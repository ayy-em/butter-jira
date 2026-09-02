// Per-person Jira activity: what people *did* this sprint, as opposed to what
// is assigned to them.
//
// The standup and the recap both answer "what is on this person's plate" and,
// with GitHub connected, "what did they push". Neither answers who moved which
// ticket, who picked work up, or who created the things that appeared
// mid-sprint. That is what this module reads, and it reads it from data already
// in flight: `expand=changelog` rides the sprint and backlog requests the app
// makes anyway, and `fields.creator` has been fetched and cached all along.
//
// ── Framing, settled before the first panel was drawn ────────────────────────
//
// This counts *actions taken by a named colleague*, which is a much shorter step
// to a productivity metric than anything else in this app. Points assigned
// describe work; transition counts describe a person. So the rules M16 set for
// Quarter Wrapped and M14 sets for the 1:1 screen are the floor here, not the
// ceiling:
//
//   * **Ordered by name, never by output.** `activityFrom` returns people sorted
//     by label, and no sort-by-count is offered anywhere. A table sorted by
//     transition count is very hard to un-read once it has been seen.
//   * **"Activity", never "performance".** These are conversation fuel — a
//     prompt for "tell us about ABC-12" — and the wording in every consumer says
//     so.
//   * **No leaderboard, no ranking, no per-person trend framed as evaluation.**
//   * **A high count is not a good number and a low one is not a bad one.** Ten
//     transitions can be one ticket bouncing between review and rework. The
//     module deliberately exposes no total, no score and no composite.
//
// ── The window is a parameter from the first commit ──────────────────────────
//
// M16's *Ping-Pong Award* is "most status transitions"; M14's "what they did" is
// "issues closed and moved this week". Both are this reader with a different
// window over it, so `activityFrom` takes `{ since, until }` the way
// `statsFor(stats, login, { since })` already does in `js/github.js`, and
// neither milestone pays for the window a second time.

import { resolveStatusGroup } from "./utils.js";
import { isSubtask } from "./monitor.js";
import { displayNameFor, memberFor, memberLabel } from "./team.js";

export const UNASSIGNED = "__unassigned__";

// Changelog field names the reader acts on. Jira reports these by display name
// in `item.field`, and the name is localised on some sites — so `item.fieldId`
// is preferred where Jira sends it (it is stable and untranslated) and the name
// is only the fallback. A site that sends neither is why `field` is kept raw on
// the entry rather than mapped to null: an unrecognised field still counts as an
// edit, which is the honest answer.
const FIELD_IDS = {
  status: "status",
  assignee: "assignee",
};

const FIELD_NAMES = {
  status: /^(status|statut|estado|zustand|status)$/i,
  assignee: /^(assignee|toegewezen persoon|responsable|zugewiesene person)$/i,
};

function fieldKind(item) {
  const id = String(item?.fieldId ?? "");
  if (id === FIELD_IDS.status) return "status";
  if (id === FIELD_IDS.assignee) return "assignee";
  // Only fall back to the display name when there is no id at all. An id that
  // is present but unrecognised is a custom field, and guessing from its label
  // would misread a field called "Status of review" as a transition.
  if (!id) {
    const name = String(item?.field ?? "").trim();
    if (FIELD_NAMES.status.test(name)) return "status";
    if (FIELD_NAMES.assignee.test(name)) return "assignee";
  }
  return "field";
}

// ── Compaction, which happens at fetch time ──────────────────────────────────

