# PotSpark map lag and collision fix

The visual GLB is unchanged. The fix replaces per-frame triangle scanning and
the inaccurate one-box-per-mesh workaround with exact, BVH-accelerated static
collision geometry.

## What changed

- `js/physics.js` builds an acceleration tree for every static map mesh once
  during the loading screen.
- BVHs use non-mutating indirect triangle indices, so collider preparation
  cannot reorder the visible map geometry or disturb its texture assignment.
- `js/mapLoader.js` explicitly keeps glTF base-colour and emissive textures in
  sRGB. All eight embedded colour textures and original material colours remain.
- The HTTP Content Security Policy now permits same-document `blob:` fetches in
  `connect-src`. GLTFLoader uses these URLs to decode images embedded inside the
  GLB; blocking them was the actual reason the map rendered without textures.
- Join, fall recovery, death respawn, and initial client placement now use the
  requested spawn point `(-101.03, -16.60, -30.00)`.
- Movement, floor, ceiling, wall, and bullet raycasts reuse the same exact
  double-sided collider layer.
- The fused 305,160-triangle environment no longer becomes one arena-sized
  collision box, so real walls remain solid and doorways remain open.
- `server.js` streams large files and caches map assets for one day instead of
  forcing the 34 MB GLB to download again on every reload.
- `tests/map-collision.test.mjs` verifies collider construction, raycast
  acceleration, unchanged visual index/material/texture data, all eight colour
  textures, and that a player walking into a real map wall cannot cross it.

## Run

```bash
npm install
npm test
npm start
```

Open `http://127.0.0.1:5186` after the server starts.

The later server-authoritative movement work keeps this collider intact. See
`SERVER_AUTHORITY.md` for the current networking architecture and security
boundary.
