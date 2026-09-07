/**
 * physics.js – FPS character physics using Three.js Raycaster
 *
 * Performance strategy:
 *   - A MeshBVH is built once for each static map geometry during loading.
 *   - firstHitOnly then performs an accelerated closest-hit query instead of
 *     checking all 305k triangles in the large environment mesh every frame.
 *   - Exact, double-sided collision meshes share the render geometry but never
 *     enter the scene, so doorways and interior walls keep their real shape.
 *   - Indirect BVHs leave the visible geometry's index buffers untouched, so
 *     collision preparation cannot disturb visual material/texture assignment.
 *
 * Collision strategy:
 *   - Gravity + downward floor ray → snap feet to surface
 *   - Upward ceiling ray          → block jumps through ceilings/floors above
 *   - Horizontal: predict new position, try X axis independently, then Z axis
 *     → gives smooth wall-sliding instead of stopping dead
 *
 * Movement feel (tactical FPS — Valorant / CS2 style):
 *   - Short, low jump arc (≈ 1 m apex) with fast gravity pull-down
 *   - Acceleration ramp-up + friction deceleration instead of instant top speed
 *   - Heavy air-control penalty: can barely steer once airborne
 *   - Crouch: hold CtrlLeft or KeyC — lower eye height, 55 % speed penalty
 *   - Landing impulse flag: read justLanded + landingSpeed to drive camera dip
 */

