/**
 * main.js – PotSpark FPS — Game Loop, Loadout Flow, Weapon System
 *
 * State machine:
 *   "lobby"   → lobby camera + UI visible
 *   "loading" → map streaming (loading overlay)
 *   "loadout" → map loaded, loadout selection screen
 *   "playing" → full FPS: pointer lock, physics, weapons
 */

import * as THREE from "three";
import { createSceneSetup }              from "./sceneSetup.js";
import { loadMap }                       from "./mapLoader.js";
import { optimizeStaticMapRendering }    from "./mapRenderOptimizer.js";
import { CharacterPhysics }              from "./physics.js";
import { WeaponSystem, WEAPON_DEFS, WEAPON_SPEEDS } from "./weaponSystem.js";
import {
  COMBAT_FLAGS,
  HIT_ZONE,
  connect as netConnect,
  disconnect as netDisconnect,
  MSG,
  onMessage,
  parseHitFrame,
  parseStateFrame,
  sendEnterGame,
  sendInputCommand,
  sendReload,
  sendShot,
  getPlayerId,
  SHOT_STATUS,
} from "./network.js";
import {
  SIMULATION_DT,
  SIMULATION_HZ,
  buildInputMask,
  inputMaskToKeys,
} from "./protocol.js";
import { GhostManager } from "./ghosts.js";
import { animate as animeAnimate, svg, utils, stagger, splitText, scrambleText } from "animejs";

// ─── Network — Server-authoritative movement + all-weapon combat ─────────────
const net          = netConnect();
const ghostManager = new GhostManager(null); // scene injected after setup below

// STATE handler: unpack snapshot → move / create / remove ghost capsules
onMessage(MSG.STATE, (view, buf) => {
  const state = parseStateFrame(view, buf);
  if (state) handleNetworkState(state);
});
onMessage(MSG.HIT, (view, buf) => {
  const result = parseHitFrame(view, buf);
  if (result) handleShotResult(result);
});

// ─── Renderer & Scene ────────────────────────────────────────────────────────
const canvas = document.querySelector("#game-canvas");
const game   = createSceneSetup({ canvas });
const clock  = new THREE.Clock();
const hudCoordinates = {
  root: document.getElementById("hud-coordinates"),
  x: document.getElementById("coord-x"),
  y: document.getElementById("coord-y"),
  z: document.getElementById("coord-z"),
};
const hudCrouchIndicator = document.getElementById("hud-crouch-indicator");

// Inject scene into ghost manager now that it exists
ghostManager._scene = game.scene;

// ─── Game state ──────────────────────────────────────────────────────────────
let gameState  = "lobby";
let mapRoot    = null;
let mapMeshes  = [];     // flat mesh list shared by physics & weapon raycasts
let showCoords = false;
let movementSeq = 1;
let shotSeq = 1;
let reloadSeq = 1;
let latestSnapshotTick = 0;
let localHealth = 100;
let localLifeId = 0;
let localDead = false;
let _lastCoordinatePaint = 0;
let _lastCrouchState = null;

const pendingInputs = [];
const replayKeys = {};
const MAX_PENDING_INPUTS = 240;
const MAX_SIMULATION_STEPS_PER_FRAME = 5;
let movementAccumulator = 0;
const SERVER_CORRECTION_THRESHOLD = 0.85;
const SERVER_SMOOTH_THRESHOLD = 0.015;

// ─── FPS Camera rig ──────────────────────────────────────────────────────────
const PLAYER_HEIGHT = 1.8;
const LOOK_SPEED    = 0.002;  // raw 1:1 — no artificial smoothing (pro-feel)
const DEFAULT_SPEED = 7.5;

const player = { yaw: 0, pitch: 0 };

// ── View bob (CS2-style) ──────────────────────────────────────────────────────
// A small sinusoidal pitch + roll applied to the camera while walking.
// Keeps the weapon steady (bob is in camera space) so only the world sways.
let viewBobT    = 0;   // bob phase accumulator
let viewBobPitch = 0;  // current smoothed bob pitch offset (radians)
let viewBobRoll  = 0;  // current smoothed bob roll  offset (radians)

// ── Strafe tilt ────────────────────────────────────────────────────────────
// Lean the camera slightly left/right based on horizontal velocity (like Valorant).
let strafeTilt     = 0;  // current roll (radians)
let strafeTiltVel  = 0;  // spring velocity for strafe tilt

// ── Landing camera dip ────────────────────────────────────────────────────
// Snappy downward pitch spring on landing — gives tactile "thud" feedback.
let landingDip     = 0;
let landingDipVel  = 0;

const cameraRig = new THREE.Object3D();
game.scene.add(cameraRig);
cameraRig.add(game.camera);
game.camera.position.set(0, 0, 0);

// Physics always stays at the corrected predicted state. This small camera-only
// offset decays after reconciliation so ordinary network corrections are not
// visible as hard snaps.
const cameraCorrection = new THREE.Vector3();
const correctionWorld = new THREE.Vector3();
const correctionQuaternion = new THREE.Quaternion();
const preReconcilePosition = new THREE.Vector3();

// ─── Physics ─────────────────────────────────────────────────────────────────
const physics = new CharacterPhysics();

// ─── Weapon System ───────────────────────────────────────────────────────────
const weaponSystem = new WeaponSystem(game.camera, game.scene);
weaponSystem.setTargetProvider(() => ghostManager.getHitboxes());
weaponSystem.setNetworkShotReporter((request) => sendShot(request));
weaponSystem.setNetworkReloadReporter(() => sendReload(reloadSeq++));

// ─── Input state ─────────────────────────────────────────────────────────────
const keys         = {};
const mouseBtn     = { 0: false, 2: false }; // LMB, RMB
const prevMouseBtn = { 0: false, 2: false };
let mouseDX = 0, mouseDY = 0;
// Recoil delta tracking
let prevRecoilPitch = 0, prevRecoilYaw = 0;

