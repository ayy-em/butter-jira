// Team Overview derivations — everything the rebuilt sprint dashboard shows
// that `summarize` does not already answer.
//
// DOM-free and network-free, like js/dashboard.js beside it: every function
// here takes what the view already fetched and returns plain data, so the whole
// screen's arithmetic tests without a browser (scripts/test-overview.mjs).
//
// Three rules from the spec that shaped it, written down because each is easy
// to undo by accident:
//
//   * **Time elapsed and work completed are different figures.** `sprintDay`
//     is the calendar; `summary.completionByPoints` is the work. Neither is
//     derived from the other anywhere in this file.
//   * **Points describe load, not people.** `workload` is ordered by name and
//     measures what someone holds against the days left — never what they
//     finished against a colleague. Same rule js/activity.js sets for itself.
//   * **A comparison is like for like or it is not made.** The previous
//     sprint is read at the same working day, not at its end; a figure with no
//     earlier reading says so instead of comparing against zero.

import {
  isBlocked,
  isInReview,
  isoDay,
  startOfDay,
  wasAddedAfterStart,
  workingDaysBetween,
} from "./dashboard.js";
import { isDone, isEpic, isSubtask } from "./monitor.js";
import { doneResolver } from "./activity.js";
import { getStoryPoints, isOverdue } from "./utils.js";
import { memberLabel } from "./team.js";

const DAY_MS = 86400000;

// "More than two days", as the checklist words it.
export const STALE_DAYS = 2;

const msOf = (iso) => {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? ms : 0;
};

const isWorkingDay = (d) => d.getDay() !== 0 && d.getDay() !== 6;

const counted = (issues) => (issues || []).filter((issue) => issue && !isSubtask(issue));

// ── The calendar ─────────────────────────────────────────────────────────────

// "Day 8 of 14": working days, inclusive of today when today is one. A Saturday
// is still day 5 of a week that ended on Friday, not day 6. Null when the sprint
// has no dates, which is a state the header has its own words for.
export function sprintDay(summary, now = new Date()) {
  const total = summary?.daysTotal || 0;
  if (!total) return null;
  if (summary.isOverdue) return { day: total, of: total, share: 1, ended: true };
  const today = startOfDay(now);
  const start = summary.window?.start;
  if (start && today < start) return { day: 0, of: total, share: 0, ended: false, notStarted: true };
  const day = Math.min(total, (summary.daysElapsed || 0) + (isWorkingDay(today) ? 1 : 0));
  return { day: Math.max(1, day), of: total, share: Math.max(1, day) / total, ended: false };
}

// Working days before `dayIso` inside the window — how far into the sprint a
// snapshot taken that day was. The day itself is excluded, matching
// `summary.daysElapsed`, which counts the days already behind us.
export function elapsedBefore(window, dayIso) {
  if (!window?.start || !dayIso) return 0;
  const day = startOfDay(dayIso);
  if (!day || day <= window.start) return 0;
  const prev = new Date(day);
  prev.setDate(prev.getDate() - 1);
  return workingDaysBetween(window.start, prev);
}

// The end of the n-th working day from `start` (n ≥ 1), clamped to `end`. The
// instant "the same point last sprint" is read at.
export function endOfWorkingDay(start, n, end = null) {
  const cursor = startOfDay(start);
  if (!cursor || n < 1) return null;
  let seen = 0;
  const stop = end ? startOfDay(end) : null;
  for (let guard = 0; guard < 400; guard++) {
    if (isWorkingDay(cursor)) seen++;
    if (seen >= n || (stop && cursor >= stop)) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 23, 59, 59, 999);
}

// ── Status split ─────────────────────────────────────────────────────────────

// Workflow order, which is the order the donut and its legend read in. Blocked
// last and apart: it is not a step on the way to Done but a state off it.
export const STATUS_SLICES = ["To Do", "In Progress", "In Review", "Done", "Blocked"];

export function statusSlice(issue, statusGroups = []) {
  if (isDone(issue)) return "Done";
  if (isBlocked(issue, statusGroups)) return "Blocked";
  if (isInReview(issue, statusGroups)) return "In Review";
  return issue?.fields?.status?.statusCategory?.key === "new" ? "To Do" : "In Progress";
}

export function statusDistribution(issues = [], statusGroups = []) {
  const keys = new Map(STATUS_SLICES.map((label) => [label, []]));
  const list = counted(issues);
  for (const issue of list) keys.get(statusSlice(issue, statusGroups)).push(issue.key);
  const total = list.length;
  return {
    total,
    slices: STATUS_SLICES.map((label) => {
      const count = keys.get(label).length;
      return { label, count, share: total ? count / total : 0, keys: keys.get(label) };
    }),
  };
}

