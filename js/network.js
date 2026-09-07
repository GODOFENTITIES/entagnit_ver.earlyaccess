/**
 * Browser transport for PotSpark protocol v8.
 *
 * The movement frame contains only a sequence number, key mask, yaw, and
 * pitch. Position and velocity are deliberately impossible to encode.
 */

import {
  AUTH_TICKET_BYTES,
  AUTH_TICKET_CHARACTERS,
  COMBAT_FLAGS,
  ENTER_GAME_BYTES,
  FEATURE_FLAGS,
  HIT_BYTES,
  HIT_ZONE,
  INPUT_BYTES,
  MSG,
  NORMAL_MATCH_ASSIGNED_BYTES,
  NORMAL_MATCH_JOIN_BYTES,
  NORMAL_MATCH_MAX_PLAYERS,
  PING_BYTES,
  PLAYER_FLAGS,
  PROTOCOL_VERSION,
  RELOAD_BYTES,
  ROOM_CODE_LENGTH,
  ROOM_CREATE_BYTES,
  ROOM_ERROR,
  ROOM_ERROR_BYTES,
  ROOM_ERROR_MESSAGES,
  ROOM_JOIN_BYTES,
  ROOM_LEAVE_BYTES,
  ROOM_LEFT_BYTES,
  ROOM_PLAYER_FLAGS,
  ROOM_PLAYER_NAME_BYTES,
  ROOM_READY_BYTES,
  ROOM_STATE_HEADER_BYTES,
  ROOM_STATE_PLAYER_BYTES,
  ROOM_TEAM_SWITCH_BYTES,
  MATCH_START_BYTES,
  ROOM_PHASE,
  SHOT_BYTES,
  SHOT_STATUS,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
  STATE_HEADER_BYTES,
  STATE_PLAYER_BYTES,
  TEAM,
  TEAM_NAMES,
  WELCOME_BYTES,
  buildInputMask,
  isValidRoomCode,
  normalizeRoomCode,
  weaponNetId,
} from "./protocol.js";

export {
  COMBAT_FLAGS,
  FEATURE_FLAGS,
  HIT_ZONE,
  MSG,
  PLAYER_FLAGS,
  PROTOCOL_VERSION,
  ROOM_ERROR,
  ROOM_ERROR_MESSAGES,
  ROOM_PHASE,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
  SHOT_STATUS,
  TEAM,
  TEAM_NAMES,
};

const MAX_CLIENT_BUFFERED_BYTES = 64 * 1024;
const MAX_RECONNECT_DELAY_MS = 8000;

let ws = null;
let desiredUrl = null;
let myPlayerId = null;
let isOpen = false;
let serverAcceptedProtocol = false;
let pingMs = null;
let pingTimer = 0;
let reconnectTimer = 0;
let reconnectAttempt = 0;
let readyWeaponId = null;
let latestServerTick = 0;
let ticketRequest = null;
let connectionGeneration = 0;
let identityRefreshPending = false;

const handlers = new Map();

export function onMessage(opcode, fn) {
  handlers.set(opcode, fn);
  return () => {
    if (handlers.get(opcode) === fn) handlers.delete(opcode);
  };
}

export function packInputCommand(command) {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(buf);
  const mask = Number.isInteger(command?.mask)
    ? command.mask
    : buildInputMask(command);

  view.setUint8(0, MSG.INPUT);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint32(2, command?.seq >>> 0, true);
  view.setUint8(6, mask & 0xff);
  view.setUint8(7, 0);
  view.setFloat32(8, Number.isFinite(command?.yaw) ? command.yaw : 0, true);
  view.setFloat32(12, Number.isFinite(command?.pitch) ? command.pitch : 0, true);
  return buf;
}

export function sendInputCommand(command) {
  return sendRaw(packInputCommand(command));
}

export function sendEnterGame(weaponId) {
  readyWeaponId = weaponId;
  return flushEnterGame();
}

export function packNormalMatchJoinRequest() {
  const buf = new ArrayBuffer(NORMAL_MATCH_JOIN_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.NORMAL_MATCH_JOIN);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint16(2, 0, true);
  return buf;
}

export function joinNormalMatch() {
  return sendRaw(packNormalMatchJoinRequest());
}

export function packShotRequest(request) {
  const buf = new ArrayBuffer(SHOT_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.SHOT);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint32(2, request?.shotSeq >>> 0, true);
  view.setUint32(6, request?.inputSeq >>> 0, true);
  view.setUint32(10, request?.rewindTick >>> 0, true);
  view.setFloat32(14, Number.isFinite(request?.yaw) ? request.yaw : 0, true);
  view.setFloat32(18, Number.isFinite(request?.pitch) ? request.pitch : 0, true);
  view.setUint16(22, 0, true);
  return buf;
}

