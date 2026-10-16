// The planning flow (M23): the author's planning ritual as four screens, one
// board per session, from wrapping up the outgoing sprint to starting the new
// one. Everything here is pure and covered by scripts/test-planflow.mjs; the
// screens are a mode of js/views/planner.js, which the flow shares its plan
// screen with.
//
//   1. Set up         board, the new sprint (picked, or created at once), dates,
//                     buffer, people
//   2. Wrap up        the outgoing sprint's open issues: carry, split, or leave
//                     for the backlog (the default — carrying is a decision)
//   3. Plan           fill and balance, quick create, proposed due dates
//   4. Review & start the recap opens, then one confirm runs the writes, the
//                     close, the start and the freeze, in that order, stopping
//                     at the first refusal with Retry and a link to the board
//
// The sprint writes — create, complete, start — are the three new kinds of Jira
// write M23 was settled to add (2026-10-01). Nothing else here is new.

import { isDone, isSubtask } from "./monitor.js";
import { getStoryPoints, resolveStatusGroup } from "./utils.js";
import { holidaysBetween, round2 } from "./planner.js";

export const FLOW_KEY = "sprintPlanFlow";
export const FLOW_STEPS = [
  { id: "setup", label: "Set up" },
  { id: "wrapup", label: "Wrap up" },
  { id: "plan", label: "Plan" },
  { id: "start", label: "Review & start" },
];