// Reduce one issue's changelog to a flat array of compact entries.
//
// Called at the API boundary, before the response reaches the cache. Sprint
// issues go through `cached()` into device-local storage on a 5-minute TTL, and
// whole changelogs would multiply that payload to carry data the app discards
// most of — Jira's history entry is a nested object with an author record, an
// avatar URL set and both raw and display values per item. What a panel needs is
// five fields.
//
// A pure function over the response shape, so it tests without a browser.
export function compactHistory(issue) {
  const log = issue?.changelog;
  if (!log) return null;

  const histories = Array.isArray(log.histories) ? log.histories : [];
  const events = [];
  for (const entry of histories) {
    const by = entry?.author?.accountId ? String(entry.author.accountId) : "";
    const at = entry?.created ? String(entry.created) : "";
    const items = Array.isArray(entry?.items) ? entry.items : [];
    for (const item of items) {
      events.push({
        at,
        by,
        kind: fieldKind(item),
        field: String(item?.field ?? item?.fieldId ?? ""),
        // `fromString`/`toString` are the display values, which is what a panel
        // prints. The raw `from`/`to` are ids and are kept only for assignee,
        // where the id is what identifies the person and the string is a name
        // that may since have changed.
        from: item?.fromString == null ? "" : String(item.fromString),
        to: item?.toString == null ? "" : String(item.toString),
        fromId: item?.from == null ? "" : String(item.from),
        toId: item?.to == null ? "" : String(item.to),
      });
    }
  }

  // The bounded-and-does-not-paginate problem, carried rather than hidden. Jira
  // returns the most recent entries per issue alongside a total, and a ticket
  // that has ping-ponged for months can exceed it. `js/github.js` already
  // answers this the same way for its own page caps: carry a flag through the
  // model and have the screen say so, rather than printing an undercount as
  // though it were whole.
  const returned = histories.length;
  const total = Number.isFinite(log.total) ? log.total : returned;

  return {
    events,
    total,
    returned,
    truncated: total > returned,
  };
}

// Replace each issue's `changelog` with its compact form, in place, and return
// the issues. Called from `js/api.js` on the fetch path so nothing downstream —
// and nothing in the cache — ever sees the raw shape.
export function compactChangelogs(issues) {
  for (const issue of issues || []) {
    if (!issue?.changelog) continue;
    const history = compactHistory(issue);
    delete issue.changelog;
    if (history) issue.history = history;
  }
  return issues;
}

// ── The model ────────────────────────────────────────────────────────────────

