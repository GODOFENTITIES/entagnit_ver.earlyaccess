import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createAuthSystem } from "../server/authSystem.js";
import { createChatBridge } from "../server/chatBridge.js";

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const AUTH_ORIGIN = "http://auth.potspark.test";

/**
 * Stand up a real in-memory auth system + chatBridge wired together.
 * We use a per-test fetch proxy that routes:
 *   - requests to the test HTTP server endpoint → real node fetch (bypasses stub)
 *   - everything else (Supabase REST) → stub that returns test data
 *
 * This avoids the bug where globalThis.fetch = stub also intercepts the test's
 * own HTTP requests to the in-process server.
 */
async function startTokenHarness() {
  const emails = [];

  const authSystem = await createAuthSystem({
    baseURL: AUTH_ORIGIN,
    databasePath: ":memory:",
    checkBreaches: false,
    secret: "tests-only-auth-secret-that-is-longer-than-32-bytes",
    // Email delivery required so sign-up works and we can capture verification links.
    sendEmail: async (message) => emails.push(message),
  });

  const server = http.createServer((req, res) => {
    void authSystem.handleRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}`;

  // Install a fetch proxy so Supabase REST calls are stubbed but our own
  // HTTP requests to `endpoint` go through the real fetch untouched.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlInput, opts) => {
    const urlStr = typeof urlInput === "string" ? urlInput : urlInput.toString();
    if (urlStr.startsWith(endpoint)) return originalFetch(urlInput, opts);
    if (urlStr.includes("/rest/v1/game_channels") && opts?.method === "GET") {
      return new Response(JSON.stringify([{ id: "chan-123" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };

  const chatBridge = await createChatBridge({
    supabaseUrl: "https://test.supabase.co",
    anonKey: "test-anon-key",
    jwtSecret: "test-jwt-secret-that-is-long-enough",
    serviceKey: "test-service-key",
    dbKind: "sqlite",
    database: authSystem._database,
  });
  authSystem._setChatBridge(chatBridge);

  /** Make a CSRF-safe request to the test server. */
  async function request(path, { method = "GET", body, cookie = "" } = {}) {
    return originalFetch(`${endpoint}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Origin": AUTH_ORIGIN,
        ...(method === "POST" ? { "x-potspark-request": "1" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Register, verify email, and sign in — returns the session cookie.
   * Follows the same flow as the existing auth-security.test.mjs harness.
   */
  async function registerAndVerify(
    email = "player@test.local",
    password = "correct-horse-battery-staple!",
  ) {
    // 1. Sign up (sends a verification email via the sendEmail stub)
    const signupRes = await originalFetch(`${endpoint}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": AUTH_ORIGIN },
      body: JSON.stringify({
        name: "TestPlayer",
        email,
        password,
        callbackURL: `${AUTH_ORIGIN}/?auth=verified`,
      }),
    });
    assert.equal(signupRes.status, 200, `sign-up failed: ${signupRes.status}`);

    // 2. Hit the verification link captured from the email.
    const emailText = emails.at(-1)?.text ?? "";
    const linkMatch = emailText.match(/https?:\/\/\S+/);
    assert.ok(linkMatch, "verification email must contain a link");
    const verifyURL = new URL(linkMatch[0]);
    const verifyRes = await originalFetch(
      `${endpoint}${verifyURL.pathname}${verifyURL.search}`,
      { redirect: "manual", headers: { "Origin": AUTH_ORIGIN } },
    );
    assert.ok(verifyRes.status === 302 || verifyRes.status === 303, "verify endpoint must redirect");
    assert.match(verifyRes.headers.get("location") ?? "", /auth=verified/);

    // 3. Sign in.
    const signinRes = await originalFetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": AUTH_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(signinRes.status, 200, `sign-in failed: ${signinRes.status}`);

    // 4. Extract session cookie.
    const setCookies = signinRes.headers.getSetCookie?.()
      ?? [signinRes.headers.get("set-cookie")].filter(Boolean);
    const sessionCookie = setCookies
      .find((c) => c.includes("potspark.session"))
      ?.split(";")[0] ?? "";
    assert.ok(sessionCookie, "session cookie must be present");
    return sessionCookie;
  }

  async function stop() {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await authSystem.close();
  }

  return { request, registerAndVerify, chatBridge, emails, stop };
}


// ---------------------------------------------------------------------------
// GET /api/potspark/chat/config
// ---------------------------------------------------------------------------

test("GET /api/potspark/chat/config returns public Supabase config", async () => {
  const { request, stop } = await startTokenHarness();
  try {
    const res = await request("/api/potspark/chat/config");
    assert.equal(res.status, 200, `chat/config should return 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.url, "url must be present");
    assert.ok(body.anonKey, "anonKey must be present");
    assert.ok(typeof body.maxMessageLength === "number", "maxMessageLength must be a number");
    // Security: service key and jwt secret must never appear in response
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("test-jwt-secret"), "JWT secret must NOT appear in config response");
    assert.ok(!raw.includes("test-service-key"), "service key must NOT appear in config response");
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// POST /api/potspark/chat/token — guest (unauthenticated) rejection
// ---------------------------------------------------------------------------

test("POST /api/potspark/chat/token rejects unauthenticated requests with 401", async () => {
  const { request, stop } = await startTokenHarness();
  try {
    const res = await request("/api/potspark/chat/token", { method: "POST", body: {} });
    assert.equal(res.status, 401, `unauthenticated request must be rejected with 401, got ${res.status}`);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// POST /api/potspark/chat/token — happy path
// ---------------------------------------------------------------------------

test("POST /api/potspark/chat/token returns token for authenticated user", async () => {
  const { request, registerAndVerify, stop } = await startTokenHarness();
  try {
    const cookie = await registerAndVerify("token-happy@test.local");
    const res = await request("/api/potspark/chat/token", { method: "POST", body: {}, cookie });
    assert.equal(res.status, 200, `chat/token should return 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(typeof body.token === "string" && body.token.length > 0, "token must be a non-empty string");
    assert.ok(typeof body.supabaseUid === "string", "supabaseUid must be present");
    assert.ok(typeof body.expiresAt === "number", "expiresAt must be a number");
    assert.ok(body.expiresAt > Date.now(), "expiresAt must be in the future");
  } finally {
    await stop();
  }
});

test("POST /api/potspark/chat/token mints a valid HS256 JWT", async () => {
  const { request, registerAndVerify, stop } = await startTokenHarness();
  try {
    const cookie = await registerAndVerify("token-jwt@test.local");
    const res = await request("/api/potspark/chat/token", { method: "POST", body: {}, cookie });
    const { token } = await res.json();
    const [headerB64, payloadB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    assert.equal(header.alg, "HS256", "JWT algorithm must be HS256");
    assert.equal(payload.iss, "supabase");
    assert.equal(payload.aud, "authenticated");
    assert.equal(payload.role, "authenticated");
    assert.ok(payload.sub, "JWT must have a sub claim");
    assert.ok(payload.exp > Math.floor(Date.now() / 1000), "exp must be in the future");
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// Rate limiting via HTTP endpoint
// ---------------------------------------------------------------------------

test("POST /api/potspark/chat/token rate-limits after 10 requests", async () => {
  const { request, registerAndVerify, stop } = await startTokenHarness();
  try {
    const cookie = await registerAndVerify("token-ratelimit@test.local");
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request("/api/potspark/chat/token", { method: "POST", body: {}, cookie });
      statuses.push(res.status);
    }
    const successes = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    assert.equal(successes, 10, "exactly 10 tokens should succeed");
    assert.equal(limited, 2, "2 requests should be rate-limited with 429");
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// Method enforcement
// ---------------------------------------------------------------------------

test("GET /api/potspark/chat/token returns 405", async () => {
  const { request, registerAndVerify, stop } = await startTokenHarness();
  try {
    const cookie = await registerAndVerify("token-method@test.local");
    const res = await request("/api/potspark/chat/token", { method: "GET", cookie });
    assert.equal(res.status, 405, "GET on chat/token must return 405");
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// chat/config and chat/token return 503 when chatBridge is not configured
// ---------------------------------------------------------------------------

test("chat routes return 503 when chatBridge is not configured", async () => {
  const authSystem = await createAuthSystem({
    baseURL: AUTH_ORIGIN,
    databasePath: ":memory:",
    checkBreaches: false,
    secret: "tests-only-auth-secret-that-is-longer-than-32-bytes",
  });
  const server = http.createServer((req, res) => {
    void authSystem.handleRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const configRes = await fetch(`${base}/api/potspark/chat/config`);
    assert.equal(configRes.status, 503, `chat/config without bridge should 503, got ${configRes.status}`);

    // POST to chat/token without chatBridge — must check chatBridge BEFORE CSRF
    // so a 503 (not 403) is returned, avoiding information leakage about the CSRF check.
    const tokenRes = await fetch(`${base}/api/potspark/chat/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": AUTH_ORIGIN,
        "x-potspark-request": "1",
      },
      body: "{}",
    });
    assert.equal(tokenRes.status, 503, `chat/token without bridge should 503, got ${tokenRes.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await authSystem.close();
  }
});
