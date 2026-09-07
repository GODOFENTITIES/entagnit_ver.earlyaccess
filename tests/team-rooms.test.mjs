import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  createTeamRoom,
  packRoomCreateRequest,
  packRoomJoinRequest,
  packNormalMatchJoinRequest,
  packRoomReadyRequest,
  packRoomTeamSwitchRequest,
  parseMatchStartFrame,
  parseNormalMatchAssignedFrame,
  parseRoomErrorFrame,
  parseRoomStateFrame,
} from "../js/network.js";
import {
  FEATURE_FLAGS,
  MSG,
  PROTOCOL_VERSION,
  ROOM_ERROR,
  ROOM_PHASE,
  TEAM,
} from "../js/protocol.js";
import { AuthoritativeWorld } from "../server/authoritativeWorld.js";
import { loadAuthoritativeCollision } from "../server/mapCollision.js";
import {
  createPotSparkServer,
  decodeRoomCreateFrame,
  decodeRoomJoinFrame,
  decodeRoomReadyFrame,
  decodeRoomTeamSwitchFrame,
} from "../server/runtime.js";
import { TeamRoomManager } from "../server/teamRooms.js";
import { createAuthenticatedSocket } from "./helpers/match-client.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");

let colliderSource;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for team-room state");
}

function arrayBufferFromNodeBuffer(frame) {
  return Uint8Array.from(frame).buffer;
}

function parseServerFrame(frame) {
  const buffer = arrayBufferFromNodeBuffer(frame);
  const view = new DataView(buffer);
  const opcode = view.getUint8(0);
  if (opcode === MSG.ROOM_STATE) return { opcode, value: parseRoomStateFrame(view, buffer) };
  if (opcode === MSG.ROOM_ERROR) return { opcode, value: parseRoomErrorFrame(view, buffer) };
  if (opcode === MSG.MATCH_START) return { opcode, value: parseMatchStartFrame(view, buffer) };
  if (opcode === MSG.NORMAL_MATCH_ASSIGNED) {
    return { opcode, value: parseNormalMatchAssignedFrame(view, buffer) };
  }
  return { opcode, value: null };
}

function packEnterGame(weaponNetId = 1) {
  const frame = Buffer.alloc(4);
  frame.writeUInt8(MSG.ENTER_GAME, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(weaponNetId, 2);
  return frame;
}

function parseStatePlayerIds(frame) {
  if (frame.readUInt8(0) !== MSG.STATE) return null;
  const count = frame.readUInt16LE(10);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(frame.readUInt16LE(24 + index * 44));
  }
  return result;
}

async function connectRoomClient(webSocketUrl, origin, headers = {}) {
  const { ws } = await createAuthenticatedSocket(webSocketUrl, origin, headers);
  return new Promise((resolve, reject) => {
    const client = {
      ws,
      id: null,
      welcomeFeatures: 0,
      room: null,
      roomErrors: [],
      matchStarts: [],
      normalMatch: null,
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
      const parsed = parseServerFrame(frame);
      if (parsed.opcode === MSG.ROOM_STATE && parsed.value) client.room = parsed.value;
      if (parsed.opcode === MSG.ROOM_ERROR && parsed.value) client.roomErrors.push(parsed.value);
      if (parsed.opcode === MSG.MATCH_START && parsed.value) client.matchStarts.push(parsed.value);
      if (parsed.opcode === MSG.NORMAL_MATCH_ASSIGNED && parsed.value) {
        client.normalMatch = parsed.value;
      }
      client.statePlayerIds = parseStatePlayerIds(frame) || client.statePlayerIds;
    });
  });
}

before(async () => {
  ({ colliderSource } = await loadAuthoritativeCollision(MAP_PATH));
});

after(() => {
  colliderSource?.disposeColliders();
});

test("room codes are unique six-character letter-number combinations", () => {
  const manager = new TeamRoomManager();
  const first = manager.createRoom(1);
  const second = manager.createRoom(2);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.match(first.room.code, /^[A-Z0-9]{6}$/);
  assert.match(first.room.code, /[A-Z]/);
  assert.match(first.room.code, /[0-9]/);
  assert.notEqual(first.room.code, second.room.code);
});

