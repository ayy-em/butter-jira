import {
  discoverFieldMappings,
  listBoards,
  verifyCredentials,
} from "./api.js";
import { getCredentials, saveCredentials, defaultExpiry } from "./credentials.js";
import {
  isReauthOpen,
  promptReauth,
  renderExpiryBanner,
  renderGithubExpiryBanner,
} from "./components/reauth.js";
import { cache, loadBoards, loadTheme, saveBoards, showToast } from "./utils.js";
import { loadTeam, loadTeamOnly } from "./team.js";
import {
  CONFIG,
  boardPaletteColor,
  hasBoards,
  isConfigured,
  normalizeBaseUrl,
  saveConfig,
  siteHost,
} from "./config.js";
import { renderNav, updateActiveTab, setLastSync } from "./components/nav.js";
import {
  closePalette,
  invalidatePaletteIndex,
  isPaletteOpen,
  openPalette,
} from "./components/palette.js";

const TOKEN_HELP_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

async function init() {
  await loadBoards();
  await loadTheme();
  // Roster and its filter preference must be in place before any view renders,
  // since display names and the Team Only toggle both read from them.
  await Promise.all([loadTeam(), loadTeamOnly()]);
  document.title = CONFIG.brand.productName;
  const creds = await getCredentials();

  renderNav(async () => {
    await cache.clear();
    invalidatePaletteIndex();
    setLastSync(new Date());
    mountView(await getCredentials());
  });

  // A 401 means the token died, not that the config is gone. Ask for the one
  // field that changed and resume where we were.
  document.addEventListener("jira-auth-error", async () => {
    if (isReauthOpen()) return; // parallel requests, one prompt
    const refreshed = await promptReauth();
    if (!refreshed) {
      showToast("Jira rejected the stored token — views will not load until it is replaced.", true);
      return;
    }
    await cache.clear();
    invalidatePaletteIndex();
    mountView(refreshed);
  });

  // The nav's ⌘K button routes through here so the palette has exactly one
  // owner of credentials and open/close state.
  document.addEventListener("palette-open", async () => {
    if (isPaletteOpen()) closePalette();
    // The re-auth prompt sits below the palette in the stack, so don't bury it.
    else if (isConfigured() && !isReauthOpen()) openPalette(await getCredentials());
  });

  chrome.runtime.onMessage?.addListener((msg) => {
    if (msg.type === "credentials-updated") {
      init();
    }
  });

  document.addEventListener("keydown", async (e) => {
    // Cmd/Ctrl+K is checked before the input guard and before standup's claim on
    // the keyboard: it must work from anywhere, including out of a text field.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (isPaletteOpen()) closePalette();
      else if (isConfigured() && !isReauthOpen()) openPalette(await getCredentials());
      return;
    }

    if (isPaletteOpen()) return; // the palette owns its own keys while open

    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable
    )
      return;
    // Standup mode owns the keyboard while it is running: Space, arrows and Esc
    // are its controls, and navigating away mid-standup would lose the session.
    if (document.body.dataset.standupActive === "1") return;
    if (e.key === "r" || e.key === "R") location.hash = "#gantt";
    if (e.key === "b" || e.key === "B") location.hash = "#backlog";
    if (e.key === "k" || e.key === "K") location.hash = "#kanban";
    if (e.key === "m" || e.key === "M") location.hash = "#monitor";
    if (e.key === "s" || e.key === "S") location.hash = "#standup";
    if (e.key === "d" || e.key === "D") location.hash = "#dashboard";
  });

  if (!creds || !isConfigured()) {
    showSetup();
    return;
  }

  if (!hasBoards()) {
    showBoardPicker(creds);
    return;
  }

  renderExpiryBanner();
  // Separate banner, separate failure mode: GitHub lapsing costs one optional
  // panel, not the app.
  renderGithubExpiryBanner();
  mountView(creds);
}

