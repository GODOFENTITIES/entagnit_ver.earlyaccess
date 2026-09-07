import assert from "node:assert/strict";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";

import * as THREE from "three";
import {
  packInputCommand,
  packNormalMatchJoinRequest,
  packReloadRequest,
  packShotRequest,
} from "../js/network.js";
import {
  AUTHORITATIVE_PISTOL_NET_ID,
  COMBAT_RULES,
  HIT_ZONE,
  MSG,
  PISTOL_RULES,
  PROTOCOL_VERSION,
  SHOT_BYTES,
  SHOT_STATUS,
  SIMULATION_DT,
  STATE_HEADER_BYTES,
  STATE_PLAYER_BYTES,
  WEAPON_NET_IDS,
  WEAPON_RULES,
} from "../js/protocol.js";
import { AuthoritativeWorld } from "../server/authoritativeWorld.js";
import { loadAuthoritativeCollision } from "../server/mapCollision.js";
import {
  createPotSparkServer,
  decodeReloadFrame,
  decodeShotFrame,
} from "../server/runtime.js";
import { createAuthenticatedSocket } from "./helpers/match-client.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");

let colliderSource;
let world;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for expected network state");
}

function stepMany(targetWorld, ticks) {
  for (let index = 0; index < ticks; index += 1) targetWorld.step(SIMULATION_DT);
}

function addDuel(targetWorld, weaponNetId = AUTHORITATIVE_PISTOL_NET_ID) {
  const shooter = targetWorld.addPlayer(1);
  const target = targetWorld.addPlayer(2);
  assert.equal(targetWorld.enterGame(1, weaponNetId), true);
  assert.equal(targetWorld.enterGame(2, weaponNetId), true);
  stepMany(targetWorld, 180);

  // Spawn faces clear -Z. Put the target five metres down that lane.
  target.physics.teleport(
    target.rig,
    shooter.rig.position.x,
    shooter.rig.position.y,
    shooter.rig.position.z - 5,
  );
  targetWorld.step();
  return { shooter, target };
}

function queueShot(targetWorld, {
  shooterId = 1,
  inputSeq,
  shotSeq,
  yaw = 0,
  pitch = 0,
  rewindTick = targetWorld.tickNumber,
  forgedClaims = {},
}) {
  assert.equal(targetWorld.submitInput(shooterId, {
    seq: inputSeq,
    mask: 0,
    yaw,
    pitch,
  }).ok, true);
  return targetWorld.submitShot(shooterId, {
    ...forgedClaims,
    shotSeq,
    inputSeq,
    rewindTick,
    yaw,
    pitch,
  });
}