// ─── Selected loadout weapon ─────────────────────────────────────────────────
let selectedWeaponId = null;

function resetLiveInput() {
  Object.keys(keys).forEach((code) => { keys[code] = false; });
  mouseBtn[0] = false;
  mouseBtn[2] = false;
  prevMouseBtn[0] = false;
  prevMouseBtn[2] = false;
  mouseDX = 0;
  mouseDY = 0;
}

function requestGamePointerLock() {
  if (gameState === "playing" && document.pointerLockElement !== canvas) {
    const lockRequest = canvas.requestPointerLock();
    lockRequest?.catch?.(() => syncPointerLockUI());
  }
}

function syncPointerLockUI() {
  const locked = document.pointerLockElement === canvas;
  const isPlaying = gameState === "playing";
  const hud = document.getElementById("hud-overlay");
  const unlockedPanel = document.getElementById("hud-unlocked-panel");

  document.body.classList.toggle("is-pointer-locked", isPlaying && locked);
  document.body.classList.toggle("is-pointer-unlocked", isPlaying && !locked);

  if (hud) {
    hud.style.opacity = isPlaying ? "1" : "0";
    hud.setAttribute("aria-hidden", String(!isPlaying));
    hud.classList.toggle("is-pointer-locked", isPlaying && locked);
    hud.classList.toggle("is-pointer-unlocked", isPlaying && !locked);
  }

  if (unlockedPanel) {
    unlockedPanel.setAttribute("aria-hidden", String(!isPlaying || locked));
  }

  if (isPlaying && !locked) {
    resetLiveInput();
  }
}

// ─── Key listeners ───────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  keys[e.code] = true;

  // Block browser shortcuts while playing (Ctrl+W closes tab, etc.)
  if (gameState === "playing" && e.ctrlKey) e.preventDefault();

  if (e.code === "KeyK" && gameState === "playing") {
    showCoords = !showCoords;
    hudCoordinates.root?.toggleAttribute("hidden", !showCoords);
  }
  if (e.code === "KeyR" && gameState === "playing" && !localDead) {
    weaponSystem.reload();
  }
});
document.addEventListener("keyup", (e) => { keys[e.code] = false; });

// Mouse move — look + weapon sway accumulation
document.addEventListener("mousemove", (e) => {
  if (gameState !== "playing" || document.pointerLockElement !== canvas) return;
  player.yaw   -= e.movementX * LOOK_SPEED;
  player.pitch -= e.movementY * LOOK_SPEED;
  player.pitch  = THREE.MathUtils.clamp(player.pitch, -Math.PI / 2.2, Math.PI / 2.2);
  mouseDX += e.movementX;
  mouseDY += e.movementY;
});

// Mouse buttons — track LMB (fire) and RMB (ADS)
document.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement === canvas) mouseBtn[e.button] = true;
});
document.addEventListener("mouseup", (e) => { mouseBtn[e.button] = false; });

// ─── Custom Context Menu (replaces browser default RMB dialog) ───────────────
const _ctxMenu = document.getElementById("customContextMenu");

function showCustomContextMenu(x, y) {
  if (!_ctxMenu) return;
  // Ensure menu is unhidden before calculating dimensions so layout measurements are accurate
  _ctxMenu.hidden = false;
  const menuW = _ctxMenu.offsetWidth || 242;
  const menuH = _ctxMenu.offsetHeight || 196;
  const clampedX = Math.max(8, Math.min(x, window.innerWidth  - menuW - 8));
  const clampedY = Math.max(8, Math.min(y, window.innerHeight - menuH - 8));
  _ctxMenu.style.left = `${clampedX}px`;
  _ctxMenu.style.top  = `${clampedY}px`;
  requestAnimationFrame(() => _ctxMenu.classList.add("is-open"));
}

function hideCustomContextMenu() {
  if (!_ctxMenu || _ctxMenu.hidden) return;
  _ctxMenu.classList.remove("is-open");
  const onEnd = () => {
    if (!_ctxMenu.classList.contains("is-open")) _ctxMenu.hidden = true;
    _ctxMenu.removeEventListener("transitionend", onEnd);
  };
  _ctxMenu.addEventListener("transitionend", onEnd);
  // Safety timeout in case transitionend is canceled
  setTimeout(onEnd, 200);
}

// Block the native context menu everywhere and show our own instead
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // Only show our custom menu when NOT in pointer-locked gameplay
  if (document.pointerLockElement === canvas) return;
  showCustomContextMenu(e.clientX, e.clientY);
});

// Dismiss on any click outside
document.addEventListener("click", (e) => {
  if (_ctxMenu && !_ctxMenu.hidden && !_ctxMenu.contains(e.target)) {
    hideCustomContextMenu();
  }
});

// Dismiss on Escape key
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _ctxMenu && !_ctxMenu.hidden) {
    hideCustomContextMenu();
  }
});

// Dismiss on resize or scroll to keep layout crisp
window.addEventListener("resize", hideCustomContextMenu, { passive: true });
window.addEventListener("scroll", hideCustomContextMenu, { passive: true });

// Handle context menu item actions
_ctxMenu?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ctx]");
  if (!btn) return;
  hideCustomContextMenu();
  const action = btn.dataset.ctx;
  if (action === "coords" && gameState === "playing") {
    showCoords = !showCoords;
    hudCoordinates.root?.toggleAttribute("hidden", !showCoords);
  }
  // Other actions are informational (ADS, Reload, Crouch are in-game keys)
});

// Prevent context menu on RMB in canvas (already covered above, kept for safety)
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Pointer lock — request on canvas click during play
canvas.addEventListener("click", () => {
  requestGamePointerLock();
});

// ─── Pause menu buttons ───────────────────────────────────────────────────────
document.getElementById("hud-resume-button")?.addEventListener("click", requestGamePointerLock);

