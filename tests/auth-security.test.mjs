import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createAuthSystem } from "../server/authSystem.js";
import {
  MatchAdmissionStore,
  hashOpaqueSecret,
} from "../server/matchAdmission.js";

const AUTH_ORIGIN = "http://auth.potspark.test";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function firstCookie(response, name) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";", 1)[0] || "";
}

function extractLink(message) {
  const match = String(message?.text || "").match(/https?:\/\/[^\s]+/);
  assert.ok(match, "email should contain an absolute single-use link");
  return new URL(match[0]);
}

async function startAuthHarness({ emailDelivery = true } = {}) {
  const emails = [];
  const authSystem = await createAuthSystem({
    baseURL: AUTH_ORIGIN,
    databasePath: ":memory:",
    checkBreaches: false,
    ...(emailDelivery ? { sendEmail: async (message) => emails.push(message) } : {}),
    secret: "tests-only-auth-secret-that-is-longer-than-32-bytes",
  });
  const server = http.createServer((req, res) => {
    void authSystem.handleRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;

  async function request(path, { method = "GET", body, cookie = "", redirect = "follow" } = {}) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      redirect,
      headers: {
        Origin: AUTH_ORIGIN,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(body !== undefined && path.startsWith("/api/potspark/")
          ? { "X-Potspark-Request": "1" }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  return {
    authSystem,
    emails,
    endpoint,
    request,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await authSystem.close();
    },
  };
}

test("email registration fails before account creation when delivery is unavailable", async () => {
  const harness = await startAuthHarness({ emailDelivery: false });
  try {
    const response = await harness.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "No Mail",
        email: "nomail@example.test",
        password: "correct horse battery spark",
      },
    });
    assert.equal(response.status, 503);
    assert.equal(harness.authSystem._database.prepare("SELECT count(*) AS total FROM user").get().total, 0);
  } finally {
    await harness.close();
  }
});

test("match tickets are hashed, principal-bound, epoch-bound, expiring, and single-use", async () => {
  let now = 10_000;
  const database = new Database(":memory:");
  const store = new MatchAdmissionStore({ kind: "sqlite", database, clock: () => now });
  await store.migrate();

  const guest = await store.createGuestSession({ ttlMs: 1_000 });
  assert.equal(await store.validateGuestSession(guest.secret, { touch: false }).then(Boolean), true);
  const guestRow = database.prepare("SELECT * FROM potspark_guest_sessions").get();
  assert.equal(guestRow.guest_hash, hashOpaqueSecret(guest.secret));
  assert.equal(JSON.stringify(guestRow).includes(guest.secret), false);

  const principal = {
    principalKey: `guest:${guest.guestHash}`,
    sessionId: `guest:${guest.guestHash}`,
    userId: null,
  };
  const stale = await store.issueTicket(principal, null, { ttlMs: 500 });
  const current = await store.issueTicket(principal, { playerId: 7, team: 2 }, { ttlMs: 500 });
  assert.equal(await store.consumeTicket(stale.secret, principal), null, "new epoch must invalidate an older ticket");
  assert.equal(await store.consumeTicket(current.secret, { ...principal, sessionId: "wrong" }), null);
  const consumed = await store.consumeTicket(current.secret, principal);
  assert.equal(consumed.connectionEpoch, current.connectionEpoch);
  assert.equal(consumed.binding.playerId, 7);
  assert.equal(await store.consumeTicket(current.secret, principal), null, "ticket must be one-use");

  const expiring = await store.issueTicket(principal, null, { ttlMs: 50 });
  now += 51;
  assert.equal(await store.consumeTicket(expiring.secret, principal), null);
  database.close();
});