async function mountView(creds) {
  if (!creds || !isConfigured()) {
    showSetup();
    return;
  }
  if (!hasBoards()) {
    showBoardPicker(creds);
    return;
  }

  const container = document.getElementById("view-container");
  const hash = location.hash || "#backlog";
  updateActiveTab();

  container.innerHTML = '<div class="spinner-logo"><img src="assets/logo.png" alt="Loading"></div>';

  try {
    let viewModule;
    switch (hash) {
      case "#backlog":
        viewModule = await import("./views/backlog.js");
        break;
      case "#kanban":
        viewModule = await import("./views/kanban.js");
        break;
      case "#gantt":
        viewModule = await import("./views/gantt.js");
        break;
      case "#monitor":
        viewModule = await import("./views/monitor.js");
        break;
      case "#standup":
        viewModule = await import("./views/standup.js");
        break;
      case "#dashboard":
        viewModule = await import("./views/dashboard.js");
        break;
      default:
        viewModule = await import("./views/backlog.js");
        break;
    }
    await viewModule.mount(container, creds);
    setLastSync(new Date());
  } catch (err) {
    console.error("View mount error:", err);
    if (err.message?.includes("401")) return;
    showToast(`Failed to load view: ${err.message}`, true);
  }
}

// The manifest grants *.atlassian.net up front; anything else (Jira Data
// Center on a custom domain) is requested at setup time as an optional origin.
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

function showSetup() {
  const container = document.getElementById("view-container");
  const brand = CONFIG.brand;
  container.innerHTML = `
    <div class="setup-overlay">
      <div class="setup-modal">
        <div style="text-align:center;margin-bottom:8px;">
          <img src="assets/logo.png" alt="" style="width:56px;height:56px;">
        </div>
        <div class="setup-title">${escapeHtml(brand.productName.toUpperCase())}</div>
        <div class="setup-subtitle">${escapeHtml(brand.tagline)}</div>
        <form id="setup-form" autocomplete="on">
        <label class="setup-label" for="setup-site">Jira Site URL</label>
        <input class="setup-input" type="text" id="setup-site" name="url"
               placeholder="your-org.atlassian.net" />
        <label class="setup-label" for="setup-email">Email</label>
        <input class="setup-input" type="email" id="setup-email" name="email" autocomplete="email" placeholder="you@example.com" />
        <label class="setup-label" for="setup-token">API Token</label>
        <div class="setup-token-wrap">
          <input class="setup-input" type="password" id="setup-token" name="password" autocomplete="current-password" placeholder="Paste Jira API token" />
          <button type="button" class="setup-token-toggle" id="setup-toggle">Show</button>
        </div>
        <a href="${TOKEN_HELP_URL}" target="_blank" rel="noopener"
           style="display:block;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--accent-primary);margin-bottom:14px;text-decoration:none;">
          Need an API token? Create one here</a>
        <button type="submit" class="setup-save" id="setup-save">Connect</button>
        </form>
        <div class="setup-status" id="setup-status"></div>
      </div>
    </div>
  `;

  const siteInput = document.getElementById("setup-site");
  const emailInput = document.getElementById("setup-email");
  const tokenInput = document.getElementById("setup-token");
  const toggleBtn = document.getElementById("setup-toggle");
  const saveBtn = document.getElementById("setup-save");
  const status = document.getElementById("setup-status");

  siteInput.value = CONFIG.site.baseUrl || "";
  getCredentials().then((stored) => {
    if (stored?.email) emailInput.value = stored.email;
    if (stored?.token) tokenInput.value = stored.token;
  });

  toggleBtn.addEventListener("click", () => {
    const hidden = tokenInput.type === "password";
    tokenInput.type = hidden ? "text" : "password";
    toggleBtn.textContent = hidden ? "Hide" : "Show";
  });

  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const baseUrl = normalizeBaseUrl(siteInput.value);
    const email = emailInput.value.trim();
    const token = tokenInput.value.trim();

    if (!baseUrl) {
      setStatus(status, "Enter a Jira site URL, e.g. your-org.atlassian.net", "error");
      return;
    }
    if (!email || !token) {
      setStatus(status, "Email and API token are required", "error");
      return;
    }

    // Request the origin first: Chrome only honours permission prompts while
    // the click gesture is still live.
    const granted = await ensureHostPermission(baseUrl);
    if (!granted) {
      setStatus(status, `Access to ${baseUrl} was not granted`, "error");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Connecting...";
    setStatus(status, "", "info");

    try {
      await saveConfig({ site: { baseUrl } });
      const creds = { email, token };
      const user = await verifyCredentials(creds);

      // Device-local, with a default expiry reminder Settings can correct.
      await saveCredentials({ email, token, tokenExpiresAt: defaultExpiry() });

      saveBtn.textContent = "Reading field layout...";
      try {
        const fields = await discoverFieldMappings(creds);
        await saveConfig({ fields });
      } catch (err) {
        // Non-fatal: Settings has manual overrides for every field role.
        console.warn("Field discovery failed:", err);
      }

      setStatus(status, `Connected as ${user.displayName}`, "success");
      saveBtn.textContent = "Loading boards...";

      setTimeout(() => {
        if (hasBoards()) mountView(creds);
        else showBoardPicker(creds);
      }, 900);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Connect";
      if (String(err.message).includes("401")) {
        setStatus(status, "Invalid credentials — check email and token", "error");
      } else if (String(err.message).includes("404")) {
        setStatus(status, "Site reachable but Jira API not found — check the URL", "error");
      } else {
        setStatus(status, "Connection failed — check the site URL and your network", "warning");
      }
    }
  });
}