// Clicking the dark overlay outside the panel also resumes
document.getElementById("hud-unlocked-panel")?.addEventListener("click", (e) => {
  // Only resume if click was directly on the overlay backdrop (not on the panel)
  if (!e.target.closest(".hud-pause-panel")) requestGamePointerLock();
});

// Settings button — opens the existing settings modal via the UI system
document.getElementById("pause-settings-btn")?.addEventListener("click", () => {
  // Dispatch to the existing settings panel mechanism in ui.js
  const settingsBtn = document.querySelector("[data-panel='settings']");
  settingsBtn?.click();
});

// Quit to Lobby — cleanly disconnect then reload the page to return to lobby state
document.getElementById("pause-quit-btn")?.addEventListener("click", () => {
  netDisconnect(); // release seat on server; suppress auto-reconnect
  window.location.reload();
});

// HUD opacity based on lock state
document.addEventListener("pointerlockchange", syncPointerLockUI);
document.addEventListener("pointerlockerror", syncPointerLockUI);

// ─── Camera helpers ───────────────────────────────────────────────────────────
function placeLobbyCamera() {
  cameraRig.position.set(0, 6, 18);
  player.yaw   =  0;
  player.pitch = -0.12;
}

function placeInGameCamera(spawnPoint) {
  physics.teleport(cameraRig, spawnPoint.x, spawnPoint.y, spawnPoint.z);
  pendingInputs.length = 0;
  movementAccumulator = 0;
  cameraCorrection.set(0, 0, 0);
  player.yaw      = 0;
  player.pitch    = 0;
  prevRecoilPitch = 0;
  prevRecoilYaw   = 0;
  landingDip      = 0;
  landingDipVel   = 0;
  viewBobT        = 0;
  viewBobPitch    = 0;
  viewBobRoll     = 0;
  strafeTilt      = 0;
  strafeTiltVel   = 0;
}

function updateCamera() {
  cameraRig.rotation.y = player.yaw;
  game.camera.position.copy(cameraCorrection);

  // pitch: look + recoil kick + landing dip + walk bob
  game.camera.rotation.x = THREE.MathUtils.clamp(
    player.pitch + landingDip + viewBobPitch,
    -Math.PI / 2.2,
    Math.PI / 2.2,
  );

  // roll: strafe tilt + walk bob roll (CS2-style lean)
  game.camera.rotation.z = strafeTilt + viewBobRoll;
}

// ─── Loading Corner Widget Animations (Anime.js) ────────────────────
function handleNetworkState(state) {
  latestSnapshotTick = state.tick;
  const localId = getPlayerId();
  if (localId != null) {
    const selfState = state.players.find((p) => p.id === localId);
    if (selfState) {
      updateLocalCombatState(selfState, state.combat);
      reconcileLocalPlayer(selfState, state.lastAckedSeq);
    }
  }
  ghostManager.updateFromState(state, localId);
}

function updateLocalCombatState(selfState, combatState) {
  const lifeChanged = localLifeId !== 0 && selfState.lifeId !== localLifeId;
  const tookDamage = !lifeChanged && localLifeId !== 0 && selfState.health < localHealth;
  const wasDead = localDead;

  localLifeId = selfState.lifeId;
  localHealth = selfState.health;
  localDead = selfState.health <= 0;

  if (tookDamage) flashDamage();
  if (localDead && !wasDead) {
    resetLiveInput();
    pendingInputs.length = 0;
    cameraCorrection.set(0, 0, 0);
  }

  if (lifeChanged && !localDead) {
    pendingInputs.length = 0;
    cameraCorrection.set(0, 0, 0);
  }

  const healthValue = document.getElementById("hud-health-value");
  const healthFill = document.getElementById("hud-health-fill");
  if (healthValue) healthValue.textContent = String(selfState.health);
  if (healthFill) {
    healthFill.style.width = `${Math.max(0, Math.min(100, selfState.health))}%`;
    healthFill.classList.toggle("is-critical", selfState.health <= 30);
  }

  // Sync vitals to pause menu
  const pauseHealthEl = document.getElementById("pause-health-val");
  const pauseHealthBar = document.getElementById("pause-health-bar");
  if (pauseHealthEl) pauseHealthEl.textContent = String(selfState.health);
  if (pauseHealthBar) {
    pauseHealthBar.style.width = `${Math.max(0, Math.min(100, selfState.health))}%`;
    pauseHealthBar.classList.toggle("is-critical", selfState.health <= 30);
  }

  const deathOverlay = document.getElementById("hud-death-overlay");
  const deathTimer = document.getElementById("hud-respawn-timer");
  if (deathOverlay) deathOverlay.hidden = !localDead;
  if (deathTimer && localDead) {
    deathTimer.textContent = `RESPAWNING IN ${(combatState.respawnRemainingTicks / SIMULATION_HZ).toFixed(1)}s`;
  }

  const protection = document.getElementById("hud-spawn-protection");
  if (protection) {
    protection.hidden = !(combatState.flags & COMBAT_FLAGS.SPAWN_PROTECTED) || localDead;
  }

  if (combatState.flags & COMBAT_FLAGS.AUTHORITATIVE_WEAPON) {
    weaponSystem.applyAuthoritativeCombatState({
      ...combatState,
      reloading: !!(combatState.flags & COMBAT_FLAGS.RELOADING),
    });
  }
}

function handleShotResult(result) {
  const accepted = weaponSystem.applyAuthoritativeCombatState({
    ammo: result.ammo,
    reserveAmmo: result.reserveAmmo,
    reloadRemainingTicks: result.reloadRemainingTicks,
    reloading: result.reloadRemainingTicks > 0,
    weaponNetId: result.weaponNetId,
  });
  if (!accepted) return;

  if (
    result.status === SHOT_STATUS.HIT
    || result.status === SHOT_STATUS.KILL
  ) {
    showConfirmedHitmarker(result.status === SHOT_STATUS.KILL, result.zone);
  } else if (result.status === SHOT_STATUS.REJECTED_PROTECTED) {
    showProtectedMarker();
  }
}

