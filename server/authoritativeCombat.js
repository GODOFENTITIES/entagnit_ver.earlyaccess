import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";

import * as THREE from "three";

import {
  COMBAT_RULES,
  COMBAT_FLAGS,
  HIT_ZONE,
  SHOT_STATUS,
  SIMULATION_HZ,
  weaponRulesForNetId,
} from "../js/protocol.js";

const MAX_SHOT_SEQUENCE_ADVANCE = 2048;
const MAX_RELOAD_SEQUENCE_ADVANCE = 2048;
const MAX_QUEUED_SHOTS = 8;
const MAX_AIM_HISTORY = 180;
const MAX_POSITION_HISTORY = COMBAT_RULES.maxRewindTicks + 12;
const SHOT_TOKEN_RATE = 20;
const SHOT_TOKEN_CAPACITY = 30;
const AIM_EPSILON = 0.0005;
const QUEUED_SHOT_TIMEOUT_TICKS = 8;
const HALF_UINT32 = 0x80000000;
const WALL_EPSILON = 0.01;

const ZONES = Object.freeze([
  Object.freeze({
    id: HIT_ZONE.HEAD,
    centerY: -0.05,
    halfX: 0.19,
    halfY: 0.17,
    halfZ: 0.19,
    multiplier: 2,
  }),
  Object.freeze({
    id: HIT_ZONE.BODY,
    centerY: -0.76,
    halfX: 0.31,
    halfY: 0.41,
    halfZ: 0.23,
    multiplier: 1,
  }),
  Object.freeze({
    id: HIT_ZONE.LEGS,
    centerY: -1.35,
    halfX: 0.29,
    halfY: 0.36,
    halfZ: 0.22,
    multiplier: 0.75,
  }),
]);

function nextLifeId(value) {
  const next = ((value || 0) + 1) & 0xffff;
  return next === 0 ? 1 : next;
}

function uintAge(current, past) {
  return (current - past) >>> 0;
}

function angularDistance(a, b) {
  const twoPi = Math.PI * 2;
  return Math.abs(((a - b + Math.PI) % twoPi + twoPi) % twoPi - Math.PI);
}

function isValidSequenceAdvance(next, previous, maxAdvance) {
  if (!Number.isInteger(next) || next < 1 || next > 0xffffffff) return false;
  if (next <= previous) return false;
  return next - previous <= maxAdvance;
}

function defaultRandom() {
  return randomInt(0, 0x1000000) / 0x1000000;
}

export class AuthoritativeCombat {
  constructor(colliderSource, options = {}) {
    this.colliderSource = colliderSource;
    this.random = typeof options.random === "function" ? options.random : defaultRandom;
    this.events = [];

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.mapHits = [];
    this.origin = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.intersection = new THREE.Vector3();
    this.box = new THREE.Box3();
  }

  initializePlayer(player) {
    player.aimHistory = new Map();
    player.combat = {
      ammo: 0,
      reserveAmmo: 0,
      reloadEndTick: 0,
      nextFireTick: 0,
      lastShotRequestSeq: 0,
      lastReloadRequestSeq: 0,
      shotTokens: SHOT_TOKEN_CAPACITY,
      lastShotTokenRefillAt: performance.now(),
      queuedShots: [],
      history: [],
      lifeId: 0,
      deadUntilTick: 0,
      invulnerableUntilTick: 0,
    };
  }

  enterGame(player, tickNumber) {
    const combat = player.combat;
    combat.lifeId = nextLifeId(combat.lifeId);
    combat.lastShotRequestSeq = 0;
    combat.lastReloadRequestSeq = 0;
    combat.shotTokens = SHOT_TOKEN_CAPACITY;
    combat.lastShotTokenRefillAt = performance.now();
    combat.queuedShots.length = 0;
    combat.history.length = 0;
    combat.deadUntilTick = 0;
    combat.nextFireTick = tickNumber;
    combat.reloadEndTick = 0;
    combat.invulnerableUntilTick = tickNumber + COMBAT_RULES.spawnProtectionTicks;
    this.resetAmmo(player);
    player.aimHistory.clear();
  }

