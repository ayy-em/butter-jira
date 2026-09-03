// Sprint freeze and diff — what changed underneath the plan.
//
// The dashboard already answers "how much got done". This answers the other
// question a sprint review asks and nothing in the app could: **what crept in,
// what was pulled out, what was re-estimated, what moved its due date, and who
// it moved to**.
//
// Why a second store rather than a field on the daily snapshot: `js/snapshots.js`
// records one row of team totals per day plus a short `byPerson` block, which is
// exactly right for a burndown and useless here. A burndown asks "how many
// points were left on Tuesday"; a diff asks "*which issue* changed", and an
// aggregate cannot answer that at any resolution. So this is per-issue, keyed by
// the same sprint key, written once per sprint rather than once per day.
//
// Why per-issue rows and not per-issue changelogs, which would be exact and
// complete: a changelog is one request per issue, so a 60-issue sprint is 60
// requests every time the tab opens. The same trade `js/snapshots.js` opens with,
// reached the same way — build history forward from data already in hand.
//
// **The honest cost, stated here and in the panel.** A freeze compares two
// points in time, not the path between them, so an issue that left the sprint
// and came back reads as unchanged. Detecting that needs the changelogs this
// design exists to avoid, so it is named on screen rather than quietly absent.
// And a freeze only exists from the day it is taken: a sprint boundary that
// passes unfrozen cannot be reconstructed afterwards, which is why the first
// dashboard load of a sprint takes one without being asked.

import { localGet, localSet } from "./browser.js";
import { MAX_SPRINTS_KEPT } from "./snapshots.js";
import {
  isoDay,
  sprintEntries,
  sprintNames,
  sprintWindow,
  startOfDay,
  workingDaysBetween,
} from "./dashboard.js";
import { isDone, isSubtask } from "./monitor.js";
import { getStoryPoints, resolveStatusGroup } from "./utils.js";
import { fieldValue } from "./config.js";

const FREEZE_KEY = "sprintFreezes";

// ── Taking a freeze ─────────────────────────────────────────────────────────

// One frozen issue. Every field here is chosen so the diff can be computed
// without going back to Jira for anything but the issues that *left* the sprint
// — the one question a frozen row cannot answer about itself.
//
// Two fields the scope note in the roadmap does not list, and why they are here:
//
//   - **`category`**, the status category key, rather than re-deriving done-ness
//     from the status name later. `isDone` reads the category, and a name like
//     "Klaar" is not something a diff should be matching on months afterwards.
//   - **`assigneeName`**, beside the account id. Exactly the argument
//     `snapshotFrom` makes for storing the display name rather than resolving it
//     on read: the roster is current, history is not, and someone who leaves the
//     team should still be named in the sprint they were on it for. Without it
//     the re-assigned bucket reads "5f3a…c1 → Bo", which is not a sentence.
export function freezeRowFrom(issue, statusGroups = []) {
  const f = issue?.fields || {};
  const status = f.status?.name || "";
  return {
    key: issue.key,
    summary: f.summary || "",
    type: f.issuetype?.name || "",
    status,
    statusGroup: resolveStatusGroup(status, statusGroups),
    category: f.status?.statusCategory?.key || "",
    assignee: f.assignee?.accountId || null,
    assigneeName: f.assignee?.displayName || "",
    points: getStoryPoints(issue),
    dueDate: f.duedate || null,
    // Modern Jira hierarchy first, the epic-link custom field second — the same
    // two ways the monitor's epic check reads a parent.
    parent: f.parent?.key || fieldValue(issue, "epicLink") || null,
    boardId: issue.boardId ?? null,
    sprintId: activeSprintIdOf(issue) ?? null,
    created: f.created || null,
  };
}

// The issue's own sprint id, for a diff that spans several boards: two boards'
// active sprints are one window on the dashboard, and "pulled out" wants to know
// which of them an issue left.
function activeSprintIdOf(issue) {
  const entries = sprintEntries(issue).filter((e) => e.state !== "closed");
  return entries.length ? entries[entries.length - 1].id : null;
}

