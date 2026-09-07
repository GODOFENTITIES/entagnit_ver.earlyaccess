/**
 * weaponSystem.js – PotSpark FPS Weapon System
 *
 * Weapon categories & behaviour:
 *   pistol   (Breach) – Semi-auto, 240 RPM, crisp recoil
 *   assault  (ARC-7)  – Full-auto, 600 RPM, medium recoil, medium range
 *   smg      (Vesper) – Full-auto, 900 RPM, low recoil, close-range spread
 *   sniper   (Recon)  – Semi-auto, 40 RPM, heavy recoil, long range, ADS zoom
 *
 * Every weapon predicts audiovisual feedback locally. Ammo, reload cadence,
 * spread, ray hits, damage, health, death, and respawn are server-authoritative.
 */

import * as THREE from "three";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { MOVEMENT_SPEEDS, SIMULATION_HZ, WEAPON_RULES } from "./protocol.js";

const ARC_RULES = WEAPON_RULES["ARC-7"];
const VESPER_RULES = WEAPON_RULES.VESPER;
const RECON_RULES = WEAPON_RULES.RECON;
const BREACH_RULES = WEAPON_RULES.BREACH;

// ─── Weapon Definitions ───────────────────────────────────────────────────────
export const WEAPON_DEFS = {
  "BREACH": {
    id:         "BREACH",
    netId:      BREACH_RULES.weaponNetId,
    name:       "Breach",
    subtitle:   "Pistol · Server Verified",
    category:   "pistol",
    file:       null,
    rpm:        BREACH_RULES.rpm,
    damage:     BREACH_RULES.damage,
    magSize:    BREACH_RULES.magSize,
    reserveAmmo: BREACH_RULES.reserveAmmo,
    reloadTime: BREACH_RULES.reloadTicks / SIMULATION_HZ,
    recoilPitch:    0.030,
    recoilYaw:      0.008,
    recoilReturn:   8.5,
    spread:         BREACH_RULES.spread,
    auto:           BREACH_RULES.automatic,
    adsZoom:        false,
    range:          BREACH_RULES.range,
    serverAuthoritative: true,
    muzzleZ: -0.78,
    camPos:   new THREE.Vector3(0.31, -0.34, -0.52),
    camScale: 1,
    stats: { damage: 6, fireRate: 4, range: 5, mobility: 8 },
  },
  "ARC-7": {
    id:         "ARC-7",
    netId:      ARC_RULES.weaponNetId,
    name:       "ARC-7",
    subtitle:   "Assault Rifle · Server Verified",
    category:   "assault",
    file:       "./assets/models/ARC-7_Assault_Rifle.glb",
    rpm:        ARC_RULES.rpm,
    damage:     ARC_RULES.damage,
    magSize:    ARC_RULES.magSize,
    reserveAmmo: ARC_RULES.reserveAmmo,
    reloadTime: ARC_RULES.reloadTicks / SIMULATION_HZ,
    recoilPitch:    0.020,    // radians per shot (upward kick)
    recoilYaw:      0.006,    // random left/right per shot
    recoilReturn:   7.0,      // spring return strength
    spread:         ARC_RULES.spread,
    auto:           ARC_RULES.automatic,
    adsZoom:        false,
    range:          ARC_RULES.range,
    serverAuthoritative: true,
    // Camera-local transform  (right, down, forward-into-screen)
    camPos:   new THREE.Vector3(0.38, -0.38, -0.55),
    camScale: 0.5,
    stats: { damage: 6, fireRate: 7, range: 6, mobility: 6 },
  },
  "VESPER": {
    id:         "VESPER",
    netId:      VESPER_RULES.weaponNetId,
    name:       "Vesper",
    subtitle:   "SMG · Server Verified",
    category:   "smg",
    file:       "./assets/models/Vesper_SMG.glb",
    rpm:        VESPER_RULES.rpm,
    damage:     VESPER_RULES.damage,
    magSize:    VESPER_RULES.magSize,
    reserveAmmo: VESPER_RULES.reserveAmmo,
    reloadTime: VESPER_RULES.reloadTicks / SIMULATION_HZ,
    recoilPitch:    0.009,
    recoilYaw:      0.012,
    recoilReturn:   10.0,
    spread:         VESPER_RULES.spread,
    auto:           VESPER_RULES.automatic,
    adsZoom:        false,
    range:          VESPER_RULES.range,
    serverAuthoritative: true,
    camPos:   new THREE.Vector3(0.32, -0.34, -0.48),
    camScale: 0.5,
    stats: { damage: 4, fireRate: 9, range: 3, mobility: 9 },
  },
  "RECON": {
    id:         "RECON",
    netId:      RECON_RULES.weaponNetId,
    name:       "Recon",
    subtitle:   "Sniper Rifle · Server Verified",
    category:   "sniper",
    file:       "./assets/models/Recon_Sniper.glb",
    rpm:        RECON_RULES.rpm,
    damage:     RECON_RULES.damage,
    magSize:    RECON_RULES.magSize,
    reserveAmmo: RECON_RULES.reserveAmmo,
    reloadTime: RECON_RULES.reloadTicks / SIMULATION_HZ,
    recoilPitch:    0.075,
    recoilYaw:      0.010,
    recoilReturn:   4.5,
    spread:         RECON_RULES.spread,
    auto:           RECON_RULES.automatic,
    adsZoom:        true,
    normalFov:      70,
    adsFov:         22,       // 3× zoom feel
    range:          RECON_RULES.range,
    serverAuthoritative: true,
    camPos:   new THREE.Vector3(0.40, -0.36, -0.65),
    camScale: 0.5,
    stats: { damage: 10, fireRate: 2, range: 10, mobility: 4 },
  },
};

