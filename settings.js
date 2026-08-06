import {
  CONFIG,
  DEFAULT_STATUS_GROUPS,
  FIELD_ROLES,
  boardPaletteColor,
  loadConfig,
  normalizeBaseUrl,
  saveConfig,
} from "./js/config.js";
import { discoverFieldMappings, listBoards } from "./js/api.js";
import {
  clearToken,
  defaultExpiry,
  describeTokenStatus,
  loadCredentials,
  saveCredentials,
  saveTokenExpiry,
  tokenStatus,
} from "./js/credentials.js";
import {
  buildExport,
  downloadJson,
  exportFilename,
  parseImport,
} from "./js/portable.js";
import { allMembers, loadTeam, saveMembers } from "./js/team.js";
import { MONITOR_CHECKS, isCheckEnabled } from "./js/monitor.js";
import { initRoster } from "./js/roster-ui.js";

const el = (id) => document.getElementById(id);

const baseUrlInput = el("baseUrl");
const emailInput = el("email");
const tokenInput = el("token");
const toggleBtn = el("toggleToken");
const saveBtn = el("saveBtn");
const status = el("status");
const boardList = el("boardList");
const addBoardBtn = el("addBoardBtn");
const importBoardsBtn = el("importBoardsBtn");
const statusGroupList = el("statusGroupList");
const addGroupBtn = el("addGroupBtn");
const fieldRoleList = el("fieldRoleList");
const monitorCheckList = el("monitorCheckList");
const discoverFieldsBtn = el("discoverFieldsBtn");
const additionalFieldsInput = el("additionalFields");
const localFieldsNote = el("localFieldsNote");
const orgNameInput = el("orgName");
const orgLogoInput = el("orgLogo");
const themeToggle = el("themeToggle");
const tokenExpiryInput = el("tokenExpiry");
const tokenStatusNote = el("tokenStatusNote");
const forgetTokenBtn = el("forgetTokenBtn");
const includeTokenBox = el("includeToken");
const includeRosterBox = el("includeRoster");
const exportBtn = el("exportBtn");
const importBtn = el("importBtn");
const importFile = el("importFile");

let boards = [];
let statusGroups = [];
let fields = {};
let currentTheme = "dark";
let roster = null;   // roster editor, created once on first init
let monitorChecks = {};

chrome.storage.sync.get("theme", (result) => {
  currentTheme = result.theme || "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
});

themeToggle.addEventListener("click", () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  chrome.storage.sync.set({ theme: currentTheme });
});

toggleBtn.addEventListener("click", () => {
  const isPassword = tokenInput.type === "password";
  tokenInput.type = isPassword ? "text" : "password";
  toggleBtn.textContent = isPassword ? "Hide" : "Show";
});

function flash(message, kind = "success") {
  const colors = {
    success: "var(--accent-success)",
    warning: "var(--accent-warning)",
    error: "var(--accent-danger)",
  };
  status.textContent = message;
  status.style.color = colors[kind] || colors.success;
  status.classList.add("visible");
  setTimeout(() => status.classList.remove("visible"), 2600);
}

function credsFromForm() {
  const email = emailInput.value.trim();
  const token = tokenInput.value.trim();
  return email && token ? { email, token } : null;
}

function renderBoards() {
  boardList.innerHTML = "";
  if (!boards.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No boards yet — import them from Jira or add one manually.";
    boardList.appendChild(empty);
  }
  boards.forEach((board, i) => {
    const row = document.createElement("div");
    row.className = "board-row";

    const idInput = document.createElement("input");
    idInput.type = "number";
    idInput.value = board.id;
    idInput.placeholder = "ID";
    idInput.title = "Jira board ID";
    idInput.addEventListener("input", () => { boards[i].id = parseInt(idInput.value) || 0; });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = board.name || "";
    nameInput.placeholder = "Label";
    nameInput.addEventListener("input", () => { boards[i].name = nameInput.value; });

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.value = board.projectKey || "";
    keyInput.placeholder = "KEY";
    keyInput.title = "Project key — used to group epics by board";
    keyInput.style.flex = "0 0 72px";
    keyInput.addEventListener("input", () => { boards[i].projectKey = keyInput.value.trim().toUpperCase(); });

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = board.color || boardPaletteColor(i);
    colorInput.addEventListener("input", () => { boards[i].color = colorInput.value; });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-board";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      boards.splice(i, 1);
      renderBoards();
    });

    row.append(idInput, nameInput, keyInput, colorInput, removeBtn);
    boardList.appendChild(row);
  });
}