// The whole record. Sub-tasks are excluded for the same reason `summarize`
// excludes them — their points duplicate the parent's — and because a diff whose
// counts did not reconcile with the dashboard's issue count above it would be
// worse than no diff.
export function freezeFrom({
  issues = [],
  sprints = [],
  statusGroups = [],
  now = new Date(),
} = {}) {
  const counted = issues.filter((issue) => !isSubtask(issue));
  const window = sprintWindow(sprints);
  const windowStart = window.start ? isoDay(window.start) : null;
  const takenOn = isoDay(now);

  const rows = counted.map((issue) => freezeRowFrom(issue, statusGroups));
  return {
    takenAt: new Date(now).toISOString(),
    takenOn,
    sprintNames: sprintNames(sprints),
    sprintIds: sprints.map((s) => s?.id).filter((id) => id !== undefined).map(String),
    windowStart,
    windowEnd: window.end ? isoDay(window.end) : null,
    // Which day of the sprint this was taken on, counted in working days, 1 on
    // the start day. The difference between a freeze that can say what the
    // sprint set out to do and one that can only say what changed since Tuesday.
    dayOfSprint: window.start ? workingDaysBetween(window.start, startOfDay(now)) : 0,
    atStart: Boolean(windowStart && takenOn <= windowStart),
    issueCount: rows.length,
    totalPoints: round1(rows.reduce((sum, row) => sum + (row.points ?? 0), 0)),
    rows,
  };
}

// ── What the freeze lets the dashboard claim ────────────────────────────────

// How the scope-added figure was arrived at, so the number can never silently
// change meaning depending on when the extension was installed.
//
// Three states, not two. A mid-sprint freeze is not the same fact as a
// start-of-sprint one: it is exact about everything after it and blind to
// everything before, and calling that "exact" would be the same overclaim the
// creation-date approximation already makes.
export function scopeBasis(freeze) {
  if (!freeze?.rows) {
    return {
      basis: "creation",
      exact: false,
      since: null,
      note:
        "Counted from issue creation date, so an older issue dragged in " +
        "mid-sprint isn't caught.",
    };
  }
  if (freeze.atStart) {
    return {
      basis: "freeze",
      exact: true,
      since: freeze.takenOn,
      note: `Exact: measured against the sprint's frozen state, taken ${freeze.takenOn}.`,
    };
  }
  return {
    basis: "freeze",
    exact: false,
    since: freeze.takenOn,
    note:
      `Measured against a freeze taken ${freeze.takenOn}, on day ` +
      `${freeze.dayOfSprint} of the sprint — exact from then on, blind to what ` +
      "changed before it.",
  };
}

// The keys the sprint held when it was frozen.
//
// A set rather than a per-issue predicate because that is the whole of what the
// exact scope flag needs: "was this issue in the sprint at the freeze" is set
// membership, not a date comparison, which is exactly why a freeze can be exact
// where a creation date cannot. The recap builds it once and tests every ticket
// against it.
export function frozenKeySet(freeze) {
  return new Set(freeze?.rows ? freeze.rows.map((row) => row.key) : []);
}

// ── The diff ────────────────────────────────────────────────────────────────