export function sendShot(request) {
  return sendRaw(packShotRequest(request));
}

export function packReloadRequest(requestSeq) {
  const buf = new ArrayBuffer(RELOAD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.RELOAD);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint32(2, requestSeq >>> 0, true);
  view.setUint16(6, 0, true);
  return buf;
}

export function sendReload(requestSeq) {
  return sendRaw(packReloadRequest(requestSeq));
}

export function packRoomCreateRequest() {
  const buf = new ArrayBuffer(ROOM_CREATE_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ROOM_CREATE);
  view.setUint8(1, PROTOCOL_VERSION);
  return buf;
}

export function createTeamRoom() {
  return sendRaw(packRoomCreateRequest());
}

export function packRoomJoinRequest(rawCode) {
  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) return null;
  const buf = new ArrayBuffer(ROOM_JOIN_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ROOM_JOIN);
  view.setUint8(1, PROTOCOL_VERSION);
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    view.setUint8(2 + index, code.charCodeAt(index));
  }
  return buf;
}

export function joinTeamRoom(code) {
  const frame = packRoomJoinRequest(code);
  return frame ? sendRaw(frame) : false;
}

export function packRoomReadyRequest(ready) {
  const buf = new ArrayBuffer(ROOM_READY_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ROOM_READY);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint8(2, ready ? 1 : 0);
  return buf;
}

export function setTeamRoomReady(ready) {
  return sendRaw(packRoomReadyRequest(ready));
}

export function packRoomTeamSwitchRequest(targetTeam) {
  if (targetTeam !== TEAM.CRAZIES && targetTeam !== TEAM.MADDIES) return null;
  const buf = new ArrayBuffer(ROOM_TEAM_SWITCH_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ROOM_TEAM_SWITCH);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint8(2, targetTeam);
  view.setUint8(3, 0);
  return buf;
}

export function switchTeamRoomTeam(targetTeam) {
  const frame = packRoomTeamSwitchRequest(targetTeam);
  return frame ? sendRaw(frame) : false;
}

export function packRoomLeaveRequest() {
  const buf = new ArrayBuffer(ROOM_LEAVE_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ROOM_LEAVE);
  view.setUint8(1, PROTOCOL_VERSION);
  return buf;
}

export function leaveTeamRoom() {
  return sendRaw(packRoomLeaveRequest());
}

function readRoomCode(view, offset = 2) {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += String.fromCharCode(view.getUint8(offset + index));
  }
  return code;
}

export function parseRoomStateFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength < ROOM_STATE_HEADER_BYTES
    || view.getUint8(0) !== MSG.ROOM_STATE
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint8(15) !== 0
  ) return null;

  const code = readRoomCode(view);
  const phase = view.getUint8(8);
  const count = view.getUint8(9);
  const expectedBytes = ROOM_STATE_HEADER_BYTES + count * ROOM_STATE_PLAYER_BYTES;
  if (
    !isValidRoomCode(code)
    || !Object.values(ROOM_PHASE).includes(phase)
    || buffer.byteLength !== expectedBytes
  ) return null;

  const players = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let index = 0; index < count; index += 1) {
      const offset = ROOM_STATE_HEADER_BYTES + index * ROOM_STATE_PLAYER_BYTES;
      const team = view.getUint8(offset + 2);
      const flags = view.getUint8(offset + 3);
      const nameLength = view.getUint8(offset + 6);
      if (
        (team !== TEAM.CRAZIES && team !== TEAM.MADDIES)
        || nameLength > ROOM_PLAYER_NAME_BYTES
        || view.getUint8(offset + 7) !== 0
      ) return null;
      const nameBytes = new Uint8Array(buffer, offset + 8, nameLength);
      players.push({
        id: view.getUint16(offset, true),
        team,
        ready: !!(flags & ROOM_PLAYER_FLAGS.READY),
        authenticated: !!(flags & ROOM_PLAYER_FLAGS.AUTHENTICATED),
        joinIndex: view.getUint16(offset + 4, true),
        displayName: decoder.decode(nameBytes),
      });
    }
  } catch {
    return null;
  }

  return {
    code,
    phase,
    selfId: view.getUint16(10, true),
    minPlayers: view.getUint8(12),
    maxPlayers: view.getUint8(13),
    selfTeam: view.getUint8(14),
    players,
  };
}

