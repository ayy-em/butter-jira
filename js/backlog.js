// Backlog view logic: grouping, sorting, pagination, density, saved views and
// column visibility.
//
// DOM-free on purpose, same split as monitor.js and dashboard.js. The awkward
// parts here are all arithmetic — which page you land on when a filter shrinks
// the list under you, what the ellipsis window looks like at page 7 of 12,
// whether a group survives being sorted — and none of that needs a browser to
// get wrong.

import { localGet, localSet } from "./browser.js";
import { boardName, getStoryPoints } from "./utils.js";
import { displayNameFor } from "./team.js";

// ── Density ──────────────────────────────────────────────────────────────────

export const DENSITIES = [
  { id: "compact", label: "Compact", hint: "Most rows on screen" },
  { id: "default", label: "Default", hint: "A little room to breathe" },
  { id: "cozy", label: "Cozy", hint: "Comfortable for long sessions" },
];
export const DEFAULT_DENSITY = "compact";

export function isDensity(id) {
  return DENSITIES.some((d) => d.id === id);
}

// ── Columns ──────────────────────────────────────────────────────────────────

// `optional: false` means the column cannot be hidden — a row with no key and
// no summary is not a row. Board defaults off because the left accent bar now
// carries board identity (task item 9).
export const COLUMNS = [
  { id: "select", label: "", title: "Select", optional: false, fixed: true },
  { id: "key", label: "Key", optional: false },
  { id: "summary", label: "Summary", optional: false },
  { id: "type", label: "Type", optional: true },
  { id: "epic", label: "Epic", optional: true },
  { id: "status", label: "Status", optional: true },
  { id: "assignee", label: "Assignee", optional: true },
  { id: "sp", label: "SP", title: "Story points", optional: true },
  { id: "due", label: "Due", optional: true },
  { id: "updated", label: "Updated", optional: true },
  { id: "board", label: "Board", optional: true, offByDefault: true },
];

export function defaultColumns() {
  return COLUMNS.filter((c) => !c.offByDefault).map((c) => c.id);
}

// Stored as the visible set rather than the hidden set: a column added in a
// later version should appear for everyone by default, and storing hidden ids
// would give the opposite — the same reasoning as monitorChecks storing mutes.
// So an unknown id is dropped, and a *missing* stored list means "defaults".
export function normalizeColumns(stored) {
  if (!Array.isArray(stored)) return defaultColumns();
  const known = new Set(COLUMNS.map((c) => c.id));
  const visible = stored.filter((id) => known.has(id));
  const required = COLUMNS.filter((c) => !c.optional).map((c) => c.id);
  for (const id of required) if (!visible.includes(id)) visible.unshift(id);
  // Keep declaration order so toggling a column back on puts it where it was.
  return COLUMNS.filter((c) => visible.includes(c.id)).map((c) => c.id);
}

export function toggleColumn(visible, id) {
  const column = COLUMNS.find((c) => c.id === id);
  if (!column || !column.optional) return normalizeColumns(visible);
  const next = visible.includes(id)
    ? visible.filter((v) => v !== id)
    : [...visible, id];
  return normalizeColumns(next);
}

// ── Grouping ─────────────────────────────────────────────────────────────────

export const GROUPINGS = [
  { id: "none", label: "None" },
  { id: "epic", label: "Epic" },
  { id: "assignee", label: "Assignee" },
  { id: "board", label: "Board" },
  { id: "status", label: "Status" },
];

export function isGrouping(id) {
  return GROUPINGS.some((g) => g.id === id);
}

