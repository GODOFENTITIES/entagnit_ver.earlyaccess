import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { createChatBridge, deriveSupabaseUid } from "../server/chatBridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build a minimal ChatBridge backed by an in-memory SQLite DB.
 * The Supabase env vars are stubbed out — no real network calls are made
 * because we intercept fetch before the bridge touches the network.
 */
async function makeBridge({ clock, fetchStub } = {}) {
  const db = new Database(":memory:");

  // Stub global fetch so Supabase REST calls don't hit the network.
  // Each test can override specific responses via fetchStub.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub ?? (async () =>
    new Response(JSON.stringify([{ id: "00000000-0000-4000-8000-000000000001" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  const bridge = await createChatBridge({
    supabaseUrl: "https://test.supabase.co",
    anonKey: "anon-key-for-tests",
    jwtSecret: "test-jwt-secret-that-is-long-enough",
    serviceKey: "service-key-for-tests",
    dbKind: "sqlite",
    database: db,
    clock: clock ?? { now: () => Date.now() },
  });

  return { bridge, db, restoreFetch: () => { globalThis.fetch = originalFetch; } };
}

// ---------------------------------------------------------------------------
// deriveSupabaseUid — pure function, no network
// ---------------------------------------------------------------------------

test("deriveSupabaseUid returns a valid UUID v4", () => {
  const uid = deriveSupabaseUid("user-abc-123");
  assert.match(uid, UUID_RE, "must be UUID v4 format");
  // version nibble must be '4'
  assert.equal(uid[14], "4");
  // variant nibble must be 8, 9, a or b
  assert.ok(["8", "9", "a", "b"].includes(uid[19].toLowerCase()), "variant bits wrong");
});

test("deriveSupabaseUid is deterministic", () => {
  const uid1 = deriveSupabaseUid("same-user");
  const uid2 = deriveSupabaseUid("same-user");
  assert.equal(uid1, uid2);
});

test("deriveSupabaseUid produces different UIDs for different Potspark IDs", () => {
  const uid1 = deriveSupabaseUid("user-A");
  const uid2 = deriveSupabaseUid("user-B");
  assert.notEqual(uid1, uid2);
});

// ---------------------------------------------------------------------------
// Identity table migration
// ---------------------------------------------------------------------------

test("createChatBridge creates potspark_chat_identity table", async () => {
  const { db, restoreFetch } = await makeBridge();
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='potspark_chat_identity'`,
    ).get();
    assert.ok(row, "table should exist after bridge creation");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// issueToken — happy path
// ---------------------------------------------------------------------------

test("issueToken returns token, supabaseUid, expiresAt", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    const result = await bridge.issueToken("potspark-user-1", "Player1");
    assert.ok(result.token, "token must be present");
    assert.match(result.supabaseUid, UUID_RE, "supabaseUid must be UUID");
    assert.ok(typeof result.expiresAt === "number", "expiresAt must be a number");
    // expiresAt should be ~15 minutes from now (in ms)
    const expectedTtlMs = 15 * 60 * 1000;
    const delta = result.expiresAt - Date.now();
    assert.ok(delta > expectedTtlMs - 5000 && delta <= expectedTtlMs + 5000,
      `expiresAt delta ${delta}ms should be ~${expectedTtlMs}ms`);
  } finally {
    restoreFetch();
  }
});

test("issueToken mints a JWT with correct sub claim", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    const result = await bridge.issueToken("potspark-user-2", "Player2");
    // Decode without verifying (we just need to inspect the payload)
    const [, payloadB64] = result.token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    const expectedUid = deriveSupabaseUid("potspark-user-2");
    assert.equal(payload.sub, expectedUid, "JWT sub must equal derived supabase UID");
    assert.equal(payload.role, "authenticated");
    assert.equal(payload.aud, "authenticated");
    assert.equal(payload.iss, "supabase");
    assert.equal(payload.user_metadata?.username, "Player2");
  } finally {
    restoreFetch();
  }
});

test("issueToken persists identity mapping in DB", async () => {
  const { bridge, db, restoreFetch } = await makeBridge();
  try {
    const potsparkId = "potspark-user-persist";
    await bridge.issueToken(potsparkId, "TestPlayer");
    const row = db.prepare(
      `SELECT supabase_uid, username FROM potspark_chat_identity WHERE potspark_user_id = ?`,
    ).get(potsparkId);
    assert.ok(row, "identity row must exist after issueToken");
    assert.equal(row.supabase_uid, deriveSupabaseUid(potsparkId));
    assert.equal(row.username, "TestPlayer");
  } finally {
    restoreFetch();
  }
});

test("issueToken upserts username on repeated calls", async () => {
  const { bridge, db, restoreFetch } = await makeBridge();
  try {
    const potsparkId = "potspark-user-upsert";
    await bridge.issueToken(potsparkId, "OldName");
    await bridge.issueToken(potsparkId, "NewName");
    const row = db.prepare(
      `SELECT username FROM potspark_chat_identity WHERE potspark_user_id = ?`,
    ).get(potsparkId);
    assert.equal(row.username, "NewName", "username should be updated on upsert");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// issueToken — rate limiting
// ---------------------------------------------------------------------------

test("issueToken rate-limits to 10 tokens per 5 minutes per user", async () => {
  let fakeNow = 1_000_000;
  const { bridge, restoreFetch } = await makeBridge({
    clock: { now: () => fakeNow },
  });
  try {
    const userId = "rate-limited-user";
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await bridge.issueToken(userId, "Player"));
    }
    const successful = results.filter((r) => !r.rateLimited);
    const limited = results.filter((r) => r.rateLimited);
    assert.equal(successful.length, 10, "exactly 10 tokens allowed in window");
    assert.equal(limited.length, 2, "2 requests should be rate-limited");
  } finally {
    restoreFetch();
  }
});

test("issueToken rate-limit resets after the window", async () => {
  let fakeNow = 2_000_000;
  const { bridge, restoreFetch } = await makeBridge({
    clock: { now: () => fakeNow },
  });
  try {
    const userId = "rate-reset-user";
    // exhaust the 10-token window
    for (let i = 0; i < 10; i++) {
      await bridge.issueToken(userId, "Player");
    }
    // verify 11th is rate limited
    const limited = await bridge.issueToken(userId, "Player");
    assert.ok(limited.rateLimited, "11th request should be rate limited");

    // advance past the 5-minute window
    fakeNow += 5 * 60 * 1000 + 1;

    const fresh = await bridge.issueToken(userId, "Player");
    assert.ok(!fresh.rateLimited, "request after window reset should succeed");
  } finally {
    restoreFetch();
  }
});

test("issueToken rate-limits are per-user, not global", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    // exhaust user A's limit
    for (let i = 0; i < 10; i++) {
      await bridge.issueToken("user-A", "A");
    }
    // user B should be unaffected
    const result = await bridge.issueToken("user-B", "B");
    assert.ok(!result.rateLimited, "user B must not be rate-limited by user A's consumption");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// getSupabaseUid
// ---------------------------------------------------------------------------

test("getSupabaseUid returns null for unmapped user", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    const uid = await bridge.getSupabaseUid("never-seen-user");
    assert.equal(uid, null);
  } finally {
    restoreFetch();
  }
});

test("getSupabaseUid returns correct uid after issueToken", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    const potsparkId = "lookup-user";
    await bridge.issueToken(potsparkId, "LookupPlayer");
    const uid = await bridge.getSupabaseUid(potsparkId);
    assert.equal(uid, deriveSupabaseUid(potsparkId));
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// publicConfig
// ---------------------------------------------------------------------------

test("publicConfig does not expose jwt secret or service key", async () => {
  const { bridge, restoreFetch } = await makeBridge();
  try {
    const config = bridge.publicConfig();
    const configStr = JSON.stringify(config);
    assert.ok(!configStr.includes("test-jwt-secret"), "JWT secret must not appear in publicConfig");
    assert.ok(!configStr.includes("service-key"), "service key must not appear in publicConfig");
    assert.ok(config.url, "url must be present");
    assert.ok(config.anonKey, "anonKey must be present");
    assert.ok(typeof config.maxMessageLength === "number", "maxMessageLength must be present");
  } finally {
    restoreFetch();
  }
});
