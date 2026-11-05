// Per-sprint history (M17) — one rollup row a sprint, kept for years.
//
// The daily snapshots (`js/snapshots.js`) answer "how much was left on
// Tuesday" and are capped at eight sprints, which is right for sixty rows a
// sprint. A trend asks a different question — "how did this sprint end,
// against the last twenty" — and wants one small row a sprint for as long as
// the team exists. So this is a store of its own, with its own retention.
//
// ── How a row is written ─────────────────────────────────────────────────────
//
// Built forward, because a figure not stored when it was available is gone:
//
//   1. **Every live dashboard load writes the running sprint's draft row** —
//      its name, dates, commitment and the day's totals — from the same summary
//      that writes the daily snapshot. So the draft is always as fresh as the
//      last snapshot, and holds the one thing a snapshot does not: the
//      commitment, read off the sprint's freeze while the freeze still exists.
//   2. **At rollover** — the first live load that sees a different sprint key,
//      which is the moment the freeze hooks too — every draft that is not the
//      running sprint is finalised: the GitHub figures are counted over the
//      sprint's own dates and the row stops changing.
//   3. **Sprints from before this store existed** are seeded once from what is
//      still on the device: the last daily snapshot of each stored sprint, and
//      its freeze for the name, the dates and the commitment.
//
// ── What a row can claim ─────────────────────────────────────────────────────
//
// `partial` is per source, so a row built from a truncated window draws as
// incomplete rather than as a dip. Jira is partial when the last reading was
// taken before the sprint's last day — nobody opened the dashboard on the
// Friday — or when there was no freeze to say what was committed. GitHub is
// partial when the fetch window started after the sprint did, or a repository
// ran out of pages. Null GitHub figures mean GitHub sync was off: an absence,
// drawn as nothing, never as zero.
//
// Team-level only, like the burndown. Nothing here is per person, so the trend
// cannot be read as a ranking.

import { localGet, localSet } from "./browser.js";
import { isoDay, sprintNames, sprintWindow } from "./dashboard.js";
import { statsFor } from "./github.js";

export const HISTORY_KEY = "sprintHistory";

// Four years of fortnightly sprints. Far past what a trend chart shows; the
// bound exists so a store nobody clears cannot grow without one. Clearing is
// Settings → Backup & transfer → Delete sprint history.
export const MAX_HISTORY_ROWS = 104;

const DAY_MS = 86400000;

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// ── Rows ────────────────────────────────────────────────────────────────────

// The running sprint's draft, from the dashboard's summary and scope reading.
// `scope` is `scopeChange()`'s answer: `original` is the commitment, and only a
// freeze makes it a measured one.
export function draftRow({ key, sprints = [], summary, scope = null, now = new Date() } = {}) {
  const window = sprintWindow(sprints);
  const committed = scope?.basis === "freeze" ? round1(scope.original) : null;
  return {
    key: String(key),
    sprintIds: sprints.map((s) => s?.id).filter((id) => id !== undefined).map(String),
    name: sprintNames(sprints).join(" + "),
    start: window.start ? isoDay(window.start) : null,
    end: window.end ? isoDay(window.end) : null,
    lastReading: isoDay(now),
    final: false,
    issues: Number(summary?.issueCount) || 0,
    issuesClosed: Number(summary?.doneIssues) || 0,
    pointsCommitted: committed,
    pointsTotal: round1(summary?.totalPoints),
    pointsCompleted: round1(summary?.donePoints),
    github: null,
    partial: { jira: committed === null, github: false },
  };
}

// A row for a sprint that closed before this store existed, from what the
// device still holds: its last daily snapshot, and its freeze.
export function seedRow({ key, snapshots = [], freeze = null } = {}) {
  const days = (Array.isArray(snapshots) ? snapshots : []).filter((d) => d?.date);
  if (!days.length) return null;
  const last = days[days.length - 1];
  const committed = freeze?.rows ? round1(freeze.totalPoints) : null;
  return {
    key: String(key),
    sprintIds: Array.isArray(freeze?.sprintIds) ? freeze.sprintIds.map(String) : String(key).split("+"),
    name: Array.isArray(freeze?.sprintNames) ? freeze.sprintNames.join(" + ") : "",
    start: freeze?.windowStart || days[0].date,
    end: freeze?.windowEnd || last.date,
    lastReading: last.date,
    final: false,
    issues: Number(last.issueCount) || 0,
    issuesClosed: Number(last.doneIssues) || 0,
    pointsCommitted: committed,
    pointsTotal: round1(last.totalPoints),
    pointsCompleted: round1(last.donePoints),
    github: null,
    partial: { jira: committed === null, github: false },
  };
}

