import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import {
  AUTH_TICKET_BYTES,
  AUTH_TICKET_CHARACTERS,
  ENTER_GAME_BYTES,
  FEATURE_FLAGS,
  HIT_BYTES,
  INPUT_BYTES,
  MSG,
  PING_BYTES,
  PROTOCOL_VERSION,
  RELOAD_BYTES,
  ROOM_CODE_LENGTH,
  ROOM_CREATE_BYTES,
  ROOM_ERROR,
  ROOM_ERROR_BYTES,
  ROOM_JOIN_BYTES,
  ROOM_LEAVE_BYTES,
  ROOM_LEFT_BYTES,
  ROOM_PLAYER_FLAGS,
  ROOM_PLAYER_NAME_BYTES,
  ROOM_READY_BYTES,
  ROOM_STATE_HEADER_BYTES,
  ROOM_STATE_PLAYER_BYTES,
  ROOM_TEAM_SWITCH_BYTES,
  SIMULATION_DT,
  SIMULATION_HZ,
  SHOT_BYTES,
  SNAPSHOT_HZ,
  STATE_HEADER_BYTES,
  STATE_PLAYER_BYTES,
  TEAM,
  MATCH_START_BYTES,
  NORMAL_MATCH_ASSIGNED_BYTES,
  NORMAL_MATCH_JOIN_BYTES,
  WELCOME_BYTES,
  isValidRoomCode,
} from "../js/protocol.js";
import { AuthoritativeWorld } from "./authoritativeWorld.js";
import { createAuthSystem } from "./authSystem.js";
import { createChatBridge } from "./chatBridge.js";
import { loadAuthoritativeCollision } from "./mapCollision.js";
import { NormalMatchManager } from "./normalMatches.js";
import { TeamRoomManager, sanitizeAuthenticatedUsername } from "./teamRooms.js";


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(MODULE_DIR, "..");

const MAX_INBOUND_FRAME_BYTES = 128;
const MAX_PACKET_BUFFERED_BYTES = 256 * 1024;
// A full 5v5 room may share one school/home NAT, so the per-IP ceiling must be
// above room capacity while still remaining bounded.
const MAX_CONNECTIONS_PER_IP = 16;
const MAX_PLAYERS = 32;
const MAX_CATCH_UP_STEPS = 5;
const MATCH_AUTH_TIMEOUT_MS = 5_000;
const RECONNECT_GRACE_MS = 15_000;
const ROOM_OP_TOKEN_RATE = 2;
const ROOM_OP_TOKEN_CAPACITY = 8;
const SNAPSHOT_EVERY_TICKS = Math.max(1, Math.round(SIMULATION_HZ / SNAPSHOT_HZ));

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wasm": "application/wasm",
});

const STATIC_RULES = Object.freeze({
  css: new Set([".css"]),
  js: new Set([".js", ".mjs", ".map"]),
  assets: new Set([".glb", ".svg", ".png", ".jpg", ".jpeg", ".wasm"]),
});

function buildSecurityHeaders() {
  // Inject the Supabase URL into connect-src so the browser's Supabase realtime
  // client can open WSS connections. Falls back to the baseline policy when
  // SUPABASE_URL is not configured (dev/CI without chat).
  const supabaseUrl = process.env.SUPABASE_URL || "";
  let connectSrc = "'self' blob: ws: wss:";
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      const httpsOrigin = `${parsed.protocol}//${parsed.host}`;
      const wssOrigin = `wss://${parsed.host}`;
      connectSrc = `'self' blob: ws: wss: ${httpsOrigin} ${wssOrigin}`;
    } catch {
      // malformed SUPABASE_URL — skip the injection
    }
  }
  return Object.freeze({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://esm.sh",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // GLTFLoader decodes images embedded in a GLB by creating same-document
      // blob: URLs and fetching them through ImageBitmapLoader. Without blob:
      // here the geometry loads but every colour texture is silently rejected.
      `connect-src ${connectSrc}`,
      "object-src 'none'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
}

// Compute once at startup (SUPABASE_URL is set before the module is imported).
const SECURITY_HEADERS = buildSecurityHeaders();

function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}


function sendText(res, status, message, extraHeaders = {}) {
  setSecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
    ...extraHeaders,
  });
  res.end(message);
}

function isAllowedStaticPath(relativePath) {
  if (relativePath === "index.html") return true;
  const [top] = relativePath.split("/");
  const extensions = STATIC_RULES[top];
  if (!extensions) return false;
  return extensions.has(path.extname(relativePath).toLowerCase());
}