// `departed` is the current state of the issues that are in the freeze and no
// longer in the sprint — one batched JQL, not one request per issue, and empty
// is a legitimate answer meaning "they are all gone or unreadable".
export function diffFreeze({
  freeze = null,
  issues = [],
  sprints = [],
  statusGroups = [],
  departed = [],
  now = new Date(),
} = {}) {
  if (!freeze?.rows) return null;

  const counted = issues.filter((issue) => !isSubtask(issue));
  const activeSprintIds = sprints.map((s) => s?.id).filter((id) => id !== undefined);
  const before = new Map(freeze.rows.map((row) => [row.key, row]));
  const present = new Set(counted.map((issue) => issue.key));
  const departedBy = new Map((departed || []).map((issue) => [issue.key, issue]));

  const createdAfter = [];
  const draggedIn = [];
  const reEstimated = [];
  const reDated = [];
  const reassigned = [];
  const regressed = [];
  const changed = new Set();

  const frozenAt = new Date(freeze.takenAt).getTime();

  for (const issue of counted) {
    const was = before.get(issue.key);
    if (!was) {
      const row = creptRow(issue, statusGroups);
      // The split the approximation cannot make: an issue whose own creation
      // postdates the freeze is genuinely new work, and one that existed
      // already was dragged in off the backlog or out of another sprint. M7's
      // figure calls both "added after start" and is labelled approximate for
      // exactly this reason.
      const created = new Date(issue.fields?.created || 0).getTime();
      if (Number.isFinite(created) && created > frozenAt) createdAfter.push(row);
      else draggedIn.push(row);
      continue;
    }

    const points = getStoryPoints(issue);
    if (!sameNumber(was.points, points)) {
      reEstimated.push({
        key: issue.key,
        summary: was.summary,
        from: was.points,
        to: points,
        delta: round1((points ?? 0) - (was.points ?? 0)),
      });
      changed.add(issue.key);
    }

    const dueDate = issue.fields?.duedate || null;
    if ((was.dueDate || null) !== dueDate) {
      reDated.push({
        key: issue.key,
        summary: was.summary,
        from: was.dueDate || null,
        to: dueDate,
        days: dayDelta(was.dueDate, dueDate),
        direction: dateDirection(was.dueDate, dueDate),
      });
      changed.add(issue.key);
    }

    const assignee = issue.fields?.assignee?.accountId || null;
    if ((was.assignee || null) !== assignee) {
      reassigned.push({
        key: issue.key,
        summary: was.summary,
        from: was.assignee || null,
        // The name as it read on the day, not as the roster reads it now.
        fromName: was.assigneeName || (was.assignee ? was.assignee : "Unassigned"),
        to: assignee,
        toName: issue.fields?.assignee?.displayName || (assignee ? assignee : "Unassigned"),
      });
      changed.add(issue.key);
    }

    // A status regression is the one change that is about direction rather than
    // value: Done at the freeze and not Done now means work was reopened, which
    // no completion percentage will ever show.
    if (was.category === "done" && !isDone(issue)) {
      regressed.push({
        key: issue.key,
        summary: was.summary,
        from: was.status,
        to: issue.fields?.status?.name || "",
      });
      changed.add(issue.key);
    }
  }

  const pulledOut = freeze.rows
    .filter((row) => !present.has(row.key))
    .map((row) => ({
      ...row,
      ...departureOf(departedBy.get(row.key), activeSprintIds),
    }));

  const carriedThrough = freeze.rows.length - pulledOut.length;
  const creptIn = createdAfter.length + draggedIn.length;

  return {
    takenAt: freeze.takenAt,
    takenOn: freeze.takenOn,
    dayOfSprint: freeze.dayOfSprint,
    atStart: freeze.atStart,
    sprintNames: freeze.sprintNames || [],
    scope: scopeBasis(freeze),
    createdAfter,
    draggedIn,
    pulledOut,
    reEstimated,
    reDated,
    reassigned,
    regressed,
    // The reconciliation, which is the point of the unchanged count: the buckets
    // and the sprint total have to add up on screen, or the reader is left
    // wondering what the panel left out.
    counts: {
      frozen: freeze.rows.length,
      now: counted.length,
      creptIn,
      createdAfter: createdAfter.length,
      draggedIn: draggedIn.length,
      pulledOut: pulledOut.length,
      carriedThrough,
      changed: changed.size,
      unchanged: carriedThrough - changed.size,
    },
    points: {
      frozen: round1(freeze.totalPoints ?? 0),
      creptIn: round1(sumPoints(createdAfter) + sumPoints(draggedIn)),
      pulledOut: round1(sumPoints(pulledOut)),
      // The sprint's total change from re-estimation alone, which is the figure
      // a burndown cannot separate from work being finished.
      reEstimated: round1(reEstimated.reduce((sum, row) => sum + row.delta, 0)),
    },
    generatedAt: new Date(now).toISOString(),
  };
}

// Which issues to go and look up: in the freeze, not in the sprint now.
export function departedKeys(freeze, issues = []) {
  if (!freeze?.rows) return [];
  const present = new Set(issues.filter((i) => !isSubtask(i)).map((i) => i.key));
  return freeze.rows.map((row) => row.key).filter((key) => !present.has(key));
}

