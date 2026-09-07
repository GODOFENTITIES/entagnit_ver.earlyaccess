/**
 * server/chatBridge.js
 *
 * Identity bridge: Potspark Better-Auth ↔ Veloxwale Supabase.
 *
 * Responsibilities:
 *  - Derive a stable Supabase UID from a Potspark userId (SHA-256 → UUID-v4 format).
 *  - Mint short-lived Supabase-compatible JWTs using the Supabase JWT secret.
 *  - Persist the potsparkUserId ↔ supabaseUid mapping in Potspark's own DB.
 *  - Manage game_channel_members rows via the service-role key (server-only).
 *  - Rate-limit token issuance per user (reuses WindowLimiter pattern).
 *
 * Nothing in this file is ever sent to the browser.
 */

import { createHash } from "node:crypto";
import { SignJWT } from "jose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAT_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const CHAT_TOKEN_RATE_MAX = 10; // max 10 tokens per window
const CHAT_TOKEN_RATE_WINDOW_MS = 5 * 60_000; // per 5 minutes
const MAX_MESSAGE_LENGTH = 280;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic UUID v4-shaped string from a Potspark userId.
 * SHA-256 produces 32 bytes; we take the first 16 and format as UUID.
 * The result is stable: same userId always → same supabaseUid.
 *
 * @param {string} potsparkUserId
 * @returns {string}  xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function deriveSupabaseUid(potsparkUserId) {
  const hash = createHash("sha256")
    .update("potspark:chat:uid:")
    .update(String(potsparkUserId))
    .digest();

  // Force version=4 and variant=10xx per RFC 4122
  hash[6] = (hash[6] & 0x0f) | 0x40; // version 4
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant 10

  const hex = hash.toString("hex", 0, 16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Minimal in-process rate-limiter (same pattern as authSystem.js WindowLimiter)
// ---------------------------------------------------------------------------

class WindowLimiter {
  constructor() {
    this._entries = new Map();
    this._ops = 0;
  }

  consume(key, max, windowMs, now = Date.now()) {
    this._ops += 1;
    if (this._ops % 256 === 0) this._prune(now);
    let entry = this._entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this._entries.set(key, entry);
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }

  _prune(now = Date.now()) {
    for (const [key, entry] of this._entries) {
      if (entry.resetAt <= now) this._entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase REST helpers (no SDK dependency on the server — raw fetch only)
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Supabase REST/PostgREST API
 * using the service-role key (server-only — never sent to browser).
 *
 * @param {object} opts
 * @param {string} opts.supabaseUrl
 * @param {string} opts.serviceKey
 * @param {string} opts.method
 * @param {string} opts.path   e.g. "/rest/v1/game_channels"
 * @param {object} [opts.body]
 * @param {Record<string,string>} [opts.query]
 * @returns {Promise<{ ok: boolean, status: number, data: unknown }>}
 */
async function supabaseRest({ supabaseUrl, serviceKey, method, path, body, query }) {
  const url = new URL(`${supabaseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const headers = {
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  const res = await fetch(url.href, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// SQLite/Postgres-agnostic DB helpers
// ---------------------------------------------------------------------------

/**
 * Run the identity-mapping table migration against whatever DB Potspark uses.
 *
 * @param {{ kind: "sqlite"|"postgres", database: object }} db
 */
async function migrateIdentityTable({ kind, database }) {
  if (kind === "sqlite") {
    database.prepare(`
      CREATE TABLE IF NOT EXISTS potspark_chat_identity (
        potspark_user_id TEXT NOT NULL PRIMARY KEY,
        supabase_uid     TEXT NOT NULL UNIQUE,
        username         TEXT NOT NULL,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
  } else {
    await database.query(`
      CREATE TABLE IF NOT EXISTS potspark_chat_identity (
        potspark_user_id TEXT    NOT NULL PRIMARY KEY,
        supabase_uid     TEXT    NOT NULL UNIQUE,
        username         TEXT    NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
}

/**
 * Upsert the identity mapping row.
 *
 * @param {{ kind: "sqlite"|"postgres", database: object }} db
 * @param {{ potsparkUserId: string, supabaseUid: string, username: string }} identity
 */
async function upsertIdentity({ kind, database }, { potsparkUserId, supabaseUid, username }) {
  if (kind === "sqlite") {
    database.prepare(`
      INSERT INTO potspark_chat_identity (potspark_user_id, supabase_uid, username)
      VALUES (?, ?, ?)
      ON CONFLICT(potspark_user_id) DO UPDATE SET username = excluded.username
    `).run(potsparkUserId, supabaseUid, username);
  } else {
    await database.query(
      `INSERT INTO potspark_chat_identity (potspark_user_id, supabase_uid, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (potspark_user_id) DO UPDATE SET username = EXCLUDED.username`,
      [potsparkUserId, supabaseUid, username],
    );
  }
}

/**
 * Look up a supabaseUid from a potsparkUserId (returns null if not found).
 *
 * @param {{ kind: "sqlite"|"postgres", database: object }} db
 * @param {string} potsparkUserId
 * @returns {Promise<string|null>}
 */
async function lookupSupabaseUid({ kind, database }, potsparkUserId) {
  if (kind === "sqlite") {
    const row = database.prepare(
      `SELECT supabase_uid FROM potspark_chat_identity WHERE potspark_user_id = ?`,
    ).get(potsparkUserId);
    return row?.supabase_uid ?? null;
  } else {
    const result = await database.query(
      `SELECT supabase_uid FROM potspark_chat_identity WHERE potspark_user_id = $1`,
      [potsparkUserId],
    );
    return result.rows[0]?.supabase_uid ?? null;
  }
}

// ---------------------------------------------------------------------------
// ChatBridge factory
// ---------------------------------------------------------------------------

/**
 * Create a ChatBridge instance.
 *
 * @param {object} options
 * @param {string}  options.supabaseUrl     - e.g. "https://xyzxyz.supabase.co"
 * @param {string}  options.anonKey         - publishable / anon key (goes to browser)
 * @param {string}  options.jwtSecret       - JWT signing secret (never sent to browser)
 * @param {string}  options.serviceKey      - service-role key (never sent to browser)
 * @param {"sqlite"|"postgres"} options.dbKind
 * @param {object}  options.database        - the Potspark DB instance (sqlite3 or pg.Pool)
 * @param {object}  [options.clock]         - optional { now() } for testing
 *
 * @returns {Promise<ChatBridge>}
 */
export async function createChatBridge(options) {
  const {
    supabaseUrl,
    anonKey,
    jwtSecret,
    serviceKey,
    dbKind: kind,
    database,
    clock = { now: () => Date.now() },
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required for ChatBridge");
  if (!anonKey)     throw new Error("SUPABASE_ANON_KEY is required for ChatBridge");
  if (!jwtSecret)   throw new Error("SUPABASE_JWT_SECRET is required for ChatBridge");
  if (!serviceKey)  throw new Error("SUPABASE_SERVICE_KEY is required for ChatBridge");

  // Encode the signing secret as a Uint8Array for jose
  const signingKey = new TextEncoder().encode(jwtSecret);

  // Rate limiter: shared across all users
  const tokenLimiter = new WindowLimiter();

  // Run DB migration on startup
  await migrateIdentityTable({ kind, database });

  // Ensure the lobby channel row exists in Supabase
  await _ensureLobbyChannel({ supabaseUrl, serviceKey });

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Issue a Supabase-compatible JWT for a Potspark user.
   * Rate-limited: 10 tokens per user per 5 minutes.
   *
   * @param {string} potsparkUserId
   * @param {string} username
   * @returns {Promise<{ token: string, supabaseUid: string, expiresAt: number } | { rateLimited: true }>}
   */
  async function issueToken(potsparkUserId, username) {
    const now = clock.now();
    if (!tokenLimiter.consume(`user:${potsparkUserId}`, CHAT_TOKEN_RATE_MAX, CHAT_TOKEN_RATE_WINDOW_MS, now)) {
      return { rateLimited: true };
    }

    const supabaseUid = deriveSupabaseUid(potsparkUserId);

    // Persist the mapping (upsert — idempotent)
    await upsertIdentity({ kind, database }, { potsparkUserId, supabaseUid, username });

    const issuedAt = Math.floor(now / 1000);
    const expiresAt = issuedAt + CHAT_TOKEN_TTL_SECONDS;

    // Build a JWT that Supabase's auth system recognises.
    // The `sub` claim is the supabaseUid so RLS sees auth.uid() = supabaseUid.
    const token = await new SignJWT({
      sub: supabaseUid,
      iss: "supabase",
      aud: "authenticated",
      role: "authenticated",
      // Custom claim: carry the Potspark username for profile display
      user_metadata: { username },
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKey);

    return { token, supabaseUid, expiresAt: expiresAt * 1000 }; // expiresAt in ms
  }

  /**
   * Add a Supabase UID to a game channel (INSERT into game_channel_members).
   * Called server-side when a player joins a room or match.
   *
   * @param {string} channelKey  e.g. "room:ABCD12" or "lobby:global"
   * @param {string} supabaseUid
   */
  async function addMember(channelKey, supabaseUid) {
    // Derive channel_type from the key prefix so room channels are created on first join.
    const channelType = channelKey.startsWith("room:")  ? "room"
      : channelKey.startsWith("match:") ? "match"
      : channelKey.startsWith("lobby:") ? "lobby"
      : "dm";

    // Upsert the channel row (idempotent — existing rows are untouched).
    const upsertResult = await supabaseRest({
      supabaseUrl,
      serviceKey,
      method: "POST",
      path: "/rest/v1/game_channels",
      body: { channel_key: channelKey, channel_type: channelType, is_archived: false },
      query: { on_conflict: "channel_key" },
    });
    if (!upsertResult.ok && upsertResult.status !== 409) {
      console.warn(`[chatBridge] addMember: channel upsert failed for "${channelKey}": ${upsertResult.status}`);
      return;
    }

    // Invalidate cache so the next _resolveChannelId reads the real UUID.
    _channelIdCache.delete(channelKey);

    const channelId = await _resolveChannelId(channelKey, { supabaseUrl, serviceKey });
    if (!channelId) {
      console.warn(`[chatBridge] addMember: channel "${channelKey}" still not found after upsert`);
      return;
    }
    const result = await supabaseRest({
      supabaseUrl,
      serviceKey,
      method: "POST",
      path: "/rest/v1/game_channel_members",
      body: { channel_id: channelId, supabase_uid: supabaseUid },
      query: { on_conflict: "channel_id,supabase_uid" },
    });
    if (!result.ok) {
      console.warn(`[chatBridge] addMember failed for ${channelKey}/${supabaseUid}: ${result.status}`);
    }
  }

  /**
   * Remove a Supabase UID from a game channel.
   * Called when a player leaves a room, disconnects, or is revoked.
   *
   * @param {string} channelKey
   * @param {string} supabaseUid
   */
  async function removeMember(channelKey, supabaseUid) {
    const channelId = await _resolveChannelId(channelKey, { supabaseUrl, serviceKey });
    if (!channelId) return;
    await supabaseRest({
      supabaseUrl,
      serviceKey,
      method: "DELETE",
      path: "/rest/v1/game_channel_members",
      query: {
        channel_id: `eq.${channelId}`,
        supabase_uid: `eq.${supabaseUid}`,
      },
    });
  }

  /**
   * Mark a channel as archived / read_only (called when a match ends).
   *
   * @param {string} channelKey
   */
  async function archiveChannel(channelKey) {
    await supabaseRest({
      supabaseUrl,
      serviceKey,
      method: "PATCH",
      path: "/rest/v1/game_channels",
      query: { channel_key: `eq.${channelKey}` },
      body: { is_archived: true },
    });
  }

  /**
   * Remove a user from ALL active channels (called on session/user revoke).
   *
   * @param {string} supabaseUid
   */
  async function revokeUser(supabaseUid) {
    await supabaseRest({
      supabaseUrl,
      serviceKey,
      method: "DELETE",
      path: "/rest/v1/game_channel_members",
      query: { supabase_uid: `eq.${supabaseUid}` },
    });
  }

  /**
   * Look up the supabaseUid for a potsparkUserId without issuing a token.
   * Used by Phase 4 room/match hooks.
   *
   * @param {string} potsparkUserId
   * @returns {Promise<string|null>}
   */
  async function getSupabaseUid(potsparkUserId) {
    return lookupSupabaseUid({ kind, database }, potsparkUserId);
  }

  /**
   * Return public config values safe to expose to the browser.
   * @returns {{ url: string, anonKey: string, maxMessageLength: number }}
   */
  function publicConfig() {
    return { url: supabaseUrl, anonKey, maxMessageLength: MAX_MESSAGE_LENGTH };
  }

  return {
    issueToken,
    addMember,
    removeMember,
    archiveChannel,
    revokeUser,
    getSupabaseUid,
    publicConfig,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Create the "lobby:global" channel in game_channels if it doesn't exist yet.
 */
async function _ensureLobbyChannel({ supabaseUrl, serviceKey }) {
  const result = await supabaseRest({
    supabaseUrl,
    serviceKey,
    method: "POST",
    path: "/rest/v1/game_channels",
    body: {
      channel_key: "lobby:global",
      channel_type: "lobby",
      is_archived: false,
    },
    query: { on_conflict: "channel_key" },
  });
  if (!result.ok && result.status !== 409) {
    // 409 = already exists (duplicate), which is fine.
    console.warn(`[chatBridge] _ensureLobbyChannel: ${result.status}`, result.data);
  }
}

/**
 * Resolve a channel_key to its UUID primary key in game_channels.
 * Result is cached in a simple Map for the lifetime of the process.
 *
 * @param {string} channelKey
 * @param {{ supabaseUrl: string, serviceKey: string }} ctx
 * @returns {Promise<string|null>}
 */
const _channelIdCache = new Map();

async function _resolveChannelId(channelKey, { supabaseUrl, serviceKey }) {
  if (_channelIdCache.has(channelKey)) return _channelIdCache.get(channelKey);

  const result = await supabaseRest({
    supabaseUrl,
    serviceKey,
    method: "GET",
    path: "/rest/v1/game_channels",
    query: { channel_key: `eq.${channelKey}`, select: "id" },
  });
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  const id = result.data[0].id;
  _channelIdCache.set(channelKey, id);
  return id;
}

export { deriveSupabaseUid, MAX_MESSAGE_LENGTH };