export function createStaticHandler(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);

  return async function handleStaticRequest(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      sendText(res, 400, "Bad request");
      return;
    }
    if (urlPath.includes("\0")) {
      sendText(res, 400, "Bad request");
      return;
    }

    const relativePath = urlPath === "/"
      ? "index.html"
      : urlPath.replace(/^\/+/, "");
    if (!isAllowedStaticPath(relativePath)) {
      sendText(res, 404, "Not found");
      return;
    }

    const target = path.resolve(resolvedRoot, relativePath);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    try {
      const [stat, realTarget, realRoot] = await Promise.all([
        fsp.stat(target),
        fsp.realpath(target),
        fsp.realpath(resolvedRoot),
      ]);
      if (
        !stat.isFile()
        || (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`))
      ) {
        sendText(res, 404, "Not found");
        return;
      }

      const extension = path.extname(realTarget).toLowerCase();
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      setSecurityHeaders(res);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }

      const isLargeAsset = relativePath.startsWith("assets/");
      res.writeHead(200, {
        "Content-Type": MIME[extension] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": isLargeAsset ? "public, max-age=86400" : "no-cache",
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString(),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const stream = fs.createReadStream(realTarget);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        sendText(res, 404, "Not found");
      } else {
        console.error("[http] static-file error", error);
        if (!res.headersSent) sendText(res, 500, "Internal server error");
        else res.destroy();
      }
    }
  };
}

function dataViewFor(rawData) {
  const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  return {
    buffer,
    view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  };
}

export function decodeAuthTicketFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== AUTH_TICKET_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.AUTH_TICKET) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint8(2) !== AUTH_TICKET_CHARACTERS || view.getUint8(3) !== 0) {
    return { ok: false, reason: "header" };
  }
  for (let offset = 4 + AUTH_TICKET_CHARACTERS; offset < buffer.byteLength; offset += 1) {
    if (buffer[offset] !== 0) return { ok: false, reason: "padding" };
  }
  const ticket = buffer.toString("ascii", 4, 4 + AUTH_TICKET_CHARACTERS);
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return { ok: false, reason: "ticket" };
  return { ok: true, ticket };
}

export function decodeInputFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== INPUT_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.INPUT) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint8(7) !== 0) return { ok: false, reason: "reserved" };

  const command = {
    seq: view.getUint32(2, true),
    mask: view.getUint8(6),
    yaw: view.getFloat32(8, true),
    pitch: view.getFloat32(12, true),
  };
  if (!Number.isFinite(command.yaw) || !Number.isFinite(command.pitch)) {
    return { ok: false, reason: "non-finite" };
  }
  return { ok: true, command };
}

export function decodeShotFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== SHOT_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.SHOT) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint16(22, true) !== 0) return { ok: false, reason: "reserved" };

  const request = {
    shotSeq: view.getUint32(2, true),
    inputSeq: view.getUint32(6, true),
    rewindTick: view.getUint32(10, true),
    yaw: view.getFloat32(14, true),
    pitch: view.getFloat32(18, true),
  };
  if (!Number.isFinite(request.yaw) || !Number.isFinite(request.pitch)) {
    return { ok: false, reason: "non-finite" };
  }
  return { ok: true, request };
}

export function decodeReloadFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== RELOAD_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.RELOAD) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint16(6, true) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true, requestSeq: view.getUint32(2, true) };
}

function decodeEnterGameFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ENTER_GAME_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ENTER_GAME) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint8(3) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true, weaponNetId: view.getUint8(2) };
}

export function decodeNormalMatchJoinFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== NORMAL_MATCH_JOIN_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.NORMAL_MATCH_JOIN) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint16(2, true) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function decodeRoomCreateFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ROOM_CREATE_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ROOM_CREATE) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint16(2, true) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function decodeRoomJoinFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ROOM_JOIN_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ROOM_JOIN) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  const code = buffer.toString("ascii", 2, 2 + ROOM_CODE_LENGTH);
  if (!isValidRoomCode(code)) return { ok: false, reason: "code" };
  return { ok: true, code };
}

export function decodeRoomReadyFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ROOM_READY_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ROOM_READY) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  const ready = view.getUint8(2);
  if (ready > 1 || view.getUint8(3) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true, ready: ready === 1 };
}

export function decodeRoomTeamSwitchFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ROOM_TEAM_SWITCH_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ROOM_TEAM_SWITCH) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  const targetTeam = view.getUint8(2);
  if (targetTeam !== TEAM.CRAZIES && targetTeam !== TEAM.MADDIES) {
    return { ok: false, reason: "team" };
  }
  if (view.getUint8(3) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true, targetTeam };
}

export function decodeRoomLeaveFrame(rawData) {
  const { buffer, view } = dataViewFor(rawData);
  if (buffer.byteLength !== ROOM_LEAVE_BYTES) return { ok: false, reason: "length" };
  if (view.getUint8(0) !== MSG.ROOM_LEAVE) return { ok: false, reason: "opcode" };
  if (view.getUint8(1) !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (view.getUint16(2, true) !== 0) return { ok: false, reason: "reserved" };
  return { ok: true };
}

function packWelcome(playerId) {
  const frame = Buffer.alloc(WELCOME_BYTES);
  frame.writeUInt8(MSG.WELCOME, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt16LE(playerId, 2);
  frame.writeUInt8(SIMULATION_HZ, 4);
  frame.writeUInt8(SNAPSHOT_HZ, 5);
  frame.writeUInt16LE(
    FEATURE_FLAGS.AUTHORITATIVE_MOVEMENT
      | FEATURE_FLAGS.AUTHORITATIVE_COMBAT
      | FEATURE_FLAGS.LAG_COMPENSATION
      | FEATURE_FLAGS.TEAM_ROOMS
      | FEATURE_FLAGS.NORMAL_MATCH_INSTANCES
      | FEATURE_FLAGS.MATCH_TICKETS,
    6,
  );
  return frame;
}

function writeRoomCode(frame, code, offset = 2) {
  frame.write(code, offset, ROOM_CODE_LENGTH, "ascii");
}

function utf8NameBytes(value) {
  let result = "";
  for (const character of String(value ?? "")) {
    const candidate = result + character;
    if (Buffer.byteLength(candidate, "utf8") > ROOM_PLAYER_NAME_BYTES) break;
    result = candidate;
  }
  return Buffer.from(result, "utf8");
}

export function packRoomStateFrame(snapshot, selfId) {
  const players = snapshot?.players || [];
  const frame = Buffer.alloc(
    ROOM_STATE_HEADER_BYTES + players.length * ROOM_STATE_PLAYER_BYTES,
  );
  frame.writeUInt8(MSG.ROOM_STATE, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  writeRoomCode(frame, snapshot.code);
  frame.writeUInt8(snapshot.phase, 8);
  frame.writeUInt8(players.length, 9);
  frame.writeUInt16LE(selfId, 10);
  frame.writeUInt8(snapshot.minPlayers, 12);
  frame.writeUInt8(snapshot.maxPlayers, 13);
  frame.writeUInt8(players.find((member) => member.id === selfId)?.team || TEAM.NONE, 14);
  frame.writeUInt8(0, 15);

  let offset = ROOM_STATE_HEADER_BYTES;
  for (const member of players) {
    const nameBytes = utf8NameBytes(member.displayName);
    let flags = 0;
    if (member.ready) flags |= ROOM_PLAYER_FLAGS.READY;
    if (member.authenticated) flags |= ROOM_PLAYER_FLAGS.AUTHENTICATED;
    frame.writeUInt16LE(member.id, offset);
    frame.writeUInt8(member.team, offset + 2);
    frame.writeUInt8(flags, offset + 3);
    frame.writeUInt16LE(Math.min(0xffff, member.joinIndex), offset + 4);
    frame.writeUInt8(nameBytes.length, offset + 6);
    frame.writeUInt8(0, offset + 7);
    nameBytes.copy(frame, offset + 8);
    offset += ROOM_STATE_PLAYER_BYTES;
  }
  return frame;
}

export function packRoomErrorFrame(errorCode) {
  const frame = Buffer.alloc(ROOM_ERROR_BYTES);
  frame.writeUInt8(MSG.ROOM_ERROR, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(errorCode || ROOM_ERROR.SERVER_ERROR, 2);
  frame.writeUInt8(0, 3);
  return frame;
}

export function packRoomLeftFrame() {
  const frame = Buffer.alloc(ROOM_LEFT_BYTES);
  frame.writeUInt8(MSG.ROOM_LEFT, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  return frame;
}

export function packMatchStartFrame(snapshot, member) {
  const frame = Buffer.alloc(MATCH_START_BYTES);
  frame.writeUInt8(MSG.MATCH_START, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  writeRoomCode(frame, snapshot.code);
  frame.writeUInt8(member?.team || TEAM.NONE, 8);
  frame.writeUInt8(snapshot.players.length, 9);
  frame.writeUInt16LE(0, 10);
  return frame;
}

export function packNormalMatchAssignedFrame(snapshot, member) {
  const frame = Buffer.alloc(NORMAL_MATCH_ASSIGNED_BYTES);
  frame.writeUInt8(MSG.NORMAL_MATCH_ASSIGNED, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt32LE(snapshot.id >>> 0, 2);
  frame.writeUInt8(member?.team || TEAM.NONE, 6);
  frame.writeUInt8(snapshot.players.length, 7);
  frame.writeUInt8(snapshot.maxPlayers, 8);
  frame.writeUInt8(snapshot.sealed ? 1 : 0, 9);
  frame.writeUInt16LE(0, 10);
  return frame;
}

export function packStateFrame(receiver, tickNumber, players, combatState = {}) {
  const frame = Buffer.alloc(STATE_HEADER_BYTES + players.length * STATE_PLAYER_BYTES);
  frame.writeUInt8(MSG.STATE, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt32LE(tickNumber >>> 0, 2);
  frame.writeUInt32LE(receiver.lastProcessedSeq >>> 0, 6);
  frame.writeUInt16LE(players.length, 10);
  frame.writeUInt16LE(combatState.ammo || 0, 12);
  frame.writeUInt16LE(combatState.reserveAmmo || 0, 14);
  frame.writeUInt16LE(combatState.reloadRemainingTicks || 0, 16);
  frame.writeUInt16LE(combatState.respawnRemainingTicks || 0, 18);
  frame.writeUInt8(combatState.flags || 0, 20);
  frame.writeUInt8(combatState.weaponNetId || receiver.weaponNetId || 0, 21);
  frame.writeUInt16LE(combatState.lifeId || 0, 22);

  let offset = STATE_HEADER_BYTES;
  for (const state of players) {
    frame.writeUInt16LE(state.id, offset);
    frame.writeUInt8(state.weaponNetId, offset + 2);
    frame.writeUInt8(Math.max(0, Math.min(100, state.health)), offset + 3);
    frame.writeUInt8(state.flags, offset + 4);
    frame.writeUInt8(state.grounded ? 1 : 0, offset + 5);
    frame.writeUInt16LE(state.lifeId || 0, offset + 6);
    frame.writeFloatLE(state.x, offset + 8);
    frame.writeFloatLE(state.y, offset + 12);
    frame.writeFloatLE(state.z, offset + 16);
    frame.writeFloatLE(state.velocityX, offset + 20);
    frame.writeFloatLE(state.velocityY, offset + 24);
    frame.writeFloatLE(state.velocityZ, offset + 28);
    frame.writeFloatLE(state.yaw, offset + 32);
    frame.writeFloatLE(state.pitch, offset + 36);
    frame.writeFloatLE(state.eyeHeight, offset + 40);
    offset += STATE_PLAYER_BYTES;
  }
  return frame;
}

export function packHitFrame(result) {
  const frame = Buffer.alloc(HIT_BYTES);
  frame.writeUInt8(MSG.HIT, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 1);
  frame.writeUInt8(result.status, 2);
  frame.writeUInt8(result.zone || 0, 3);
  frame.writeUInt32LE(result.shotSeq >>> 0, 4);
  frame.writeUInt32LE(result.serverTick >>> 0, 8);
  frame.writeUInt16LE(result.targetId || 0, 12);
  frame.writeUInt16LE(result.ammo || 0, 14);
  frame.writeUInt16LE(result.reserveAmmo || 0, 16);
  frame.writeUInt8(result.damage || 0, 18);
  frame.writeUInt8(result.targetHealth || 0, 19);
  frame.writeUInt16LE(result.reloadRemainingTicks || 0, 20);
  frame.writeUInt8(result.weaponNetId || 0, 22);
  frame.writeUInt8(0, 23);
  return frame;
}

function safeSend(ws, frame) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_PACKET_BUFFERED_BYTES) {
    return false;
  }
  ws.send(frame, { binary: true });
  return true;
}

function configuredOrigins() {
  return new Set(
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  const allowed = configuredOrigins();
  if (allowed.size > 0) return !!origin && allowed.has(origin);
  if (!origin) return process.env.NODE_ENV !== "production";

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.host === req.headers.host;
  } catch {
    return false;
  }
}

function remoteAddress(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
    if (isIP(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}

export async function createPotSparkServer(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const mapPath = path.resolve(options.mapPath || path.join(root, "assets/models/map_1.glb"));
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.PORT ?? 5186);

  let ownsWorld = false;
  let collision = null;
  let world = options.world;
  if (!world) {
    collision = await loadAuthoritativeCollision(mapPath, options.onCollisionProgress);
    world = new AuthoritativeWorld(collision.colliderSource);
    ownsWorld = true;
  }
  const teamRooms = options.teamRooms || new TeamRoomManager();
  const normalMatches = options.normalMatches || new NormalMatchManager();
  const ownsAuthSystem = !options.authSystem;
  const authHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  // ---------------------------------------------------------------------------
  // Step 1: Build the auth system first (it exposes _database / _databaseKind
  //         that ChatBridge needs to run its own migration).
  // ---------------------------------------------------------------------------
  const authSystem = options.authSystem || await createAuthSystem({
    root,
    baseURL: process.env.BETTER_AUTH_URL || `http://${authHost}:${port || 5186}`,
    databasePath: port === 0 ? ":memory:" : options.authDatabasePath,
    ...(options.authOptions || {}),
  });

  // ---------------------------------------------------------------------------
  // Step 2: Build ChatBridge (if env vars are set) and late-bind it into the
  //         auth system's handleGameApi closure via _setChatBridge.
  //         When SUPABASE_URL / SUPABASE_JWT_SECRET are absent the server
  //         starts normally with chat disabled — all existing tests pass.
  // ---------------------------------------------------------------------------
  let chatBridge = options.chatBridge ?? null;
  if (!chatBridge && process.env.SUPABASE_URL && process.env.SUPABASE_JWT_SECRET) {
    chatBridge = await createChatBridge({
      supabaseUrl: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY || "",
      jwtSecret: process.env.SUPABASE_JWT_SECRET,
      serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
      dbKind: authSystem._databaseKind,
      database: authSystem._database,
    }).catch((err) => {
      console.warn("[chatBridge] Failed to initialise — chat will be unavailable:", err.message);
      return null;
    });
  }
  if (chatBridge) authSystem._setChatBridge(chatBridge);

  // -------------------------------------------------------------------------
  // Chat lifecycle helpers (Phase 4)
  // All bridge calls are fire-and-forget: a Supabase error must never stall
  // or reject a room operation. fireChatHook() isolates that guarantee.
  // -------------------------------------------------------------------------

  /** Fires a chatBridge async call and swallows any error. */
  function fireChatHook(promise) {
    promise.catch((err) => {
      console.warn("[chatBridge] hook error:", err.message);
    });
  }

  /** Returns the Supabase channel key for a private room code. */
  function chatRoomKey(roomCode) {
    return `room:${roomCode}`;
  }

  /**
   * Resolves the stable Supabase UID for a client.
   * Returns null for guests (no userId) or when chatBridge is unavailable.
   * @param {{ userId: string | null }} client
   * @returns {Promise<string | null>}
   */
  async function chatClientUid(client) {
    if (!chatBridge || !client.userId) return null;
    return chatBridge.getSupabaseUid(client.userId);
  }

  const matchAuthTimeoutMs = Number(options.matchAuthTimeoutMs ?? MATCH_AUTH_TIMEOUT_MS);
  const reconnectGraceMs = Number(options.reconnectGraceMs ?? RECONNECT_GRACE_MS);

  const staticHandler = createStaticHandler(root);
  const httpServer = http.createServer((req, res) => {
    setSecurityHeaders(res);
    void (async () => {
      if (await authSystem.handleRequest(req, res)) return;
      await staticHandler(req, res);
    })().catch((error) => {
      console.error("[http] request failure", error);
      if (!res.headersSent) sendText(res, 500, "Internal server error");
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_FRAME_BYTES,
    perMessageDeflate: false,
  });

  const clients = new Map();
  const principalClients = new Map();
  const pendingSockets = new Set();
  const connectionCounts = new Map();
  let nextPlayerId = 1;
  let running = false;
  let stopped = false;
  let loopTimer = null;
  let heartbeatTimer = null;
  let previousLoopTime = 0;
  let accumulatorMs = 0;

  function allocatePlayerId() {
    for (let attempts = 0; attempts < 0xffff; attempts += 1) {
      const candidate = nextPlayerId;
      nextPlayerId = nextPlayerId >= 0xffff ? 1 : nextPlayerId + 1;
      if (!clients.has(candidate)) return candidate;
    }
    return null;
  }

  authSystem.setBindingProvider((principalKey) => {
    const client = principalClients.get(principalKey);
    if (!client) return null;
    const player = world.getPlayer(client.id);
    if (!player) return null;
    const privateRoom = teamRooms.getRoomForPlayer(client.id);
    const normalMatch = normalMatches.getMatchForPlayer(client.id);
    return {
      playerId: client.id,
      roomId: privateRoom?.code || null,
      matchId: normalMatch?.scopeKey || null,
      team: player.team,
      inGame: player.inGame,
    };
  });

  function recordViolation(client, weight, reason) {
    client.violationScore += weight;
    if (client.violationScore >= 8 && client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(1008, "Invalid client traffic");
      console.warn(`[security] disconnected player ${client.id}: ${reason}`);
    }
  }

  function sendRoomError(client, errorCode) {
    safeSend(client.ws, packRoomErrorFrame(errorCode));
  }

  function consumeRoomOperation(client, now = performance.now()) {
    const elapsedSeconds = Math.max(0, now - client.lastRoomTokenRefillAt) / 1000;
    client.roomOpTokens = Math.min(
      ROOM_OP_TOKEN_CAPACITY,
      client.roomOpTokens + elapsedSeconds * ROOM_OP_TOKEN_RATE,
    );
    client.lastRoomTokenRefillAt = now;
    if (client.roomOpTokens < 1) {
      sendRoomError(client, ROOM_ERROR.RATE_LIMIT);
      return false;
    }
    client.roomOpTokens -= 1;
    return true;
  }

  function broadcastRoomState(room) {
    const snapshot = teamRooms.snapshot(room);
    if (!snapshot) return null;
    for (const member of snapshot.players) {
      const client = clients.get(member.id);
      if (client) safeSend(client.ws, packRoomStateFrame(snapshot, member.id));
    }
    return snapshot;
  }

  function broadcastMatchStart(room) {
    const snapshot = teamRooms.snapshot(room);
    if (!snapshot) return;
    for (const member of snapshot.players) {
      const client = clients.get(member.id);
      if (client) safeSend(client.ws, packMatchStartFrame(snapshot, member));
    }
  }

  function sendSnapshots() {
    for (const client of clients.values()) {
      const receiver = world.getPlayer(client.id);
      if (!receiver?.inGame) continue;
      const states = world.getSnapshotPlayers(receiver);
      safeSend(client.ws, packStateFrame(
        receiver,
        world.tickNumber,
        states,
        world.getCombatSnapshot(receiver),
      ));
    }
  }

  function sendCombatEvents() {
    for (const event of world.drainCombatEvents()) {
      const client = clients.get(event.shooterId);
      if (client) safeSend(client.ws, packHitFrame(event));
    }
  }

  function simulationLoop() {
    if (!running) return;
    const now = performance.now();
    const elapsed = Math.min(250, Math.max(0, now - previousLoopTime));
    previousLoopTime = now;
    accumulatorMs += elapsed;
    const fixedMs = SIMULATION_DT * 1000;

    let steps = 0;
    while (accumulatorMs >= fixedMs && steps < MAX_CATCH_UP_STEPS) {
      world.step(SIMULATION_DT);
      sendCombatEvents();
      accumulatorMs -= fixedMs;
      steps += 1;
      if (world.tickNumber % SNAPSHOT_EVERY_TICKS === 0) sendSnapshots();
    }
    if (steps === MAX_CATCH_UP_STEPS && accumulatorMs >= fixedMs) {
      accumulatorMs = 0;
    }

    loopTimer = setTimeout(simulationLoop, Math.max(1, fixedMs - accumulatorMs));
  }

  function decrementConnectionCount(ip) {
    const remaining = Math.max(0, (connectionCounts.get(ip) || 1) - 1);
    if (remaining === 0) connectionCounts.delete(ip);
    else connectionCounts.set(ip, remaining);
  }

  function sendCommittedContext(client) {
    const privateRoom = teamRooms.getRoomForPlayer(client.id);
    if (privateRoom) {
      const snapshot = teamRooms.snapshot(privateRoom);
      const member = teamRooms.getMember(client.id);
      safeSend(client.ws, packRoomStateFrame(snapshot, client.id));
      if (teamRooms.canEnterGame(client.id)) {
        safeSend(client.ws, packMatchStartFrame(snapshot, member));
      }
      return;
    }
    const normalMatch = normalMatches.getMatchForPlayer(client.id);
    if (normalMatch) {
      const snapshot = normalMatches.snapshot(normalMatch);
      safeSend(
        client.ws,
        packNormalMatchAssignedFrame(snapshot, normalMatches.getMember(client.id)),
      );
    }
  }

  function bindingMatchesClient(binding, client) {
    if (!binding) return true;
    if (binding.playerId !== client.id) return false;
    const player = world.getPlayer(client.id);
    const privateRoom = teamRooms.getRoomForPlayer(client.id);
    const normalMatch = normalMatches.getMatchForPlayer(client.id);
    return (binding.roomId || null) === (privateRoom?.code || null)
      && (binding.matchId || null) === (normalMatch?.scopeKey || null)
      && Number(binding.team || 0) === Number(player?.team || 0)
      && binding.inGame === (player?.inGame === true);
  }

  function finalizeClient(client, closeCode = 1000, closeReason = "Session ended") {
    if (!client || client.finalized) return;
    client.finalized = true;
    clearTimeout(client.disconnectTimer);
    clients.delete(client.id);
    if (principalClients.get(client.principalKey) === client) {
      principalClients.delete(client.principalKey);
    }
    const roomResult = teamRooms.disconnectPlayer(client.id);
    if (roomResult && !roomResult.deleted) broadcastRoomState(roomResult.room);
    // Phase 4: remove player from room chat channel on disconnect.
    if (roomResult) {
      fireChatHook(
        chatClientUid(client).then((uid) => {
          if (!chatBridge) return;
          const key = chatRoomKey(roomResult.room.code);
          if (roomResult.deleted) return chatBridge.archiveChannel(key);
          if (uid) return chatBridge.removeMember(key, uid);
        }),
      );
    }
    normalMatches.disconnectPlayer(client.id);
    world.removePlayer(client.id);
    if (client.ws?.readyState === WebSocket.OPEN) {
      client.ws.close(closeCode, closeReason);
    }
    console.info(`[net] player ${client.id} released (${clients.size} seats retained/online)`);
  }

  function scheduleReconnectExpiry(client) {
    clearTimeout(client.disconnectTimer);
    client.disconnectTimer = setTimeout(() => {
      if (!client.connected) finalizeClient(client, 1000, "Reconnect grace expired");
    }, reconnectGraceMs);
    client.disconnectTimer.unref?.();
  }

  function activateClient(ws, req, ticket) {
    const principal = req.potsparkPrincipal;
    const injectedUsername = typeof options.resolveAuthenticatedUsername === "function"
      ? sanitizeAuthenticatedUsername(options.resolveAuthenticatedUsername(req))
      : null;
    const authenticatedUsername = principal.authenticated ? principal.username : injectedUsername;
    let client = principalClients.get(principal.principalKey) || null;
    if (client) {
      if (!bindingMatchesClient(ticket.binding, client)) return null;
      const replacedSocket = client.ws;
      clearTimeout(client.disconnectTimer);
      client.ws = ws;
      client.ip = remoteAddress(req);
      client.connected = true;
      client.finalized = false;
      client.sessionId = principal.sessionId;
      client.userId = principal.userId;
      client.authenticatedUsername = authenticatedUsername;
      client.connectionEpoch = ticket.connectionEpoch;
      client.violationScore = 0;
      client.roomOpTokens = ROOM_OP_TOKEN_CAPACITY;
      client.lastRoomTokenRefillAt = performance.now();
      world.resetConnectionEpoch(client.id);
      if (replacedSocket && replacedSocket !== ws && replacedSocket.readyState === WebSocket.OPEN) {
        replacedSocket.close(4001, "Replaced by a newer connection");
      }
    } else {
      if (ticket.binding?.playerId != null) return null;
      const id = allocatePlayerId();
      if (id == null) return null;
      client = {
        id,
        ip: remoteAddress(req),
        ws,
        connected: true,
        finalized: false,
        disconnectTimer: null,
        principalKey: principal.principalKey,
        sessionId: principal.sessionId,
        userId: principal.userId,
        connectionEpoch: ticket.connectionEpoch,
        violationScore: 0,
        authenticatedUsername,
        roomOpTokens: ROOM_OP_TOKEN_CAPACITY,
        lastRoomTokenRefillAt: performance.now(),
      };
      clients.set(id, client);
      principalClients.set(principal.principalKey, client);
      world.addPlayer(id);
    }
    safeSend(ws, packWelcome(client.id));
    sendCommittedContext(client);
    console.info(`[net] player ${client.id} admitted (${clients.size} seats retained/online)`);
    return client;
  }

  const removeSessionListener = authSystem.onSessionRevoked(({ sessionId }) => {
    for (const client of clients.values()) {
      if (client.sessionId === sessionId) finalizeClient(client, 4403, "Session revoked");
    }
  });
  const removeUserListener = authSystem.onUserRevoked(({ userId }) => {
    for (const client of clients.values()) {
      if (client.userId === userId) finalizeClient(client, 4403, "Account unavailable");
    }
    // Phase 4: revoke the user from all Supabase chat channels.
    // We call getSupabaseUid directly via chatBridge since the client may
    // already be finalized (userId → supabaseUid mapping is in the local DB).
    if (chatBridge && userId) {
      fireChatHook(
        chatBridge.getSupabaseUid(userId).then((uid) => {
          if (uid) return chatBridge.revokeUser(uid);
        }),
      );
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const rawUpgradeURL = req.url || "";
      const upgradePath = rawUpgradeURL.split("?")[0];
      const ip = remoteAddress(req);
      const connectionCount = connectionCounts.get(ip) || 0;
      const principal = await authSystem.resolvePrincipal(req);
      const isResume = principal && principalClients.has(principal.principalKey);
      if (
        upgradePath !== "/game"
        || rawUpgradeURL.includes("?")
        || !isAllowedOrigin(req)
        || !principal
        || connectionCount >= MAX_CONNECTIONS_PER_IP
        || (clients.size >= MAX_PLAYERS && !isResume)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      req.potsparkPrincipal = principal;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxRequestsPerSocket = 1_000;

  function handleAuthenticatedFrame(client, ws, rawData, isBinary) {
      const id = client.id;
      if (!client.connected || client.ws !== ws || client.finalized) return;
      if (!isBinary) {
        recordViolation(client, 2, "text frame");
        return;
      }
      const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
      if (buffer.byteLength < 2 || buffer.byteLength > MAX_INBOUND_FRAME_BYTES) {
        recordViolation(client, 2, "frame size");
        return;
      }

      const opcode = buffer.readUInt8(0);
      if (opcode === MSG.ROOM_CREATE) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeRoomCreateFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `room-create ${decoded.reason}`);
          return;
        }
        if (world.getPlayer(id)?.inGame) {
          sendRoomError(client, ROOM_ERROR.MATCH_STARTED);
          return;
        }
        if (normalMatches.hasPlayer(id)) {
          sendRoomError(client, ROOM_ERROR.ALREADY_MATCHMADE);
          return;
        }
        const result = teamRooms.createRoom(id, client.authenticatedUsername);
        if (!result.ok) {
          sendRoomError(client, result.error);
          return;
        }
        if (!world.assignPlayerRoom(id, result.room.code, result.member.team)) {
          teamRooms.leaveRoom(id, { force: true });
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }
        // Phase 4: add creator to the room chat channel (fire-and-forget).
        fireChatHook(
          chatClientUid(client).then((uid) => {
            if (uid) return chatBridge?.addMember(chatRoomKey(result.room.code), uid);
          }),
        );
        broadcastRoomState(result.room);
        return;
      }

      if (opcode === MSG.ROOM_JOIN) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeRoomJoinFrame(buffer);
        if (!decoded.ok) {
          if (decoded.reason === "code") sendRoomError(client, ROOM_ERROR.INVALID_CODE);
          else recordViolation(client, 1, `room-join ${decoded.reason}`);
          return;
        }
        if (world.getPlayer(id)?.inGame) {
          sendRoomError(client, ROOM_ERROR.MATCH_STARTED);
          return;
        }
        if (normalMatches.hasPlayer(id)) {
          sendRoomError(client, ROOM_ERROR.ALREADY_MATCHMADE);
          return;
        }
        const result = teamRooms.joinRoom(id, decoded.code, client.authenticatedUsername);
        if (!result.ok) {
          sendRoomError(client, result.error);
          return;
        }
        if (!world.assignPlayerRoom(id, result.room.code, result.member.team)) {
          teamRooms.leaveRoom(id, { force: true });
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }
        // Phase 4: add joiner to the room chat channel (fire-and-forget).
        fireChatHook(
          chatClientUid(client).then((uid) => {
            if (uid) return chatBridge?.addMember(chatRoomKey(result.room.code), uid);
          }),
        );
        broadcastRoomState(result.room);
        return;
      }

      if (opcode === MSG.ROOM_READY) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeRoomReadyFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `room-ready ${decoded.reason}`);
          return;
        }
        const result = teamRooms.setReady(id, decoded.ready);
        if (!result.ok) {
          sendRoomError(client, result.error);
          return;
        }
        broadcastRoomState(result.room);
        if (result.started) broadcastMatchStart(result.room);
        return;
      }

      if (opcode === MSG.ROOM_TEAM_SWITCH) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeRoomTeamSwitchFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `room-team-switch ${decoded.reason}`);
          return;
        }
        const result = teamRooms.switchTeam(id, decoded.targetTeam);
        if (!result.ok) {
          sendRoomError(client, result.error);
          return;
        }
        if (result.changed && !world.assignPlayerRoom(id, result.room.code, result.member.team)) {
          result.member.team = result.previousTeam;
          result.member.ready = result.previousReady;
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }
        broadcastRoomState(result.room);
        return;
      }

      if (opcode === MSG.ROOM_LEAVE) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeRoomLeaveFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `room-leave ${decoded.reason}`);
          return;
        }
        const result = teamRooms.leaveRoom(id);
        if (!result.ok) {
          sendRoomError(client, result.error);
          return;
        }
        world.assignPlayerRoom(id, null, TEAM.NONE);
        safeSend(client.ws, packRoomLeftFrame());
        // Phase 4: remove member from room chat channel; archive if room is gone.
        fireChatHook(
          chatClientUid(client).then((uid) => {
            if (!chatBridge) return;
            const key = chatRoomKey(result.room.code);
            if (result.deleted) return chatBridge.archiveChannel(key);
            if (uid) return chatBridge.removeMember(key, uid);
          }),
        );
        if (!result.deleted) broadcastRoomState(result.room);
        return;
      }

      if (opcode === MSG.NORMAL_MATCH_JOIN) {
        if (!consumeRoomOperation(client)) return;
        const decoded = decodeNormalMatchJoinFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `normal-match-join ${decoded.reason}`);
          return;
        }
        if (teamRooms.getRoomForPlayer(id)) {
          sendRoomError(client, ROOM_ERROR.ALREADY_IN_ROOM);
          return;
        }
        if (world.getPlayer(id)?.inGame) {
          sendRoomError(client, ROOM_ERROR.MATCH_STARTED);
          return;
        }

        let result;
        try {
          result = normalMatches.joinMatch(id, client.authenticatedUsername);
        } catch (error) {
          console.error(`[matchmaking] failed to allocate player ${id}`, error);
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }
        if (!result.ok) {
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }
        if (!world.assignPlayerRoom(id, result.match.scopeKey, result.member.team)) {
          if (!result.existing) normalMatches.leaveMatch(id);
          sendRoomError(client, ROOM_ERROR.SERVER_ERROR);
          return;
        }

        const snapshot = normalMatches.snapshot(result.match);
        safeSend(client.ws, packNormalMatchAssignedFrame(snapshot, result.member));
        return;
      }

      if (opcode === MSG.INPUT) {
        const decoded = decodeInputFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1.5, `input ${decoded.reason}`);
          return;
        }
        const result = world.submitInput(id, decoded.command);
        if (!result.ok && result.reason !== "not-in-game") {
          recordViolation(client, result.reason === "rate-limit" ? 0.2 : 0.75, result.reason);
        }
        return;
      }

      if (opcode === MSG.ENTER_GAME) {
        const decoded = decodeEnterGameFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1.5, `enter-game ${decoded.reason || "weapon"}`);
          return;
        }
        const privateRoom = teamRooms.getRoomForPlayer(id);
        if (privateRoom && !teamRooms.canEnterGame(id)) {
          sendRoomError(client, ROOM_ERROR.NEED_MORE_PLAYERS);
          return;
        }
        if (!privateRoom && !normalMatches.canEnterGame(id)) {
          sendRoomError(client, ROOM_ERROR.MATCHMAKING_REQUIRED);
          return;
        }
        if (!world.enterGame(id, decoded.weaponNetId)) {
          recordViolation(client, 1.5, "enter-game weapon");
        }
        return;
      }

      if (opcode === MSG.PING) {
        if (
          buffer.byteLength !== PING_BYTES
          || buffer.readUInt8(1) !== PROTOCOL_VERSION
        ) {
          recordViolation(client, 0.5, "ping frame");
          return;
        }
        const pong = Buffer.from(buffer);
        pong.writeUInt8(MSG.PONG, 0);
        safeSend(ws, pong);
        return;
      }

      if (opcode === MSG.SHOT) {
        const decoded = decodeShotFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1.5, `shot ${decoded.reason}`);
          return;
        }
        const result = world.submitShot(id, decoded.request);
        if (!result.ok && result.reason !== "not-in-game") {
          const weight = result.reason === "rate-limit" ? 0.25 : 0.8;
          recordViolation(client, weight, `shot ${result.reason}`);
        }
        return;
      }

      if (opcode === MSG.RELOAD) {
        const decoded = decodeReloadFrame(buffer);
        if (!decoded.ok) {
          recordViolation(client, 1, `reload ${decoded.reason}`);
          return;
        }
        const result = world.submitReload(id, decoded.requestSeq);
        if (!result.ok && result.reason !== "not-in-game") {
          recordViolation(client, 0.75, `reload ${result.reason}`);
        }
        return;
      }

      recordViolation(client, 1, `unknown opcode ${opcode}`);
  }

  wss.on("connection", (ws, req) => {
    const ip = remoteAddress(req);
    connectionCounts.set(ip, (connectionCounts.get(ip) || 0) + 1);
    pendingSockets.add(ws);
    ws.isAlive = true;

    let client = null;
    let authenticating = false;
    let connectionCounted = true;
    const authTimer = setTimeout(() => {
      if (!client && ws.readyState === WebSocket.OPEN) {
        ws.close(4401, "Match ticket required");
      }
    }, matchAuthTimeoutMs);
    authTimer.unref?.();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (rawData, isBinary) => {
      if (client) {
        handleAuthenticatedFrame(client, ws, rawData, isBinary);
        return;
      }
      if (authenticating || !isBinary) {
        ws.close(4401, "Invalid match admission");
        return;
      }

      const decoded = decodeAuthTicketFrame(rawData);
      if (!decoded.ok) {
        ws.close(4401, "Invalid match admission");
        return;
      }

      authenticating = true;
      void authSystem.consumeMatchTicket(decoded.ticket, req.potsparkPrincipal)
        .then((ticket) => {
          if (!ticket || ws.readyState !== WebSocket.OPEN) {
            if (ws.readyState === WebSocket.OPEN) ws.close(4401, "Invalid match ticket");
            return;
          }
          client = activateClient(ws, req, ticket);
          if (!client) {
            ws.close(4403, "Match context changed");
            return;
          }
          clearTimeout(authTimer);
          pendingSockets.delete(ws);
        })
        .catch(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Admission unavailable");
        })
        .finally(() => {
          authenticating = false;
        });
    });

    ws.on("close", (code) => {
      clearTimeout(authTimer);
      pendingSockets.delete(ws);
      if (connectionCounted) {
        connectionCounted = false;
        decrementConnectionCount(ip);
      }
      if (!client || client.ws !== ws || client.finalized) return;

      client.connected = false;
      world.neutralizePlayerInput(client.id);
      if ([1000, 1002, 1003, 1007, 1008, 1009, 4000, 4403].includes(code)) {
        finalizeClient(client, 1000, "Connection ended");
      } else {
        scheduleReconnectExpiry(client);
        console.info(`[net] player ${client.id} disconnected; seat held for reconnect`);
      }
    });

    ws.on("error", (error) => {
      const label = client ? `player ${client.id}` : "pending connection";
      console.warn(`[net] socket error for ${label}: ${error.message}`);
    });
  });

  async function start() {
    if (stopped) throw new Error("Server has already stopped");
    if (running) return httpServer.address();
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(port, host, () => {
        httpServer.off("error", onError);
        resolve();
      });
    });
    running = true;
    previousLoopTime = performance.now();
    simulationLoop();
    heartbeatTimer = setInterval(() => {
      for (const client of clients.values()) {
        if (!client.connected || client.ws.readyState !== WebSocket.OPEN) continue;
        if (!client.ws.isAlive) {
          client.ws.terminate();
          continue;
        }
        client.ws.isAlive = false;
        client.ws.ping();
      }
      for (const ws of pendingSockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    return httpServer.address();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    removeSessionListener();
    removeUserListener();
    for (const client of clients.values()) clearTimeout(client.disconnectTimer);
    if (running) {
      running = false;
      clearTimeout(loopTimer);
      clearInterval(heartbeatTimer);
      for (const client of [...clients.values()]) {
        finalizeClient(client, 1001, "Server stopping");
      }
      for (const ws of pendingSockets) ws.close(1001, "Server stopping");
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
    if (ownsWorld) {
      world.dispose();
      collision?.colliderSource.disposeColliders();
    }
    if (ownsAuthSystem) await authSystem.close();
  }

  return {
    root,
    world,
    httpServer,
    wss,
    clients,
    principalClients,
    authSystem,
    teamRooms,
    normalMatches,
    chatBridge,
    start,
    stop,
  };
}