test("email accounts use verified Argon2id credentials and revocable opaque sessions", async () => {
  const harness = await startAuthHarness();
  const email = "operator@example.test";
  const password = "correct horse battery spark";
  const replacement = "new correct horse battery spark";

  try {
    let response = await harness.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "Red Operator",
        email,
        password: "too-short",
        callbackURL: `${AUTH_ORIGIN}/?auth=verified`,
      },
    });
    assert.equal(response.status, 400);

    response = await harness.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "Red Operator",
        email,
        password,
        callbackURL: `${AUTH_ORIGIN}/?auth=verified`,
      },
    });
    assert.equal(response.status, 200);
    const signUpPayload = await response.json();
    assert.equal("token" in signUpPayload, false, "browser JSON must not expose a session token");
    assert.equal(harness.emails.length, 1);

    response = await harness.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "Red Operator",
        email,
        password,
        callbackURL: `${AUTH_ORIGIN}/?auth=verified`,
      },
    });
    assert.equal(response.status, 200, "duplicate registration must not enumerate an address");
    const duplicatePayload = await response.json();
    assert.equal("token" in duplicatePayload, false);
    assert.equal(duplicatePayload.user.email, email);

    const credential = harness.authSystem._database.prepare(`
      SELECT password FROM account WHERE providerId = 'credential'
    `).get();
    assert.match(credential.password, /^\$argon2id\$/);
    assert.equal(credential.password.includes(password), false);

    response = await harness.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Unable to sign in. Check your credentials and email verification.",
    });

    const verificationLink = extractLink(harness.emails.at(-1));
    const storedVerifications = harness.authSystem._database
      .prepare("SELECT challenge_hash FROM potspark_auth_challenges")
      .all();
    assert.ok(storedVerifications.length > 0);
    assert.equal(
      storedVerifications.some((entry) => verificationLink.href.includes(entry.challenge_hash)),
      false,
    );
    assert.equal(
      hashOpaqueSecret(verificationLink.searchParams.get("code")),
      storedVerifications[0].challenge_hash,
    );
    response = await harness.request(`${verificationLink.pathname}${verificationLink.search}`, {
      redirect: "manual",
    });
    assert.ok(response.status === 302 || response.status === 303);
    const verifiedRow = harness.authSystem._database
      .prepare("SELECT emailVerified FROM user WHERE email = ?")
      .get(email);
    assert.equal(verifiedRow.emailVerified, 1);
    assert.match(response.headers.get("location"), /auth=verified/);
    response = await harness.request(`${verificationLink.pathname}${verificationLink.search}`, {
      redirect: "manual",
    });
    assert.match(response.headers.get("location"), /auth=error/, "verification code must be one-use");

    response = await harness.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password, rememberMe: true },
    });
    assert.equal(response.status, 200);
    const sessionCookie = firstCookie(response, "potspark.session");
    assert.ok(sessionCookie);
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.equal("token" in await response.json(), false);

    response = await harness.request("/api/potspark/auth/me", { cookie: sessionCookie });
    const me = await response.json();
    assert.equal(me.authenticated, true);
    assert.equal(me.user.id.length > 8, true);
    assert.equal(me.user.username, "Red Operator");

    response = await harness.request("/api/potspark/account/sessions", { cookie: sessionCookie });
    const listed = await response.json();
    assert.equal(listed.sessions.length, 1);
    assert.equal(JSON.stringify(listed).includes("token"), false);

    harness.authSystem._database
      .prepare("UPDATE user SET status = 'suspended' WHERE email = ?")
      .run(email);
    response = await harness.request("/api/potspark/match-ticket", {
      method: "POST",
      body: {},
      cookie: sessionCookie,
    });
    assert.equal(response.status, 403, "a disabled account must not silently downgrade to guest");
    harness.authSystem._database
      .prepare("UPDATE user SET status = 'active' WHERE email = ?")
      .run(email);

    const revoked = [];
    const stopListening = harness.authSystem.onSessionRevoked((event) => revoked.push(event));
    response = await harness.request("/api/auth/request-password-reset", {
      method: "POST",
      body: { email: "missing@example.test", redirectTo: `${AUTH_ORIGIN}/?auth=reset` },
    });
    assert.equal(response.status, 200);
    const missingResetResponse = await response.json();
    response = await harness.request("/api/auth/request-password-reset", {
      method: "POST",
      body: { email, redirectTo: `${AUTH_ORIGIN}/?auth=reset` },
    });
    assert.equal(response.status, 200);
    const existingResetResponse = await response.json();
    assert.deepEqual(existingResetResponse, missingResetResponse);
    assert.match(existingResetResponse.message, /If this email exists/i);
    const resetLink = extractLink(harness.emails.at(-1));
    const resetRows = harness.authSystem._database
      .prepare("SELECT identifier FROM verification")
      .all();
    assert.ok(resetRows.length > 0);
    assert.equal(resetRows.some((entry) => resetLink.href.includes(entry.identifier)), false);
    response = await harness.request(`${resetLink.pathname}${resetLink.search}`, { redirect: "manual" });
    assert.ok(response.status === 302 || response.status === 303);
    const resetToken = new URL(response.headers.get("location")).searchParams.get("token");
    assert.ok(resetToken);

    response = await harness.request("/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: replacement, token: resetToken },
    });
    assert.equal(response.status, 200);
    assert.ok(revoked.length >= 1, "password reset must revoke active sessions");
    stopListening();

    response = await harness.request("/api/potspark/auth/me", { cookie: sessionCookie });
    assert.equal((await response.json()).authenticated, false);
    response = await harness.request("/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: replacement, token: resetToken },
    });
    assert.equal(response.status, 400, "reset identifier must be single-use");

    response = await harness.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: replacement },
    });
    assert.equal(response.status, 200);
  } finally {
    await harness.close();
  }
});

