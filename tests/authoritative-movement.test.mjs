import assert from "node:assert/strict";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";

import * as THREE from "three";
import WebSocket from "ws";

import { CharacterPhysics } from "../js/physics.js";
import { packInputCommand, packNormalMatchJoinRequest } from "../js/network.js";
import {
  INPUT_BYTES,
  INPUT_MASK,
  MSG,
  PROTOCOL_VERSION,
  SIMULATION_DT,
  STATE_HEADER_BYTES,
  STATE_PLAYER_BYTES,
  inputMaskToKeys,
  movementSpeedForNetId,
} from "../js/protocol.js";
import { AuthoritativeWorld, SPAWN_POINT } from "../server/authoritativeWorld.js";
import { loadAuthoritativeCollision } from "../server/mapCollision.js";
import { createPotSparkServer, decodeInputFrame } from "../server/runtime.js";
import { createAuthenticatedSocket } from "./helpers/match-client.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");

let colliderSource;
let world;

function settle(controller, rig, frames = 180) {
  for (let i = 0; i < frames; i += 1) {
    controller.update(SIMULATION_DT, {}, rig, 7.5, 0);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packEnterGame(weaponNetId = 1) {
  const frame = Buffer.alloc(4);
  frame.writeUInt8(MSG.ENTER_GAME, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(weaponNetId, 2);
  return frame;
}

function parseStateBuffer(frame) {
  if (frame.readUInt8(0) !== MSG.STATE) return null;
  const count = frame.readUInt16LE(10);
  const players = [];
  for (let index = 0; index < count; index += 1) {
    const offset = STATE_HEADER_BYTES + index * STATE_PLAYER_BYTES;
    players.push({
      id: frame.readUInt16LE(offset),
      health: frame.readUInt8(offset + 3),
      x: frame.readFloatLE(offset + 8),
      y: frame.readFloatLE(offset + 12),
      z: frame.readFloatLE(offset + 16),
    });
  }
  return {
    tick: frame.readUInt32LE(2),
    ack: frame.readUInt32LE(6),
    combat: {
      ammo: frame.readUInt16LE(12),
      reserveAmmo: frame.readUInt16LE(14),
      flags: frame.readUInt8(20),
    },
    players,
  };
}

function expectOriginRejected(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl, { origin: "https://evil.example" });
    ws.once("open", () => reject(new Error("cross-origin socket unexpectedly opened")));
    ws.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      ws.terminate();
    });
    ws.once("error", () => {});
  });
}

async function connectTestClient(webSocketUrl, origin) {
  const { ws } = await createAuthenticatedSocket(webSocketUrl, origin);
  return new Promise((resolve, reject) => {
    const client = { ws, id: null, state: null };
    ws.once("error", reject);
    ws.on("message", (data) => {
      const frame = Buffer.from(data);
      if (frame.readUInt8(0) === MSG.WELCOME) {
        client.id = frame.readUInt16LE(2);
        resolve(client);
        return;
      }
      client.state = parseStateBuffer(frame) || client.state;
    });
  });
}

before(async () => {
  ({ colliderSource } = await loadAuthoritativeCollision(MAP_PATH));
});

beforeEach(() => {
  world = new AuthoritativeWorld(colliderSource);
});

afterEach(() => {
  world?.dispose();
  world = null;
});

after(() => {
  colliderSource?.disposeColliders();
});

test("movement frames cannot encode client position or elapsed time", () => {
  const frame = packInputCommand({
    seq: 7,
    mask: INPUT_MASK.FORWARD | INPUT_MASK.SPRINT,
    yaw: 0.25,
    pitch: -0.1,
    x: 999_999,
    y: 999_999,
    z: 999_999,
    timestamp: Number.MAX_VALUE,
  });

  assert.equal(frame.byteLength, INPUT_BYTES);
  const decoded = decodeInputFrame(Buffer.from(frame));
  assert.equal(decoded.ok, true);
  assert.deepEqual(Object.keys(decoded.command).sort(), ["mask", "pitch", "seq", "yaw"]);

  const legacyPositionPacket = Buffer.alloc(36);
  legacyPositionPacket.writeUInt8(MSG.INPUT, 0);
  legacyPositionPacket.writeUInt8(PROTOCOL_VERSION, 1);
  assert.deepEqual(decodeInputFrame(legacyPositionPacket), { ok: false, reason: "length" });
});

test("non-finite rotations and malformed protocol versions are rejected", () => {
  const frame = Buffer.from(packInputCommand({ seq: 1, mask: 0, yaw: 0, pitch: 0 }));
  frame.writeFloatLE(Number.NaN, 8);
  assert.deepEqual(decodeInputFrame(frame), { ok: false, reason: "non-finite" });

  const wrongVersion = Buffer.from(packInputCommand({ seq: 1, mask: 0, yaw: 0, pitch: 0 }));
  wrongVersion.writeUInt8(PROTOCOL_VERSION + 1, 1);
  assert.deepEqual(decodeInputFrame(wrongVersion), { ok: false, reason: "version" });
});