export function stepIndex(id) {
  const i = FLOW_STEPS.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The working days of a range, in order: weekdays not taken off as a holiday.
export function workingDayList(start, end, { calendar = "none", overrides = {} } = {}) {
  const from = parseDay(start);
  const to = parseDay(end);
  if (!from || !to || to < from) return [];
  const off = new Set(holidaysBetween(start, end, { calendar, overrides }).filter((h) => h.off).map((h) => h.date));
  const out = [];
  const cursor = new Date(from);
  for (let i = 0; cursor <= to && i < 800; i++) {
    const day = cursor.getDay();
    const iso = isoDay(cursor);
    if (day !== 0 && day !== 6 && !off.has(iso)) out.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// Working days elapsed from `since` up to and including `until`'s day, weekends
// out. Holidays are not looked up here: this measures how long something has
// been under way, where a lost day off is noise next to the estimate.
export function workingDaysElapsed(since, until) {
  const from = parseDay(String(since || "").slice(0, 10));
  const to = parseDay(String(until || "").slice(0, 10));
  if (!from || !to || to < from) return 0;
  let n = 0;
  const cursor = new Date(from);
  for (let i = 0; cursor <= to && i < 800; i++) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) n++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

// What Jira's sprint start wants: an instant, so the planning dates become the
// working day's start and end in local time.
export function sprintInstants(start, end) {
  const s = parseDay(start);
  const e = parseDay(end);
  if (!s || !e) return null;
  s.setHours(9, 0, 0, 0);
  e.setHours(17, 0, 0, 0);
  return { startDate: s.toISOString(), endDate: e.toISOString() };
}

// "ACME Sprint 42" → "ACME Sprint 43"; anything without a trailing number gets
// one. A suggestion for the create form, never written without being shown.
export function nextSprintName(previous, boardName = "") {
  const name = String(previous || "").trim();
  const m = /^(.*?)(\d+)(\D*)$/.exec(name);
  if (m) return `${m[1]}${Number(m[2]) + 1}${m[3]}`.trim();
  return name ? `${name} 2` : `${boardName || "Sprint"} 1`.trim();
}

// ── Wrap up ─────────────────────────────────────────────────────────────────

// The outgoing sprint's issues that still need a decision: open, not a
// sub-task (it goes wherever its parent goes).
export function wrapUpIssues(issues = []) {
  return issues.filter((i) => i?.key && !isDone(i) && !isSubtask(i));
}

// When the issue went under way: the first status change out of the first
// column (To Do, in the user's own grouping), else null.
export function startedAt(issue, statusGroups = []) {
  const firstGroup = statusGroups[0]?.name || "To Do";
  const events = (issue?.history?.events || [])
    .filter((e) => e.kind === "status" && e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const moved = events.find(
    (e) => resolveStatusGroup(e.from, statusGroups) === firstGroup && resolveStatusGroup(e.to, statusGroups) !== firstGroup
  );
  return moved ? moved.at : null;
}

// Part one's points, proposed from the time already spent (settled
// 2026-10-01): working days under way inside the outgoing sprint, at the
// planner's points per day, capped at the estimate. Half each when there is no
// history to go on — the person planning can always override it.
export function proposeSplitPoints(issue, { sprintStart = "", now = new Date(), pointsPerDay = 1, statusGroups = [] } = {}) {
  const total = getStoryPoints(issue);
  if (!(Number(total) > 0)) return { first: null, second: null, basis: "unestimated" };
  const quarter = (n) => Math.round(n * 4) / 4;
  const began = startedAt(issue, statusGroups);
  if (!began) {
    const half = quarter(total / 2);
    return { first: half, second: round2(total - half), basis: "half" };
  }
  const from = sprintStart && String(began) < String(sprintStart) ? sprintStart : began;
  const days = workingDaysElapsed(from, now.toISOString());
  const done = Math.min(total, quarter(days * (Number(pointsPerDay) > 0 ? pointsPerDay : 1)));
  // Time has outrun the estimate: part one keeps all of it, and part two needs
  // an estimate of its own rather than a zero nobody chose.
  if (done >= total) return { first: round2(total), second: null, basis: "time", days, overrun: true };
  return { first: round2(done), second: round2(total - done), basis: "time", days };
}

// ── Due dates ───────────────────────────────────────────────────────────────

// Each person's planned issues, oldest first (settled 2026-10-01), laid end to
// end over the sprint's working days: an issue is due on the working day its
// cumulative points run out. Unestimated issues get no date. Work past the
// sprint's end is dated on its last day and flagged, rather than dated into the
// next sprint.
export function proposeDueDates({ issues = [], assigneeOf = (i) => i?.fields?.assignee?.accountId || null, pointsOf = getStoryPoints, start, end, calendar = "none", holidays = {}, pointsPerDay = 1 } = {}) {
  const days = workingDayList(start, end, { calendar, overrides: holidays });
  const out = new Map();
  if (!days.length) return out;
  const ppd = Number(pointsPerDay) > 0 ? Number(pointsPerDay) : 1;
  const byPerson = new Map();
  for (const issue of issues) {
    const who = assigneeOf(issue);
    if (!who) continue;
    if (!byPerson.has(who)) byPerson.set(who, []);
    byPerson.get(who).push(issue);
  }
  for (const list of byPerson.values()) {
    list.sort((a, b) => String(a.fields?.created || "").localeCompare(String(b.fields?.created || "")) || String(a.key).localeCompare(String(b.key)));
    let used = 0;
    for (const issue of list) {
      const p = Number(pointsOf(issue));
      if (!(p > 0)) continue;
      used += p / ppd;
      const index = Math.max(0, Math.ceil(used - 1e-9) - 1);
      const over = index >= days.length;
      out.set(issue.key, { due: days[Math.min(index, days.length - 1)], over });
    }
  }
  return out;
}

// ── Review & start ──────────────────────────────────────────────────────────

// The steps the last screen runs, in order, each with whether it applies.
// `done` is the run state saved in the draft, so a reload or a Retry picks up
// at the first step not yet done rather than repeating writes.
export function runSteps({ hasWrites = false, outgoingSprintId = "", targetSprintId = "", targetState = "future", done = {} } = {}) {
  return [
    { id: "push", label: "Write the plan: field changes and moves into the new sprint", applies: hasWrites },
    { id: "close", label: "Complete the outgoing sprint (open issues not carried go to the backlog)", applies: Boolean(outgoingSprintId) },
    { id: "start", label: "Start the new sprint", applies: Boolean(targetSprintId) && targetState !== "active" },
    { id: "freeze", label: "Take the scope snapshot (the sprint freeze)", applies: Boolean(targetSprintId) },
  ].map((s) => ({ ...s, done: done[s.id] === true }));
}

// Runs the steps that apply and are not done, in order, stopping at the first
// failure. `run` is { push, close, start, freeze } → async functions. Returns
// the step states and the failure, if any, with Jira's sentence.
export async function executeRun(steps, run) {
  const states = steps.map((s) => ({ ...s }));
  for (const step of states) {
    if (!step.applies || step.done) continue;
    try {
      const result = await run[step.id]();
      if (result && result.ok === false) {
        step.error = result.message || "failed";
        return { states, failed: step };
      }
      step.done = true;
    } catch (err) {
      step.error = String(err?.message || err);
      return { states, failed: step };
    }
  }
  return { states, failed: null };
}
