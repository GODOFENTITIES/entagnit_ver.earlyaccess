import {
  NORMAL_MATCH_MAX_PLAYERS,
  NORMAL_MATCH_TEAM_CAPACITY,
  TEAM,
} from "../js/protocol.js";
import { sanitizeAuthenticatedUsername } from "./teamRooms.js";

const MAX_INSTANCE_ID = 0xffffffff;

/**
 * Small in-memory allocator for ordinary public matches.
 *
 * There is exactly one fillable instance at a time. Once it reaches 10
 * players it is sealed permanently and the next join creates another one.
 * This keeps allocation deterministic and prevents players being moved
 * between live matches when somebody disconnects.
 */
export class NormalMatchManager {
  constructor(options = {}) {
    this.maxPlayers = options.maxPlayers ?? NORMAL_MATCH_MAX_PLAYERS;
    this.teamCapacity = options.teamCapacity ?? NORMAL_MATCH_TEAM_CAPACITY;
    if (
      !Number.isInteger(this.maxPlayers)
      || this.maxPlayers < 2
      || !Number.isInteger(this.teamCapacity)
      || this.teamCapacity < 1
      || this.teamCapacity * 2 !== this.maxPlayers
    ) {
      throw new RangeError("Normal matches require two equal teams");
    }

    this.matches = new Map();
    this.playerMatches = new Map();
    this.openMatchId = null;
    this.nextInstanceId = 1;
  }

  joinMatch(playerId, authenticatedUsername = null) {
    const existing = this.getMatchForPlayer(playerId);
    if (existing) {
      return {
        ok: true,
        match: existing,
        member: existing.members.get(playerId),
        created: false,
        existing: true,
        becameFull: false,
      };
    }

    let match = this.openMatchId == null ? null : this.matches.get(this.openMatchId);
    if (!match || match.sealed || match.members.size >= this.maxPlayers) {
      match = this.createMatch();
    }

    const member = this.addMember(match, playerId, authenticatedUsername);
    if (!member) return { ok: false, reason: "full" };

    const becameFull = match.members.size === this.maxPlayers;
    if (becameFull) {
      match.sealed = true;
      if (this.openMatchId === match.id) this.openMatchId = null;
    }

    return {
      ok: true,
      match,
      member,
      created: member.joinIndex === 1,
      existing: false,
      becameFull,
    };
  }

  leaveMatch(playerId) {
    const match = this.getMatchForPlayer(playerId);
    if (!match) return null;

    const member = match.members.get(playerId) || null;
    match.members.delete(playerId);
    this.playerMatches.delete(playerId);

    if (match.members.size === 0) {
      this.matches.delete(match.id);
      if (this.openMatchId === match.id) this.openMatchId = null;
    }

    return {
      ok: true,
      match,
      member,
      deleted: match.members.size === 0,
    };
  }

  disconnectPlayer(playerId) {
    return this.leaveMatch(playerId);
  }

  getMatch(instanceId) {
    return this.matches.get(instanceId) || null;
  }

  getMatchForPlayer(playerId) {
    const instanceId = this.playerMatches.get(playerId);
    return instanceId == null ? null : this.matches.get(instanceId) || null;
  }

  getMember(playerId) {
    return this.getMatchForPlayer(playerId)?.members.get(playerId) || null;
  }

  hasPlayer(playerId) {
    return this.playerMatches.has(playerId);
  }

  canEnterGame(playerId) {
    return this.hasPlayer(playerId);
  }

  snapshot(matchOrId) {
    const match = typeof matchOrId === "number" ? this.getMatch(matchOrId) : matchOrId;
    if (!match) return null;
    return {
      id: match.id,
      scopeKey: match.scopeKey,
      sealed: match.sealed,
      maxPlayers: this.maxPlayers,
      players: [...match.members.values()]
        .sort((left, right) => left.joinIndex - right.joinIndex)
        .map((member) => ({ ...member })),
    };
  }

  createMatch() {
    const id = this.allocateInstanceId();
    if (id == null) throw new Error("No normal match instance ids are available");
    const match = {
      id,
      scopeKey: `normal:${id}`,
      sealed: false,
      members: new Map(),
      nextJoinIndex: 1,
      createdAt: Date.now(),
    };
    this.matches.set(id, match);
    this.openMatchId = id;
    return match;
  }

  allocateInstanceId() {
    for (let attempts = 0; attempts < MAX_INSTANCE_ID; attempts += 1) {
      const candidate = this.nextInstanceId;
      this.nextInstanceId = candidate >= MAX_INSTANCE_ID ? 1 : candidate + 1;
      if (!this.matches.has(candidate)) return candidate;
    }
    return null;
  }

  addMember(match, playerId, authenticatedUsername) {
    const crazies = this.teamCount(match, TEAM.CRAZIES);
    const maddies = this.teamCount(match, TEAM.MADDIES);
    let team = crazies <= maddies ? TEAM.CRAZIES : TEAM.MADDIES;
    if (this.teamCount(match, team) >= this.teamCapacity) {
      team = team === TEAM.CRAZIES ? TEAM.MADDIES : TEAM.CRAZIES;
    }
    if (this.teamCount(match, team) >= this.teamCapacity) return null;

    const joinIndex = match.nextJoinIndex;
    match.nextJoinIndex += 1;
    const username = sanitizeAuthenticatedUsername(authenticatedUsername);
    const member = {
      id: playerId,
      team,
      joinIndex,
      authenticated: !!username,
      displayName: username || `Player ${joinIndex}`,
    };
    match.members.set(playerId, member);
    this.playerMatches.set(playerId, match.id);
    return member;
  }

  teamCount(match, team) {
    let count = 0;
    for (const member of match.members.values()) {
      if (member.team === team) count += 1;
    }
    return count;
  }
}