test("join and respawn use the requested authoritative spawn point", () => {
  assert.deepEqual(SPAWN_POINT, { x: -101.03, y: -16.60, z: -30.00 });

  const player = world.addPlayer(1);
  assert.deepEqual(player.rig.position.toArray(), [-101.03, -16.60, -30.00]);
  assert.equal(world.enterGame(1, 1), true);
  assert.deepEqual(player.rig.position.toArray(), [-101.03, -16.60, -30.00]);

  player.rig.position.set(50, 50, 50);
  assert.equal(world.respawnPlayer(player), true);
  assert.deepEqual(player.rig.position.toArray(), [-101.03, -16.60, -30.00]);
});

test("a packet flood still produces only one authoritative movement step", () => {
  const controlWorld = new AuthoritativeWorld(colliderSource);
  try {
    const flooded = world.addPlayer(1);
    const control = controlWorld.addPlayer(1);
    assert.equal(world.enterGame(1, 2), true);
    assert.equal(controlWorld.enterGame(1, 2), true);

    for (let i = 0; i < 180; i += 1) {
      world.step();
      controlWorld.step();
    }

    for (let seq = 1; seq <= 1000; seq += 1) {
      world.submitInput(1, {
        seq,
        mask: INPUT_MASK.FORWARD | INPUT_MASK.SPRINT,
        yaw: 0,
        pitch: 0,
      }, 1);
    }
    controlWorld.submitInput(1, {
      seq: 1,
      mask: INPUT_MASK.FORWARD | INPUT_MASK.SPRINT,
      yaw: 0,
      pitch: 0,
    }, 1);

    world.step();
    controlWorld.step();

    assert.ok(
      flooded.rig.position.distanceTo(control.rig.position) < 1e-9,
      "1000 inputs before one tick must not move farther than one input",
    );
    assert.ok(
      Math.hypot(
        flooded.rig.position.x - SPAWN_POINT.x,
        flooded.rig.position.z - SPAWN_POINT.z,
      ) < 0.25,
      "one 60 Hz step must remain below the configured speed budget",
    );
  } finally {
    controlWorld.dispose();
  }
});

test("extra teleport fields are ignored even when calling the world boundary directly", () => {
  const player = world.addPlayer(1);
  world.enterGame(1, 1);
  for (let i = 0; i < 180; i += 1) world.step();

  const before = player.rig.position.clone();
  const result = world.submitInput(1, {
    seq: 1,
    mask: INPUT_MASK.FORWARD,
    yaw: 0,
    pitch: 0,
    x: 1_000_000,
    y: 1_000_000,
    z: 1_000_000,
  });
  assert.equal(result.ok, true);
  world.step();
  assert.ok(player.rig.position.distanceTo(before) < 0.2);
});

test("authoritative restore plus pending-input replay matches uninterrupted prediction", () => {
  const baselinePhysics = new CharacterPhysics().useSharedColliders(colliderSource);
  const replayPhysics = new CharacterPhysics().useSharedColliders(colliderSource);
  const serverPhysics = new CharacterPhysics().useSharedColliders(colliderSource);
  const baselineRig = new THREE.Object3D();
  const replayRig = new THREE.Object3D();
  const serverRig = new THREE.Object3D();
  const controllers = [baselinePhysics, replayPhysics, serverPhysics];
  const rigs = [baselineRig, replayRig, serverRig];
  for (let i = 0; i < controllers.length; i += 1) {
    controllers[i].teleport(rigs[i], SPAWN_POINT.x, SPAWN_POINT.y, SPAWN_POINT.z);
    settle(controllers[i], rigs[i]);
  }

  const commands = Array.from({ length: 60 }, (_, index) => ({
    seq: index + 1,
    mask: INPUT_MASK.RIGHT | (index < 25 ? INPUT_MASK.SPRINT : 0),
    yaw: -0.35,
    pitch: 0,
  }));
  const keys = {};
  const speed = movementSpeedForNetId(1);
  for (const command of commands) {
    inputMaskToKeys(command.mask, keys);
    baselinePhysics.update(SIMULATION_DT, keys, baselineRig, speed, command.yaw);
    replayPhysics.update(SIMULATION_DT, keys, replayRig, speed, command.yaw);
    if (command.seq <= 30) {
      serverPhysics.update(SIMULATION_DT, keys, serverRig, speed, command.yaw);
    }
  }

  const authoritativeAt30 = serverPhysics.captureState(serverRig);
  replayPhysics.restoreState(replayRig, authoritativeAt30);
  for (const command of commands.slice(30)) {
    inputMaskToKeys(command.mask, keys);
    replayPhysics.update(SIMULATION_DT, keys, replayRig, speed, command.yaw);
  }

  assert.ok(replayRig.position.distanceTo(baselineRig.position) < 1e-9);
  assert.ok(Math.abs(replayPhysics.velX - baselinePhysics.velX) < 1e-9);
  assert.ok(Math.abs(replayPhysics.velZ - baselinePhysics.velZ) < 1e-9);

  for (const controller of controllers) controller.disposeColliders();
});

