import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TICKET_TTL_MS = 20_000;
const DEFAULT_GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SECURITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function nowMs(clock) {
  return Math.floor(clock());
}

export function hashOpaqueSecret(secret) {
  return createHash("sha256").update(String(secret), "utf8").digest("hex");
}

export function createOpaqueSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeBinding(value) {
  if (!value || typeof value !== "object") return null;
  return {
    playerId: Number.isInteger(value.playerId) ? value.playerId : null,
    roomId: typeof value.roomId === "string" ? value.roomId.slice(0, 64) : null,
    matchId: typeof value.matchId === "string" ? value.matchId.slice(0, 64) : null,
    team: Number.isInteger(value.team) ? value.team : 0,
    inGame: value.inGame === true,
  };
}

function parseBinding(raw) {
  if (!raw) return null;
  try {
    return safeBinding(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Persistent, deliberately small store for guest sessions, one-use match
 * tickets, connection epochs, and security events. Authentication itself is
 * owned by Better Auth; this store only owns Potspark match admission.
 */
export class MatchAdmissionStore {
  constructor({ kind, database, clock = Date.now } = {}) {
    if (kind !== "sqlite" && kind !== "postgres") {
      throw new TypeError("MatchAdmissionStore requires sqlite or postgres");
    }
    this.kind = kind;
    this.database = database;
    this.clock = clock;
  }

  async migrate() {
    if (this.kind === "sqlite") {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS potspark_guest_sessions (
          guest_hash TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS potspark_connection_epochs (
          principal_key TEXT PRIMARY KEY,
          current_epoch INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS potspark_match_tickets (
          ticket_hash TEXT PRIMARY KEY,
          principal_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          user_id TEXT,
          connection_epoch INTEGER NOT NULL,
          binding_json TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS potspark_ticket_session_idx
          ON potspark_match_tickets(session_id, consumed_at, expires_at);
        CREATE TABLE IF NOT EXISTS potspark_security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          principal_key TEXT,
          user_id TEXT,
          detail_json TEXT
        );
        CREATE TABLE IF NOT EXISTS potspark_auth_challenges (
          challenge_hash TEXT PRIMARY KEY,
          challenge_kind TEXT NOT NULL,
          user_id TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS potspark_challenge_user_idx
          ON potspark_auth_challenges(user_id, challenge_kind, consumed_at, expires_at);
      `);
      return;
    }

    await this.database.query(`
      CREATE TABLE IF NOT EXISTS potspark_guest_sessions (
        guest_hash TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS potspark_connection_epochs (
        principal_key TEXT PRIMARY KEY,
        current_epoch BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS potspark_match_tickets (
        ticket_hash TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT,
        connection_epoch BIGINT NOT NULL,
        binding_json TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        consumed_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS potspark_ticket_session_idx
        ON potspark_match_tickets(session_id, consumed_at, expires_at);
      CREATE TABLE IF NOT EXISTS potspark_security_events (
        id BIGSERIAL PRIMARY KEY,
        created_at BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        principal_key TEXT,
        user_id TEXT,
        detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS potspark_auth_challenges (
        challenge_hash TEXT PRIMARY KEY,
        challenge_kind TEXT NOT NULL,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        consumed_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS potspark_challenge_user_idx
        ON potspark_auth_challenges(user_id, challenge_kind, consumed_at, expires_at);
    `);
  }

  async createGuestSession({ ttlMs = DEFAULT_GUEST_TTL_MS } = {}) {
    const secret = createOpaqueSecret();
    const guestHash = hashOpaqueSecret(secret);
    const createdAt = nowMs(this.clock);
    const expiresAt = createdAt + ttlMs;
    if (this.kind === "sqlite") {
      this.database.prepare(`
        INSERT INTO potspark_guest_sessions
          (guest_hash, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(guestHash, createdAt, createdAt, expiresAt);
    } else {
      await this.database.query(`
        INSERT INTO potspark_guest_sessions
          (guest_hash, created_at, last_seen_at, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [guestHash, createdAt, createdAt, expiresAt]);
    }
    return { secret, guestHash, createdAt, expiresAt };
  }

  async validateGuestSession(secret, { touch = true } = {}) {
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 128) return null;
    const guestHash = hashOpaqueSecret(secret);
    const current = nowMs(this.clock);
    let row;
    if (this.kind === "sqlite") {
      row = this.database.prepare(`
        SELECT guest_hash, created_at, last_seen_at, expires_at
        FROM potspark_guest_sessions
        WHERE guest_hash = ? AND expires_at > ?
      `).get(guestHash, current);
      if (row && touch) {
        this.database.prepare(`
          UPDATE potspark_guest_sessions SET last_seen_at = ? WHERE guest_hash = ?
        `).run(current, guestHash);
      }
    } else {
      const result = await this.database.query(`
        SELECT guest_hash, created_at, last_seen_at, expires_at
        FROM potspark_guest_sessions
        WHERE guest_hash = $1 AND expires_at > $2
      `, [guestHash, current]);
      row = result.rows[0];
      if (row && touch) {
        await this.database.query(`
          UPDATE potspark_guest_sessions SET last_seen_at = $1 WHERE guest_hash = $2
        `, [current, guestHash]);
      }
    }
    if (!row) return null;
    return {
      guestHash,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async issueTicket(principal, binding = null, { ttlMs = DEFAULT_TICKET_TTL_MS } = {}) {
    const secret = createOpaqueSecret();
    const ticketHash = hashOpaqueSecret(secret);
    const createdAt = nowMs(this.clock);
    const expiresAt = createdAt + ttlMs;
    const bindingJson = binding ? JSON.stringify(safeBinding(binding)) : null;

    let connectionEpoch;
    if (this.kind === "sqlite") {
      const issue = this.database.transaction(() => {
        const current = this.database.prepare(`
          SELECT current_epoch FROM potspark_connection_epochs WHERE principal_key = ?
        `).get(principal.principalKey);
        const next = Number(current?.current_epoch || 0) + 1;
        this.database.prepare(`
          INSERT INTO potspark_connection_epochs (principal_key, current_epoch, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(principal_key) DO UPDATE SET
            current_epoch = excluded.current_epoch,
            updated_at = excluded.updated_at
        `).run(principal.principalKey, next, createdAt);
        this.database.prepare(`
          INSERT INTO potspark_match_tickets
            (ticket_hash, principal_key, session_id, user_id, connection_epoch,
             binding_json, created_at, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          ticketHash,
          principal.principalKey,
          principal.sessionId,
          principal.userId,
          next,
          bindingJson,
          createdAt,
          expiresAt,
        );
        return next;
      });
      connectionEpoch = issue();
    } else {
      const client = await this.database.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          INSERT INTO potspark_connection_epochs (principal_key, current_epoch, updated_at)
          VALUES ($1, 0, $2)
          ON CONFLICT(principal_key) DO NOTHING
        `, [principal.principalKey, createdAt]);
        const current = await client.query(`
          SELECT current_epoch FROM potspark_connection_epochs
          WHERE principal_key = $1 FOR UPDATE
        `, [principal.principalKey]);
        connectionEpoch = Number(current.rows[0].current_epoch) + 1;
        await client.query(`
          UPDATE potspark_connection_epochs
          SET current_epoch = $1, updated_at = $2 WHERE principal_key = $3
        `, [connectionEpoch, createdAt, principal.principalKey]);
        await client.query(`
          INSERT INTO potspark_match_tickets
            (ticket_hash, principal_key, session_id, user_id, connection_epoch,
             binding_json, created_at, expires_at, consumed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
        `, [
          ticketHash,
          principal.principalKey,
          principal.sessionId,
          principal.userId,
          connectionEpoch,
          bindingJson,
          createdAt,
          expiresAt,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    return { secret, connectionEpoch, createdAt, expiresAt, binding: safeBinding(binding) };
  }

  async consumeTicket(secret, principal) {
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 128) return null;
    const ticketHash = hashOpaqueSecret(secret);
    const current = nowMs(this.clock);

    if (this.kind === "sqlite") {
      const consume = this.database.transaction(() => {
        const row = this.database.prepare(`
          SELECT * FROM potspark_match_tickets WHERE ticket_hash = ?
        `).get(ticketHash);
        if (!this.isConsumable(row, principal, current)) return null;
        const epoch = this.database.prepare(`
          SELECT current_epoch FROM potspark_connection_epochs WHERE principal_key = ?
        `).get(row.principal_key);
        if (Number(epoch?.current_epoch) !== Number(row.connection_epoch)) return null;
        const changed = this.database.prepare(`
          UPDATE potspark_match_tickets
          SET consumed_at = ?
          WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?
        `).run(current, ticketHash, current).changes;
        return changed === 1 ? row : null;
      });
      const row = consume();
      return row ? this.ticketResult(row) : null;
    }

    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(`
        SELECT * FROM potspark_match_tickets WHERE ticket_hash = $1 FOR UPDATE
      `, [ticketHash]);
      const row = selected.rows[0];
      if (!this.isConsumable(row, principal, current)) {
        await client.query("ROLLBACK");
        return null;
      }
      const epoch = await client.query(`
        SELECT current_epoch FROM potspark_connection_epochs WHERE principal_key = $1
      `, [row.principal_key]);
      if (Number(epoch.rows[0]?.current_epoch) !== Number(row.connection_epoch)) {
        await client.query("ROLLBACK");
        return null;
      }
      const changed = await client.query(`
        UPDATE potspark_match_tickets SET consumed_at = $1
        WHERE ticket_hash = $2 AND consumed_at IS NULL AND expires_at > $1
      `, [current, ticketHash]);
      if (changed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return this.ticketResult(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  isConsumable(row, principal, current) {
    return !!row
      && row.consumed_at == null
      && Number(row.expires_at) > current
      && row.principal_key === principal.principalKey
      && row.session_id === principal.sessionId
      && (row.user_id || null) === (principal.userId || null);
  }

  ticketResult(row) {
    return {
      principalKey: row.principal_key,
      sessionId: row.session_id,
      userId: row.user_id || null,
      connectionEpoch: Number(row.connection_epoch),
      expiresAt: Number(row.expires_at),
      binding: parseBinding(row.binding_json),
    };
  }

  async revokeSession(sessionId) {
    if (!sessionId) return 0;
    if (this.kind === "sqlite") {
      return this.database.prepare(`
        DELETE FROM potspark_match_tickets
        WHERE session_id = ? AND consumed_at IS NULL
      `).run(sessionId).changes;
    }
    const result = await this.database.query(`
      DELETE FROM potspark_match_tickets
      WHERE session_id = $1 AND consumed_at IS NULL
    `, [sessionId]);
    return result.rowCount || 0;
  }

  async revokeUser(userId) {
    if (!userId) return;
    const principalKey = `user:${userId}`;
    if (this.kind === "sqlite") {
      const revoke = this.database.transaction(() => {
        this.database.prepare("DELETE FROM potspark_match_tickets WHERE user_id = ?").run(userId);
        this.database.prepare("DELETE FROM potspark_auth_challenges WHERE user_id = ?").run(userId);
        this.database.prepare("DELETE FROM potspark_connection_epochs WHERE principal_key = ?")
          .run(principalKey);
      });
      revoke();
      return;
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM potspark_match_tickets WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM potspark_auth_challenges WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM potspark_connection_epochs WHERE principal_key = $1", [principalKey]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async issueAuthChallenge(kind, userId, email, { ttlMs = 60 * 60_000 } = {}) {
    const secret = createOpaqueSecret();
    const challengeHash = hashOpaqueSecret(secret);
    const createdAt = nowMs(this.clock);
    const expiresAt = createdAt + ttlMs;
    const challengeKind = String(kind).slice(0, 48);
    const normalizedEmail = String(email).normalize("NFKC").trim().toLowerCase();
    if (this.kind === "sqlite") {
      const issue = this.database.transaction(() => {
        this.database.prepare(`
          DELETE FROM potspark_auth_challenges
          WHERE user_id = ? AND challenge_kind = ? AND consumed_at IS NULL
        `).run(userId, challengeKind);
        this.database.prepare(`
          INSERT INTO potspark_auth_challenges
            (challenge_hash, challenge_kind, user_id, email, created_at, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(challengeHash, challengeKind, userId, normalizedEmail, createdAt, expiresAt);
      });
      issue();
    } else {
      const client = await this.database.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          DELETE FROM potspark_auth_challenges
          WHERE user_id = $1 AND challenge_kind = $2 AND consumed_at IS NULL
        `, [userId, challengeKind]);
        await client.query(`
          INSERT INTO potspark_auth_challenges
            (challenge_hash, challenge_kind, user_id, email, created_at, expires_at, consumed_at)
          VALUES ($1, $2, $3, $4, $5, $6, NULL)
        `, [challengeHash, challengeKind, userId, normalizedEmail, createdAt, expiresAt]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return { secret, challengeHash, createdAt, expiresAt };
  }

  async consumeAuthChallenge(secret, kind) {
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 128) return null;
    const challengeHash = hashOpaqueSecret(secret);
    const challengeKind = String(kind).slice(0, 48);
    const current = nowMs(this.clock);
    if (this.kind === "sqlite") {
      const consume = this.database.transaction(() => {
        const row = this.database.prepare(`
          SELECT * FROM potspark_auth_challenges
          WHERE challenge_hash = ? AND challenge_kind = ?
        `).get(challengeHash, challengeKind);
        if (!row || row.consumed_at != null || Number(row.expires_at) <= current) return null;
        const changed = this.database.prepare(`
          UPDATE potspark_auth_challenges SET consumed_at = ?
          WHERE challenge_hash = ? AND consumed_at IS NULL AND expires_at > ?
        `).run(current, challengeHash, current).changes;
        return changed === 1 ? row : null;
      });
      return consume();
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(`
        SELECT * FROM potspark_auth_challenges
        WHERE challenge_hash = $1 AND challenge_kind = $2 FOR UPDATE
      `, [challengeHash, challengeKind]);
      const row = selected.rows[0];
      if (!row || row.consumed_at != null || Number(row.expires_at) <= current) {
        await client.query("ROLLBACK");
        return null;
      }
      const changed = await client.query(`
        UPDATE potspark_auth_challenges SET consumed_at = $1
        WHERE challenge_hash = $2 AND consumed_at IS NULL AND expires_at > $1
      `, [current, challengeHash]);
      if (changed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordEvent(eventType, principal = null, details = null) {
    const createdAt = nowMs(this.clock);
    const detailJson = details ? JSON.stringify(details) : null;
    if (this.kind === "sqlite") {
      this.database.prepare(`
        INSERT INTO potspark_security_events
          (created_at, event_type, principal_key, user_id, detail_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        createdAt,
        String(eventType).slice(0, 64),
        principal?.principalKey || null,
        principal?.userId || null,
        detailJson,
      );
      return;
    }
    await this.database.query(`
      INSERT INTO potspark_security_events
        (created_at, event_type, principal_key, user_id, detail_json)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      createdAt,
      String(eventType).slice(0, 64),
      principal?.principalKey || null,
      principal?.userId || null,
      detailJson,
    ]);
  }

  async cleanup() {
    const current = nowMs(this.clock);
    if (this.kind === "sqlite") {
      this.database.prepare("DELETE FROM potspark_guest_sessions WHERE expires_at <= ?").run(current);
      this.database.prepare("DELETE FROM potspark_match_tickets WHERE expires_at <= ?").run(current);
      this.database.prepare("DELETE FROM potspark_auth_challenges WHERE expires_at <= ?").run(current);
      this.database.prepare(`
        DELETE FROM potspark_connection_epochs
        WHERE principal_key LIKE 'guest:%'
          AND substr(principal_key, 7) NOT IN (SELECT guest_hash FROM potspark_guest_sessions)
      `).run();
      this.database.prepare("DELETE FROM potspark_security_events WHERE created_at <= ?")
        .run(current - SECURITY_EVENT_RETENTION_MS);
      return;
    }
    await this.database.query("DELETE FROM potspark_guest_sessions WHERE expires_at <= $1", [current]);
    await this.database.query("DELETE FROM potspark_match_tickets WHERE expires_at <= $1", [current]);
    await this.database.query("DELETE FROM potspark_auth_challenges WHERE expires_at <= $1", [current]);
    await this.database.query(`
      DELETE FROM potspark_connection_epochs
      WHERE principal_key LIKE 'guest:%'
        AND substring(principal_key FROM 7) NOT IN (SELECT guest_hash FROM potspark_guest_sessions)
    `);
    await this.database.query("DELETE FROM potspark_security_events WHERE created_at <= $1", [
      current - SECURITY_EVENT_RETENTION_MS,
    ]);
  }
}

export const MATCH_TICKET_TTL_MS = DEFAULT_TICKET_TTL_MS;
export const GUEST_SESSION_TTL_MS = DEFAULT_GUEST_TTL_MS;