// ── Workload ─────────────────────────────────────────────────────────────────

// What each person holds against the working days left. Capacity is the
// planner's own conversion — `hoursPerPoint` against an eight-hour day — so a
// point means the same thing here as it did when the sprint was planned.
// Everyone on the roster gets a row, holding work or not; without a roster,
// whoever holds sprint work does. Unassigned is not a person and is returned
// separately.
export function workload({
  summary,
  members = [],
  daysRemaining = summary?.daysRemaining ?? 0,
  hoursPerPoint = 8,
  ended = Boolean(summary?.isOverdue),
} = {}) {
  const byKey = new Map((summary?.byPerson || []).map((b) => [b.key, b]));
  const capacity =
    ended || !daysRemaining ? null : (daysRemaining * 8) / Math.max(0.5, Number(hoursPerPoint) || 8);

  const keys = members.length
    ? members.map((m) => m.accountId).filter(Boolean)
    : [...byKey.keys()].filter((k) => k !== "__unassigned__");

  const rows = keys.map((key) => {
    const bucket = byKey.get(key);
    const member = members.find((m) => m.accountId === key) || null;
    const points = bucket?.points || 0;
    const donePoints = bucket?.donePoints || 0;
    const reviewPoints = bucket?.reviewPoints || 0;
    const openPoints = Math.max(0, points - donePoints - reviewPoints);
    const load = capacity ? openPoints / capacity : null;
    let state = "ok";
    if (!bucket?.issues) state = "idle";
    // Work held with no estimate on any of it: there is nothing to measure
    // against capacity, and "OK" would be a claim the bar cannot back.
    else if (points === 0) state = "unestimated";
    else if (load !== null && load > 1) state = "over";
    else if (load !== null && load > 0.8) state = "near";
    return {
      key,
      // Someone on the roster holding nothing has no bucket to name them.
      label: bucket?.label || (member ? memberLabel(member) : key),
      member,
      role: member?.role || "",
      issues: bucket?.issues || 0,
      doneIssues: bucket?.doneIssues || 0,
      points,
      donePoints,
      reviewPoints,
      openPoints,
      capacity,
      load,
      state,
    };
  });

  rows.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const unassigned = byKey.get("__unassigned__") || null;
  return {
    rows,
    capacity,
    unassigned: unassigned
      ? { issues: unassigned.issues, points: unassigned.points - unassigned.donePoints }
      : null,
    // The scale every bar shares: the largest of anyone's load and the
    // capacity line, so the marker always lands inside the track.
    scale: Math.max(capacity || 0, ...rows.map((r) => r.points), 1),
  };
}

// ── Scope ────────────────────────────────────────────────────────────────────

// Original commitment, added, removed and re-estimated, each kept apart. With a
// freeze these are set membership and its arithmetic; without one, only the
// creation-date estimate of "added" exists and the rest are null, not zero.
export function scopeChange({ summary, diff = null } = {}) {
  if (diff) {
    const original = diff.points.frozen;
    const net = diff.points.creptIn - diff.points.pulledOut + diff.points.reEstimated;
    return {
      original,
      added: diff.points.creptIn,
      addedCount: diff.counts.creptIn,
      removed: diff.points.pulledOut,
      removedCount: diff.counts.pulledOut,
      reEstimated: diff.points.reEstimated,
      net,
      share: original > 0 ? net / original : null,
      exact: Boolean(diff.scope?.exact),
      basis: "freeze",
    };
  }
  const added = summary?.addedAfterStartPoints || 0;
  const original = Math.max(0, (summary?.totalPoints || 0) - added);
  return {
    original,
    added,
    addedCount: summary?.addedAfterStart || 0,
    removed: null,
    removedCount: null,
    reEstimated: null,
    net: added,
    share: original > 0 ? added / original : null,
    exact: false,
    basis: "creation",
  };
}

// Which issues those added points are, for the checklist: the same rule
// `summarize` uses, so the list and the count can never disagree.
export function addedAfterStartIssues(issues = [], { freeze = null, windowStart = null } = {}) {
  const frozen = freeze?.rows ? new Set(freeze.rows.map((row) => row.key)) : null;
  return counted(issues).filter((issue) =>
    frozen ? !frozen.has(issue.key) : wasAddedAfterStart(issue, windowStart)
  );
}

// ── Carry-over risk ──────────────────────────────────────────────────────────

