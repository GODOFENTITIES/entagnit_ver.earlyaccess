import { performance } from "node:perf_hooks";

import * as THREE from "three";

import { CharacterPhysics } from "../js/physics.js";
import {
  DEFAULT_WEAPON_NET_ID,
  INPUT_MASK,
  PLAYER_FLAGS,
  SIMULATION_DT,
  TEAM,
  VALID_INPUT_MASK,
  inputMaskToKeys,
  movementSpeedForNetId,
  weaponRulesForNetId,
} from "../js/protocol.js";
import { AuthoritativeCombat } from "./authoritativeCombat.js";

export const SPAWN_POINT = Object.freeze({
  x: -101.03,
  y: -16.60,
  z: -30.00,
});

const MAX_SEQUENCE_ADVANCE = 2048;
const INPUT_STALE_MS = 250;
const INPUT_TOKEN_RATE = 90;
const INPUT_TOKEN_CAPACITY = 120;
const FALL_RESPAWN_Y = -100;

function normalizeYaw(value) {
  const twoPi = Math.PI * 2;
  return ((value + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function neutralInput(previous = {}) {
  return {
    seq: previous.seq >>> 0,
    mask: 0,
    yaw: Number.isFinite(previous.yaw) ? previous.yaw : 0,
    pitch: Number.isFinite(previous.pitch) ? previous.pitch : 0,
  };
}

export class AuthoritativeWorld {
  constructor(colliderSource, options = {}) {
    if (!(colliderSource instanceof CharacterPhysics) || colliderSource.colliderCount === 0) {
      throw new TypeError("AuthoritativeWorld requires a prepared CharacterPhysics collider source");
    }
    this.colliderSource = colliderSource;
    this.combat = new AuthoritativeCombat(colliderSource, options.combat);
    this.players = new Map();
    this.tickNumber = 0;
    this.elapsedMs = 0;
  }

  addPlayer(id) {
    if (!Number.isInteger(id) || id < 1 || id > 0xffff || this.players.has(id)) {
      throw new RangeError(`Invalid or duplicate player id: ${id}`);
    }

    const physics = new CharacterPhysics().useSharedColliders(this.colliderSource);
    const rig = new THREE.Object3D();
    physics.teleport(rig, SPAWN_POINT.x, SPAWN_POINT.y, SPAWN_POINT.z);
    const now = performance.now();
    const player = {
      id,
      physics,
      rig,
      inGame: false,
      roomCode: null,
      team: TEAM.NONE,
      health: 100,
      weaponNetId: DEFAULT_WEAPON_NET_ID,
      yaw: 0,
      pitch: 0,
      flags: 0,
      pendingInput: null,
      currentInput: neutralInput(),
      keyState: {},
      lastReceivedSeq: 0,
      lastProcessedSeq: 0,
      lastInputSimulationMs: -Infinity,
      inputTokens: INPUT_TOKEN_CAPACITY,
      lastTokenRefillAt: now,
      rejectedInputs: 0,
    };
    this.combat.initializePlayer(player);
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return false;
    player.physics.disposeColliders();
    player.aimHistory.clear();
    player.combat.history.length = 0;
    player.combat.queuedShots.length = 0;
    this.players.delete(id);
    return true;
  }

  enterGame(id, weaponNetId) {
    const player = this.players.get(id);
    if (!player || !weaponRulesForNetId(weaponNetId)) return false;
    if (player.inGame) return player.weaponNetId === weaponNetId;

    player.weaponNetId = weaponNetId;
    player.health = 100;
    player.yaw = 0;
    player.pitch = 0;
    player.flags = 0;
    player.pendingInput = null;
    player.currentInput = neutralInput();
    player.lastReceivedSeq = 0;
    player.lastProcessedSeq = 0;
    player.lastInputSimulationMs = this.elapsedMs;
    player.physics.teleport(player.rig, SPAWN_POINT.x, SPAWN_POINT.y, SPAWN_POINT.z);
    player.inGame = true;
    this.combat.enterGame(player, this.tickNumber);
    this.combat.recordPosition(player, this.tickNumber);
    return true;
  }

  assignPlayerRoom(id, roomCode = null, team = TEAM.NONE) {
    const player = this.players.get(id);
    if (!player || player.inGame) return false;
    player.roomCode = roomCode || null;
    player.team = player.roomCode ? team : TEAM.NONE;
    return true;
  }

  resetConnectionEpoch(id) {
    const player = this.players.get(id);
    if (!player) return false;
    player.pendingInput = null;
    player.currentInput = neutralInput();
    player.keyState = {};
    player.lastReceivedSeq = 0;
    player.lastProcessedSeq = 0;
    player.lastInputSimulationMs = this.elapsedMs;
    player.inputTokens = INPUT_TOKEN_CAPACITY;
    player.lastTokenRefillAt = performance.now();
    this.combat.resetConnectionEpoch(player);
    return true;
  }

  neutralizePlayerInput(id) {
    const player = this.players.get(id);
    if (!player) return false;
    player.pendingInput = null;
    player.currentInput = neutralInput(player.currentInput);
    player.keyState = {};
    player.lastInputSimulationMs = -Infinity;
    return true;
  }

  arePlayersInSameMatch(left, right) {
    if (!left || !right) return false;
    if (left.roomCode || right.roomCode) {
      return !!left.roomCode && left.roomCode === right.roomCode;
    }
    return true;
  }

  arePlayersFriendly(left, right) {
    return this.arePlayersInSameMatch(left, right)
      && !!left.roomCode
      && left.team !== TEAM.NONE
      && left.team === right.team;
  }

  submitInput(id, command, now = performance.now()) {
    const player = this.players.get(id);
    if (!player?.inGame) return { ok: false, reason: "not-in-game" };

    const elapsedSeconds = Math.max(0, now - player.lastTokenRefillAt) / 1000;
    player.inputTokens = Math.min(
      INPUT_TOKEN_CAPACITY,
      player.inputTokens + elapsedSeconds * INPUT_TOKEN_RATE,
    );
    player.lastTokenRefillAt = now;
    if (player.inputTokens < 1) {
      player.rejectedInputs += 1;
      return { ok: false, reason: "rate-limit" };
    }
    player.inputTokens -= 1;

    if (
      !Number.isInteger(command?.seq)
      || command.seq <= player.lastReceivedSeq
      || command.seq - player.lastReceivedSeq > MAX_SEQUENCE_ADVANCE
    ) {
      player.rejectedInputs += 1;
      return { ok: false, reason: "sequence" };
    }
    if (
      !Number.isInteger(command.mask)
      || command.mask < 0
      || command.mask > 0xff
      || (command.mask & ~VALID_INPUT_MASK) !== 0
    ) {
      player.rejectedInputs += 1;
      return { ok: false, reason: "mask" };
    }
    if (!Number.isFinite(command.yaw) || !Number.isFinite(command.pitch)) {
      player.rejectedInputs += 1;
      return { ok: false, reason: "non-finite" };
    }

    const sanitized = {
      seq: command.seq >>> 0,
      mask: command.mask & VALID_INPUT_MASK,
      yaw: normalizeYaw(command.yaw),
      pitch: clamp(command.pitch, -Math.PI / 2.2, Math.PI / 2.2),
    };
    player.lastReceivedSeq = sanitized.seq;
    player.lastInputSimulationMs = this.elapsedMs;
    this.combat.recordAim(player, sanitized);

    // Only the newest control state can affect the next fixed server tick.
    // Sending 1 or 10,000 packets before that tick still yields one movement step.
    player.pendingInput = sanitized;
    return { ok: true };
  }

  step(dt = SIMULATION_DT) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const fixedDt = Math.min(dt, 0.05);
    this.tickNumber = (this.tickNumber + 1) >>> 0;
    this.elapsedMs += fixedDt * 1000;

    for (const player of this.players.values()) {
      if (!player.inGame) continue;

      if (player.health <= 0) {
        if (this.tickNumber >= player.combat.deadUntilTick) {
          this.respawnPlayer(player);
        } else {
          player.pendingInput = null;
          player.currentInput = neutralInput(player.currentInput);
          player.flags = this.computeFlags(player);
          this.combat.recordPosition(player, this.tickNumber);
          continue;
        }
      }

      this.combat.advancePlayer(player, this.tickNumber);

      if (player.pendingInput) {
        player.currentInput = player.pendingInput;
        player.pendingInput = null;
        player.lastProcessedSeq = player.currentInput.seq;
      } else if (this.elapsedMs - player.lastInputSimulationMs > INPUT_STALE_MS) {
        player.currentInput = neutralInput(player.currentInput);
      }

      const input = player.currentInput;
      inputMaskToKeys(input.mask, player.keyState);
      player.physics.update(
        fixedDt,
        player.keyState,
        player.rig,
        movementSpeedForNetId(player.weaponNetId),
        input.yaw,
      );
      player.yaw = input.yaw;
      player.pitch = input.pitch;

      if (!Number.isFinite(player.rig.position.y) || player.rig.position.y < FALL_RESPAWN_Y) {
        this.respawnPlayer(player);
      }
      player.flags = this.computeFlags(player);
      this.combat.recordPosition(player, this.tickNumber);
    }

    this.combat.processQueuedShots(this);
    for (const player of this.players.values()) {
      if (player.inGame) player.flags = this.computeFlags(player);
    }
  }

  respawnPlayer(playerOrId) {
    const player = typeof playerOrId === "number"
      ? this.players.get(playerOrId)
      : playerOrId;
    if (!player) return false;
    player.health = 100;
    player.pendingInput = null;
    player.currentInput = neutralInput(player.currentInput);
    player.physics.teleport(player.rig, SPAWN_POINT.x, SPAWN_POINT.y, SPAWN_POINT.z);
    this.combat.respawnPlayer(player, this.tickNumber);
    this.combat.recordPosition(player, this.tickNumber);
    player.flags = this.computeFlags(player);
    return true;
  }

  computeFlags(player) {
    let flags = 0;
    if (player.health <= 0) flags |= PLAYER_FLAGS.DEAD;
    if (player.physics.crouching) flags |= PLAYER_FLAGS.CROUCHING;
    if (player.physics.sprinting) flags |= PLAYER_FLAGS.SPRINTING;
    if (player.physics.aiming) flags |= PLAYER_FLAGS.AIMING;
    if (player.physics.isGrounded) flags |= PLAYER_FLAGS.GROUNDED;
    if (this.tickNumber < player.combat.invulnerableUntilTick) {
      flags |= PLAYER_FLAGS.SPAWN_PROTECTED;
    }
    return flags;
  }

  getSnapshotPlayers(receiverOrId = null) {
    const receiver = typeof receiverOrId === "number"
      ? this.players.get(receiverOrId)
      : receiverOrId;
    const result = [];
    for (const player of this.players.values()) {
      if (!player.inGame) continue;
      if (receiver && !this.arePlayersInSameMatch(receiver, player)) continue;
      result.push({
        id: player.id,
        weaponNetId: player.weaponNetId,
        health: player.health,
        lifeId: player.combat.lifeId,
        flags: player.flags,
        yaw: player.yaw,
        pitch: player.pitch,
        ...player.physics.captureState(player.rig),
      });
    }
    return result;
  }

  getPlayer(id) {
    return this.players.get(id) || null;
  }

  submitShot(id, request, now = performance.now()) {
    return this.combat.submitShot(this.players.get(id), request, this.tickNumber, now);
  }

  submitReload(id, requestSeq) {
    return this.combat.beginReload(this.players.get(id), requestSeq, this.tickNumber);
  }

  getCombatSnapshot(idOrPlayer) {
    const player = typeof idOrPlayer === "number"
      ? this.players.get(idOrPlayer)
      : idOrPlayer;
    return player ? this.combat.snapshotFor(player, this.tickNumber) : null;
  }

  drainCombatEvents() {
    return this.combat.drainEvents();
  }

  dispose() {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
  }
}

export function hasMovementIntent(mask) {
  return !!(mask & (
    INPUT_MASK.FORWARD
    | INPUT_MASK.BACKWARD
    | INPUT_MASK.LEFT
    | INPUT_MASK.RIGHT
  ));
}
