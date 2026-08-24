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

const TOAST_MS = 5000;
let toastTimer = null;

// Shared by the router and any view that needs to report a one-off outcome.
//
// `action` turns the toast into the app's undo window: `{ label, run }` draws a
// button, and the window is however long the toast stays up. Which is why the
// timer is now cleared rather than left to fire — a second toast used to cut the
// first one short, and an undo that disappears early is worse than no undo.
export function showToast(message, isError = false, action = null) {
  const toast = document.getElementById("toast");
  if (!toast) return;
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

  // The toast is click-through by default so it never swallows a click on the
  // board underneath; one with a button in it has to opt back in.
  toast.className = "visible" + (isError ? " error" : "") + (action ? " actionable" : "");
  toastTimer = setTimeout(hideToast, action?.timeout ?? TOAST_MS);
}

function hideToast() {
  const toast = document.getElementById("toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toast.className = "";
}