let hitmarkerTimer = 0;
let damageTimer = 0;

function showConfirmedHitmarker(killed, zone) {
  const marker = document.getElementById("hud-hitmarker");
  if (!marker) return;
  marker.hidden = false;
  marker.classList.toggle("is-kill", killed);
  marker.classList.toggle("is-headshot", zone === HIT_ZONE.HEAD);
  marker.classList.remove("is-visible");
  requestAnimationFrame(() => marker.classList.add("is-visible"));
  window.clearTimeout(hitmarkerTimer);
  hitmarkerTimer = window.setTimeout(() => {
    marker.classList.remove("is-visible", "is-kill", "is-headshot");
    marker.hidden = true;
  }, killed ? 260 : 180);
}

function showProtectedMarker() {
  const marker = document.getElementById("hud-protected-hit");
  if (!marker) return;
  marker.hidden = false;
  marker.classList.remove("is-visible");
  requestAnimationFrame(() => marker.classList.add("is-visible"));
  window.setTimeout(() => {
    marker.classList.remove("is-visible");
    marker.hidden = true;
  }, 380);
}

function flashDamage() {
  const flash = document.getElementById("hud-damage-flash");
  if (!flash) return;
  flash.classList.remove("is-visible");
  requestAnimationFrame(() => flash.classList.add("is-visible"));
  window.clearTimeout(damageTimer);
  damageTimer = window.setTimeout(() => flash.classList.remove("is-visible"), 190);
}

function buildInputCommand(isADS) {
  return {
    seq: movementSeq++,
    mask: buildInputMask({
      forward: !!(keys["KeyW"] || keys["ArrowUp"]),
      backward: !!(keys["KeyS"] || keys["ArrowDown"]),
      left: !!(keys["KeyA"] || keys["ArrowLeft"]),
      right: !!(keys["KeyD"] || keys["ArrowRight"]),
      jump: !!keys["Space"],
      crouch: !!(keys["ControlLeft"] || keys["KeyC"]),
      sprint: !!keys["ShiftLeft"],
      aim: !!isADS,
    }),
    yaw: player.yaw,
    pitch: player.pitch,
  };
}

function applyPredictedInput(command) {
  inputMaskToKeys(command.mask, replayKeys);
  const baseSpeed = WEAPON_SPEEDS[weaponSystem.def?.id] ?? DEFAULT_SPEED;
  physics.update(
    SIMULATION_DT,
    replayKeys,
    cameraRig,
    baseSpeed,
    command.yaw,
  );
}

function simulateAndSendMovement(frameDt, isADS) {
  movementAccumulator = Math.min(
    movementAccumulator + frameDt,
    SIMULATION_DT * MAX_SIMULATION_STEPS_PER_FRAME,
  );

  let steps = 0;
  while (
    movementAccumulator >= SIMULATION_DT
    && steps < MAX_SIMULATION_STEPS_PER_FRAME
  ) {
    const command = buildInputCommand(isADS);
    applyPredictedInput(command);
    pendingInputs.push(command);
    if (pendingInputs.length > MAX_PENDING_INPUTS) pendingInputs.shift();
    sendInputCommand(command);
    movementAccumulator -= SIMULATION_DT;
    steps += 1;
  }
}

function createShotInputAnchor(isADS) {
  const command = buildInputCommand(isADS);
  applyPredictedInput(command);
  pendingInputs.push(command);
  if (pendingInputs.length > MAX_PENDING_INPUTS) pendingInputs.shift();
  sendInputCommand(command);

  // This command predicts the next fixed step slightly early. Keeping the
  // accumulator negative until real time catches up avoids granting an extra
  // local movement step while ensuring the server receives aim before SHOT.
  movementAccumulator -= SIMULATION_DT;
  return command;
}

function reconcileLocalPlayer(serverState, lastAckedSeq) {
  while (pendingInputs.length > 0 && pendingInputs[0].seq <= lastAckedSeq) {
    pendingInputs.shift();
  }

  if (gameState !== "playing") return;

  if (localDead) {
    pendingInputs.length = 0;
    physics.restoreState(cameraRig, serverState);
    cameraCorrection.set(0, 0, 0);
    return;
  }

  preReconcilePosition.copy(cameraRig.position);
  physics.restoreState(cameraRig, serverState);
  for (const command of pendingInputs) applyPredictedInput(command);

  correctionWorld.subVectors(preReconcilePosition, cameraRig.position);
  const error = correctionWorld.length();
  if (error > SERVER_CORRECTION_THRESHOLD) {
    cameraCorrection.set(0, 0, 0);
  } else if (error > SERVER_SMOOTH_THRESHOLD) {
    cameraRig.getWorldQuaternion(correctionQuaternion).invert();
    correctionWorld.applyQuaternion(correctionQuaternion);
    cameraCorrection.add(correctionWorld);
    if (cameraCorrection.lengthSq() > SERVER_CORRECTION_THRESHOLD ** 2) {
      cameraCorrection.setLength(SERVER_CORRECTION_THRESHOLD);
    }
  }
}

window.addEventListener("potspark:net-welcome", () => {
  // A reconnect creates a fresh authoritative player, so old sequence numbers
  // and prediction history must never leak into the new session.
  movementSeq = 1;
  shotSeq = 1;
  reloadSeq = 1;
  latestSnapshotTick = 0;
  localLifeId = 0;
  localHealth = 100;
  localDead = false;
  movementAccumulator = 0;
  pendingInputs.length = 0;
  cameraCorrection.set(0, 0, 0);
});

