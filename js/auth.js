import { refreshNetworkIdentity } from "./network.js";

const elements = {
  button: document.querySelector("#accountButton"),
  buttonKicker: document.querySelector("#accountButtonKicker"),
  buttonLabel: document.querySelector("#accountButtonLabel"),
  modal: document.querySelector("#accountModal"),
  backdrop: document.querySelector("#accountBackdrop"),
  close: document.querySelector("#accountCloseButton"),
  body: document.querySelector("#accountBody"),
};

const state = {
  config: null,
  session: { authenticated: false },
  providers: [],
  sessions: [],
  currentSessionId: null,
  view: "signin",
  busy: false,
  status: "",
  statusKind: "info",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return String(name || "P")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "P";
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : {
      "Content-Type": "application/json",
      ...(path.startsWith("/api/potspark/") ? { "X-Potspark-Request": "1" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Request unavailable");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setStatus(message, kind = "info") {
  state.status = message;
  state.statusKind = kind;
}

function clearStatus() {
  state.status = "";
  state.statusKind = "info";
}

function syncButton() {
  const user = state.session?.authenticated ? state.session.user : null;
  elements.button?.classList.toggle("is-authenticated", !!user);
  if (elements.buttonKicker) elements.buttonKicker.textContent = user ? "Secured" : "Account";
  if (elements.buttonLabel) elements.buttonLabel.textContent = user?.username || "Sign in";
  elements.button?.setAttribute("aria-label", user ? `Manage ${user.username} account` : "Sign in to Potspark");
}

function statusMarkup() {
  return state.status
    ? `<div class="account-status is-${state.statusKind}" role="status">${escapeHtml(state.status)}</div>`
    : "";
}

function socialButtons(mode = "signin") {
  const label = mode === "link" ? "Link" : "Continue with";
  const buttons = [];
  if (state.config?.providers?.google) {
    buttons.push(`<button class="account-social-button" type="button" data-social="google" data-social-mode="${mode}"><span>G</span>${label} Google</button>`);
  }
  if (state.config?.providers?.discord) {
    buttons.push(`<button class="account-social-button" type="button" data-social="discord" data-social-mode="${mode}"><span>◈</span>${label} Discord</button>`);
  }
  return buttons.length ? `<div class="account-social-grid">${buttons.join("")}</div>` : "";
}

function authTabs() {
  return `<nav class="account-tabs" aria-label="Account access">
    <button type="button" data-auth-view="signin" class="${state.view === "signin" ? "is-active" : ""}">Sign in</button>
    <button type="button" data-auth-view="signup" class="${state.view === "signup" ? "is-active" : ""}">Create</button>
    <button type="button" data-auth-view="recover" class="${state.view === "recover" ? "is-active" : ""}">Recover</button>
  </nav>`;
}

function passwordField(id, label, autocomplete, hint = "") {
  return `<label class="account-field" for="${id}">
    <span>${label}</span>
    <div class="account-password-wrap">
      <input id="${id}" name="password" type="password" minlength="15" maxlength="128" autocomplete="${autocomplete}" required />
      <button type="button" data-show-password="${id}" aria-label="Show password">Show</button>
    </div>
    ${hint ? `<small>${hint}</small>` : ""}
  </label>`;
}

function signInMarkup() {
  const socials = socialButtons("signin");
  return `${authTabs()}
    ${state.session?.accountUnavailable
      ? '<div class="account-status is-error">This signed-in account cannot enter matches. <button class="account-inline-action" type="button" data-signout-current>Sign out and continue as guest</button></div>'
      : ""}
    <section class="account-intro"><span>Return to the grid</span><h3>Sign in securely</h3><p>Your browser receives only a protected session cookie. Match admission uses a new one-time ticket for every connection.</p></section>
    ${socials}
    ${socials ? '<div class="account-divider"><span>or use email</span></div>' : ""}
    <form class="account-form" data-auth-form="signin">
      <label class="account-field" for="signinEmail"><span>Email</span><input id="signinEmail" name="email" type="email" maxlength="254" autocomplete="email" inputmode="email" required /></label>
      ${passwordField("signinPassword", "Password", "current-password")}
      <button class="account-primary-button" type="submit">Sign in</button>
    </form>`;
}

function signUpMarkup() {
  const deliveryReady = state.config?.providers?.emailDelivery;
  return `${authTabs()}
    <section class="account-intro"><span>New operator</span><h3>Create your identity</h3><p>Use a unique passphrase. Your email must be verified before password sign-in is enabled.</p></section>
    ${!deliveryReady ? '<div class="account-status is-warning">Email delivery is not configured on this server, so new email accounts are temporarily unavailable.</div>' : ""}
    <form class="account-form" data-auth-form="signup">
      <label class="account-field" for="signupName"><span>Display name</span><input id="signupName" name="name" type="text" minlength="1" maxlength="24" autocomplete="nickname" required /></label>
      <label class="account-field" for="signupEmail"><span>Email</span><input id="signupEmail" name="email" type="email" maxlength="254" autocomplete="email" inputmode="email" required /></label>
      ${passwordField("signupPassword", "Passphrase", "new-password", "15–128 characters. A longer, unique phrase is strongest.")}
      <button class="account-primary-button" type="submit" ${deliveryReady ? "" : "disabled"}>Create and verify</button>
    </form>`;
}

function recoveryMarkup() {
  const deliveryReady = state.config?.providers?.emailDelivery;
  return `${authTabs()}
    <section class="account-intro"><span>Credential recovery</span><h3>Reset your password</h3><p>We’ll respond the same way whether or not the address exists. Reset links are single-use and expire after 30 minutes.</p></section>
    ${!deliveryReady ? '<div class="account-status is-warning">Password-reset email is unavailable until this server configures email delivery.</div>' : ""}
    <form class="account-form" data-auth-form="recover">
      <label class="account-field" for="recoverEmail"><span>Email</span><input id="recoverEmail" name="email" type="email" maxlength="254" autocomplete="email" inputmode="email" required /></label>
      <button class="account-primary-button" type="submit" ${deliveryReady ? "" : "disabled"}>Send reset link</button>
    </form>`;
}

function resetMarkup() {
  return `<section class="account-intro"><span>Single-use reset</span><h3>Choose a new passphrase</h3><p>Completing this reset signs out every existing device and match connection.</p></section>
    <form class="account-form" data-auth-form="reset">
      ${passwordField("resetPassword", "New passphrase", "new-password", "Use 15–128 characters and avoid a password exposed in a data breach.")}
      <button class="account-primary-button" type="submit">Reset password</button>
    </form>`;
}

function providerRow(provider, available) {
  const connected = state.providers.includes(provider);
  const title = provider[0].toUpperCase() + provider.slice(1);
  if (!available) return "";
  const action = !connected && provider === "credential"
    ? '<small class="account-provider-note">Add through password recovery</small>'
    : connected
    ? `<button class="account-text-button" type="button" data-unlink-provider="${provider}" ${state.providers.length <= 1 ? "disabled" : ""}>Unlink</button>`
    : `<button class="account-text-button" type="button" data-social="${provider}" data-social-mode="link">Link</button>`;
  return `<div class="account-provider-row"><div><strong>${title}</strong><span>${connected ? "Connected" : "Not connected"}</span></div>${action}</div>`;
}

function accountMarkup() {
  const user = state.session.user;
  const sessions = state.sessions.length
    ? state.sessions.map((session) => `<article class="account-session ${session.current ? "is-current" : ""}">
        <div><strong>${session.current ? "This device" : escapeHtml(session.userAgent)}</strong><span>Expires ${new Date(session.expiresAt).toLocaleDateString()}</span></div>
        ${session.current ? '<small>Current</small>' : `<button type="button" data-revoke-session="${escapeHtml(session.id)}">Revoke</button>`}
      </article>`).join("")
    : '<p class="account-muted">Loading active devices…</p>';

  return `<section class="account-identity-card">
      <span class="account-avatar">${escapeHtml(initials(user.username))}</span>
      <div><small>Verified operator</small><h3>${escapeHtml(user.username)}</h3><p>${escapeHtml(user.email)}</p></div>
      <span class="account-verified">${user.emailVerified ? "Email verified" : "Verification pending"}</span>
    </section>
    <section class="account-section"><header><div><span>Sign-in methods</span><h3>Linked identities</h3></div><small>Linking always requires an active signed-in session.</small></header>
      <div class="account-provider-list">
        ${providerRow("credential", true)}
        ${providerRow("google", state.config?.providers?.google)}
        ${providerRow("discord", state.config?.providers?.discord)}
      </div>
    </section>
    <section class="account-section"><header><div><span>Session control</span><h3>Active devices</h3></div><small>Sessions expire automatically and can be revoked immediately.</small></header>
      <div class="account-session-list">${sessions}</div>
    </section>
    <div class="account-actions">
      <button class="account-text-button" type="button" data-signout-current>Sign out this device</button>
      <button class="account-danger-button" type="button" data-signout-all>Sign out everywhere</button>
    </div>`;
}

function render() {
  if (!elements.body) return;
  const content = state.view === "reset"
    ? resetMarkup()
    : state.session?.authenticated
      ? accountMarkup()
      : state.view === "signup"
      ? signUpMarkup()
      : state.view === "recover"
        ? recoveryMarkup()
        : signInMarkup();
  elements.body.innerHTML = `${statusMarkup()}${content}`;
  elements.body.toggleAttribute("aria-busy", state.busy);
  for (const control of elements.body.querySelectorAll("button, input")) {
    if (state.busy) control.disabled = true;
  }
}

async function loadAccountDetails() {
  if (!state.session?.authenticated) {
    state.providers = [];
    state.sessions = [];
    state.currentSessionId = null;
    return;
  }
  const [providerData, sessionData] = await Promise.all([
    request("/api/potspark/account/providers"),
    request("/api/potspark/account/sessions"),
  ]);
  state.providers = providerData.providers || [];
  state.sessions = sessionData.sessions || [];
  state.currentSessionId = sessionData.currentSessionId || null;
}

function publishIdentityChanged() {
  window.dispatchEvent(new CustomEvent("potspark:auth-changed", {
    detail: state.session?.authenticated ? { user: state.session.user } : { user: null },
  }));
}

async function refreshSession({ reconnect = false } = {}) {
  state.session = await request("/api/potspark/auth/me");
  if (state.session.accountUnavailable) {
    setStatus("This account is unavailable. Sign out before continuing as a guest.", "error");
  }
  await loadAccountDetails();
  syncButton();
  publishIdentityChanged();
  if (reconnect) refreshNetworkIdentity();
}

async function runBusy(task) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await task();
  } catch (error) {
    setStatus(error.message || "Authentication service unavailable", "error");
  } finally {
    state.busy = false;
    render();
  }
}

async function socialAction(provider, mode) {
  if (mode === "link") {
    const result = await request("/api/potspark/account/link", {
      method: "POST",
      body: { provider },
    });
    if (result.url) location.assign(result.url);
    return;
  }
  const result = await request("/api/auth/sign-in/social", {
    method: "POST",
    body: {
      provider,
      callbackURL: `${location.origin}/?auth=complete`,
      errorCallbackURL: `${location.origin}/?auth=error`,
      disableRedirect: true,
    },
  });
  if (result.url) location.assign(result.url);
}

async function submitAuthForm(form) {
  const kind = form.dataset.authForm;
  const data = new FormData(form);
  if (kind === "signin") {
    await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: data.get("email"), password: data.get("password"), rememberMe: true },
    });
    setStatus("Signed in. Match identity refreshed.", "success");
    await refreshSession({ reconnect: true });
    return;
  }
  if (kind === "signup") {
    await request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        callbackURL: `${location.origin}/?auth=verified`,
      },
    });
    state.view = "signin";
    setStatus("Check your email to verify the account, then sign in.", "success");
    return;
  }
  if (kind === "recover") {
    await request("/api/auth/request-password-reset", {
      method: "POST",
      body: { email: data.get("email"), redirectTo: `${location.origin}/?auth=reset` },
    });
    setStatus("If the address can receive a reset, the link is on its way.", "success");
    return;
  }
  if (kind === "reset") {
    const token = new URLSearchParams(location.search).get("token");
    if (!token) throw new Error("This reset link is invalid or expired");
    await request("/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: data.get("password"), token },
    });
    history.replaceState({}, "", `${location.pathname}${location.hash}`);
    state.view = "signin";
    setStatus("Password reset complete. Every previous session was revoked.", "success");
    await refreshSession({ reconnect: true });
  }
}

