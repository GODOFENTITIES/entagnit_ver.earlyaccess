# Potspark 5v5

Potspark is a browser FPS with server-authoritative movement, combat, private team rooms, isolated 5v5 matchmaking, and secure optional accounts. Guests can still play immediately.

## Run locally

Requires Node.js 20.19 or newer.

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:5186`. Local development uses SQLite at `.potspark-data/auth.sqlite`. Without SMTP, new email registration and password recovery are shown as unavailable; guest play and existing account sign-in continue to work.

## Production

Copy `.env.example` into your deployment’s secret/configuration system—do not commit a populated `.env`. Production fails closed unless the public auth URL uses HTTPS, a strong auth secret is present, and PostgreSQL is configured.

See [AUTH_SECURITY.md](./AUTH_SECURITY.md) for provider callbacks, reverse-proxy requirements, session behavior, and operational checks. The existing match architecture is documented in [MATCH_INSTANCES.md](./MATCH_INSTANCES.md), [TEAM_ROOMS.md](./TEAM_ROOMS.md), [SERVER_AUTHORITY.md](./SERVER_AUTHORITY.md), and [SERVER_COMBAT.md](./SERVER_COMBAT.md).
