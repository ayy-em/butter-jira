// Daily sprint snapshots — the burndown's history.
//
// Why snapshots rather than reading history out of Jira: a point-in-time
// burndown needs to know what the scope and the remaining work were on each past
// day, and neither documented route is good.
//
//   - `expand=changelog` per issue is accurate but costs one request per issue,
//     so a 60-issue sprint is 60 requests every time the tab opens.
//   - The chart Jira itself draws comes from `/rest/greenhopper/1.0/rapid/charts/
//     sprintreport`, which is one request but undocumented and unsupported — the
//     same class of endpoint the development-links feature was deferred over.
//
// So the app records its own aggregate once per day, from data it already has in
// hand, and builds history forward. The honest cost: a burndown appears on the
// second day of use rather than immediately, and history does not exist for
// sprints that ran before the extension was installed. The view says so instead
// of drawing a line it cannot support.
//
// Stored device-local. It is small — a few numbers per day, plus one short row
// per person — and pruned to the most recent sprints.

import { localGet, localSet } from "./browser.js";

const SNAPSHOT_KEY = "sprintSnapshots";

// Exported so `js/freeze.js` prunes to the same depth rather than keeping a
// second copy of the number. The two stores are written on the same dashboard
// load from the same sprint key, so a shared cap is what stops them ending up
// different lengths — a diff for a sprint with no burndown, or the reverse.
export const MAX_SPRINTS_KEPT = 8;
const MAX_DAYS_PER_SPRINT = 60;

// Sprints are keyed by their Jira ids so a re-planned sprint doesn't inherit
// another one's history.
export function sprintKey(sprints) {
  const ids = sprints
    .map((s) => s.id)
    .filter((id) => id !== undefined)
    .map(String)
    .sort();
  return ids.length ? ids.join("+") : "no-sprint";
}

export function snapshotFrom(summary, dayIso) {
  return {
    date: dayIso,
    totalPoints: round1(summary.totalPoints),
    openPoints: round1(summary.openPoints),
    donePoints: round1(summary.donePoints),
    issueCount: summary.issueCount,
    doneIssues: summary.doneIssues,
    byPerson: peopleFrom(summary.byPerson),
  };
}

// The per-person half of the same day, written for the sprint planner and the
// 1:1 screen, which both need per-person history and can only have it if the
// field starts accruing before they are built.
//
// Three decisions worth stating, because they are hard to change once days of
// history exist in the field:
//
//   - **Keyed by account id, not an array.** Every reader asks "this person,
//     across days" rather than "this day, across people", so a map is one index
//     instead of a scan per stored day.
//   - **Unassigned is kept.** It is a row like any other, and dropping it would
//     make the rows stop summing to the day's totals — a trap for anyone who
//     later checks one figure against the other.
//   - **The display name is stored, not resolved on read.** The roster is
//     current; history is not. Someone who leaves the team should still be
//     named in the weeks they were on it, rather than decaying to an opaque id.
//
// `onTeam` is deliberately absent: unlike a name, it is a question about now,
// and the roster answers it at read time without going stale in storage.
function peopleFrom(buckets) {
  const people = {};
  if (!Array.isArray(buckets)) return people;
  for (const bucket of buckets) {
    if (bucket?.key === undefined || bucket?.key === null) continue;
    people[String(bucket.key)] = {
      label: bucket.label || String(bucket.key),
      points: round1(bucket.points),
      issues: Number(bucket.issues) || 0,
      donePoints: round1(bucket.donePoints),
      doneIssues: Number(bucket.doneIssues) || 0,
    };
  }
  return people;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

export async function loadSnapshots(key) {
  const stored = await localGet([SNAPSHOT_KEY]);
  const all = stored[SNAPSHOT_KEY] || {};
  const list = all[key];
  return Array.isArray(list) ? list : [];
}

// One row per day: a later read on the same day overwrites it, so the figure
// stored is always the most recent state of that day rather than whatever
// happened to be true the first time the tab was opened.
export async function recordSnapshot(key, snapshot) {
  // Nothing to record — return what is already stored rather than an empty
  // array, which would read as "this sprint has no history".
  if (!snapshot?.date) return loadSnapshots(key);
  const stored = await localGet([SNAPSHOT_KEY]);
  const all = { ...(stored[SNAPSHOT_KEY] || {}) };
  const list = Array.isArray(all[key]) ? [...all[key]] : [];

  const existing = list.findIndex((s) => s.date === snapshot.date);
  if (existing >= 0) list[existing] = snapshot;
  else list.push(snapshot);

  list.sort((a, b) => a.date.localeCompare(b.date));
  all[key] = list.slice(-MAX_DAYS_PER_SPRINT);

  // Keep storage bounded: drop the least recently touched sprints.
  const keys = Object.keys(all);
  if (keys.length > MAX_SPRINTS_KEPT) {
    const ranked = keys
      .map((k) => ({ k, last: all[k]?.[all[k].length - 1]?.date || "" }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .slice(0, MAX_SPRINTS_KEPT)
      .map((entry) => entry.k);
    for (const k of keys) if (!ranked.includes(k)) delete all[k];
  }

  await localSet({ [SNAPSHOT_KEY]: all });
  return all[key];
}

export async function clearSnapshots() {
  await localSet({ [SNAPSHOT_KEY]: {} });
}
