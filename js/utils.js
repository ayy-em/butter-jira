import {
  CONFIG,
  DEFAULT_STATUS_GROUPS,
  boardPaletteColor,
  fieldValue,
  loadConfig,
  saveConfig,
} from "./config.js";

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
  if (!a || !a.avatarUrls) return null;
  return a.avatarUrls["24x24"] || a.avatarUrls["16x16"] || null;
}

export function formatDisplayName(name) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[parts.length - 1]}`;
  }
  return parts[0];
}

export function extractAssignees(issues) {
  const map = new Map();
  for (const issue of issues) {
    const a = issue.fields.assignee;
    if (!a) continue;
    if (!map.has(a.accountId)) {
      map.set(a.accountId, {
        accountId: a.accountId,
        displayName: a.displayName,
        avatarUrl: getAvatarUrl(issue),
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

export async function loadStatusGroups() {
  return CONFIG.statusGroups?.length ? CONFIG.statusGroups : DEFAULT_STATUS_GROUPS;
}

export async function saveStatusGroups(groups) {
  await saveConfig({ statusGroups: groups });
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
  const result = await chrome.storage.sync.get("theme");
  const theme = result.theme || "dark";
  applyTheme(theme);
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export async function saveTheme(theme) {
  await chrome.storage.sync.set({ theme });
  applyTheme(theme);
}

const CACHE_TTL = 5 * 60 * 1000;

export const cache = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.value;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: { value, ts: Date.now() } });
  },
  async clear() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("cache_"));
    if (keys.length) await chrome.storage.local.remove(keys);
  },
};