async function signOut(path) {
  await request(path, { method: "POST", body: {} });
  state.session = { authenticated: false };
  state.providers = [];
  state.sessions = [];
  syncButton();
  publishIdentityChanged();
  refreshNetworkIdentity();
  state.view = "signin";
  setStatus("Signed out. You can keep playing as a guest.", "success");
}

function openModal() {
  if (!elements.modal) return;
  elements.modal.hidden = false;
  elements.modal.classList.remove("is-closing");
  render();
  queueMicrotask(() => elements.body?.querySelector("input, button")?.focus());
  if (state.config) void runBusy(() => refreshSession());
}

function closeModal() {
  if (!elements.modal || elements.modal.hidden) return;
  elements.modal.classList.add("is-closing");
  window.setTimeout(() => {
    elements.modal.hidden = true;
    elements.modal.classList.remove("is-closing");
    elements.button?.focus();
  }, 140);
}

elements.button?.addEventListener("click", openModal);
elements.close?.addEventListener("click", closeModal);
elements.backdrop?.addEventListener("click", closeModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.modal && !elements.modal.hidden) closeModal();
});

elements.body?.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-auth-view]");
  const showButton = event.target.closest("[data-show-password]");
  const socialButton = event.target.closest("[data-social]");
  const unlinkButton = event.target.closest("[data-unlink-provider]");
  const revokeButton = event.target.closest("[data-revoke-session]");

  if (viewButton) {
    state.view = viewButton.dataset.authView;
    clearStatus();
    render();
  } else if (showButton) {
    const input = document.getElementById(showButton.dataset.showPassword);
    if (input) {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      showButton.textContent = showing ? "Show" : "Hide";
      showButton.setAttribute("aria-label", `${showing ? "Show" : "Hide"} password`);
      input.focus();
    }
  } else if (socialButton) {
    void runBusy(() => socialAction(socialButton.dataset.social, socialButton.dataset.socialMode));
  } else if (unlinkButton) {
    void runBusy(async () => {
      await request("/api/potspark/account/unlink", {
        method: "POST",
        body: { provider: unlinkButton.dataset.unlinkProvider },
      });
      setStatus("Sign-in method unlinked.", "success");
      await loadAccountDetails();
    });
  } else if (revokeButton) {
    void runBusy(async () => {
      await request("/api/potspark/account/revoke-session", {
        method: "POST",
        body: { sessionId: revokeButton.dataset.revokeSession },
      });
      setStatus("Device session revoked.", "success");
      await loadAccountDetails();
    });
  } else if (event.target.closest("[data-signout-current]")) {
    void runBusy(() => signOut("/api/auth/sign-out"));
  } else if (event.target.closest("[data-signout-all]")) {
    void runBusy(() => signOut("/api/potspark/account/sign-out-all"));
  }
});