test("guests receive stable Player numbers and balanced team assignments", () => {
  const manager = new TeamRoomManager({ codeGenerator: () => "ABC123" });
  const created = manager.createRoom(11);
  const second = manager.joinRoom(12, created.room.code);
  const third = manager.joinRoom(13, created.room.code);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);

  const snapshot = manager.snapshot(created.room);
  assert.deepEqual(snapshot.players.map((player) => player.displayName), [
    "Player 1",
    "Player 2",
    "Player 3",
  ]);
  assert.deepEqual(snapshot.players.map((player) => player.team), [
    TEAM.CRAZIES,
    TEAM.MADDIES,
    TEAM.CRAZIES,
  ]);
});

test("players can switch teams before deployment and must ready up again", () => {
  const manager = new TeamRoomManager({ codeGenerator: () => "SWAP42" });
  const created = manager.createRoom(1);
  manager.joinRoom(2, created.room.code);

  manager.setReady(1, true);
  manager.setReady(2, true);
  assert.equal(created.room.phase, ROOM_PHASE.IN_MATCH);
  assert.equal(manager.switchTeam(1, TEAM.MADDIES).error, ROOM_ERROR.MATCH_STARTED);

  const lobbyManager = new TeamRoomManager({ codeGenerator: () => "SIDES7" });
  const lobby = lobbyManager.createRoom(11);
  lobbyManager.joinRoom(12, lobby.room.code);
  lobbyManager.setReady(11, true);
  const switched = lobbyManager.switchTeam(11, TEAM.MADDIES);
  assert.equal(switched.ok, true);
  assert.equal(switched.changed, true);
  assert.equal(switched.member.team, TEAM.MADDIES);
  assert.equal(switched.member.ready, false, "switching clears that player's ready state");

  lobbyManager.setReady(11, true);
  const sameSideReady = lobbyManager.setReady(12, true);
  assert.equal(sameSideReady.started, false, "a match needs at least one player on each team");

  const restoredSides = lobbyManager.switchTeam(12, TEAM.CRAZIES);
  assert.equal(restoredSides.member.ready, false);
  assert.equal(lobbyManager.setReady(12, true).started, true);
});

test("team switches respect the server-owned five-player capacity", () => {
  const manager = new TeamRoomManager({
    maxPlayers: 2,
    teamCapacity: 1,
    codeGenerator: () => "FULL55",
  });
  const created = manager.createRoom(1);
  manager.joinRoom(2, created.room.code);
  assert.equal(manager.switchTeam(1, TEAM.MADDIES).error, ROOM_ERROR.TEAM_FULL);
  assert.equal(manager.getMember(1).team, TEAM.CRAZIES);
});

test("trusted authenticated identities replace only that player's guest label", () => {
  const manager = new TeamRoomManager({ codeGenerator: () => "NAME42" });
  const created = manager.createRoom(1, "  Naitik   Dev  ");
  manager.joinRoom(2, created.room.code);
  const [authenticated, guest] = manager.snapshot(created.room).players;
  assert.equal(authenticated.displayName, "Naitik Dev");
  assert.equal(authenticated.authenticated, true);
  assert.equal(guest.displayName, "Player 2");
  assert.equal(guest.authenticated, false);
});

test("a room starts exactly once and only after every player is ready", () => {
  const manager = new TeamRoomManager({ codeGenerator: () => "READY7" });
  const created = manager.createRoom(1);
  manager.joinRoom(2, created.room.code);
  manager.joinRoom(3, created.room.code);

  assert.equal(manager.setReady(1, true).started, false);
  assert.equal(manager.setReady(2, true).started, false);
  const finalReady = manager.setReady(3, true);
  assert.equal(finalReady.started, true);
  assert.equal(finalReady.room.phase, ROOM_PHASE.IN_MATCH);
  assert.equal(manager.joinRoom(4, created.room.code).error, ROOM_ERROR.MATCH_STARTED);
  assert.equal(manager.setReady(1, false).error, ROOM_ERROR.MATCH_STARTED);
});

test("room capacity, leave, and disconnect cleanup are server-owned", () => {
  const codes = ["FULL22", "NEXT33"];
  const manager = new TeamRoomManager({
    maxPlayers: 2,
    teamCapacity: 1,
    codeGenerator: () => codes.shift(),
  });
  const created = manager.createRoom(1);
  assert.equal(manager.joinRoom(2, created.room.code).ok, true);
  assert.equal(manager.joinRoom(3, created.room.code).error, ROOM_ERROR.FULL);
  assert.equal(manager.leaveRoom(1).ok, true);
  assert.equal(manager.getRoom(created.room.code).members.size, 1);
  manager.disconnectPlayer(2);
  assert.equal(manager.getRoom(created.room.code), null);
});