// The share of the sprint's points the current pace leaves unfinished: points
// done per working day so far, carried forward over the days left, against
// what is still open. A projection, and labelled as one; it is null until a
// day has passed, because a rate over no days is not a rate.
function riskFrom({ totalPoints, donePoints, openPoints, elapsed, remaining }) {
  if (!(totalPoints > 0)) return null;
  if (remaining <= 0) return openPoints / totalPoints;
  if (elapsed <= 0) return null;
  const rate = donePoints / elapsed;
  return Math.max(0, openPoints - rate * remaining) / totalPoints;
}

export function carryOverRisk({ summary, snapshots = [], now = new Date() } = {}) {
  if (!summary) return null;
  const ended = Boolean(summary.isOverdue);
  const current = riskFrom({
    totalPoints: summary.totalPoints,
    donePoints: summary.donePoints,
    openPoints: summary.openPoints,
    elapsed: summary.daysElapsed,
    remaining: ended ? 0 : summary.daysRemaining,
  });

  // The latest reading from an earlier day, recomputed the same way.
  const today = isoDay(now);
  const earlier = (snapshots || [])
    .filter((s) => s?.date && s.date < today && typeof s.openPoints === "number")
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();
  let previous = null;
  if (earlier && summary.window?.start) {
    const elapsed = elapsedBefore(summary.window, earlier.date);
    previous = riskFrom({
      totalPoints: earlier.totalPoints,
      donePoints: earlier.donePoints ?? earlier.totalPoints - earlier.openPoints,
      openPoints: earlier.openPoints,
      elapsed,
      remaining: Math.max(0, summary.daysTotal - elapsed),
    });
  }
  return {
    risk: current,
    spillPoints: current === null ? null : current * summary.totalPoints,
    previous,
    previousDate: earlier?.date || null,
    delta: current !== null && previous !== null ? current - previous : null,
    ended,
  };
}

// ── Readings from an earlier day ─────────────────────────────────────────────

// The last snapshot before today that recorded `field` — "since the previous
// reporting period" for a figure the daily snapshot carries.
export function previousReading(snapshots = [], field, now = new Date()) {
  const today = isoDay(now);
  const found = (snapshots || [])
    .filter((s) => s?.date && s.date < today && typeof s[field] === "number")
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();
  return found ? { date: found.date, value: found[field] } : null;
}

// ── The previous sprint ──────────────────────────────────────────────────────

// The sprint before the one being looked at, per board. For a running sprint
// that is the board's last closed one; for a closed sprint, the one closed
// before it. `closed` is each board's list newest first, as `getClosedSprints`
// answers.
export function previousSprintFor(sprint, closed = []) {
  if (!sprint) return null;
  if (sprint.state !== "closed") return closed[0] || null;
  const at = closed.findIndex((s) => String(s.id) === String(sprint.id));
  return at >= 0 ? closed[at + 1] || null : null;
}

// Issues closed by `cutoff`, read off the history that rode the sprint fetch:
// a status change into a done status between the sprint's start and the
// cutoff. `partial` says some done issue carried no history to read, so the
// count is a floor.
export function closedBy(issues = [], { from = null, cutoff, statusGroups = [] } = {}) {
  const list = counted(issues);
  const isDoneStatus = doneResolver(list, statusGroups);
  const lo = from ? new Date(from).getTime() : 0;
  const hi = new Date(cutoff).getTime();
  let count = 0;
  let partial = false;
  for (const issue of list) {
    const events = issue.history?.events;
    if (!events) {
      if (isDone(issue)) partial = true;
      continue;
    }
    const hit = events.some((e) => {
      if (e.kind !== "status" || !isDoneStatus(e.to) || isDoneStatus(e.from)) return false;
      const at = msOf(e.at);
      return at >= lo && at <= hi;
    });
    if (hit) count++;
  }
  return { count, partial };
}

// ── Review turnaround ────────────────────────────────────────────────────────

