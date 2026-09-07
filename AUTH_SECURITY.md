# Potspark account and match security

## Security model

Potspark uses Better Auth for accounts and sessions, Argon2id for password hashing, and a small server-owned admission store for guest sessions and match tickets.

- Every account has one immutable internal user ID. Google, Discord, and credential identities are provider accounts attached to that ID.
- Matching email addresses never silently merge accounts. Social identities can only be linked from a recent authenticated session, and the last sign-in method cannot be removed.
- Passwords must contain 15–128 characters, are normalized with NFKC, and are hashed with Argon2id (19 MiB memory, two iterations, one lane). The production breach-password check is enabled by default.
- Email verification codes and match tickets are random, hashed at rest, expiring, and atomically single-use. Password-reset identifiers use Better Auth’s hashed atomic verification store.
- Browser sessions are opaque server-side sessions. JavaScript never receives the session token; session cookies are host-only, `HttpOnly`, `SameSite=Lax`, and `Secure` in HTTPS deployments. The production cookie is named `__Host-potspark.session`.
- JSON auth responses are scrubbed of access, refresh, ID, session, and bearer token fields. OAuth credentials are never persisted in account rows and are excluded from application logs.
- State-changing game-account endpoints require an exact trusted origin plus the `X-Potspark-Request: 1` header. Better Auth’s own endpoints retain its origin and CSRF checks.

## Match admission and reconnects

The WebSocket URL is always `/game` and contains no credential. The client first obtains a 20-second match ticket over same-origin HTTPS, then sends it in a fixed binary frame as the first WebSocket message.

Each ticket is bound to the principal, browser session, user (when present), current player/room/match/team context, and a monotonically increasing connection epoch. Issuing a newer ticket invalidates older unconsumed tickets; consumption is atomic. One principal can own one active match connection.

On an unexpected disconnect, input is neutralized immediately while the avatar remains in the authoritative world and remains vulnerable. The server reserves the player ID, team, room, match, health, and loadout for 15 seconds. A fresh ticket reclaims the same seat with a new connection epoch and reset input/combat sequence state. When grace expires, normal room and match cleanup runs.

## Required production configuration

Set these through the deployment’s secret manager:

- `NODE_ENV=production`
- `BETTER_AUTH_URL=https://<public-host>`
- `BETTER_AUTH_SECRET` containing at least 32 random bytes (for example, output from `openssl rand -base64 32`)
- `DATABASE_URL` for a durable PostgreSQL database
- `ALLOWED_ORIGINS` containing the exact public origin; separate multiple origins with commas
- `SMTP_URL` and `AUTH_EMAIL_FROM` for verification and password recovery
- `TRUST_PROXY=1` only when the TLS proxy removes any client-supplied `X-Forwarded-For` value and writes the authoritative client chain

The process refuses to start in production when HTTPS, the auth secret, or PostgreSQL is missing. Put TLS in front of the Node process and forward both ordinary HTTP and WebSocket upgrade traffic without rewriting `/api/auth`, `/api/potspark`, or `/game`. Do not expose the local SQLite database, `.env`, source maps outside `js/`, or server files through a static-file fallback.

Configure the proxy to preserve the public `Host` header and to omit query strings and request bodies from access logs for auth, verification, recovery, and OAuth callback routes. Application logging already drops structured auth arguments, but an upstream default access log can otherwise record short-lived codes.

## OAuth provider configuration

Provider buttons appear only when both client ID and client secret are present.

Google:

- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Register `https://<public-host>/api/auth/callback/google` as the redirect URI.
- Potspark uses authorization code flow with state, PKCE, and nonce. It verifies signature, issuer, audience, authorized party, expiry, issue time, nonce, and stable `sub` before accepting the identity.

Discord:

- Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
- Register `https://<public-host>/api/auth/callback/discord` as the redirect URI.
- Only the `identify` and `email` scopes are requested. The stable Discord provider ID—not an email address—is the external identity key.

## Session and incident operations

- Sessions expire after seven days, refresh at most daily, and require a session created within the last ten minutes for link/unlink operations.
- Players can revoke another device, sign out the current device, or sign out everywhere from the Account dialog. Database session deletion immediately revokes outstanding match tickets and closes the corresponding live match connection.
- A successful password reset atomically consumes the reset identifier and revokes every session for that account.
- Security event records contain event type, internal principal/user references, and bounded metadata. They never contain cookies, passwords, OAuth codes, or tokens.

Before each deployment, run:

```sh
npm ci
npm test
npm audit --omit=dev
```

Rotate the auth secret only as a planned global sign-out. Rotate OAuth and SMTP credentials independently, review failed-auth/rate-limit events, keep PostgreSQL backups encrypted and tested, and patch dependencies promptly.