let isMorphingActive = false;
let morphLoopId = 0;
let loadingTextAnimation = null;
let loadingScrambleAnimation = null;
let loadingScrambleTimer = 0;
let loadingStatusMessageIndex = 0;
let loadingOverlayActive = false;

const MIN_LOADING_SCREEN_MS = 900;
const LOADING_STATUS_MESSAGES = [
  "SYNCING SPARK CORE",
  "STREAMING REDLINE YARD",
  "CALIBRATING SPAWN GRID",
  "PRIMING LOADOUT SYSTEMS",
  "FINALIZING COLLISION GRID",
];

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// #MorphTo — generates random polygon points for the corner widget SVG (viewBox 120×120)
function generatePoints() {
  const total = utils.random(4, 64);
  const r1 = utils.random(4, 52);
  const r2 = 52;
  const isOdd = n => n % 2;
  let points = '';
  for (let i = 0, l = isOdd(total) ? total + 1 : total; i < l; i++) {
    const r = isOdd(i) ? r1 : r2;
    const a = (2 * Math.PI * i / l) - Math.PI / 2;
    const x = 60 + utils.round(r * Math.cos(a), 0);
    const y = 60 + utils.round(r * Math.sin(a), 0);
    points += `${x},${y} `;
  }
  return points;
}

function seedCornerMorphPoints() {
  const $path1 = document.getElementById('morph-source');
  const $path2 = document.getElementById('morph-target');
  if (!$path1 || !$path2) return;

  utils.set($path1, { points: generatePoints() });
  utils.set($path2, { points: generatePoints() });
}

// #MorphTo — morph the polygon in the corner widget
function animateRandomPoints(loopId = morphLoopId) {
  if (!isMorphingActive || loopId !== morphLoopId) return;
  const $path1 = document.getElementById('morph-source');
  const $path2 = document.getElementById('morph-target');
  if (!$path1 || !$path2) return;

  if (!$path1.getAttribute('points')?.trim()) {
    seedCornerMorphPoints();
  }

  utils.set($path2, { points: generatePoints() });
  animeAnimate($path1, {
    points: svg.morphTo($path2),
    ease: 'inOutCirc',
    duration: 500,
    onComplete: () => animateRandomPoints(loopId)
  });
}

function stopLoadingScramble() {
  window.clearTimeout(loadingScrambleTimer);
  loadingScrambleTimer = 0;
  loadingScrambleAnimation?.pause?.();
  loadingScrambleAnimation?.cancel?.();
  loadingScrambleAnimation = null;
}

function startLoadingScramble() {
  const statusEl = document.getElementById("load-status-text");
  if (!statusEl) return;

  stopLoadingScramble();
  loadingStatusMessageIndex = 0;

  const runScramble = () => {
    if (!loadingOverlayActive) return;

    const message = LOADING_STATUS_MESSAGES[
      loadingStatusMessageIndex % LOADING_STATUS_MESSAGES.length
    ];
    loadingStatusMessageIndex += 1;

    // #Scramble from animejsexamples.txt, cycled through arena-flavored text.
    loadingScrambleAnimation = animeAnimate(statusEl, {
      innerHTML: scrambleText({
        text: message,
        chars: "uppercase",
        cursor: "_",
        revealRate: 72,
        settleDuration: 420,
      }),
      ease: "linear",
      onComplete: () => {
        if (!loadingOverlayActive) return;
        loadingScrambleTimer = window.setTimeout(runScramble, 180);
      },
    });
  };

  runScramble();
}

// #Animation — splitText char bounce on the corner widget map name
function setupLoadingTextAnimation() {
  const h2El = document.getElementById('corner-map-name');
  if (!h2El) return;

  const { chars } = splitText(h2El, { words: false, chars: true });
  loadingTextAnimation = animeAnimate(chars, {
    // Property keyframes — from animejsexamples.txt #animation
    y: [
      { to: '-2.75rem', ease: 'outExpo', duration: 600 },
      { to: 0, ease: 'outBounce', duration: 800, delay: 100 }
    ],
    // Property specific parameters
    rotate: {
      from: '-1turn',
      delay: 0
    },
    delay: stagger(50),
    ease: 'inOutCirc',
    loopDelay: 1000,
    loop: true,
    autoplay: false
  });
}

// Initialize corner widget text animation
setupLoadingTextAnimation();

// ─── Loading overlay ──────────────────────────────────────────────────────────
function setLoadingProgress(pct, status) {
  const bar  = document.getElementById("load-progress-bar");
  const text = document.getElementById("load-progress-text");
  const statusText = document.getElementById("load-status-text");
  const clampedPct = Math.max(0, Math.min(100, Math.round(pct)));
  if (bar)  bar.style.width  = `${clampedPct}%`;
  if (text) text.textContent = `${clampedPct}%`;
  if (status && statusText) statusText.textContent = status;
}
function showLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (!el) return;
  loadingOverlayActive = true;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("is-visible"));
  setLoadingProgress(0);
  startLoadingScramble();

  // Show corner widget and start morphTo + text animations
  const widget = document.getElementById("loading-corner-widget");
  if (widget) widget.classList.add("is-active");
  isMorphingActive = true;
  morphLoopId += 1;
  seedCornerMorphPoints();
  animateRandomPoints(morphLoopId);
  loadingTextAnimation?.restart();
}
function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (!el) return;
  loadingOverlayActive = false;
  stopLoadingScramble();
  el.classList.remove("is-visible");
  el.addEventListener("transitionend", () => { el.hidden = true; }, { once: true });

  // Hide corner widget and stop animations
  const widget = document.getElementById("loading-corner-widget");
  if (widget) widget.classList.remove("is-active");
  isMorphingActive = false;
  morphLoopId += 1;
  loadingTextAnimation?.pause();
}

