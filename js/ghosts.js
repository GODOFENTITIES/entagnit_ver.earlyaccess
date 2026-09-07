/**
 * Remote player presentation for networked opponents.
 *
 * Server snapshots arrive at 20 Hz. GhostManager buffers remote states and
 * renders them slightly in the past so movement stays smooth at render rate.
 */

import * as THREE from "three";
import { PLAYER_FLAGS } from "./network.js";

const INTERPOLATION_DELAY_MS = 100;
const HISTORY_MS = 1000;

const PALETTE = [
  0xff4655,
  0x00d4ff,
  0xffcc00,
  0x7fff7f,
  0xff7f00,
  0xcc88ff,
  0x00ffcc,
  0xff69b4,
];

let bodyGeo = null;
let headGeo = null;
let ringGeo = null;
let hitHeadGeo = null;
let hitBodyGeo = null;
let hitLegsGeo = null;
let hitboxMat = null;

function colorForId(id) {
  return PALETTE[(id - 1) % PALETTE.length];
}

function getBodyGeo() {
  if (!bodyGeo) bodyGeo = new THREE.CapsuleGeometry(0.3, 1.2, 4, 8);
  return bodyGeo;
}

function getHeadGeo() {
  if (!headGeo) headGeo = new THREE.SphereGeometry(0.25, 8, 8);
  return headGeo;
}

function getRingGeo() {
  if (!ringGeo) ringGeo = new THREE.TorusGeometry(0.35, 0.03, 6, 16);
  return ringGeo;
}

function getHitboxMaterial() {
  if (!hitboxMat) {
    hitboxMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });
  }
  return hitboxMat;
}

