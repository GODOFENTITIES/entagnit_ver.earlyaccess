import { animate, svg, stagger } from "animejs";
import {
  MSG,
  ROOM_PHASE,
  TEAM,
  TEAM_NAMES,
  createTeamRoom,
  isConnected,
  joinNormalMatch,
  joinTeamRoom,
  leaveTeamRoom,
  onMessage,
  parseMatchStartFrame,
  parseNormalMatchAssignedFrame,
  parseRoomErrorFrame,
  parseRoomLeftFrame,
  parseRoomStateFrame,
  setTeamRoomReady,
  switchTeamRoomTeam,
} from "./network.js";
import { chatClient, MAX_MESSAGE_LENGTH } from "./chat.js";


const state = {
  mode: "Redline Strike",
  primary: "Vektor-9",
  sidearm: "Breach Pistol",
  cosmetic: "Factory Red",
  credits: 2400,
  queue: "idle",
  normalMatch: null,
  teamRoom: null,
  teamRoomError: "",
  teamRoomPending: false,
  teamMatchStarted: false,
  chatDraft: "",
  profile: {
    username: "GodOfEntities",
    initials: "GE",
    level: 42,
    xp: 72,
    starRating: 5,
    title: "Spark Core Sentinel",
    clanTag: "POT",
    region: "Asia-Pacific",
    playerId: "POT-GE-0042",
    avatar: "Redline Mask",
    banner: "Factory Ignition",
    usernameChangeAvailableOn: "2026-09-12",
    visibleStats: ["kd", "winRate", "headshot", "rankRating", "bestWeapon"],
    badges: ["Redline Founder", "Core Runner", "Clean Entry", "Squad Anchor"],
    achievements: [
      { name: "Ace Protocol", meta: "5 MVP rounds secured" },
      { name: "Sparkline Control", meta: "128 objective wins" },
      { name: "Deadeye Routine", meta: "42% headshot peak" },
    ],
  },
  settings: {
    autoSprint: false,
    rawInput: true,
    hitMarkers: true,
    resolution: "1920 x 1080",
    graphicsQuality: "High",
    fpsCap: "144",
    crosshairColor: "#36e0c2",
    crosshairSize: 4,
    crosshairGap: 5,
    crosshairOutlines: true,
    masterVolume: 72,
    musicVolume: 38,
    matchVolume: 86,
    motion: true,
    voice: true,
    fullscreenOnPlay: false,
    potatoMode: false,
  },
  /** Live messages appended by the potspark:chat-message event listener. */
  chat: [],
  /** 'off' | 'connecting' | 'live' | 'error' — mirrors ChatClient status. */
  chatStatus: "off",
};

const HTML_ESCAPE = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

const modes = [
  {
    name: "Redline Strike",
    icon: "icon-zap",
    meta: "5v5 | short rounds",
    desc: "Fast objective fights with tight rotations and quick respawn pressure.",
  },
  {
    name: "Iron Control",
    icon: "icon-shield",
    meta: "8v8 | zone hold",
    desc: "Hold machinery sectors, reinforce lanes, and deny flank routes.",
  },
  {
    name: "Spark Rush",
    icon: "icon-play",
    meta: "Solo | score chase",
    desc: "A compact warmup mode built for aim rhythm and movement timing.",
  },
];

const weapons = [
  {
    name: "Vektor-9",
    icon: "icon-zap",
    meta: "SMG | 920 RPM",
    desc: "Light recoil, strong hip-fire, best for close machinery lanes.",
  },
  {
    name: "Mast-17",
    icon: "icon-mode",
    meta: "Rifle | balanced",
    desc: "Reliable mid-range handling with a clean red-dot sight picture.",
  },
  {
    name: "Forge LMG",
    icon: "icon-shield",
    meta: "LMG | suppressive",
    desc: "Heavy recoil curve, huge magazine, excellent for area denial.",
  },
];

const shopItems = [
  {
    name: "Factory Red",
    icon: "icon-star",
    cost: 0,
    owned: true,
    desc: "White steel panels with red enamel cuts.",
  },
  {
    name: "Carbon Volt",
    icon: "icon-zap",
    cost: 900,
    owned: false,
    desc: "Dark carbon plates with aqua ignition lines.",
  },
  {
    name: "Brass Riot",
    icon: "icon-shield",
    cost: 1400,
    owned: false,
    desc: "Worn brass edges, black bolts, and red inspection marks.",
  },
  {
    name: "Glitch Core",
    icon: "icon-zap",
    cost: null,
    owned: false,
    comingSoon: true,
    desc: "Vibrant neon distortion layers with pulsing frequencies.",
  },
  {
    name: "Quantum Phase",
    icon: "icon-shield",
    cost: null,
    owned: false,
    comingSoon: true,
    desc: "Shifting chromatic panels with light bending carbon fiber.",
  }
];

const friends = [
  { name: "Rift", status: "Online | lobby", online: true },
  { name: "Mara", status: "Online | loadout", online: true },
  { name: "Kane", status: "Away | firing range", online: false },
];

const profileStats = [
  { id: "kd", label: "K/D", value: "1.84", meta: "Lifetime combat ratio" },
  { id: "winRate", label: "Win Rate", value: "58%", meta: "Competitive queue" },
  { id: "headshot", label: "Headshot", value: "31%", meta: "Primary weapon average" },
  { id: "accuracy", label: "Accuracy", value: "46%", meta: "Shots on target" },
  { id: "matches", label: "Matches", value: "312", meta: "Matches played" },
  { id: "mvps", label: "MVPs", value: "39", meta: "Top score finishes" },
  { id: "rankRating", label: "Rank Rating", value: "742", meta: "Gold ladder score" },
  { id: "bestWeapon", label: "Best Weapon", value: () => state.primary, meta: "Showcased weapon" },
];

const panelMeta = {
  mode: { kicker: "Queue Contract", title: "Mode" },
  loadout: { kicker: "Arsenal", title: "Loadout" },
  shop: { kicker: "Quartermaster", title: "Shop" },
  profile: { kicker: "Operator", title: "Profile" },
  friends: { kicker: "Squad Link", title: "Friends" },
  chat: { kicker: "Comms", title: "Chat" },
  settings: { kicker: "System", title: "Settings" },
  credits: { kicker: "PotSpark", title: "Credits" },
};

let ccActiveTab = "";
let careerActiveTab = "overview";
let activeDrawerTab = "chat";
let activeModalType = "settings";

const controlCenter = document.querySelector("#controlCenter");
const ccCloseBtn = document.querySelector("#ccCloseBtn");
const ccBody = document.querySelector("#ccBody");

const socialDrawer = document.querySelector("#socialDrawer");
const socialDrawerCloseBtn = document.querySelector("#socialDrawerCloseBtn");
const socialDrawerBody = document.querySelector("#socialDrawerBody");
const socialDrawerBackdrop = document.querySelector("#socialDrawerBackdrop");

const utilityModal = document.querySelector("#utilityModal");
const utilityModalCloseBtn = document.querySelector("#utilityModalCloseBtn");
const utilityModalBody = document.querySelector("#utilityModalBody");
const utilityModalBackdrop = document.querySelector("#utilityModalBackdrop");
const utilityModalTitle = document.querySelector("#utilityModalTitle");
const utilityModalIcon = document.querySelector("#utilityModalIcon");

const teamRoomButton = document.querySelector("#teamRoomButton");
const teamRoomButtonLabel = document.querySelector("#teamRoomButtonLabel");
const teamRoomCount = document.querySelector("#teamRoomCount");
const teamRoomModal = document.querySelector("#teamRoomModal");
const teamRoomBackdrop = document.querySelector("#teamRoomBackdrop");
const teamRoomCloseBtn = document.querySelector("#teamRoomCloseBtn");
const teamRoomBody = document.querySelector("#teamRoomBody");

const roadmapButton = document.querySelector("#roadmapButton");
const roadmapModal = document.querySelector("#roadmapModal");
const roadmapBackdrop = document.querySelector("#roadmapBackdrop");
const roadmapCloseBtn = document.querySelector("#roadmapCloseBtn");

const playButton = document.querySelector("#playButton");
const playText = document.querySelector("#playText");
const queuePanel = document.querySelector("#queuePanel");
const queueFill = document.querySelector("#queueFill");
const queueStatus = document.querySelector("#queueStatus");
const toast = document.querySelector("#toast");
const missionModeName = document.querySelector("#missionModeName");
const missionModeMeta = document.querySelector("#missionModeMeta");
const profileButton = document.querySelector(".profile-button");
const profileButtonInitials = document.querySelector("[data-profile-initials]");

let queueTimer = 0;
let queueProgress = 0;
let toastTimer = 0;
let profileFireTimer = 0;
let logoDrawAnimation = null;

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#${name}"></use></svg>`;
}

