# PotSpark authoritative weapon combat

## Trust boundary

The browser sends a 24-byte shot request containing only:

- Protocol version
- Monotonic shot sequence
- The exact movement-input sequence that supplied the aim
- A recent rendered server tick for bounded lag compensation
- Yaw and pitch, which must match that stored input

There is no target id, weapon id, client origin, hit zone, damage, spread, ammo
count, client delta time, or client timestamp in the frame. Extra bytes are
rejected. The server already knows which weapon the player selected when they
entered the match, so a modified client cannot request another gun's damage.

## Server-owned weapon rules

| Weapon | Mode | RPM | Base damage | Magazine | Reserve | Reload | Range | Spread |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ARC-7 | Automatic rifle | 600 | 28 | 30 | 90 | 2.2 s | 300 | 0.022 |
| Vesper | Automatic SMG | 900 | 16 | 45 | 135 | 1.7 s | 100 | 0.055 |
| Recon | Semi-auto sniper | 40 | 120 | 5 | 15 | 3.5 s | 1500 | 0.001 |
| Breach | Semi-auto pistol | 240 | 30 | 12 | 48 | 1.5 s | 150 | 0.005 |

The shared table in `js/protocol.js` supplies client prediction values and the
server's real rules. Editing those values in a browser changes presentation
only; the Node server imports its own trusted copy.

## What the server decides

- Equipped weapon and weapon-specific movement speed
- Whether the player is alive and allowed to fire
- Whether the linked input and aim are genuine and current
- Whether the requested rewind is within the 300 ms history window
- Magazine, reserve ammo, fire interval, and reload completion
- Server-randomized spread and authoritative shot origin
- Exact BVH map occlusion before any player hit
- Rewound head, body, and leg hitboxes
- Damage, health, death, three-second respawn, and one-second spawn protection

The client predicts muzzle flash, recoil, ammo presentation, reload animation,
and map impact effects for responsiveness. It shows a player hitmarker only
after receiving the server result.

## Run and verify

```bash
npm ci
npm test
npm start
```

Open `http://127.0.0.1:5186` in two browser windows and select any matching
loadout weapon. Test after the one-second spawn shield expires.

The automated suite covers all four weapon identities and assets, exact weapon
rules, weapon-spoof attempts, malformed and oversized frames, forged target and
damage fields, invalid aim links, stale rewinds, real-wall occlusion, 1,000-shot
packet floods for every gun, fire-rate enforcement, ammo and reload timing, lag
compensation, death/respawn, and a live two-client rifle exchange.

## Honest security limit

Server authority prevents a modified browser from awarding itself a hit,
weapon damage, ammo, or fire rate. It does not make an online FPS literally
unhackable. Aimbots can still generate legitimate-looking aim inputs, and recoil
can be visually counteracted. Those problems require telemetry, detection,
moderation, authenticated identities, and production infrastructure.
