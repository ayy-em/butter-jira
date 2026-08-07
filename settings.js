import {
  createTab,
  queryTabs,
  requestOrigin,
  runtimeUrl,
  sendTabMessage,
  syncGet,
  syncSet,
  updateTab,
  focusWindow,
} from "./js/browser.js";
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
  clearGithubToken,
  clearToken,
  defaultExpiry,
  describeGithubTokenStatus,
  describeTokenStatus,
  getGithubToken,
  githubTokenStatus,
  loadCredentials,
  saveCredentials,
  saveGithubToken,
  saveTokenExpiry,
  tokenStatus,
} from "./js/credentials.js";
import {
  checkRepoAccess,
  githubOrigin,
  listOrgMembers,
  normalizeGithubHost,
  normalizeGithubOrg,
  parseRepoList,
  proposeGithubMatches,
  repoSlug,
  verifyGithubToken,
} from "./js/github.js";
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
const brandLink = el("brandLink");
const githubEnabledBox = el("githubEnabled");
const githubHostInput = el("githubHost");
const githubOrgInput = el("githubOrg");
const githubReposInput = el("githubRepos");
const githubRepoNote = el("githubRepoNote");
const githubTokenInput = el("githubToken");
const toggleGithubTokenBtn = el("toggleGithubToken");
const githubTokenNote = el("githubTokenNote");
const githubTestBtn = el("githubTestBtn");
const githubTestResults = el("githubTestResults");
const forgetGithubTokenBtn = el("forgetGithubTokenBtn");
const matchGithubBtn = el("matchGithubBtn");
const includeTokenBox = el("includeToken");
const includeGithubTokenBox = el("includeGithubToken");
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

syncGet("theme").then((result) => {
  currentTheme = result.theme || "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
});

themeToggle.addEventListener("click", () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  syncSet({ theme: currentTheme });
});

toggleBtn.addEventListener("click", () => {
  const isPassword = tokenInput.type === "password";
  tokenInput.type = isPassword ? "text" : "password";
  toggleBtn.textContent = isPassword ? "Hide" : "Show";
});

// The logo goes back to the board. Settings is usually opened in its own tab
// from an app tab that is still sitting there, so an already-open app is
// focused and pointed at Kanban rather than being opened a second time —
// which also leaves any unsaved edits on this page where they are.
//
// The href is real, so ⌘/Ctrl-click and "open in new tab" work natively; only
// an unmodified left-click is intercepted. Same shape as the issue links.
brandLink.addEventListener("click", async (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const appUrl = runtimeUrl("app.html");
  try {
    const [existing] = await queryTabs({ url: appUrl });
    if (existing) {
      // The hash change is what moves the app to Kanban: same document, so the
      // router's hashchange handler mounts the view without a reload.
      await updateTab(existing.id, { active: true, url: `${appUrl}#kanban` });
      await focusWindow(existing.windowId);
      return;
    }
    await createTab({ url: `${appUrl}#kanban` });
  } catch {
    // No tabs access for some reason — plain navigation still gets there.
    location.href = `${appUrl}#kanban`;
  }
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
  const includeGithubToken = includeGithubTokenBox.checked;
  const includeRoster = includeRosterBox.checked;

  // One confirm per sensitive thing, each naming what it actually exposes.
  // A single "this file has secrets in it" prompt teaches people to click past
  // it without reading which secret they just agreed to.
  if (includeToken) {
    const proceed = confirm(
      "The exported file will contain your Jira API token in plaintext.\n\n" +
        "Anyone who opens the file can act as you in Jira. Continue?"
    );
    if (!proceed) return;
  }
  if (includeGithubToken) {
    const proceed = confirm(
      "The exported file will contain your GitHub token in plaintext.\n\n" +
        "A fine-grained token can read every repository it was scoped to — not " +
        "just the ones listed here. Continue?"
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
    includeGithubToken,
    githubToken: includeGithubToken ? await getGithubToken() : null,
    members: roster ? roster.getMembers() : allMembers(),
  });
  downloadJson(exportFilename(), payload);

  const tokenCount = [includeToken, includeGithubToken].filter(Boolean).length;
  const caveats = [
    tokenCount === 2 ? "two live tokens" : tokenCount === 1 ? "a live token" : null,
    includeRoster && "personal data",
  ].filter(Boolean);
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
    result.account?.token && "a Jira API token",
    result.githubAccount?.token && "a GitHub token",
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
  // No expiry carried across: GitHub reports the real one on the first
  // authenticated call, so an imported token starts as "unknown" and corrects
  // itself rather than inheriting a stale date from the exporting machine.
  if (result.githubAccount?.token) {
    await saveGithubToken(result.githubAccount.token);
  }

  await init();
  const notes = result.warnings.length ? ` (${result.warnings.join(" ")})` : "";
  flash(`Imported${notes}`, result.warnings.length ? "warning" : "success");
  await notifyApp();
});