test("the account UI supports autofill without browser token storage", async () => {
  const [html, client] = await Promise.all([
    fsp.readFile(path.join(PROJECT_ROOT, "index.html"), "utf8"),
    fsp.readFile(path.join(PROJECT_ROOT, "js/auth.js"), "utf8"),
  ]);
  assert.match(html, /id="accountModal"/);
  assert.match(html, /src="\.\/js\/auth\.js"/);
  assert.match(client, /autocomplete="email"/);
  assert.match(client, /passwordField\("signinPassword", "Password", "current-password"\)/);
  assert.match(client, /passwordField\("signupPassword", "Passphrase", "new-password"/);
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.doesNotMatch(client, /[?&](?:access_token|session_token)=/i);
});

test("production auth fails closed without HTTPS, a durable database, or a strong secret", async () => {
  await assert.rejects(
    createAuthSystem({ baseURL: "http://example.test", databasePath: ":memory:", secret: "weak" }),
    /32-byte/,
  );
  await assert.rejects(
    createAuthSystem({ production: true, baseURL: "http://example.test", secret: "x".repeat(40) }),
    /HTTPS/,
  );
  await assert.rejects(
    createAuthSystem({ production: true, baseURL: "https://example.test", secret: "x".repeat(40) }),
    /DATABASE_URL/,
  );
});

test("HTTPS configuration uses __Host cookies and forbids implicit identity linking", async () => {
  const authSystem = await createAuthSystem({
    baseURL: "https://play.example.test",
    databasePath: ":memory:",
    checkBreaches: false,
    sendEmail: async () => {},
    secret: "tests-only-auth-secret-that-is-longer-than-32-bytes",
  });
  try {
    assert.equal(authSystem.secureCookies, true);
    assert.equal(
      authSystem.auth.options.advanced.cookies.session_token.name,
      "__Host-potspark.session",
    );
    assert.equal(
      authSystem.auth.options.account.accountLinking.disableImplicitLinking,
      true,
    );
    assert.equal(
      authSystem.auth.options.account.accountLinking.allowDifferentEmails,
      false,
    );
  } finally {
    await authSystem.close();
  }
});

test("OAuth authorization starts with state, Google PKCE and nonce, and minimal Discord scopes", async () => {
  const authSystem = await createAuthSystem({
    baseURL: "https://play.example.test",
    databasePath: ":memory:",
    checkBreaches: false,
    sendEmail: async () => {},
    googleClientId: "google-client-id",
    googleClientSecret: "google-client-secret",
    discordClientId: "discord-client-id",
    discordClientSecret: "discord-client-secret",
    secret: "tests-only-auth-secret-that-is-longer-than-32-bytes",
  });
  try {
    async function begin(provider) {
      const response = await authSystem.auth.handler(new Request(
        "https://play.example.test/api/auth/sign-in/social",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://play.example.test",
          },
          body: JSON.stringify({
            provider,
            callbackURL: "https://play.example.test/?auth=complete",
            disableRedirect: true,
          }),
        },
      ));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(typeof payload.url, "string");
      assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
      return new URL(payload.url);
    }

    const google = await begin("google");
    assert.ok(google.searchParams.get("state"));
    assert.ok(google.searchParams.get("nonce"));
    assert.equal(google.searchParams.get("code_challenge_method"), "S256");
    assert.ok(google.searchParams.get("code_challenge"));
    assert.match(google.searchParams.get("scope"), /openid/);

    const discord = await begin("discord");
    assert.ok(discord.searchParams.get("state"));
    const scopes = new Set(String(discord.searchParams.get("scope")).split(/\s+/));
    assert.deepEqual(scopes, new Set(["identify", "email"]));
  } finally {
    await authSystem.close();
  }
});