// First run has no boards configured, and nobody knows their numeric board IDs,
// so offer everything the account can see.
async function showBoardPicker(creds) {
  const container = document.getElementById("view-container");
  container.innerHTML = `
    <div class="setup-overlay">
      <div class="setup-modal" style="width:520px;max-width:92vw;">
        <div class="setup-title">SELECT BOARDS</div>
        <div class="setup-subtitle">${escapeHtml(siteHost())}</div>
        <input class="setup-input" type="search" id="board-search" placeholder="Filter boards..." />
        <div id="board-options" style="max-height:46vh;overflow-y:auto;margin:10px 0;border:1px solid var(--border);border-radius:4px;">
          <div class="spinner" style="margin:24px auto;"></div>
        </div>
        <button class="setup-save" id="board-save" disabled>Save boards</button>
        <div class="setup-status" id="board-status"></div>
      </div>
    </div>
  `;

  const optionsEl = document.getElementById("board-options");
  const searchEl = document.getElementById("board-search");
  const saveBtn = document.getElementById("board-save");
  const status = document.getElementById("board-status");
  const selected = new Map();

  let boards;
  try {
    boards = await listBoards(creds);
  } catch (err) {
    optionsEl.innerHTML = "";
    setStatus(status, `Could not list boards: ${err.message}`, "error");
    return;
  }

  if (!boards.length) {
    optionsEl.innerHTML =
      '<div style="padding:16px;color:var(--muted);font-size:13px;">No boards visible to this account. Add them manually in Settings.</div>';
    return;
  }

  function refreshSaveBtn() {
    saveBtn.disabled = selected.size === 0;
    saveBtn.textContent = selected.size
      ? `Save ${selected.size} board${selected.size === 1 ? "" : "s"}`
      : "Save boards";
  }

  function render(filter = "") {
    const needle = filter.trim().toLowerCase();
    const visible = boards.filter(
      (b) =>
        !needle ||
        b.name.toLowerCase().includes(needle) ||
        b.projectKey.toLowerCase().includes(needle)
    );
    optionsEl.innerHTML = "";
    if (!visible.length) {
      optionsEl.innerHTML =
        '<div style="padding:12px;color:var(--muted);font-size:12px;">No matches</div>';
      return;
    }
    for (const board of visible) {
      const row = document.createElement("label");
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(board.id);
      box.addEventListener("change", () => {
        if (box.checked) selected.set(board.id, board);
        else selected.delete(board.id);
        refreshSaveBtn();
      });
      const label = document.createElement("span");
      label.style.flex = "1";
      label.textContent = board.name;
      const meta = document.createElement("span");
      meta.className = "mono";
      meta.style.cssText = "color:var(--muted);font-size:11px;";
      meta.textContent = [board.projectKey, board.type, `#${board.id}`]
        .filter(Boolean)
        .join(" · ");
      row.append(box, label, meta);
      optionsEl.appendChild(row);
    }
  }

  searchEl.addEventListener("input", () => render(searchEl.value));
  render();

  saveBtn.addEventListener("click", async () => {
    const chosen = [...selected.values()].map((board, i) => ({
      id: board.id,
      name: board.projectKey || board.name,
      projectKey: board.projectKey,
      color: boardPaletteColor(i),
    }));
    await saveBoards(chosen);
    await cache.clear();
    invalidatePaletteIndex();
    mountView(creds);
  });
}

const STATUS_COLORS = {
  error: "var(--accent-danger)",
  warning: "var(--accent-warning)",
  success: "var(--accent-success)",
  info: "var(--muted)",
};

function setStatus(el, message, kind = "info") {
  el.textContent = message;
  el.style.color = STATUS_COLORS[kind] || STATUS_COLORS.info;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

window.addEventListener("hashchange", async () => {
  const creds = await getCredentials();
  mountView(creds);
});

init();