import * as THREE from "three";
import {
  SAH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";

// `Raycaster.firstHitOnly` is only understood after installing the BVH
// raycast implementation. On stock Three.js it is just an ignored property.
if (THREE.Mesh.prototype.raycast !== acceleratedRaycast) {
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────
const GRAVITY         = -22;   // m/s² — snappy without moon-physics float
const JUMP_VELOCITY   =  6.2;  // m/s → apex ≈ 0.88 m, feels tight & tactical
const PLAYER_RADIUS   =  0.45; // capsule radius for wall detection
const PLAYER_EYE_H    =  1.8;  // standing eye height above feet
const PLAYER_CROUCH_H =  1.15; // crouched eye height above feet
const CROUCH_LERP     =  14;   // eye-height lerp speed (per second)
const SKIN_WIDTH      =  0.06; // floor snap buffer
const FLOOR_RAY_LEN   =  PLAYER_EYE_H + SKIN_WIDTH + 0.45; // tall enough for crouch transitions
const CACHE_RADIUS    =  24;   // floor/gravity: meshes within this many world units
const WALL_CACHE_RADIUS=  12;  // extra distance around each mesh's world-space bounds
const CACHE_FRAMES    =   4;   // re-filter caches every N frames (halved → stays accurate at sprint)

const STEP_DOWN_HEIGHT = 0.35; // max height difference for snapping down (slope-following)
const MAX_STEP_HEIGHT  = 0.35; // max height player can automatically step over (curbs/stairs)

// ── Wall ray heights above feet ──────────────────────────────────────────────────
// Three rays span ankle → waist → shoulder so the player can’t duck under
// or over a thin wall segment. Heights are measured above feet (rig.position.y - eyeH).
const WALL_H_LOW  = 0.28;  // ankle — catches low barriers / step edges

// ── Ceiling detection constants ───────────────────────────────────────────────
// HEAD_ABOVE_EYE: how far the top of the head is above eye level (rig.position.y).
// The upward ray fires from rig.position.y and the hit threshold is HEAD_ABOVE_EYE
// plus a small skin buffer — if there's geometry that close above, we're about to
// clip through it.
const HEAD_ABOVE_EYE  =  0.14; // metres above eye = top of head
const CEIL_RAY_LEN    =  HEAD_ABOVE_EYE + SKIN_WIDTH + 0.08; // ~0.28 m — tight detection window

// ── Movement feel constants ───────────────────────────────────────────────────
//   ACCEL_GROUND: how fast horizontal speed ramps up on the ground (m/s per second)
//   FRICTION:     deceleration when no key is held (m/s per second bleed-off)
//   AIR_ACCEL:    fraction of ground accel available in the air (keep low for CS-feel)
//   AIR_FRICTION: minimal air friction — once you jump you carry most of your momentum
const ACCEL_GROUND  = 68;   // very snappy — reaches top speed in ~2-3 frames at 60 fps
const FRICTION      = 22;   // fast stop — responsive, not slidey
const AIR_ACCEL     =  9;   // only slight direction adjust mid-air
const AIR_FRICTION  =  1.5; // almost no slowdown once airborne
const CROUCH_SPEED  =  0.55; // speed multiplier while crouching
const SPRINT_SPEED  =  1.12; // forward-only tactical sprint multiplier
const AIM_SPEED     =  0.45; // ADS movement penalty, enforced on server too
const COLLIDER_WORK_CHUNK = 24;

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

const _DOWN   = new THREE.Vector3(0, -1, 0);
const _UP     = new THREE.Vector3(0,  1, 0); // used by ceiling ray

/** Make a raycaster with firstHitOnly enabled (massive perf win). */
function makeRay() {
  const r = new THREE.Raycaster();
  r.firstHitOnly = true; // stops after the first intersection — far faster for large scenes
  return r;
}

export class CharacterPhysics {
  constructor() {
    this._velocityY    = 0;
    this._isGrounded   = false;

    // Horizontal velocity tracked separately for smooth acceleration / friction
    this._velX = 0;
    this._velZ = 0;

    // Crouch state
    this._crouching    = false;
    this._sprinting    = false;
    this._aiming       = false;
    this._eyeH         = PLAYER_EYE_H; // smoothly interpolated eye height

    // Landing impulse — read from main.js to drive camera dip
    this._justLanded   = false;
    this._landingSpeed = 0; // speed at moment of landing (absolute value)

    // Full exact collider list, built once at map load.
    this._collidersInfo = []; // [{ mesh, cx, cy, cz, radius, proxyMesh }]
    this._ownsColliderData = true;

    // Exact collision meshes share geometry and its BVH with the visible map.
    // They use one double-sided material and are never added to the scene.
    this._proxyMeshes = [];
    this._bvhGeometries = new Set();

    // Distance-filtered mesh caches refreshed every CACHE_FRAMES frames.
    // Both lists contain exact BVH collision meshes. Separate radii keep the
    // floor query broad while horizontal wall queries stay local.
    this._nearbyMeshes  = [];
    this._wallMeshes    = [];
    this._cacheAge      = 9999; // force immediate refresh on first update

    this._downRay = makeRay();
    this._wallRay = makeRay();
    this._upRay   = makeRay();

    // ── Pre-allocated vectors — NEVER create new Vector3 inside update() ──
    this._wallOrigin = new THREE.Vector3();
    this._wallDir    = new THREE.Vector3();
    this._ceilOrigin = new THREE.Vector3();

    // ── Pre-allocated hit arrays — reused every frame to avoid GC churn ──
    this._floorHits = [];
    this._wallHits  = [];
    this._ceilHits  = [];
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Call once after the map root is added to the scene.
   *
   * All floor, ceiling, wall, and bullet queries use the exact static map
   * triangles through a BVH. This deliberately avoids one AABB per render
   * mesh: the downloaded map fuses most buildings into one mesh, so its AABB
   * covers the entire arena and cannot represent any interior wall.
   */
  async setColliders(mapRoot, onProgress) {
    this.disposeColliders();
    if (!mapRoot) return;
    this._ownsColliderData = true;

    const meshes = [];
    mapRoot.traverse((node) => {
      if (
        node.isMesh &&
        !node.isSkinnedMesh &&
        node.visible &&
        node.material &&
        node.geometry?.attributes?.position
      ) {
        meshes.push(node);
      }
    });

    // Double-sided collision prevents back-face holes while keeping the visible
    // map's original materials untouched. It must remain visible because
    // Mesh.raycast() skips meshes whose material is invisible.
    this._proxyMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

    const bsVec    = new THREE.Vector3();
    const scaleV   = new THREE.Vector3();

    for (let i = 0; i < meshes.length; i += COLLIDER_WORK_CHUNK) {
      const end = Math.min(meshes.length, i + COLLIDER_WORK_CHUNK);
      for (let j = i; j < end; j += 1) {
        const node = meshes[j];

        const geo = node.geometry;
        if (!geo || !geo.attributes.position) continue;

        node.updateWorldMatrix(true, false);

        // Build once per unique geometry. SAH takes slightly longer during the
        // loading screen but gives the fastest repeated gameplay raycasts.
        // `indirect` is essential here: direct BVH construction reorders the
        // geometry index in place. This map geometry is also rendered, so the
        // collision accelerator must never mutate its visual triangle order.
        if (!this._bvhGeometries.has(geo)) {
          if (geo.boundsTree) disposeBoundsTree.call(geo);
          computeBoundsTree.call(geo, {
            strategy: SAH,
            maxLeafTris: 12,
            setBoundingBox: true,
            indirect: true,
          });
          this._bvhGeometries.add(geo);
        }

        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const bs = geo.boundingSphere;
        if (!bs) continue;
        bsVec.copy(bs.center).applyMatrix4(node.matrixWorld);
        node.getWorldScale(scaleV);
        const wRadius = bs.radius * Math.max(scaleV.x, scaleV.y, scaleV.z);
        if (wRadius < 0.01) continue;

        // Copy the exact world transform. The mesh remains detached, so its
        // matrix will never be overwritten by scene graph updates.
        const proxyMesh = new THREE.Mesh(geo, this._proxyMaterial);
        proxyMesh.name = `COL_${node.name || j}`;
        proxyMesh.matrixAutoUpdate = false;
        proxyMesh.matrixWorldAutoUpdate = false;
        proxyMesh.matrixWorld.copy(node.matrixWorld);

        this._proxyMeshes.push(proxyMesh);
        this._collidersInfo.push({
          mesh: proxyMesh,
          cx: bsVec.x,
          cy: bsVec.y,
          cz: bsVec.z,
          radius: wRadius,
          proxyMesh,
        });
      }

      if (onProgress) {
        onProgress(95 + Math.round((end / Math.max(meshes.length, 1)) * 4), "Indexing solid map collision");
      }
      await yieldToBrowser();
    }

    this._cacheAge = 9999;
    console.info(
      `[Physics] ${this._collidersInfo.length} exact colliders ready — ` +
      `${this._bvhGeometries.size} BVH geometries indexed.`
    );
  }

  /** Dispose BVH data and clear all detached collider state. */
  disposeColliders() {
    if (this._ownsColliderData) {
      for (const geo of this._bvhGeometries) {
        if (geo.boundsTree) disposeBoundsTree.call(geo);
      }
      this._proxyMaterial?.dispose();
    }

    this._proxyMaterial = null;
    this._proxyMeshes = [];
    this._collidersInfo = [];
    this._bvhGeometries = new Set();
    this._nearbyMeshes.length  = 0;
    this._wallMeshes.length    = 0;
    this._ownsColliderData = true;
  }

  /** Alias so any existing call sites still work. */
  resetColliders() { this.disposeColliders(); }

  /**
   * Reuse an already-built immutable collider layer while keeping per-player
   * velocity, grounded state, and proximity caches independent.
   */
  useSharedColliders(source) {
    if (!(source instanceof CharacterPhysics) || source.colliderCount === 0) {
      throw new TypeError("CharacterPhysics.useSharedColliders requires a prepared source");
    }

    this.disposeColliders();
    this._ownsColliderData = false;
    this._proxyMaterial = source._proxyMaterial;
    this._proxyMeshes = source._proxyMeshes;
    this._collidersInfo = source._collidersInfo;
    this._bvhGeometries = source._bvhGeometries;
    this._cacheAge = 9999;
    return this;
  }

  /** Teleport the camera rig to eye-level position (x, y, z). */
  teleport(rig, x, y, z) {
    rig.position.set(x, y, z);
    this._velocityY  = 0;
    this._velX       = 0;
    this._velZ       = 0;
    this._isGrounded = false;
    this._crouching  = false;
    this._sprinting  = false;
    this._aiming     = false;
    this._eyeH       = PLAYER_EYE_H;
    this._cacheAge   = 9999; // force both caches to refresh on next update
  }

  /** Capture all movement state needed for snapshots and reconciliation. */
  captureState(rig) {
    return {
      x: rig.position.x,
      y: rig.position.y,
      z: rig.position.z,
      velocityX: this._velX,
      velocityY: this._velocityY,
      velocityZ: this._velZ,
      grounded: this._isGrounded,
      crouching: this._crouching,
      sprinting: this._sprinting,
      aiming: this._aiming,
      eyeHeight: this._eyeH,
    };
  }

  /** Restore an authoritative state before replaying unacknowledged inputs. */
  restoreState(rig, state) {
    const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
    rig.position.set(
      finite(state?.x, rig.position.x),
      finite(state?.y, rig.position.y),
      finite(state?.z, rig.position.z),
    );
    this._velX = finite(state?.velocityX);
    this._velocityY = finite(state?.velocityY);
    this._velZ = finite(state?.velocityZ);
    this._isGrounded = !!state?.grounded;
    this._crouching = !!state?.crouching;
    this._sprinting = !!state?.sprinting;
    this._aiming = !!state?.aiming;
    this._eyeH = THREE.MathUtils.clamp(
      finite(state?.eyeHeight, this._crouching ? PLAYER_CROUCH_H : PLAYER_EYE_H),
      PLAYER_CROUCH_H,
      PLAYER_EYE_H,
    );
    this._justLanded = false;
    this._landingSpeed = 0;
    this._cacheAge = 9999;
  }

  /**
   * Call every frame from the render loop.
   * @param {number}           dt      delta time (seconds, already capped)
   * @param {object}           keys    { KeyW, Space, ControlLeft, … } boolean map
   * @param {THREE.Object3D}   rig     camera rig (eye-level position)
   * @param {number}           speed   base horizontal top speed m/s
   * @param {number}           yaw     player yaw radians
   */
  update(dt, keys, rig, speed, yaw) {
    if (this._collidersInfo.length === 0) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.05);

    // ── 0. Refresh nearby mesh caches ─────────────────────────────────────
    this._cacheAge++;
    if (this._cacheAge >= CACHE_FRAMES) {
      this._refreshCache(rig.position);
      this._cacheAge = 0;
    }
    const nearby = this._nearbyMeshes;

    // ── 0b. Crouch ────────────────────────────────────────────────────────
    // ControlLeft or KeyC held = crouch. Crouch is blocked if there's a ceiling
    // (we don't ray-test up here, so we just allow toggling freely — simple & stable).
    const wantCrouch = !!(keys["ControlLeft"] || keys["KeyC"]);
    this._crouching  = wantCrouch;
    const targetEyeH = wantCrouch ? PLAYER_CROUCH_H : PLAYER_EYE_H;

    // Smoothly interpolate eye height — gives a visible crouch animation
    this._eyeH += (targetEyeH - this._eyeH) * Math.min(1, CROUCH_LERP * dt);

    // ── 1. Desired movement direction ─────────────────────────────────────
    let localX = 0, localZ = 0;
    if (keys["KeyW"]     || keys["ArrowUp"])    localZ -= 1;
    if (keys["KeyS"]     || keys["ArrowDown"])  localZ += 1;
    if (keys["KeyA"]     || keys["ArrowLeft"])  localX -= 1;
    if (keys["KeyD"]     || keys["ArrowRight"]) localX += 1;

    const moving = (localX !== 0 || localZ !== 0);
    const wantAim = !!keys.Aim;
    const wantSprint = !!keys.ShiftLeft && localZ < 0 && !wantCrouch && !wantAim;
    this._aiming = wantAim;
    this._sprinting = wantSprint;

    // These modifiers live in shared physics, so a client cannot skip the ADS
    // penalty or invent a faster sprint than the authoritative server uses.
    let effSpeed = Number.isFinite(speed) && speed > 0 ? speed : 0;
    if (wantCrouch) effSpeed *= CROUCH_SPEED;
    if (wantAim) effSpeed *= AIM_SPEED;
    if (wantSprint) effSpeed *= SPRINT_SPEED;

    // Rotate local intent by yaw → world-space wish direction (unit vector)
    let wishX = 0, wishZ = 0;
    if (moving) {
      const len = Math.sqrt(localX * localX + localZ * localZ);
      localX /= len;
      localZ /= len;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      wishX = ( localX * cosY + localZ * sinY);
      wishZ = (-localX * sinY + localZ * cosY);
    }

    // ── 2. Accelerate / decelerate horizontal velocity ────────────────────
    // Ground: full accel + strong friction.  Air: low accel + almost no friction.
    const accel   = this._isGrounded ? ACCEL_GROUND : AIR_ACCEL;
    const fric    = this._isGrounded ? FRICTION      : AIR_FRICTION;

    if (moving) {
      // Project wish-velocity onto current vel to avoid over-speeding diagonals
      const targetVX = wishX * effSpeed;
      const targetVZ = wishZ * effSpeed;
      const addX = (targetVX - this._velX) * Math.min(1, accel * dt);
      const addZ = (targetVZ - this._velZ) * Math.min(1, accel * dt);
      this._velX += addX;
      this._velZ += addZ;
    } else {
      // No input — apply friction to bleed off speed
      const speed2 = Math.sqrt(this._velX * this._velX + this._velZ * this._velZ);
      if (speed2 > 0.001) {
        const drop = Math.min(speed2, fric * dt);
        const scale = (speed2 - drop) / speed2;
        this._velX *= scale;
        this._velZ *= scale;
      } else {
        this._velX = 0;
        this._velZ = 0;
      }
    }

    // Clamp to effective top speed
    const curSpeed = Math.sqrt(this._velX * this._velX + this._velZ * this._velZ);
    if (curSpeed > effSpeed) {
      const s = effSpeed / curSpeed;
      this._velX *= s;
      this._velZ *= s;
    }

    const dx = this._velX * dt;
    const dz = this._velZ * dt;

    // ── 3. Jump ───────────────────────────────────────────────────────────
    // Must be grounded and not crouching to jump (realistic tactical rule)
    if (keys["Space"] && this._isGrounded && !wantCrouch) {
      this._velocityY  = JUMP_VELOCITY;
      this._isGrounded = false;
    }

    // ── 4. Gravity ────────────────────────────────────────────────────────
    if (!this._isGrounded) {
      this._velocityY += GRAVITY * dt;
    }

    // ── 5. Horizontal movement with pre-move swept CCD collision and Step-up ──
    const walls = this._wallMeshes;
    this._stepUpApplied = false;

    if (dx !== 0) {
      const hitDist = this._getWallHitDistance(rig, walls, dx, 0);
      let stepUpSuccess = false;

      if (hitDist !== null) {
        if (this._isGrounded) {
          const origY = rig.position.y;
          rig.position.y += MAX_STEP_HEIGHT;
          const raisedHit = this._getWallHitDistance(rig, walls, dx, 0);
          rig.position.y = origY;

          if (raisedHit === null) {
            rig.position.x += dx;
            rig.position.y += MAX_STEP_HEIGHT;
            stepUpSuccess = true;
            this._stepUpApplied = true;
          }
        }

        if (!stepUpSuccess) {
          const sign = Math.sign(dx);
          const allowed = Math.max(0, hitDist - PLAYER_RADIUS - 0.005);
          rig.position.x += sign * allowed;
          this._velX = 0;
        }
      } else {
        rig.position.x += dx;
      }
    }

    if (dz !== 0) {
      const hitDist = this._getWallHitDistance(rig, walls, 0, dz);
      let stepUpSuccess = false;

      if (hitDist !== null) {
        if (this._isGrounded) {
          const origY = rig.position.y;
          rig.position.y += MAX_STEP_HEIGHT;
          const raisedHit = this._getWallHitDistance(rig, walls, 0, dz);
          rig.position.y = origY;

          if (raisedHit === null) {
            rig.position.z += dz;
            rig.position.y += MAX_STEP_HEIGHT;
            stepUpSuccess = true;
            this._stepUpApplied = true;
          }
        }

        if (!stepUpSuccess) {
          const sign = Math.sign(dz);
          const allowed = Math.max(0, hitDist - PLAYER_RADIUS - 0.005);
          rig.position.z += sign * allowed;
          this._velZ = 0;
        }
      } else {
        rig.position.z += dz;
      }
    }

    // ── 6. Vertical step + floor/ceiling detection (prevent tunneling & support slopes) ──
    this._justLanded = false;
    const prevVelY  = this._velocityY;
    const dy = this._velocityY * dt;

    if (dy > 0) {
      // ── 6a. Ceiling detection (only while moving upward) ─────────────────
      this._ceilOrigin.set(rig.position.x, rig.position.y, rig.position.z);
      this._upRay.set(this._ceilOrigin, _UP);
      this._upRay.far  = CEIL_RAY_LEN + dy;
      this._upRay.near = 0;
      this._ceilHits.length = 0;
      this._upRay.intersectObjects(nearby, false, this._ceilHits);

      if (this._ceilHits.length > 0) {
        const ceilY = this._ceilHits[0].point.y;
        const headY = rig.position.y + HEAD_ABOVE_EYE;
        if (headY + dy >= ceilY - SKIN_WIDTH) {
          rig.position.y = ceilY - HEAD_ABOVE_EYE - SKIN_WIDTH;
          this._velocityY = 0;
        } else {
          rig.position.y += dy;
        }
      } else {
        rig.position.y += dy;
      }
    } else {
      // ── 6b. Downward floor detection & snapping ──────────────────────────
      this._downRay.set(rig.position, _DOWN);
      this._downRay.far  = FLOOR_RAY_LEN + Math.max(0, -dy);
      this._downRay.near = 0;
      this._floorHits.length = 0;
      this._downRay.intersectObjects(nearby, false, this._floorHits);

      const wasGrounded = this._isGrounded;
      this._isGrounded = false;

      let floorSnapped = false;
      if (this._floorHits.length > 0) {
        const floorY = this._floorHits[0].point.y;
        const feetY  = rig.position.y - this._eyeH;

        const isLanding = (feetY + dy <= floorY + SKIN_WIDTH);
        const isSlopeDown = wasGrounded && (feetY + dy <= floorY + STEP_DOWN_HEIGHT);
        const isStepUp = this._stepUpApplied && (feetY + dy <= floorY + MAX_STEP_HEIGHT);

        if (isLanding || isSlopeDown || isStepUp) {
          rig.position.y   = floorY + this._eyeH + SKIN_WIDTH;
          this._isGrounded = true;

          if (!wasGrounded && prevVelY < -2) {
            this._justLanded   = true;
            this._landingSpeed = Math.abs(prevVelY);
          }
          this._velocityY = 0;
          floorSnapped = true;
        }
      }

      if (!floorSnapped) {
        rig.position.y += dy;
      }
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Rebuild the nearby-mesh lists using pre-computed world bounding spheres.
   * Pure arithmetic — no matrix transforms at runtime.
   */
  _refreshCache(playerPos) {
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;
    this._nearbyMeshes.length = 0;
    this._wallMeshes.length   = 0;

    for (const info of this._collidersInfo) {
      const dx = info.cx - px;
      const dy = info.cy - py;
      const dz = info.cz - pz;
      const dist2 = dx * dx + dy * dy + dz * dz;

      // Floor + ceiling cache — exact BVH mesh, wide radius.
      const floorThreshold = CACHE_RADIUS + info.radius;
      if (dist2 <= floorThreshold * floorThreshold) {
        this._nearbyMeshes.push(info.mesh);
      }

      // Wall cache — the same exact BVH mesh with a tighter query radius.
      // Adding the mesh radius keeps the fused environment mesh included.
      if (info.proxyMesh) {
        const wallThreshold = WALL_CACHE_RADIUS + info.radius;
        if (dist2 <= wallThreshold * wallThreshold) {
          this._wallMeshes.push(info.proxyMesh);
        }
      }
    }
  }

  /**
   * Pre-move swept CCD wall check — the correct replacement for _wallBlocked.
   *
   * Fires THREE horizontal rays from the CURRENT (pre-move) position along
   * the direction of travel (dx, dz). Ray far-plane = |step| + PLAYER_RADIUS,
   * so the player's body is guaranteed to stop at skin distance from any
   * surface it would otherwise pass through.
   *
   * Why this fixes tunneling:
   *   Old: rig.position += step  →  ray fires from destination (wrong side).
   *   New: ray fires from origin →  hits wall before position ever changes.
   *
   * Performance: exact BVH meshes with firstHitOnly closest-hit queries.
   *
   * @param {THREE.Object3D} rig     - camera rig at current (pre-move) position
   * @param {THREE.Mesh[]}   nearby  - exact BVH wall collider cache
   * @param {number}         dx      - intended X displacement this frame
   * @param {number}         dz      - intended Z displacement this frame
   * @returns {boolean} true if the step would hit a wall (do NOT apply dx/dz)
   */
  /**
   * Pre-move swept CCD wall check.
   *
   * Fires three horizontal rays with dynamic heights scaled by the player's eye height.
   * Returns the minimum hit distance to a wall, or null if no wall is hit.
   *
   * @param {THREE.Object3D} rig     - camera rig at current position
   * @param {THREE.Mesh[]}   nearby  - exact BVH wall collider cache
   * @param {number}         dx      - intended X displacement
   * @param {number}         dz      - intended Z displacement
   * @returns {number|null} the minimum hit distance, or null if no hit
   */
  _getWallHitDistance(rig, nearby, dx, dz) {
    const stepLen = Math.sqrt(dx * dx + dz * dz);
    if (stepLen < 1e-6) return null;

    this._wallDir.set(dx / stepLen, 0, dz / stepLen);

    // Sweep distance: intended step length + player radius
    const sweepFar = stepLen + PLAYER_RADIUS;
    this._wallRay.far  = sweepFar;
    this._wallRay.near = 0.01;

    const feetY = rig.position.y - this._eyeH;
    
    // Dynamic ray heights scaled to match the standing vs. crouched capsule heights
    const hLow  = WALL_H_LOW;
    const hMid  = this._eyeH * 0.5;
    const hHigh = this._eyeH + HEAD_ABOVE_EYE - 0.08;

    let minDistance = Infinity;

    const heights = [hLow, hMid, hHigh];
    for (const h of heights) {
      this._wallOrigin.set(rig.position.x, feetY + h, rig.position.z);
      this._wallRay.set(this._wallOrigin, this._wallDir);
      this._wallHits.length = 0;
      this._wallRay.intersectObjects(nearby, false, this._wallHits);
      if (this._wallHits.length > 0) {
        const d = this._wallHits[0].distance;
        if (d < minDistance) {
          minDistance = d;
        }
      }
    }

    return minDistance !== Infinity ? minDistance : null;
  }

  // ─── Getters ──────────────────────────────────────────────────────────────────
  get isGrounded()    { return this._isGrounded; }
  get velocityY()     { return this._velocityY; }
  get velX()          { return this._velX; }
  get velZ()          { return this._velZ; }
  get crouching()     { return this._crouching; }
  get sprinting()     { return this._sprinting; }
  get aiming()        { return this._aiming; }
  get eyeH()          { return this._eyeH; }
  get justLanded()    { return this._justLanded; }
  get landingSpeed()  { return this._landingSpeed; }
  get proxyCount()    { return this._proxyMeshes.length; }
  get colliderCount() { return this._collidersInfo.length; }
  get raycastColliders() { return this._proxyMeshes; }
}
