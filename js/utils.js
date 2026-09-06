import { localGet, localRemove, localSet, syncGet, syncSet } from "./browser.js";
import {
  CONFIG,
  DEFAULT_STATUS_GROUPS,
  boardPaletteColor,
  fieldValue,
  loadConfig,
  saveConfig,
} from "./config.js";
import { avatarOverrideFor, displayNameFor, isOnTeam } from "./team.js";
import { icon } from "./components/icons.js";

// Boards come from user config — there are no built-in defaults, because board
// IDs and project keys belong to one specific Jira site.
const BOARDS = [];

export { BOARDS, DEFAULT_STATUS_GROUPS };

function syncBoardsFromConfig() {
  BOARDS.length = 0;
  (CONFIG.boards || []).forEach((board, i) => {
    BOARDS.push({ ...board, color: board.color || boardPaletteColor(i) });
  });
  return BOARDS;
}

export async function loadBoards() {
  await loadConfig();
  return syncBoardsFromConfig();
}

// Points the live board list at an explicit set. The Settings page needs this:
// it stages board edits in its own array and never calls loadBoards(), so
// without it every Jira call made from Settings sees no boards at all.
export function setBoardList(boards) {
  BOARDS.length = 0;
  (boards || []).forEach((board, i) => {
    BOARDS.push({ ...board, color: board.color || boardPaletteColor(i) });
  });
  return BOARDS;
}

export async function saveBoards(boards) {
  await saveConfig({ boards });
  return syncBoardsFromConfig();
}

export function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = ((hash % 360) + 360) % 360;
  return `hsl(${h}, 65%, 58%)`;
}

export function boardColor(boardId) {
  const b = BOARDS.find((x) => x.id === boardId);
  return b ? b.color : "#6B7280";
}