async function notifyApp() {
  const appUrl = runtimeUrl("app.html");
  for (const tab of await queryTabs({ url: appUrl })) {
    sendTabMessage(tab.id, { type: "credentials-updated" });
  }
}

async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  return ensureOrigin(origin);
}

// Chrome only honours a permission prompt while the click gesture is live, so
// every caller of this runs from a button handler rather than from init().
async function ensureOrigin(origin) {
  return requestOrigin(origin);
}

// ── GitHub sync ──────────────────────────────────────────────────────────────

// Everything the GitHub section knows, read straight from the form — the same
// approach the Jira actions take, so Test connection works before Save.
function githubFormState() {
  const host = normalizeGithubHost(githubHostInput.value) || "github.com";
  const org = normalizeGithubOrg(githubOrgInput.value);
  const { repos, invalid } = parseRepoList(githubReposInput.value, org);
  return { enabled: githubEnabledBox.checked, host, org, repos, invalid };
}

function renderGithubRepoNote() {
  const { repos, invalid, enabled, org } = githubFormState();
  const parts = [];
  if (repos.length) {
    parts.push(`${repos.length} repo${repos.length === 1 ? "" : "s"} in scope: ${repos.map(repoSlug).join(", ")}`);
  }
  if (invalid.length) {
    parts.push(`Not readable as a repo, will be dropped: ${invalid.join(", ")}`);
  }
  if (enabled && !org) parts.push("Set the organisation before saving.");
  if (enabled && org && !repos.length) {
    parts.push("No repos listed — nothing will be fetched until you add at least one.");
  }
  githubRepoNote.textContent = parts.join(" · ");
  githubRepoNote.classList.toggle(
    "token-status-soon",
    Boolean(invalid.length || (enabled && (!org || !repos.length)))
  );
}

async function renderGithubTokenStatus() {
  const status = await githubTokenStatus();
  githubTokenNote.textContent = describeGithubTokenStatus(status);
  githubTokenNote.classList.toggle("token-status-expired", status.expired);
  githubTokenNote.classList.toggle("token-status-soon", status.expiringSoon);
  // The org matcher needs a token and an org; offering it without either just
  // produces a confusing failure.
  const { org } = githubFormState();
  matchGithubBtn.hidden = !(status.hasToken && org);
}

toggleGithubTokenBtn.addEventListener("click", () => {
  const hidden = githubTokenInput.type === "password";
  githubTokenInput.type = hidden ? "text" : "password";
  toggleGithubTokenBtn.textContent = hidden ? "Hide" : "Show";
});

for (const input of [githubHostInput, githubOrgInput, githubReposInput]) {
  input.addEventListener("input", renderGithubRepoNote);
}
githubEnabledBox.addEventListener("change", renderGithubRepoNote);
githubOrgInput.addEventListener("change", renderGithubTokenStatus);

function repoResultRow(name, ok, detail) {
  const row = document.createElement("div");
  row.className = "board-row repo-row";
  const label = document.createElement("span");
  label.className = "repo-name";
  label.textContent = name;
  const verdict = document.createElement("span");
  verdict.className = `repo-verdict ${ok ? "ok" : "bad"}`;
  verdict.textContent = detail;
  row.append(label, verdict);
  return row;
}

githubTestBtn.addEventListener("click", async () => {
  const { host, org, repos, invalid } = githubFormState();
  const token = githubTokenInput.value.trim() || (await getGithubToken());

  if (!org) return flash("Set the GitHub organisation first", "warning");
  if (!token) return flash("Paste a GitHub token first", "warning");
  // The repo list lives in its own section, so say where rather than just
  // refusing at someone looking at a different part of the page.
  if (!repos.length) {
    return flash("Add at least one repo under GitHub settings — the list is the scope", "warning");
  }

  const granted = await ensureOrigin(githubOrigin(host));
  if (!granted) return flash(`Access to ${host} was not granted`, "error");

  githubTestBtn.disabled = true;
  githubTestBtn.textContent = "Testing...";
  githubTestResults.innerHTML = "";

  try {
    const identity = await verifyGithubToken({ host, org }, token);
    // Per repo, because access is granted per repo: listing one here does not
    // give the token access to it, and a 404 is what that looks like.
    const results = await checkRepoAccess(repos, { host }, token);

    githubTestResults.appendChild(
      repoResultRow(`authenticated as ${identity.login || "?"}`, true, "ok")
    );
    for (const result of results) {
      githubTestResults.appendChild(
        repoResultRow(
          result.repo,
          result.ok,
          result.ok ? (result.private ? "private · ok" : "public · ok") : result.error
        )
      );
    }
    for (const line of invalid) {
      githubTestResults.appendChild(repoResultRow(line, false, "unreadable — will be dropped"));
    }

    const unreachable = results.filter((r) => !r.ok);
    if (unreachable.length) {
      flash(
        `${unreachable.length} of ${results.length} repos unreachable — check the token's repository access and org approval`,
        "warning"
      );
    } else {
      flash(`Connected as ${identity.login} — all ${results.length} repos reachable`, "success");
    }
    await renderGithubTokenStatus();
  } catch (err) {
    const msg = String(err.message || err);
    githubTestResults.appendChild(repoResultRow("connection", false, msg));
    flash(`GitHub test failed: ${msg}`, "error");
  } finally {
    githubTestBtn.disabled = false;
    githubTestBtn.textContent = "✓ Test connection";
  }
});