export function parseRoomErrorFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength !== ROOM_ERROR_BYTES
    || view.getUint8(0) !== MSG.ROOM_ERROR
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint8(3) !== 0
  ) return null;
  const code = view.getUint8(2);
  return {
    code,
    message: ROOM_ERROR_MESSAGES[code] || ROOM_ERROR_MESSAGES[ROOM_ERROR.SERVER_ERROR],
  };
}

export function parseMatchStartFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength !== MATCH_START_BYTES
    || view.getUint8(0) !== MSG.MATCH_START
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint16(10, true) !== 0
  ) return null;
  const code = readRoomCode(view);
  const team = view.getUint8(8);
  if (
    !isValidRoomCode(code)
    || (team !== TEAM.CRAZIES && team !== TEAM.MADDIES)
  ) return null;
  return { code, team, playerCount: view.getUint8(9) };
}

export function parseRoomLeftFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength !== ROOM_LEFT_BYTES
    || view.getUint8(0) !== MSG.ROOM_LEFT
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint16(2, true) !== 0
  ) return null;
  return { left: true };
}

export function parseNormalMatchAssignedFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength !== NORMAL_MATCH_ASSIGNED_BYTES
    || view.getUint8(0) !== MSG.NORMAL_MATCH_ASSIGNED
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint16(10, true) !== 0
  ) return null;

  const id = view.getUint32(2, true);
  const team = view.getUint8(6);
  const playerCount = view.getUint8(7);
  const maxPlayers = view.getUint8(8);
  const sealed = view.getUint8(9);
  if (
    id === 0
    || (team !== TEAM.CRAZIES && team !== TEAM.MADDIES)
    || maxPlayers !== NORMAL_MATCH_MAX_PLAYERS
    || playerCount < 1
    || playerCount > maxPlayers
    || sealed > 1
  ) return null;

  return {
    id,
    team,
    playerCount,
    maxPlayers,
    sealed: sealed === 1,
  };
}

export function parseStateFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength < STATE_HEADER_BYTES
    || view.getUint8(0) !== MSG.STATE
    || view.getUint8(1) !== PROTOCOL_VERSION
  ) {
    return null;
  }

  const tick = view.getUint32(2, true);
  const lastAckedSeq = view.getUint32(6, true);
  const count = view.getUint16(10, true);
  const expectedBytes = STATE_HEADER_BYTES + count * STATE_PLAYER_BYTES;
  if (buffer.byteLength !== expectedBytes) return null;

  const players = [];
  for (let i = 0; i < count; i += 1) {
    const offset = STATE_HEADER_BYTES + i * STATE_PLAYER_BYTES;
    const flags = view.getUint8(offset + 4);
    players.push({
      id: view.getUint16(offset, true),
      weaponNetId: view.getUint8(offset + 2),
      health: view.getUint8(offset + 3),
      flags,
      grounded: view.getUint8(offset + 5) === 1,
      lifeId: view.getUint16(offset + 6, true),
      x: view.getFloat32(offset + 8, true),
      y: view.getFloat32(offset + 12, true),
      z: view.getFloat32(offset + 16, true),
      velocityX: view.getFloat32(offset + 20, true),
      velocityY: view.getFloat32(offset + 24, true),
      velocityZ: view.getFloat32(offset + 28, true),
      yaw: view.getFloat32(offset + 32, true),
      pitch: view.getFloat32(offset + 36, true),
      eyeHeight: view.getFloat32(offset + 40, true),
      crouching: !!(flags & PLAYER_FLAGS.CROUCHING),
      sprinting: !!(flags & PLAYER_FLAGS.SPRINTING),
      aiming: !!(flags & PLAYER_FLAGS.AIMING),
    });
  }

  return {
    tick,
    lastAckedSeq,
    combat: {
      ammo: view.getUint16(12, true),
      reserveAmmo: view.getUint16(14, true),
      reloadRemainingTicks: view.getUint16(16, true),
      respawnRemainingTicks: view.getUint16(18, true),
      flags: view.getUint8(20),
      weaponNetId: view.getUint8(21),
      lifeId: view.getUint16(22, true),
    },
    players,
  };
}