function logoSvg(extraClass = "") {
  return `<svg class="brand-spark brand-spark-svg ${extraClass}" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polygon points="8,0 44,0 36,44 0,44 0,8" fill="var(--red)" opacity="0.3" stroke="var(--red)" stroke-width="1"/>
    <path class="logo-line" d="M22,8 L16,36" stroke="var(--cream)" stroke-width="3" stroke-linecap="round"/>
    <path class="logo-line" d="M8,22 L36,18" stroke="var(--cream)" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

// #createDrawable — animates the "potSpark" text logo SVG paths on the top left.
// Targets only .brand-spark-text-logo .logo-line so it doesn't affect other SVGs.
function startLogoAnimation() {
  requestAnimationFrame(() => {
    if (logoDrawAnimation) return;
    const selector = '.brand-spark-text-logo .logo-line';
    if (!document.querySelector(selector)) return;
    // #createDrawable: draw each stroke from nothing to full, then erase, looping
    logoDrawAnimation = animate(svg.createDrawable(selector), {
      draw: ['0 0', '0 1', '1 1'],
      ease: 'inOutQuad',
      duration: 2000,
      delay: stagger(100),
      loop: true
    });
  });
}

function showToast(message) {
  window.clearTimeout(toastTimer);

  // Force animation restart so rapid toasts always spring in from below
  toast.classList.remove("is-visible");
  void toast.offsetWidth; // reflow
  toast.textContent = message;
  toast.classList.add("is-visible");

  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

function settingLabel(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatProfileDate(dateString) {
  const [year, month, day] = dateString.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function profileStatValue(stat) {
  return typeof stat.value === "function" ? stat.value() : stat.value;
}

function renderStarRating(count) {
  return Array.from({ length: 5 }, (_, index) => {
    const active = index < count;
    return `<span class="profile-star ${active ? "is-active" : ""}">${icon("icon-star")}</span>`;
  }).join("");
}

function renderIdentityAvatar() {
  return `<span class="identity-avatar" style="--profile-xp: ${state.profile.xp}%;">
    <span class="identity-avatar-core">${escapeHtml(state.profile.initials)}</span>
    <span class="identity-level">LV ${state.profile.level}</span>
  </span>`;
}

function settingToggle(key, label, description, iconName) {
  const value = Boolean(state.settings[key]);
  return `<article class="settings-control">
    <div>
      <h3>${label}</h3>
      <p>${description}</p>
    </div>
    <button class="toggle-button" type="button" aria-pressed="${value}" data-toggle="${key}">
      ${icon(iconName)}
      <span>${value ? "On" : "Off"}</span>
    </button>
  </article>`;
}

function settingRange(key, label, min, max, iconName) {
  return `<article class="settings-control">
    <div>
      <h3>${label}</h3>
      <p><output data-setting-output="${key}">${state.settings[key]}</output>${key.toLowerCase().includes("volume") ? "% output" : ""}</p>
    </div>
    <label class="range-control">
      ${icon(iconName)}
      <input type="range" min="${min}" max="${max}" value="${state.settings[key]}" data-setting-range="${key}" />
    </label>
  </article>`;
}

function settingSelect(key, label, options, iconName) {
  return `<article class="settings-control">
    <div>
      <h3>${label}</h3>
      <p>${state.settings[key]}</p>
    </div>
    <label class="select-control">
      ${icon(iconName)}
      <select data-setting-select="${key}">
        ${options.map((option) => `<option value="${option}" ${option === state.settings[key] ? "selected" : ""}>${option}</option>`).join("")}
      </select>
    </label>
  </article>`;
}

function renderCrosshairPreview() {
  const size = Number(state.settings.crosshairSize);
  const gap = Number(state.settings.crosshairGap);
  const color = state.settings.crosshairColor;
  const outlineClass = state.settings.crosshairOutlines ? " has-outline" : "";

  return `<div class="crosshair-preview${outlineClass}" style="--crosshair-color: ${color}; --crosshair-size: ${size}px; --crosshair-gap: ${gap}px;" aria-label="Crosshair preview">
    <span class="crosshair-line top"></span>
    <span class="crosshair-line right"></span>
    <span class="crosshair-line bottom"></span>
    <span class="crosshair-line left"></span>
  </div>`;
}

function applySettingsEffects() {
  document.body.classList.toggle("is-potato-mode", state.settings.potatoMode);
  document.body.classList.toggle("is-motion-muted", !state.settings.motion);
  document.body.classList.toggle("has-crosshair-outline", state.settings.crosshairOutlines);
  document.documentElement.style.setProperty("--hud-crosshair-color", state.settings.crosshairColor);
  document.documentElement.style.setProperty("--hud-crosshair-size", `${state.settings.crosshairSize}px`);
  document.documentElement.style.setProperty("--hud-crosshair-gap", `${state.settings.crosshairGap}px`);
  window.dispatchEvent(new CustomEvent("potspark:menu-motion-change", {
    detail: {
      enabled: state.settings.motion && !state.settings.potatoMode,
    },
  }));
}

function syncProfileButton() {
  if (profileButton) {
    profileButton.style.setProperty("--profile-xp", `${state.profile.xp}%`);
    profileButton.setAttribute("aria-label", `${state.profile.username} profile`);
  }

  if (profileButtonInitials) {
    profileButtonInitials.textContent = state.profile.initials;
  }
}

function syncActiveButtons() {
  syncProfileButton();

  document.querySelectorAll("[data-panel]").forEach((button) => {
    const panelType = button.dataset.panel;
    let isActive = false;

    if (panelType === "mode" || panelType === "loadout" || panelType === "shop" || panelType === "profile") {
      const tabMap = { mode: "arena", loadout: "arsenal", shop: "store", profile: "career" };
      isActive = controlCenter && !controlCenter.hidden && tabMap[panelType] === ccActiveTab;
    } else if (panelType === "friends" || panelType === "chat") {
      isActive = socialDrawer && !socialDrawer.hidden && panelType === activeDrawerTab;
    } else if (panelType === "settings" || panelType === "credits") {
      isActive = utilityModal && !utilityModal.hidden && panelType === activeModalType;
    }

    button.classList.toggle("is-active", isActive);
  });

  const mode = modes.find((entry) => entry.name === state.mode);
  if (mode && missionModeName && missionModeMeta) {
    missionModeName.textContent = mode.name;
    missionModeMeta.textContent = mode.meta;
  }
}

function openControlCenter(tab) {
  if (!controlCenter) return;
  // Cancel any in-progress close animation
  controlCenter.classList.remove("is-closing");
  controlCenter.hidden = false;
  switchControlCenterTab(tab);
}

function closeControlCenter() {
  if (!controlCenter) return;
  controlCenter.classList.add("is-closing");
  const CLOSE_DURATION = 160;
  window.setTimeout(() => {
    controlCenter.hidden = true;
    controlCenter.classList.remove("is-closing");
    ccActiveTab = "";
    syncActiveButtons();
  }, CLOSE_DURATION);
}

function switchControlCenterTab(tab) {
  ccActiveTab = tab;

  if (controlCenter) {
    controlCenter.querySelectorAll(".cc-tab-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.ccTab === tab);
    });
  }

  if (ccBody) {
    ccBody.classList.remove("is-tab-switching");
    // Force reflow to restart animation
    void ccBody.offsetWidth;
    ccBody.innerHTML = renderControlCenterTab(tab);
    ccBody.scrollTop = 0;
    ccBody.classList.add("is-tab-switching");

    if (tab === "career") {
      populateCareerSidebar();
      switchCareerTab(careerActiveTab);
    }
  }

  syncActiveButtons();
  startLogoAnimation();
}

function renderControlCenterTab(tab) {
  switch (tab) {
    case "arena":    return renderArena();
    case "arsenal":  return renderArsenal();
    case "store":    return renderStore();
    case "career":   return renderCareer();
    default:         return "";
  }
}

function openSocialDrawer(tab) {
  if (!socialDrawer) return;
  // Cancel any in-progress close animation
  socialDrawer.classList.remove("is-closing");
  socialDrawer.hidden = false;
  switchSocialDrawerTab(tab);
}

function closeSocialDrawer() {
  if (!socialDrawer) return;
  socialDrawer.classList.add("is-closing");
  const CLOSE_DURATION = 160;
  window.setTimeout(() => {
    socialDrawer.hidden = true;
    socialDrawer.classList.remove("is-closing");
    syncActiveButtons();
  }, CLOSE_DURATION);
}

function switchSocialDrawerTab(tab) {
  activeDrawerTab = tab;

  if (socialDrawer) {
    socialDrawer.querySelectorAll("[data-drawer-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.drawerTab === tab);
    });
  }

  if (socialDrawerBody) {
    // Trigger cross-fade by resetting animation
    socialDrawerBody.style.animation = "none";
    void socialDrawerBody.offsetWidth;
    socialDrawerBody.style.animation = "";

    socialDrawerBody.innerHTML = tab === "chat" ? renderSquadChat() : renderSquadFriends();
    socialDrawerBody.scrollTop = 0;

    if (tab === "chat") {
      const chatLog = socialDrawerBody.querySelector("#chatLog");
      if (chatLog) {
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      const chatInput = socialDrawerBody.querySelector("#chatInput");
      if (chatInput) {
        chatInput.focus();
        chatInput.selectionStart = chatInput.value.length;
      }
    }
  }

  syncActiveButtons();
}

function openUtilityModal(type) {
  if (!utilityModal) return;
  // Cancel any in-progress close animation
  utilityModal.classList.remove("is-closing");
  utilityModal.hidden = false;
  activeModalType = type;

  if (utilityModalTitle) {
    utilityModalTitle.textContent = type === "settings" ? "Settings" : "Credits";
  }

  if (utilityModalIcon) {
    const iconName = type === "settings" ? "icon-settings" : "icon-credits";
    utilityModalIcon.innerHTML = `<use href="#${iconName}"></use>`;
  }

  if (utilityModalBody) {
    utilityModalBody.innerHTML = type === "settings" ? renderSettings() : renderCredits();
    utilityModalBody.scrollTop = 0;
  }

  syncActiveButtons();
  startLogoAnimation();
}

function closeUtilityModal() {
  if (!utilityModal) return;
  utilityModal.classList.add("is-closing");
  const CLOSE_DURATION = 160;
  window.setTimeout(() => {
    utilityModal.hidden = true;
    utilityModal.classList.remove("is-closing");
    syncActiveButtons();
  }, CLOSE_DURATION);
}

function hydrateRoadmapImages() {
  roadmapModal?.querySelectorAll("img[data-roadmap-src]").forEach((image) => {
    image.src = image.dataset.roadmapSrc;
    image.removeAttribute("data-roadmap-src");
  });
}

function openRoadmapModal() {
  closeControlCenter();
  closeSocialDrawer();
  closeUtilityModal();
  closeTeamRoomModal();
  if (!roadmapModal) return;
  hydrateRoadmapImages();
  roadmapModal.hidden = false;
  window.setTimeout(() => roadmapCloseBtn?.focus({ preventScroll: true }), 0);
}

function closeRoadmapModal() {
  if (!roadmapModal || roadmapModal.hidden) return;
  roadmapModal.classList.add("is-closing");
  window.setTimeout(() => {
    roadmapModal.hidden = true;
    roadmapModal.classList.remove("is-closing");
    roadmapButton?.focus({ preventScroll: true });
  }, 160);
}

function getSelfRoomPlayer(room = state.teamRoom) {
  return room?.players?.find((player) => player.id === room.selfId) || null;
}

function renderTeamPlayer(player, room) {
  const isSelf = player.id === room.selfId;
  const safeName = escapeHtml(player.displayName);
  return `<article class="team-player ${isSelf ? "is-self" : ""}">
    <div class="team-player-name">
      <strong>${safeName}</strong>
      ${isSelf ? '<span class="team-player-tag">YOU</span>' : ""}
      ${player.authenticated ? '<span class="team-player-tag">USER</span>' : ""}
    </div>
    <span class="team-player-ready ${player.ready ? "is-ready" : ""}">
      ${player.ready ? "Ready" : "Not ready"}
    </span>
  </article>`;
}

function renderTeamCard(room, team, className) {
  const players = room.players.filter((player) => player.team === team);
  const capacity = Math.floor(room.maxPlayers / 2);
  const self = getSelfRoomPlayer(room);
  const isCurrent = self?.team === team;
  const isFull = players.length >= capacity;
  const isLocked = room.phase === ROOM_PHASE.IN_MATCH;
  const switchDisabled = !self || isCurrent || isFull || isLocked || state.teamRoomPending;
  const switchLabel = isCurrent
    ? "Current Team"
    : isFull
      ? "Team Full"
      : isLocked
        ? "Teams Locked"
        : `Switch to ${TEAM_NAMES[team].replace("Team ", "")}`;
  return `<section class="team-card ${className}">
    <header class="team-card-heading">
      <h3>${escapeHtml(TEAM_NAMES[team])}</h3>
      <span>${players.length}/${capacity}</span>
    </header>
    <div class="team-player-list">
      ${players.length
        ? players.map((player) => renderTeamPlayer(player, room)).join("")
        : '<p class="team-empty">Waiting for a player...</p>'}
    </div>
    <footer class="team-card-footer">
      <button class="micro-button team-switch-button ${isCurrent ? "is-current" : ""}" type="button" data-team-switch="${team}" ${switchDisabled ? "disabled" : ""}>
        ${icon(isCurrent ? "icon-check" : "icon-friends")}
        <span>${escapeHtml(switchLabel)}</span>
      </button>
    </footer>
  </section>`;
}

function teamRoomStatus(room) {
  const readyCount = room.players.filter((player) => player.ready).length;
  if (room.phase === ROOM_PHASE.IN_MATCH) {
    return {
      title: "Deployment authorized",
      text: "Every player is ready. Redline Yard is loading for the room.",
    };
  }
  if (room.players.length < room.minPlayers) {
    return {
      title: "Waiting for a friend",
      text: `Share the code. At least ${room.minPlayers} players are required to start.`,
    };
  }
  const crazies = room.players.filter((player) => player.team === TEAM.CRAZIES).length;
  const maddies = room.players.filter((player) => player.team === TEAM.MADDIES).length;
  if (crazies === 0 || maddies === 0) {
    return {
      title: "Choose opposing sides",
      text: "Each team needs at least one player before the ready gate can deploy the match.",
    };
  }
  return {
    title: `${readyCount}/${room.players.length} players ready`,
    text: readyCount === room.players.length
      ? "All players are locked in. Waiting for the server to deploy."
      : "The match starts automatically only when everyone is ready.",
  };
}

function renderTeamRoom() {
  if (!teamRoomBody) return;
  const connected = isConnected();
  if (!state.teamRoom) {
    const message = state.teamRoomError
      || (state.teamRoomPending
        ? "Contacting the room server..."
        : connected
          ? "Create a fresh room or enter a friend's six-character code."
          : "Connecting to the room server...");
    teamRoomBody.innerHTML = `
      <div class="team-room-intro">
        <h3>Bring your squad</h3>
        <p>Each room is split automatically between Team Crazies and Team Maddies, and players can switch sides before deployment. Guests receive Player 1, Player 2, and so on; authenticated accounts keep their verified username.</p>
      </div>
      <div class="team-room-entry-grid">
        <section class="team-room-entry-card">
          <h3>Create a room</h3>
          <p class="team-room-help">Generate a new random six-character invite code and take the first slot in Team Crazies.</p>
          <button class="micro-button" type="button" data-team-create ${!connected || state.teamRoomPending ? "disabled" : ""}>
            ${icon("icon-friends")} <span>Create Room</span>
          </button>
        </section>
        <section class="team-room-entry-card is-join">
          <h3>Join a room</h3>
          <p class="team-room-help">Codes use uppercase letters and numbers and work only while that room is waiting.</p>
          <form class="team-room-join-form" data-team-join-form>
            <input class="team-code-input" id="teamRoomCodeInput" name="roomCode" inputmode="text" autocomplete="off" maxlength="6" placeholder="A7B2C9" aria-label="Six-character room code" ${!connected || state.teamRoomPending ? "disabled" : ""}>
            <button class="micro-button" type="submit" ${!connected || state.teamRoomPending ? "disabled" : ""}>
              ${icon("icon-play")} <span>Join Room</span>
            </button>
          </form>
        </section>
      </div>
      <div class="team-room-message ${state.teamRoomError ? "is-error" : ""}">${escapeHtml(message)}</div>`;
    return;
  }

  const room = state.teamRoom;
  const self = getSelfRoomPlayer(room);
  const status = teamRoomStatus(room);
  const matchStarted = room.phase === ROOM_PHASE.IN_MATCH;
  teamRoomBody.innerHTML = `
    <div class="team-room-topline">
      <section class="team-room-code-block">
        <h3>Invite code</h3>
        <div class="team-room-code-line">
          <strong class="team-room-code">${escapeHtml(room.code)}</strong>
          <button class="micro-button" type="button" data-team-copy-code>
            ${icon("icon-friends")} <span>Copy</span>
          </button>
        </div>
      </section>
      <section class="team-room-status-copy">
        <strong>${escapeHtml(status.title)}</strong>
        <p>${escapeHtml(status.text)}</p>
      </section>
    </div>
    <div class="team-room-teams">
      ${renderTeamCard(room, TEAM.CRAZIES, "is-crazies")}
      ${renderTeamCard(room, TEAM.MADDIES, "is-maddies")}
    </div>
    <div class="team-room-actions">
      <p class="team-room-help">${room.players.length}/${room.maxPlayers} players · Switching sides clears your Ready status · Room codes are server-generated.</p>
      <div class="team-room-actions-right">
        <button class="micro-button team-leave-button" type="button" data-team-leave ${matchStarted ? "disabled" : ""}>
          ${icon("icon-x")} <span>Leave</span>
        </button>
        <button class="micro-button team-ready-button ${self?.ready ? "is-ready" : ""}" type="button" data-team-ready ${matchStarted || state.teamRoomPending ? "disabled" : ""}>
          ${icon(self?.ready ? "icon-check" : "icon-play")}
          <span>${matchStarted ? "Deploying" : self?.ready ? "Not Ready" : "Ready Up"}</span>
        </button>
      </div>
    </div>
    ${state.teamRoomError ? `<div class="team-room-message is-error">${escapeHtml(state.teamRoomError)}</div>` : ""}`;
}

function syncTeamRoomButtons() {
  const room = state.teamRoom;
  const self = getSelfRoomPlayer(room);
  teamRoomButton?.classList.toggle("is-in-room", !!room);
  if (teamRoomButtonLabel) teamRoomButtonLabel.textContent = "Team";
  if (teamRoomCount) {
    teamRoomCount.hidden = !room;
    teamRoomCount.textContent = room?.players?.length || 0;
  }
  if (room) {
    playButton.classList.remove("is-queueing");
    playText.textContent = room.phase === ROOM_PHASE.IN_MATCH
      ? "Deploying"
      : self?.ready ? "Waiting" : "Ready Up";
  } else if (state.queue === "idle") {
    playText.textContent = "Play";
  }
}

function openTeamRoomModal() {
  closeControlCenter();
  closeSocialDrawer();
  closeUtilityModal();
  closeRoadmapModal();
  if (!teamRoomModal) return;
  teamRoomModal.hidden = false;
  renderTeamRoom();
  window.setTimeout(() => {
    teamRoomBody?.querySelector("input, button")?.focus({ preventScroll: true });
  }, 0);
}

function closeTeamRoomModal() {
  if (!teamRoomModal || teamRoomModal.hidden) return;
  teamRoomModal.classList.add("is-closing");
  window.setTimeout(() => {
    teamRoomModal.hidden = true;
    teamRoomModal.classList.remove("is-closing");
  }, 160);
}

function setTeamRoomPending(pending, error = "") {
  state.teamRoomPending = pending;
  state.teamRoomError = error;
  renderTeamRoom();
}

function handleRoomStateFrame(view, buffer) {
  const room = parseRoomStateFrame(view, buffer);
  if (!room) return;
  window.clearInterval(queueTimer);
  state.queue = "idle";
  hideQueuePanel();
  queueFill.style.width = "0%";
  state.teamRoom = room;
  state.teamRoomPending = false;
  state.teamRoomError = "";
  state.teamMatchStarted = room.phase === ROOM_PHASE.IN_MATCH;
  syncTeamRoomButtons();
  if (teamRoomModal && !teamRoomModal.hidden) renderTeamRoom();
}

function handleRoomErrorFrame(view, buffer) {
  const error = parseRoomErrorFrame(view, buffer);
  if (!error) return;
  if (state.queue === "assigning") {
    state.queue = "ready";
    playButton.disabled = false;
    playButton.classList.remove("is-queueing");
    playText.textContent = "Deploy";
    queueStatus.textContent = "Match assignment failed - try again";
    showToast(error.message);
    return;
  }
  setTeamRoomPending(false, error.message);
  showToast(error.message);
}

function handleRoomLeftFrame(view, buffer) {
  if (!parseRoomLeftFrame(view, buffer)) return;
  state.teamRoom = null;
  state.teamRoomPending = false;
  state.teamRoomError = "";
  state.teamMatchStarted = false;
  syncTeamRoomButtons();
  renderTeamRoom();
  showToast("You left the team room.");
}

function handleMatchStartFrame(view, buffer) {
  const match = parseMatchStartFrame(view, buffer);
  if (!match || state.teamRoom?.code !== match.code) return;
  state.teamMatchStarted = true;
  closeTeamRoomModal();
  showToast(`${TEAM_NAMES[match.team]} locked. Everyone is ready.`);
  beginArenaDeployment({ teamAuthorized: true });
}

function handleNormalMatchAssignedFrame(view, buffer) {
  const match = parseNormalMatchAssignedFrame(view, buffer);
  if (!match || state.teamRoom) return;
  state.normalMatch = match;
  state.queue = "matched";
  playButton.disabled = false;
  queueStatus.textContent = `Normal Match ${match.id} · ${match.playerCount}/${match.maxPlayers}`;
  showToast(
    `Normal Match ${match.id} · ${TEAM_NAMES[match.team]} · ${match.playerCount}/${match.maxPlayers}`,
  );
  beginArenaDeployment({ normalMatchAuthorized: true });
}

onMessage(MSG.ROOM_STATE, handleRoomStateFrame);
onMessage(MSG.ROOM_ERROR, handleRoomErrorFrame);
onMessage(MSG.ROOM_LEFT, handleRoomLeftFrame);
onMessage(MSG.MATCH_START, handleMatchStartFrame);
onMessage(MSG.NORMAL_MATCH_ASSIGNED, handleNormalMatchAssignedFrame);

window.addEventListener("potspark:net-welcome", () => {
  state.teamRoomPending = false;
  state.teamRoomError = "";
  renderTeamRoom();
});

window.addEventListener("potspark:net-disconnected", () => {
  state.normalMatch = null;
  state.teamRoom = null;
  state.teamRoomPending = false;
  state.teamMatchStarted = false;
  state.teamRoomError = "Connection lost. Reconnect before creating or joining a room.";
  syncTeamRoomButtons();
  if (teamRoomModal && !teamRoomModal.hidden) renderTeamRoom();
});

function renderDeployWarning() {
  return `<div class="deploy-warning">
    <span class="deploy-warning-mark">${icon("icon-shield")}</span>
    <h2>Large map loading</h2>
    <p>Redline Yard is a heavy arena. If Chrome says PotSpark stopped responding during this load, choose <strong>Wait</strong>. The game is still preparing the map.</p>
    <div class="deploy-warning-actions">
      <button class="micro-button deploy-warning-confirm" type="button" data-deploy-continue>
        ${icon("icon-play")}
        <span>Continue deployment</span>
      </button>
      <button class="micro-button" type="button" data-deploy-cancel>
        ${icon("icon-x")}
        <span>Back</span>
      </button>
    </div>
  </div>`;
}

function openDeployWarning() {
  if (!utilityModal) return;
  utilityModal.hidden = false;
  activeModalType = "deploy";

  if (utilityModalTitle) utilityModalTitle.textContent = "Deployment Notice";
  if (utilityModalIcon) utilityModalIcon.innerHTML = `<use href="#icon-shield"></use>`;
  if (utilityModalBody) {
    utilityModalBody.innerHTML = renderDeployWarning();
    utilityModalBody.scrollTop = 0;
  }

  syncActiveButtons();
}

function requestNormalMatchAssignment() {
  if (!isConnected()) {
    state.queue = "ready";
    playButton.disabled = false;
    playText.textContent = "Deploy";
    queueStatus.textContent = "Server unavailable - reconnect to deploy";
    showToast("Match server is still connecting. Try again in a moment.");
    return;
  }

  state.queue = "assigning";
  playButton.disabled = true;
  playText.textContent = "Joining";
  queueStatus.textContent = "Assigning an available 5v5 instance";
  if (!joinNormalMatch()) {
    state.queue = "ready";
    playButton.disabled = false;
    playText.textContent = "Deploy";
    queueStatus.textContent = "Server unavailable - try again";
    showToast("Could not contact matchmaking. Try again.");
  }
}

function beginArenaDeployment({ teamAuthorized = false, normalMatchAuthorized = false } = {}) {
  if (state.teamRoom && !teamAuthorized) {
    openTeamRoomModal();
    showToast("Every player in the team room must be ready first.");
    return;
  }
  if (!state.teamRoom && !normalMatchAuthorized) {
    requestNormalMatchAssignment();
    return;
  }
  state.queue = "idle";
  hideQueuePanel();
  queueFill.style.width = "0%";
  playText.textContent = "Play";
  closeUtilityModal();
  showToast("Deployment handshake complete. Loading map...");

  window.dispatchEvent(new CustomEvent("potspark:deploy"));
}

const careerTabMeta = {
  overview:     { kicker: "Operator", title: "Overview" },
  stats:        { kicker: "Combat Data", title: "Stats" },
  achievements: { kicker: "History", title: "Achievements" },
  social:       { kicker: "Squad Link", title: "Social" },
  customise:    { kicker: "Identity", title: "Customise" },
};

function populateCareerSidebar() {
  const p = state.profile;
  const careerSidebarAvatar = document.querySelector("#careerSidebarAvatar");
  const careerSidebarClan = document.querySelector("#careerSidebarClan");
  const careerSidebarUsername = document.querySelector("#careerSidebarUsername");
  const careerSidebarTitle = document.querySelector("#careerSidebarTitle");
  const careerSidebarStars = document.querySelector("#careerSidebarStars");
  const careerSidebarId = document.querySelector("#careerSidebarId");
  const careerSidebarXpFill = document.querySelector("#careerSidebarXpFill");
  const careerSidebarXpVal = document.querySelector("#careerSidebarXpVal");

  if (careerSidebarAvatar) {
    careerSidebarAvatar.style.setProperty("--profile-xp", `${p.xp}%`);
    careerSidebarAvatar.innerHTML = `
      <div class="career-sidebar-avatar-core">${escapeHtml(p.initials)}</div>
      <span class="career-sidebar-level">LV ${p.level}</span>
    `;
  }

  if (careerSidebarClan)     careerSidebarClan.textContent     = `[${p.clanTag}] ${p.region}`;
  if (careerSidebarUsername) careerSidebarUsername.textContent = p.username;
  if (careerSidebarTitle)    careerSidebarTitle.textContent    = p.title;

  if (careerSidebarStars) {
    careerSidebarStars.innerHTML = renderStarRating(p.starRating);
  }

  if (careerSidebarId) {
    careerSidebarId.textContent = `ID: ${p.playerId}`;
  }

  if (careerSidebarXpFill) {
    requestAnimationFrame(() => {
      careerSidebarXpFill.style.width = `${p.xp}%`;
    });
  }

  if (careerSidebarXpVal) {
    careerSidebarXpVal.textContent = `${p.xp} / 100 XP`;
  }
}

function switchCareerTab(tab) {
  careerActiveTab = tab;

  document.querySelectorAll(".career-nav-item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.careerTab === tab);
  });

  const meta = careerTabMeta[tab];
  const careerTabKicker = document.querySelector("#careerTabKicker");
  const careerTabTitle = document.querySelector("#careerTabTitle");
  if (meta) {
    if (careerTabKicker) careerTabKicker.textContent = meta.kicker;
    if (careerTabTitle)  careerTabTitle.textContent  = meta.title;
  }

  const careerTabBody = document.querySelector("#careerTabBody");
  if (careerTabBody) {
    // Force reflow to restart animation on tab switch
    careerTabBody.style.animation = "none";
    void careerTabBody.offsetWidth;
    careerTabBody.style.animation = "";
    careerTabBody.innerHTML = renderProfileTab(tab);
    careerTabBody.scrollTop = 0;
  }
}

function renderProfileTab(tab) {
  switch (tab) {
    case "overview":     return renderProfileTabOverview();
    case "stats":        return renderProfileTabStats();
    case "achievements": return renderProfileTabAchievements();
    case "social":       return renderProfileTabSocial();
    case "customise":    return renderProfileTabCustomise();
    default: return "";
  }
}

function renderWeaponSchematic(weaponName) {
  if (weaponName === "Vektor-9") {
    return `<svg class="weapon-svg" viewBox="0 0 320 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M 0,20 L 320,20 M 0,60 L 320,60 M 0,100 L 320,100 M 40,0 L 40,120 M 120,0 L 120,120 M 200,0 L 200,120 M 280,0 L 280,120" stroke="rgba(236,232,223,0.03)" stroke-width="1"/>
      <path d="M 20,45 L 80,45 L 80,55 L 20,55 Z" stroke="var(--red)" stroke-width="1.8" fill="rgba(255,70,85,0.06)"/>
      <line x1="8" y1="50" x2="20" y2="50" stroke="var(--red)" stroke-width="2.5"/>
      <path d="M 80,35 L 210,35 L 230,65 L 210,95 L 180,95 L 170,80 L 110,80 L 95,95 L 80,95 Z" stroke="var(--cream)" stroke-width="2.2" fill="rgba(236,232,223,0.08)"/>
      <path d="M 140,80 L 155,112 L 172,112 L 160,80 Z" stroke="var(--teal)" stroke-width="1.8" fill="rgba(54,224,194,0.12)"/>
      <path d="M 120,35 L 125,22 L 165,22 L 170,35" stroke="var(--cream)" stroke-width="1.8" fill="none"/>
      <circle cx="145" cy="28" r="3.5" stroke="var(--teal)" stroke-width="1.5" fill="rgba(54,224,194,0.2)"/>
      <path d="M 210,45 L 280,45 L 290,75 L 230,65 Z" stroke="var(--cream)" stroke-width="1.8" fill="rgba(236,232,223,0.04)"/>
      <circle cx="20" cy="50" r="8" fill="var(--red)" opacity="0.25" filter="blur(4px)"/>
    </svg>`;
  } else if (weaponName === "Mast-17") {
    return `<svg class="weapon-svg" viewBox="0 0 320 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M 0,20 L 320,20 M 0,60 L 320,60 M 0,100 L 320,100 M 40,0 L 40,120 M 120,0 L 120,120 M 200,0 L 200,120 M 280,0 L 280,120" stroke="rgba(236,232,223,0.03)" stroke-width="1"/>
      <path d="M 15,48 L 90,48 L 90,54 L 15,54 Z" stroke="var(--cream)" stroke-width="1.8" fill="rgba(236,232,223,0.08)"/>
      <path d="M 5,51 L 15,51" stroke="var(--red)" stroke-width="2.5"/>
      <path d="M 90,38 L 225,38 L 240,62 L 225,85 L 190,85 L 180,72 L 120,72 L 105,85 L 90,85 Z" stroke="var(--cream)" stroke-width="2.2" fill="rgba(236,232,223,0.08)"/>
      <path d="M 135,72 C 130,92 120,108 110,112 L 125,112 C 136,108 147,92 149,72 Z" stroke="var(--teal)" stroke-width="1.8" fill="rgba(54,224,194,0.12)"/>
      <path d="M 115,38 L 125,24 L 180,24 L 190,38" stroke="var(--cream)" stroke-width="1.8" fill="none"/>
      <line x1="125" y1="31" x2="180" y2="31" stroke="var(--teal)" stroke-width="1.5"/>
      <path d="M 225,45 L 295,45 L 300,78 L 280,78 L 252,65 L 225,62 Z" stroke="var(--cream)" stroke-width="1.8" fill="rgba(236,232,223,0.04)"/>
    </svg>`;
  } else {
    return `<svg class="weapon-svg" viewBox="0 0 320 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M 0,20 L 320,20 M 0,60 L 320,60 M 0,100 L 320,100 M 40,0 L 40,120 M 120,0 L 120,120 M 200,0 L 200,120 M 280,0 L 280,120" stroke="rgba(236,232,223,0.03)" stroke-width="1"/>
      <path d="M 10,44 L 80,44 L 80,56 L 10,56 Z" stroke="var(--cream)" stroke-width="1.8" fill="rgba(236,232,223,0.12)"/>
      <line x1="80" y1="50" x2="10" y2="50" stroke="var(--red)" stroke-width="2"/>
      <path d="M 80,32 L 220,32 L 220,90 L 182,90 L 172,98 L 110,98 L 110,90 L 80,90 Z" stroke="var(--cream)" stroke-width="2.2" fill="rgba(236,232,223,0.08)"/>
      <path d="M 120,90 L 120,115 L 155,115 L 155,90 Z" stroke="var(--teal)" stroke-width="1.8" fill="rgba(54,224,194,0.15)"/>
      <path d="M 100,32 L 105,18 L 150,18 L 155,32 Z" stroke="var(--cream)" stroke-width="1.8" fill="none"/>
      <path d="M 220,38 L 290,38 L 295,85 L 255,85 L 220,68 Z" stroke="var(--cream)" stroke-width="1.8" fill="rgba(236,232,223,0.08)"/>
    </svg>`;
  }
}

function renderProfileTabOverview() {
  const p = state.profile;
  const quickStats = profileStats.filter((s) => state.profile.visibleStats.includes(s.id)).slice(0, 4);

  return `<div class="pov-bento-grid">
    <!-- Bento Item 1: Hero identity card -->
    <div class="bento-card bento-hero">
      <div class="bento-hero-bg-glow" style="--profile-xp: ${p.xp}%;"></div>
      <div class="bento-hero-header">
        <div class="pov-banner-tag">
          ${icon("icon-zap")}
          <span>[${p.clanTag}] ${p.region}</span>
        </div>
        <div class="pov-stars-row">
          ${renderStarRating(p.starRating)}
        </div>
      </div>
      <div class="bento-hero-identity">
        <h2 class="pov-username">${escapeHtml(p.username)}</h2>
        <div class="profile-title-row">
          <span class="title-glow-text">${p.title}</span>
          <strong class="title-sub-label">Server Title</strong>
        </div>
      </div>
      <p class="pov-subtitle">Ready in <strong>${state.mode}</strong> &nbsp;·&nbsp; equipped with <strong>${state.primary}</strong>.</p>
      <div class="pov-banner-actions">
        <button class="micro-button" type="button" data-profile-invite>
          ${icon("icon-friends")} <span>Invite Link</span>
        </button>
        <button class="micro-button" type="button" data-profile-status>
          ${icon("icon-check")} <span>Presence</span>
        </button>
        <button class="micro-button" type="button" data-profile-refresh>
          ${icon("icon-zap")} <span>Sync State</span>
        </button>
      </div>
    </div>

    <!-- Bento Item 2: Quick stats metrics grid -->
    <div class="bento-card bento-stats">
      <div class="bento-header">
        <span class="card-kicker">Performance Summary</span>
        <h3>Combat Metrics</h3>
      </div>
      <div class="pov-quick-stats-grid">
        ${quickStats.map((s) => {
          let extraVisual = "";
          if (s.id === "kd") {
            const isGood = Number(s.value) >= 1.5;
            extraVisual = `<div class="stat-progress-bar"><div class="stat-progress-fill" style="width: ${Math.min(100, (Number(s.value)/2.5)*100)}%; background: ${isGood ? "var(--teal)" : "var(--red)"}"></div></div>`;
          } else if (s.id === "winRate") {
            extraVisual = `<div class="stat-progress-bar"><div class="stat-progress-fill" style="width: ${s.value}"></div></div>`;
          } else if (s.id === "headshot" || s.id === "accuracy") {
            extraVisual = `<div class="stat-progress-bar"><div class="stat-progress-fill" style="width: ${s.value}; background: var(--teal)"></div></div>`;
          }
          return `<div class="pov-quick-stat-box">
            <span class="pov-quick-stat-label">${s.label}</span>
            <span class="pov-quick-stat-value">${profileStatValue(s)}</span>
            ${extraVisual}
            <span class="pov-quick-stat-meta">${s.meta}</span>
          </div>`;
        }).join("")}
      </div>
    </div>

    <!-- Bento Item 3: Player ID dossier card -->
    <div class="bento-card bento-id">
      <span class="pov-id-card-label">Operator Signature ID</span>
      <strong class="pov-id-card-value">${p.playerId}</strong>
      <p class="pov-id-card-desc">Authoritative cryptographic identifier generated by the Spark network core.</p>
      <button class="micro-button copy-id-btn" type="button" data-profile-copy-id>
        ${icon("icon-send")} <span>Copy Signature</span>
      </button>
    </div>

    <!-- Bento Item 4: Weapon Blueprint Showcase (Full Width) -->
    <div class="bento-card bento-blueprint">
      <div class="blueprint-header">
        <div>
          <span class="card-kicker">Showcase Blueprint</span>
          <h3>${state.primary}</h3>
          <p>${state.sidearm} sidearm &nbsp;·&nbsp; ${state.cosmetic} finish.</p>
        </div>
        <div class="profile-loadout-actions">
          <button class="micro-button" type="button" data-profile-open-loadout>
            ${icon("icon-loadout")} <span>Configure</span>
          </button>
          <button class="micro-button" type="button" data-profile-favorite>
            ${icon("icon-star")} <span>Set Showcase</span>
          </button>
        </div>
      </div>
      <div class="blueprint-visual">
        ${renderWeaponSchematic(state.primary)}
      </div>
    </div>
  </div>`;
}

function renderProfileTabStats() {
  const visibleStats = profileStats.filter((s) => state.profile.visibleStats.includes(s.id));

  return `<div class="pstats-grid">
    <div class="bento-card">
      <div class="pstats-section-title">
        <span class="card-kicker">Showcase Stats</span>
        <h2>Active Combat Metrics</h2>
      </div>
      <div class="pstats-cards-grid">
        ${visibleStats.map((s) => {
          let statWidget = "";
          if (s.id === "kd") {
            const isGood = Number(s.value) >= 1.5;
            statWidget = `<div class="stat-widget-progress"><div class="stat-widget-fill" style="width: ${Math.min(100, (Number(s.value)/2.5)*100)}%; background: ${isGood ? "var(--teal)" : "var(--red)"}"></div></div>`;
          } else if (s.id === "winRate") {
            statWidget = `<div class="stat-widget-progress"><div class="stat-widget-fill" style="width: ${s.value}; background: var(--gold)"></div></div>`;
          } else if (s.id === "headshot" || s.id === "accuracy") {
            statWidget = `<div class="stat-widget-progress"><div class="stat-widget-fill" style="width: ${s.value}; background: var(--teal)"></div></div>`;
          } else if (s.id === "matches") {
            statWidget = `<div class="stat-widget-badge">Competitive Queue</div>`;
          } else if (s.id === "mvps") {
            statWidget = `<div class="stat-widget-badge gold">MVP Trophy</div>`;
          } else if (s.id === "rankRating") {
            statWidget = `<div class="stat-widget-badge teal">Gold Ladder Rating</div>`;
          }
          return `<div class="pstats-card-enhanced">
            <div class="pstats-card-header">
              <span class="pstats-card-label">${s.label}</span>
              <span class="pstats-card-value">${profileStatValue(s)}</span>
            </div>
            ${statWidget}
            <span class="pstats-card-meta">${s.meta}</span>
          </div>`;
        }).join("")}
      </div>
    </div>

    <div class="pstats-visibility bento-card">
      <div class="pstats-section-title">
        <span class="card-kicker">Operator Dashboard Configuration</span>
        <h2>Stat Card Visibility Control</h2>
      </div>
      <div class="pstats-toggle-grid-enhanced">
        ${profileStats.map((s) => {
          const visible = state.profile.visibleStats.includes(s.id);
          return `<button class="stat-toggle-enhanced ${visible ? "is-active" : ""}" type="button"
            aria-pressed="${visible}" data-profile-stat-toggle="${s.id}">
            <span class="toggle-dot"></span>
            <div class="toggle-copy">
              <span>${s.label}</span>
              <p>${visible ? "Visible on Operator card" : "Hidden from Operator card"}</p>
            </div>
          </button>`;
        }).join("")}
      </div>
    </div>
  </div>`;
}

function renderProfileTabAchievements() {
  const p = state.profile;
  return `<div class="pach-layout">
    <div class="pach-section">
      <div class="pach-section-title">
        <span class="card-kicker">Achievements</span>
        <h2>Recent flex</h2>
      </div>
      ${p.achievements.map((a) => `<div class="pach-card">
        <span class="pach-card-icon">${icon("icon-star")}</span>
        <div>
          <span class="pach-card-name">${a.name}</span>
          <span class="pach-card-meta">${a.meta}</span>
        </div>
      </div>`).join("")}
    </div>

    <div class="pach-section">
      <div class="pach-section-title">
        <span class="card-kicker">Badges</span>
        <h2>Identity marks</h2>
      </div>
      <div class="pach-badge-grid">
        ${p.badges.map((b) => `<span class="badge-chip">${icon("icon-shield")} ${b}</span>`).join("")}
      </div>
    </div>
  </div>`;
}

function renderProfileTabSocial() {
  return `<div class="psoc-layout">
    <div class="psoc-header-card">
      <div>
        <span class="card-kicker">Squad Link</span>
        <p class="psoc-header-title">Squad link ready</p>
        <p class="psoc-header-desc">Invite routing, friend code, and current status are staged for backend wiring.</p>
      </div>
      <div class="psoc-actions">
        <button class="micro-button" type="button" data-profile-invite>
          ${icon("icon-friends")} <span>Invite</span>
        </button>
        <button class="micro-button" type="button" data-profile-status>
          ${icon("icon-check")} <span>Status</span>
        </button>
      </div>
    </div>

    <div class="psoc-friends-section">
      <h2 class="psoc-friends-title">Online Friends</h2>
      ${friends.map((f) => `<article class="friend-row">
        <span class="friend-dot ${f.online ? "online" : ""}" aria-hidden="true"></span>
        <div>
          <h2>${f.name}</h2>
          <p>${f.status}</p>
        </div>
        <div class="friend-actions">
          <button class="micro-button" type="button" data-invite="${f.name}">
            ${icon("icon-play")} <span>Invite</span>
          </button>
          <button class="micro-button" type="button" data-whisper="${f.name}">
            ${icon("icon-chat")} <span>Chat</span>
          </button>
        </div>
      </article>`).join("")}
    </div>
  </div>`;
}

function renderProfileTabCustomise() {
  const p = state.profile;
  const renameDate = formatProfileDate(p.usernameChangeAvailableOn);
  return `<div class="pcust-layout">
    <div class="pcust-section">
      <div class="pcust-section-header">
        <span class="card-kicker">Identity</span>
        <h2>Operator customisation</h2>
      </div>
      <div class="pcust-grid">
        <button class="pcust-card" type="button" data-profile-avatar>
          ${icon("icon-profile")}
          <span class="pcust-card-label">Avatar</span>
          <span class="pcust-card-value">${p.avatar}</span>
          <span class="pcust-card-sub">6-month change window</span>
        </button>
        <button class="pcust-card" type="button" data-profile-banner>
          ${icon("icon-star")}
          <span class="pcust-card-label">Banner</span>
          <span class="pcust-card-value">${p.banner}</span>
          <span class="pcust-card-sub">6-month change window</span>
        </button>
        <button class="pcust-card is-locked" type="button" data-profile-username disabled>
          ${icon("icon-shield")}
          <span class="pcust-card-label">Username</span>
          <span class="pcust-card-value">Locked</span>
          <span class="pcust-card-sub">Next change: ${renameDate}</span>
        </button>
        <article class="pcust-card is-server-owned">
          ${icon("icon-zap")}
          <span class="pcust-card-label">Title</span>
          <span class="pcust-card-value">Auto Assigned</span>
          <span class="pcust-card-sub">Granted by server performance</span>
        </article>
      </div>
    </div>
  </div>`;
}

function renderArena() {
  return `<div class="arena-layout">
    <div class="cc-section-header">
      <span class="card-kicker">Queue Contract</span>
      <h2>Arena Mode</h2>
    </div>
    ${renderMode()}
  </div>`;
}

function renderArsenal() {
  return `<div class="arsenal-layout">
    <div class="cc-section-header">
      <span class="card-kicker">Arsenal</span>
      <h2>Loadout Selection</h2>
    </div>
    ${renderLoadout()}
  </div>`;
}

function renderStore() {
  return `<div class="store-layout">
    <div class="cc-section-header">
      <span class="card-kicker">Quartermaster</span>
      <h2>Cosmetic Store</h2>
    </div>
    ${renderShop()}
  </div>`;
}

function renderSquadChat() {
  const isLive   = state.chatStatus === "live";
  const isBusy   = state.chatStatus === "connecting";
  const isError  = state.chatStatus === "error";
  const disabled = !isLive ? "disabled" : "";

  // Status indicator text + CSS modifier
  const statusLabel = { off: "Offline", connecting: "Connecting…", live: "Live", error: "Error" }[state.chatStatus] ?? "";
  const statusMod   = `chat-status--${state.chatStatus}`;

  const messagesHtml = state.chat.length
    ? state.chat
        .map(
          (msg) => `<article class="chat-line" data-msg-id="${escapeHtml(msg.id ?? "")}">
            <strong>${escapeHtml(msg.username)}</strong>
            <p>${escapeHtml(msg.body)}</p>
          </article>`,
        )
        .join("")
    : `<p class="chat-empty">${
        isError      ? "Connection lost. Reload to reconnect." :
        isBusy       ? "Connecting to lobby chat…" :
        isLive       ? "No messages yet. Say hello!" :
                       "Sign in to join the lobby chat."
      }</p>`;

  return `<div class="drawer-chat-container">
    <div class="chat-container">
      <div class="chat-status-bar ${statusMod}" aria-live="polite">
        <span class="chat-status-dot" aria-hidden="true"></span>
        <span class="chat-status-label">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="chat-log" id="chatLog">
        ${messagesHtml}
      </div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" name="message" type="text" autocomplete="off"
          placeholder="${isLive ? "Lobby message…" : "Sign in to chat"}"
          maxlength="${MAX_MESSAGE_LENGTH}"
          value="${escapeHtml(state.chatDraft)}"
          ${disabled} />
        <button class="micro-button" type="submit" aria-label="Send chat message" ${disabled}>
          ${icon("icon-send")}
          <span>Send</span>
        </button>
      </form>
    </div>
  </div>`;
}


function renderSquadFriends() {
  return `<div class="drawer-friends-container">
    <div class="squad-friends-list">
      ${friends
        .map(
          (friend) => `<article class="friend-row">
            <span class="friend-dot ${friend.online ? "online" : ""}" aria-hidden="true"></span>
            <div>
              <h2>${friend.name}</h2>
              <p>${friend.status}</p>
            </div>
            <div class="friend-actions">
              <button class="micro-button" type="button" data-invite="${friend.name}">
                ${icon("icon-play")}
                <span>Invite</span>
              </button>
              <button class="micro-button" type="button" data-whisper="${friend.name}">
                ${icon("icon-chat")}
                <span>Chat</span>
              </button>
            </div>
          </article>`,
        )
        .join("")}
    </div>
  </div>`;
}

function renderCareer() {
  return `<div class="career-layout">
    <aside class="career-sidebar">
      <div class="career-sidebar-identity">
        <div class="career-sidebar-avatar" id="careerSidebarAvatar"></div>
        <div class="career-sidebar-info">
          <span class="career-sidebar-clan" id="careerSidebarClan"></span>
          <h2 class="career-sidebar-username" id="careerSidebarUsername"></h2>
          <span class="career-sidebar-title" id="careerSidebarTitle"></span>
        </div>
        <div class="career-sidebar-stars" id="careerSidebarStars"></div>
      </div>

      <nav class="career-nav" aria-label="Career sections">
        <button class="career-nav-item" data-career-tab="overview">
          <svg class="icon" aria-hidden="true"><use href="#icon-profile"></use></svg>
          <span>Overview</span>
        </button>
        <button class="career-nav-item" data-career-tab="stats">
          <svg class="icon" aria-hidden="true"><use href="#icon-crosshair"></use></svg>
          <span>Stats</span>
        </button>
        <button class="career-nav-item" data-career-tab="achievements">
          <svg class="icon" aria-hidden="true"><use href="#icon-star"></use></svg>
          <span>Achievements</span>
        </button>
        <button class="career-nav-item" data-career-tab="social">
          <svg class="icon" aria-hidden="true"><use href="#icon-friends"></use></svg>
          <span>Social</span>
        </button>
        <button class="career-nav-item" data-career-tab="customise">
          <svg class="icon" aria-hidden="true"><use href="#icon-shield"></use></svg>
          <span>Customise</span>
        </button>
      </nav>

      <div class="career-sidebar-footer">
        <div class="career-sidebar-id" id="careerSidebarId"></div>
        <div class="career-sidebar-xp">
          <span class="career-sidebar-xp-label">Season XP</span>
          <div class="career-sidebar-xp-bar">
            <div class="career-sidebar-xp-fill" id="careerSidebarXpFill"></div>
          </div>
          <span class="career-sidebar-xp-val" id="careerSidebarXpVal"></span>
        </div>
      </div>
    </aside>

    <div class="career-content">
      <header class="career-content-header">
        <div>
          <span class="eyebrow" id="careerTabKicker">Operator</span>
          <h1 id="careerTabTitle">Overview</h1>
        </div>
      </header>

      <div class="career-tab-body" id="careerTabBody"></div>
    </div>
  </div>`;
}

function renderMode() {
  return `<div class="panel-grid">
    ${modes
      .map((mode) => {
        const selected = mode.name === state.mode;
        return `<article class="option-card ${selected ? "is-selected" : ""}">
          <div class="card-copy">
            <span class="card-icon">${icon(mode.icon)}</span>
            <div>
              <span class="card-kicker">${mode.meta}</span>
              <h2>${mode.name}</h2>
              <p>${mode.desc}</p>
            </div>
          </div>
          <button class="micro-button" type="button" data-mode="${mode.name}" ${selected ? "disabled" : ""}>
            ${icon(selected ? "icon-check" : "icon-play")}
            <span>${selected ? "Active" : "Select"}</span>
          </button>
        </article>`;
      })
      .join("")}
  </div>`;
}

function renderLoadout() {
  return `<div class="panel-grid">
    ${weapons
      .map((weapon) => {
        const equipped = weapon.name === state.primary;
        return `<article class="option-card ${equipped ? "is-selected" : ""}">
          <div class="card-copy">
            <span class="card-icon">${icon(weapon.icon)}</span>
            <div>
              <span class="card-kicker">${weapon.meta}</span>
              <h2>${weapon.name}</h2>
              <p>${weapon.desc}</p>
            </div>
          </div>
          <button class="micro-button" type="button" data-equip="${weapon.name}" ${equipped ? "disabled" : ""}>
            ${icon(equipped ? "icon-check" : "icon-loadout")}
            <span>${equipped ? "Equipped" : "Equip"}</span>
          </button>
        </article>`;
      })
      .join("")}
    <article class="option-card">
      <div class="card-copy">
        <span class="card-icon">${icon("icon-mode")}</span>
        <div>
          <span class="card-kicker">Sidearm</span>
          <h2>${state.sidearm}</h2>
          <p>Compact armor-piercing backup with snap-ready iron sights.</p>
        </div>
      </div>
      <button class="micro-button" type="button" data-sidearm>
        ${icon("icon-check")}
        <span>Tuned</span>
      </button>
    </article>
  </div>`;
}

function renderShop() {
  return `<div class="coming-soon-container">
    <span class="coming-soon-icon">${icon("icon-shop")}</span>
    <h2>Shop will be added soon</h2>
    <p>The storefront is currently offline. Tactical weapon skins and custom decals will be deployed in a future synchronization patch.</p>
  </div>`;
}

function renderProfile() {
  const visibleStats = profileStats.filter((stat) => state.profile.visibleStats.includes(stat.id));
  const renameDate = formatProfileDate(state.profile.usernameChangeAvailableOn);

  return `<div class="profile-dossier">
    <section class="profile-hero-card">
      <div class="profile-banner" aria-label="${state.profile.banner} banner">
        ${renderIdentityAvatar()}
        <div class="profile-identity-copy">
          <span class="card-kicker">[${state.profile.clanTag}] ${state.profile.region}</span>
          <h2>${escapeHtml(state.profile.username)}</h2>
          <div class="profile-title-row">
            <span>${state.profile.title}</span>
            <strong>Server title</strong>
          </div>
          <div class="profile-stars" aria-label="${state.profile.starRating}-star player">
            ${renderStarRating(state.profile.starRating)}
            <strong>${state.profile.starRating}-star player</strong>
          </div>
          <p>${state.mode} ready | ${state.primary} equipped | ${state.cosmetic} finish.</p>
        </div>
        <div class="profile-id-card">
          <span>Player ID</span>
          <strong>${state.profile.playerId}</strong>
          <button class="micro-button" type="button" data-profile-copy-id>
            ${icon("icon-send")}
            <span>Copy</span>
          </button>
        </div>
      </div>

      <div class="profile-edit-grid">
        <button class="profile-edit-action" type="button" data-profile-avatar>
          ${icon("icon-profile")}
          <span>Avatar</span>
          <strong>${state.profile.avatar}</strong>
          <small>6-month change window</small>
        </button>
        <button class="profile-edit-action" type="button" data-profile-banner>
          ${icon("icon-star")}
          <span>Banner</span>
          <strong>${state.profile.banner}</strong>
          <small>6-month change window</small>
        </button>
        <button class="profile-edit-action is-locked" type="button" data-profile-username disabled>
          ${icon("icon-shield")}
          <span>Username</span>
          <strong>Locked</strong>
          <small>Next change ${renameDate}</small>
        </button>
        <article class="profile-edit-action is-server-owned">
          ${icon("icon-zap")}
          <span>Title</span>
          <strong>Auto assigned</strong>
          <small>Granted by server performance</small>
        </article>
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section-title">
        <span class="card-kicker">Showcase Stats</span>
        <h3>Visible on profile</h3>
      </div>
      <div class="profile-stat-grid">
        ${visibleStats
          .map(
            (stat) => `<article class="profile-stat-card">
              <span>${stat.label}</span>
              <strong>${profileStatValue(stat)}</strong>
              <p>${stat.meta}</p>
            </article>`,
          )
          .join("")}
      </div>
    </section>

    <section class="profile-section profile-loadout-card" tabindex="0">
      <div class="card-copy">
        <span class="card-icon">${icon("icon-loadout")}</span>
        <div>
          <span class="card-kicker">Hover Loadout</span>
          <h2>${state.primary}</h2>
          <p>${state.sidearm} sidearm | ${state.cosmetic} cosmetic. Actions appear on hover.</p>
        </div>
      </div>
      <div class="profile-loadout-actions">
        <button class="micro-button" type="button" data-profile-open-loadout>
          ${icon("icon-loadout")}
          <span>Edit</span>
        </button>
        <button class="micro-button" type="button" data-profile-favorite>
          ${icon("icon-star")}
          <span>Favorite</span>
        </button>
      </div>
    </section>

    <section class="profile-two-column">
      <article class="profile-section">
        <div class="profile-section-title">
          <span class="card-kicker">Badges</span>
          <h3>Identity marks</h3>
        </div>
        <div class="badge-grid">
          ${state.profile.badges.map((badge) => `<span class="badge-chip">${icon("icon-shield")} ${badge}</span>`).join("")}
        </div>
      </article>

      <article class="profile-section">
        <div class="profile-section-title">
          <span class="card-kicker">Achievements</span>
          <h3>Recent flex</h3>
        </div>
        <div class="achievement-list">
          ${state.profile.achievements
            .map(
              (achievement) => `<div class="achievement-chip">
                ${icon("icon-star")}
                <div>
                  <strong>${achievement.name}</strong>
                  <span>${achievement.meta}</span>
                </div>
              </div>`,
            )
            .join("")}
        </div>
      </article>
    </section>

    <section class="profile-section">
      <div class="profile-section-title">
        <span class="card-kicker">Stat Privacy</span>
        <h3>Choose what others see</h3>
      </div>
      <div class="stat-toggle-grid">
        ${profileStats
          .map((stat) => {
            const visible = state.profile.visibleStats.includes(stat.id);
            return `<button class="stat-toggle ${visible ? "is-on" : ""}" type="button" aria-pressed="${visible}" data-profile-stat-toggle="${stat.id}">
              <span>${stat.label}</span>
              <strong>${visible ? "Shown" : "Hidden"}</strong>
            </button>`;
          })
          .join("")}
      </div>
    </section>

    <section class="profile-social-panel">
      <div>
        <span class="card-kicker">Social</span>
        <h3>Squad link ready</h3>
        <p>Invite routing, friend code, and current status are staged for backend wiring.</p>
      </div>
      <div class="profile-social-actions">
        <button class="micro-button" type="button" data-profile-invite>
          ${icon("icon-friends")}
          <span>Invite</span>
        </button>
        <button class="micro-button" type="button" data-profile-status>
          ${icon("icon-check")}
          <span>Status</span>
        </button>
        <button class="micro-button" type="button" data-profile-refresh>
          ${icon("icon-zap")}
          <span>Sync</span>
        </button>
      </div>
    </section>
  </div>`;
}

function renderFriends() {
  return `<div class="panel-grid">
    ${friends
      .map(
        (friend) => `<article class="friend-row">
          <span class="friend-dot ${friend.online ? "online" : ""}" aria-hidden="true"></span>
          <div>
            <h2>${friend.name}</h2>
            <p>${friend.status}</p>
          </div>
          <div class="friend-actions">
            <button class="micro-button" type="button" data-invite="${friend.name}">
              ${icon("icon-play")}
              <span>Invite</span>
            </button>
            <button class="micro-button" type="button" data-whisper="${friend.name}">
              ${icon("icon-chat")}
              <span>Chat</span>
            </button>
          </div>
        </article>`,
      )
      .join("")}
  </div>`;
}

function renderChat() {
  return `<div class="chat-log" id="chatLog">
    ${state.chat
      .map(
        (msg) => `<article class="chat-line" data-msg-id="${escapeHtml(msg.id ?? "")}">
          <strong>${escapeHtml(msg.username)}</strong>
          <p>${escapeHtml(msg.body)}</p>
        </article>`,
      )
      .join("")}
  </div>
  <form class="chat-form" id="chatForm">
    <input id="chatInput" name="message" type="text" autocomplete="off"
      placeholder="Lobby message…"
      maxlength="${MAX_MESSAGE_LENGTH}"
      value="${escapeHtml(state.chatDraft)}" />
    <button class="micro-button" type="submit" aria-label="Send chat message">
      ${icon("icon-send")}
      <span>Send</span>
    </button>
  </form>`;
}


function renderSettings() {
  return `<div class="settings-layout">
    <section class="settings-section">
      <div class="settings-section-title">
        <span class="card-kicker">Gameplay</span>
        <h2>Input & Combat</h2>
      </div>
      ${settingToggle("autoSprint", "Auto sprint", "Automatically sprint when moving forward.", "icon-zap")}
      ${settingToggle("rawInput", "Raw mouse input", "Bypasses pointer smoothing for cleaner aim.", "icon-mode")}
      ${settingToggle("hitMarkers", "Hit markers", "Shows confirmation feedback when shots connect.", "icon-crosshair")}
    </section>

    <section class="settings-section">
      <div class="settings-section-title">
        <span class="card-kicker">Graphics</span>
        <h2>Display</h2>
      </div>
      ${settingSelect("resolution", "Resolution", ["1280 x 720", "1600 x 900", "1920 x 1080", "2560 x 1440"], "icon-settings")}
      ${settingSelect("graphicsQuality", "Quality preset", ["Low", "Medium", "High", "Ultra"], "icon-star")}
      ${settingSelect("fpsCap", "FPS cap", ["60", "90", "144", "240", "Unlimited"], "icon-zap")}
    </section>

    <section class="settings-section crosshair-section">
      <div class="settings-section-title">
        <span class="card-kicker">Crosshair</span>
        <h2>Reticle</h2>
      </div>
      <div class="crosshair-editor">
        ${renderCrosshairPreview()}
        <div class="crosshair-controls">
          <article class="settings-control">
            <div>
              <h3>Color</h3>
              <p>${state.settings.crosshairColor}</p>
            </div>
            <input class="color-control" type="color" value="${state.settings.crosshairColor}" data-setting-color="crosshairColor" aria-label="Crosshair color" />
          </article>
          ${settingRange("crosshairSize", "Line size", 2, 9, "icon-crosshair")}
          ${settingRange("crosshairGap", "Center gap", 1, 12, "icon-mode")}
          ${settingToggle("crosshairOutlines", "Outlines", "Adds contrast for bright maps.", "icon-shield")}
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div class="settings-section-title">
        <span class="card-kicker">Audio</span>
        <h2>Mix</h2>
      </div>
      ${settingRange("masterVolume", "Master volume", 0, 100, "icon-volume")}
      ${settingRange("musicVolume", "Music", 0, 100, "icon-volume")}
      ${settingRange("matchVolume", "In-game match sounds", 0, 100, "icon-zap")}
      ${settingToggle("voice", "Voice chat", "Team voice channel for lobby and match.", "icon-chat")}
    </section>

    <section class="settings-section">
      <div class="settings-section-title">
        <span class="card-kicker">Other</span>
        <h2>Launch & Performance</h2>
      </div>
      ${settingToggle("fullscreenOnPlay", "Fullscreen on Play", "Attempts fullscreen when matchmaking starts.", "icon-play")}
      ${settingToggle("potatoMode", "Potato PC mode", "Reduces background intensity and extra motion.", "icon-shield")}
      ${settingToggle("motion", "Menu motion", "Keeps tactical background animation active.", "icon-zap")}
    </section>
  </div>`;
}

const creditsTeam = [
  {
    handle: "god_of_entities",
    initials: "GE",
    rank: "Senior Game Developer",
    accentClass: "credits-accent-red",
    summary: "Engineered the complete game client — from physics simulation to the full UI system.",
    contributions: [
      { icon: "icon-mode",      label: "UI / UX Design",              desc: "Full lobby, HUD, overlays, and panel system" },
      { icon: "icon-loadout",   label: "Map · Characters · Weapons",   desc: "Asset integration and scene management" },
      { icon: "icon-play",      label: "Production",                   desc: "Build pipeline, release management, QA" },
      { icon: "icon-zap",       label: "Updates & Maintenance",        desc: "Patch cadence, feature rollouts, hotfixes" },
      { icon: "icon-shield",    label: "Backend · Game Logic",         desc: "Physics engine, server-side game rules, networking hooks" },
    ],
  },
  {
    handle: "Aryan Sharma",
    initials: "AS",
    rank: "Senior Developer & Designer",
    accentClass: "credits-accent-teal",
    summary: "Laid the foundational prototype and shaped the creative direction of PotSpark FPS.",
    contributions: [
      { icon: "icon-zap",       label: "Foundational Prototype",       desc: "Initial codebase, architecture decisions, proof-of-concept" },
      { icon: "icon-mode",      label: "First Map",                    desc: "Pioneered first arena design (retired build)" },
      { icon: "icon-star",      label: "UI / UX Guidance",             desc: "Visual language, colour palette, layout principles" },
      { icon: "icon-credits",   label: "App Flow Planning",            desc: "Screen transitions, menu hierarchy, user journey" },
      { icon: "icon-profile",   label: "Character Design",             desc: "Operator silhouettes, gear language, identity system" },
      { icon: "icon-crosshair", label: "Game Events Logic",            desc: "Announcement system design and event-driven UI hooks" },
    ],
  },
];

function renderCredits() {
  const year = new Date().getFullYear();
  return `
  <div class="credits-layout">

    <!-- Studio header -->
    <div class="credits-studio-header">
      <div class="credits-studio-logo">
      ${logoSvg()}
      <div>
        <p>PotSpark</p>
        <strong>FPS Core</strong>
      </div>
    </div>
      <div class="credits-studio-meta">
        <span class="card-kicker">Development Team</span>
        <p class="credits-studio-desc">Built from scratch by a two-person team — every line of code, every pixel, every mechanic.</p>
      </div>
    </div>

    <!-- Team cards -->
    <div class="credits-team-grid">
      ${creditsTeam.map((member) => `
        <article class="credits-member-card ${member.accentClass}">
          <!-- Card header -->
          <div class="credits-member-header">
            <div class="credits-member-avatar">${member.initials}</div>
            <div class="credits-member-meta">
              <span class="credits-member-rank">${member.rank}</span>
              <h2 class="credits-member-name">${member.handle}</h2>
              <p class="credits-member-summary">${member.summary}</p>
            </div>
          </div>

          <!-- Contribution list -->
          <ul class="credits-contrib-list">
            ${member.contributions.map((c) => `
              <li class="credits-contrib-item">
                <span class="credits-contrib-icon">${icon(c.icon)}</span>
                <div class="credits-contrib-copy">
                  <strong class="credits-contrib-label">${c.label}</strong>
                  <span class="credits-contrib-desc">${c.desc}</span>
                </div>
              </li>`).join("")}
          </ul>
        </article>
      `).join("")}
    </div>

    <!-- Footer -->
    <div class="credits-footer">
      <span>${icon("icon-shield")}</span>
      <p>© ${year} PotSpark FPS &nbsp;·&nbsp; All systems prototype-grade &nbsp;·&nbsp; Built with precision.</p>
    </div>

  </div>`;
}

function startQueue() {
  state.queue = "searching";
  queueProgress = 0;

  // Restart entrance animation
  if (queuePanel) {
    queuePanel.style.animation = "none";
    void queuePanel.offsetWidth;
    queuePanel.style.animation = "";
  }
  queuePanel.hidden = false;
  queueFill.style.width = "0%";
  queueStatus.textContent = "Finding squad-ready arena";
  playButton.classList.add("is-queueing");
  playText.textContent = "Cancel";
  showToast("Matchmaking started for " + state.mode + ".");

  window.clearInterval(queueTimer);
  queueTimer = window.setInterval(() => {
    queueProgress = Math.min(100, queueProgress + 9 + Math.round(Math.random() * 9));
    queueFill.style.width = queueProgress + "%";

    if (queueProgress > 68) {
      queueStatus.textContent = "Locking Redline Yard instance";
    }

    if (queueProgress >= 100) {
      window.clearInterval(queueTimer);
      state.queue = "ready";
      playButton.classList.remove("is-queueing");
      playText.textContent = "Deploy";
      queueStatus.textContent = "Arena ready - deploy when set";
      showToast("Arena ready. Play button is now Deploy.");
    }
  }, 420);
}

function hideQueuePanel() {
  if (!queuePanel || queuePanel.hidden) return;
  queuePanel.classList.add("is-closing");
  window.setTimeout(() => {
    queuePanel.hidden = true;
    queuePanel.classList.remove("is-closing");
  }, 180);
}

function cancelQueue() {
  window.clearInterval(queueTimer);
  state.queue = "idle";
  hideQueuePanel();
  playButton.classList.remove("is-queueing");
  playButton.disabled = false;
  playText.textContent = "Play";
  showToast("Queue cancelled.");
}

function deployReadyArena() {
  beginArenaDeployment();
}

function handlePanelClick(event) {
  const modeButton = event.target.closest("[data-mode]");
  const equipButton = event.target.closest("[data-equip]");
  const shopButton = event.target.closest("[data-shop]");
  const sidearmButton = event.target.closest("[data-sidearm]");
  const syncButton = event.target.closest("[data-profile-refresh]");
  const avatarButton = event.target.closest("[data-profile-avatar]");
  const bannerButton = event.target.closest("[data-profile-banner]");
  const statToggleButton = event.target.closest("[data-profile-stat-toggle]");
  const copyIdButton = event.target.closest("[data-profile-copy-id]");
  const profileLoadoutButton = event.target.closest("[data-profile-open-loadout]");
  const profileFavoriteButton = event.target.closest("[data-profile-favorite]");
  const profileInviteButton = event.target.closest("[data-profile-invite]");
  const profileStatusButton = event.target.closest("[data-profile-status]");
  const inviteButton = event.target.closest("[data-invite]");
  const whisperButton = event.target.closest("[data-whisper]");
  const toggleButton = event.target.closest("[data-toggle]");
  const careerTabBtn = event.target.closest("[data-career-tab]");
  const deployContinueButton = event.target.closest("[data-deploy-continue]");
  const deployCancelButton = event.target.closest("[data-deploy-cancel]");

  if (deployContinueButton) {
    beginArenaDeployment();
    return;
  }

  if (deployCancelButton) {
    closeUtilityModal();
    return;
  }

  if (careerTabBtn) {
    switchCareerTab(careerTabBtn.dataset.careerTab);
    return;
  }

  if (modeButton) {
    state.mode = modeButton.dataset.mode;
    showToast(state.mode + " selected.");
    openControlCenter("arena");
    return;
  }

  if (equipButton) {
    state.primary = equipButton.dataset.equip;
    showToast(state.primary + " equipped.");
    openControlCenter("arsenal");
    return;
  }

  if (shopButton) {
    const item = shopItems.find((entry) => entry.name === shopButton.dataset.shop);
    if (!item) return;
    if (!item.owned && state.credits >= item.cost) {
      state.credits -= item.cost;
      item.owned = true;
      showToast(item.name + " purchased.");
    } else {
      showToast(item.name + " equipped.");
    }
    state.cosmetic = item.name;
    openControlCenter("store");
    return;
  }

  if (sidearmButton) {
    showToast(state.sidearm + " is already tuned.");
    return;
  }

  if (syncButton) {
    showToast("Profile synced with current lobby state.");
    openControlCenter("career");
    return;
  }

  if (avatarButton) {
    showToast("Avatar editor ready. Backend save will enforce the 6-month window.");
    return;
  }

  if (bannerButton) {
    showToast("Banner selector ready. Backend save will enforce the 6-month window.");
    return;
  }

  if (statToggleButton) {
    const statId = statToggleButton.dataset.profileStatToggle;
    const stat = profileStats.find((entry) => entry.id === statId);
    const isVisible = state.profile.visibleStats.includes(statId);

    if (isVisible && state.profile.visibleStats.length === 1) {
      showToast("Keep at least one profile stat visible.");
      return;
    }

    state.profile.visibleStats = isVisible
      ? state.profile.visibleStats.filter((entry) => entry !== statId)
      : [...state.profile.visibleStats, statId];
    showToast(`${stat?.label || "Stat"} ${isVisible ? "hidden" : "shown"} on your identity card.`);
    switchControlCenterTab("career");
    return;
  }

  if (copyIdButton) {
    navigator.clipboard?.writeText(state.profile.playerId).catch(() => {});
    showToast("Player ID copied.");
    return;
  }

  if (profileLoadoutButton) {
    showToast("Loadout opened from profile.");
    openControlCenter("arsenal");
    return;
  }

  if (profileFavoriteButton) {
    showToast(state.primary + " set as showcased weapon.");
    return;
  }

  if (profileInviteButton) {
    showToast("Squad invite link staged.");
    return;
  }

  if (profileStatusButton) {
    showToast("Presence set to squad-ready.");
    return;
  }

  if (inviteButton) {
    showToast("Invite sent to " + inviteButton.dataset.invite + ".");
    return;
  }

  if (whisperButton) {
    state.chatDraft = "@" + whisperButton.dataset.whisper + " ";
    openSocialDrawer("chat");
    showToast("Chat opened for " + whisperButton.dataset.whisper + ".");
    return;
  }

  if (toggleButton) {
    const key = toggleButton.dataset.toggle;
    state.settings[key] = !state.settings[key];
    if (key === "potatoMode") {
      state.settings.graphicsQuality = state.settings.potatoMode ? "Low" : "High";
      state.settings.fpsCap = state.settings.potatoMode ? "60" : "144";
      state.settings.motion = !state.settings.potatoMode;
    }
    applySettingsEffects();
    showToast(settingLabel(key) + " " + (state.settings[key] ? "enabled." : "disabled."));
    openUtilityModal("settings");
  }
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const input = event.target.querySelector("#chatInput");
  if (!input) return;
  const message = input.value.trim();
  if (!message) {
    showToast("Type a message first.");
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    showToast(`Message too long (max ${MAX_MESSAGE_LENGTH} characters).`);
    return;
  }

  // Optimistically clear the input so the user can type the next message while
  // the request is in-flight. The message itself will appear via the Realtime
  // subscription once the INSERT is confirmed by Supabase.
  input.value = "";
  input.focus();
  state.chatDraft = "";

  const ok = await chatClient.send(message);
  if (!ok) {
    // Restore draft so the user doesn't lose what they typed.
    input.value = message;
    state.chatDraft = message;
    showToast("Could not send — check connection.");
  }
}


function handlePanelInput(event) {
  const rangeKey = event.target.dataset.settingRange;
  const colorKey = event.target.dataset.settingColor;

  if (rangeKey) {
    state.settings[rangeKey] = Number(event.target.value);
    const output = utilityModalBody.querySelector(`[data-setting-output="${rangeKey}"]`);
    if (output) output.textContent = state.settings[rangeKey];
    if (rangeKey.startsWith("crosshair")) {
      const preview = utilityModalBody.querySelector(".crosshair-preview");
      if (preview) {
        preview.style.setProperty("--crosshair-size", `${state.settings.crosshairSize}px`);
        preview.style.setProperty("--crosshair-gap", `${state.settings.crosshairGap}px`);
      }
      applySettingsEffects();
    }
    return;
  }

  if (colorKey) {
    state.settings[colorKey] = event.target.value;
    const preview = utilityModalBody.querySelector(".crosshair-preview");
    if (preview) preview.style.setProperty("--crosshair-color", state.settings[colorKey]);
    const colorText = event.target.closest(".settings-control")?.querySelector("p");
    if (colorText) colorText.textContent = state.settings[colorKey];
    applySettingsEffects();
  }
}

function handlePanelChange(event) {
  const selectKey = event.target.dataset.settingSelect;
  if (!selectKey) return;

  state.settings[selectKey] = event.target.value;
  applySettingsEffects();
  showToast(settingLabel(selectKey) + " set to " + event.target.value + ".");
  openUtilityModal("settings");
}

function startProfileHoverEffect() {
  if (!profileButton) return;
  window.clearTimeout(profileFireTimer);
  profileButton.classList.add("is-profile-hovered");
  profileFireTimer = window.setTimeout(() => {
    profileButton.classList.add("is-fire-active");
  }, 60000);
}

function stopProfileHoverEffect() {
  if (!profileButton) return;
  window.clearTimeout(profileFireTimer);
  profileButton.classList.remove("is-profile-hovered", "is-fire-active");
}

if (profileButton) {
  profileButton.addEventListener("pointerenter", startProfileHoverEffect);
  profileButton.addEventListener("pointerleave", stopProfileHoverEffect);
  profileButton.addEventListener("focus", startProfileHoverEffect);
  profileButton.addEventListener("blur", stopProfileHoverEffect);
}

document.addEventListener("click", (event) => {
  const panelButton = event.target.closest("[data-panel]");
  if (panelButton) {
    const panelType = panelButton.dataset.panel;
    if (panelType === "mode" || panelType === "loadout" || panelType === "shop" || panelType === "profile") {
      const tabMap = { mode: "arena", loadout: "arsenal", shop: "store", profile: "career" };
      openControlCenter(tabMap[panelType]);
    } else if (panelType === "friends" || panelType === "chat") {
      openSocialDrawer(panelType);
    } else if (panelType === "settings" || panelType === "credits") {
      openUtilityModal(panelType);
    }
  }

  const ccTabBtn = event.target.closest("[data-cc-tab]");
  if (ccTabBtn) {
    switchControlCenterTab(ccTabBtn.dataset.ccTab);
  }

  const drawerTabBtn = event.target.closest("[data-drawer-tab]");
  if (drawerTabBtn) {
    switchSocialDrawerTab(drawerTabBtn.dataset.drawerTab);
  }
});

if (ccCloseBtn) {
  ccCloseBtn.addEventListener("click", closeControlCenter);
}

if (ccBody) {
  ccBody.addEventListener("click", handlePanelClick);
  ccBody.addEventListener("submit", handleChatSubmit);
  ccBody.addEventListener("input", handlePanelInput);
  ccBody.addEventListener("change", handlePanelChange);
}

if (socialDrawerCloseBtn) {
  socialDrawerCloseBtn.addEventListener("click", closeSocialDrawer);
}
if (socialDrawerBackdrop) {
  socialDrawerBackdrop.addEventListener("click", closeSocialDrawer);
}
if (socialDrawerBody) {
  socialDrawerBody.addEventListener("click", handlePanelClick);
  socialDrawerBody.addEventListener("submit", handleChatSubmit);
}

if (utilityModalCloseBtn) {
  utilityModalCloseBtn.addEventListener("click", closeUtilityModal);
}
if (utilityModalBackdrop) {
  utilityModalBackdrop.addEventListener("click", closeUtilityModal);
}
if (utilityModalBody) {
  utilityModalBody.addEventListener("click", handlePanelClick);
  utilityModalBody.addEventListener("input", handlePanelInput);
  utilityModalBody.addEventListener("change", handlePanelChange);
}

if (teamRoomButton) {
  teamRoomButton.addEventListener("click", openTeamRoomModal);
}
if (teamRoomCloseBtn) {
  teamRoomCloseBtn.addEventListener("click", closeTeamRoomModal);
}
if (teamRoomBackdrop) {
  teamRoomBackdrop.addEventListener("click", closeTeamRoomModal);
}
if (teamRoomBody) {
  teamRoomBody.addEventListener("input", (event) => {
    if (!event.target.matches("#teamRoomCodeInput")) return;
    event.target.value = event.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
    state.teamRoomError = "";
  });

  teamRoomBody.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-team-join-form]")) return;
    event.preventDefault();
    const code = event.target.elements.roomCode?.value || "";
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setTeamRoomPending(false, "Enter all six letters and numbers from the invite code.");
      return;
    }
    setTeamRoomPending(true);
    if (!joinTeamRoom(code)) {
      setTeamRoomPending(false, "The room server is not connected yet.");
    }
  });

  teamRoomBody.addEventListener("click", (event) => {
    if (event.target.closest("[data-team-create]")) {
      setTeamRoomPending(true);
      if (!createTeamRoom()) {
        setTeamRoomPending(false, "The room server is not connected yet.");
      }
      return;
    }
    if (event.target.closest("[data-team-copy-code]") && state.teamRoom?.code) {
      navigator.clipboard?.writeText(state.teamRoom.code).catch(() => {});
      showToast(`Room code ${state.teamRoom.code} copied.`);
      return;
    }
    const switchControl = event.target.closest("[data-team-switch]");
    if (switchControl) {
      const targetTeam = Number(switchControl.dataset.teamSwitch);
      const self = getSelfRoomPlayer();
      if (!self || targetTeam === self.team) return;
      setTeamRoomPending(true);
      if (!switchTeamRoomTeam(targetTeam)) {
        setTeamRoomPending(false, "The room server is not connected yet.");
      } else {
        showToast(`Switching to ${TEAM_NAMES[targetTeam]}...`);
      }
      return;
    }
    if (event.target.closest("[data-team-ready]")) {
      const self = getSelfRoomPlayer();
      if (!self) return;
      setTeamRoomPending(true);
      if (!setTeamRoomReady(!self.ready)) {
        setTeamRoomPending(false, "The room server is not connected yet.");
      }
      return;
    }
    if (event.target.closest("[data-team-leave]")) {
      setTeamRoomPending(true);
      if (!leaveTeamRoom()) {
        setTeamRoomPending(false, "The room server is not connected yet.");
      }
    }
  });
}

if (roadmapButton) {
  roadmapButton.addEventListener("click", openRoadmapModal);
}
if (roadmapCloseBtn) {
  roadmapCloseBtn.addEventListener("click", closeRoadmapModal);
}
if (roadmapBackdrop) {
  roadmapBackdrop.addEventListener("click", closeRoadmapModal);
}

playButton.addEventListener("click", () => {
  if (state.teamRoom) {
    openTeamRoomModal();
    showToast("Ready up in the team room. Deployment starts when everyone is ready.");
    return;
  }
  if (state.settings.fullscreenOnPlay && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {
      showToast("Fullscreen was blocked by the browser.");
    });
  }

  if (state.queue === "idle") {
    startQueue();
  } else if (state.queue === "searching") {
    cancelQueue();
  } else {
    deployReadyArena();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (controlCenter && !controlCenter.hidden) {
      closeControlCenter();
    }
    if (socialDrawer && !socialDrawer.hidden) {
      closeSocialDrawer();
    }
    if (utilityModal && !utilityModal.hidden) {
      closeUtilityModal();
    }
    if (teamRoomModal && !teamRoomModal.hidden) {
      closeTeamRoomModal();
    }
    if (roadmapModal && !roadmapModal.hidden) {
      closeRoadmapModal();
    }
  }
});

function setupCanvas() {
  const canvas = document.querySelector("#machineCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frameId = 0;
  let deployed = false;

  function canAnimate() {
    return !deployed &&
      !document.hidden &&
      !reduceMotion &&
      state.settings.motion &&
      !state.settings.potatoMode;
  }

  function queueFrame() {
    if (!frameId && canAnimate()) frameId = window.requestAnimationFrame(draw);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function cutPolygon(points, fill, stroke) {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function drawMapBlock(x, y, scale, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(236,232,223,0.2)";
    cutPolygon(
      [
        [-110, -54],
        [-20, -88],
        [92, -58],
        [122, 18],
        [48, 78],
        [-72, 58],
        [-126, -10],
      ],
      null,
      "rgba(236,232,223,0.18)",
    );
    cutPolygon(
      [
        [-74, -18],
        [-18, -42],
        [48, -20],
        [74, 22],
        [24, 48],
        [-46, 28],
      ],
      "rgba(255,70,85,0.06)",
      "rgba(255,70,85,0.28)",
    );
    ctx.beginPath();
    ctx.moveTo(-110, 0);
    ctx.lineTo(112, -26);
    ctx.moveTo(-12, -84);
    ctx.lineTo(-44, 62);
    ctx.moveTo(38, -62);
    ctx.lineTo(70, 58);
    ctx.strokeStyle = "rgba(236,232,223,0.12)";
    ctx.stroke();
    ctx.fillStyle = "rgba(236,232,223,0.42)";
    for (let i = 0; i < 7; i += 1) {
      const px = -82 + i * 31;
      const py = Math.sin(i * 1.7) * 42;
      ctx.fillRect(px, py, 4, 4);
    }
    ctx.restore();
  }

  function draw(time) {
    frameId = 0;
    const t = time * 0.001;
    ctx.clearRect(0, 0, width, height);

    ctx.globalAlpha = 0.62;
    ctx.strokeStyle = "rgba(236,232,223,0.06)";
    ctx.lineWidth = 1;
    for (let x = -height; x < width + height; x += 92) {
      ctx.beginPath();
      ctx.moveTo(x + ((t * 16) % 92), 0);
      ctx.lineTo(x + height * 0.9 + ((t * 16) % 92), height);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    drawMapBlock(width * 0.34, height * 0.44, 1, 0.68);
    drawMapBlock(width * 0.77, height * 0.5, 0.72, 0.42);

    const sweep = (t * 70) % (width + 260) - 130;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.translate(sweep, 0);
    cutPolygon(
      [
        [0, height * 0.18],
        [90, height * 0.16],
        [width * 0.32, height * 0.84],
        [width * 0.32 - 90, height * 0.86],
      ],
      "rgba(255,70,85,0.08)",
      null,
    );
    ctx.restore();

    ctx.globalAlpha = 0.78;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,70,85,0.46)";
    ctx.beginPath();
    ctx.moveTo(width * 0.16, height * 0.72);
    ctx.lineTo(width * 0.42, height * 0.64);
    ctx.lineTo(width * 0.53, height * 0.56);
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(236,232,223,0.26)";
    const cx = width * 0.62;
    const cy = height * 0.36;
    ctx.beginPath();
    ctx.arc(cx, cy, 44 + Math.sin(t * 1.4) * 3, 0, Math.PI * 2);
    ctx.moveTo(cx - 64, cy);
    ctx.lineTo(cx - 22, cy);
    ctx.moveTo(cx + 22, cy);
    ctx.lineTo(cx + 64, cy);
    ctx.moveTo(cx, cy - 64);
    ctx.lineTo(cx, cy - 22);
    ctx.moveTo(cx, cy + 22);
    ctx.lineTo(cx, cy + 64);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(236,232,223,0.12)";
    for (let i = 0; i < 6; i += 1) {
      const y = height * 0.18 + i * 52;
      ctx.beginPath();
      ctx.moveTo(width * 0.07, y);
      ctx.lineTo(width * 0.33, y - 18);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    queueFrame();
  }

  function syncAnimation() {
    if (canAnimate()) {
      queueFrame();
      return;
    }

    if (frameId) window.cancelAnimationFrame(frameId);
    frameId = 0;
  }

  resize();
  draw(performance.now());
  window.addEventListener("resize", () => {
    resize();
    if (!deployed) {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      draw(performance.now());
    }
  });
  document.addEventListener("visibilitychange", syncAnimation);
  window.addEventListener("potspark:menu-motion-change", syncAnimation);
  window.addEventListener("potspark:deploy", () => {
    deployed = true;
    syncAnimation();
    canvas.hidden = true;
  }, { once: true });
}

applySettingsEffects();
syncActiveButtons();
syncTeamRoomButtons();
renderTeamRoom();
setupCanvas();
const initialPanel = window.location.hash.replace("#", "");
if (initialPanel === "settings" || initialPanel === "credits") {
  openUtilityModal(initialPanel);
} else if (initialPanel === "friends" || initialPanel === "chat") {
  openSocialDrawer(initialPanel);
} else {
  const initialTabMap = {
    profile: "career",
    mode: "arena",
    loadout: "arsenal",
    shop: "store"
  };
  const tab = initialTabMap[initialPanel];
  if (tab) {
    openControlCenter(tab);
  }
}
showToast("PotSpark tactical lobby online.");

window.addEventListener("potspark:deploy", () => {
  logoDrawAnimation?.pause();
  window.clearTimeout(profileFireTimer);
  closeControlCenter();
  closeSocialDrawer();
  closeUtilityModal();
  closeTeamRoomModal();
});

window.addEventListener("potspark:auth-changed", (event) => {
  const user = event.detail?.user;
  const username = user?.username || "Guest Operator";
  state.profile.username = username;
  state.profile.initials = username
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "P";
  syncProfileButton();
  if (controlCenter && !controlCenter.hidden && ccActiveTab === "career") {
    renderControlCenterTab("career");
  }

  // Connect or disconnect the ChatClient based on login state.
  // user is null when signed out, truthy when authenticated.
  if (user && user.id) {
    chatClient.connect().catch((err) => {
      console.error("[ui] chatClient.connect error:", err);
    });
  } else {
    chatClient.disconnect().catch(() => {});
    state.chat = [];
    state.chatStatus = "off";
    // Re-render the chat tab if it is currently visible.
    if (socialDrawerBody && activeDrawerTab === "chat") {
      socialDrawerBody.innerHTML = renderSquadChat();
    }
  }
});

// ---------------------------------------------------------------------------
// Live message ingestion — appends to the DOM without a full re-render so
// the user's scroll position is preserved.
// ---------------------------------------------------------------------------

window.addEventListener("potspark:chat-message", (event) => {
  const msg = event.detail;
  if (!msg) return;

  // Deduplication: skip if already in state.
  if (state.chat.some((m) => m.id && m.id === msg.id)) return;

  state.chat.push(msg);
  // Keep the in-memory buffer bounded.
  if (state.chat.length > 100) state.chat.shift();

  // Append to the live DOM if the chat tab is open.
  if (socialDrawerBody && activeDrawerTab === "chat") {
    const chatLog = socialDrawerBody.querySelector("#chatLog");
    if (chatLog) {
      // Remove the empty-state placeholder if present.
      chatLog.querySelector(".chat-empty")?.remove();

      const article = document.createElement("article");
      article.className = "chat-line";
      article.dataset.msgId = msg.id ?? "";
      article.innerHTML = `<strong>${escapeHtml(msg.username)}</strong><p>${escapeHtml(msg.body)}</p>`;
      chatLog.appendChild(article);

      const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
      if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
    }
  }
});

// ---------------------------------------------------------------------------
// Status changes — update the status bar and (de-)activate the form.
// ---------------------------------------------------------------------------

window.addEventListener("potspark:chat-status", (event) => {
  const { status } = event.detail ?? {};
  if (!status) return;
  state.chatStatus = status;

  if (socialDrawerBody && activeDrawerTab === "chat") {
    // Re-render just the status bar and form controls.
    // Using a full renderSquadChat() would reset scroll — avoid it.
    const container = socialDrawerBody.querySelector(".chat-container");
    if (container) {
      // Update status bar
      const bar = container.querySelector(".chat-status-bar");
      if (bar) {
        bar.className = `chat-status-bar chat-status--${status}`;
        const label = bar.querySelector(".chat-status-label");
        if (label) {
          label.textContent = { off: "Offline", connecting: "Connecting…", live: "Live", error: "Error" }[status] ?? "";
        }
      }
      // Enable / disable form controls
      const isLive = status === "live";
      const input = container.querySelector("#chatInput");
      const sendBtn = container.querySelector("[type='submit']");
      if (input)   { input.disabled   = !isLive; input.placeholder = isLive ? "Lobby message…" : "Sign in to chat"; }
      if (sendBtn) sendBtn.disabled = !isLive;
    }
  }
});

// ---------------------------------------------------------------------------
// Chat errors — show a toast.
// ---------------------------------------------------------------------------

window.addEventListener("potspark:chat-error", (event) => {
  const message = event.detail?.message;
  if (message) showToast(message);
});

startLogoAnimation();