// Median days from a pull request being opened to its first review by someone
// other than its author, over pull requests opened inside the window. Median,
// because one PR left over a holiday would otherwise be the whole number.
// Pull requests with no review yet are counted separately, not as zero.
export function reviewTurnaround(stats, { since = "", until = "" } = {}) {
  if (!stats) return null;
  const from = Math.max(msOf(stats.since), msOf(since));
  const to = until ? msOf(until) : Infinity;
  const first = new Map();
  for (const review of stats.reviews || []) {
    const by = String(review.author || "").toLowerCase();
    if (!by || by === String(review.prAuthor || "").toLowerCase()) continue;
    const key = `${review.repo}#${review.number}`;
    const at = msOf(review.submittedAt);
    if (at && (!first.has(key) || at < first.get(key))) first.set(key, at);
  }
  const waits = [];
  let unreviewed = 0;
  for (const pr of stats.pullRequests || []) {
    const opened = msOf(pr.createdAt);
    if (!opened || opened < from || opened > to) continue;
    const reviewed = first.get(`${pr.repo}#${pr.number}`);
    if (reviewed === undefined || reviewed < opened) {
      unreviewed++;
      continue;
    }
    waits.push((reviewed - opened) / DAY_MS);
  }
  waits.sort((a, b) => a - b);
  const mid = waits.length >> 1;
  const median = !waits.length
    ? null
    : waits.length % 2
      ? waits[mid]
      : (waits[mid - 1] + waits[mid]) / 2;
  return {
    median,
    reviewed: waits.length,
    unreviewed,
    clamped: Boolean(since) && msOf(since) < msOf(stats.since),
  };
}

// ── Items to check manually ──────────────────────────────────────────────────

// When the issue entered the state it is blocked in: the last status change
// into its current status, or the last time the flag was set. Null when the
// history does not say.
export function blockedSince(issue) {
  const events = issue?.history?.events;
  if (!events?.length) return null;
  const status = String(issue.fields?.status?.name || "").toLowerCase();
  let at = 0;
  for (const e of events) {
    const intoStatus = e.kind === "status" && String(e.to).toLowerCase() === status;
    const flagged = e.kind === "field" && /flag/i.test(e.field) && e.to;
    if ((intoStatus || flagged) && msOf(e.at) > at) at = msOf(e.at);
  }
  return at ? new Date(at).toISOString() : null;
}

const daysOld = (iso, now) => Math.floor((now.getTime() - msOf(iso)) / DAY_MS);

// "Waits on", read the way js/issue-link.js reads a link: the label is the
// phrase as seen from this issue, inward for an inwardIssue.
const WAITS_ON = /blocked by|depends on/i;

export function dependencyRows(linked = [], sprintIssues = []) {
  const open = new Set(counted(sprintIssues).filter((i) => !isDone(i)).map((i) => i.key));
  const rows = [];
  for (const issue of linked || []) {
    if (!open.has(issue?.key)) continue;
    for (const link of issue.fields?.issuelinks || []) {
      const other = link?.inwardIssue;
      if (!other?.key || !WAITS_ON.test(link.type?.inward || "")) continue;
      if (other.fields?.status?.statusCategory?.key === "done") continue;
      rows.push({
        key: issue.key,
        summary: issue.fields?.summary || "",
        waitsOn: other.key,
        waitsOnStatus: other.fields?.status?.name || "",
      });
    }
  }
  return rows;
}

