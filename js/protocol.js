/**
 * PotSpark wire protocol v8.
 *
 * Movement commands intentionally contain no position, velocity, or elapsed
 * time. Shot commands intentionally contain no target, origin, hit zone,
 * damage, ammo, or client timestamp. Those values are owned by the server.
 */

export const PROTOCOL_VERSION = 8;
export const SIMULATION_HZ = 60;
export const SNAPSHOT_HZ = 20;
export const SIMULATION_DT = 1 / SIMULATION_HZ;

export const MSG = Object.freeze({
  WELCOME: 0x00,
  INPUT: 0x01,
  STATE: 0x02,
  SHOT: 0x03,
  HIT: 0x04, // Server shot result / confirmed hit.
  RELOAD: 0x05,
  DESPAWN: 0x06,
  ENTER_GAME: 0x07,
  PING: 0x08,
  PONG: 0x09,
  ROOM_CREATE: 0x0a,
  ROOM_JOIN: 0x0b,
  ROOM_READY: 0x0c,
  ROOM_LEAVE: 0x0d,
  ROOM_STATE: 0x0e,
  ROOM_ERROR: 0x0f,
  MATCH_START: 0x10,
  ROOM_LEFT: 0x11,
  ROOM_TEAM_SWITCH: 0x12,
  NORMAL_MATCH_JOIN: 0x13,
  NORMAL_MATCH_ASSIGNED: 0x14,
  AUTH_TICKET: 0x15,
});

export const INPUT_MASK = Object.freeze({
  FORWARD: 1 << 0,
  BACKWARD: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  JUMP: 1 << 4,
  CROUCH: 1 << 5,
  SPRINT: 1 << 6,
  AIM: 1 << 7,
});

export const VALID_INPUT_MASK = Object.values(INPUT_MASK)
  .reduce((mask, bit) => mask | bit, 0);

export const PLAYER_FLAGS = Object.freeze({
  DEAD: 1 << 0,
  CROUCHING: 1 << 1,
  SPRINTING: 1 << 2,
  AIMING: 1 << 3,
  GROUNDED: 1 << 4,
  SPAWN_PROTECTED: 1 << 5,
});

export const FEATURE_FLAGS = Object.freeze({
  AUTHORITATIVE_MOVEMENT: 1 << 0,
  AUTHORITATIVE_COMBAT: 1 << 1,
  LAG_COMPENSATION: 1 << 2,
  TEAM_ROOMS: 1 << 3,
  NORMAL_MATCH_INSTANCES: 1 << 4,
  MATCH_TICKETS: 1 << 5,
});

export const TEAM = Object.freeze({
  NONE: 0,
  CRAZIES: 1,
  MADDIES: 2,
});

export const TEAM_NAMES = Object.freeze({
  [TEAM.CRAZIES]: "Team Crazies",
  [TEAM.MADDIES]: "Team Maddies",
});

export const ROOM_PHASE = Object.freeze({
  LOBBY: 0,
  IN_MATCH: 1,
});

export const ROOM_PLAYER_FLAGS = Object.freeze({
  READY: 1 << 0,
  AUTHENTICATED: 1 << 1,
});

export const ROOM_ERROR = Object.freeze({
  INVALID_CODE: 1,
  NOT_FOUND: 2,
  FULL: 3,
  ALREADY_IN_ROOM: 4,
  MATCH_STARTED: 5,
  NOT_IN_ROOM: 6,
  NEED_MORE_PLAYERS: 7,
  SERVER_ERROR: 8,
  RATE_LIMIT: 9,
  TEAM_FULL: 10,
  ALREADY_MATCHMADE: 11,
  MATCHMAKING_REQUIRED: 12,
});

export const ROOM_ERROR_MESSAGES = Object.freeze({
  [ROOM_ERROR.INVALID_CODE]: "Enter a valid 6-character room code.",
  [ROOM_ERROR.NOT_FOUND]: "That team room does not exist.",
  [ROOM_ERROR.FULL]: "That team room is already full.",
  [ROOM_ERROR.ALREADY_IN_ROOM]: "Leave your current team room first.",
  [ROOM_ERROR.MATCH_STARTED]: "That match has already started.",
  [ROOM_ERROR.NOT_IN_ROOM]: "You are not in a team room.",
  [ROOM_ERROR.NEED_MORE_PLAYERS]: "Invite at least one friend before readying up.",
  [ROOM_ERROR.SERVER_ERROR]: "The team room could not be updated.",
  [ROOM_ERROR.RATE_LIMIT]: "Too many room actions. Wait a moment and try again.",
  [ROOM_ERROR.TEAM_FULL]: "That team already has five players.",
  [ROOM_ERROR.ALREADY_MATCHMADE]: "You are already assigned to a normal match.",
  [ROOM_ERROR.MATCHMAKING_REQUIRED]: "Join a normal match before deploying.",
});

