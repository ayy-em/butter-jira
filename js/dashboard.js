// Sprint dashboard aggregation.
//
// Pure derivation over the sprint issues and sprint objects the other views
// already fetch, so opening this tab costs no extra Jira requests.
//
// Everything here is documented-API only. Two figures are necessarily
// approximations, and the view says so rather than implying precision:
//   - "carried in" is detected from the issue's sprint field listing a closed
//     sprint, which is reliable;
//   - "added after start" compares issue creation against the sprint start,
//     which misses an older issue dragged into the sprint mid-flight. Catching
//     that needs per-issue changelogs (one request each) — see the burndown note
//     in js/snapshots.js.

import { getStoryPoints } from "./utils.js";
import { fieldValue } from "./config.js";
import { isDone, isSubtask, runChecks, totalFindings } from "./monitor.js";
import { displayNameFor, isOnTeam } from "./team.js";

// Monday–Friday only. Sprint capacity is quoted in working days, so a burndown
// that counts weekends makes every team look behind on Monday morning.
export function workingDaysBetween(from, to) {
  const start = startOfDay(from);
  const end = startOfDay(to);
  if (!start || !end || end < start) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function startOfDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function isoDay(value) {
  const d = startOfDay(value);
  if (!d) return null;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

// Several boards can each have their own active sprint; the dashboard treats
// them as one window running from the earliest start to the latest end.
export function sprintWindow(sprints) {
  const starts = sprints.map((s) => startOfDay(s.startDate)).filter(Boolean);
  const ends = sprints.map((s) => startOfDay(s.endDate)).filter(Boolean);
  return {
    start: starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
    end: ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
  };
}

export function sprintNames(sprints) {
  return sprints.map((s) => s.name).filter(Boolean);
}

export function sprintGoals(sprints) {
  return sprints.map((s) => (s.goal || "").trim()).filter(Boolean);
}

// The sprint field carries every sprint an issue has belonged to. A closed one
// in that list means the issue did not finish last time.
export function wasCarriedIn(issue, activeSprintIds = []) {
  const value = fieldValue(issue, "sprint");
  if (!value) return false;
  const list = Array.isArray(value) ? value : [value];
  const active = new Set(activeSprintIds.map(String));

  let sawOther = false;
  for (const entry of list) {
    if (typeof entry === "string") {
      // Older Jira serialises the sprint as a blob; state=CLOSED is enough.
      if (/state=closed/i.test(entry)) return true;
      const id = /id=(\d+)/.exec(entry)?.[1];
      if (id && !active.has(id)) sawOther = true;
      continue;
    }
    if (!entry) continue;
    if (String(entry.state || "").toLowerCase() === "closed") return true;
    if (entry.id !== undefined && !active.has(String(entry.id))) sawOther = true;
  }
  return sawOther;
}

export function wasAddedAfterStart(issue, windowStart) {
  if (!windowStart) return false;
  const created = startOfDay(issue?.fields?.created);
  return Boolean(created && created > windowStart);
}

function bucketAdd(map, key, issue) {
  if (!map.has(key)) map.set(key, { key, issues: 0, points: 0, doneIssues: 0, donePoints: 0 });
  const bucket = map.get(key);
  const points = getStoryPoints(issue) ?? 0;
  bucket.issues++;
  bucket.points += points;
  if (isDone(issue)) {
    bucket.doneIssues++;
    bucket.donePoints += points;
  }
  return bucket;
}

// One pass over the sprint issues produces everything the view renders.
export function summarize({
  issues = [],
  sprints = [],
  statusGroups = [],
  monitorSettings = {},
  boards = [],
  now = new Date(),
} = {}) {
  const window = sprintWindow(sprints);
  const activeSprintIds = sprints.map((s) => s.id).filter((id) => id !== undefined);

  // Sub-tasks are excluded from the totals: their points (when they have any)
  // duplicate the parent story's, which would inflate the sprint total.
  const counted = issues.filter((issue) => !isSubtask(issue));

  let totalPoints = 0;
  let donePoints = 0;
  let doneIssues = 0;
  let unestimated = 0;
  let carriedIn = 0;
  let carriedInPoints = 0;
  let addedAfterStart = 0;
  let addedAfterStartPoints = 0;

  const byStatus = new Map();
  const byBoard = new Map();
  const byPerson = new Map();

  for (const issue of counted) {
    const points = getStoryPoints(issue);
    const value = points ?? 0;
    totalPoints += value;
    if (points === null) unestimated++;

    if (isDone(issue)) {
      doneIssues++;
      donePoints += value;
    }
    if (wasCarriedIn(issue, activeSprintIds)) {
      carriedIn++;
      carriedInPoints += value;
    }
    if (wasAddedAfterStart(issue, window.start)) {
      addedAfterStart++;
      addedAfterStartPoints += value;
    }

    // Status buckets follow the configured group order, so an unmapped status
    // still shows up rather than vanishing.
    const groupName = resolveGroup(issue, statusGroups);
    bucketAdd(byStatus, groupName, issue);
    bucketAdd(byBoard, issue.boardId ?? "?", issue);

    const assignee = issue.fields?.assignee;
    const personKey = assignee?.accountId || "__unassigned__";
    const bucket = bucketAdd(byPerson, personKey, issue);
    bucket.label = assignee ? displayNameFor(assignee) : "Unassigned";
    bucket.onTeam = assignee ? isOnTeam(assignee.accountId) : null;
  }

  // Keep the configured group order; append anything unmapped at the end.
  const statusOrder = statusGroups.map((g) => g.name);
  for (const name of byStatus.keys()) {
    if (!statusOrder.includes(name)) statusOrder.push(name);
  }
  const statusBuckets = statusOrder.map(
    (name) => byStatus.get(name) || { key: name, issues: 0, points: 0, doneIssues: 0, donePoints: 0 }
  );

  const boardBuckets = boards
    .map((board) => {
      const bucket = byBoard.get(board.id);
      return bucket
        ? { ...bucket, label: board.name, color: board.color }
        : { key: board.id, label: board.name, color: board.color, issues: 0, points: 0, doneIssues: 0, donePoints: 0 };
    })
    .filter((b) => b.issues > 0 || boards.length <= 6);

  const personBuckets = [...byPerson.values()].sort(
    (a, b) => b.points - a.points || b.issues - a.issues || a.label.localeCompare(b.label)
  );

  const checks = runChecks(counted, monitorSettings);
  const notDone = counted.length - doneIssues;
  const openPoints = totalPoints - donePoints;

  const today = startOfDay(now);
  const daysTotal = window.start && window.end ? workingDaysBetween(window.start, window.end) : 0;
  const daysRemaining =
    window.end && today
      ? today > window.end
        ? 0
        : workingDaysBetween(today, window.end)
      : 0;
  const daysElapsed = Math.max(0, daysTotal - daysRemaining);

  return {
    window,
    sprintNames: sprintNames(sprints),
    goals: sprintGoals(sprints),
    issueCount: counted.length,
    subtaskCount: issues.length - counted.length,
    totalPoints,
    donePoints,
    openPoints,
    doneIssues,
    notDone,
    unestimated,
    completionByPoints: totalPoints > 0 ? donePoints / totalPoints : null,
    completionByIssues: counted.length > 0 ? doneIssues / counted.length : null,
    carriedIn,
    carriedInPoints,
    addedAfterStart,
    addedAfterStartPoints,
    // Everything not finished when the sprint closes carries into the next one.
    projectedCarryOut: notDone,
    projectedCarryOutPoints: openPoints,
    byStatus: statusBuckets,
    byBoard: boardBuckets,
    byPerson: personBuckets,
    checks,
    hygieneFindings: totalFindings(checks),
    daysTotal,
    daysRemaining,
    daysElapsed,
    isOverdue: Boolean(window.end && today && today > window.end),
  };
}

function resolveGroup(issue, statusGroups) {
  const status = issue.fields?.status?.name || "To Do";
  for (const group of statusGroups) {
    if (group.statuses?.some((s) => s.toLowerCase() === status.toLowerCase())) return group.name;
  }
  return status;
}

// Ratio of issues with no finding against those a check could apply to.
// Deliberately coarse: it is a nudge, not a KPI to optimise.
export function hygieneScore(summary) {
  const considered = summary.checks
    .filter((c) => !c.unavailable)
    .reduce((max, c) => Math.max(max, c.considered), 0);
  if (!considered) return null;
  const flagged = new Set();
  for (const check of summary.checks) {
    for (const issue of check.issues) flagged.add(issue.key);
  }
  return 1 - flagged.size / considered;
}

export function hygieneLabel(score) {
  if (score === null) return { text: "no data", state: "unknown" };
  if (score >= 0.9) return { text: "healthy", state: "good" };
  if (score >= 0.7) return { text: "some gaps", state: "warning" };
  return { text: "needs attention", state: "critical" };
}

// ── Burndown series ──────────────────────────────────────────────────────────

// Builds the plotted series from stored daily snapshots plus the ideal line.
// Returns null when there is not yet enough history to draw an honest chart —
// one point is not a trend, and a single-point line invites false confidence.
export function buildBurndown({ snapshots = [], window, totalPoints, now = new Date() }) {
  if (!window?.start || !window?.end) return null;

  const points = snapshots
    .filter((s) => s.date && typeof s.openPoints === "number")
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) {
    return { ready: false, have: points.length, need: 2 };
  }

  const workingDays = [];
  const cursor = new Date(window.start);
  while (cursor <= window.end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) workingDays.push(isoDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (workingDays.length < 2) return { ready: false, have: points.length, need: 2 };

  // The ideal line starts from the scope as it stood on the first snapshot, so
  // it is comparable to what was actually being burned down.
  const startingScope = points[0].totalPoints ?? totalPoints;
  const ideal = workingDays.map((date, i) => ({
    date,
    points: startingScope * (1 - i / (workingDays.length - 1)),
  }));

  const actual = points
    .filter((s) => workingDays.includes(s.date))
    .map((s) => ({ date: s.date, points: s.openPoints, totalPoints: s.totalPoints }));

  const todayIso = isoDay(now);
  const idealToday = ideal.find((p) => p.date === todayIso);
  const latest = actual[actual.length - 1];
  const delta = idealToday && latest ? latest.points - idealToday.points : null;

  return {
    ready: true,
    days: workingDays,
    ideal,
    actual,
    // Positive means more work left than the ideal line — behind.
    deltaPoints: delta,
    onTrack: delta === null ? null : delta <= 0,
  };
}