function packEnterGame(weaponNetId = AUTHORITATIVE_PISTOL_NET_ID) {
  const frame = Buffer.alloc(4);
  frame.writeUInt8(MSG.ENTER_GAME, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(weaponNetId, 2);
  frame.writeUInt8(0, 3);
  return frame;
}

function parseLiveFrame(data) {
  const frame = Buffer.from(data);
  const opcode = frame.readUInt8(0);
  if (opcode === MSG.HIT) {
    return {
      type: "hit",
      status: frame.readUInt8(2),
      zone: frame.readUInt8(3),
      shotSeq: frame.readUInt32LE(4),
      ammo: frame.readUInt16LE(14),
      damage: frame.readUInt8(18),
      targetHealth: frame.readUInt8(19),
      weaponNetId: frame.readUInt8(22),
    };
  }
  if (opcode !== MSG.STATE) return null;

  const count = frame.readUInt16LE(10);
  const players = [];
  for (let index = 0; index < count; index += 1) {
    const offset = STATE_HEADER_BYTES + index * STATE_PLAYER_BYTES;
    players.push({
      id: frame.readUInt16LE(offset),
      health: frame.readUInt8(offset + 3),
    });
  }
  return {
    type: "state",
    tick: frame.readUInt32LE(2),
    ammo: frame.readUInt16LE(12),
    reserveAmmo: frame.readUInt16LE(14),
    weaponNetId: frame.readUInt8(21),
    players,
  };
}

async function connectCombatClient(socketUrl, origin) {
  const { ws } = await createAuthenticatedSocket(socketUrl, origin);
  return new Promise((resolve, reject) => {
    const client = { ws, id: null, state: null, hits: [] };
    ws.once("error", reject);
    ws.on("message", (data) => {
      const frame = Buffer.from(data);
      if (frame.readUInt8(0) === MSG.WELCOME) {
        client.id = frame.readUInt16LE(2);
        resolve(client);
        return;
      }
      const parsed = parseLiveFrame(data);
      if (parsed?.type === "state") client.state = parsed;
      if (parsed?.type === "hit") client.hits.push(parsed);
    });
  });
}

before(async () => {
  ({ colliderSource } = await loadAuthoritativeCollision(MAP_PATH));
});

beforeEach(() => {
  // Zero-centred spread makes geometry assertions exact. Production uses
  // server-only randomness and never accepts a client-provided spread value.
  world = new AuthoritativeWorld(colliderSource, { combat: { random: () => 0.5 } });
});

afterEach(() => {
  world?.dispose();
  world = null;
});

after(() => {
  colliderSource?.disposeColliders();
});

test("shot and reload frames cannot encode a target, origin, damage, ammo, or client time", () => {
  const frame = packShotRequest({
    shotSeq: 7,
    inputSeq: 21,
    rewindTick: 900,
    yaw: 0.25,
    pitch: -0.1,
    targetId: 2,
    damage: 255,
    ammo: 999,
    origin: [999, 999, 999],
    timestamp: Number.MAX_VALUE,
    weaponNetId: WEAPON_NET_IDS.RECON,
  });

  assert.equal(frame.byteLength, SHOT_BYTES);
  const decoded = decodeShotFrame(Buffer.from(frame));
  assert.equal(decoded.ok, true);
  assert.deepEqual(
    Object.keys(decoded.request).sort(),
    ["inputSeq", "pitch", "rewindTick", "shotSeq", "yaw"],
  );

  const oversizedForgery = Buffer.alloc(SHOT_BYTES + 16);
  oversizedForgery.writeUInt8(MSG.SHOT, 0);
  oversizedForgery.writeUInt8(PROTOCOL_VERSION, 1);
  assert.deepEqual(decodeShotFrame(oversizedForgery), { ok: false, reason: "length" });

  const nanAim = Buffer.from(frame);
  nanAim.writeFloatLE(Number.NaN, 14);
  assert.deepEqual(decodeShotFrame(nanAim), { ok: false, reason: "non-finite" });

  const reload = packReloadRequest(4);
  assert.deepEqual(decodeReloadFrame(Buffer.from(reload)), { ok: true, requestSeq: 4 });
});

test("a valid Breach headshot is raycast and damaged only by the server", () => {
  const { target, shooter } = addDuel(world);
  const queued = queueShot(world, { inputSeq: 1, shotSeq: 1 });
  assert.equal(queued.ok, true);
  world.step();

  const [result] = world.drainCombatEvents();
  assert.equal(result.status, SHOT_STATUS.HIT);
  assert.equal(result.zone, HIT_ZONE.HEAD);
  assert.equal(result.targetId, target.id);
  assert.equal(result.damage, 60);
  assert.equal(target.health, 40);
  assert.equal(shooter.combat.ammo, PISTOL_RULES.magSize - 1);
});

test("every loadout gun uses its server-owned damage, cadence, ammo, and reload rules", async (t) => {
  for (const [weaponId, rules] of Object.entries(WEAPON_RULES)) {
    await t.test(weaponId, () => {
      const weaponWorld = new AuthoritativeWorld(colliderSource, {
        combat: { random: () => 0.5 },
      });
      try {
        const { shooter, target } = addDuel(weaponWorld, rules.weaponNetId);
        const forgedWeaponNetId = rules.weaponNetId === WEAPON_NET_IDS.RECON
          ? WEAPON_NET_IDS.VESPER
          : WEAPON_NET_IDS.RECON;

        const queued = queueShot(weaponWorld, {
          inputSeq: 1,
          shotSeq: 1,
          forgedClaims: {
            weaponNetId: forgedWeaponNetId,
            targetId: target.id,
            damage: 255,
          },
        });
        assert.equal(queued.ok, true);
        weaponWorld.step();

        const [confirmed] = weaponWorld.drainCombatEvents();
        const expectedDamage = Math.round(rules.damage * 2);
        const expectedHealth = Math.max(0, 100 - expectedDamage);
        assert.equal(
          confirmed.status,
          expectedHealth === 0 ? SHOT_STATUS.KILL : SHOT_STATUS.HIT,
        );
        assert.equal(confirmed.damage, expectedDamage);
        assert.equal(confirmed.weaponNetId, rules.weaponNetId);
        assert.equal(target.health, expectedHealth);
        assert.equal(shooter.combat.ammo, rules.magSize - 1);
        assert.equal(shooter.combat.reserveAmmo, rules.reserveAmmo);

        // One tick later is too soon for every current weapon. The server must
        // reject the request without consuming another round.
        queueShot(weaponWorld, { inputSeq: 2, shotSeq: 2 });
        weaponWorld.step();
        const [cooldown] = weaponWorld.drainCombatEvents();
        assert.equal(cooldown.status, SHOT_STATUS.REJECTED_COOLDOWN);
        assert.equal(shooter.combat.ammo, rules.magSize - 1);

        assert.deepEqual(weaponWorld.submitReload(1, 1), { ok: true, started: true });
        stepMany(weaponWorld, rules.reloadTicks - 1);
        assert.equal(shooter.combat.ammo, rules.magSize - 1, "reload completed early");
        weaponWorld.step();
        assert.equal(shooter.combat.ammo, rules.magSize);
        assert.equal(shooter.combat.reserveAmmo, rules.reserveAmmo - 1);

        const otherWeaponNetId = rules.weaponNetId === WEAPON_NET_IDS["ARC-7"]
          ? WEAPON_NET_IDS.VESPER
          : WEAPON_NET_IDS["ARC-7"];
        assert.equal(
          weaponWorld.enterGame(shooter.id, otherWeaponNetId),
          false,
          "a client must not hot-swap its server weapon after spawning",
        );
      } finally {
        weaponWorld.dispose();
      }
    });
  }
});

test("packet flooding cannot bypass any weapon's fire interval", async (t) => {
  for (const [weaponId, rules] of Object.entries(WEAPON_RULES)) {
    await t.test(weaponId, () => {
      const floodWorld = new AuthoritativeWorld(colliderSource, {
        combat: { random: () => 0.5 },
      });
      try {
        const { shooter, target } = addDuel(floodWorld, rules.weaponNetId);
        assert.equal(floodWorld.submitInput(1, {
          seq: 1,
          mask: 0,
          yaw: 0,
          pitch: 0,
        }).ok, true);

        for (let shotSeq = 1; shotSeq <= 1000; shotSeq += 1) {
          floodWorld.submitShot(1, {
            shotSeq,
            inputSeq: 1,
            rewindTick: floodWorld.tickNumber,
            yaw: 0,
            pitch: 0,
            weaponNetId: WEAPON_NET_IDS.RECON,
            damage: 255,
          }, 1);
        }
        floodWorld.step();

        const results = floodWorld.drainCombatEvents();
        const confirmed = results.filter((result) => (
          result.status === SHOT_STATUS.HIT || result.status === SHOT_STATUS.KILL
        ));
        assert.equal(confirmed.length, 1);
        assert.equal(shooter.combat.ammo, rules.magSize - 1);
        assert.equal(
          target.health,
          Math.max(0, 100 - Math.round(rules.damage * 2)),
        );
      } finally {
        floodWorld.dispose();
      }
    });
  }
});

test("unlinked aim, non-finite values, and future rewinds are rejected at the world boundary", () => {
  const { target } = addDuel(world);
  assert.equal(world.submitInput(1, { seq: 1, mask: 0, yaw: 0, pitch: 0 }).ok, true);

  const forgedAim = world.submitShot(1, {
    shotSeq: 1,
    inputSeq: 1,
    rewindTick: world.tickNumber,
    yaw: 1,
    pitch: 0,
  });
  assert.equal(forgedAim.ok, false);
  assert.equal(forgedAim.reason, "aim-link");

  const nonFinite = world.submitShot(1, {
    shotSeq: 2,
    inputSeq: 1,
    rewindTick: world.tickNumber,
    yaw: Number.NaN,
    pitch: 0,
  });
  assert.deepEqual(nonFinite, { ok: false, reason: "malformed" });

  const future = world.submitShot(1, {
    shotSeq: 2,
    inputSeq: 1,
    rewindTick: world.tickNumber + 1,
    yaw: 0,
    pitch: 0,
  });
  assert.equal(future.ok, false);
  assert.equal(future.reason, "rewind");
  assert.equal(target.health, 100);
});

test("spawn protection is decided by the server and cannot be bypassed by a shot request", () => {
  const shooter = world.addPlayer(1);
  const target = world.addPlayer(2);
  world.enterGame(1, AUTHORITATIVE_PISTOL_NET_ID);
  world.enterGame(2, AUTHORITATIVE_PISTOL_NET_ID);
  target.physics.teleport(
    target.rig,
    shooter.rig.position.x,
    shooter.rig.position.y,
    shooter.rig.position.z - 5,
  );
  world.step();

  queueShot(world, { inputSeq: 1, shotSeq: 1 });
  world.step();
  const [result] = world.drainCombatEvents();
  assert.equal(result.status, SHOT_STATUS.REJECTED_PROTECTED);
  assert.equal(target.health, 100);
  assert.equal(shooter.combat.ammo, PISTOL_RULES.magSize - 1);
});

test("claimed targets and damage fields have no authority", () => {
  const { target } = addDuel(world);
  target.physics.teleport(
    target.rig,
    target.rig.position.x + 5,
    target.rig.position.y,
    target.rig.position.z,
  );
  world.step();

  assert.equal(world.submitInput(1, { seq: 1, mask: 0, yaw: 0, pitch: 0 }).ok, true);
  assert.equal(world.submitShot(1, {
    shotSeq: 1,
    inputSeq: 1,
    rewindTick: world.tickNumber,
    yaw: 0,
    pitch: 0,
    targetId: target.id,
    damage: 255,
    zone: HIT_ZONE.HEAD,
    origin: { x: target.rig.position.x, y: target.rig.position.y, z: target.rig.position.z },
  }).ok, true);
  world.step();

  const [result] = world.drainCombatEvents();
  assert.equal(result.status, SHOT_STATUS.MISS);
  assert.equal(target.health, 100);
});

test("the authoritative map blocks a target placed behind a real wall", () => {
  const { shooter, target } = addDuel(world);

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.near = 0.05;
  raycaster.far = 50;
  const cardinalDirections = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  const wall = cardinalDirections
    .map((direction) => {
      raycaster.set(shooter.rig.position, direction);
      const hit = raycaster.intersectObjects(colliderSource.raycastColliders, false)[0];
      return hit && hit.distance > 0.75 ? { direction, distance: hit.distance } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)[0];

  assert.ok(wall, "spawn must have a real cardinal wall for the occlusion test");
  target.physics.teleport(
    target.rig,
    shooter.rig.position.x + wall.direction.x * (wall.distance + 2),
    shooter.rig.position.y,
    shooter.rig.position.z + wall.direction.z * (wall.distance + 2),
  );
  world.step();

  const yawTowardWall = Math.atan2(-wall.direction.x, -wall.direction.z);
  queueShot(world, {
    inputSeq: 1,
    shotSeq: 1,
    yaw: yawTowardWall,
  });
  world.step();

  const [result] = world.drainCombatEvents();
  assert.equal(result.status, SHOT_STATUS.MISS);
  assert.equal(target.health, 100, "a wall-occluded player must not take damage");
});

test("a rapid-fire packet flood consumes one round and resolves at most one hit", () => {
  const { shooter, target } = addDuel(world);
  assert.equal(world.submitInput(1, { seq: 1, mask: 0, yaw: 0, pitch: 0 }).ok, true);

  for (let shot = 1; shot <= 1000; shot += 1) {
    world.submitShot(1, {
      shotSeq: shot,
      inputSeq: 1,
      rewindTick: world.tickNumber,
      yaw: 0,
      pitch: 0,
    }, 1);
  }
  world.step();

  const results = world.drainCombatEvents();
  assert.equal(shooter.combat.ammo, PISTOL_RULES.magSize - 1);
  assert.equal(target.health, 40);
  assert.equal(
    results.filter((result) => result.status === SHOT_STATUS.HIT).length,
    1,
  );
});

test("ammo cannot go negative and reload timing is server-owned", () => {
  const shooter = world.addPlayer(1);
  world.enterGame(1, AUTHORITATIVE_PISTOL_NET_ID);
  stepMany(world, 180);

  for (let shot = 1; shot <= PISTOL_RULES.magSize; shot += 1) {
    queueShot(world, { inputSeq: shot, shotSeq: shot });
    world.step();
    stepMany(world, PISTOL_RULES.fireIntervalTicks - 1);
  }
  world.drainCombatEvents();
  assert.equal(shooter.combat.ammo, 0);

  queueShot(world, {
    inputSeq: PISTOL_RULES.magSize + 1,
    shotSeq: PISTOL_RULES.magSize + 1,
  });
  world.step();
  const [emptyResult] = world.drainCombatEvents();
  assert.equal(emptyResult.status, SHOT_STATUS.REJECTED_AMMO);
  assert.equal(shooter.combat.ammo, 0);

  assert.deepEqual(world.submitReload(1, 1), { ok: true, started: true });
  const authoritativeReloadEnd = shooter.combat.reloadEndTick;
  for (let requestSeq = 2; requestSeq <= 30; requestSeq += 1) {
    world.submitReload(1, requestSeq);
  }
  assert.equal(
    shooter.combat.reloadEndTick,
    authoritativeReloadEnd,
    "reload-request spam must not shorten the server timer",
  );
  stepMany(world, PISTOL_RULES.reloadTicks - 1);
  assert.equal(shooter.combat.ammo, 0, "reload must not complete early");
  world.step();
  assert.equal(shooter.combat.ammo, PISTOL_RULES.magSize);
  assert.equal(
    shooter.combat.reserveAmmo,
    PISTOL_RULES.reserveAmmo - PISTOL_RULES.magSize,
  );
});

test("lag compensation hits a recent historical position but rejects stale rewinds", () => {
  const { shooter, target } = addDuel(world);
  const visibleTick = world.tickNumber;
  const historicalPosition = target.rig.position.clone();

  target.physics.teleport(
    target.rig,
    historicalPosition.x + 5,
    historicalPosition.y,
    historicalPosition.z,
  );
  stepMany(world, 12); // 200 ms of simulated network/interpolation delay

  queueShot(world, {
    inputSeq: 1,
    shotSeq: 1,
    rewindTick: visibleTick,
  });
  world.step();
  const [rewoundHit] = world.drainCombatEvents();
  assert.equal(rewoundHit.status, SHOT_STATUS.HIT);
  assert.equal(target.health, 40);

  stepMany(world, PISTOL_RULES.fireIntervalTicks);
  assert.equal(world.submitInput(1, { seq: 2, mask: 0, yaw: 0, pitch: 0 }).ok, true);
  const stale = world.submitShot(1, {
    shotSeq: 2,
    inputSeq: 2,
    rewindTick: world.tickNumber - COMBAT_RULES.maxRewindTicks - 1,
    yaw: 0,
    pitch: 0,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "rewind");
  const [staleResult] = world.drainCombatEvents();
  assert.equal(staleResult.status, SHOT_STATUS.REJECTED_STALE);
});

test("death locks movement and the server performs a fresh-life respawn", () => {
  const { target } = addDuel(world);
  const firstLife = target.combat.lifeId;

  queueShot(world, { inputSeq: 1, shotSeq: 1 });
  world.step();
  stepMany(world, PISTOL_RULES.fireIntervalTicks);
  queueShot(world, { inputSeq: 2, shotSeq: 2 });
  world.step();
  world.drainCombatEvents();

  assert.equal(target.health, 0);
  const deadPosition = target.rig.position.clone();
  world.submitInput(2, { seq: 1, mask: 1, yaw: 0, pitch: 0 });
  stepMany(world, 30);
  assert.ok(target.rig.position.distanceTo(deadPosition) < 1e-9);

  stepMany(world, COMBAT_RULES.respawnTicks - 30);
  assert.equal(target.health, 100);
  assert.notEqual(target.combat.lifeId, firstLife);
  assert.equal(target.combat.ammo, PISTOL_RULES.magSize);
  assert.ok(target.combat.invulnerableUntilTick > world.tickNumber);
});

test("two live clients receive server-confirmed rifle damage while forged and rapid packets fail", async () => {
  const liveRules = WEAPON_RULES["ARC-7"];
  const liveWorld = new AuthoritativeWorld(colliderSource, { combat: { random: () => 0.5 } });
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world: liveWorld,
  });
  let shooter;
  let target;

  try {
    const address = await app.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/game`;
    [shooter, target] = await Promise.all([
      connectCombatClient(socketUrl, origin),
      connectCombatClient(socketUrl, origin),
    ]);
    shooter.ws.send(packNormalMatchJoinRequest());
    target.ws.send(packNormalMatchJoinRequest());
    shooter.ws.send(packEnterGame(liveRules.weaponNetId));
    target.ws.send(packEnterGame(liveRules.weaponNetId));

    await waitUntil(() => shooter.state?.players.length === 2 && target.state?.players.length === 2);
    await delay(1100); // server-owned one-second spawn shield

    const serverShooter = liveWorld.getPlayer(shooter.id);
    const serverTarget = liveWorld.getPlayer(target.id);
    serverTarget.physics.teleport(
      serverTarget.rig,
      serverShooter.rig.position.x,
      serverShooter.rig.position.y,
      serverShooter.rig.position.z - 5,
    );
    await delay(60);

    shooter.ws.send(packInputCommand({ seq: 1, mask: 0, yaw: 0, pitch: 0 }));
    shooter.ws.send(packShotRequest({
      shotSeq: 1,
      inputSeq: 1,
      rewindTick: shooter.state.tick,
      yaw: 0,
      pitch: 0,
    }));

    const confirmed = await waitUntil(() => shooter.hits.find((hit) => hit.shotSeq === 1));
    assert.equal(confirmed.status, SHOT_STATUS.HIT);
    const zoneMultiplier = confirmed.zone === HIT_ZONE.HEAD
      ? 2
      : confirmed.zone === HIT_ZONE.LEGS ? 0.75 : 1;
    assert.equal(confirmed.damage, Math.round(liveRules.damage * zoneMultiplier));
    assert.equal(confirmed.weaponNetId, liveRules.weaponNetId);
    assert.equal(confirmed.ammo, liveRules.magSize - 1);
    const confirmedTargetHealth = 100 - confirmed.damage;
    await waitUntil(
      () => target.state.players.find((p) => p.id === target.id)?.health === confirmedTargetHealth,
    );

    // Hold the authoritative cooldown open while the forged burst is sent so
    // test timing cannot accidentally turn a later packet into a legal shot.
    serverShooter.combat.nextFireTick = liveWorld.tickNumber + liveRules.fireIntervalTicks + 20;

    const forged = Buffer.alloc(SHOT_BYTES + 16);
    forged.writeUInt8(MSG.SHOT, 0);
    forged.writeUInt8(PROTOCOL_VERSION, 1);
    forged.writeUInt16LE(target.id, 12);
    forged.writeUInt8(255, 18);
    shooter.ws.send(forged);

    for (let nextShot = 2; nextShot <= 7; nextShot += 1) {
      shooter.ws.send(packShotRequest({
        shotSeq: nextShot,
        inputSeq: 1,
        rewindTick: shooter.state.tick,
        yaw: 0,
        pitch: 0,
      }));
    }
    await delay(180);

    const targetAfterAttacks = target.state.players.find((p) => p.id === target.id);
    assert.equal(targetAfterAttacks.health, confirmedTargetHealth);
    assert.equal(shooter.state.weaponNetId, liveRules.weaponNetId);
    assert.equal(shooter.state.ammo, liveRules.magSize - 1);
  } finally {
    shooter?.ws.close(1000);
    target?.ws.close(1000);
    await delay(30);
    await app.stop();
    liveWorld.dispose();
  }
});
