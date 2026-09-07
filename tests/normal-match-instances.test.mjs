import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  packNormalMatchJoinRequest,
  parseNormalMatchAssignedFrame,
  parseRoomErrorFrame,
} from "../js/network.js";
import {
  FEATURE_FLAGS,
  MSG,
  NORMAL_MATCH_MAX_PLAYERS,
  PROTOCOL_VERSION,
  ROOM_ERROR,
  STATE_HEADER_BYTES,
  STATE_PLAYER_BYTES,
  TEAM,
} from "../js/protocol.js";
import { AuthoritativeWorld } from "../server/authoritativeWorld.js";
import { loadAuthoritativeCollision } from "../server/mapCollision.js";
import { NormalMatchManager } from "../server/normalMatches.js";
import {
  createPotSparkServer,
  decodeNormalMatchJoinFrame,
  packNormalMatchAssignedFrame,
} from "../server/runtime.js";
import { createAuthenticatedSocket } from "./helpers/match-client.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");

let colliderSource;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for normal-match state");
}

function arrayBufferFromNodeBuffer(frame) {
  return Uint8Array.from(frame).buffer;
}

function packEnterGame(weaponNetId = 1) {
  const frame = Buffer.alloc(4);
  frame.writeUInt8(MSG.ENTER_GAME, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(weaponNetId, 2);
  frame.writeUInt8(0, 3);
  return frame;
}

function parseStatePlayerIds(frame) {
  if (frame.readUInt8(0) !== MSG.STATE) return null;
  const count = frame.readUInt16LE(10);
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(frame.readUInt16LE(STATE_HEADER_BYTES + index * STATE_PLAYER_BYTES));
  }
  return ids;
}

async function connectMatchClient(webSocketUrl, origin) {
  const { ws } = await createAuthenticatedSocket(webSocketUrl, origin);
  return new Promise((resolve, reject) => {
    const client = {
      ws,
      id: null,
      welcomeFeatures: 0,
      assignment: null,
      errors: [],
      statePlayerIds: null,
    };

    ws.once("error", reject);
    ws.on("message", (data) => {
      const frame = Buffer.from(data);
      const opcode = frame.readUInt8(0);
      if (opcode === MSG.WELCOME) {
        client.id = frame.readUInt16LE(2);
        client.welcomeFeatures = frame.readUInt16LE(6);
        resolve(client);
        return;
      }

      const buffer = arrayBufferFromNodeBuffer(frame);
      const view = new DataView(buffer);
      if (opcode === MSG.NORMAL_MATCH_ASSIGNED) {
        client.assignment = parseNormalMatchAssignedFrame(view, buffer);
      } else if (opcode === MSG.ROOM_ERROR) {
        const error = parseRoomErrorFrame(view, buffer);
        if (error) client.errors.push(error);
      } else if (opcode === MSG.STATE) {
        client.statePlayerIds = parseStatePlayerIds(frame);
      }
    });
  });
}

before(async () => {
  ({ colliderSource } = await loadAuthoritativeCollision(MAP_PATH));
});

after(() => {
  colliderSource?.disposeColliders();
});

test("normal matches fill 5v5, seal at ten, and roll over repeatedly", () => {
  const manager = new NormalMatchManager();
  const assignments = [];
  for (let playerId = 1; playerId <= 21; playerId += 1) {
    assignments.push(manager.joinMatch(playerId));
  }

  const instanceIds = [...new Set(assignments.map((entry) => entry.match.id))];
  assert.equal(instanceIds.length, 3);
  assert.deepEqual(
    instanceIds.map((id) => manager.getMatch(id).members.size),
    [10, 10, 1],
  );

  for (const id of instanceIds.slice(0, 2)) {
    const match = manager.getMatch(id);
    assert.equal(match.sealed, true);
    assert.equal(manager.teamCount(match, TEAM.CRAZIES), 5);
    assert.equal(manager.teamCount(match, TEAM.MADDIES), 5);
  }
  assert.equal(manager.getMatch(instanceIds[2]).sealed, false);
  assert.equal(new Set(instanceIds.map((id) => manager.getMatch(id).scopeKey)).size, 3);
});

test("duplicate joins are idempotent and sealed matches never reopen", () => {
  const manager = new NormalMatchManager();
  const first = manager.joinMatch(1);
  const duplicate = manager.joinMatch(1);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.match.id, first.match.id);
  assert.equal(first.match.members.size, 1);

  for (let playerId = 2; playerId <= 10; playerId += 1) manager.joinMatch(playerId);
  assert.equal(first.match.sealed, true);
  manager.disconnectPlayer(1);
  assert.equal(first.match.members.size, 9);

  const overflow = manager.joinMatch(11);
  assert.notEqual(overflow.match.id, first.match.id);
  assert.equal(first.match.members.size, 9, "a disconnect must not reopen a sealed match");
  assert.equal(overflow.match.members.size, 1);
});