elements.body?.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-auth-form]");
  if (!form) return;
  event.preventDefault();
  clearStatus();
  void runBusy(() => submitAuthForm(form));
});

async function initialize() {
  const params = new URLSearchParams(location.search);
  const authMode = params.get("auth");
  const accountMode = params.get("account");
  if (authMode === "reset") state.view = "reset";
  if (authMode === "error") setStatus("That identity provider could not complete sign-in.", "error");
  if (authMode === "verified") setStatus("Email verified. You can sign in now.", "success");
  if (authMode === "complete") setStatus("Identity provider sign-in complete.", "success");
  if (accountMode === "linked") setStatus("Sign-in method linked.", "success");
  if (accountMode === "link-error") setStatus("The sign-in method could not be linked.", "error");
  if ((authMode && authMode !== "reset") || accountMode) {
    const cleanURL = new URL(location.href);
    cleanURL.searchParams.delete("auth");
    cleanURL.searchParams.delete("account");
    cleanURL.searchParams.delete("error");
    cleanURL.searchParams.delete("error_description");
    history.replaceState({}, "", `${cleanURL.pathname}${cleanURL.search}${cleanURL.hash}`);
  }
  try {
    [state.config, state.session] = await Promise.all([
      request("/api/potspark/auth/config"),
      request("/api/potspark/auth/me"),
    ]);
    if (state.session.accountUnavailable) {
      setStatus("This account is unavailable. Sign out before continuing as a guest.", "error");
    }
    await loadAccountDetails();
    syncButton();
    publishIdentityChanged();
    if (authMode || accountMode) openModal();
  } catch {
    setStatus("Account service is temporarily unavailable.", "error");
    syncButton();
  }
  render();
}

void initialize();
