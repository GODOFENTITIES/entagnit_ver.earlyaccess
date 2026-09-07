/**
 * js/chat.js — Potspark × Veloxwale ChatClient
 *
 * Bridges the Potspark lobby UI to Supabase Realtime for live global chat.
 * Loaded as a module from ui.js — never executed server-side.
 *
 * Responsibilities:
 *   - Fetch a short-lived Supabase JWT from POST /api/potspark/chat/token
 *   - Lazy-load the Supabase browser client from esm.sh (already allowed by CSP)
 *   - Subscribe to game_messages INSERT events on the lobby:global channel
 *   - Dispatch `potspark:chat-message` CustomEvents for ui.js to render
 *   - Send messages via Supabase REST (anon client INSERT)
 *   - Auto-refresh the JWT before it expires (15-min TTL, refresh at 12 min)
 *   - Expose connect() / disconnect() / send() so ui.js controls the lifecycle
 *
 * Security notes:
 *   - The JWT is minted server-side and never stored in localStorage.
 *   - The service-role key never reaches the browser.
 *   - All INSERT RLS policies enforce sender_uid = auth.uid().
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_URL = "/api/potspark/chat/config";
const TOKEN_URL  = "/api/potspark/chat/token";

/** Refresh the JWT 3 minutes before it expires. */
const REFRESH_LEAD_MS = 3 * 60 * 1000;

/** How many lines to keep in memory (prevents unbounded growth). */
const MAX_HISTORY = 100;

/** Maximum body length enforced client-side (mirrors the DB CHECK constraint). */
export const MAX_MESSAGE_LENGTH = 280;

// ---------------------------------------------------------------------------
// Lazy Supabase client loader
// ---------------------------------------------------------------------------

let _supabaseModule = null;

async function loadSupabaseClient() {
  if (_supabaseModule) return _supabaseModule;
  // CSP already allows https://esm.sh for script-src.
  _supabaseModule = await import("https://esm.sh/@supabase/supabase-js@2");
  return _supabaseModule;
}

// ---------------------------------------------------------------------------
// ChatClient
// ---------------------------------------------------------------------------

export class ChatClient extends EventTarget {
  /** @type {'off'|'connecting'|'live'|'error'} */
  #status = "off";

  /** Server-issued Supabase anon key and project URL. */
  #supabaseUrl  = "";
  #supabaseAnon = "";

  /** Authenticated Supabase client (set after connect). */
  #client = null;

  /** The Realtime channel subscription. */
  #channel = null;

  /** The current JWT and its expiry (ms epoch). */
  #token    = null;
  #expiresAt = 0;

  /** UUID of the lobby channel row in game_channels. */
  #channelId = null;

  /** Timer ID for the auto-refresh job. */
  #refreshTimer = null;

  /** In-memory message history (newest appended last). */
  #messages = [];