// Seven checks, each a count and the rows behind it. `state` is per check
// because the sources land at different times: Jira-only checks are ready on
// first paint, the PR check waits on GitHub and the dependencies check on its
// own link lookup — and "still looking" is a different answer from zero.
export function attentionChecks({
  issues = [],
  statusGroups = [],
  freeze = null,
  windowStart = null,
  pullRequests = null,
  githubState = "off",
  links = null,
  linksState = "loading",
  now = new Date(),
} = {}) {
  const list = counted(issues);
  const open = list.filter((i) => !isDone(i));
  const issueRow = (issue, detail) => ({
    key: issue.key,
    summary: issue.fields?.summary || "",
    assignee: issue.fields?.assignee || null,
    detail,
  });

  const overdue = open
    .filter((i) => isOverdue(i, now))
    .map((i) => issueRow(i, `due ${i.fields.duedate}`));

  const blocked = open
    .filter((i) => isBlocked(i, statusGroups))
    .map((i) => ({ issue: i, since: blockedSince(i) }))
    .filter(({ since }) => !since || daysOld(since, now) > STALE_DAYS)
    .map(({ issue, since }) =>
      issueRow(issue, since ? `blocked ${daysOld(since, now)} days` : "blocked, since unknown")
    );

  const workItems = open.filter((i) => !isEpic(i));
  const unestimated = workItems
    .filter((i) => getStoryPoints(i) === null)
    .map((i) => issueRow(i, i.fields?.status?.name || ""));
  const unassigned = workItems
    .filter((i) => !i.fields?.assignee)
    .map((i) => issueRow(i, i.fields?.status?.name || ""));

  const added = addedAfterStartIssues(list, { freeze, windowStart }).map((i) => {
    const points = getStoryPoints(i);
    return issueRow(i, points === null ? "unestimated" : `${points} pts`);
  });

  const waiting =
    pullRequests === null
      ? []
      : pullRequests
          .filter((pr) => pr.state === "waiting-review" && pr.ageDays > STALE_DAYS)
          .map((pr) => ({
            pr,
            key: `${pr.repo}#${pr.number}`,
            summary: pr.title,
            detail: `open ${pr.ageDays} days`,
          }));

  // The link lookup carries only summary, status and links, so each row is
  // drawn from the sprint issue itself — assignee and all.
  const byKey = new Map(list.map((i) => [i.key, i]));
  const deps = links === null ? [] : dependencyRows(links, list).map((row) =>
    issueRow(
      byKey.get(row.key),
      row.waitsOnStatus ? `waits on ${row.waitsOn} (${row.waitsOnStatus})` : `waits on ${row.waitsOn}`
    )
  );

  return [
    { id: "overdue", label: "Overdue issues", kind: "issues", rows: overdue, state: "ready" },
    { id: "blocked", label: `Blocked for more than ${STALE_DAYS} days`, kind: "issues", rows: blocked, state: "ready" },
    {
      id: "prs",
      label: `PRs awaiting review over ${STALE_DAYS} days`,
      kind: "prs",
      rows: waiting,
      state: githubState === "ready" && pullRequests === null ? "loading" : githubState,
    },
    { id: "unestimated", label: "Unestimated issues", kind: "issues", rows: unestimated, state: "ready" },
    { id: "unassigned", label: "Issues without an assignee", kind: "issues", rows: unassigned, state: "ready" },
    { id: "added", label: "Scope added after sprint start", kind: "issues", rows: added, state: "ready" },
    { id: "deps", label: "Dependencies to follow up", kind: "issues", rows: deps, state: linksState },
  ].map((check) => ({ ...check, count: check.rows.length }));
}

// ── Standup prep ─────────────────────────────────────────────────────────────

// Who has left no trace since `since`: no Jira status change, edit, creation or
// pick-up, and no pull request, commit, review or comment on GitHub. Not "who
// did nothing" — work happens off both systems — so the panel calls it no
// recent activity and offers their 1:1 sheet rather than a verdict.
//
// `jira` is an `activityFrom` model over the window; `github` is the stats
// document, or null when GitHub is off or has not answered. `unknown` is true
// when neither source can say anything at all.
export function quietMembers({ members = [], jira = null, github = null, statsFor = null, since = "" } = {}) {
  const jiraKnown = Boolean(jira?.hasHistory);
  const out = [];
  for (const member of members) {
    if (!member?.accountId) continue;
    const bucket = jira?.byPerson?.find((p) => p.key === member.accountId) || null;
    const jiraActive = Boolean(
      bucket &&
        (bucket.transitions || bucket.edits || bucket.created || bucket.pickedUp || bucket.assignedToOthers)
    );
    let githubActive = false;
    if (github && statsFor && member.githubLogin) {
      const s = statsFor(github, member.githubLogin, { since });
      githubActive = Boolean(s && (s.prsOpened || s.prsMerged || s.directCommits || s.reviews || s.comments));
    }
    if (!jiraActive && !githubActive) out.push(member);
  }
  return { quiet: out, unknown: !jiraKnown && !github, since };
}

// What moved since the last standup, from the same history: issues that
// reached done, issues created or pulled into the sprint, and status changes
// overall. Null without a previous standup to measure from.
export function sinceLastStandup({ issues = [], since = "", statusGroups = [], freeze = null } = {}) {
  if (!since) return null;
  const list = counted(issues);
  const isDoneStatus = doneResolver(list, statusGroups);
  const from = msOf(since);
  const closed = [];
  let moves = 0;
  let historyKnown = false;
  for (const issue of list) {
    const events = issue.history?.events;
    if (!events) continue;
    historyKnown = true;
    let reachedDone = false;
    for (const e of events) {
      if (e.kind !== "status" || msOf(e.at) < from) continue;
      moves++;
      if (isDoneStatus(e.to) && !isDoneStatus(e.from)) reachedDone = true;
    }
    if (reachedDone) closed.push(issue.key);
  }
  const frozen = freeze?.rows ? new Set(freeze.rows.map((r) => r.key)) : null;
  const created = list
    .filter((i) => msOf(i.fields?.created) >= from)
    .filter((i) => !frozen || !frozen.has(i.key))
    .map((i) => i.key);
  return { since, closed, created, moves, historyKnown };
}