forgetGithubTokenBtn.addEventListener("click", async () => {
  if (!confirm("Remove the stored GitHub token from this device?\n\nYour Jira setup and the repo list are kept. Standup simply loses its GitHub panel.")) {
    return;
  }
  await clearGithubToken();
  githubTokenInput.value = "";
  await renderGithubTokenStatus();
  flash("GitHub token removed from this device", "warning");
  await notifyApp();
});

matchGithubBtn.addEventListener("click", async () => {
  const { host, org } = githubFormState();
  const token = githubTokenInput.value.trim() || (await getGithubToken());
  if (!org || !token) return flash("Set the GitHub org and token first", "warning");

  const granted = await ensureOrigin(githubOrigin(host));
  if (!granted) return flash(`Access to ${host} was not granted`, "error");

  matchGithubBtn.disabled = true;
  matchGithubBtn.textContent = "Matching...";
  try {
    const orgMembers = await listOrgMembers({ host, org }, token);
    const proposal = proposeGithubMatches(roster.getMembers(), orgMembers);
    const applied = roster.applyGithubLogins(proposal.matches);
    const bits = [`${orgMembers.length} org members`];
    if (applied) bits.push(`matched ${applied}`);
    if (proposal.ambiguous.length) bits.push(`${proposal.ambiguous.length} ambiguous, left blank`);
    const missing = roster.countMissingGithubLogins();
    if (missing) bits.push(`${missing} still without a login`);
    flash(
      `${bits.join(" · ")}${applied ? " — review and press Save" : ""}`,
      applied ? "success" : "warning"
    );
  } catch (err) {
    const msg = String(err.message || err);
    flash(
      msg.includes("403")
        ? "GitHub refused the member list (403) — the token needs org 'Members: read'. Fill logins in by hand instead."
        : `Match failed: ${msg}`,
      "error"
    );
  } finally {
    matchGithubBtn.disabled = false;
    matchGithubBtn.textContent = "⇄ Match logins from GitHub org";
  }
});

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

  const github = githubFormState();
  if (github.enabled) {
    if (!github.org) return flash("GitHub sync needs an organisation", "warning");
    if (!github.repos.length) {
      return flash(
        "GitHub sync needs at least one repo under GitHub settings — the list is the scope",
        "warning"
      );
    }
    // Requested from inside the Save click, which is the gesture Chrome wants.
    const ghGranted = await ensureOrigin(githubOrigin(github.host));
    if (!ghGranted) return flash(`Access to ${github.host} was not granted`, "error");
  }

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
    github: {
      enabled: github.enabled,
      host: github.host,
      org: github.org,
      repos: github.repos.map(repoSlug),
    },
  });

  // Saved separately from the config, on this device only, with no expiry
  // guess — GitHub reports the real date on the first authenticated call.
  const githubToken = githubTokenInput.value.trim();
  if (githubToken) await saveGithubToken(githubToken);
  await saveCredentials({
    email,
    token,
    tokenExpiresAt: tokenExpiryInput.value || defaultExpiry(),
  });

  if (roster) await saveMembers(roster.getMembers());

  baseUrlInput.value = CONFIG.site.baseUrl;
  boards = validBoards;
  githubReposInput.value = github.repos.map(repoSlug).join("\n");
  renderBoards();
  renderLocalFieldsNote();
  renderGithubRepoNote();
  await renderTokenStatus();
  await renderGithubTokenStatus();
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

  const gh = CONFIG.github || {};
  githubEnabledBox.checked = gh.enabled === true;
  githubHostInput.value = gh.host || "github.com";
  githubOrgInput.value = gh.org || "";
  githubReposInput.value = (gh.repos || []).join("\n");

  const stored = await loadCredentials();
  if (stored?.email) emailInput.value = stored.email;
  if (stored?.token) tokenInput.value = stored.token;
  tokenExpiryInput.value = stored?.tokenExpiresAt?.slice(0, 10) || "";
  githubTokenInput.value = await getGithubToken();

  if (!roster) {
    roster = initRoster({
      flash,
      requireLiveJira: withLiveConfig,
      getBoards: () => boards,
    });
  }
  roster.setMembers(allMembers());

  renderBoards();
  renderStatusGroups();
  renderFieldRoles();
  renderMonitorChecks();
  renderLocalFieldsNote();
  renderGithubRepoNote();
  await renderTokenStatus();
  await renderGithubTokenStatus();
}

init();