function renderStatusGroups() {
  statusGroupList.innerHTML = "";
  statusGroups.forEach((group, i) => {
    const row = document.createElement("div");
    row.className = "board-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = group.name;
    nameInput.placeholder = "Column name";
    nameInput.style.flex = "0 0 120px";
    nameInput.addEventListener("input", () => { statusGroups[i].name = nameInput.value; });

    const statusInput = document.createElement("input");
    statusInput.type = "text";
    statusInput.value = group.statuses.join(", ");
    statusInput.placeholder = "Status 1, Status 2, ...";
    statusInput.addEventListener("input", () => {
      statusGroups[i].statuses = statusInput.value.split(",").map((s) => s.trim()).filter(Boolean);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-board";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      statusGroups.splice(i, 1);
      renderStatusGroups();
    });

    row.append(nameInput, statusInput, removeBtn);
    statusGroupList.appendChild(row);
  });
}

function renderFieldRoles() {
  fieldRoleList.innerHTML = "";
  for (const [role, spec] of Object.entries(FIELD_ROLES)) {
    const row = document.createElement("div");
    row.className = "board-row field-role-row";

    const label = document.createElement("span");
    label.className = "role-label";
    label.textContent = spec.label;
    if (!fields[role]?.length) label.classList.add("role-unresolved");

    const idsInput = document.createElement("input");
    idsInput.type = "text";
    idsInput.value = (fields[role] || []).join(", ");
    idsInput.placeholder = "unresolved — run discover";
    idsInput.title = `Field IDs tried in order. Matched by name: ${spec.names.join(", ")}`;
    idsInput.addEventListener("input", () => {
      fields[role] = idsInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      label.classList.toggle("role-unresolved", !fields[role].length);
    });

    row.append(label, idsInput);
    fieldRoleList.appendChild(row);
  }
}

function renderMonitorChecks() {
  monitorCheckList.innerHTML = "";
  for (const check of MONITOR_CHECKS) {
    const row = document.createElement("label");
    row.className = "board-row checkbox-row";
    row.style.cursor = "pointer";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = isCheckEnabled(monitorChecks, check.id);
    box.addEventListener("change", () => {
      // Store only the muted ones, so checks added later default to on.
      if (box.checked) delete monitorChecks[check.id];
      else monitorChecks[check.id] = false;
    });

    const label = document.createElement("span");
    label.textContent = `${check.label} — ${check.question}`;

    row.append(box, label);
    monitorCheckList.appendChild(row);
  }
}

function renderLocalFieldsNote() {
  const stored = new Set(
    additionalFieldsInput.value.split(",").map((s) => s.trim()).filter(Boolean)
  );
  const fromLocal = (CONFIG.additionalFields || []).filter((f) => !stored.has(f));
  localFieldsNote.textContent = fromLocal.length
    ? `From config.local.json: ${fromLocal.join(", ")}`
    : "";
}

addBoardBtn.addEventListener("click", () => {
  boards.push({ id: 0, name: "", projectKey: "", color: boardPaletteColor(boards.length) });
  renderBoards();
});

addGroupBtn.addEventListener("click", () => {
  statusGroups.push({ name: "", statuses: [] });
  renderStatusGroups();
});

// Both Jira-backed actions need a site URL and credentials, and neither is
// necessarily saved yet — so read them straight from the form.
async function withLiveConfig(action, label) {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  const creds = credsFromForm();
  if (!baseUrl) return flash("Set the Jira site URL first", "warning");
  if (!creds) return flash("Email and API token required", "warning");

  const granted = await ensureHostPermission(baseUrl);
  if (!granted) return flash(`Access to ${baseUrl} was not granted`, "error");

  await saveConfig({ site: { baseUrl } });
  baseUrlInput.value = CONFIG.site.baseUrl;

  try {
    await action(creds);
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes("401")) flash("401 — check email and API token", "error");
    else flash(`${label} failed: ${msg}`, "error");
  }
}