export const ROOM_CODE_LENGTH = 6;
export const ROOM_MIN_PLAYERS = 2;
export const ROOM_MAX_PLAYERS = 10;
export const ROOM_TEAM_CAPACITY = ROOM_MAX_PLAYERS / 2;
export const ROOM_PLAYER_NAME_BYTES = 24;
export const NORMAL_MATCH_MAX_PLAYERS = 10;
export const NORMAL_MATCH_TEAM_CAPACITY = NORMAL_MATCH_MAX_PLAYERS / 2;

export const COMBAT_FLAGS = Object.freeze({
  AUTHORITATIVE_WEAPON: 1 << 0,
  RELOADING: 1 << 1,
  DEAD: 1 << 2,
  SPAWN_PROTECTED: 1 << 3,
});

export const HIT_ZONE = Object.freeze({
  NONE: 0,
  HEAD: 1,
  BODY: 2,
  LEGS: 3,
});

export const SHOT_STATUS = Object.freeze({
  MISS: 0,
  HIT: 1,
  KILL: 2,
  REJECTED_COOLDOWN: 10,
  REJECTED_AMMO: 11,
  REJECTED_RELOAD: 12,
  REJECTED_DEAD: 13,
  REJECTED_STALE: 14,
  REJECTED_AIM: 15,
  REJECTED_SEQUENCE: 16,
  REJECTED_WEAPON: 17,
  REJECTED_PROTECTED: 18,
});

export const WEAPON_NET_IDS = Object.freeze({
  "ARC-7": 1,
  VESPER: 2,
  RECON: 3,
  BREACH: 4,
});

export const NET_WEAPON_IDS = Object.freeze({
  1: "ARC-7",
  2: "VESPER",
  3: "RECON",
  4: "BREACH",
});

export const MOVEMENT_SPEEDS = Object.freeze({
  "ARC-7": 7.5,
  VESPER: 9.5,
  RECON: 5.0,
  BREACH: 8.2,
});

export const MOVEMENT_SPEEDS_BY_NET_ID = Object.freeze({
  1: MOVEMENT_SPEEDS["ARC-7"],
  2: MOVEMENT_SPEEDS.VESPER,
  3: MOVEMENT_SPEEDS.RECON,
  4: MOVEMENT_SPEEDS.BREACH,
});

export const DEFAULT_WEAPON_NET_ID = WEAPON_NET_IDS["ARC-7"];
export const COMBAT_RULES = Object.freeze({
  maxRewindTicks: Math.ceil(0.3 * SIMULATION_HZ),
  respawnTicks: 3 * SIMULATION_HZ,
  spawnProtectionTicks: SIMULATION_HZ,
});

function makeWeaponRules({
  id,
  rpm,
  damage,
  magSize,
  reserveAmmo,
  reloadSeconds,
  range,
  spread,
  automatic,
}) {
  return Object.freeze({
    id,
    weaponNetId: WEAPON_NET_IDS[id],
    rpm,
    damage,
    magSize,
    reserveAmmo,
    reloadTicks: Math.ceil(reloadSeconds * SIMULATION_HZ),
    fireIntervalTicks: Math.max(1, Math.ceil((60 * SIMULATION_HZ) / rpm)),
    range,
    spread,
    automatic,
  });
}

/**
 * Shared combat truth used by both the browser's prediction layer and the
 * authoritative Node server. A modified client can display different values,
 * but the server imports this same table and decides the real outcome.
 */
export const WEAPON_RULES = Object.freeze({
  "ARC-7": makeWeaponRules({
    id: "ARC-7",
    rpm: 600,
    damage: 28,
    magSize: 30,
    reserveAmmo: 90,
    reloadSeconds: 2.2,
    range: 300,
    spread: 0.022,
    automatic: true,
  }),
  VESPER: makeWeaponRules({
    id: "VESPER",
    rpm: 900,
    damage: 16,
    magSize: 45,
    reserveAmmo: 135,
    reloadSeconds: 1.7,
    range: 100,
    spread: 0.055,
    automatic: true,
  }),
  RECON: makeWeaponRules({
    id: "RECON",
    rpm: 40,
    damage: 120,
    magSize: 5,
    reserveAmmo: 15,
    reloadSeconds: 3.5,
    range: 1500,
    spread: 0.001,
    automatic: false,
  }),
  BREACH: makeWeaponRules({
    id: "BREACH",
    rpm: 240,
    damage: 30,
    magSize: 12,
    reserveAmmo: 48,
    reloadSeconds: 1.5,
    range: 150,
    spread: 0.005,
    automatic: false,
  }),
});