// ─── Loadout overlay ──────────────────────────────────────────────────────────
function showLoadoutOverlay() {
  buildLoadoutCards();
  const el = document.getElementById("loadout-overlay");
  if (!el) return;
  el.hidden = false;
  requestAnimationFrame(() => {
    el.classList.add("is-visible");
    el.querySelector(".loadout-card")?.focus({ preventScroll: true });
  });
}
function hideLoadoutOverlay() {
  const el = document.getElementById("loadout-overlay");
  if (!el) return;
  el.classList.remove("is-visible");
  el.classList.add("is-closing");
  window.setTimeout(() => {
    el.hidden = true;
    el.classList.remove("is-closing");
  }, 180);
}

function buildLoadoutCards() {
  const container = document.getElementById("loadout-cards");
  if (!container) return;
  container.innerHTML = "";
  selectedWeaponId = null;

  const confirmBtn = document.getElementById("loadout-confirm-btn");
  if (confirmBtn) confirmBtn.disabled = true;

  const statDefs = [
    { key: "damage",   label: "DMG" },
    { key: "fireRate", label: "RPM" },
    { key: "range",    label: "RNG" },
    { key: "mobility", label: "MOB" },
  ];

  for (const [id, def] of Object.entries(WEAPON_DEFS)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "loadout-card";
    card.dataset.weaponId = id;
    card.dataset.category = def.category;
    card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-label", `${def.name}, ${def.subtitle}`);

    const statsHtml = statDefs.map(({ key, label }) => `
      <div class="lc-stat">
        <span class="lc-stat-label">${label}</span>
        <div class="lc-stat-bar">
          <div class="lc-stat-fill" style="width:${def.stats[key] * 10}%"></div>
        </div>
        <span class="lc-stat-val">${def.stats[key]}</span>
      </div>`).join("");

    card.innerHTML = `
      <div class="lc-badge">${def.subtitle}</div>
      <div class="lc-name">${def.name}</div>
      <div class="lc-divider"></div>
      <div class="lc-stats">${statsHtml}</div>
      <div class="lc-select-indicator"></div>`;

    card.addEventListener("click", () => {
      selectedWeaponId = id;
      document.querySelectorAll(".loadout-card")
        .forEach((c) => {
          const selected = c.dataset.weaponId === id;
          c.classList.toggle("is-selected", selected);
          c.setAttribute("aria-pressed", String(selected));
        });
      if (confirmBtn) confirmBtn.disabled = false;
    });

    container.appendChild(card);
  }
}

// Confirm button click
document.addEventListener("click", (e) => {
  if (e.target.closest("#loadout-confirm-btn") && selectedWeaponId) {
    window.dispatchEvent(new CustomEvent("potspark:loadout-confirmed", {
      detail: { weaponId: selectedWeaponId },
    }));
  }
});

// ─── HUD helpers ──────────────────────────────────────────────────────────────
function showHUD() {
  document.getElementById("hud-overlay")?.removeAttribute("hidden");
  document.getElementById("hud-ammo")?.removeAttribute("hidden");
  document.getElementById("hud-weapon-name")?.removeAttribute("hidden");
  document.getElementById("hud-health")?.removeAttribute("hidden");
  syncPointerLockUI();
}

// Ammo HUD event listener
window.addEventListener("potspark:ammo", (e) => {
  const { ammo, max, reserve, reloading, reloadTime } = e.detail;

  // Ammo numbers
  const curEl  = document.getElementById("ammo-current");
  const maxEl  = document.getElementById("ammo-max");
  if (curEl) {
    curEl.textContent = ammo;
    const ratio = max > 0 ? ammo / max : 1;
    curEl.classList.toggle("is-low",  ratio <= 0.4 && ratio > 0.15);
    curEl.classList.toggle("is-crit", ratio <= 0.15);
  }
  if (maxEl) maxEl.textContent = max;
  const reserveEl = document.getElementById("ammo-reserve");
  if (reserveEl) {
    reserveEl.textContent = reserve > 0 ? `+${reserve}` : "";
    reserveEl.hidden = !(weaponSystem.def?.serverAuthoritative);
  }

  // Reload bar
  const reloadBar = document.getElementById("hud-reload-bar");
  const reloadFill = document.getElementById("hud-reload-fill");
  if (reloadBar) reloadBar.hidden = !reloading;
  if (reloadFill && reloading) {
    // Animate bar from 100% → 0% over reloadTime seconds
    reloadFill.style.transition = "none";
    reloadFill.style.width = "100%";
    requestAnimationFrame(() => {
      reloadFill.style.transition = `width ${reloadTime}s linear`;
      reloadFill.style.width = "0%";
    });
  }
});

// Weapon name HUD event listener
window.addEventListener("potspark:weapon-name", (e) => {
  const nameEl = document.getElementById("hud-weapon-label");
  const catEl  = document.getElementById("hud-weapon-cat");
  if (nameEl) nameEl.textContent = e.detail.name;
  if (catEl)  catEl.textContent  = e.detail.subtitle.toUpperCase();
});

// ─── Scene scenery ────────────────────────────────────────────────────────────
function applyLobbyScenery() {
  game.scene.background = null;
  game.scene.fog = new THREE.FogExp2(0x090a0f, 0.018);
}
function applyGameScenery(mapDiagonal) {
  const diag      = mapDiagonal || 400;
  const farPlane  = Math.max(diag * 1.5, 600);
  const fogDensity = 2.5 / diag;
  game.scene.background = new THREE.Color(0x1a1c2a);
  game.scene.fog = new THREE.FogExp2(0x1a1c2a, fogDensity);
  game.camera.far = farPlane;
  game.camera.updateProjectionMatrix();
  console.info(`[Main] Scene — diag=${diag.toFixed(0)} far=${farPlane.toFixed(0)} fog=${fogDensity.toFixed(5)}`);
}