// Returns [{ key, label, issues }]. `key` is stable for collapse state; `label`
// is what the header shows. Ungrouped returns a single unlabelled bucket so the
// renderer has one shape to deal with rather than two.
export function groupIssues(issues, groupBy, { epicLabel = () => "" } = {}) {
  if (groupBy === "none" || !isGrouping(groupBy)) {
    return [{ key: "all", label: "", issues }];
  }

  const buckets = new Map();
  const put = (key, label, issue) => {
    if (!buckets.has(key)) buckets.set(key, { key, label, issues: [] });
    buckets.get(key).issues.push(issue);
  };

  for (const issue of issues) {
    if (groupBy === "epic") {
      const label = epicLabel(issue);
      put(label || "__none__", label || "No epic", issue);
    } else if (groupBy === "assignee") {
      const id = issue.fields?.assignee?.accountId || "__none__";
      put(id, issue.fields?.assignee ? displayNameFor(issue.fields.assignee) : "Unassigned", issue);
    } else if (groupBy === "board") {
      put(String(issue.boardId ?? "__none__"), boardName(issue.boardId) || "No board", issue);
    } else if (groupBy === "status") {
      const name = issue.fields?.status?.name || "";
      put(name || "__none__", name || "No status", issue);
    }
  }

  // "None"-ish buckets sort last whatever they are called; everything else
  // alphabetically, so the order does not depend on which issue came first.
  return [...buckets.values()].sort((a, b) => {
    const aNone = a.key === "__none__";
    const bNone = b.key === "__none__";
    if (aNone !== bNone) return aNone ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export const SORTS = [
  { id: "updated", label: "Last updated" },
  { id: "created", label: "Created" },
  { id: "sp", label: "Story points" },
  { id: "due", label: "Due date" },
  { id: "status", label: "Status" },
  { id: "key", label: "Key" },
  { id: "summary", label: "Summary" },
  { id: "epic", label: "Epic" },
  { id: "assignee", label: "Assignee" },
  { id: "board", label: "Board" },
  { id: "type", label: "Type" },
];

export function isSort(id) {
  return SORTS.some((s) => s.id === id);
}

const STATUS_ORDER = {
  "in review": 0, "in code review": 0, "code review": 0, "review": 0,
  "in progress": 1, "in development": 1,
  "on hold": 2,
  "done": 90, "closed": 90, "resolved": 90,
  "rejected": 91,
};

const time = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

export function sortIssues(issues, col, dir, { epicLabel = () => "" } = {}) {
  const sorted = [...issues];
  const m = dir === "asc" ? 1 : -1;
  const text = (v) => String(v || "");

  sorted.sort((a, b) => {
    const fa = a.fields || {};
    const fb = b.fields || {};
    switch (col) {
      case "board":
        return text(a.boardName).localeCompare(text(b.boardName)) * m;
      case "key":
        return text(a.key).localeCompare(text(b.key)) * m;
      case "type":
        return text(fa.issuetype?.name).localeCompare(text(fb.issuetype?.name)) * m;
      case "summary":
        return text(fa.summary).localeCompare(text(fb.summary)) * m;
      case "status": {
        const sa = STATUS_ORDER[text(fa.status?.name).toLowerCase()] ?? 50;
        const sb = STATUS_ORDER[text(fb.status?.name).toLowerCase()] ?? 50;
        if (sa !== sb) return (sa - sb) * m;
        return text(fa.status?.name).localeCompare(text(fb.status?.name)) * m;
      }
      case "epic":
        return (epicLabel(a) || "zzz").localeCompare(epicLabel(b) || "zzz") * m;
      case "assignee":
        return (text(fa.assignee?.displayName) || "zzz")
          .localeCompare(text(fb.assignee?.displayName) || "zzz") * m;
      case "sp":
        return ((getStoryPoints(a) ?? -1) - (getStoryPoints(b) ?? -1)) * m;
      case "due": {
        // Undated sorts last in both directions: "no due date" is not earlier
        // or later than a date, and burying it flips confusingly on reverse.
        const va = fa.duedate ? time(fa.duedate) : Infinity;
        const vb = fb.duedate ? time(fb.duedate) : Infinity;
        if (va === vb) return 0;
        if (va === Infinity) return 1;
        if (vb === Infinity) return -1;
        return (va - vb) * m;
      }
      case "updated":
        return (time(fa.updated) - time(fb.updated)) * m;
      case "created":
        return (time(fa.created) - time(fb.created)) * m;
      default:
        return 0;
    }
  });
  return sorted;
}

// ── Pagination ───────────────────────────────────────────────────────────────

export const PAGE_SIZES = [25, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

// Clamped, not trusted: a filter that shrinks the list while you are on page 9
// must not leave you staring at an empty table.
export function paginate(items, page, perPage) {
  const size = PAGE_SIZES.includes(perPage) ? perPage : DEFAULT_PAGE_SIZE;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    slice,
    page: current,
    totalPages,
    total,
    from: total ? start + 1 : 0,
    to: start + slice.length,
  };
}

// [1, 2, 3, "…", 12] — first, last, and a window around the current page.
export function pageWindow(page, totalPages, span = 1) {
  if (totalPages <= 1) return [1];
  const wanted = new Set([1, totalPages]);
  for (let p = page - span; p <= page + span; p++) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }
  const pages = [...wanted].sort((a, b) => a - b);
  const out = [];
  let previous = 0;
  for (const p of pages) {
    if (previous && p - previous > 1) out.push("…");
    out.push(p);
    previous = p;
  }
  return out;
}

// ── Presentation helpers ─────────────────────────────────────────────────────

// Six tones, as the task asks. Mapped off Jira's own statusCategory first,
// because that is the only signal that survives a site renaming its statuses;
// the name table is a refinement on top, not the basis.
export const STATUS_TONES = ["gray", "blue", "green", "orange", "red", "purple"];

const TONE_BY_NAME = {
  "to do": "gray", "open": "gray", "backlog": "gray", "new": "gray",
  "in progress": "blue", "in development": "blue", "in testing": "blue",
  "in review": "purple", "code review": "purple", "in code review": "purple", "review": "purple",
  "on hold": "orange", "blocked": "red", "impediment": "red",
  "done": "green", "closed": "green", "resolved": "green",
  "rejected": "red", "cancelled": "red", "won't do": "red",
};

export function statusTone(status) {
  const name = String(status?.name || "").toLowerCase().trim();
  if (TONE_BY_NAME[name]) return TONE_BY_NAME[name];
  switch (status?.statusCategory?.key) {
    case "done": return "green";
    case "indeterminate": return "blue";
    case "new": return "gray";
    default: return "gray";
  }
}

// "2h ago" / "Yesterday" / "3d ago". Deliberately coarse: this column exists
// for grooming ("what has gone stale"), where the hour is noise past a day.
export function relativeTime(iso, now = new Date()) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// The summary tiles. Driven by the configured status groups rather than the
// five names in the mockup: this app lets every site define its own workflow,
// and a tile hardcoded to "On Hold" would read zero for anyone who does not
// have that status. Total is always first.
export function summaryTiles(issues, statusGroups) {
  const groups = Array.isArray(statusGroups) ? statusGroups : [];
  const byName = new Map();
  for (const group of groups) {
    for (const status of group.statuses || []) {
      byName.set(String(status).toLowerCase(), group.name);
    }
  }

  const counts = new Map(groups.map((g) => [g.name, 0]));
  for (const issue of issues) {
    const name = String(issue.fields?.status?.name || "").toLowerCase();
    const group = byName.get(name);
    if (group !== undefined) counts.set(group, (counts.get(group) || 0) + 1);
  }

  return [
    { id: "__total__", label: "Total issues", count: issues.length, tone: "total" },
    ...groups.map((g) => ({
      id: g.name,
      label: g.name,
      count: counts.get(g.name) || 0,
      tone: statusTone({ name: g.statuses?.[0] || g.name }),
    })),
  ];
}

// ── Saved views ──────────────────────────────────────────────────────────────

export function normalizeView(raw = {}) {
  const name = String(raw.name || "").trim().slice(0, 60);
  if (!name) return null;
  return {
    id: String(raw.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80),
    name,
    filters: raw.filters && typeof raw.filters === "object" ? { ...raw.filters } : {},
    groupBy: isGrouping(raw.groupBy) ? raw.groupBy : "none",
    sortCol: isSort(raw.sortCol) ? raw.sortCol : "updated",
    sortDir: raw.sortDir === "asc" ? "asc" : "desc",
    columns: normalizeColumns(raw.columns),
    density: isDensity(raw.density) ? raw.density : DEFAULT_DENSITY,
  };
}

export function upsertView(views, view) {
  const clean = normalizeView(view);
  if (!clean) return views;
  const without = views.filter((v) => v.id !== clean.id);
  return [...without, clean].slice(-20);   // a view list is not an archive
}

export function removeView(views, id) {
  return views.filter((v) => v.id !== id);
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Device-local: these are view preferences, the same class as the Monitor
// scope toggle and the Kanban column order. Syncing them would mean one
// person's density choice arriving on a colleague's machine mid-sprint.

export const PREFS_KEY = "backlogPrefs";

export async function loadPrefs() {
  const stored = (await localGet(PREFS_KEY))[PREFS_KEY] || {};
  return {
    density: isDensity(stored.density) ? stored.density : DEFAULT_DENSITY,
    groupBy: isGrouping(stored.groupBy) ? stored.groupBy : "none",
    sortCol: isSort(stored.sortCol) ? stored.sortCol : "updated",
    sortDir: stored.sortDir === "asc" ? "asc" : "desc",
    columns: normalizeColumns(stored.columns),
    perPage: PAGE_SIZES.includes(stored.perPage) ? stored.perPage : DEFAULT_PAGE_SIZE,
    sidebarOpen: stored.sidebarOpen !== false,
    views: Array.isArray(stored.views)
      ? stored.views.map(normalizeView).filter(Boolean)
      : [],
  };
}

export async function savePrefs(prefs) {
  await localSet({ [PREFS_KEY]: prefs });
  return prefs;
}