test("the HTTP server exposes game assets but not source-side secrets", async () => {
  const serverWorld = new AuthoritativeWorld(colliderSource);
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world: serverWorld,
  });

  try {
    const address = await app.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [mainModule, serverSource, packageFile, backupFile, mapHead] = await Promise.all([
      fetch(`${baseUrl}/js/main.js`),
      fetch(`${baseUrl}/server.js`),
      fetch(`${baseUrl}/package.json`),
      fetch(`${baseUrl}/js/main.js.bak`),
      fetch(`${baseUrl}/assets/models/map_1.glb`, { method: "HEAD" }),
    ]);

    assert.equal(mainModule.status, 200);
    assert.equal(serverSource.status, 404);
    assert.equal(packageFile.status, 404);
    assert.equal(backupFile.status, 404);
    assert.equal(mapHead.status, 200);
    assert.equal(mapHead.headers.get("cache-control"), "public, max-age=86400");
    const contentSecurityPolicy = mainModule.headers.get("content-security-policy") || "";
    assert.match(contentSecurityPolicy, /object-src 'none'/);
    assert.match(
      contentSecurityPolicy,
      /connect-src[^;]*blob:/,
      "embedded GLB textures require same-document blob fetches",
    );
  } finally {
    await app.stop();
    serverWorld.dispose();
  }
});

test("two live clients receive authoritative snapshots and acknowledgements", async () => {
  const serverWorld = new AuthoritativeWorld(colliderSource);
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world: serverWorld,
  });
  let movingClient;
  let idleClient;

  try {
    const address = await app.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/game`;
    assert.equal(await expectOriginRejected(socketUrl), 403);
    [movingClient, idleClient] = await Promise.all([
      connectTestClient(socketUrl, origin),
      connectTestClient(socketUrl, origin),
    ]);
    movingClient.ws.send(packNormalMatchJoinRequest());
    idleClient.ws.send(packNormalMatchJoinRequest());
    movingClient.ws.send(packEnterGame(1));
    idleClient.ws.send(packEnterGame(1));

    let sequence = 1;
    idleClient.ws.send(packInputCommand({ seq: 1, mask: 0, yaw: 0, pitch: 0 }));
    const movementTimer = setInterval(() => {
      movingClient.ws.send(packInputCommand({
        seq: sequence++,
        mask: INPUT_MASK.FORWARD | INPUT_MASK.SPRINT,
        yaw: 0,
        pitch: 0,
      }));
    }, 17);
    await delay(700);
    clearInterval(movementTimer);
    movingClient.ws.send(packInputCommand({ seq: sequence++, mask: 0, yaw: 0, pitch: 0 }));
    await delay(300);

    assert.ok(movingClient.state && idleClient.state, "both clients should receive snapshots");
    assert.equal(movingClient.state.players.length, 2);
    assert.equal(idleClient.state.players.length, 2);
    assert.ok(movingClient.state.ack > 10, "server should acknowledge processed commands");

    const movedState = movingClient.state.players.find((player) => player.id === movingClient.id);
    const idleState = idleClient.state.players.find((player) => player.id === idleClient.id);
    const movedDistance = Math.hypot(movedState.x - SPAWN_POINT.x, movedState.z - SPAWN_POINT.z);
    const idleDistance = Math.hypot(idleState.x - SPAWN_POINT.x, idleState.z - SPAWN_POINT.z);
    assert.ok(movedDistance > 0.1 && movedDistance < 9, `unexpected move distance ${movedDistance}`);
    assert.ok(idleDistance < 0.05, `idle player drifted ${idleDistance}`);

    const forgedShot = Buffer.alloc(40);
    forgedShot.writeUInt8(MSG.SHOT, 0);
    forgedShot.writeUInt8(PROTOCOL_VERSION, 1);
    forgedShot.writeUInt16LE(idleClient.id, 13);
    movingClient.ws.send(forgedShot);
    await delay(100);
    const idleAfterShot = movingClient.state.players.find((player) => player.id === idleClient.id);
    assert.equal(idleAfterShot.health, 100, "client-created shot packets must not deal damage");
  } finally {
    movingClient?.ws.close(1000);
    idleClient?.ws.close(1000);
    await delay(30);
    await app.stop();
    serverWorld.dispose();
  }
});