  /** True while a send() is in-flight — prevents double-submit. */
  #sending = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * connect() — call after the user signs in.
   * Idempotent: safe to call multiple times.
   */
  async connect() {
    if (this.#status === "connecting" || this.#status === "live") return;
    this._setStatus("connecting");

    try {
      // 1. Load public Supabase config from the server (URL + anon key).
      const configRes = await fetch(CONFIG_URL);
      if (!configRes.ok) throw new Error(`config ${configRes.status}`);
      const config = await configRes.json();
      this.#supabaseUrl  = config.url;
      this.#supabaseAnon = config.anonKey;

      // 2. Fetch a server-minted JWT for this user.
      await this._refreshToken();

      // 3. Build an authenticated Supabase client with the JWT.
      const { createClient } = await loadSupabaseClient();
      this.#client = createClient(this.#supabaseUrl, this.#supabaseAnon, {
        global: { headers: { Authorization: `Bearer ${this.#token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { apikey: this.#supabaseAnon } },
      });

      // 4. Resolve the lobby:global channel ID (needed for INSERT).
      this.#channelId = await this._resolveChannelId("lobby:global");

      // 5. Subscribe to new messages via Realtime.
      this._subscribe();

      this._setStatus("live");
    } catch (err) {
      console.error("[chat] connect failed:", err.message);
      this._setStatus("error");
    }
  }

  /**
   * disconnect() — call when the user signs out.
   * Cleans up realtime subscriptions and scheduled timers.
   */
  async disconnect() {
    this._clearRefreshTimer();

    if (this.#channel) {
      try { await this.#client?.removeChannel(this.#channel); } catch { /* ignore */ }
      this.#channel = null;
    }

    this.#client    = null;
    this.#token     = null;
    this.#expiresAt = 0;
    this.#channelId = null;
    this.#messages  = [];
    this._setStatus("off");
  }

  /**
   * send(text) — insert a message into game_messages via the authenticated client.
   * Returns true on success, false on failure.
   * @param {string} text
   */
  async send(text) {
    const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed) return false;
    if (this.#status !== "live" || !this.#client || !this.#channelId) {
      this._dispatchError("Chat is not connected. Please try again.");
      return false;
    }
    if (this.#sending) return false;
    this.#sending = true;
    try {
      const { error } = await this.#client
        .from("game_messages")
        .insert({ channel_id: this.#channelId, body: trimmed });
      if (error) throw new Error(error.message);
      return true;
    } catch (err) {
      console.error("[chat] send failed:", err.message);
      this._dispatchError("Message failed to send.");
      return false;
    } finally {
      this.#sending = false;
    }
  }

  /** Current connection status. */
  get status() { return this.#status; }

  /** Snapshot of in-memory messages. */
  get messages() { return [...this.#messages]; }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a fresh JWT from the Potspark server.
   * The server's CSRF check requires x-potspark-request: 1 and a valid Origin.
   */
  async _refreshToken() {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-potspark-request": "1",
      },
      body: "{}",
    });
    if (res.status === 401) throw new Error("Not authenticated");
    if (res.status === 429) throw new Error("Rate limited — try again shortly");
    if (!res.ok)            throw new Error(`token ${res.status}`);
    const data = await res.json();
    this.#token     = data.token;
    this.#expiresAt = data.expiresAt;

    // Update the Authorization header on the existing client if already built.
    if (this.#client) {
      this.#client.realtime.setAuth(this.#token);
    }

    this._scheduleRefresh();
  }

  /** Subscribe to INSERT events on game_messages for the lobby channel. */
  _subscribe() {
    if (!this.#client || !this.#channelId) return;

    this.#channel = this.#client
      .channel("lobby-global-chat")
      .on(
        "postgres_changes",
        {
          event:  "INSERT",
          schema: "public",
          table:  "game_messages",
          filter: `channel_id=eq.${this.#channelId}`,
        },
        (payload) => this._onMessage(payload.new),
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[chat] realtime channel error:", status);
          this._setStatus("error");
        }
      });
  }

  /** Handle a message arriving from Realtime or sent locally. */
  _onMessage(row) {
    const msg = {
      id:        row.id,
      username:  row.username,
      body:      row.body,
      timestamp: row.inserted_at ? new Date(row.inserted_at).getTime() : Date.now(),
    };
    this.#messages.push(msg);
    if (this.#messages.length > MAX_HISTORY) {
      this.#messages.shift();
    }
    window.dispatchEvent(new CustomEvent("potspark:chat-message", { detail: msg }));
  }

  /** Resolve channel_key → channel UUID via a public REST call. */
  async _resolveChannelId(channelKey) {
    const url = `${this.#supabaseUrl}/rest/v1/game_channels`
      + `?channel_key=eq.${encodeURIComponent(channelKey)}&select=id&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey:        this.#supabaseAnon,
        Authorization: `Bearer ${this.#token}`,
        Accept:        "application/json",
      },
    });
    if (!res.ok) throw new Error(`channel resolve ${res.status}`);
    const rows = await res.json();
    if (!rows.length) throw new Error(`channel '${channelKey}' not found — run the SQL migration`);
    return rows[0].id;
  }

  /** Schedule the next token refresh. */
  _scheduleRefresh() {
    this._clearRefreshTimer();
    const msUntilRefresh = this.#expiresAt - Date.now() - REFRESH_LEAD_MS;
    if (msUntilRefresh <= 0) {
      // Already close to expiry — refresh immediately.
      this._refreshToken().catch((err) => {
        console.error("[chat] auto-refresh failed:", err.message);
        this._setStatus("error");
      });
      return;
    }
    this.#refreshTimer = window.setTimeout(async () => {
      try {
        await this._refreshToken();
      } catch (err) {
        console.error("[chat] auto-refresh failed:", err.message);
        this._setStatus("error");
      }
    }, msUntilRefresh);
  }

  _clearRefreshTimer() {
    if (this.#refreshTimer !== null) {
      window.clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  _setStatus(s) {
    this.#status = s;
    window.dispatchEvent(new CustomEvent("potspark:chat-status", { detail: { status: s } }));
  }

  _dispatchError(message) {
    window.dispatchEvent(new CustomEvent("potspark:chat-error", { detail: { message } }));
  }
}

// ---------------------------------------------------------------------------
// Singleton export — ui.js imports this instance directly.
// ---------------------------------------------------------------------------
export const chatClient = new ChatClient();