  resetConnectionEpoch(player) {
    if (!player?.combat) return false;
    const combat = player.combat;
    combat.lastShotRequestSeq = 0;
    combat.lastReloadRequestSeq = 0;
    combat.shotTokens = SHOT_TOKEN_CAPACITY;
    combat.lastShotTokenRefillAt = performance.now();
    combat.queuedShots.length = 0;
    player.aimHistory.clear();
    return true;
  }

  resetAmmo(player) {
    const combat = player.combat;
    const rules = weaponRulesForNetId(player.weaponNetId);
    combat.ammo = rules?.magSize || 0;
    combat.reserveAmmo = rules?.reserveAmmo || 0;
  }

  recordAim(player, command) {
    player.aimHistory.set(command.seq, {
      seq: command.seq,
      yaw: command.yaw,
      pitch: command.pitch,
    });
    while (player.aimHistory.size > MAX_AIM_HISTORY) {
      player.aimHistory.delete(player.aimHistory.keys().next().value);
    }
  }

  recordPosition(player, tickNumber) {
    if (!player.inGame) return;
    const combat = player.combat;
    combat.history.push({
      tick: tickNumber >>> 0,
      x: player.rig.position.x,
      y: player.rig.position.y,
      z: player.rig.position.z,
      health: player.health,
      lifeId: combat.lifeId,
    });
    while (combat.history.length > MAX_POSITION_HISTORY) combat.history.shift();
  }

  advancePlayer(player, tickNumber) {
    const combat = player.combat;
    const rules = weaponRulesForNetId(player.weaponNetId);
    if (
      rules
      && player.health > 0
      && combat.reloadEndTick > 0
      && tickNumber >= combat.reloadEndTick
    ) {
      const needed = Math.max(0, rules.magSize - combat.ammo);
      const loaded = Math.min(needed, combat.reserveAmmo);
      combat.ammo += loaded;
      combat.reserveAmmo -= loaded;
      combat.reloadEndTick = 0;
    }
  }

  beginReload(player, requestSeq, tickNumber) {
    const combat = player?.combat;
    if (!player?.inGame || !combat) return { ok: false, reason: "not-in-game" };
    if (!isValidSequenceAdvance(
      requestSeq,
      combat.lastReloadRequestSeq,
      MAX_RELOAD_SEQUENCE_ADVANCE,
    )) {
      return { ok: false, reason: "sequence" };
    }
    combat.lastReloadRequestSeq = requestSeq;

    const rules = weaponRulesForNetId(player.weaponNetId);
    if (!rules) {
      return { ok: true, started: false, reason: "weapon" };
    }
    if (player.health <= 0) return { ok: true, started: false, reason: "dead" };
    if (combat.reloadEndTick > tickNumber) {
      return { ok: true, started: false, reason: "already-reloading" };
    }
    if (combat.ammo >= rules.magSize || combat.reserveAmmo <= 0) {
      return { ok: true, started: false, reason: "not-needed" };
    }

    combat.reloadEndTick = tickNumber + rules.reloadTicks;
    return { ok: true, started: true };
  }