// Where an issue went. Four answers, and "gone" covers both a deleted issue and
// one the account can no longer see — the app cannot tell those apart, and
// claiming either would be a guess.
function departureOf(issue, activeSprintIds = []) {
  if (!issue) {
    return { where: "gone", whereLabel: "deleted, or no longer visible to you" };
  }
  const active = new Set(activeSprintIds.map(String));
  const entries = sprintEntries(issue).filter((e) => e.state !== "closed");
  if (entries.some((e) => e.id !== null && active.has(e.id))) {
    // Still in an active sprint but not in the list this diff was given: a
    // board that is configured in Jira and not here, most often.
    return { where: "elsewhere", whereLabel: "in an active sprint on another board" };
  }
  if (!entries.length) return { where: "backlog", whereLabel: "backlog" };
  const target = entries[entries.length - 1];
  return { where: "sprint", whereLabel: target.name || `sprint ${target.id || "?"}` };
}

function creptRow(issue, statusGroups) {
  const row = freezeRowFrom(issue, statusGroups);
  return { ...row, done: isDone(issue) };
}

function sumPoints(rows) {
  return rows.reduce((sum, row) => sum + (row.points ?? 0), 0);
}

// An estimate read back as "5" and frozen as 5 is not a re-estimation, and
// null (no estimate) is a value distinct from 0.
function sameNumber(a, b) {
  const left = a === null || a === undefined ? null : Number(a);
  const right = b === null || b === undefined ? null : Number(b);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 0.001;
}

function dayDelta(from, to) {
  if (!from || !to) return null;
  const a = startOfDay(from);
  const b = startOfDay(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function dateDirection(from, to) {
  if (!from && to) return "set";
  if (from && !to) return "cleared";
  const days = dayDelta(from, to);
  if (days === null) return "changed";
  return days > 0 ? "later" : days < 0 ? "earlier" : "changed";
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// ── Storage ─────────────────────────────────────────────────────────────────
//
// Device-local, like every other derived store, and pruned with the snapshot
// store's own constant rather than a second copy of the number. The two are
// written on the same dashboard load from the same sprint key, so sharing the
// cap is what stops them ending up different lengths and producing a diff for a
// sprint with no burndown, or the reverse.

export async function loadFreeze(key) {
  const stored = await localGet([FREEZE_KEY]);
  const all = stored[FREEZE_KEY] || {};
  const freeze = all[key];
  return freeze && Array.isArray(freeze.rows) ? freeze : null;
}

export async function loadAllFreezes() {
  const stored = await localGet([FREEZE_KEY]);
  return stored[FREEZE_KEY] || {};
}

// Overwrites whatever was there. A re-freeze is a deliberate act — the caller
// confirms it and says what is being discarded — so this does not second-guess
// it; what it returns is the record that was replaced, so the caller can.
export async function recordFreeze(key, freeze) {
  if (!key || !Array.isArray(freeze?.rows)) return null;
  const all = { ...(await loadAllFreezes()) };
  const previous = all[key] || null;
  all[key] = freeze;

  const keys = Object.keys(all);
  if (keys.length > MAX_SPRINTS_KEPT) {
    const kept = keys
      .sort((a, b) => String(all[b]?.takenAt || "").localeCompare(String(all[a]?.takenAt || "")))
      .slice(0, MAX_SPRINTS_KEPT);
    for (const k of Object.keys(all)) if (!kept.includes(k)) delete all[k];
  }

  await localSet({ [FREEZE_KEY]: all });
  return previous;
}

export async function clearFreezes() {
  await localSet({ [FREEZE_KEY]: {} });
}

// What one freeze costs on the device, in bytes of stored JSON.
//
// Here rather than guessed at because the roadmap's own risk register says per-
// issue rows for eight sprints is the largest thing this extension keeps, and
// "assume it is small" is how a storage quota is discovered by a user rather
// than by a test. `scripts/test-dashboard.mjs` measures a full sprint with it.
export function freezeBytes(freeze) {
  return new TextEncoder().encode(JSON.stringify(freeze ?? null)).length;
}