// The team's GitHub figures over a sprint's dates: every roster login, summed.
// Null when there is nothing to count from.
export function githubFigures(stats, logins = [], { since, until } = {}) {
  if (!stats || !logins.length) return null;
  const totals = { prsOpened: 0, prsMerged: 0, prsReviewed: 0, additions: 0, deletions: 0 };
  let clamped = false;
  for (const login of logins) {
    const s = statsFor(stats, login, { since, until });
    if (!s) continue;
    totals.prsOpened += s.prsOpened;
    totals.prsMerged += s.prsMerged;
    totals.prsReviewed += s.reviews;
    totals.additions += s.additions;
    totals.deletions += s.deletions;
    clamped = clamped || s.clamped;
  }
  const truncated = (stats.truncated || []).length > 0 || (stats.failures || []).length > 0;
  return { ...totals, partial: clamped || truncated };
}

// The row as it is stored for good. The last reading counts as the end of the
// sprint if it was taken on its last day or after; earlier, the figures are a
// floor and the row says so.
export function finalRow(row, github = null) {
  const endedOn = row.end || row.lastReading;
  const late = Boolean(row.lastReading && endedOn) && Date.parse(row.lastReading) + DAY_MS <= Date.parse(endedOn);
  const figures = github ? { ...github } : null;
  if (figures) delete figures.partial;
  return {
    ...row,
    final: true,
    github: figures,
    partial: {
      jira: Boolean(row.partial?.jira) || late,
      github: Boolean(github?.partial),
    },
  };
}

// Completion as a share of the commitment, when there was one to measure
// against; otherwise of the sprint's points at its last reading.
export function completionRate(row) {
  const base = row?.pointsCommitted ?? row?.pointsTotal;
  return base > 0 ? row.pointsCompleted / base : null;
}

// ── The store ───────────────────────────────────────────────────────────────

// `clearedOn` is the day Settings last emptied the store. Seeding skips any
// sprint whose last snapshot is from before it, or a delete would quietly undo
// itself on the next dashboard load.
export function normalizeSprintHistory(raw) {
  const rows = raw && typeof raw === "object" && raw.rows && typeof raw.rows === "object" ? raw.rows : {};
  const clean = {};
  for (const [key, row] of Object.entries(rows)) {
    if (row && typeof row === "object" && row.key === key) clean[key] = row;
  }
  const clearedOn = typeof raw?.clearedOn === "string" ? raw.clearedOn : null;
  return { rows: clean, clearedOn };
}

// Oldest first, by start date, then by key so two boards' sprints that started
// on the same day keep a stable order.
export function sprintHistoryRows(store) {
  return Object.values(normalizeSprintHistory(store).rows).sort(
    (a, b) => String(a.start || "").localeCompare(String(b.start || "")) || a.key.localeCompare(b.key)
  );
}

function prune(rows) {
  const ordered = Object.values(rows).sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")));
  const kept = {};
  for (const row of ordered.slice(0, MAX_HISTORY_ROWS)) kept[row.key] = row;
  return kept;
}

// What a load should write, without writing: the draft for the running sprint,
// seed rows for stored sprints this store has never seen, and the list of
// unfinished rows that are not the running sprint — the ones rollover closes.
//
// A final row is never overwritten, by a draft or a seed. A sprint seen
// running again after it was finalised is a sprint reopened in Jira, and the
// row it ended with is still the honest one.
export function planUpdate(store, { liveKey = "", draft = null, snapshots = {}, freezes = {} } = {}) {
  const { rows: stored, clearedOn } = normalizeSprintHistory(store);
  const rows = { ...stored };
  if (draft && liveKey && liveKey !== "no-sprint" && !rows[liveKey]?.final) rows[liveKey] = draft;
  for (const [key, days] of Object.entries(snapshots || {})) {
    if (key === liveKey || key === "no-sprint" || rows[key]) continue;
    const seeded = seedRow({ key, snapshots: days, freeze: freezes?.[key] || null });
    if (!seeded || (clearedOn && seeded.lastReading <= clearedOn)) continue;
    rows[key] = seeded;
  }
  const closing = Object.values(rows).filter((row) => !row.final && row.key !== liveKey);
  return { rows: prune(rows), clearedOn, closing };
}

export async function loadSprintHistory() {
  const stored = await localGet([HISTORY_KEY]);
  return normalizeSprintHistory(stored[HISTORY_KEY]);
}

export async function saveSprintHistory(store) {
  const { rows, clearedOn } = normalizeSprintHistory(store);
  await localSet({ [HISTORY_KEY]: { rows: prune(rows), clearedOn } });
}