  submitShot(player, request, tickNumber, now = performance.now()) {
    const combat = player?.combat;
    if (!player?.inGame || !combat) return { ok: false, reason: "not-in-game" };
    if (
      !Number.isInteger(request?.inputSeq)
      || request.inputSeq < 1
      || request.inputSeq > 0xffffffff
      || !Number.isInteger(request?.rewindTick)
      || request.rewindTick < 0
      || request.rewindTick > 0xffffffff
      || !Number.isFinite(request?.yaw)
      || !Number.isFinite(request?.pitch)
    ) {
      return { ok: false, reason: "malformed" };
    }

    const elapsedSeconds = Math.max(0, now - combat.lastShotTokenRefillAt) / 1000;
    combat.shotTokens = Math.min(
      SHOT_TOKEN_CAPACITY,
      combat.shotTokens + elapsedSeconds * SHOT_TOKEN_RATE,
    );
    combat.lastShotTokenRefillAt = now;
    if (combat.shotTokens < 1) return { ok: false, reason: "rate-limit" };
    combat.shotTokens -= 1;

    if (!isValidSequenceAdvance(
      request?.shotSeq,
      combat.lastShotRequestSeq,
      MAX_SHOT_SEQUENCE_ADVANCE,
    )) {
      return { ok: false, reason: "sequence" };
    }
    combat.lastShotRequestSeq = request.shotSeq;

    const rules = weaponRulesForNetId(player.weaponNetId);
    if (!rules) {
      this.reject(player, request.shotSeq, SHOT_STATUS.REJECTED_WEAPON, tickNumber);
      return { ok: true, queued: false, reason: "weapon" };
    }
    if (player.health <= 0) {
      this.reject(player, request.shotSeq, SHOT_STATUS.REJECTED_DEAD, tickNumber);
      return { ok: true, queued: false, reason: "dead" };
    }

    const aim = player.aimHistory.get(request.inputSeq);
    if (
      !aim
      || request.inputSeq !== player.lastReceivedSeq
      || angularDistance(aim.yaw, request.yaw) > AIM_EPSILON
      || Math.abs(aim.pitch - request.pitch) > AIM_EPSILON
    ) {
      this.reject(player, request.shotSeq, SHOT_STATUS.REJECTED_AIM, tickNumber);
      return { ok: false, reason: "aim-link" };
    }

    let rewindTick = request.rewindTick >>> 0;
    if (rewindTick === 0) rewindTick = tickNumber >>> 0;
    const rewindAge = uintAge(tickNumber, rewindTick);
    if (rewindAge >= HALF_UINT32 || rewindAge > COMBAT_RULES.maxRewindTicks) {
      this.reject(player, request.shotSeq, SHOT_STATUS.REJECTED_STALE, tickNumber);
      return { ok: false, reason: "rewind" };
    }
    if (combat.queuedShots.length >= MAX_QUEUED_SHOTS) {
      return { ok: false, reason: "queue-limit" };
    }

    combat.queuedShots.push({
      shotSeq: request.shotSeq >>> 0,
      inputSeq: request.inputSeq >>> 0,
      rewindTick,
      yaw: aim.yaw,
      pitch: aim.pitch,
      weaponNetId: player.weaponNetId,
      lifeId: combat.lifeId,
      queuedAtTick: tickNumber >>> 0,
    });
    return { ok: true, queued: true };
  }

  processQueuedShots(world) {
    for (const player of world.players.values()) {
      const queue = player.combat.queuedShots;
      if (queue.length === 0) continue;

      const waiting = [];
      for (const shot of queue) {
        if (player.lastProcessedSeq < shot.inputSeq) {
          if (uintAge(world.tickNumber, shot.queuedAtTick) <= QUEUED_SHOT_TIMEOUT_TICKS) {
            waiting.push(shot);
          } else {
            this.reject(player, shot.shotSeq, SHOT_STATUS.REJECTED_STALE, world.tickNumber);
          }
          continue;
        }
        this.resolveShot(world, player, shot);
      }
      player.combat.queuedShots = waiting;
    }
  }