function getHitboxGeometry(zone) {
  if (zone === "head") {
    if (!hitHeadGeo) hitHeadGeo = new THREE.BoxGeometry(0.38, 0.34, 0.38);
    return hitHeadGeo;
  }
  if (zone === "legs") {
    if (!hitLegsGeo) hitLegsGeo = new THREE.BoxGeometry(0.58, 0.72, 0.44);
    return hitLegsGeo;
  }
  if (!hitBodyGeo) hitBodyGeo = new THREE.BoxGeometry(0.62, 0.82, 0.46);
  return hitBodyGeo;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  const twoPi = Math.PI * 2;
  let diff = ((b - a + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return a + diff * t;
}

function disposeMaterial(material) {
  if (!material) return;
  material.map?.dispose?.();
  material.dispose?.();
}

export class GhostManager {
  constructor(scene) {
    this._scene = scene;
    this._ghosts = new Map();
    this._scratchHitboxes = [];
    this._latestSnapshotTick = 0;
    this._latestRenderedTick = 0;
  }

  updateFromState(state, localPlayerId) {
    if (!state?.players) return;

    const now = performance.now();
    this._latestSnapshotTick = state.tick >>> 0;
    const seenIds = new Set();

    for (const playerState of state.players) {
      if (playerState.id === localPlayerId) continue;

      seenIds.add(playerState.id);
      const ghost = this._ensureGhost(playerState.id);
      if (ghost.lifeId !== playerState.lifeId) {
        ghost.lifeId = playerState.lifeId;
        ghost.buffer.length = 0;
      }
      ghost.lastSeenAt = now;
      ghost.health = playerState.health;
      ghost.flags = playerState.flags;
      ghost.buffer.push({ t: now, tick: state.tick >>> 0, ...playerState });

      const cutoff = now - HISTORY_MS;
      while (ghost.buffer.length > 0 && ghost.buffer[0].t < cutoff) {
        ghost.buffer.shift();
      }
    }

    for (const [id] of this._ghosts) {
      if (!seenIds.has(id)) this._remove(id);
    }
  }

  updateVisuals(now = performance.now()) {
    let renderedTick = 0;
    for (const ghost of this._ghosts.values()) {
      const sample = this._sample(ghost.buffer, now - INTERPOLATION_DELAY_MS);
      if (!sample) continue;
      renderedTick = Math.max(renderedTick, sample.tick >>> 0);

      const alive = sample.health > 0 && !(sample.flags & PLAYER_FLAGS.DEAD);
      ghost.group.position.set(sample.x, sample.y - 0.9, sample.z);
      ghost.group.rotation.y = sample.yaw;
      ghost.group.visible = true;

      const opacity = alive ? 0.85 : 0.22;
      ghost.body.material.opacity = opacity;
      ghost.head.material.opacity = opacity;
      ghost.ring.material.opacity = alive ? 0.4 : 0.12;

      for (const hitbox of ghost.hitboxes) {
        hitbox.userData.dead = !alive;
      }
    }
    this._latestRenderedTick = renderedTick;
  }

  getHitboxes() {
    this._scratchHitboxes.length = 0;
    for (const ghost of this._ghosts.values()) {
      if (ghost.health <= 0 || (ghost.flags & PLAYER_FLAGS.DEAD)) continue;
      this._scratchHitboxes.push(...ghost.hitboxes);
    }
    return this._scratchHitboxes;
  }

  disposeAll() {
    for (const [id] of [...this._ghosts]) this._remove(id);
  }

  get count() {
    return this._ghosts.size;
  }

  getRenderedServerTick(fallbackTick = 0) {
    return this._latestRenderedTick
      || fallbackTick
      || this._latestSnapshotTick
      || 0;
  }

  _ensureGhost(id) {
    let ghost = this._ghosts.get(id);
    if (ghost) return ghost;

    ghost = this._createGhost(id);
    this._ghosts.set(id, ghost);
    this._scene?.add(ghost.group);
    console.log(`[ghosts] spawned player ${id}`);
    return ghost;
  }

  _createGhost(id) {
    const color = colorForId(id);
    const bodyMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const headMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });

    const body = new THREE.Mesh(getBodyGeo(), bodyMat);
    const head = new THREE.Mesh(getHeadGeo(), headMat);
    const ring = new THREE.Mesh(getRingGeo(), ringMat);
    const tag = this._makeNametag(id, color);
    const hitboxes = this._makeHitboxes(id);

    body.position.y = 0;
    head.position.y = 0.85;
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.6;

    const group = new THREE.Group();
    group.userData.playerId = id;
    group.add(body, head, ring, tag, ...hitboxes);

    return {
      id,
      group,
      body,
      head,
      ring,
      tag,
      hitboxes,
      buffer: [],
      health: 100,
      flags: 0,
      lifeId: 0,
      lastSeenAt: performance.now(),
    };
  }

  _makeHitboxes(playerId) {
    const mat = getHitboxMaterial();

    const head = new THREE.Mesh(getHitboxGeometry("head"), mat);
    head.position.y = 0.85;
    head.userData = { playerId, zone: "head", multiplier: 2.0 };

    const body = new THREE.Mesh(getHitboxGeometry("body"), mat);
    body.position.y = 0.14;
    body.userData = { playerId, zone: "body", multiplier: 1.0 };

    const legs = new THREE.Mesh(getHitboxGeometry("legs"), mat);
    legs.position.y = -0.45;
    legs.userData = { playerId, zone: "legs", multiplier: 0.75 };

    return [head, body, legs];
  }

  _makeNametag(id, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(4, 8, 120, 32, 8);
    ctx.fill();

    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.font = "bold 22px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`P${id}`, 64, 24);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.0, 0.375, 1);
    sprite.position.y = 1.5;
    return sprite;
  }

  _sample(buffer, renderTime) {
    if (buffer.length === 0) return null;
    if (buffer.length === 1) return buffer[0];

    let before = null;
    let after = null;

    for (let i = 0; i < buffer.length - 1; i += 1) {
      const a = buffer[i];
      const b = buffer[i + 1];
      if (a.t <= renderTime && b.t >= renderTime) {
        before = a;
        after = b;
        break;
      }
    }

    if (!before || !after) return buffer[buffer.length - 1];

    const span = Math.max(1, after.t - before.t);
    const alpha = THREE.MathUtils.clamp((renderTime - before.t) / span, 0, 1);
    return {
      id: before.id,
      x: lerp(before.x, after.x, alpha),
      y: lerp(before.y, after.y, alpha),
      z: lerp(before.z, after.z, alpha),
      yaw: lerpAngle(before.yaw, after.yaw, alpha),
      pitch: lerpAngle(before.pitch, after.pitch, alpha),
      tick: Math.round(lerp(before.tick, after.tick, alpha)) >>> 0,
      health: after.health,
      flags: after.flags,
    };
  }

  _remove(id) {
    const ghost = this._ghosts.get(id);
    if (!ghost) return;

    this._scene?.remove(ghost.group);
    disposeMaterial(ghost.body.material);
    disposeMaterial(ghost.head.material);
    disposeMaterial(ghost.ring.material);
    disposeMaterial(ghost.tag.material);
    this._ghosts.delete(id);
    console.log(`[ghosts] removed player ${id}`);
  }
}

