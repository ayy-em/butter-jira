// The sprint planner (M15): everything it decides that does not need a DOM.
//
// A plan is prepared by one person ahead of the planning meeting and reviewed in
// it (settled 2026-09-30), so it is a **draft that lives on the device** and is
// written to Jira only at the end, in one reviewed batch. Nothing here writes;
// `executePush` runs the writes a caller hands it, so the whole push is testable
// with the transport stubbed.
//
// The rules the author settled, and where each lives:
//
//   - Capacity is in story points, one point being one working day. A person's
//     budget defaults to the sprint's working days, overridden per person for
//     leave and holidays, minus a buffer the team sets as a percentage or as
//     points per person, itself overridable per person — `personCapacity`.
//     Velocity is a post-mortem number and plays no part in it.
//   - Nothing enters the plan unassigned or unestimated — `canCommit`. An issue
//     already in the target sprint that breaks the rule blocks the push until it
//     is fixed or taken out — `buildPushPlan`.
//   - Candidates are the selected sprints' open leftovers first, then the
//     boards' backlogs, ordered by status: work under way, then to do, then on
//     hold — `candidateRank`.
//   - The push is re-checked against Jira first, since a draft can be a day old,
//     and a write that fails is retried on its own up to three times before it
//     is reported by name — `executePush`.
//   - Sprints are created, started and closed in Jira, not here. Order within
//     the sprint is not written.

import { localGet, localSet, localRemove } from "./browser.js";
import { getEpicKey, getStoryPoints, isOverdue } from "./utils.js";
import { isDone, isEpic, isSubtask } from "./monitor.js";

export const PLANNER_KEY = "sprintPlanner";
export const DRAFT_VERSION = 1;
export const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [600, 1200, 2400];

// ── Numbers ─────────────────────────────────────────────────────────────────

// Points are days, so quarters are real values: a half-day spike is 0.5. Two
// decimals is enough to hold any of them without 0.1 + 0.2 printing as noise.
export function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// "8", "7.5", "0.25" — never "8.00".
export function fmtPoints(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "–";
  return String(round2(n));
}