  resolveShot(world, shooter, shot) {
    const combat = shooter.combat;
    if (shooter.health <= 0) {
      this.reject(shooter, shot.shotSeq, SHOT_STATUS.REJECTED_DEAD, world.tickNumber);
      return;
    }
    const rules = weaponRulesForNetId(shooter.weaponNetId);
    if (
      !rules
      || shot.weaponNetId !== shooter.weaponNetId
      || shot.lifeId !== combat.lifeId
    ) {
      this.reject(shooter, shot.shotSeq, SHOT_STATUS.REJECTED_WEAPON, world.tickNumber);
      return;
    }
    if (combat.reloadEndTick > world.tickNumber) {
      this.reject(shooter, shot.shotSeq, SHOT_STATUS.REJECTED_RELOAD, world.tickNumber);
      return;
    }
    if (world.tickNumber < combat.nextFireTick) {
      this.reject(shooter, shot.shotSeq, SHOT_STATUS.REJECTED_COOLDOWN, world.tickNumber);
      return;
    }
    if (combat.ammo <= 0) {
      this.reject(shooter, shot.shotSeq, SHOT_STATUS.REJECTED_AMMO, world.tickNumber);
      return;
    }

    combat.ammo -= 1;
    combat.nextFireTick = world.tickNumber + rules.fireIntervalTicks;

    this.origin.copy(shooter.rig.position);
    this.directionFromAim(shot.yaw, shot.pitch, this.direction);
    this.applyServerSpread(this.direction, rules.spread);

    this.raycaster.set(this.origin, this.direction);
    this.raycaster.near = 0;
    this.raycaster.far = rules.range;
    this.mapHits.length = 0;
    this.raycaster.intersectObjects(
      this.colliderSource.raycastColliders,
      false,
      this.mapHits,
    );
    const wallDistance = this.mapHits[0]?.distance ?? Infinity;
    const hit = this.findNearestPlayerHit(world, shooter, shot.rewindTick, rules.range);

    if (!hit || wallDistance <= hit.distance + WALL_EPSILON) {
      this.emitResult(shooter, {
        status: SHOT_STATUS.MISS,
        zone: HIT_ZONE.NONE,
        shotSeq: shot.shotSeq,
        serverTick: world.tickNumber,
      });
      return;
    }

    if (world.tickNumber < hit.target.combat.invulnerableUntilTick) {
      this.emitResult(shooter, {
        status: SHOT_STATUS.REJECTED_PROTECTED,
        zone: HIT_ZONE.NONE,
        shotSeq: shot.shotSeq,
        serverTick: world.tickNumber,
        targetId: hit.target.id,
        targetHealth: hit.target.health,
      });
      return;
    }

    const damage = Math.max(1, Math.round(rules.damage * hit.zone.multiplier));
    hit.target.health = Math.max(0, hit.target.health - damage);
    const killed = hit.target.health === 0;
    if (killed) this.killPlayer(hit.target, world.tickNumber);

    this.emitResult(shooter, {
      status: killed ? SHOT_STATUS.KILL : SHOT_STATUS.HIT,
      zone: hit.zone.id,
      shotSeq: shot.shotSeq,
      serverTick: world.tickNumber,
      targetId: hit.target.id,
      damage,
      targetHealth: hit.target.health,
    });
  }

  findNearestPlayerHit(world, shooter, rewindTick, range) {
    let nearest = null;
    for (const target of world.players.values()) {
      if (
        target.id === shooter.id
        || !target.inGame
        || target.health <= 0
        || !world.arePlayersInSameMatch(shooter, target)
        || world.arePlayersFriendly(shooter, target)
      ) continue;

      const state = this.historyAt(target, rewindTick);
      if (!state || state.health <= 0 || state.lifeId !== target.combat.lifeId) continue;

      for (const zone of ZONES) {
        this.box.min.set(
          state.x - zone.halfX,
          state.y + zone.centerY - zone.halfY,
          state.z - zone.halfZ,
        );
        this.box.max.set(
          state.x + zone.halfX,
          state.y + zone.centerY + zone.halfY,
          state.z + zone.halfZ,
        );
        const point = this.raycaster.ray.intersectBox(this.box, this.intersection);
        if (!point) continue;
        const distance = this.origin.distanceTo(point);
        if (distance > range) continue;
        if (!nearest || distance < nearest.distance) {
          nearest = { target, zone, distance };
        }
      }
    }
    return nearest;
  }