importBoardsBtn.addEventListener("click", () =>
  withLiveConfig(async (creds) => {
    importBoardsBtn.disabled = true;
    importBoardsBtn.textContent = "Loading...";
    try {
      const available = await listBoards(creds);
      const existing = new Set(boards.map((b) => b.id));
      const added = available
        .filter((b) => !existing.has(b.id))
        .map((b, i) => ({
          id: b.id,
          name: b.projectKey || b.name,
          projectKey: b.projectKey,
          color: boardPaletteColor(boards.length + i),
        }));
      boards.push(...added);
      renderBoards();
      flash(
        added.length
          ? `Imported ${added.length} board${added.length === 1 ? "" : "s"} — review and save`
          : "No new boards found",
        added.length ? "success" : "warning"
      );
    } finally {
      importBoardsBtn.disabled = false;
      importBoardsBtn.textContent = "↓ Import from Jira";
    }
  }, "Board import")
);

discoverFieldsBtn.addEventListener("click", () =>
  withLiveConfig(async (creds) => {
    discoverFieldsBtn.disabled = true;
    discoverFieldsBtn.textContent = "Discovering...";
    try {
      const discovered = await discoverFieldMappings(creds);
      fields = discovered;
      renderFieldRoles();
      const unresolved = Object.entries(FIELD_ROLES)
        .filter(([role]) => !discovered[role]?.length)
        .map(([, spec]) => spec.label);
      flash(
        unresolved.length
          ? `Resolved, except: ${unresolved.join(", ")} — set manually`
          : "All fields resolved — save to apply",
        unresolved.length ? "warning" : "success"
      );
    } finally {
      discoverFieldsBtn.disabled = false;
      discoverFieldsBtn.textContent = "⟳ Discover from Jira";
    }
  }, "Field discovery")
);

additionalFieldsInput.addEventListener("input", renderLocalFieldsNote);

async function renderTokenStatus() {
  const status = await tokenStatus();
  tokenStatusNote.textContent = describeTokenStatus(status);
  tokenStatusNote.classList.toggle("token-status-expired", status.expired);
  tokenStatusNote.classList.toggle("token-status-soon", status.expiringSoon);
}

tokenExpiryInput.addEventListener("change", async () => {
  await saveTokenExpiry(tokenExpiryInput.value || null);
  await renderTokenStatus();
});

// Leaves the site, boards and field mapping in place — only the credential goes.
forgetTokenBtn.addEventListener("click", async () => {
  if (!confirm("Remove the stored API token from this device?\n\nBoards, field mapping and branding are kept. You will be asked for a token next time the app loads.")) {
    return;
  }
  await clearToken();
  tokenInput.value = "";
  tokenExpiryInput.value = "";
  await renderTokenStatus();
  flash("Token removed from this device", "warning");
  await notifyApp();
});

exportBtn.addEventListener("click", async () => {
  const includeToken = includeTokenBox.checked;
  const includeRoster = includeRosterBox.checked;
  if (includeToken) {
    const proceed = confirm(
      "The exported file will contain your API token in plaintext.\n\n" +
        "Anyone who opens the file can act as you in Jira. Continue?"
    );
    if (!proceed) return;
  }
  if (includeRoster) {
    const proceed = confirm(
      "The exported file will contain your team roster: colleagues' names, " +
        "emails and Jira account IDs.\n\nContinue?"
    );
    if (!proceed) return;
  }
  const credentials = await loadCredentials();
  const payload = buildExport({
    credentials,
    includeToken,
    includeRoster,
    members: roster ? roster.getMembers() : allMembers(),
  });
  downloadJson(exportFilename(), payload);
  const caveats = [includeToken && "a live token", includeRoster && "personal data"].filter(Boolean);
  flash(
    caveats.length ? `Exported — file contains ${caveats.join(" and ")}, store it carefully` : "Exported",
    caveats.length ? "warning" : "success"
  );
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  importFile.value = "";

  let text;
  try {
    text = await file.text();
  } catch (err) {
    return flash(`Could not read file: ${err.message}`, "error");
  }

  const result = parseImport(text);
  if (!result.ok) return flash(`Import failed: ${result.error}`, "error");

  const summary = [
    result.config.site?.baseUrl && `site ${result.config.site.baseUrl}`,
    result.config.boards && `${result.config.boards.length} boards`,
    result.config.statusGroups && `${result.config.statusGroups.length} status groups`,
    result.members && `${result.members.length} roster members`,
    result.account?.email && `account ${result.account.email}`,
    result.account?.token && "an API token",
  ].filter(Boolean);

  if (!confirm(`Import will replace:\n\n${summary.join("\n")}\n\nContinue?`)) return;

  await saveConfig(result.config);
  if (result.members) await saveMembers(result.members);
  if (result.account?.email && result.account?.token) {
    await saveCredentials({
      email: result.account.email,
      token: result.account.token,
      tokenExpiresAt: result.account.tokenExpiresAt || defaultExpiry(),
    });
  }

  await init();
  const notes = result.warnings.length ? ` (${result.warnings.join(" ")})` : "";
  flash(`Imported${notes}`, result.warnings.length ? "warning" : "success");
  await notifyApp();
});

