// Re-auth prompt for an expired or revoked token.
//
// A 401 used to drop the user onto the bare setup screen, which reads as "the
// app forgot everything". Boards, field mappings, branding and email are all
// still valid — only the token is dead — so ask for exactly that one field.

import { verifyCredentials } from "../api.js";
import { CONFIG, siteHost } from "../config.js";
import {
  defaultExpiry,
  describeGithubTokenStatus,
  describeTokenStatus,
  githubTokenStatus,
  loadCredentials,
  saveCredentials,
  tokenStatus,
} from "../credentials.js";
import { isGithubConfigured } from "../github.js";

const TOKEN_HELP_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

let open = false;

// A burst of parallel requests produces a burst of 401s; callers check this so
// only the first one prompts and the rest stay quiet.
export function isReauthOpen() {
  return open;
}

// Resolves with fresh { email, token } once re-auth succeeds, or null if the
// user dismisses the prompt.
export async function promptReauth({ reason = "" } = {}) {
  if (open) return null;
  open = true;

  const existing = await loadCredentials();
  const status = await tokenStatus();
  const email = existing?.email || "";

  const overlay = document.createElement("div");
  overlay.className = "setup-overlay reauth-overlay";
  overlay.innerHTML = `
    <div class="setup-modal">
      <div class="setup-title">TOKEN EXPIRED</div>
      <div class="setup-subtitle" id="reauth-reason"></div>
      <div class="reauth-meta mono" id="reauth-meta"></div>
      <form id="reauth-form" autocomplete="on">
        <label class="setup-label" for="reauth-token">New API Token</label>
        <div class="setup-token-wrap">
          <input class="setup-input" type="password" id="reauth-token" name="password"
                 autocomplete="current-password" placeholder="Paste a fresh Jira API token" />
          <button type="button" class="setup-token-toggle" id="reauth-toggle">Show</button>
        </div>
        <label class="setup-label" for="reauth-expiry">Expires on</label>
        <input class="setup-input" type="date" id="reauth-expiry" />
        <a href="${TOKEN_HELP_URL}" target="_blank" rel="noopener" class="reauth-help">
          Create a new token</a>
        <button type="submit" class="setup-save" id="reauth-save">Reconnect</button>
        <button type="button" class="reauth-dismiss" id="reauth-dismiss">Not now</button>
      </form>
      <div class="setup-status" id="reauth-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const reasonEl = overlay.querySelector("#reauth-reason");
  const metaEl = overlay.querySelector("#reauth-meta");
  const tokenInput = overlay.querySelector("#reauth-token");
  const expiryInput = overlay.querySelector("#reauth-expiry");
  const toggleBtn = overlay.querySelector("#reauth-toggle");
  const saveBtn = overlay.querySelector("#reauth-save");
  const dismissBtn = overlay.querySelector("#reauth-dismiss");
  const statusEl = overlay.querySelector("#reauth-status");

  reasonEl.textContent =
    reason || "Jira rejected the stored token. Your boards and settings are untouched.";
  metaEl.textContent = [siteHost(), email, describeTokenStatus(status)]
    .filter(Boolean)
    .join(" · ");
  expiryInput.value = defaultExpiry();
  tokenInput.focus();

  toggleBtn.addEventListener("click", () => {
    const hidden = tokenInput.type === "password";
    tokenInput.type = hidden ? "text" : "password";
    toggleBtn.textContent = hidden ? "Hide" : "Show";
  });

  return new Promise((resolve) => {
    function close(result) {
      open = false;
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }

    function onKeydown(e) {
      if (e.key === "Escape") close(null);
    }
    document.addEventListener("keydown", onKeydown);

    dismissBtn.addEventListener("click", () => close(null));

    overlay.querySelector("#reauth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = tokenInput.value.trim();
      if (!token) {
        statusEl.textContent = "Paste a token to continue";
        statusEl.style.color = "var(--accent-danger)";
        return;
      }
      if (!email) {
        statusEl.textContent = "No stored email — use the setup screen instead";
        statusEl.style.color = "var(--accent-danger)";
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Verifying...";
      statusEl.textContent = "";

      try {
        const creds = { email, token };
        const user = await verifyCredentials(creds);
        await saveCredentials({ email, token, tokenExpiresAt: expiryInput.value || undefined });
        statusEl.style.color = "var(--accent-success)";
        statusEl.textContent = `Reconnected as ${user.displayName}`;
        saveBtn.textContent = "Reloading...";
        setTimeout(() => close(creds), 700);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Reconnect";
        statusEl.style.color = "var(--accent-danger)";
        statusEl.textContent = String(err.message).includes("401")
          ? "Still rejected — check the token was copied in full"
          : `Verification failed: ${err.message}`;
      }
    });
  });
}

// Non-blocking heads-up for a token that is close to expiry. Dismissed for the
// rest of the day so it nags once, not every refresh.
export async function renderExpiryBanner() {
  const status = await tokenStatus();
  if (!status.hasToken || (!status.expiringSoon && !status.expired)) return;

  const today = new Date().toISOString().slice(0, 10);
  const { expiryBannerDismissedOn } = await chrome.storage.local.get("expiryBannerDismissedOn");
  if (expiryBannerDismissedOn === today) return;

  document.getElementById("token-expiry-banner")?.remove();

  const banner = document.createElement("div");
  banner.id = "token-expiry-banner";
  banner.className = status.expired ? "expiry-banner expired" : "expiry-banner";

  const text = document.createElement("span");
  text.textContent = status.expired
    ? `${describeTokenStatus(status)} — Jira calls will fail until you paste a new one.`
    : `${describeTokenStatus(status)}. Rotate it before it lapses.`;

  const renew = document.createElement("button");
  renew.className = "expiry-banner-btn";
  renew.textContent = "Update token";
  renew.addEventListener("click", async () => {
    banner.remove();
    const creds = await promptReauth({
      reason: "Paste a fresh token to keep going. Everything else stays as it is.",
    });
    if (creds) location.reload();
  });

  const dismiss = document.createElement("button");
  dismiss.className = "expiry-banner-btn subtle";
  dismiss.textContent = "Dismiss";
  dismiss.title = `Hidden until ${CONFIG.brand.productName} is next opened tomorrow`;
  dismiss.addEventListener("click", async () => {
    await chrome.storage.local.set({ expiryBannerDismissedOn: today });
    banner.remove();
  });

  banner.append(text, renew, dismiss);
  document.body.appendChild(banner);
}

// The same heads-up for the GitHub token, deliberately kept as its own banner
// rather than folded into the one above. A dead GitHub token costs you one
// optional panel in standup; presenting that as an app-wide auth failure would
// be a lie, and the wording has to make the difference obvious. There is no
// inline re-auth here either — a GitHub token is created against an org and a
// repo list, which is a Settings-shaped job, not a one-field prompt.
export async function renderGithubExpiryBanner() {
  if (!isGithubConfigured()) return;
  const status = await githubTokenStatus();
  if (!status.hasToken || (!status.expiringSoon && !status.expired)) return;

  const today = new Date().toISOString().slice(0, 10);
  const { githubBannerDismissedOn } = await chrome.storage.local.get("githubBannerDismissedOn");
  if (githubBannerDismissedOn === today) return;

  document.getElementById("github-expiry-banner")?.remove();

  const banner = document.createElement("div");
  banner.id = "github-expiry-banner";
  banner.className = status.expired ? "expiry-banner expired" : "expiry-banner";

  const text = document.createElement("span");
  text.textContent = status.expired
    ? `${describeGithubTokenStatus(status)} — standup loses its pull-request panel. Everything else is unaffected.`
    : `${describeGithubTokenStatus(status)}. Rotate it before standup starts missing pull requests.`;

  const open = document.createElement("button");
  open.className = "expiry-banner-btn";
  open.textContent = "Open Settings";
  open.addEventListener("click", () => {
    window.open(chrome.runtime.getURL("settings.html"));
  });

  const dismiss = document.createElement("button");
  dismiss.className = "expiry-banner-btn subtle";
  dismiss.textContent = "Dismiss";
  dismiss.title = `Hidden until ${CONFIG.brand.productName} is next opened tomorrow`;
  dismiss.addEventListener("click", async () => {
    await chrome.storage.local.set({ githubBannerDismissedOn: today });
    banner.remove();
  });

  banner.append(text, open, dismiss);
  document.body.appendChild(banner);
}