export function parseHitFrame(view, buffer) {
  if (
    !view
    || !buffer
    || buffer.byteLength !== HIT_BYTES
    || view.getUint8(0) !== MSG.HIT
    || view.getUint8(1) !== PROTOCOL_VERSION
    || view.getUint8(23) !== 0
  ) return null;

  return {
    status: view.getUint8(2),
    zone: view.getUint8(3),
    shotSeq: view.getUint32(4, true),
    serverTick: view.getUint32(8, true),
    targetId: view.getUint16(12, true),
    ammo: view.getUint16(14, true),
    reserveAmmo: view.getUint16(16, true),
    damage: view.getUint8(18),
    targetHealth: view.getUint8(19),
    reloadRemainingTicks: view.getUint16(20, true),
    weaponNetId: view.getUint8(22),
  };
}

export function connect(url) {
  desiredUrl = url || defaultServerUrl();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }
  if (ticketRequest) return null;

  clearReconnectTimer();
  const generation = ++connectionGeneration;
  ticketRequest = requestMatchTicket()
    .then((ticket) => {
      if (generation !== connectionGeneration) return null;
      return openSocketWithTicket(ticket);
    })
    .catch((error) => {
      if (generation !== connectionGeneration) return null;
      console.warn(`[net] admission unavailable: ${error.message}`);
      dispatchBrowserEvent("potspark:net-disconnected", {
        code: 0,
        reason: "Match admission unavailable",
      });
      if (!error.terminal) scheduleReconnect();
      return null;
    })
    .finally(() => {
      if (generation === connectionGeneration) ticketRequest = null;
    });
  return null;
}

function openSocketWithTicket(ticket) {
  console.info(`[net] connecting to ${desiredUrl}`);
  ws = new WebSocket(desiredUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    isOpen = true;
    reconnectAttempt = 0;
    if (!sendRaw(packAuthTicket(ticket))) {
      ws.close(1008, "Admission failed");
      return;
    }
    ticket = null;
    console.info("[net] connected; authenticating match admission");
  };

  ws.onmessage = (event) => dispatch(event.data);

  ws.onclose = (event) => {
    isOpen = false;
    serverAcceptedProtocol = false;
    myPlayerId = null;
    latestServerTick = 0;
    stopPingLoop();
    console.warn(`[net] disconnected (${event.code}) ${event.reason || ""}`);
    dispatchBrowserEvent("potspark:net-disconnected", { code: event.code, reason: event.reason });
    if (identityRefreshPending) {
      identityRefreshPending = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      connect(desiredUrl);
      return;
    }
    if (![1000, 1002, 1003, 1008, 1009, 4401, 4403].includes(event.code)) {
      scheduleReconnect();
    }
  };

  ws.onerror = (error) => {
    console.error("[net] WebSocket error", error);
  };

  return ws;
}

async function requestMatchTicket() {
  const response = await fetch("/api/potspark/match-ticket", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Potspark-Request": "1",
    },
    body: "{}",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.ticket !== "string") {
    const error = new Error(payload.error || `admission ${response.status}`);
    error.terminal = response.status === 401 || response.status === 403;
    throw error;
  }
  return payload.ticket;
}

export function packAuthTicket(ticket) {
  if (typeof ticket !== "string" || ticket.length !== AUTH_TICKET_CHARACTERS) {
    throw new TypeError("Invalid match ticket");
  }
  const encoded = new TextEncoder().encode(ticket);
  if (encoded.length !== AUTH_TICKET_CHARACTERS) throw new TypeError("Invalid match ticket");
  const buffer = new ArrayBuffer(AUTH_TICKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, MSG.AUTH_TICKET);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint8(2, encoded.length);
  view.setUint8(3, 0);
  new Uint8Array(buffer, 4, encoded.length).set(encoded);
  return buffer;
}

export function refreshNetworkIdentity() {
  connectionGeneration += 1;
  ticketRequest = null;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    identityRefreshPending = true;
    ws.close(4000, "Identity changed");
  } else {
    identityRefreshPending = false;
    connect(desiredUrl);
  }
}

export function getPlayerId() {
  return myPlayerId;
}

export function isConnected() {
  return isOpen && serverAcceptedProtocol;
}

export function getPingMs() {
  return pingMs;
}

export function getLatestServerTick() {
  return latestServerTick;
}

function defaultServerUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/game`;
}

function sendRaw(buffer) {
  if (
    !ws
    || !isOpen
    || ws.readyState !== WebSocket.OPEN
    || ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES
  ) {
    return false;
  }
  ws.send(buffer);
  return true;
}

function flushEnterGame() {
  if (!readyWeaponId || !serverAcceptedProtocol) return false;
  const buf = new ArrayBuffer(ENTER_GAME_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.ENTER_GAME);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint8(2, weaponNetId(readyWeaponId));
  view.setUint8(3, 0);
  return sendRaw(buf);
}

function dispatch(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return;
  const view = new DataView(buffer);
  const opcode = view.getUint8(0);

  if (opcode === MSG.WELCOME) {
    handleWelcome(view, buffer);
  } else if (opcode === MSG.PONG) {
    handlePong(view, buffer);
  } else if (opcode === MSG.STATE) {
    const state = parseStateFrame(view, buffer);
    if (!state) {
      console.warn("[net] rejected malformed state frame");
      return;
    }
    latestServerTick = state.tick;
  } else if (opcode === MSG.HIT && !parseHitFrame(view, buffer)) {
    console.warn("[net] rejected malformed hit frame");
    return;
  } else if (opcode === MSG.ROOM_STATE && !parseRoomStateFrame(view, buffer)) {
    console.warn("[net] rejected malformed room-state frame");
    return;
  } else if (opcode === MSG.ROOM_ERROR && !parseRoomErrorFrame(view, buffer)) {
    console.warn("[net] rejected malformed room-error frame");
    return;
  } else if (opcode === MSG.MATCH_START && !parseMatchStartFrame(view, buffer)) {
    console.warn("[net] rejected malformed match-start frame");
    return;
  } else if (opcode === MSG.ROOM_LEFT && !parseRoomLeftFrame(view, buffer)) {
    console.warn("[net] rejected malformed room-left frame");
    return;
  } else if (
    opcode === MSG.NORMAL_MATCH_ASSIGNED
    && !parseNormalMatchAssignedFrame(view, buffer)
  ) {
    console.warn("[net] rejected malformed normal-match assignment frame");
    return;
  }

  const handler = handlers.get(opcode);
  if (handler) handler(view, buffer);
}

function handleWelcome(view, buffer) {
  if (buffer.byteLength !== WELCOME_BYTES) return;
  const version = view.getUint8(1);
  if (version !== PROTOCOL_VERSION) {
    console.error(`[net] protocol mismatch: client=${PROTOCOL_VERSION} server=${version}`);
    ws?.close(1002, "Protocol mismatch");
    return;
  }

  myPlayerId = view.getUint16(2, true);
  latestServerTick = 0;
  serverAcceptedProtocol = true;
  startPingLoop();
  const simHz = view.getUint8(4);
  const snapshotHz = view.getUint8(5);
  const features = view.getUint16(6, true);
  console.info(`[net] welcome: player ${myPlayerId}, ${simHz} Hz sim, ${snapshotHz} Hz snapshots`);
  dispatchBrowserEvent("potspark:net-welcome", {
    playerId: myPlayerId,
    simHz,
    snapshotHz,
    features,
  });
  flushEnterGame();
}

function startPingLoop() {
  stopPingLoop();
  sendPing();
  pingTimer = window.setInterval(sendPing, 2000);
}

function stopPingLoop() {
  if (pingTimer) window.clearInterval(pingTimer);
  pingTimer = 0;
}

function sendPing() {
  if (!isOpen) return;
  const buf = new ArrayBuffer(PING_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG.PING);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setFloat64(2, performance.now(), true);
  sendRaw(buf);
}

function handlePong(view, buffer) {
  if (
    buffer.byteLength !== PING_BYTES
    || view.getUint8(1) !== PROTOCOL_VERSION
  ) return;
  const sentAt = view.getFloat64(2, true);
  pingMs = Math.max(0, Math.round(performance.now() - sentAt));
  dispatchBrowserEvent("potspark:net-ping", { pingMs });
}

function scheduleReconnect() {
  if (reconnectTimer || !desiredUrl) return;
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** reconnectAttempt));
  const jitter = Math.round(Math.random() * 250);
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect(desiredUrl);
  }, base + jitter);
}

function clearReconnectTimer() {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

/**
 * Intentional disconnect — closes the socket with code 1000 so the server
 * releases the seat immediately, and cancels any pending reconnect timer so
 * the client does not try to reconnect automatically.  Call this before
 * navigating away (e.g. page reload triggered by "Exit lobby").
 */
export function disconnect() {
  clearReconnectTimer();
  connectionGeneration += 1; // invalidate any in-flight ticket request
  ticketRequest = null;
  desiredUrl = null;         // prevent scheduleReconnect from re-connecting
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close(1000, "User left intentionally");
  }
}

function dispatchBrowserEvent(name, detail) {
  if (typeof window !== "undefined" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