// ─── Map loading → loadout ────────────────────────────────────────────────────
async function startGame() {
  if (gameState !== "lobby") return;

  const uiLayer = document.getElementById("ui-layer");
  if (uiLayer) {
    uiLayer.style.transition = "opacity 0.4s ease";
    uiLayer.style.opacity    = "0";
    await new Promise((r) => setTimeout(r, 400));
    uiLayer.style.display    = "none";
  }

  gameState = "loading";
  showLoadingOverlay();
  const loadingStartedAt = performance.now();

  try {
    setLoadingProgress(2, "Opening deployment stream");
    await waitForPaint();
    applyGameScenery();

    const result = await loadMap(
      game.scene,
      "./assets/models/map_1.glb",
      (pct, status) => setLoadingProgress(pct, status),
    );

    mapRoot = result.root;
    const { spawnPoint, box } = result;

    // Tune fog/far to map size
    const size = new THREE.Vector3();
    box.getSize(size);
    const aboveGroundY = Math.max(box.max.y, 0) - Math.max(box.min.y, 0);
    const diagonal = Math.sqrt(size.x ** 2 + aboveGroundY ** 2 + size.z ** 2);
    applyGameScenery(diagonal);

    // Build one exact, accelerated collision layer for movement and bullets.
    await physics.setColliders(mapRoot, (pct, status) => setLoadingProgress(pct, status));
    weaponSystem.setColliders(physics.raycastColliders);

    // Keep the exact collider above, then spatially partition only the giant
    // visible mesh so off-camera sections no longer reach the GPU every frame.
    await optimizeStaticMapRendering(mapRoot, {
      onProgress: (pct, status) => setLoadingProgress(pct, status),
    });

    // Pre-position camera at spawn (no pointer lock yet)
    placeInGameCamera(spawnPoint);
    updateCamera();

    await wait(Math.max(0, MIN_LOADING_SCREEN_MS - (performance.now() - loadingStartedAt)));
    setLoadingProgress(100);
    hideLoadingOverlay();
    // Enter loadout phase
    gameState = "loadout";
    syncPointerLockUI();
    showLoadoutOverlay();

  } catch (err) {
    console.error("[Main] Map load failed:", err);
    loadingOverlayActive = false;
    stopLoadingScramble();
    isMorphingActive = false;
    morphLoopId += 1;
    loadingTextAnimation?.pause();
    document.getElementById("loading-corner-widget")?.classList.remove("is-active");
    const loadStatus = document.getElementById("load-status-text");
    if (loadStatus) {
      loadStatus.textContent = "⚠ Failed to load map. Check the console.";
      loadStatus.style.color = "#ff4655";
    }
    if (uiLayer) { uiLayer.style.display = ""; uiLayer.style.opacity = "1"; }
    canvas.style.pointerEvents = "none";
    gameState = "lobby";
    syncPointerLockUI();
    applyLobbyScenery();
  }
}

// ─── Loadout confirmed → equip weapon → start playing ────────────────────────
window.addEventListener("potspark:loadout-confirmed", async (e) => {
  if (gameState !== "loadout") return;
  const { weaponId } = e.detail;

  hideLoadoutOverlay();

  try {
    await weaponSystem.equip(weaponId);
    sendEnterGame(weaponId);
    localHealth = 100;
    localLifeId = 0;
    localDead = false;

    canvas.style.pointerEvents = "auto";
    gameState = "playing";
    showHUD();

    // Auto-request pointer lock
    requestGamePointerLock();

  } catch (err) {
    console.error("[Main] Weapon equip failed:", err);
    // Recover — show loadout again
    gameState = "loadout";
    syncPointerLockUI();
    showLoadoutOverlay();
  }
});

// ─── Deploy event from ui.js ─────────────────────────────────────────────────
window.addEventListener("potspark:deploy", () => { startGame(); });