  historyAt(player, rewindTick) {
    const history = player.combat.history;
    let best = null;
    let bestAge = HALF_UINT32;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const state = history[index];
      const age = uintAge(rewindTick, state.tick);
      if (age >= HALF_UINT32) continue;
      if (age < bestAge) {
        best = state;
        bestAge = age;
        if (age === 0) break;
      }
    }
    return best;
  }

  directionFromAim(yaw, pitch, target) {
    const cosPitch = Math.cos(pitch);
    return target.set(
      -Math.sin(yaw) * cosPitch,
      Math.sin(pitch),
      -Math.cos(yaw) * cosPitch,
    ).normalize();
  }

  applyServerSpread(direction, spread) {
    this.right.crossVectors(direction, THREE.Object3D.DEFAULT_UP);
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0);
    else this.right.normalize();
    this.up.crossVectors(this.right, direction).normalize();
    const spreadX = (this.random() - 0.5) * spread;
    const spreadY = (this.random() - 0.5) * spread;
    direction
      .addScaledVector(this.right, spreadX)
      .addScaledVector(this.up, spreadY)
      .normalize();
  }

  killPlayer(player, tickNumber) {
    const combat = player.combat;
    combat.deadUntilTick = tickNumber + COMBAT_RULES.respawnTicks;
    combat.reloadEndTick = 0;
    combat.queuedShots.length = 0;
    const state = player.physics.captureState(player.rig);
    player.physics.restoreState(player.rig, {
      ...state,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
    });
  }

  respawnPlayer(player, tickNumber) {
    const combat = player.combat;
    combat.lifeId = nextLifeId(combat.lifeId);
    combat.deadUntilTick = 0;
    combat.reloadEndTick = 0;
    combat.nextFireTick = tickNumber;
    combat.queuedShots.length = 0;
    combat.history.length = 0;
    combat.invulnerableUntilTick = tickNumber + COMBAT_RULES.spawnProtectionTicks;
    this.resetAmmo(player);
  }

  combatFlags(player, tickNumber) {
    let flags = 0;
    if (weaponRulesForNetId(player.weaponNetId)) {
      flags |= COMBAT_FLAGS.AUTHORITATIVE_WEAPON;
    }
    if (player.combat.reloadEndTick > tickNumber) flags |= COMBAT_FLAGS.RELOADING;
    if (player.health <= 0) flags |= COMBAT_FLAGS.DEAD;
    if (tickNumber < player.combat.invulnerableUntilTick) {
      flags |= COMBAT_FLAGS.SPAWN_PROTECTED;
    }
    return flags;
  }

  snapshotFor(player, tickNumber) {
    return {
      ammo: player.combat.ammo,
      reserveAmmo: player.combat.reserveAmmo,
      reloadRemainingTicks: Math.max(0, player.combat.reloadEndTick - tickNumber),
      respawnRemainingTicks: Math.max(0, player.combat.deadUntilTick - tickNumber),
      flags: this.combatFlags(player, tickNumber),
      weaponNetId: player.weaponNetId,
      lifeId: player.combat.lifeId,
    };
  }

  reject(player, shotSeq, status, tickNumber) {
    this.emitResult(player, { status, shotSeq, serverTick: tickNumber });
  }

  emitResult(shooter, result) {
    const combat = shooter.combat;
    this.events.push({
      shooterId: shooter.id,
      status: result.status,
      zone: result.zone ?? HIT_ZONE.NONE,
      shotSeq: result.shotSeq >>> 0,
      serverTick: result.serverTick >>> 0,
      targetId: result.targetId || 0,
      ammo: combat.ammo,
      reserveAmmo: combat.reserveAmmo,
      damage: result.damage || 0,
      targetHealth: result.targetHealth ?? 0,
      reloadRemainingTicks: Math.max(0, combat.reloadEndTick - result.serverTick),
      weaponNetId: shooter.weaponNetId,
    });
  }

  drainEvents() {
    if (this.events.length === 0) return [];
    const drained = this.events;
    this.events = [];
    return drained;
  }

  get historyTicks() {
    return MAX_POSITION_HISTORY;
  }

  get simulationHz() {
    return SIMULATION_HZ;
  }
}
