import { createHmac, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { Algorithm, hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import {
  createAuthorizationURL,
  validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import { verifyGoogleIdToken } from "@better-auth/core/social-providers";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import Database from "better-sqlite3";
import { decodeJwt } from "jose";
import nodemailer from "nodemailer";
import pg from "pg";

import {
  GUEST_SESSION_TTL_MS,
  MATCH_TICKET_TTL_MS,
  MatchAdmissionStore,
  hashOpaqueSecret,
} from "./matchAdmission.js";

const { Pool } = pg;

const AUTH_BODY_LIMIT = 64 * 1024;
const FRESH_SESSION_MS = 10 * 60 * 1000;
const AUTH_API_PREFIX = "/api/auth";
const GAME_API_PREFIX = "/api/potspark";
const GUEST_COOKIE_DEV = "potspark.guest";
const GUEST_COOKIE_SECURE = "__Host-potspark.guest";
const SESSION_COOKIE_DEV = "potspark.session";
const SESSION_COOKIE_SECURE = "__Host-potspark.session";

// These Better Auth endpoints either expose bearer material or bypass the
// recent-reauthentication wrappers below. They remain available to trusted
// server-side auth.api calls, but never directly to browser JavaScript.
const BLOCKED_BROWSER_AUTH_PATHS = new Set([
  "/account-info",
  "/change-email",
  "/get-access-token",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/refresh-token",
  "/revoke-session",
  "/unlink-account",
  "/verify-email",
]);

const EMAIL_DELIVERY_PATHS = new Set([
  "/request-password-reset",
  "/send-verification-email",
  "/sign-up/email",
]);

const ARGON2_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

function normalizePassword(password) {
  return String(password).normalize("NFKC");
}

export async function hashPassword(password) {
  return argon2Hash(normalizePassword(password), ARGON2_OPTIONS);
}

export async function verifyPassword({ hash, password }) {
  return argon2Verify(hash, normalizePassword(password));
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") return "Operator";
  const clean = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>&"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...(clean || "Operator")].slice(0, 24).join("");
}

function parseCookies(header) {
  const cookies = new Map();
  for (const pair of String(header || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key || cookies.has(key)) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function serializeCookie(name, value, {
  secure,
  maxAge,
  expires,
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`);
  return parts.join("; ");
}

function safeJsonClone(value) {
  if (Array.isArray(value)) return value.map(safeJsonClone);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:accessToken|refreshToken|idToken|sessionToken|token)$/i.test(key)) continue;
    result[key] = safeJsonClone(child);
  }
  return result;
}

async function readBody(req, limit = AUTH_BODY_LIMIT) {
  const length = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(length) && length > limit) {
    const error = new Error("Request body too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (contentType !== "application/json") {
    const error = new Error("JSON required");
    error.statusCode = 415;
    throw error;
  }
  const body = await readBody(req);
  try {
    return body.length ? JSON.parse(body.toString("utf8")) : {};
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function requestOrigin(req, baseURL) {
  const explicit = req.headers.origin;
  if (explicit) return explicit;
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return req.method === "GET" || req.method === "HEAD" ? new URL(baseURL).origin : null;
}

function trustedRedirect(raw, trustedOrigins, fallbackOrigin) {
  try {
    const target = new URL(raw || "/", fallbackOrigin);
    return trustedOrigins.has(target.origin) ? target : new URL("/", fallbackOrigin);
  } catch {
    return new URL("/", fallbackOrigin);
  }
}

function isSafeStateChange(req, trustedOrigins, baseURL, production) {
  if (req.headers["x-potspark-request"] !== "1") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = requestOrigin(req, baseURL);
  if (!origin) return false;
  if (trustedOrigins.has(origin)) return true;
  if (production) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function clientAddress(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
    if (isIP(forwarded)) return forwarded;
  }
  return req.socket?.remoteAddress || "unknown";
}

function publicSession(session) {
  if (!session?.user || !session?.session) return null;
  return {
    authenticated: true,
    user: {
      id: session.user.id,
      username: normalizeDisplayName(session.user.name),
      email: session.user.email,
      emailVerified: session.user.emailVerified === true,
      image: session.user.image || null,
    },
    session: {
      id: session.session.id,
      createdAt: session.session.createdAt,
      expiresAt: session.session.expiresAt,
    },
  };
}

class WindowLimiter {
  constructor() {
    this.entries = new Map();
    this.operations = 0;
  }

  consume(key, max, windowMs, now = Date.now()) {
    this.operations += 1;
    if (this.operations % 256 === 0) this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

function createAbuseHook() {
  const limiter = new WindowLimiter();
  const sensitive = new Map([
    ["/sign-in/email", { identifierMax: 8, globalMax: 300, windowMs: 60_000 }],
    ["/sign-up/email", { identifierMax: 4, globalMax: 120, windowMs: 5 * 60_000 }],
    ["/request-password-reset", { identifierMax: 4, globalMax: 120, windowMs: 5 * 60_000 }],
    ["/send-verification-email", { identifierMax: 4, globalMax: 120, windowMs: 5 * 60_000 }],
  ]);
  return createAuthMiddleware(async (ctx) => {
    const rule = sensitive.get(ctx.path);
    if (!rule) return;
    const identifier = typeof ctx.body?.email === "string"
      ? ctx.body.email.normalize("NFKC").trim().toLowerCase()
      : "unknown";
    const now = Date.now();
    const allowed = limiter.consume(
      `${ctx.path}:identifier:${identifier}`,
      rule.identifierMax,
      rule.windowMs,
      now,
    ) && limiter.consume(`${ctx.path}:global`, rule.globalMax, rule.windowMs, now);
    if (!allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Too many attempts. Please wait and try again.",
        code: "RATE_LIMITED",
      });
    }
  });
}

function scrubOAuthTokens(account) {
  if (!account || account.providerId === "credential") return;
  return {
    data: {
      ...account,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  };
}

function createSecureGooglePlugin({ clientId, clientSecret, secret }) {
  const verifiedTokens = new Map();
  const nonceFor = (codeVerifier) => createHmac("sha256", secret)
    .update(`potspark-google-nonce:${codeVerifier}`, "utf8")
    .digest("base64url");

  const provider = {
    id: "google",
    name: "Google",
    async createAuthorizationURL({ state, scopes, codeVerifier, redirectURI }) {
      if (!codeVerifier) throw new Error("Google PKCE verifier missing");
      return createAuthorizationURL({
        id: "google",
        options: { clientId, clientSecret },
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        state,
        codeVerifier,
        scopes: scopes || ["openid", "email", "profile"],
        redirectURI,
        prompt: "select_account",
        additionalParams: {
          nonce: nonceFor(codeVerifier),
          include_granted_scopes: "true",
        },
      });
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      if (!codeVerifier) throw new Error("Google PKCE verifier missing");
      const tokens = await validateAuthorizationCode({
        code,
        codeVerifier,
        redirectURI,
        options: { clientId, clientSecret },
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      });
      if (!tokens.idToken) throw new Error("Google ID token missing");
      const claims = await verifyGoogleIdToken({
        token: tokens.idToken,
        audience: clientId,
        nonce: nonceFor(codeVerifier),
      });
      if (
        !claims?.sub
        || typeof claims.iat !== "number"
        || (claims.azp && claims.azp !== clientId)
      ) throw new Error("Google ID token validation failed");
      verifiedTokens.set(hashOpaqueSecret(tokens.idToken), {
        claims,
        expiresAt: Date.now() + 60_000,
      });
      if (verifiedTokens.size > 64) {
        for (const [key, value] of verifiedTokens) {
          if (value.expiresAt <= Date.now() || verifiedTokens.size > 64) verifiedTokens.delete(key);
        }
      }
      return tokens;
    },
    async getUserInfo(tokens) {
      const tokenHash = hashOpaqueSecret(tokens.idToken);
      const verified = verifiedTokens.get(tokenHash);
      verifiedTokens.delete(tokenHash);
      if (!verified || verified.expiresAt <= Date.now()) return null;
      const claims = verified.claims || decodeJwt(tokens.idToken);
      return {
        user: {
          id: claims.sub,
          name: normalizeDisplayName(claims.name || claims.email?.split("@")[0]),
          email: claims.email,
          emailVerified: claims.email_verified === true,
          image: claims.picture || null,
        },
        data: claims,
      };
    },
    options: { clientId, clientSecret },
  };

  return {
    id: "potspark-secure-google",
    init(ctx) {
      return {
        context: {
          socialProviders: [
            provider,
            ...ctx.socialProviders.filter((candidate) => candidate.id !== "google"),
          ],
        },
      };
    },
  };
}

async function createDatabase({ root, databasePath, databaseURL, production }) {
  if (databaseURL) {
    const pool = new Pool({
      connectionString: databaseURL,
      ssl: process.env.PGSSLMODE === "disable" ? false : undefined,
      max: Number(process.env.PGPOOL_MAX || 10),
    });
    await pool.query("SELECT 1");
    return { kind: "postgres", database: pool, ownsDatabase: true };
  }
  if (production) {
    throw new Error("DATABASE_URL is required in production");
  }

  const resolvedPath = databasePath === ":memory:"
    ? databasePath
    : path.resolve(databasePath || path.join(root, ".potspark-data/auth.sqlite"));
  if (resolvedPath !== ":memory:") await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  const database = new Database(resolvedPath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (resolvedPath !== ":memory:") database.pragma("journal_mode = WAL");
  return { kind: "sqlite", database, ownsDatabase: true };
}

function createEmailDelivery(options) {
  if (typeof options.sendEmail === "function") return options.sendEmail;
  const smtpURL = options.smtpURL || process.env.SMTP_URL;
  if (!smtpURL) return null;
  const transport = nodemailer.createTransport(smtpURL);
  const from = options.emailFrom || process.env.AUTH_EMAIL_FROM || "Potspark <no-reply@localhost>";
  return async ({ to, subject, text }) => {
    await transport.sendMail({ from, to, subject, text });
  };
}

const GENERIC_AUTH_ERRORS = Object.freeze({
  "/sign-in/email": "Unable to sign in. Check your credentials and email verification.",
  "/sign-up/email": "Unable to create an account with those details.",
  "/request-password-reset": "If the address can receive a reset, the link is on its way.",
  "/reset-password": "Unable to reset the password. The link may be invalid or expired.",
  "/send-verification-email": "Unable to send a verification email right now.",
});

async function forwardAuthResponse(response, res, authPath = "") {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie" || name.toLowerCase() === "content-length") continue;
    headers[name] = value;
  }
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  if (setCookies.length) headers["Set-Cookie"] = setCookies;
  headers["Cache-Control"] = "no-store";

  const raw = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";
  let body = raw;
  let status = response.status;
  if (contentType.includes("application/json") && raw.length) {
    try {
      const parsed = safeJsonClone(JSON.parse(raw.toString("utf8")));
      if (
        authPath === "/sign-up/email"
        && status >= 400
        && /USER_ALREADY_EXISTS/i.test(String(parsed.code || parsed.error || ""))
      ) {
        status = 200;
        body = Buffer.from(JSON.stringify({
          status: true,
          message: "If the address can be used, check your email to continue.",
        }), "utf8");
      } else if (status >= 400 && GENERIC_AUTH_ERRORS[authPath]) {
        body = Buffer.from(JSON.stringify({ error: GENERIC_AUTH_ERRORS[authPath] }), "utf8");
      } else {
        body = Buffer.from(JSON.stringify(parsed), "utf8");
      }
    } catch {
      body = Buffer.from(JSON.stringify({ error: "Authentication request failed" }), "utf8");
    }
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function providerConfig(options) {
  const googleClientId = options.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = options.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const discordClientId = options.discordClientId || process.env.DISCORD_CLIENT_ID;
  const discordClientSecret = options.discordClientSecret || process.env.DISCORD_CLIENT_SECRET;
  return {
    google: googleClientId && googleClientSecret
      ? { clientId: googleClientId, clientSecret: googleClientSecret }
      : null,
    discord: discordClientId && discordClientSecret
      ? { clientId: discordClientId, clientSecret: discordClientSecret }
      : null,
  };
}

export async function createAuthSystem(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const production = options.production ?? process.env.NODE_ENV === "production";
  const baseURL = options.baseURL || process.env.BETTER_AUTH_URL || "http://127.0.0.1:5186";
  const parsedBaseURL = new URL(baseURL);
  if (production && parsedBaseURL.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production");
  }
  const secureCookies = options.secureCookies ?? parsedBaseURL.protocol === "https:";
  const sessionCookieName = secureCookies ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV;
  const guestCookieName = secureCookies ? GUEST_COOKIE_SECURE : GUEST_COOKIE_DEV;
  const secret = options.secret
    || process.env.BETTER_AUTH_SECRET
    || process.env.POTSPARK_AUTH_SECRET
    || (production ? null : randomBytes(32).toString("base64url"));
  if (!secret || secret.length < 32) throw new Error("A 32-byte BETTER_AUTH_SECRET is required");

  const trustedOrigins = new Set([
    parsedBaseURL.origin,
    ...(options.trustedOrigins || []),
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  const providers = providerConfig(options);
  const emailDelivery = createEmailDelivery(options);
  const databaseBundle = options.databaseBundle || await createDatabase({
    root,
    production,
    databasePath: options.databasePath || (options.inMemory ? ":memory:" : undefined),
    databaseURL: options.databaseURL || process.env.DATABASE_URL,
  });
  const { kind, database } = databaseBundle;
  const admissionStore = new MatchAdmissionStore({ kind, database, clock: options.clock });
  const sessionListeners = new Set();
  const userListeners = new Set();
  const abuseHook = createAbuseHook();

  const plugins = [
    haveIBeenPwned({ enabled: options.checkBreaches !== false }),
  ];
  if (providers.google) {
    plugins.unshift(createSecureGooglePlugin({ ...providers.google, secret }));
  }

  const auth = betterAuth({
    appName: "Potspark",
    baseURL,
    basePath: AUTH_API_PREFIX,
    secret,
    database,
    trustedOrigins: [...trustedOrigins],
    socialProviders: providers.discord ? {
      discord: {
        clientId: providers.discord.clientId,
        clientSecret: providers.discord.clientSecret,
        scope: ["identify", "email"],
      },
    } : {},
    plugins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 30 * 60,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: async ({ user, url }) => {
        if (!emailDelivery) throw new Error("Email delivery is not configured");
        await emailDelivery({
          to: user.email,
          subject: "Reset your Potspark password",
          text: `A password reset was requested for your Potspark account. Use this single-use link within 30 minutes:\n\n${url}\n\nIf this was not you, ignore this message.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        if (!emailDelivery) throw new Error("Email delivery is not configured");
        const betterAuthURL = new URL(url);
        const callbackURL = trustedRedirect(
          betterAuthURL.searchParams.get("callbackURL"),
          trustedOrigins,
          parsedBaseURL.origin,
        );
        const challenge = await admissionStore.issueAuthChallenge(
          "verify-email",
          user.id,
          user.email,
          { ttlMs: 60 * 60_000 },
        );
        const verificationURL = new URL(`${GAME_API_PREFIX}/auth/verify-email`, parsedBaseURL.origin);
        verificationURL.searchParams.set("code", challenge.secret);
        verificationURL.searchParams.set("callbackURL", callbackURL.href);
        await emailDelivery({
          to: user.email,
          subject: "Verify your Potspark email",
          text: `Verify your Potspark email with this single-use link:\n\n${verificationURL.href}\n\nThe link expires in one hour.`,
        });
      },
    },
    user: {
      additionalFields: {
        status: { type: "string", required: true, defaultValue: "active", input: false },
        role: { type: "string", required: true, defaultValue: "player", input: false },
        bannedUntil: { type: "date", required: false, input: false },
      },
      changeEmail: {
        enabled: false,
      },
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({ user, url }) => {
          if (!emailDelivery) throw new Error("Email delivery is not configured");
          await emailDelivery({
            to: user.email,
            subject: "Confirm Potspark account deletion",
            text: `Confirm account deletion with this single-use link:\n\n${url}\n\nIf this was not you, ignore this message.`,
          });
        },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: FRESH_SESSION_MS / 1000,
      cookieCache: { enabled: false },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    verification: {
      storeIdentifier: "hashed",
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 300, max: 5 },
        "/request-password-reset": { window: 300, max: 5 },
        "/send-verification-email": { window: 300, max: 5 },
        "/sign-in/social": { window: 60, max: 20 },
      },
    },
    advanced: {
      useSecureCookies: false,
      ipAddress: {
        ipAddressHeaders: ["x-potspark-client-ip"],
        ipv6Subnet: 64,
      },
      defaultCookieAttributes: {
        secure: secureCookies,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        session_token: {
          name: sessionCookieName,
          attributes: {
            secure: secureCookies,
            httpOnly: true,
            sameSite: "lax",
            path: "/",
          },
        },
      },
      cookiePrefix: "potspark-auth",
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    hooks: { before: abuseHook },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            return { data: { ...user, name: normalizeDisplayName(user.name) } };
          },
        },
        update: {
          async before(user) {
            return user.name === undefined
              ? undefined
              : { data: { ...user, name: normalizeDisplayName(user.name) } };
          },
        },
        delete: {
          async after(user) {
            await admissionStore.revokeUser(user.id);
            await admissionStore.recordEvent("user_deleted", {
              principalKey: `user:${user.id}`,
              userId: user.id,
            });
            for (const listener of userListeners) listener({ userId: user.id });
          },
        },
      },
      session: {
        create: {
          async after(session) {
            await admissionStore.recordEvent("session_created", {
              principalKey: `user:${session.userId}`,
              userId: session.userId,
            });
          },
        },
        delete: {
          async after(session) {
            await admissionStore.revokeSession(session.id);
            await admissionStore.recordEvent("session_revoked", {
              principalKey: `user:${session.userId}`,
              userId: session.userId,
            });
            for (const listener of sessionListeners) {
              listener({ sessionId: session.id, userId: session.userId });
            }
          },
        },
      },
      account: {
        create: { async before(account) { return scrubOAuthTokens(account); } },
        update: { async before(account) { return scrubOAuthTokens(account); } },
      },
    },
    logger: {
      level: production ? "warn" : "error",
      disableColors: true,
      log(level, message) {
        // Deliberately omit structured arguments: provider codes, reset links,
        // cookies, and tokens must never leak into application logs.
        console[level === "error" ? "error" : "warn"](`[auth] ${message}`);
      },
    },
    telemetry: { enabled: false },
  });

  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  await admissionStore.migrate();

  let bindingProvider = () => null;
  const ticketLimiter = new WindowLimiter();
  let chatBridge = options.chatBridge ?? null;
  let cleanupTimer = null;


  async function getBetterAuthSession(req) {
    try {
      return await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableCookieCache: true },
      });
    } catch {
      return null;
    }
  }

  function isAccountAllowed(session) {
    if (!session?.user || !session?.session) return false;
    if (session.user.status && session.user.status !== "active") return false;
    if (session.user.bannedUntil) {
      const until = new Date(session.user.bannedUntil).getTime();
      if (Number.isFinite(until) && until > Date.now()) return false;
    }
    return true;
  }

  async function resolvePrincipal(req, { allowCreateGuest = false, res = null } = {}) {
    const session = await getBetterAuthSession(req);
    if (session?.user && session?.session) {
      if (!isAccountAllowed(session)) return null;
      return {
        principalKey: `user:${session.user.id}`,
        sessionId: session.session.id,
        userId: session.user.id,
        username: normalizeDisplayName(session.user.name),
        authenticated: true,
        session,
      };
    }

    const cookies = parseCookies(req.headers.cookie);
    const guestSecret = cookies.get(guestCookieName);
    const guest = guestSecret
      ? await admissionStore.validateGuestSession(guestSecret)
      : null;
    if (guest) {
      return {
        principalKey: `guest:${guest.guestHash}`,
        sessionId: `guest:${guest.guestHash}`,
        userId: null,
        username: null,
        authenticated: false,
      };
    }
    if (!allowCreateGuest || !res) return null;

    const created = await admissionStore.createGuestSession();
    res.setHeader("Set-Cookie", serializeCookie(guestCookieName, created.secret, {
      secure: secureCookies,
      maxAge: Math.floor(GUEST_SESSION_TTL_MS / 1000),
    }));
    return {
      principalKey: `guest:${created.guestHash}`,
      sessionId: `guest:${created.guestHash}`,
      userId: null,
      username: null,
      authenticated: false,
    };
  }

  async function handleAuthRoute(req, res) {
    const authPath = (req.url || "").slice(AUTH_API_PREFIX.length).split("?")[0] || "/";
    if (BLOCKED_BROWSER_AUTH_PATHS.has(authPath)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!emailDelivery && EMAIL_DELIVERY_PATHS.has(authPath)) {
      sendJson(res, 503, { error: "Email authentication is temporarily unavailable" });
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
    const requestHeaders = fromNodeHeaders(req.headers);
    requestHeaders.set("x-potspark-client-ip", clientAddress(req));
    const request = new Request(new URL(req.url || AUTH_API_PREFIX, baseURL), {
      method: req.method,
      headers: requestHeaders,
      body: body?.length ? body : undefined,
    });
    const response = await auth.handler(request);
    await forwardAuthResponse(response, res, authPath);
  }

  async function requireAccount(req, res) {
    const session = await getBetterAuthSession(req);
    if (!isAccountAllowed(session)) {
      sendJson(res, 401, { error: "Authentication required" });
      return null;
    }
    return session;
  }

  function requireSafePost(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
      return false;
    }
    if (!isSafeStateChange(req, trustedOrigins, baseURL, production)) {
      sendJson(res, 403, { error: "Request origin rejected" });
      return false;
    }
    return true;
  }

  async function handleGameApi(req, res) {
    const url = new URL(req.url || GAME_API_PREFIX, baseURL);
    const route = url.pathname.slice(GAME_API_PREFIX.length) || "/";

    // ------------------------------------------------------------------
    // Chat bridge routes — only active when chatBridge is configured.
    // ------------------------------------------------------------------

    if (route === "/chat/config" && req.method === "GET") {
      if (!chatBridge) {
        sendJson(res, 503, { error: "Chat is not configured" });
        return;
      }
      sendJson(res, 200, chatBridge.publicConfig());
      return;
    }

    if (route === "/chat/token") {
      // Check chatBridge availability BEFORE method/CSRF checks to avoid leaking
      // the existence of CSRF protection to callers who would see 503 anyway.
      if (!chatBridge) {
        sendJson(res, 503, { error: "Chat is not configured" });
        return;
      }
      if (!requireSafePost(req, res)) return;
      const session = await requireAccount(req, res);
      if (!session) return; // requireAccount already sent 401
      await readJson(req);  // consume body (none expected, but drain it)

      const result = await chatBridge.issueToken(
        session.user.id,
        session.user.name || session.user.email,
      );
      if (result.rateLimited) {
        sendJson(res, 429, { error: "Too many token requests. Please wait." });
        return;
      }
      sendJson(res, 200, {
        token: result.token,
        supabaseUid: result.supabaseUid,
        expiresAt: result.expiresAt,
      });
      return;
    }


    // ------------------------------------------------------------------

    if (route === "/auth/config" && req.method === "GET") {

      sendJson(res, 200, {
        providers: {
          emailPassword: true,
          emailDelivery: !!emailDelivery,
          google: !!providers.google,
          discord: !!providers.discord,
        },
        password: { minLength: 15, maxLength: 128 },
      });
      return;
    }

    if (route === "/auth/verify-email" && req.method === "GET") {
      const callbackURL = trustedRedirect(
        url.searchParams.get("callbackURL"),
        trustedOrigins,
        parsedBaseURL.origin,
      );
      const challenge = await admissionStore.consumeAuthChallenge(
        url.searchParams.get("code"),
        "verify-email",
      );
      let verified = false;
      if (challenge) {
        if (kind === "sqlite") {
          const result = database.prepare(`
            UPDATE user SET emailVerified = 1, updatedAt = ?
            WHERE id = ? AND lower(email) = lower(?)
          `).run(Date.now(), challenge.user_id, challenge.email);
          verified = result.changes === 1;
        } else {
          const result = await database.query(`
            UPDATE "user" SET "emailVerified" = TRUE, "updatedAt" = $1
            WHERE id = $2 AND lower(email) = lower($3)
          `, [new Date(), challenge.user_id, challenge.email]);
          verified = result.rowCount === 1;
        }
      }
      if (verified && challenge) {
        await admissionStore.recordEvent("email_verified", {
          principalKey: `user:${challenge.user_id}`,
          userId: challenge.user_id,
        });
      }
      callbackURL.searchParams.set("auth", verified ? "verified" : "error");
      res.writeHead(302, {
        Location: callbackURL.href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }

    if (route === "/auth/me" && req.method === "GET") {
      const session = await getBetterAuthSession(req);
      sendJson(res, 200, isAccountAllowed(session)
        ? publicSession(session)
        : { authenticated: false, accountUnavailable: !!session });
      return;
    }

    if (route === "/match-ticket") {
      if (!requireSafePost(req, res)) return;
      await readJson(req);
      const ip = clientAddress(req);
      if (!ticketLimiter.consume(`ip:${ip}`, 30, 60_000)) {
        await admissionStore.recordEvent("match_ticket_rate_limited", null);
        sendJson(res, 429, { error: "Please wait before reconnecting" });
        return;
      }
      const principal = await resolvePrincipal(req, { allowCreateGuest: true, res });
      if (!principal) {
        sendJson(res, 403, { error: "Account unavailable" });
        return;
      }
      if (!ticketLimiter.consume(`principal:${principal.principalKey}`, 8, 60_000)) {
        await admissionStore.recordEvent("match_ticket_rate_limited", principal);
        sendJson(res, 429, { error: "Please wait before reconnecting" });
        return;
      }
      const binding = bindingProvider(principal.principalKey);
      const ticket = await admissionStore.issueTicket(principal, binding, {
        ttlMs: MATCH_TICKET_TTL_MS,
      });
      sendJson(res, 200, {
        ticket: ticket.secret,
        expiresAt: ticket.expiresAt,
        authenticated: principal.authenticated,
        username: principal.username,
      });
      return;
    }

    if (route === "/account/providers" && req.method === "GET") {
      const session = await requireAccount(req, res);
      if (!session) return;
      const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) });
      sendJson(res, 200, {
        providers: accounts.map((account) => account.providerId),
      });
      return;
    }

    if (route === "/account/sessions" && req.method === "GET") {
      const session = await requireAccount(req, res);
      if (!session) return;
      const sessions = await auth.api.listSessions({ headers: fromNodeHeaders(req.headers) });
      sendJson(res, 200, {
        currentSessionId: session.session.id,
        sessions: sessions.map((entry) => ({
          id: entry.id,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          expiresAt: entry.expiresAt,
          userAgent: entry.userAgent || "Unknown device",
          current: entry.id === session.session.id,
        })),
      });
      return;
    }

    if (route === "/account/revoke-session") {
      if (!requireSafePost(req, res)) return;
      const session = await requireAccount(req, res);
      if (!session) return;
      const body = await readJson(req);
      const sessions = await auth.api.listSessions({ headers: fromNodeHeaders(req.headers) });
      const target = sessions.find((entry) => entry.id === body.sessionId);
      if (!target) {
        sendJson(res, 200, { status: true });
        return;
      }
      await auth.api.revokeSession({
        body: { token: target.token },
        headers: fromNodeHeaders(req.headers),
      });
      sendJson(res, 200, { status: true });
      return;
    }

    if (route === "/account/sign-out-all") {
      if (!requireSafePost(req, res)) return;
      if (!await requireAccount(req, res)) return;
      await readJson(req);
      await auth.api.revokeSessions({ headers: fromNodeHeaders(req.headers) });
      sendJson(res, 200, { status: true }, {
        "Set-Cookie": serializeCookie(sessionCookieName, "", {
          secure: secureCookies,
          maxAge: 0,
          expires: new Date(0),
        }),
      });
      return;
    }

    if (route === "/account/link") {
      if (!requireSafePost(req, res)) return;
      const session = await requireAccount(req, res);
      if (!session) return;
      const age = Date.now() - new Date(session.session.createdAt).getTime();
      if (age > FRESH_SESSION_MS) {
        sendJson(res, 403, { error: "Please sign in again before linking an account" });
        return;
      }
      const body = await readJson(req);
      const provider = body.provider;
      if (!((provider === "google" && providers.google) || (provider === "discord" && providers.discord))) {
        sendJson(res, 400, { error: "Provider unavailable" });
        return;
      }
      const result = await auth.api.linkSocialAccount({
        body: {
          provider,
          callbackURL: `${parsedBaseURL.origin}/?account=linked`,
          errorCallbackURL: `${parsedBaseURL.origin}/?account=link-error`,
          disableRedirect: true,
        },
        headers: fromNodeHeaders(req.headers),
      });
      await admissionStore.recordEvent("identity_link_started", {
        principalKey: `user:${session.user.id}`,
        userId: session.user.id,
      }, { provider });
      sendJson(res, 200, { url: result.url, redirect: true });
      return;
    }

    if (route === "/account/unlink") {
      if (!requireSafePost(req, res)) return;
      const session = await requireAccount(req, res);
      if (!session) return;
      const age = Date.now() - new Date(session.session.createdAt).getTime();
      if (age > FRESH_SESSION_MS) {
        sendJson(res, 403, { error: "Please sign in again before unlinking an account" });
        return;
      }
      const body = await readJson(req);
      const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) });
      if (accounts.length <= 1 || !accounts.some((entry) => entry.providerId === body.provider)) {
        sendJson(res, 400, { error: "Keep at least one verified sign-in method" });
        return;
      }
      await auth.api.unlinkAccount({
        body: { providerId: body.provider },
        headers: fromNodeHeaders(req.headers),
      });
      await admissionStore.recordEvent("identity_unlinked", {
        principalKey: `user:${session.user.id}`,
        userId: session.user.id,
      }, { provider: body.provider });
      sendJson(res, 200, { status: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  async function handleRequest(req, res) {
    try {
      const pathname = (req.url || "/").split("?")[0];
      if (pathname === AUTH_API_PREFIX || pathname.startsWith(`${AUTH_API_PREFIX}/`)) {
        await handleAuthRoute(req, res);
        return true;
      }
      if (pathname === GAME_API_PREFIX || pathname.startsWith(`${GAME_API_PREFIX}/`)) {
        await handleGameApi(req, res);
        return true;
      }
      return false;
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) console.error(`[auth] request failed: ${error?.name || "Error"}`);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status >= 500 ? "Authentication service unavailable" : error.message,
        });
      } else {
        res.destroy();
      }
      return true;
    }
  }

  cleanupTimer = setInterval(() => {
    void admissionStore.cleanup().catch(() => {});
  }, 5 * 60_000);
  cleanupTimer.unref?.();

  async function close() {
    clearInterval(cleanupTimer);
    if (!databaseBundle.ownsDatabase) return;
    if (kind === "sqlite") database.close();
    else await database.end();
  }

  return {
    auth,
    baseURL,
    secureCookies,
    providers: {
      emailPassword: true,
      emailDelivery: !!emailDelivery,
      google: !!providers.google,
      discord: !!providers.discord,
    },
    handleRequest,
    resolvePrincipal,
    consumeMatchTicket: (ticket, principal) => admissionStore.consumeTicket(ticket, principal),
    recordSecurityEvent: (type, principal, details) => admissionStore.recordEvent(type, principal, details),
    setBindingProvider(provider) {
      bindingProvider = typeof provider === "function" ? provider : () => null;
    },
    /** Late-bind the ChatBridge after both authSystem and chatBridge are created. */
    _setChatBridge(bridge) {
      chatBridge = bridge;
    },
    onSessionRevoked(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    onUserRevoked(listener) {
      userListeners.add(listener);
      return () => userListeners.delete(listener);
    },
    close,
    _database: database,
    _databaseKind: kind,
    _admissionStore: admissionStore,
  };
}

export const AUTH_CONSTANTS = Object.freeze({
  AUTH_API_PREFIX,
  GAME_API_PREFIX,
  MATCH_TICKET_TTL_MS,
  FRESH_SESSION_MS,
});