test("room request frames have exact sizes and reject malformed traffic", () => {
  const createFrame = Buffer.from(packRoomCreateRequest());
  const joinFrame = Buffer.from(packRoomJoinRequest("ab12cd"));
  const readyFrame = Buffer.from(packRoomReadyRequest(true));
  const switchFrame = Buffer.from(packRoomTeamSwitchRequest(TEAM.MADDIES));
  assert.equal(decodeRoomCreateFrame(createFrame).ok, true);
  assert.deepEqual(decodeRoomJoinFrame(joinFrame), { ok: true, code: "AB12CD" });
  assert.deepEqual(decodeRoomReadyFrame(readyFrame), { ok: true, ready: true });
  assert.deepEqual(decodeRoomTeamSwitchFrame(switchFrame), {
    ok: true,
    targetTeam: TEAM.MADDIES,
  });
  assert.equal(packRoomTeamSwitchRequest(TEAM.NONE), null);
  assert.equal(decodeRoomJoinFrame(Buffer.concat([joinFrame, Buffer.from([0])])).ok, false);
  readyFrame.writeUInt8(2, 2);
  assert.equal(decodeRoomReadyFrame(readyFrame).ok, false);
  switchFrame.writeUInt8(1, 3);
  assert.equal(decodeRoomTeamSwitchFrame(switchFrame).ok, false);
  assert.equal(createTeamRoom(), false, "browser transport refuses sends without a socket");
});