async function notifyApp() {
  const appUrl = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url: appUrl });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "credentials-updated" });
  }
}

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

saveBtn.addEventListener("click", async () => {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  const email = emailInput.value.trim();
  const token = tokenInput.value.trim();

  if (!baseUrl) return flash("Jira site URL required", "warning");
  if (!email || !token) return flash("Email and token required", "warning");

  const granted = await ensureHostPermission(baseUrl);
  if (!granted) return flash(`Access to ${baseUrl} was not granted`, "error");

  const validBoards = boards.filter((b) => b.id > 0 && (b.name || "").trim());
  const validGroups = statusGroups.filter((g) => g.name.trim() && g.statuses.length);
  const extraFields = additionalFieldsInput.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await saveConfig({
    site: { baseUrl },
    brand: {
      orgName: orgNameInput.value.trim(),
      orgLogo: orgLogoInput.value.trim(),
    },
    boards: validBoards,
    statusGroups: validGroups,
    fields,
    additionalFields: extraFields,
    monitorChecks,
  });
  await saveCredentials({
    email,
    token,
    tokenExpiresAt: tokenExpiryInput.value || defaultExpiry(),
  });

  if (roster) await saveMembers(roster.getMembers());

  baseUrlInput.value = CONFIG.site.baseUrl;
  boards = validBoards;
  renderBoards();
  renderLocalFieldsNote();
  await renderTokenStatus();
  flash("Saved");

  await notifyApp();
});

async function init() {
  await loadConfig();
  await loadTeam();

  el("productName").textContent = CONFIG.brand.productName;
  el("productTagline").textContent = CONFIG.brand.tagline;
  document.title = `${CONFIG.brand.productName} — Settings`;

  baseUrlInput.value = CONFIG.site.baseUrl || "";
  orgNameInput.value = CONFIG.brand.orgName || "";
  orgLogoInput.value = CONFIG.brand.orgLogo || "";
  boards = (CONFIG.boards || []).map((b) => ({ ...b }));
  statusGroups = (CONFIG.statusGroups?.length ? CONFIG.statusGroups : DEFAULT_STATUS_GROUPS)
    .map((g) => ({ ...g, statuses: [...g.statuses] }));
  fields = Object.fromEntries(
    Object.keys(FIELD_ROLES).map((role) => [role, [...(CONFIG.fields?.[role] || [])]])
  );
  additionalFieldsInput.value = (CONFIG.additionalFields || []).join(", ");
  monitorChecks = { ...(CONFIG.monitorChecks || {}) };

  const stored = await loadCredentials();
  if (stored?.email) emailInput.value = stored.email;
  if (stored?.token) tokenInput.value = stored.token;
  tokenExpiryInput.value = stored?.tokenExpiresAt?.slice(0, 10) || "";

  if (!roster) roster = initRoster({ flash, requireLiveJira: withLiveConfig });
  roster.setMembers(allMembers());

  renderBoards();
  renderStatusGroups();
  renderFieldRoles();
  renderMonitorChecks();
  renderLocalFieldsNote();
  await renderTokenStatus();
}

init();