// Compatibility exports for older local tooling. Combat code must use the
// weapon-specific lookup helpers below rather than assuming Breach rules.
export const AUTHORITATIVE_PISTOL_NET_ID = WEAPON_NET_IDS.BREACH;
export const PISTOL_RULES = Object.freeze({
  ...WEAPON_RULES.BREACH,
  ...COMBAT_RULES,
});

// Exact byte sizes. Receivers reject frames that are shorter OR longer.
export const WELCOME_BYTES = 8;
export const INPUT_BYTES = 16;
export const ENTER_GAME_BYTES = 4;
export const PING_BYTES = 10;
export const SHOT_BYTES = 24;
export const HIT_BYTES = 24;
export const RELOAD_BYTES = 8;
export const STATE_HEADER_BYTES = 24;
export const STATE_PLAYER_BYTES = 44;
export const ROOM_CREATE_BYTES = 4;
export const ROOM_JOIN_BYTES = 2 + ROOM_CODE_LENGTH;
export const ROOM_READY_BYTES = 4;
export const ROOM_TEAM_SWITCH_BYTES = 4;
export const ROOM_LEAVE_BYTES = 4;
export const ROOM_ERROR_BYTES = 4;
export const ROOM_LEFT_BYTES = 4;
export const MATCH_START_BYTES = 12;
export const ROOM_STATE_HEADER_BYTES = 16;
export const ROOM_STATE_PLAYER_BYTES = 32;
export const NORMAL_MATCH_JOIN_BYTES = 4;
export const NORMAL_MATCH_ASSIGNED_BYTES = 12;
export const AUTH_TICKET_CHARACTERS = 43;
export const AUTH_TICKET_BYTES = 48;

export function normalizeRoomCode(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(value) {
  return /^[A-Z0-9]{6}$/.test(String(value ?? ""));
}

export function weaponNetId(weaponId) {
  return WEAPON_NET_IDS[weaponId] || 0;
}

export function weaponNameFromNetId(netId) {
  return NET_WEAPON_IDS[netId] || NET_WEAPON_IDS[DEFAULT_WEAPON_NET_ID];
}

export function movementSpeedForNetId(netId) {
  return MOVEMENT_SPEEDS_BY_NET_ID[netId]
    || MOVEMENT_SPEEDS_BY_NET_ID[DEFAULT_WEAPON_NET_ID];
}

export function weaponRulesForId(weaponId) {
  return WEAPON_RULES[weaponId] || null;
}

export function weaponRulesForNetId(netId) {
  const weaponId = NET_WEAPON_IDS[netId];
  return weaponId ? WEAPON_RULES[weaponId] || null : null;
}

export function buildInputMask(input) {
  let mask = 0;
  if (input?.forward) mask |= INPUT_MASK.FORWARD;
  if (input?.backward) mask |= INPUT_MASK.BACKWARD;
  if (input?.left) mask |= INPUT_MASK.LEFT;
  if (input?.right) mask |= INPUT_MASK.RIGHT;
  if (input?.jump) mask |= INPUT_MASK.JUMP;
  if (input?.crouch) mask |= INPUT_MASK.CROUCH;
  if (input?.sprint) mask |= INPUT_MASK.SPRINT;
  if (input?.aim) mask |= INPUT_MASK.AIM;
  return mask;
}

/** Convert a command mask to the exact key-state shape CharacterPhysics uses. */
export function inputMaskToKeys(mask, target = {}) {
  target.KeyW = !!(mask & INPUT_MASK.FORWARD);
  target.KeyS = !!(mask & INPUT_MASK.BACKWARD);
  target.KeyA = !!(mask & INPUT_MASK.LEFT);
  target.KeyD = !!(mask & INPUT_MASK.RIGHT);
  target.Space = !!(mask & INPUT_MASK.JUMP);
  target.ControlLeft = !!(mask & INPUT_MASK.CROUCH);
  target.ShiftLeft = !!(mask & INPUT_MASK.SPRINT);
  target.Aim = !!(mask & INPUT_MASK.AIM);
  return target;
}