test("the lobby exposes a responsive Team control and readiness-gated modal", async () => {
  const [html, css, uiSource] = await Promise.all([
    fsp.readFile(path.join(PROJECT_ROOT, "index.html"), "utf8"),
    fsp.readFile(path.join(PROJECT_ROOT, "css/styles.css"), "utf8"),
    fsp.readFile(path.join(PROJECT_ROOT, "js/ui.js"), "utf8"),
  ]);
  const modeIndex = html.indexOf('data-panel="mode"');
  const teamIndex = html.indexOf('id="teamRoomButton"');
  const loadoutIndex = html.indexOf('data-panel="loadout"');
  assert.ok(modeIndex < teamIndex && teamIndex < loadoutIndex);
  assert.match(html, /id="teamRoomModal"/);
  assert.match(html, /id="teamRoomBody"/);
  assert.match(css, /\.team-room-teams\s*\{/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(uiSource, /onMessage\(MSG\.MATCH_START, handleMatchStartFrame\)/);
  assert.match(
    uiSource,
    /function beginArenaDeployment\(\{ teamAuthorized = false, normalMatchAuthorized = false \} = \{\}\)/,
  );
  assert.match(uiSource, /Every player in the team room must be ready first/);
  assert.match(uiSource, /switchTeamRoomTeam\(targetTeam\)/);
  assert.match(uiSource, /Switching sides clears your Ready status/);
});

test("the bottom-right Coming Soon roadmap ships four optimized visual previews", async () => {
  const [html, css, uiSource] = await Promise.all([
    fsp.readFile(path.join(PROJECT_ROOT, "index.html"), "utf8"),
    fsp.readFile(path.join(PROJECT_ROOT, "css/styles.css"), "utf8"),
    fsp.readFile(path.join(PROJECT_ROOT, "js/ui.js"), "utf8"),
  ]);
  assert.match(html, /id="roadmapButton"/);
  assert.match(html, /id="roadmapModal"/);
  assert.equal((html.match(/data-roadmap-src=/g) || []).length, 4);
  for (const label of ["New map", "Game modes", "Shop", "Upgrades"]) {
    assert.match(html, new RegExp(`>${label}<`, "i"));
  }
  assert.match(css, /\.roadmap-launch-button\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:\s*28px;[\s\S]*?bottom:\s*28px;/);
  assert.match(css, /\.roadmap-grid\s*\{/);
  assert.match(uiSource, /function hydrateRoadmapImages\(\)/);

  const previews = [
    "ashfall-foundry.jpg",
    "game-modes.jpg",
    "armory-shop.jpg",
    "weapon-upgrades.jpg",
  ];
  for (const filename of previews) {
    const previewPath = path.join(PROJECT_ROOT, "assets/roadmap", filename);
    const [bytes, stats] = await Promise.all([fsp.readFile(previewPath), fsp.stat(previewPath)]);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(stats.size > 50_000, `${filename} should contain a real visual preview`);
    assert.ok(stats.size < 250_000, `${filename} should stay lightweight`);
  }
});

test("live clients cannot enter early and start together only after unanimous readiness", async () => {
  const world = new AuthoritativeWorld(colliderSource);
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world,
    resolveAuthenticatedUsername: (req) => req.headers["x-test-authenticated-user"] || null,
  });
  const clients = [];

  try {
    const address = await app.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/game`;
    const [first, second, third, outsider] = await Promise.all([
      connectRoomClient(socketUrl, origin),
      connectRoomClient(socketUrl, origin, { "x-test-authenticated-user": "VerifiedFriend" }),
      connectRoomClient(socketUrl, origin),
      connectRoomClient(socketUrl, origin),
    ]);
    clients.push(first, second, third, outsider);
    assert.ok(first.welcomeFeatures & FEATURE_FLAGS.TEAM_ROOMS);

    first.ws.send(packRoomCreateRequest());
    const firstRoom = await waitUntil(() => first.room);
    second.ws.send(packRoomJoinRequest(firstRoom.code));
    third.ws.send(packRoomJoinRequest(firstRoom.code));
    await waitUntil(() => first.room?.players.length === 3 && second.room?.players.length === 3);

    assert.deepEqual(first.room.players.map((player) => player.team), [
      TEAM.CRAZIES,
      TEAM.MADDIES,
      TEAM.CRAZIES,
    ]);
    const verified = first.room.players.find((player) => player.id === second.id);
    assert.equal(verified.displayName, "VerifiedFriend");
    assert.equal(verified.authenticated, true);

    third.ws.send(packRoomReadyRequest(true));
    await waitUntil(() => first.room?.players.find((player) => player.id === third.id)?.ready);
    third.ws.send(packRoomTeamSwitchRequest(TEAM.MADDIES));
    await waitUntil(() => {
      const member = first.room?.players.find((player) => player.id === third.id);
      return member?.team === TEAM.MADDIES && member.ready === false;
    });
    assert.equal(world.getPlayer(third.id).team, TEAM.MADDIES);

    first.ws.send(packEnterGame());
    await waitUntil(() => first.roomErrors.some((error) => error.code === ROOM_ERROR.NEED_MORE_PLAYERS));
    assert.equal(world.getPlayer(first.id).inGame, false);

    first.ws.send(packRoomReadyRequest(true));
    second.ws.send(packRoomReadyRequest(true));
    await delay(100);
    assert.equal(first.matchStarts.length, 0);
    assert.equal(second.matchStarts.length, 0);
    assert.equal(third.matchStarts.length, 0);

    third.ws.send(packRoomReadyRequest(true));
    await waitUntil(() => clients.slice(0, 3).every((client) => client.matchStarts.length === 1));
    assert.equal(first.matchStarts[0].code, firstRoom.code);
    assert.equal(first.matchStarts[0].team, TEAM.CRAZIES);
    assert.equal(second.matchStarts[0].team, TEAM.MADDIES);
    assert.equal(third.matchStarts[0].team, TEAM.MADDIES);

    const spammer = await connectRoomClient(socketUrl, origin);
    clients.push(spammer);
    for (let index = 0; index < 12; index += 1) spammer.ws.send(packRoomCreateRequest());
    await waitUntil(() => spammer.roomErrors.some((error) => error.code === ROOM_ERROR.RATE_LIMIT));

    first.ws.send(packEnterGame());
    second.ws.send(packEnterGame());
    outsider.ws.send(packNormalMatchJoinRequest());
    await waitUntil(() => outsider.normalMatch);
    outsider.ws.send(packEnterGame());
    await waitUntil(() => world.getPlayer(first.id).inGame && world.getPlayer(outsider.id).inGame);
    await waitUntil(() => first.statePlayerIds && outsider.statePlayerIds);
    assert.deepEqual(new Set(first.statePlayerIds), new Set([first.id, second.id]));
    assert.deepEqual(outsider.statePlayerIds, [outsider.id]);
  } finally {
    for (const client of clients) client.ws.close(1000);
    await delay(30);
    await app.stop();
    world.dispose();
  }
});