// A typed estimate, or null for "not a number". Accepts a comma, which is how
// half the people using this type a decimal.
export function parsePoints(input) {
  const raw = String(input ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

// ── Dates and working days ──────────────────────────────────────────────────

function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").slice(0, 10));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Monday to Friday, both ends included. Public holidays are not known here —
// they come off a person's days, or the whole figure, by hand (a Dutch calendar
// is M21 scope).
export function workingDaysBetween(start, end) {
  const from = parseDay(start);
  const to = parseDay(end);
  if (!from || !to || to < from) return 0;
  let count = 0;
  const cursor = new Date(from);
  // Bounded, so a typo'd year cannot spin the tab.
  for (let i = 0; cursor <= to && i < 800; i++) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// ── Public holidays ─────────────────────────────────────────────────────────
//
// Computed rather than tabled, so no year runs out (M21). One calendar so far,
// the Netherlands, chosen in Settings → Sprint planner; "none" turns it off.
// `dayOff` is whether the day is taken off by default: Good Friday is not a
// day off for most, and Liberation Day only every fifth year (2025, 2030…).
// Either can be ticked or unticked per draft. Sundays are left out — Easter
// Sunday and Whit Sunday are never working days anyway.

export const HOLIDAY_CALENDARS = ["nl", "none"];

// Gregorian Easter Sunday (the anonymous algorithm).
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

export function dutchHolidays(year) {
  const easter = easterSunday(year);
  const offset = (n) => {
    const d = new Date(easter);
    d.setDate(d.getDate() + n);
    return isoDay(d);
  };
  const pad = (n) => String(n).padStart(2, "0");
  const fixed = (m, d) => `${year}-${pad(m)}-${pad(d)}`;
  // King's Day moves to the 26th when the 27th is a Sunday.
  const kings = new Date(year, 3, 27).getDay() === 0 ? fixed(4, 26) : fixed(4, 27);
  return [
    { date: fixed(1, 1), name: "New Year's Day", dayOff: true },
    { date: offset(-2), name: "Good Friday", dayOff: false },
    { date: offset(1), name: "Easter Monday", dayOff: true },
    { date: kings, name: "King's Day", dayOff: true },
    { date: fixed(5, 5), name: "Liberation Day", dayOff: year % 5 === 0 },
    { date: offset(39), name: "Ascension Day", dayOff: true },
    { date: offset(50), name: "Whit Monday", dayOff: true },
    { date: fixed(12, 25), name: "Christmas Day", dayOff: true },
    { date: fixed(12, 26), name: "Boxing Day", dayOff: true },
  ];
}

// The calendar's holidays that fall on a weekday inside the range, with
// whether each is taken off: the draft's choice where it made one, else the
// calendar's default.
export function holidaysBetween(start, end, { calendar = "nl", overrides = {} } = {}) {
  const from = parseDay(start);
  const to = parseDay(end);
  if (calendar !== "nl" || !from || !to || to < from) return [];
  const out = [];
  for (let y = from.getFullYear(); y <= to.getFullYear() && y - from.getFullYear() < 3; y++) {
    for (const h of dutchHolidays(y)) {
      const day = parseDay(h.date);
      if (day < from || day > to) continue;
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      const off = Object.prototype.hasOwnProperty.call(overrides, h.date) ? overrides[h.date] === true : h.dayOff;
      out.push({ ...h, off });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Weekdays in the draft's range less the holidays taken off — what Working
// days suggests when it is not set by hand.
export function suggestedWorkingDays(draft, { calendar = "nl" } = {}) {
  const weekdays = workingDaysBetween(draft.start, draft.end);
  const off = holidaysBetween(draft.start, draft.end, { calendar, overrides: draft.holidays || {} }).filter((h) => h.off).length;
  return Math.max(0, weekdays - off);
}

// The date range a Jira sprint stands for, as two local calendar days.
//
// Jira's default sprint runs from a start instant to the same weekday one or
// two weeks later, at the same time of day — Monday 10:00 to Monday 10:00. Read
// inclusively that is eleven working days in a ten-day sprint, because the last
// day is the next sprint's first. So when the end falls on the start's weekday
// the end day is dropped. A sprint set to end on a Friday evening is counted as
// written.
export function sprintDateRange(sprint) {
  const startMs = Date.parse(sprint?.startDate || "");
  const endMs = Date.parse(sprint?.endDate || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (end.getDay() === start.getDay() && endMs - startMs >= 6 * 86400000) {
    end.setDate(end.getDate() - 1);
  }
  return { start: isoDay(start), end: isoDay(end) };
}

// Used when no target sprint carries dates: the coming Monday for two weeks.
export function defaultDateRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const toMonday = (8 - start.getDay()) % 7 || 7;
  start.setDate(start.getDate() + toMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 11);
  return { start: isoDay(start), end: isoDay(end) };
}

// ── Capacity ────────────────────────────────────────────────────────────────

export const BUFFER_MODES = ["percent", "points"];

// A person's budget for the sprint. `days` and `buffer` are that person's
// overrides, null when they take the team's figure.
//
// e.g. ten working days and a 20% team buffer: 10 − 2 = 8 points each. With the
// buffer as 1.5 points a person instead: 10 − 1.5 = 8.5. A person on leave for
// three days overrides `days` to 7, and keeps the team buffer unless that is
// overridden too.
//
// `pointsPerDay` comes from Settings → Sprint planner (hours per story point,
// against an eight-hour day): 1 by default, 2 on a site where a point is half a
// day. Days stay days on screen; only points are scaled.
export function personCapacity({ workingDays = 0, days = null, buffer = { mode: "percent", value: 0 }, bufferOverride = null, pointsPerDay = 1 } = {}) {
  const dayCount = Math.max(0, Number(days ?? workingDays ?? 0) || 0);
  const base = round2(dayCount * (Number(pointsPerDay) > 0 ? Number(pointsPerDay) : 1));
  const value = Math.max(0, Number(bufferOverride ?? buffer?.value ?? 0) || 0);
  const held = buffer?.mode === "points" ? value : (base * value) / 100;
  const bufferPoints = round2(Math.min(base, held));
  return { days: round2(dayCount), base, buffer: bufferPoints, available: round2(base - bufferPoints) };
}

export const HOURS_PER_DAY = 8;
export const DEFAULT_HOURS_PER_POINT = 8;

// Hours per story point → points per working day. Anything unusable falls back
// to the default rather than to zero capacity.
export function pointsPerDayFor(hoursPerPoint) {
  const h = Number(hoursPerPoint);
  return h > 0 && h <= 80 ? round2(HOURS_PER_DAY / h) : 1;
}

// Utilisation as a share of capacity, and the band it falls in. Warnings at
// 100% and 120%, as the milestone always said. No capacity and nothing assigned
// is "none", not 0% or a division by zero.
export function loadBand(assigned, available) {
  const a = round2(assigned);
  const cap = round2(available);
  if (cap <= 0) return { ratio: a > 0 ? Infinity : 0, band: a > 0 ? "over" : "none" };
  const ratio = a / cap;
  if (ratio > 1.2) return { ratio, band: "over" };
  if (ratio > 1) return { ratio, band: "full" };
  return { ratio, band: "ok" };
}

// ── The draft ───────────────────────────────────────────────────────────────
//
// {
//   v, stage: "config" | "plan", updatedAt,
//   boards:  [{ id, target, sources: [sprintId] }]  — target is one sprint id
//   start, end, workingDays (null = computed from the dates),
//   buffer:  { mode: "percent" | "points", value },
//   people:  [{ accountId, name, days, buffer }]    — overrides, null = team's
//   added:   { [key]: sprintId }   moves into a target sprint
//   removed: [key]                 in a target sprint now, taken out
//   edits:   { [key]: { assignee?, points? } }       field changes to write
//   baseline:{ [key]: { assignee, points } }         Jira's values when first
//                                                    edited, to spot a change
//                                                    made in Jira meanwhile
//   extraKeys: [key]               issues from other boards, added by key
// }
//
// Ids are strings throughout: sprint and board ids arrive as numbers from Jira
// and as strings from a <select>, and comparing the two is how a plan ends up
// moving an issue into the sprint it is already in.

const str = (v) => (v === null || v === undefined ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
};
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export function emptyDraft(now = new Date()) {
  return {
    v: DRAFT_VERSION,
    stage: "config",
    updatedAt: now.toISOString(),
    boards: [],
    start: "",
    end: "",
    workingDays: null,
    holidays: {},
    // 20% held back unless set otherwise (settled 2026-10-01). Only a new
    // draft gets it; a stored one keeps what it was given.
    buffer: { mode: "percent", value: 20 },
    people: [],
    added: {},
    removed: [],
    edits: {},
    baseline: {},
    extraKeys: [],
  };
}

export function normalizeDraft(raw, now = new Date()) {
  const d = emptyDraft(now);
  if (!isObj(raw)) return d;
  d.stage = raw.stage === "plan" ? "plan" : "config";
  d.updatedAt = str(raw.updatedAt) || d.updatedAt;
  const seenBoards = new Set();
  d.boards = (Array.isArray(raw.boards) ? raw.boards : [])
    .filter(isObj)
    .map((b) => ({
      id: str(b.id),
      target: str(b.target),
      sources: [...new Set((Array.isArray(b.sources) ? b.sources : []).map(str).filter(Boolean))],
    }))
    .filter((b) => b.id && !seenBoards.has(b.id) && seenBoards.add(b.id));
  d.start = parseDay(raw.start) ? String(raw.start).slice(0, 10) : "";
  d.end = parseDay(raw.end) ? String(raw.end).slice(0, 10) : "";
  d.workingDays = numOrNull(raw.workingDays);
  for (const [date, off] of Object.entries(isObj(raw.holidays) ? raw.holidays : {})) {
    if (parseDay(date) && typeof off === "boolean") d.holidays[date] = off;
  }
  d.buffer = {
    mode: BUFFER_MODES.includes(raw.buffer?.mode) ? raw.buffer.mode : "percent",
    value: numOrNull(raw.buffer?.value) ?? (isObj(raw.buffer) ? 0 : d.buffer.value),
  };
  const seenPeople = new Set();
  d.people = (Array.isArray(raw.people) ? raw.people : [])
    .filter(isObj)
    .map((p) => ({
      accountId: str(p.accountId),
      name: str(p.name).slice(0, 120),
      days: numOrNull(p.days),
      buffer: numOrNull(p.buffer),
    }))
    .filter((p) => p.accountId && !seenPeople.has(p.accountId) && seenPeople.add(p.accountId));
  for (const [key, sprintId] of Object.entries(isObj(raw.added) ? raw.added : {})) {
    if (KEY_RE.test(key) && str(sprintId)) d.added[key] = str(sprintId);
  }
  d.removed = [...new Set((Array.isArray(raw.removed) ? raw.removed : []).map(str).filter((k) => KEY_RE.test(k)))];
  for (const [key, edit] of Object.entries(isObj(raw.edits) ? raw.edits : {})) {
    if (!KEY_RE.test(key) || !isObj(edit)) continue;
    const out = {};
    if ("assignee" in edit) out.assignee = str(edit.assignee) || null;
    if ("points" in edit) out.points = numOrNull(edit.points);
    if (Object.keys(out).length) d.edits[key] = out;
  }
  for (const [key, base] of Object.entries(isObj(raw.baseline) ? raw.baseline : {})) {
    if (!KEY_RE.test(key) || !isObj(base)) continue;
    d.baseline[key] = { assignee: str(base.assignee) || null, points: numOrNull(base.points) };
  }
  d.extraKeys = [...new Set((Array.isArray(raw.extraKeys) ? raw.extraKeys : []).map(str).filter((k) => KEY_RE.test(k)))];
  return d;
}

export async function loadDraft(now = new Date()) {
  const stored = await localGet([PLANNER_KEY]);
  return normalizeDraft(stored[PLANNER_KEY], now);
}

export async function saveDraft(draft, now = new Date()) {
  const next = normalizeDraft({ ...draft, updatedAt: now.toISOString() }, now);
  await localSet({ [PLANNER_KEY]: next });
  return next;
}

export async function clearDraft() {
  await localRemove([PLANNER_KEY]);
}

// The sprint an issue joins when it is added: its own board's target, else the
// first board's. An issue added by key from a board not being planned has no
// target of its own, and the first one is as good a guess as any — the plan
// row lets it be changed.
//
// A leftover picked under a board — including one from another board's sprint
// (cross-board carryover) — carries `planBoardId`, and goes to that board's
// target before anything else.
export function targetFor(draft, issue) {
  const picked = issue?.planBoardId && draft.boards.find((b) => b.target && b.id === str(issue.planBoardId));
  if (picked) return picked.target;
  const boardIds = (issue?.boardIds?.length ? issue.boardIds : [issue?.boardId]).map(str);
  const own = draft.boards.find((b) => b.target && boardIds.includes(b.id));
  return own?.target || draft.boards.find((b) => b.target)?.target || "";
}

// A carryover source is a sprint id on the planned board itself, or
// "boardId:sprintId" for another board's sprint.
export function sourceRef(boardId, sprintId, ownBoardId) {
  return str(boardId) === str(ownBoardId) ? str(sprintId) : `${str(boardId)}:${str(sprintId)}`;
}

export function parseSourceRef(ref, ownBoardId) {
  const m = /^([^:]+):(.+)$/.exec(str(ref));
  return m ? { boardId: m[1], sprintId: m[2] } : { boardId: str(ownBoardId), sprintId: str(ref) };
}

export function targetSprintIds(draft) {
  return [...new Set(draft.boards.map((b) => b.target).filter(Boolean))];
}

// ── Reading an issue through the draft ──────────────────────────────────────

export function jiraAssignee(issue) {
  return str(issue?.fields?.assignee?.accountId) || null;
}

// What the plan says an issue's assignee and estimate are: the draft's edit
// where there is one, Jira's value otherwise.
export function effective(draft, issue) {
  const edit = draft.edits[issue?.key] || {};
  return {
    assignee: "assignee" in edit ? edit.assignee : jiraAssignee(issue),
    points: "points" in edit ? edit.points : getStoryPoints(issue),
  };
}

// The rule an issue has to meet to be in the plan. Returns what is missing, so
// the popup can ask for exactly that.
export function missingForCommit(draft, issue) {
  const { assignee, points } = effective(draft, issue);
  const missing = [];
  if (!assignee) missing.push("assignee");
  if (!(Number(points) > 0)) missing.push("points");
  return missing;
}

export function canCommit(draft, issue) {
  return missingForCommit(draft, issue).length === 0;
}

// Records an edit, keeping Jira's value from the first time it was touched. An
// edit back to Jira's own value is dropped rather than kept as a no-op write.
export function setEdit(draft, issue, changes) {
  const key = issue.key;
  if (!draft.baseline[key]) {
    draft.baseline[key] = { assignee: jiraAssignee(issue), points: getStoryPoints(issue) };
  }
  const edit = { ...(draft.edits[key] || {}) };
  if ("assignee" in changes) edit.assignee = changes.assignee || null;
  if ("points" in changes) edit.points = changes.points === null ? null : round2(changes.points);
  if ("assignee" in edit && edit.assignee === jiraAssignee(issue)) delete edit.assignee;
  if ("points" in edit && edit.points === getStoryPoints(issue)) delete edit.points;
  if (Object.keys(edit).length) draft.edits[key] = edit;
  else {
    delete draft.edits[key];
    delete draft.baseline[key];
  }
  return draft;
}

// Whether an issue is in the plan: moved in by the draft, or already in a
// target sprint and not taken out.
export function isPlanned(draft, issue, inTargetKeys) {
  if (!issue?.key) return false;
  if (draft.added[issue.key]) return true;
  return inTargetKeys.has(issue.key) && !draft.removed.includes(issue.key);
}

export function addToPlan(draft, issue, inTargetKeys, sprintId = "") {
  const key = issue.key;
  draft.removed = draft.removed.filter((k) => k !== key);
  if (!inTargetKeys.has(key)) draft.added[key] = str(sprintId) || targetFor(draft, issue);
  return draft;
}

export function removeFromPlan(draft, issue, inTargetKeys) {
  const key = issue.key;
  delete draft.added[key];
  if (inTargetKeys.has(key) && !draft.removed.includes(key)) draft.removed.push(key);
  return draft;
}

// ── Candidates ──────────────────────────────────────────────────────────────

// Statuses that mean parked. Not a status category — Jira has no category for
// it, and a site's "On Hold" is usually filed under In Progress.
const ON_HOLD_RE = /\b(on[\s-]?hold|hold|blocked|paused|parked|waiting|deferred)\b/i;

export function isOnHold(issue) {
  return ON_HOLD_RE.test(issue?.fields?.status?.name || "");
}

// 0 under way (in progress, in review), 1 to do, 2 on hold.
export function candidateRank(issue) {
  if (isOnHold(issue)) return 2;
  const category = issue?.fields?.status?.statusCategory?.key;
  return category === "indeterminate" ? 0 : 1;
}

// Something a sprint can take: open, not an epic, not a sub-task (a sub-task
// moves with its parent and cannot be put in a sprint on its own).
export function isPlannable(issue) {
  return Boolean(issue?.key) && !isDone(issue) && !isEpic(issue) && !isSubtask(issue);
}

// Stable on rank, so within a rank the board's own order — backlog rank — holds.
export function sortCandidates(issues) {
  return issues
    .map((issue, i) => ({ issue, i, r: candidateRank(issue) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.issue);
}

// The two lists the planner offers, deduplicated across each other: an issue
// left over from the current sprint is carryover, never also backlog.
// `planned` issues (already in a target sprint, or added) are excluded from
// both, since they are shown in the plan instead.
export function splitCandidates({ carryover = [], backlog = [], extra = [], isInPlan = () => false }) {
  const seen = new Set();
  const take = (list) =>
    list.filter((issue) => {
      if (!isPlannable(issue) || seen.has(issue.key)) return false;
      seen.add(issue.key);
      return !isInPlan(issue);
    });
  const carry = sortCandidates(take(carryover));
  const extraOut = take(extra);
  const rest = sortCandidates(take(backlog));
  return { carryover: carry, backlog: [...extraOut, ...rest] };
}

export function filterCandidates(issues, { epic = "", label = "", priority = "", text = "" } = {}) {
  const needle = String(text || "").trim().toLowerCase();
  return issues.filter((issue) => {
    const f = issue.fields || {};
    if (epic === "__none__" ? getEpicKey(issue) : epic && getEpicKey(issue) !== epic) return false;
    if (label && !(f.labels || []).includes(label)) return false;
    if (priority && (f.priority?.name || "") !== priority) return false;
    if (needle && !`${issue.key} ${f.summary || ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// The filter menus' options, from what is actually on screen.
export function filterOptions(issues) {
  const labels = new Set();
  const priorities = new Set();
  const epics = new Set();
  for (const issue of issues) {
    for (const l of issue.fields?.labels || []) labels.add(l);
    if (issue.fields?.priority?.name) priorities.add(issue.fields.priority.name);
    const e = getEpicKey(issue);
    if (e) epics.add(e);
  }
  return {
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
    priorities: [...priorities],
    epics: [...epics].sort(),
  };
}

// Each epic's open work across everything the planner has loaded — the
// selected sprints, the backlogs and the plan — so choosing work can be steered
// by what an epic still needs. Labelled as "on these boards" where it is shown:
// an epic's issues on a board not being planned are not in it.
export function epicRemaining(issues) {
  const out = new Map();
  const seen = new Set();
  for (const issue of issues) {
    if (!issue?.key || seen.has(issue.key)) continue;
    seen.add(issue.key);
    if (isDone(issue) || isEpic(issue) || isSubtask(issue)) continue;
    const epic = getEpicKey(issue);
    if (!epic) continue;
    const row = out.get(epic) || { open: 0, points: 0, unestimated: 0 };
    row.open++;
    const p = getStoryPoints(issue);
    if (p === null) row.unestimated++;
    else row.points = round2(row.points + p);
    out.set(epic, row);
  }
  return out;
}

// "ACME-12", "acme-12", a /browse/ link, a board link with ?selectedIssue=.
export function parseIssueRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const selected = /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(raw);
  if (selected) return selected[1].toUpperCase();
  const browse = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(raw);
  if (browse) return browse[1].toUpperCase();
  const bare = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(raw);
  return bare ? bare[1].toUpperCase() : "";
}

// ── Per-person tallies ──────────────────────────────────────────────────────

// Points and issue counts per assignee over the planned issues. Issue count is
// shown beside points and never feeds capacity. Anyone planned who is not one
// of the plan's people is collected under `others`, so the team total still
// adds up.
export function tallies(draft, plannedIssues) {
  const people = new Map(draft.people.map((p) => [p.accountId, { points: 0, issues: 0, missing: 0 }]));
  const others = { points: 0, issues: 0, missing: 0 };
  let points = 0;
  for (const issue of plannedIssues) {
    const eff = effective(draft, issue);
    const row = (eff.assignee && people.get(eff.assignee)) || others;
    row.issues++;
    if (Number(eff.points) > 0) {
      row.points = round2(row.points + Number(eff.points));
      points = round2(points + Number(eff.points));
    } else {
      row.missing++;
    }
  }
  return { people, others, points, issues: plannedIssues.length };
}

export function teamCapacity(draft, { pointsPerDay = 1, calendar = "none" } = {}) {
  const workingDays = draft.workingDays ?? suggestedWorkingDays(draft, { calendar });
  let available = 0;
  const byPerson = new Map();
  for (const p of draft.people) {
    const cap = personCapacity({ workingDays, days: p.days, buffer: draft.buffer, bufferOverride: p.buffer, pointsPerDay });
    byPerson.set(p.accountId, cap);
    available = round2(available + cap.available);
  }
  return { workingDays, pointsPerDay, available, byPerson };
}

// ── The push ────────────────────────────────────────────────────────────────

// Everything the push would write, worked out against what Jira says *now*.
//
// `issues` is key → the freshly read issue; `inTarget` is sprint id → the keys
// Jira has in that sprint now. The draft may be a day old, so each planned
// change is checked against both before it becomes a write, and anything that
// moved underneath it is said rather than silently written over or dropped.
export function buildPushPlan({ draft, issues, inTarget, sprintEnd = "", now = new Date() }) {
  const fieldWrites = [];
  const moves = new Map();
  const removals = [];
  const skipped = [];
  const conflicts = [];
  const blocked = [];
  const warnings = [];
  const get = (key) => issues.get(key) || null;
  const inAnyTarget = (key) => [...inTarget.values()].some((set) => set.has(key));

  // Field writes, wherever the issue is going.
  for (const [key, edit] of Object.entries(draft.edits)) {
    const issue = get(key);
    if (!issue) {
      conflicts.push({ key, message: "no longer found in Jira — deleted, or not visible to this account" });
      continue;
    }
    const base = draft.baseline[key] || {};
    const changes = {};
    const from = {};
    if ("assignee" in edit && edit.assignee !== jiraAssignee(issue)) {
      changes.assignee = edit.assignee;
      from.assignee = jiraAssignee(issue);
      if ("assignee" in base && base.assignee !== jiraAssignee(issue)) {
        conflicts.push({ key, message: "assignee changed in Jira since this was planned — the plan's choice will replace it" });
      }
    }
    if ("points" in edit && edit.points !== getStoryPoints(issue)) {
      changes.storyPoints = edit.points;
      from.storyPoints = getStoryPoints(issue);
      if ("points" in base && base.points !== getStoryPoints(issue)) {
        conflicts.push({ key, message: "estimate changed in Jira since this was planned — the plan's figure will replace it" });
      }
    }
    if (Object.keys(changes).length) fieldWrites.push({ key, issue, changes, from });
  }

  // Moves in.
  for (const [key, sprintId] of Object.entries(draft.added)) {
    const issue = get(key);
    if (!issue) {
      conflicts.push({ key, message: "no longer found in Jira — it will not be moved" });
      continue;
    }
    if (isDone(issue)) {
      skipped.push({ key, message: "is done in Jira now — it will not be moved" });
      continue;
    }
    if (inTarget.get(sprintId)?.has(key)) continue; // already there
    if (!moves.has(sprintId)) moves.set(sprintId, []);
    moves.get(sprintId).push(key);
  }

  // Moves out.
  for (const key of draft.removed) {
    if (!inAnyTarget(key)) continue; // already gone
    removals.push(key);
  }

  // The rule, over what the sprint will hold: nobody's work arrives without an
  // owner and an estimate. Due dates only warn.
  const today = now;
  const planned = new Set([
    ...[...inTarget.values()].flatMap((set) => [...set]).filter((k) => !draft.removed.includes(k)),
    ...Object.keys(draft.added),
  ]);
  for (const key of planned) {
    const issue = get(key);
    // A sub-task rides with its parent and is estimated through it, so it is
    // neither planned nor held to the rule on its own.
    if (!issue || isDone(issue) || isSubtask(issue)) continue;
    const missing = missingForCommit(draft, issue);
    if (missing.length) {
      blocked.push({
        key,
        message: `has no ${missing.map((m) => (m === "points" ? "estimate" : "assignee")).join(" and no ")}`,
      });
    }
    if (isOverdue(issue, today)) {
      warnings.push({ key, message: `is overdue — due ${issue.fields.duedate}` });
    } else if (sprintEnd && issue.fields?.duedate && String(issue.fields.duedate).slice(0, 10) > sprintEnd) {
      warnings.push({ key, message: `is due ${issue.fields.duedate}, after the sprint ends` });
    }
  }

  const moveList = [...moves.entries()].map(([sprintId, keys]) => ({ sprintId, keys }));
  const writeCount =
    fieldWrites.length + moveList.reduce((n, m) => n + m.keys.length, 0) + removals.length;
  return { fieldWrites, moves: moveList, removals, skipped, conflicts, blocked, warnings, writeCount };
}

function isAuthError(err) {
  return String(err?.message || err).includes("401");
}

// Runs the push. `api` is { updateFields(issue, changes), moveToSprint(sprintId,
// keys), moveToBacklog(keys) } — the real ones are the app's write layer.
//
// Field writes first, then moves: a move that fails leaves an estimated,
// assigned issue outside the sprint, which is less wrong than an issue inside
// it with nobody on it.
//
// Everything is tried once. A failed sprint batch is broken into one task per
// issue, because a batch refusal does not say which issue it was about; then
// every failure is retried on its own, up to three times with a growing pause.
// What still fails is reported by key with Jira's own sentence. A 401 stops the
// push: the router's re-auth prompt owns that, and retrying a dead token three
// times is three more refusals.
export async function executePush(plan, api, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {} } = {}) {
  const tasks = [];
  for (const w of plan.fieldWrites) {
    tasks.push({ kind: "fields", keys: [w.key], run: () => api.updateFields(w.issue, w.changes), write: w });
  }
  for (const m of plan.moves) {
    tasks.push({ kind: "move", keys: m.keys, sprintId: m.sprintId, run: () => api.moveToSprint(m.sprintId, m.keys) });
  }
  if (plan.removals.length) {
    tasks.push({ kind: "remove", keys: plan.removals, run: () => api.moveToBacklog(plan.removals) });
  }

  const done = [];
  let failed = [];
  let authStopped = false;
  const total = tasks.reduce((n, t) => n + t.keys.length, 0);
  let settled = 0;

  const attempt = async (task) => {
    try {
      await task.run();
      done.push(task);
      settled += task.keys.length;
      onProgress({ settled, total });
      return true;
    } catch (err) {
      task.error = err;
      task.tries = (task.tries || 0) + 1;
      if (isAuthError(err)) authStopped = true;
      return false;
    }
  };

  for (const task of tasks) {
    if (authStopped) {
      failed.push(task);
      continue;
    }
    if (!(await attempt(task))) failed.push(task);
  }

  // One task per issue for any batch that failed.
  const single = (task, key) => {
    const one = { ...task, keys: [key], tries: task.tries, error: task.error };
    if (task.kind === "move") one.run = () => api.moveToSprint(task.sprintId, [key]);
    if (task.kind === "remove") one.run = () => api.moveToBacklog([key]);
    return one;
  };
  failed = failed.flatMap((task) => (task.keys.length > 1 ? task.keys.map((k) => single(task, k)) : [task]));

  for (let round = 0; round < MAX_RETRIES && failed.length && !authStopped; round++) {
    await sleep(RETRY_DELAYS_MS[round] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    const next = [];
    for (const task of failed) {
      if (authStopped || !(await attempt(task))) next.push(task);
    }
    failed = next;
  }

  return {
    done: done.flatMap((t) => t.keys.map((key) => ({ key, kind: t.kind }))),
    failed: failed.map((t) => ({
      key: t.keys.join(", "),
      kind: t.kind,
      tries: t.tries || 0,
      message: String(t.error?.message || t.error || "unknown error"),
    })),
    authStopped,
  };
}

// What a successful push leaves behind in the draft: the writes that landed
// are now Jira's own values, so they stop being edits; failures stay, ready for
// another push.
export function settleDraft(draft, result) {
  const ok = new Map();
  for (const { key, kind } of result.done) {
    if (!ok.has(key)) ok.set(key, new Set());
    ok.get(key).add(kind);
  }
  for (const [key, kinds] of ok) {
    if (kinds.has("fields")) {
      delete draft.edits[key];
      delete draft.baseline[key];
    }
    if (kinds.has("move")) delete draft.added[key];
    if (kinds.has("remove")) draft.removed = draft.removed.filter((k) => k !== key);
  }
  return draft;
}

// ── Splitting an issue ──────────────────────────────────────────────────────
//
// Unfinished work carried over is often better closed and continued: the part
// that was done stays in the sprint that did it, and the rest becomes a new
// issue. Three writes, each a kind the app already makes — create the new
// issue, link it back, transition the old one to done — run straight away from
// a confirmed dialog rather than joining the batch, because the new issue has
// to exist before it can be planned.

// Both halves' names. "Rewrite importer" becomes "Rewrite importer - pt.1" and
// "Rewrite importer - pt.2"; splitting "Rewrite importer - pt.2" again leaves it
// named as it is and makes "- pt.3". A "Placeholder: " prefix from the first
// version of Split is dropped.
export function splitNames(summary) {
  let base = String(summary || "").trim().replace(/^placeholder:\s*/i, "");
  const m = /\s*-?\s*pt\.?\s*(\d+)$/i.exec(base);
  if (m) {
    const part = Number(m[1]);
    base = base.slice(0, m.index).trim();
    return { first: `${base} - pt.${part}`.slice(0, 255), second: `${base} - pt.${part + 1}`.slice(0, 255) };
  }
  return { first: `${base} - pt.1`.slice(0, 255), second: `${base} - pt.2`.slice(0, 255) };
}

export function splitSummary(summary) {
  return splitNames(summary).second;
}

// The points split: part one keeps what was done, part two gets the rest.
// Neither goes below zero; an unestimated original gives part two nothing to
// inherit.
export function splitPoints(total, first) {
  const t = Number(total);
  const f = Math.max(0, Number(first) || 0);
  if (!(t > 0)) return { first: f || null, second: null };
  return { first: round2(Math.min(f, t)), second: round2(Math.max(0, t - f)) };
}

// The comment each half gets, so either issue explains itself on its own.
export function splitComment({ other, role }) {
  return role === "first"
    ? `Split during sprint planning: the work done so far stays here and closes with this sprint. The rest continues in ${other}.`
    : `Split during sprint planning: continues ${other}, which closed with the work done so far.`;
}

// The transition that closes the issue: one landing in the done category,
// preferring a status actually named Done.
export function doneTransition(transitions = []) {
  const toDone = transitions.filter((t) => t?.to?.statusCategory?.key === "done");
  return (
    toDone.find((t) => /^done$/i.test(t.toStatus || "")) ||
    toDone.find((t) => !/reject|cancel|won'?t|duplicate|invalid/i.test(t.toStatus || "")) ||
    null
  );
}

// Part two back to the start of the workflow, for a project whose first
// status is not in the To Do category: a transition into the "new" category,
// preferring one named To Do. Null when none exists.
export function todoTransition(transitions = []) {
  const toNew = transitions.filter((t) => t?.to?.statusCategory?.key === "new");
  return toNew.find((t) => /^to\s?-?do$/i.test(t.toStatus || "")) || toNew[0] || null;
}

// "Relates" where the site has it; else anything with a phrase to read.
export function splitLinkType(types = []) {
  return (
    types.find((t) => /^relates?$/i.test(t.name || "")) ||
    types.find((t) => /relat/i.test(`${t.name} ${t.outward}`)) ||
    types[0] ||
    null
  );
}

// The create payload for part two: same project, same type, same parent where
// it has one. The parent is dropped by the caller on a retry if the site
// refuses it (company-managed projects file an epic under Epic Link instead).
export function splitCreateFields(issue, { withParent = true, withDue = true } = {}) {
  const fields = {
    project: { key: String(issue.key).split("-")[0] },
    issuetype: issue.fields?.issuetype?.id
      ? { id: String(issue.fields.issuetype.id) }
      : { name: issue.fields?.issuetype?.name || "Task" },
    summary: splitSummary(issue.fields?.summary),
  };
  const parent = issue.fields?.parent?.key;
  if (withParent && parent) fields.parent = { key: parent };
  if (withDue && issue.fields?.duedate) fields.duedate = String(issue.fields.duedate).slice(0, 10);
  return fields;
}