// ─── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const frameNow = performance.now();

  if (gameState === "playing" && document.pointerLockElement === canvas) {

    const isADS = !localDead && mouseBtn[2] && (weaponSystem.def?.adsZoom ?? false);

    // Client prediction uses the same fixed step and CharacterPhysics code as
    // the server. Every predicted command is retained until the server acks it.
    if (!localDead) simulateAndSendMovement(dt, isADS);

    // ── Recoil: sample BEFORE weapon.update() so delta is this-frame-only ───
    // We apply the recoil delta to player.pitch/yaw BEFORE the weapon spring
    // runs, so the camera and the weapon recoil are always in sync with zero
    // one-frame lag. This is the CS2 / Valorant approach.
    const prevRP = weaponSystem.recoilPitch;
    const prevRY = weaponSystem.recoilYaw;

    // ── Shooting ─────────────────────────────────────────────────────────────
    const lmbDown    = mouseBtn[0];
    const lmbNewDown = lmbDown && !prevMouseBtn[0];
    const isAuto     = weaponSystem.def?.auto ?? false;
    if (!localDead && lmbDown && !weaponSystem.isReloading) {
      if (isAuto || lmbNewDown) {
        if (weaponSystem.def?.serverAuthoritative) {
          const command = createShotInputAnchor(isADS);
          weaponSystem.tryFire({
            shotSeq: shotSeq++,
            inputSeq: command.seq,
            rewindTick: ghostManager.getRenderedServerTick(latestSnapshotTick),
            yaw: command.yaw,
            pitch: command.pitch,
          });
        } else {
          weaponSystem.tryFire();
        }
      }
    }

    // ── Weapon update (sway, bob, recoil spring, ADS FOV) ───────────────────
    const isMoving = !localDead && !!(keys["KeyW"] || keys["KeyS"] || keys["KeyA"] || keys["KeyD"] ||
                        keys["ArrowUp"] || keys["ArrowDown"] || keys["ArrowLeft"] || keys["ArrowRight"]);
    weaponSystem.update(dt, mouseDX, mouseDY, isMoving, isADS);

    // ── Apply recoil delta to camera pitch/yaw (after tryFire + spring) ─────
    // newRP/newRY = post-spring values; the delta vs. pre-update captures
    // both the new kick AND the spring return in one accurate step.
    const newRP = weaponSystem.recoilPitch;
    const newRY = weaponSystem.recoilYaw;
    player.pitch -= (newRP - prevRP);  // negative = kick camera upward
    player.yaw   += (newRY - prevRY);
    player.pitch  = THREE.MathUtils.clamp(player.pitch, -Math.PI / 2.2, Math.PI / 2.2);

    // ── Landing camera dip (damped spring) ──────────────────────────────────
    if (physics.justLanded) {
      // Scale impulse by landing speed — gentle hop tiny dip, hard fall bigger
      const dipMag = Math.min(physics.landingSpeed * 0.014, 0.065);
      landingDipVel += dipMag;
    }
    // Spring constants: K=220 (very snappy), D=22 (critically damped feel)
    landingDipVel += (-220 * landingDip - 22 * landingDipVel) * dt;
    landingDip    += landingDipVel * dt;
    landingDip     = THREE.MathUtils.clamp(landingDip, -0.07, 0.07);

    // ── View bob — CS2-style subtle pitch + roll while walking ───────────────
    // Uses a sine wave driven by elapsed walk time. The bob only affects the
    // camera (world sways, weapon stays planted in view). Two components:
    //   Pitch: very small vertical nod (0.004 rad ≈ 0.23°)
    //   Roll:  gentle side-tilt on each step (0.003 rad ≈ 0.17°)
    // ADS halves bob amplitude (realistic, matches Valorant).
    const bobAmp  = isADS ? 0.5 : 1.0;
    if (isMoving && physics.isGrounded) {
      viewBobT += dt * 10.5; // frequency — one full cycle ≈ 0.6 s walking
    } else {
      // Decelerate bob phase (frame-rate independent exponential decay)
      viewBobT *= Math.exp(-dt * 12);
      if (Math.abs(viewBobT) < 0.001) viewBobT = 0;
    }
    const targetBobPitch = Math.sin(viewBobT * 2)      * 0.0042 * bobAmp;
    const targetBobRoll  = Math.sin(viewBobT)          * 0.0028 * bobAmp;
    // Smooth toward target (exp decay — frame-rate independent)
    const bobSmooth = 1 - Math.exp(-dt * 18);
    viewBobPitch += (targetBobPitch - viewBobPitch) * bobSmooth;
    viewBobRoll  += (targetBobRoll  - viewBobRoll)  * bobSmooth;

    // ── Strafe tilt (velocity-based camera roll — Valorant feel) ────────────
    // Project world-space horizontal velocity onto the camera's right axis.
    // Positive strafe right → tilt camera right; strafe left → tilt left.
    const cosY   = Math.cos(player.yaw);
    const sinY   = Math.sin(player.yaw);
    // Camera right axis in world XZ: (cosY, 0, -sinY)
    const strafeVel = physics.velX * cosY + physics.velZ * (-sinY);
    const tiltTarget = THREE.MathUtils.clamp(-strafeVel * 0.0014, -0.028, 0.028);
    // Critically damped spring toward tilt target
    const TILT_K = 280, TILT_D = 30;
    strafeTiltVel += (TILT_K * (tiltTarget - strafeTilt) - TILT_D * strafeTiltVel) * dt;
    strafeTilt    += strafeTiltVel * dt;

    // ── ADS FOV ──────────────────────────────────────────────────────────────
    if (weaponSystem.def?.adsZoom) {
      const nextFov = weaponSystem.currentFov;
      if (Math.abs(game.camera.fov - nextFov) > 0.001) {
        game.camera.fov = nextFov;
        game.camera.updateProjectionMatrix();
      }
    }

    // ── Reset per-frame mouse delta ──────────────────────────────────────────
    mouseDX = 0;
    mouseDY = 0;
  } else if (gameState !== "playing") {
    // Outside play — decay all camera effects to zero
    viewBobPitch *= Math.exp(-dt * 12);
    viewBobRoll  *= Math.exp(-dt * 12);
    strafeTilt   *= Math.exp(-dt * 12);
    landingDip   *= Math.exp(-dt * 12);
  }

  // Hide ordinary reconciliation corrections without moving the authoritative
  // physics rig away from its corrected predicted state.
  cameraCorrection.multiplyScalar(Math.exp(-dt * 18));
  if (cameraCorrection.lengthSq() < 1e-8) cameraCorrection.set(0, 0, 0);

  // Store previous mouse button state
  prevMouseBtn[0] = mouseBtn[0];
  prevMouseBtn[2] = mouseBtn[2];

  updateCamera();
  ghostManager.updateVisuals(frameNow);

  // Debug coordinates do not need a full render-rate DOM update.
  if (showCoords && gameState === "playing" && frameNow - _lastCoordinatePaint >= 100) {
    _lastCoordinatePaint = frameNow;
    if (hudCoordinates.x && hudCoordinates.y && hudCoordinates.z) {
      hudCoordinates.x.textContent = `X: ${cameraRig.position.x.toFixed(2)}`;
      hudCoordinates.y.textContent = `Y: ${cameraRig.position.y.toFixed(2)}`;
      hudCoordinates.z.textContent = `Z: ${cameraRig.position.z.toFixed(2)}`;
    }
  }

  // Only touch the DOM when crouch state actually changes.
  if (gameState === "playing" && physics.crouching !== _lastCrouchState) {
    _lastCrouchState = physics.crouching;
    if (hudCrouchIndicator) hudCrouchIndicator.hidden = !physics.crouching;
  }

  game.render();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
applyLobbyScenery();
placeLobbyCamera();
updateCamera();
game.renderer.setAnimationLoop(animate);
