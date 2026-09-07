import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";

import WebSocket from "ws";

import { packAuthTicket } from "../js/network.js";
import { INPUT_MASK, MSG, PROTOCOL_VERSION } from "../js/protocol.js";
import { AuthoritativeWorld } from "../server/authoritativeWorld.js";
import { loadAuthoritativeCollision } from "../server/mapCollision.js";
import { createPotSparkServer } from "../server/runtime.js";
import { requestMatchAdmission } from "./helpers/match-client.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");
let colliderSource;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeEvent(ws) {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({
    code,
    reason: reason.toString(),
  })));
}

function connectPrepared(webSocketUrl, origin, admission) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl, {
      origin,
      headers: { Cookie: admission.cookie },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for authenticated welcome"));
    }, 2_000);
    ws.once("error", reject);
    ws.once("open", () => ws.send(packAuthTicket(admission.ticket)));
    ws.on("message", (data) => {
      const frame = Buffer.from(data);
      if (frame.readUInt8(0) !== MSG.WELCOME) return;
      clearTimeout(timer);
      resolve({ ws, id: frame.readUInt16LE(2) });
    });
    ws.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Socket closed before welcome (${code})`));
    });
  });
}

function connectAndExpectRejection(webSocketUrl, origin, cookie, firstFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl, { origin, headers: { Cookie: cookie } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for admission rejection"));
    }, 2_000);
    ws.once("error", reject);
    ws.once("open", () => ws.send(firstFrame));
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

before(async () => {
  ({ colliderSource } = await loadAuthoritativeCollision(MAP_PATH));
});

after(() => {
  colliderSource?.disposeColliders();
});

test("live sockets require one-use tickets and preserve one reconnectable seat per principal", async () => {
  const world = new AuthoritativeWorld(colliderSource);
  const app = await createPotSparkServer({
    root: PROJECT_ROOT,
    host: "127.0.0.1",
    port: 0,
    world,
    reconnectGraceMs: 250,
    matchAuthTimeoutMs: 250,
  });

  try {
    const address = await app.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const webSocketUrl = `ws://127.0.0.1:${address.port}/game`;
    const initial = await requestMatchAdmission(origin);

    const forgedInput = Buffer.alloc(16);
    forgedInput.writeUInt8(MSG.INPUT, 0);
    forgedInput.writeUInt8(PROTOCOL_VERSION, 1);
    const firstFrameFailure = await connectAndExpectRejection(
      webSocketUrl,
      origin,
      initial.cookie,
      forgedInput,
    );
    assert.equal(firstFrameFailure.code, 4401);

    const stale = await requestMatchAdmission(origin, { cookie: initial.cookie });
    const current = await requestMatchAdmission(origin, { cookie: initial.cookie });
    const staleFailure = await connectAndExpectRejection(
      webSocketUrl,
      origin,
      initial.cookie,
      packAuthTicket(stale.ticket),
    );
    assert.equal(staleFailure.code, 4401, "issuing a newer epoch must retire the old ticket");

    let active = await connectPrepared(webSocketUrl, origin, current);
    const playerId = active.id;
    const replayFailure = await connectAndExpectRejection(
      webSocketUrl,
      origin,
      initial.cookie,
      packAuthTicket(current.ticket),
    );
    assert.equal(replayFailure.code, 4401, "consumed ticket must not replay");
    assert.equal(active.ws.readyState, WebSocket.OPEN);

    const replacement = await requestMatchAdmission(origin, { cookie: initial.cookie });
    const replacedSocketClose = closeEvent(active.ws);
    const replaced = await connectPrepared(webSocketUrl, origin, replacement);
    assert.equal(replaced.id, playerId);
    assert.equal((await replacedSocketClose).code, 4001);
    active = replaced;

    assert.equal(world.enterGame(playerId, 1), true);
    assert.equal(world.submitInput(playerId, {
      seq: 44,
      mask: INPUT_MASK.FORWARD,
      yaw: 0,
      pitch: 0,
    }).ok, true);
    world.step();
    active.ws.terminate();
    await delay(25);
    assert.ok(world.getPlayer(playerId), "avatar must remain vulnerable during reconnect grace");
    assert.equal(world.getPlayer(playerId).currentInput.mask, 0, "disconnect must neutralize movement");

    const reconnect = await requestMatchAdmission(origin, { cookie: initial.cookie });
    active = await connectPrepared(webSocketUrl, origin, reconnect);
    assert.equal(active.id, playerId, "reconnect must reclaim the same seat");
    assert.equal(world.getPlayer(playerId).lastReceivedSeq, 0, "new epoch must reset packet sequence state");

    active.ws.terminate();
    await delay(300);
    assert.equal(world.getPlayer(playerId), null, "seat must be released when grace expires");
  } finally {
    await app.stop();
    world.dispose();
  }
});