function msOf(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function emptyBucket(key, label) {
  return {
    key,
    label,
    historyKnown: false,
    // Status transitions they made. Not "tickets they moved": moving the same
    // ticket twice is two transitions, which is the point of the figure.
    transitions: 0,
    // Transitions that landed in a done status, and the distinct issues behind
    // them. A ticket reopened and re-closed counts once in `completedIssues`
    // and twice in `completed`.
    completed: 0,
    // Transitions that took an issue *out* of done. Kept separate rather than
    // netted off: a reopen is a real event and hiding it inside a completion
    // count is how a number stops matching what people remember.
    reopened: 0,
    // Assignee changes. `pickedUp` is work that became theirs — by their own
    // hand or someone else's, because both are things to talk about — and
    // `assignedOut` is work they moved off themselves onto somebody else.
    pickedUp: 0,
    assignedOut: 0,
    // Assignments they made *to other people*. Separate from `assignedOut`,
    // which is only about work leaving their own name.
    assignedToOthers: 0,
    // Field edits that are neither a transition nor an assignment: points, due
    // dates, summaries, custom fields.
    edits: 0,
    // Issues they created whose creation falls inside the window.
    created: 0,
    // Issue keys behind the counts, so a panel can name tickets rather than
    // only counting them — which is the difference between conversation fuel
    // and a scoreboard.
    touchedIssues: [],
    completedIssues: [],
    createdIssues: [],
  };
}

function bucketFor(map, key, label) {
  const id = key || UNASSIGNED;
  if (!map.has(id)) map.set(id, emptyBucket(id, label || id));
  const bucket = map.get(id);
  // First real name wins over an id used as a placeholder.
  if (label && bucket.label === bucket.key) bucket.label = label;
  return bucket;
}

// A status name -> is-it-done resolver.
//
// A changelog entry carries status *names*, not the `statusCategory` that
// `isDone` reads — so done-ness has to be decided from a name alone, and there
// are three sources for that, used in this order:
//
//   1. **The issues in hand.** Every issue's current status carries both its
//      name and its category, so the set of issues being read is itself an
//      index of names to categories. This is the only source that is correct on
//      a site with a custom done status nobody configured.
//   2. **The configured status groups.** Covers a status transitioned *through*
//      and away from, which no current issue will be sitting in.
//   3. **The same regex `isDone` falls back to**, for a name neither source
//      knows.
function doneResolver(issues, statusGroups) {
  const byName = new Map();
  for (const issue of issues || []) {
    const status = issue?.fields?.status;
    const name = status?.name;
    const category = status?.statusCategory?.key;
    if (name && category) byName.set(String(name).toLowerCase(), category === "done");
  }

  const groups = Array.isArray(statusGroups) ? statusGroups : [];
  const doneGroups = new Set(
    groups
      .map((g) => g?.name)
      .filter((name) => name && /^(done|closed|complete[d]?|shipped)$/i.test(name))
      .map((name) => String(name).toLowerCase())
  );

  return function isDoneStatus(name) {
    if (!name) return false;
    const key = String(name).toLowerCase();
    if (byName.has(key)) return byName.get(key);
    if (groups.length) {
      const group = resolveStatusGroup(String(name), groups);
      // Only trust the group when it actually matched one; `resolveStatusGroup`
      // returns the status name itself when nothing does, which would otherwise
      // read as an unknown group rather than as "no answer".
      if (String(group).toLowerCase() !== key) {
        return doneGroups.has(String(group).toLowerCase());
      }
    }
    return /^(done|closed|resolved|rejected|shipped)$/i.test(key);
  };
}

// Everything people did to a set of issues inside a window.
//
// `issues` are the issues as fetched, each optionally carrying the compact
// `history` that `compactChangelogs` attached. Anything without one contributes
// its creation event and nothing else, which is why an issue fetched before the
// expand was added still counts correctly for `created`.
//
// Returns people ordered **by name**, and the unassigned bucket last. See the
// framing note at the top of the file: no consumer is given a count to sort on.
export function activityFrom(
  issues = [],
  { since = "", until = "", statusGroups = [] } = {}
) {
  const from = msOf(since);
  const to = until ? msOf(until) : Infinity;
  const inWindow = (iso) => {
    const ms = msOf(iso);
    return ms > 0 && ms >= from && ms <= to;
  };

  // Sub-tasks are excluded for the same reason `summarize` and `buildRecap`
  // exclude them: their points duplicate the parent's, and counting a sub-task
  // transition as a separate action would make one piece of work read as two.
  const counted = (issues || []).filter((issue) => issue && !isSubtask(issue));
  const isDoneStatus = doneResolver(counted, statusGroups);

  // Names. A changelog author is an id and a display name recorded on the day;
  // an assignee or creator record is a full person object. `displayNameFor`
  // already prefers the roster's override over Jira's name, so indexing the
  // person records this set of issues carries gets the roster applied for free.
  const names = new Map();
  const learn = (person) => {
    const id = person?.accountId ? String(person.accountId) : "";
    if (!id || names.has(id)) return;
    const label = displayNameFor(person);
    if (label && label !== "Unassigned") names.set(id, label);
  };
  for (const issue of counted) {
    learn(issue.fields?.assignee);
    learn(issue.fields?.creator);
    learn(issue.fields?.reporter);
  }

  // Falls through to the roster for somebody who appears only as a changelog
  // author — they moved a ticket that is now assigned to someone else — and
  // then to nothing, which leaves the caller to use the name the entry carried.
  const labelFor = (id) => {
    const known = names.get(String(id));
    if (known) return known;
    const member = memberFor(String(id));
    return member ? memberLabel(member) : "";
  };

  const people = new Map();
  const truncated = [];
  const touched = new Map(); // account id -> Set of issue keys
  const completedBy = new Map();

  const noteIssue = (map, accountId, key) => {
    if (!key) return;
    const id = accountId || UNASSIGNED;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(key);
  };

  for (const issue of counted) {
    const key = issue.key || "";

    // ── Issues created, which needs no expand at all ────────────────────────
    const creator = issue.fields?.creator || issue.fields?.reporter || null;
    if (creator?.accountId && inWindow(issue.fields?.created)) {
      const bucket = bucketFor(people, String(creator.accountId), labelFor(creator.accountId));
      bucket.created++;
      bucket.createdIssues.push(key);
    }

    // Normally compacted at the API boundary. A caller that assembled issues
    // some other way may still be holding the raw shape, so compact on the fly
    // rather than reading an absent `history` and reporting that nobody did
    // anything — a silently empty model is the worst of the three outcomes.
    const history = issue.history || compactHistory(issue);
    if (!history) continue;
    if (history.truncated && key) truncated.push(key);

    for (const event of history.events || []) {
      if (!inWindow(event.at)) continue;
      // An entry with no author is a Jira automation or a deleted account. It is
      // a real change but not a person's action, so it is dropped rather than
      // pooled under "unassigned", which would read as a colleague.
      if (!event.by) continue;

      const bucket = bucketFor(people, event.by, labelFor(event.by));
      noteIssue(touched, event.by, key);

      if (event.kind === "status") {
        bucket.transitions++;
        const wasDone = isDoneStatus(event.from);
        const nowDone = isDoneStatus(event.to);
        if (nowDone && !wasDone) {
          bucket.completed++;
          noteIssue(completedBy, event.by, key);
        } else if (wasDone && !nowDone) {
          bucket.reopened++;
        }
        continue;
      }

      if (event.kind === "assignee") {
        // Identify people by id, not by the display name in the entry: a name
        // recorded months ago may since have changed, and the id has not.
        const toId = event.toId ? String(event.toId) : "";
        const fromId = event.fromId ? String(event.fromId) : "";
        if (toId && toId !== fromId) {
          const receiver = bucketFor(people, toId, labelFor(toId) || event.to);
          receiver.pickedUp++;
          noteIssue(touched, toId, key);
          // Assigning to yourself is picking work up, not handing it out.
          if (toId !== event.by) bucket.assignedToOthers++;
        }
        if (fromId && fromId === event.by && toId !== fromId) {
          bucket.assignedOut++;
        }
        continue;
      }

      bucket.edits++;
    }
  }

  const hasHistory = counted.some((issue) => issue.history || issue.changelog);
  const buckets = [...people.values()].map((bucket) => ({
    ...bucket,
    touchedIssues: [...(touched.get(bucket.key) || [])],
    completedIssues: [...(completedBy.get(bucket.key) || [])],
    // Whether the changelog half of this bucket means anything. False makes
    // `transitions`, `completed`, `edits` and the assignment counts absences
    // rather than zeroes; `created` and `createdIssues` are unaffected, since
    // they never needed a history.
    historyKnown: hasHistory,
  }));

  // By name, never by output. The unassigned bucket sorts last: it is not a
  // person. Same ordering rule as `buildRecap`, for the same reason.
  buckets.sort((a, b) => {
    const aGhost = a.key === UNASSIGNED;
    const bGhost = b.key === UNASSIGNED;
    if (aGhost !== bGhost) return aGhost ? 1 : -1;
    return String(a.label).localeCompare(String(b.label));
  });

  return {
    window: {
      from: from ? new Date(from).toISOString() : "",
      to: Number.isFinite(to) ? new Date(to).toISOString() : "",
    },
    byPerson: buckets,
    // Whether *any* issue carried a history at all. The difference between
    // "nobody did anything" and "the history was never fetched" is the whole
    // question a panel has to answer before printing a zero.
    hasHistory,

    // Issues whose history Jira truncated, so the screen and the document can
    // say the counts are a floor rather than print an undercount as a whole.
    truncated,
  };
}

// One person's activity out of a built model, or null when the model has nothing
// to answer with for them. Null and zero are different facts and the UI shows
// them differently — the same contract `statsFor` keeps in `js/github.js`.
//
// The two halves of this model have different availability, which is why the
// gate is not a single flag. Issues created come from `fields.creator` and are
// known whenever the issues were fetched at all; everything else comes from the
// changelog expand and is knowable only if a history arrived. So a bucket built
// purely from creations is a real answer for `created` while its transition
// count is an absence, and `historyKnown` on the bucket is what lets a panel
// print one and dash the other rather than showing a zero it cannot stand
// behind.
export function activityFor(activity, accountId) {
  if (!activity || !accountId) return null;
  const found = activity.byPerson.find((p) => p.key === String(accountId));
  if (found) return found;
  // Nobody by that id in the model. With a history fetched that is a genuine
  // zero — they did nothing in the window. Without one there is nothing to
  // answer from at all.
  if (!activity.hasHistory) return null;
  return { ...emptyBucket(String(accountId), ""), historyKnown: true };
}
