import { randomInt } from "node:crypto";

import {
  ROOM_ERROR,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  ROOM_PHASE,
  ROOM_TEAM_CAPACITY,
  TEAM,
  isValidRoomCode,
  normalizeRoomCode,
} from "../js/protocol.js";

// I, O, 0, and 1 are deliberately omitted so codes remain easy to read aloud.
// Every code still contains characters from the requested A-Z + 0-9 space.
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_DIGITS = "23456789";
const DEFAULT_CODE_ALPHABET = `${CODE_LETTERS}${CODE_DIGITS}`;
const MAX_CODE_ATTEMPTS = 128;
const MAX_USERNAME_CHARACTERS = 24;

function defaultCodeGenerator() {
  const characters = [
    CODE_LETTERS[randomInt(CODE_LETTERS.length)],
    CODE_DIGITS[randomInt(CODE_DIGITS.length)],
  ];
  while (characters.length < 6) {
    characters.push(DEFAULT_CODE_ALPHABET[randomInt(DEFAULT_CODE_ALPHABET.length)]);
  }
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

export function sanitizeAuthenticatedUsername(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return [...normalized].slice(0, MAX_USERNAME_CHARACTERS).join("");
}

export class TeamRoomManager {
  constructor(options = {}) {
    this.maxPlayers = options.maxPlayers ?? ROOM_MAX_PLAYERS;
    this.minPlayers = options.minPlayers ?? ROOM_MIN_PLAYERS;
    this.teamCapacity = options.teamCapacity ?? ROOM_TEAM_CAPACITY;
    this.codeGenerator = options.codeGenerator || defaultCodeGenerator;
    this.rooms = new Map();
    this.playerRooms = new Map();
  }

  createRoom(playerId, authenticatedUsername = null) {
    if (this.playerRooms.has(playerId)) {
      return { ok: false, error: ROOM_ERROR.ALREADY_IN_ROOM };
    }

    let code = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = normalizeRoomCode(this.codeGenerator());
      if (isValidRoomCode(candidate) && !this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) return { ok: false, error: ROOM_ERROR.SERVER_ERROR };

    const room = {
      code,
      phase: ROOM_PHASE.LOBBY,
      members: new Map(),
      nextJoinIndex: 1,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    const member = this.addMember(room, playerId, authenticatedUsername);
    return { ok: true, room, member, started: false };
  }

  joinRoom(playerId, rawCode, authenticatedUsername = null) {
    if (this.playerRooms.has(playerId)) {
      return { ok: false, error: ROOM_ERROR.ALREADY_IN_ROOM };
    }

    const code = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(code)) {
      return { ok: false, error: ROOM_ERROR.INVALID_CODE };
    }
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: ROOM_ERROR.NOT_FOUND };
    if (room.phase !== ROOM_PHASE.LOBBY) {
      return { ok: false, error: ROOM_ERROR.MATCH_STARTED };
    }
    if (room.members.size >= this.maxPlayers) {
      return { ok: false, error: ROOM_ERROR.FULL };
    }

    const member = this.addMember(room, playerId, authenticatedUsername);
    if (!member) return { ok: false, error: ROOM_ERROR.FULL };
    return { ok: true, room, member, started: false };
  }

  setReady(playerId, ready) {
    const room = this.getRoomForPlayer(playerId);
    if (!room) return { ok: false, error: ROOM_ERROR.NOT_IN_ROOM };
    if (room.phase !== ROOM_PHASE.LOBBY) {
      return { ok: false, error: ROOM_ERROR.MATCH_STARTED };
    }

    const member = room.members.get(playerId);
    member.ready = ready === true;
    const started = room.members.size >= this.minPlayers
      && this.hasPlayersOnBothTeams(room)
      && [...room.members.values()].every((entry) => entry.ready);
    if (started) room.phase = ROOM_PHASE.IN_MATCH;
    return { ok: true, room, member, started };
  }

  switchTeam(playerId, targetTeam) {
    const room = this.getRoomForPlayer(playerId);
    if (!room) return { ok: false, error: ROOM_ERROR.NOT_IN_ROOM };
    if (room.phase !== ROOM_PHASE.LOBBY) {
      return { ok: false, error: ROOM_ERROR.MATCH_STARTED };
    }
    if (targetTeam !== TEAM.CRAZIES && targetTeam !== TEAM.MADDIES) {
      return { ok: false, error: ROOM_ERROR.SERVER_ERROR };
    }

    const member = room.members.get(playerId);
    if (!member) return { ok: false, error: ROOM_ERROR.NOT_IN_ROOM };
    if (member.team === targetTeam) {
      return { ok: true, room, member, changed: false };
    }
    if (this.teamCount(room, targetTeam) >= this.teamCapacity) {
      return { ok: false, error: ROOM_ERROR.TEAM_FULL };
    }

    const previousTeam = member.team;
    const previousReady = member.ready;
    member.team = targetTeam;
    // A side change invalidates the player's prior lock-in. The room cannot
    // deploy until this player explicitly confirms readiness again.
    member.ready = false;
    return {
      ok: true,
      room,
      member,
      changed: true,
      previousTeam,
      previousReady,
    };
  }

  leaveRoom(playerId, options = {}) {
    const room = this.getRoomForPlayer(playerId);
    if (!room) return { ok: false, error: ROOM_ERROR.NOT_IN_ROOM };
    if (room.phase === ROOM_PHASE.IN_MATCH && !options.force) {
      return { ok: false, error: ROOM_ERROR.MATCH_STARTED };
    }

    const member = room.members.get(playerId) || null;
    room.members.delete(playerId);
    this.playerRooms.delete(playerId);
    if (room.members.size === 0) this.rooms.delete(room.code);
    return { ok: true, room, member, deleted: room.members.size === 0 };
  }

  disconnectPlayer(playerId) {
    if (!this.playerRooms.has(playerId)) return null;
    return this.leaveRoom(playerId, { force: true });
  }

  getRoom(code) {
    return this.rooms.get(normalizeRoomCode(code)) || null;
  }

  getRoomForPlayer(playerId) {
    const code = this.playerRooms.get(playerId);
    return code ? this.rooms.get(code) || null : null;
  }

  getMember(playerId) {
    return this.getRoomForPlayer(playerId)?.members.get(playerId) || null;
  }

  canEnterGame(playerId) {
    const room = this.getRoomForPlayer(playerId);
    return !room || room.phase === ROOM_PHASE.IN_MATCH;
  }

  snapshot(roomOrCode) {
    const room = typeof roomOrCode === "string" ? this.getRoom(roomOrCode) : roomOrCode;
    if (!room) return null;
    return {
      code: room.code,
      phase: room.phase,
      minPlayers: this.minPlayers,
      maxPlayers: this.maxPlayers,
      players: [...room.members.values()]
        .sort((left, right) => left.joinIndex - right.joinIndex)
        .map((member) => ({ ...member })),
    };
  }

  addMember(room, playerId, authenticatedUsername) {
    const crazies = this.teamCount(room, TEAM.CRAZIES);
    const maddies = this.teamCount(room, TEAM.MADDIES);
    let team = crazies <= maddies ? TEAM.CRAZIES : TEAM.MADDIES;
    if (this.teamCount(room, team) >= this.teamCapacity) {
      team = team === TEAM.CRAZIES ? TEAM.MADDIES : TEAM.CRAZIES;
    }
    if (this.teamCount(room, team) >= this.teamCapacity) return null;

    const joinIndex = room.nextJoinIndex;
    room.nextJoinIndex += 1;
    const username = sanitizeAuthenticatedUsername(authenticatedUsername);
    const member = {
      id: playerId,
      team,
      ready: false,
      authenticated: !!username,
      joinIndex,
      displayName: username || `Player ${joinIndex}`,
    };
    room.members.set(playerId, member);
    this.playerRooms.set(playerId, room.code);
    return member;
  }

  teamCount(room, team) {
    let count = 0;
    for (const member of room.members.values()) {
      if (member.team === team) count += 1;
    }
    return count;
  }

  hasPlayersOnBothTeams(room) {
    return this.teamCount(room, TEAM.CRAZIES) > 0
      && this.teamCount(room, TEAM.MADDIES) > 0;
  }
}
