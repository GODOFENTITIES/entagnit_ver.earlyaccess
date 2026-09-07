# PotSpark server authority

PotSpark now uses server-authoritative movement and combat for every selectable
weapon while preserving Redline Yard, exact BVH collision, and the existing UI.

## Run

```bash
npm ci
npm test
npm start
```

Open `http://127.0.0.1:5186`.

The server indexes the 34 MB map collider before it begins listening. No player
is accepted until authoritative collision is ready.

## What the server owns

- Position and horizontal/vertical velocity
- Gravity, grounding, jumping, crouching, sprint, and ADS slowdown
- Weapon-specific movement speed selected at deployment
- Exact floor, wall, doorway, ceiling, and building collision from the map BVH
- Fixed 60 Hz simulation and 20 Hz state snapshots
- Last processed input acknowledgement for client reconciliation
- Equipped weapon, ammo, reserve, reload, cadence, spread, range, and damage
- Map occlusion, lag-compensated hitboxes, health, death, and respawn
- Private room codes, balanced team assignment, readiness, and match start
- Room-isolated snapshots and combat with server-enforced friendly teams

The browser's 16-byte movement command contains only protocol version, input
sequence, key mask, yaw, and pitch. Its 24-byte shot command contains a shot
sequence, linked input sequence, bounded rewind tick, yaw, and pitch. Neither
frame has fields for position, velocity, target, weapon damage, ammo, or client
elapsed time.

## Prediction and reconciliation

The local player predicts movement at the same fixed 60 Hz step. Each predicted
input is kept until acknowledged. On a snapshot, the browser restores the
server state and replays every unacknowledged command. Small visual corrections
decay through a camera-only offset; physics remains at the corrected state.

Weapon recoil, muzzle flash, viewmodels, HUD ammo changes, and map sparks are
also predicted immediately. Only the server may confirm a player hitmarker or
change another player's health.

## Abuse resistance

- Exact packet lengths, reserved-byte checks, and protocol versioning
- Rejection of non-finite values and invalid or excessive sequences
- Input and shot token buckets, fixed server time, and newest-state movement
- Server-only weapon selection after match entry
- Server RPM, magazine, reserve, reload, spread, range, and damage enforcement
- Historical hitboxes plus real-map BVH line-of-sight validation
- WebSocket payload limit, backpressure cap, heartbeat, and same-origin upgrade
- Per-IP connection cap and invalid-traffic disconnects
- Static-file allowlist: server source, package files, backups, tests, and logs
  are not web-accessible
- Escaping of mock-chat text before HTML insertion

Tests cover legacy position packets, `NaN`, protocol mismatch, teleport fields,
movement and firing floods, reconciliation replay, every gun's combat rules and
model asset, weapon spoofing, live WebSocket clients, protected server files,
map caching, preserved map colour textures, BVH acceleration, wall occlusion,
real-wall collision, randomized room codes, team balancing, early-entry denial,
unanimous readiness, disconnect cleanup, and room-isolated snapshots.

## Security boundary

No online game can truthfully be called unhackable. A modified client cannot
choose movement results, targets, weapon identity after spawning, damage, ammo,
reload completion, fire timing, or confirmed hits. Client-side aim assistance
and recoil-removal cheats still require behavioural detection and enforcement;
production also needs accounts, authenticated sessions, operational monitoring,
and DDoS protection.