export function boardName(boardId) {
  const b = BOARDS.find((x) => x.id === boardId);
  return b ? b.name : "?";
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export function relDate(iso) {
  if (!iso) return "—";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = then - now;
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  if (diffDays > 0 && diffDays < 14) return `in ${diffDays}d`;
  if (diffDays > 0) return `in ${Math.round(diffDays / 7)}w`;
  if (diffDays > -14) return `${Math.abs(diffDays)}d ago`;
  return `${Math.round(Math.abs(diffDays) / 7)}w ago`;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// 1234 -> "1.2k". Lines merged runs into five figures on a good sprint, and the
// cells it sits in are narrow in both the standup panel and the dashboard table.
export function compactNum(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

export function getStoryPoints(issue) {
  const value = fieldValue(issue, "storyPoints");
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== null ? parsed : null;
}

// ISO date string (YYYY-MM-DD) or null.
export function getStartDate(issue) {
  const value = fieldValue(issue, "startDate");
  return typeof value === "string" ? value.slice(0, 10) : null;
}

// Epic key for an issue: the configured epic-link field, else the modern parent.
export function getEpicKey(issue) {
  const value = fieldValue(issue, "epicLink");
  if (typeof value === "string") return value;
  if (value?.key) return value.key;
  const parent = issue?.fields?.parent;
  if (parent?.fields?.issuetype?.name === "Epic") return parent.key;
  return parent?.key || null;
}

export function getAvatarUrl(issue) {
  const a = issue.fields.assignee;
  const override = avatarOverrideFor(a?.accountId);
  if (override) return override;
  if (!a || !a.avatarUrls) return null;
  return a.avatarUrls["24x24"] || a.avatarUrls["16x16"] || null;
}

// The name to show for an issue's assignee, roster override included.
export function assigneeLabel(assignee) {
  return displayNameFor(assignee);
}

// Distinct assignees across the issues, roster members first. `displayName` is
// the resolved label so callers can render it directly; `onTeam` lets the UI
// mark outsiders instead of hiding them silently.
export function extractAssignees(issues) {
  const map = new Map();
  for (const issue of issues) {
    const a = issue.fields.assignee;
    if (!a?.accountId || map.has(a.accountId)) continue;
    map.set(a.accountId, {
      accountId: a.accountId,
      displayName: displayNameFor(a),
      jiraName: a.displayName || "",
      avatarUrl: getAvatarUrl(issue),
      onTeam: isOnTeam(a.accountId),
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.onTeam !== b.onTeam) return a.onTeam ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export async function loadStatusGroups() {
  return CONFIG.statusGroups?.length ? CONFIG.statusGroups : DEFAULT_STATUS_GROUPS;
}

export async function saveStatusGroups(groups) {
  await saveConfig({ statusGroups: groups });
}

// Today as YYYY-MM-DD in local time. Jira due dates are date-only strings, and
// ISO dates compare lexicographically, so string comparison is both correct and
// free of timezone drift.
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Past its due date and still not finished. "Finished" comes from Jira's own
// status category rather than a column name, so a renamed or regrouped Done
// column still counts as done. Due *today* is not overdue.
export function isOverdue(issue, now = new Date()) {
  const due = issue?.fields?.duedate;
  if (!due) return false;
  if (issue.fields?.status?.statusCategory?.key === "done") return false;
  return String(due).slice(0, 10) < todayIso(now);
}

export function resolveStatusGroup(statusName, groups) {
  if (!statusName) return "To Do";
  for (const g of groups) {
    if (g.statuses.some((s) => s.toLowerCase() === statusName.toLowerCase())) {
      return g.name;
    }
  }
  return statusName;
}

// What a column editor is allowed to save.
//
// Both editors — the board's COLUMNS panel and the settings page — used to end
// with `filter(g => g.name.trim() && g.statuses.length)`: a half-finished row
// was dropped on save with no message and no highlight, so the way to discover
// that a column had not been kept was to notice it missing from the board
// afterwards. A row nobody has touched is noise and is dropped; a row somebody
// has half-filled is work, and is refused loudly instead.
//
// Pure, and returns problems rather than throwing, so the caller can mark the
// rows it got back by index and leave the panel open on what the user typed.
export function validateStatusGroups(groups) {
  const cleaned = [];
  const problems = [];
  const namesSeen = new Map();
  const statusesSeen = new Map();

  (groups || []).forEach((group, index) => {
    const name = String(group?.name || "").trim();
    const statuses = (group?.statuses || [])
      .map((s) => String(s).trim())
      .filter(Boolean);

    // The "+ Add column" row that was never filled in. Not half-finished — not
    // started — so it goes quietly.
    if (!name && !statuses.length) return;

    if (!name) {
      problems.push({ index, message: `A column holding ${statuses.join(", ")} has no name.` });
      return;
    }
    if (!statuses.length) {
      problems.push({ index, message: `"${name}" has no statuses, so it would always be empty.` });
      return;
    }
    const nameKey = name.toLowerCase();
    if (namesSeen.has(nameKey)) {
      problems.push({ index, message: `Two columns are both called "${name}".` });
      return;
    }
    namesSeen.set(nameKey, index);

    for (const status of statuses) {
      const statusKey = status.toLowerCase();
      // resolveStatusGroup takes the first match, so a status in two columns
      // silently belongs to the earlier one. Say so rather than pick.
      if (statusesSeen.has(statusKey)) {
        problems.push({
          index,
          message: `"${status}" is in two columns; an issue can only be in one.`,
        });
      } else {
        statusesSeen.set(statusKey, index);
      }
    }
    cleaned.push({ name, statuses });
  });

  if (!cleaned.length && !problems.length) {
    problems.push({ index: -1, message: "Add at least one column." });
  }
  return { groups: cleaned, problems, ok: problems.length === 0 };
}

// Every status name this session has actually seen, with how many issues are in
// each. The point of the column editor's shelf: the app has already fetched
// these, so nobody should be typing them from memory. Names keep the casing
// Jira sent; matching everywhere else is case-insensitive.
export function statusesInIssues(issues) {
  const counts = new Map();
  for (const issue of issues || []) {
    const name = issue?.fields?.status?.name;
    if (!name) continue;
    const key = name.toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { name, count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadTheme() {
  const result = await syncGet("theme");
  const theme = result.theme || "dark";
  applyTheme(theme);
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export async function saveTheme(theme) {
  await syncSet({ theme });
  applyTheme(theme);
}

const CACHE_TTL = 5 * 60 * 1000;

export const cache = {
  async get(key) {
    const result = await localGet(key);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.value;
  },
  async set(key, value) {
    await localSet({ [key]: { value, ts: Date.now() } });
  },
  async clear() {
    const all = await localGet(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("cache_"));
    if (keys.length) await localRemove(keys);
  },
  // Targeted invalidation after a write, so changing one issue's status doesn't
  // cost a refetch of every board's sprints, backlog and epics.
  async dropBoard(boardId) {
    const all = await localGet(null);
    const keys = Object.keys(all).filter(
      (k) =>
        k.startsWith(`cache_sprintIssues_${boardId}_`) ||
        k === `cache_backlog_${boardId}`
    );
    if (keys.length) await localRemove(keys);
  },
};

// A confirmation is a receipt — you already know what you did, and it can go.
// An error is the opposite: it is the app telling you something you did not
// know, in wording that is often the only place the reason appears.
//
//   "ACME-101: the workflow allows no move from In Review to Done — only
//    Blocked, Reopened"
//
// That sentence used to get five seconds, bottom-centre, on a screen a room is
// reading, while the card you dropped sits wherever you dropped it. Errors now
// stay up long enough to be read aloud, keep a visible way to dismiss them
// early, and — because the one thing nobody could do was ask what it said again
// — the last one can be brought back.
const TOAST_MS = 5000;
const TOAST_ERROR_MS = 15000;
let toastTimer = null;

// The last message shown, so it can be recalled after it has gone. Held in
// memory only: it is a thing that just happened on this screen, not a log.
let lastToast = null;

export function lastToastMessage() {
  return lastToast;
}

// Shared by the router and any view that needs to report a one-off outcome.
//
// `action` turns the toast into the app's undo window: `{ label, run }` draws a
// button, and the window is however long the toast stays up. Which is why the
// timer is now cleared rather than left to fire — a second toast used to cut the
// first one short, and an undo that disappears early is worse than no undo.
export function showToast(message, isError = false, action = null) {
  const shown = renderToast(message, isError, action);
  if (shown) lastToast = { message, isError, at: Date.now() };
}

// Put the last message back on screen. Never re-runs an action — an undo button
// that reappears an hour later, pointing at a write that has long since been
// overtaken, is a trap rather than a convenience.
export function recallToast() {
  if (!lastToast) {
    renderToast("Nothing to show — no messages yet", false, null);
    return false;
  }
  renderToast(`${lastToast.message}  ·  ${relativeAge(lastToast.at)}`, lastToast.isError, null);
  return true;
}

function relativeAge(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function renderToast(message, isError, action) {
  const toast = document.getElementById("toast");
  if (!toast) return false;
  if (toastTimer) clearTimeout(toastTimer);

  toast.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  if (action?.label && typeof action.run === "function") {
    const btn = document.createElement("button");
    btn.className = "toast-action mono";
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      hideToast();
      action.run();
    });
    toast.appendChild(btn);
  }

  // An error holds the screen for a while, so it needs a way off it that is not
  // waiting. Confirmations do not: they are gone before anyone would reach.
  if (isError) {
    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss icon-btn";
    dismiss.type = "button";
    dismiss.appendChild(icon("close", 12));
    dismiss.title = "Dismiss";
    dismiss.setAttribute("aria-label", "Dismiss this message");
    dismiss.addEventListener("click", hideToast);
    toast.appendChild(dismiss);
  }

  // The toast is click-through by default so it never swallows a click on the
  // board underneath; one with a button in it has to opt back in.
  const clickable = Boolean(action) || isError;
  toast.className =
    "visible" + (isError ? " error" : "") + (clickable ? " actionable" : "");
  // Announced, and assertively for an error: a message that appears and leaves
  // on a timer is invisible to a screen reader otherwise.
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-live", isError ? "assertive" : "polite");

  const dwell = action?.timeout ?? (isError ? TOAST_ERROR_MS : TOAST_MS);
  toastTimer = setTimeout(hideToast, dwell);
  // Reading it stops the clock. Somebody with the pointer on the message is
  // mid-sentence, and a countdown that ignores that is the reason this item
  // existed.
  if (clickable) armHoverHold(toast, dwell);
  return true;
}

// While the pointer is over the toast the timer is off; when it leaves, the
// full dwell starts again rather than resuming a stub of it.
function armHoverHold(toast, dwell) {
  const hold = () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  };
  const release = () => {
    if (!toast.classList.contains("visible")) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, dwell);
  };
  toast.onmouseenter = hold;
  toast.onmouseleave = release;
  toast.onfocusin = hold;
  toast.onfocusout = release;
}

function hideToast() {
  const toast = document.getElementById("toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toast.className = "";
  toast.onmouseenter = null;
  toast.onmouseleave = null;
  toast.onfocusin = null;
  toast.onfocusout = null;
}