// Movement speed modifiers per weapon (m/s)
export const WEAPON_SPEEDS = MOVEMENT_SPEEDS;

// ─── WeaponSystem class ───────────────────────────────────────────────────────
export class WeaponSystem {
  constructor(camera, scene) {
    this._camera = camera;
    this._scene  = scene;
    this._loader = new GLTFLoader();

    this._def         = null;
    this._weaponRoot  = null;
    this._muzzleLight = null;
    this._muzzleTimer = 0;

    // Ammo / state
    this._ammo      = 0;
    this._reserveAmmo = 0;
    this._reloading = false;
    this._fireTimer = 0;      // time until next shot allowed (seconds)
    this._reloadTimer = 0;

    // Recoil offsets (spring back to 0)
    this._recoilPitch = 0;
    this._recoilYaw   = 0;

    // Weapon sway
    this._swayX = 0;
    this._swayY = 0;

    // Walking bob
    this._bobT = 0;

    // ADS
    this._isADS    = false;
    this._currentFov = 70;

    // Raycaster for bullets
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;

    // Pre-allocated vectors — avoids new Vector3() on every shot
    this._rayOrigin = new THREE.Vector3();
    this._rayDir    = new THREE.Vector3();
    // Pre-allocated hit array — avoids [] allocation on every raycast
    this._rayHits   = [];
    this._targetHits = [];

    // Reusable hit-spark mesh — geometry & material created once, reused per hit
    this._sparkMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0xff8844 }),
    );
    this._sparkMesh.visible = false; // hidden until a hit occurs

    this._colliders = [];
    this._targetProvider = null;
    this._shotReporter = null;
    this._reloadReporter = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setColliders(meshList) {
    this._colliders = meshList;
  }

  setTargetProvider(fn) {
    this._targetProvider = typeof fn === "function" ? fn : null;
  }

  setNetworkShotReporter(fn) {
    this._shotReporter = typeof fn === "function" ? fn : null;
  }

  setNetworkReloadReporter(fn) {
    this._reloadReporter = typeof fn === "function" ? fn : null;
  }

  /** Load a weapon GLB and attach it to the camera. Returns a Promise. */
  async equip(weaponId) {
    // Remove previous weapon
    if (this._weaponRoot) {
      this._camera.remove(this._weaponRoot);
      this._weaponRoot  = null;
      this._muzzleLight = null;
    }

    const def = WEAPON_DEFS[weaponId];
    if (!def) throw new Error(`WeaponSystem: unknown weapon "${weaponId}"`);

    this._def         = def;
    this._ammo        = def.magSize;
    this._reserveAmmo = def.reserveAmmo || 0;
    this._reloading   = false;
    this._fireTimer   = 0;
    this._recoilPitch = 0;
    this._recoilYaw   = 0;
    this._adsX        = 0;   // reset ADS slide offset on weapon swap
    this._swayX       = 0;
    this._swayY       = 0;
    this._bobT        = 0;
    this._currentFov  = def.adsZoom ? def.normalFov : 70;

    // Load GLB
    const root = def.file
      ? (await new Promise((resolve, reject) => {
          this._loader.load(def.file, resolve, undefined, reject);
        })).scene
      : this._createBreachPistol();
    root.scale.setScalar(def.camScale);
    root.position.copy(def.camPos);
    root.rotation.set(0, 0, 0);

    root.traverse((n) => {
      if (n.isMesh) {
        n.castShadow    = false;
        n.receiveShadow = false;
        // Viewmodel MUST render on top of the world — no z-fighting with floor/walls.
        // Standard FPS technique: disable depth testing for the weapon layer.
        n.renderOrder = 999;
        if (n.material) {
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          mats.forEach((m) => {
            m.depthTest  = false;  // always draw on top — never hidden by world
            m.depthWrite = false;  // don't pollute depth buffer
          });
        }
      }
    });

    // Muzzle flash PointLight (at barrel tip)
    this._muzzleLight = new THREE.PointLight(0xff9944, 0, 4, 2);
    this._muzzleLight.position.set(0, 0, def.muzzleZ ?? -1.2);
    root.add(this._muzzleLight);

    this._camera.add(root);
    this._weaponRoot = root;

    this._emitAmmo();
    this._emitWeaponName();
    console.info(`[Weapon] Equipped: ${def.name}`);
  }

  unequip() {
    if (this._weaponRoot) {
      this._camera.remove(this._weaponRoot);
      this._weaponRoot = null;
    }
    this._def = null;
  }

  /**
   * Call every render frame.
   * @param {number}  dt         delta time (s)
   * @param {number}  mouseDX    raw pixel delta X this frame
   * @param {number}  mouseDY    raw pixel delta Y this frame
   * @param {boolean} isMoving   player is walking
   * @param {boolean} isADS      right mouse held (aim down sights)
   */
  update(dt, mouseDX, mouseDY, isMoving, isADS) {
    if (!this._def || !this._weaponRoot) return;

    // ── Timers ──────────────────────────────────────────────────────────────
    if (this._fireTimer > 0)   this._fireTimer -= dt;
    if (this._muzzleTimer > 0) {
      this._muzzleTimer -= dt;
      if (this._muzzleTimer <= 0 && this._muzzleLight) {
        this._muzzleLight.intensity = 0;
      }
    }
    if (this._reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        const needed = Math.max(0, this._def.magSize - this._ammo);
        const loaded = this._def.serverAuthoritative
          ? Math.min(needed, this._reserveAmmo)
          : needed;
        this._ammo += loaded;
        if (this._def.serverAuthoritative) this._reserveAmmo -= loaded;
        this._reloading = false;
        this._emitAmmo();
      }
    }

    // ── Recoil spring (frame-rate-independent exponential decay) ────────────
    // Using exp(-rs*dt) instead of lerp(v, 0, rs*dt) gives perfectly consistent
    // behaviour at any frame rate — critical for sniper recovery vs. SMG recovery.
    const rs = this._def.recoilReturn;
    const decay = Math.exp(-rs * dt);
    this._recoilPitch *= decay;
    this._recoilYaw   *= decay;

    // ── Weapon sway (mouse drag) ────────────────────────────────────────────
    // Sway is a viewmodel-only effect — the weapon lags slightly behind sharp
    // camera turns, then springs back. Faster lerp (dt*16) keeps the weapon
    // responsive so it doesn't feel "floaty".
    const swayStr    = 0.00022;
    const targetSwayX = THREE.MathUtils.clamp(-mouseDX * swayStr, -0.038, 0.038);
    const targetSwayY = THREE.MathUtils.clamp(-mouseDY * swayStr, -0.028, 0.028);
    // Exp-decay lerp: consistent at any frame rate, snappier than before
    const swayDecay = 1 - Math.exp(-dt * 16);
    this._swayX += (targetSwayX - this._swayX) * swayDecay;
    this._swayY += (targetSwayY - this._swayY) * swayDecay;

    // ── Weapon bob (viewmodel only — camera bob is handled in main.js) ───────
    // Only the muzzle/grip gently shift. The world-sway camera bob is in main.js.
    // Keeping this separate lets us tune weapon vs. camera bob independently.
    let bobX = 0, bobY = 0;
    if (isMoving) {
      this._bobT += dt * 10.5; // same frequency as camera bob — perfectly in sync
      bobX =  Math.sin(this._bobT)           * 0.005;
      bobY = -Math.abs(Math.cos(this._bobT)) * 0.003;
    } else {
      // Exponential decay — frame-rate independent, snappy stop
      this._bobT *= Math.exp(-dt * 14);
      if (Math.abs(this._bobT) < 0.001) this._bobT = 0;
    }

    // ── Apply transform ─────────────────────────────────────────────────────
    const base = this._def.camPos;
    // ADS: slide weapon to centre smoothly (exp-decay, frame-rate independent).
    // _adsX persists between frames so the transition is always smooth.
    const adsXTarget = isADS ? -base.x * 0.88 : 0;
    if (this._adsX === undefined) this._adsX = 0;
    this._adsX += (adsXTarget - this._adsX) * (1 - Math.exp(-dt * 18));

    this._weaponRoot.position.set(
      base.x + this._swayX + bobX + this._adsX,
      base.y + this._swayY + bobY,
      base.z,
    );

    // ── ADS FOV ─────────────────────────────────────────────────────────────
    if (this._def.adsZoom) {
      const targetFov = isADS ? this._def.adsFov : this._def.normalFov;
      // Exp-decay: snappy, frame-rate independent ADS transition
      this._currentFov += (targetFov - this._currentFov) * (1 - Math.exp(-dt * 16));
    }

    this._isADS = isADS;
  }

  /**
   * Attempt to fire. Call every frame while mouse button is held (for auto),
   * or once per click (for semi). Returns the recoil pitch delta added.
   */
  tryFire(shotContext = null) {
    if (!this._def)        return 0;
    if (this._reloading)   return 0;
    if (this._fireTimer > 0) return 0;
    if (this._ammo <= 0)   { this.reload(); return 0; }
    if (this._def.serverAuthoritative && !Number.isInteger(shotContext?.shotSeq)) return 0;

    const interval = 60 / this._def.rpm; // seconds between shots
    this._fireTimer = interval;
    this._ammo--;
    this._emitAmmo();

    // Recoil kick
    this._recoilPitch += this._def.recoilPitch;
    this._recoilYaw   += (Math.random() - 0.5) * this._def.recoilYaw * 2;

    // Muzzle flash
    if (this._muzzleLight) {
      this._muzzleLight.intensity = 8;
      this._muzzleTimer = 0.055;
    }

    // Bullet raycast
    this._doRaycast(shotContext);

    return this._def.recoilPitch;
  }

  reload() {
    if (!this._def)                           return false;
    if (this._reloading)                      return false;
    if (this._ammo === this._def.magSize)     return false;
    if (this._def.serverAuthoritative && this._reserveAmmo <= 0) return false;

    this._reloading   = true;
    this._reloadTimer = this._def.reloadTime;
    this._emitAmmo();
    if (this._def.serverAuthoritative) this._reloadReporter?.();
    return true;
  }

  applyAuthoritativeCombatState(state) {
    if (!this._def?.serverAuthoritative || !state) return false;
    if (
      Number.isInteger(state.weaponNetId)
      && state.weaponNetId !== 0
      && state.weaponNetId !== this._def.netId
    ) return false;
    const ammo = Math.max(0, Math.min(this._def.magSize, Number(state.ammo) || 0));
    const reserveAmmo = Math.max(0, Number(state.reserveAmmo) || 0);
    const reloadRemainingTicks = Math.max(0, Number(state.reloadRemainingTicks) || 0);
    const reloading = state.reloading ?? reloadRemainingTicks > 0;
    const changed = ammo !== this._ammo
      || reserveAmmo !== this._reserveAmmo
      || reloading !== this._reloading;

    this._ammo = ammo;
    this._reserveAmmo = reserveAmmo;
    this._reloading = !!reloading;
    this._reloadTimer = this._reloading
      ? reloadRemainingTicks / SIMULATION_HZ
      : 0;
    if (changed) this._emitAmmo();
    return true;
  }

  // ── Getters ─────────────────────────────────────────────────────────────────
  get recoilPitch() { return this._recoilPitch; }
  get recoilYaw()   { return this._recoilYaw; }
  get currentFov()  { return this._currentFov; }
  get def()         { return this._def; }
  get ammo()        { return this._ammo; }
  get reserveAmmo() { return this._reserveAmmo; }
  get isReloading() { return this._reloading; }

  // ── Private ─────────────────────────────────────────────────────────────────

  _doRaycast(shotContext) {
    // Reuse pre-allocated vectors — zero GC per shot
    this._camera.getWorldPosition(this._rayOrigin);
    this._camera.getWorldDirection(this._rayDir);

    // Bullet spread
    const sp = this._def.spread;
    this._rayDir.x += (Math.random() - 0.5) * sp;
    this._rayDir.y += (Math.random() - 0.5) * sp;
    this._rayDir.normalize();

    this._ray.set(this._rayOrigin, this._rayDir);
    this._ray.far = this._def.range;

    // Reuse pre-allocated hit arrays
    this._rayHits.length = 0;
    this._targetHits.length = 0;
    if (Array.isArray(this._colliders)) {
      this._ray.intersectObjects(this._colliders, false, this._rayHits);
    } else if (this._colliders) {
      this._ray.intersectObject(this._colliders, true, this._rayHits);
    }

    const authoritative = !!this._def.serverAuthoritative;
    const targets = !authoritative && this._targetProvider ? this._targetProvider() : null;
    if (targets?.length) {
      this._ray.intersectObjects(targets, false, this._targetHits);
    }

    const worldHit = this._rayHits[0] || null;
    const targetHit = this._targetHits[0] || null;

    if (authoritative) {
      if (worldHit) {
        this._spawnHitSpark(worldHit.point);
        window.dispatchEvent(new CustomEvent("potspark:hit", {
          detail: { point: worldHit.point, damage: this._def.damage, predicted: true },
        }));
      }
      this._shotReporter?.({ ...shotContext });
      return;
    }

    if (targetHit && (!worldHit || targetHit.distance <= worldHit.distance + 0.01)) {
      const targetId = targetHit.object.userData.playerId;
      this._spawnHitSpark(targetHit.point);
      window.dispatchEvent(new CustomEvent("potspark:player-hit", {
        detail: {
          playerId: targetId,
          zone: targetHit.object.userData.zone,
          point: targetHit.point,
          damage: this._def.damage,
        },
      }));
      return;
    }

    if (worldHit) {
      this._spawnHitSpark(worldHit.point);
      window.dispatchEvent(new CustomEvent("potspark:hit", {
        detail: { point: worldHit.point, damage: this._def.damage },
      }));
    }
  }

  _spawnHitSpark(point) {
    // Reuse the same mesh — just reposition and briefly show it
    // Avoids allocating new SphereGeometry + MeshBasicMaterial on every hit.
    const mesh = this._sparkMesh;
    if (!mesh.parent) this._scene.add(mesh);
    mesh.position.copy(point);
    mesh.visible = true;
    clearTimeout(this._sparkTimer);
    this._sparkTimer = setTimeout(() => { mesh.visible = false; }, 180);
  }

  _createBreachPistol() {
    const root = new THREE.Group();
    root.name = "Breach_Pistol_Viewmodel";

    const dark = new THREE.MeshStandardMaterial({
      color: 0x171a20,
      roughness: 0.34,
      metalness: 0.72,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: 0x696f78,
      roughness: 0.27,
      metalness: 0.88,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: 0xff4655,
      roughness: 0.4,
      metalness: 0.55,
    });

    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.15, 0.62), steel);
    slide.position.set(0, 0.02, -0.25);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.48), dark);
    frame.position.set(0, -0.08, -0.18);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.38, 0.2), dark);
    grip.position.set(0, -0.29, -0.02);
    grip.rotation.x = -0.16;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 10), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -0.65);
    const accentRail = new THREE.Mesh(new THREE.BoxGeometry(0.205, 0.035, 0.24), accent);
    accentRail.position.set(0, 0.105, -0.2);
    const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.055, 0.035), dark);
    rearSight.position.set(0, 0.13, 0.015);
    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.045, 0.035), dark);
    frontSight.position.set(0, 0.13, -0.52);

    root.add(slide, frame, grip, barrel, accentRail, rearSight, frontSight);
    return root;
  }

  _emitAmmo() {
    window.dispatchEvent(new CustomEvent("potspark:ammo", {
      detail: {
        ammo:        this._ammo,
        max:         this._def ? this._def.magSize : 0,
        reserve:     this._reserveAmmo,
        reloading:   this._reloading,
        reloadTime:  this._def ? this._def.reloadTime : 0,
      },
    }));
  }

  _emitWeaponName() {
    if (!this._def) return;
    window.dispatchEvent(new CustomEvent("potspark:weapon-name", {
      detail: { name: this._def.name, subtitle: this._def.subtitle },
    }));
  }
}