test("normal-match wire frames have exact lengths and reserved bytes", () => {
  const request = Buffer.from(packNormalMatchJoinRequest());
  assert.deepEqual(decodeNormalMatchJoinFrame(request), { ok: true });
  assert.equal(
    decodeNormalMatchJoinFrame(Buffer.concat([request, Buffer.from([0])])).ok,
    false,
  );
  request.writeUInt8(1, 3);
  assert.equal(decodeNormalMatchJoinFrame(request).reason, "reserved");

  const manager = new NormalMatchManager();
  const joined = manager.joinMatch(7);
  const packed = packNormalMatchAssignedFrame(
    manager.snapshot(joined.match),
    joined.member,
  );
  const buffer = arrayBufferFromNodeBuffer(packed);
  const parsed = parseNormalMatchAssignedFrame(new DataView(buffer), buffer);
  assert.deepEqual(parsed, {
    id: joined.match.id,
    team: TEAM.CRAZIES,
    playerCount: 1,
    maxPlayers: NORMAL_MATCH_MAX_PLAYERS,
    sealed: false,
  });

  packed.writeUInt8(9, 8);
  const malformed = arrayBufferFromNodeBuffer(packed);
  assert.equal(parseNormalMatchAssignedFrame(new DataView(malformed), malformed), null);
});

test("live server isolates a full 5v5 instance and sends player eleven onward", async () => {
  const world = new AuthoritativeWorld(colliderSource);
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world,
  });
  const clients = [];

  try {
    const address = await app.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/game`;
    clients.push(...await Promise.all(
      Array.from({ length: 12 }, () => connectMatchClient(socketUrl, origin)),
    ));
    assert.ok(clients[0].welcomeFeatures & FEATURE_FLAGS.NORMAL_MATCH_INSTANCES);

    const unassigned = clients[11];
    unassigned.ws.send(packEnterGame());
    await waitUntil(() => unassigned.errors.some(
      (error) => error.code === ROOM_ERROR.MATCHMAKING_REQUIRED,
    ));
    assert.equal(world.getPlayer(unassigned.id).inGame, false);

    for (const client of clients.slice(0, 11)) {
      client.ws.send(packNormalMatchJoinRequest());
    }
    await waitUntil(() => clients.slice(0, 11).every((client) => client.assignment));

    const firstInstanceId = clients[0].assignment.id;
    const secondInstanceId = clients[10].assignment.id;
    assert.ok(clients.slice(0, 10).every(
      (client) => client.assignment.id === firstInstanceId,
    ));
    assert.notEqual(secondInstanceId, firstInstanceId);
    assert.deepEqual(
      clients.slice(0, 10).map((client) => client.assignment.team),
      [
        TEAM.CRAZIES,
        TEAM.MADDIES,
        TEAM.CRAZIES,
        TEAM.MADDIES,
        TEAM.CRAZIES,
        TEAM.MADDIES,
        TEAM.CRAZIES,
        TEAM.MADDIES,
        TEAM.CRAZIES,
        TEAM.MADDIES,
      ],
    );

    for (const client of clients.slice(0, 11)) client.ws.send(packEnterGame());
    await waitUntil(() => clients.slice(0, 11).every(
      (client) => world.getPlayer(client.id)?.inGame,
    ));
    await waitUntil(() => clients[0].statePlayerIds?.length === 10);
    await waitUntil(() => clients[10].statePlayerIds?.length === 1);
    assert.deepEqual(
      new Set(clients[0].statePlayerIds),
      new Set(clients.slice(0, 10).map((client) => client.id)),
    );
    assert.deepEqual(clients[10].statePlayerIds, [clients[10].id]);

    clients[0].ws.close(1000);
    await waitUntil(() => app.normalMatches.getMatch(firstInstanceId)?.members.size === 9);
    unassigned.ws.send(packNormalMatchJoinRequest());
    await waitUntil(() => unassigned.assignment);
    assert.equal(unassigned.assignment.id, secondInstanceId);
    assert.notEqual(unassigned.assignment.id, firstInstanceId);

    unassigned.ws.send(packEnterGame());
    await waitUntil(() => world.getPlayer(unassigned.id)?.inGame);
    await waitUntil(() => clients[10].statePlayerIds?.length === 2);
    assert.deepEqual(
      new Set(clients[10].statePlayerIds),
      new Set([clients[10].id, unassigned.id]),
    );
  } finally {
    for (const client of clients) client.ws.close(1000);
    await delay(30);
    await app.stop();
    world.dispose();
  }
});