export async function clearSprintHistory(now = new Date()) {
  await localSet({ [HISTORY_KEY]: { rows: {}, clearedOn: isoDay(now) } });
}

// A row is "closed" here once it is final; the running sprint is always the
// draft. Exported for Settings, which says how much would be deleted.
export function sprintHistorySize(store) {
  const rows = sprintHistoryRows(store);
  return {
    sprints: rows.filter((r) => r.final).length,
    first: rows.find((r) => r.final)?.start || null,
  };
}

// The span a set of closing rows covers, for one GitHub fetch rather than one
// a sprint: seeding can close several at once. `until` is the day after the
// last end, so the last day counts whole.
export function closingSpan(rows = []) {
  const starts = rows.map((r) => r.start).filter(Boolean).sort();
  const ends = rows.map((r) => r.end || r.lastReading).filter(Boolean).sort();
  if (!starts.length || !ends.length) return null;
  const [y, m, d] = ends[ends.length - 1].split("-").map(Number);
  const [sy, sm, sd] = starts[0].split("-").map(Number);
  return {
    since: new Date(sy, sm - 1, sd).toISOString(),
    until: new Date(y, m - 1, d + 1).toISOString(),
  };
}

function rowSpan(row) {
  return closingSpan([row]);
}

// The whole write, for the dashboard. `loadStats({ since, until })` returns a
// GitHub stats document covering that span, or null when sync is off; it is
// called once, only when something is closing. If it throws, the closing rows
// stay drafts and the next live load tries again, rather than sealing a row
// with no GitHub half.
export async function recordSprintHistory({
  liveKey,
  draft,
  snapshots,
  freezes,
  logins = [],
  loadStats = async () => null,
} = {}) {
  const store = await loadSprintHistory();
  const { rows, clearedOn, closing } = planUpdate(store, { liveKey, draft, snapshots, freezes });
  await saveSprintHistory({ rows, clearedOn });
  if (!closing.length) return { rows, closed: [] };

  const span = closingSpan(closing);
  let stats = null;
  try {
    stats = span ? await loadStats(span) : null;
  } catch {
    return { rows, closed: [] };
  }
  const closed = closing.map((row) => {
    const own = rowSpan(row);
    return finalRow(row, own ? githubFigures(stats, logins, own) : null);
  });

  // Re-read before the second write: another tab may have written meanwhile,
  // and its rows are as good as these.
  const latest = await loadSprintHistory();
  const merged = { ...latest.rows };
  for (const row of closed) if (!merged[row.key]?.final) merged[row.key] = row;
  await saveSprintHistory({ rows: merged, clearedOn: latest.clearedOn });
  return { rows: merged, closed };
}

// ── Reading it back ─────────────────────────────────────────────────────────

export const TREND_SPRINTS = 6;

// "Sprint 42" → "S42", a sprint's goal after a colon is dropped, and a
// two-board sprint names its first and counts the rest, so a label fits under
// a column. The tooltip carries the full name.
export function shortSprintName(name = "") {
  const parts = String(name || "").split(" + ").filter(Boolean);
  if (!parts.length) return "—";
  // "Sprint 41: Payments hardening" is "Sprint 41" under a column.
  let first = parts[0].split(":")[0].trim().replace(/^sprint\s*/i, "S");
  if (first.length > 9) first = `${first.slice(0, 8)}…`;
  return parts.length > 1 ? `${first} +${parts.length - 1}` : first;
}

// The rows a trend draws: the last `limit` closed sprints, oldest first, and —
// for the running sprint — its draft after them, flagged `running` so it is
// drawn hollow. `upTo` is a start date: viewing a closed sprint, the trend ends
// at it rather than running on to today.
export function trendRows(rows = [], { liveKey = "", upTo = null, limit = TREND_SPRINTS } = {}) {
  // An unfinished row that is not the running sprint is one this load is
  // sealing: closed, with its GitHub half still on the way.
  const closed = rows
    .filter((r) => r.key !== liveKey && (r.final || Boolean(liveKey)))
    .filter((r) => !upTo || String(r.start || "") <= upTo)
    .slice(-limit)
    .map((r) => ({ ...r, running: false }));
  const live = liveKey ? rows.find((r) => r.key === liveKey && !r.final) : null;
  return live && !upTo ? [...closed, { ...live, running: true }] : closed;
}

// Mean completed points over closed sprints whose Jira half is whole. Null
// below two, where an average is just the one figure again.
export function meanCompleted(rows = []) {
  const whole = rows.filter((r) => !r.running && !r.partial?.jira);
  if (whole.length < 2) return null;
  return round1(whole.reduce((n, r) => n + r.pointsCompleted, 0) / whole.length);
}
