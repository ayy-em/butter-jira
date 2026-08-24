// Sprint recap model.
//
// One pure function over what the dashboard already fetched — sprint issues, the
// active sprint objects, and the GitHub window — producing everything the recap
// document prints. No DOM, no storage, no network, so the whole artefact is
// testable without a browser and the renderer stays a renderer.
//
// It deliberately re-uses `summarize()` rather than recomputing: a recap that
// disagreed with the dashboard it was generated from would be worse than no
// recap. What this adds is the three things `summarize` has no reason to keep —
// per-issue provenance (scope creep, carry-in), per-person GitHub detail, and
// the board-by-board split with sprint names and dates attached.
//
// **Framing, decided rather than drifted into.** The per-person cards are
// ordered by name, never by output, and the heading over them says
// "contribution", not "performance". The roadmap's own rule for M10 and M14 is
// that this kind of per-colleague number is conversation fuel for a retro and
// not a score. The at-a-glance table above them is the one exception, sorted by
// story-point completion on request: it is a table of figures being scanned for
// where the points went, and the cards — the part that is read as being about
// people — stay alphabetical. `people` is returned in name order and the
// renderer re-sorts its own copy, so nothing else inherits the ranking.

import { reviewOrDone, wasAddedAfterStart, wasCarriedIn } from "./dashboard.js";
import { statsFor } from "./github.js";
import { activityFor as jiraActivityFor, activityFrom as jiraActivityFrom } from "./activity.js";
import { getStoryPoints, resolveStatusGroup } from "./utils.js";
import { avatarOverrideFor, displayNameFor, isOnTeam, memberFor } from "./team.js";
import { isDone, isSubtask } from "./monitor.js";

// Calendar length of the sprint window, inclusive, in days. Reported beside the
// working-day count because a retro talks about both: "two weeks" is the
// calendar, "ten days" is the capacity.
export function calendarDays(start, end) {
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 86400000) + 1;
}

// A percentage, or null when the denominator is zero. Null prints as a dash: no
// estimates is not the same fact as no progress.
export function share(part, whole) {
  return whole > 0 ? part / whole : null;
}

// The avatar to print for a person: a roster photo first, then whatever Jira
// has, then nothing — the renderer draws initials in that case rather than
// leaving a hole. 48px because this is print, where a 24px avatar is a smudge.
export function avatarFor(accountId, assignee) {
  const override = avatarOverrideFor(accountId);
  if (override) return override;
  const urls = assignee?.avatarUrls;
  if (!urls) return "";
  return urls["48x48"] || urls["32x32"] || urls["24x24"] || "";
}

export function buildRecap({
  summary,
  issues = [],
  boardSprints = [],
  statusGroups = [],
  stats = null,
  since = "",
  now = new Date(),
} = {}) {
  // Sub-tasks are excluded here for the same reason `summarize` excludes them:
  // their points duplicate the parent's. Counting them in the ticket list but
  // not the totals would make the two disagree.
  const counted = issues.filter((issue) => !isSubtask(issue));

  // Per-person Jira activity over the sprint window — who moved which ticket,
  // who picked work up, who created what appeared after the start. Derived from
  // the issue history that rode the same fetch, so the block costs the document
  // no requests. Windowed on the sprint's own start, which is the window every
  // other figure on the page uses.
  const activity = jiraActivityFrom(counted, {
    since: summary.window?.start || "",
    statusGroups,
  });
  const activeSprintIds = boardSprints
    .flatMap(({ sprints = [] }) => sprints.map((s) => s?.id))
    .filter((id) => id !== undefined);

  const boardName = new Map(boardSprints.map(({ board }) => [board.id, board.name]));
  const boardColor = new Map(boardSprints.map(({ board }) => [board.id, board.color]));

  // One pass for everything per-issue: the ticket list, the per-person and
  // per-board creep counts, and the avatar lookup.
  const tickets = [];
  const perPerson = new Map();
  const perBoard = new Map();
  const avatars = new Map();

  for (const issue of counted) {
    const assignee = issue.fields?.assignee || null;
    const accountId = assignee?.accountId || "__unassigned__";
    if (assignee && !avatars.has(accountId)) {
      avatars.set(accountId, avatarFor(accountId, assignee));
    }

    const points = getStoryPoints(issue);
    const addedAfterStart = wasAddedAfterStart(issue, summary.window?.start);
    const carriedIn = wasCarriedIn(issue, activeSprintIds);
    const statusName = issue.fields?.status?.name || "";

    tickets.push({
      key: issue.key,
      summary: issue.fields?.summary || "",
      status: statusName,
      statusGroup: resolveStatusGroup(statusName, statusGroups),
      done: isDone(issue),
      points,
      assignee: assignee ? displayNameFor(assignee) : "Unassigned",
      boardId: issue.boardId ?? null,
      board: boardName.get(issue.boardId) || "",
      addedAfterStart,
      carriedIn,
    });

    const person = bump(perPerson, accountId);
    if (addedAfterStart) person.addedAfterStart++;
    if (carriedIn) person.carriedIn++;

    const board = bump(perBoard, issue.boardId ?? "?");
    if (addedAfterStart) board.addedAfterStart++;
    if (carriedIn) board.carriedIn++;
    board.issues++;
    board.points += points ?? 0;
    if (isDone(issue)) {
      board.doneIssues++;
      board.donePoints += points ?? 0;
    }
  }

  // ── People ─────────────────────────────────────────────────────────────────
  // `summary.byPerson` already holds the Jira half, keyed by account id. The
  // GitHub half is looked up per login and is null — not zero — for anyone the
  // window cannot answer for.
  const people = summary.byPerson
    .map((bucket) => {
      const progress = reviewOrDone(bucket);
      const extra = perPerson.get(bucket.key) || bump(new Map(), bucket.key);
      const login = memberFor(bucket.key)?.githubLogin || "";
      const gh = login && stats ? statsFor(stats, login, { since }) : null;
      const jira = jiraActivityFor(activity, bucket.key);
      return {
        accountId: bucket.key,
        label: bucket.label,
        onTeam: bucket.onTeam,
        avatar: avatars.get(bucket.key) || "",
        githubLogin: login,
        tickets: bucket.issues,
        doneIssues: bucket.doneIssues,
        reviewIssues: bucket.reviewIssues,
        reviewOrDoneIssues: progress.issues,
        points: bucket.points,
        donePoints: bucket.donePoints,
        reviewOrDonePoints: progress.points,
        share: progress.share,
        // Issue-based as well as points-based: the summary table leads on issues
        // because it is the figure that exists for everybody, including anyone
        // whose tickets carry no estimate at all.
        issueShare: share(progress.issues, bucket.issues),
        addedAfterStart: extra.addedAfterStart,
        carriedIn: extra.carriedIn,
        github: gh && {
          prsOpened: gh.prsOpened,
          prsMerged: gh.prsMerged,
          directCommits: gh.directCommits,
          reviews: gh.reviews,
          comments: gh.comments,
          lines: gh.lines,
          additions: gh.additions,
          deletions: gh.deletions,
        },
        // What they *did*, as against what was assigned to them. Null — not a
        // row of zeroes — where the site returned no issue history, and
        // `historyKnown` distinguishes the two halves within it: `created`
        // comes from `fields.creator` and is answerable regardless, the rest
        // needs the changelog.
        jira: jira && {
          historyKnown: jira.historyKnown,
          transitions: jira.transitions,
          completed: jira.completed,
          completedIssues: jira.completedIssues.length,
          reopened: jira.reopened,
          pickedUp: jira.pickedUp,
          assignedOut: jira.assignedOut,
          edits: jira.edits,
          created: jira.created,
          touched: jira.touchedIssues.length,
        },
      };
    })
    // By name, never by output — see the note at the top of this file. The
    // unassigned bucket sorts last: it is not a person.
    .sort((a, b) => {
      const aGhost = a.accountId === "__unassigned__";
      const bGhost = b.accountId === "__unassigned__";
      if (aGhost !== bGhost) return aGhost ? 1 : -1;
      return a.label.localeCompare(b.label);
    });

  // ── Boards ─────────────────────────────────────────────────────────────────
  // One block per board rather than per sprint: issues carry a board id, not a
  // sprint id, so a board running two active sprints at once has them listed
  // together rather than split on a guess.
  const boards = boardSprints.map(({ board, sprints = [] }) => {
    const bucket = perBoard.get(board.id) || bump(new Map(), board.id);
    const named = sprints.filter(Boolean);
    return {
      id: board.id,
      name: board.name,
      color: board.color,
      sprints: named.map((s) => ({
        name: s.name || "",
        goal: (s.goal || "").trim(),
        start: s.startDate || "",
        end: s.endDate || "",
      })),
      issues: bucket.issues,
      points: bucket.points,
      doneIssues: bucket.doneIssues,
      donePoints: bucket.donePoints,
      completion: share(bucket.donePoints, bucket.points),
      addedAfterStart: bucket.addedAfterStart,
      carriedIn: bucket.carriedIn,
    };
  });

  // ── Tickets ────────────────────────────────────────────────────────────────
  // Grouped the way the board reads — configured status order, then key — so the
  // list can be scanned for "what is still open" without re-sorting it.
  const statusOrder = statusGroups.map((g) => g.name);
  const rank = (name) => {
    const i = statusOrder.indexOf(name);
    return i === -1 ? statusOrder.length : i;
  };
  tickets.sort(
    (a, b) =>
      (a.board || "").localeCompare(b.board || "") ||
      rank(a.statusGroup) - rank(b.statusGroup) ||
      a.key.localeCompare(b.key, undefined, { numeric: true })
  );

  // ── Combined ───────────────────────────────────────────────────────────────
  const reviewOrDoneTotals = reviewOrDone(summary.totals);
  const teamPeople = people.filter((p) => p.accountId !== "__unassigned__");
  const withGithub = teamPeople.filter((p) => p.github);
  const withJira = teamPeople.filter((p) => p.jira);
  const sample = withGithub[0]?.github ? statsFor(stats, withGithub[0].githubLogin, { since }) : null;

  return {
    generatedAt: now.toISOString(),
    window: { start: summary.window?.start || null, end: summary.window?.end || null },
    days: {
      working: summary.daysTotal,
      elapsed: summary.daysElapsed,
      remaining: summary.daysRemaining,
      calendar: calendarDays(summary.window?.start, summary.window?.end),
    },
    isOverdue: summary.isOverdue,
    sprintNames: summary.sprintNames,
    goals: summary.goals,
    combined: {
      issues: summary.issueCount,
      // What the sprint set out to do: everything in it now, less whatever was
      // added after it started. The same approximation `addedAfterStart` carries
      // — creation date, not a real start-of-sprint state — so an older issue
      // dragged in mid-sprint still counts as having been there from the off.
      issuesStartedWith: Math.max(0, summary.issueCount - summary.addedAfterStart),
      subtasksExcluded: summary.subtaskCount,
      unestimated: summary.unestimated,
      pointsPlanned: summary.totalPoints,
      pointsDone: summary.donePoints,
      pointsInReview: summary.reviewPoints,
      pointsWrappedUp: reviewOrDoneTotals.points,
      pointsOpen: summary.openPoints,
      issuesDone: summary.doneIssues,
      issuesInReview: summary.reviewIssues,
      issuesWrappedUp: reviewOrDoneTotals.issues,
      completionByPoints: summary.completionByPoints,
      completionByIssues: summary.completionByIssues,
      wrappedUpByPoints: share(reviewOrDoneTotals.points, summary.totalPoints),
      wrappedUpByIssues: share(reviewOrDoneTotals.issues, summary.issueCount),
      addedAfterStart: summary.addedAfterStart,
      addedAfterStartPoints: summary.addedAfterStartPoints,
      scopeCreepShare: share(summary.addedAfterStartPoints, summary.totalPoints),
      carriedIn: summary.carriedIn,
      carriedInPoints: summary.carriedInPoints,
      projectedCarryOut: summary.projectedCarryOut,
      projectedCarryOutPoints: summary.projectedCarryOutPoints,
      // Sums of the per-person GitHub numbers, so the headline and the cards
      // cannot disagree. Null when nobody could be answered for at all.
      github: withGithub.length
        ? {
            people: withGithub.length,
            prsOpened: sumOf(withGithub, "prsOpened"),
            prsMerged: sumOf(withGithub, "prsMerged"),
            directCommits: sumOf(withGithub, "directCommits"),
            reviews: sumOf(withGithub, "reviews"),
            comments: sumOf(withGithub, "comments"),
            lines: sumOf(withGithub, "lines"),
          }
        : null,
      // The same for the Jira half. `created` is summed separately from the
      // rest because it survives a site with no issue history, so a document
      // can print it while dashing the others.
      jira: withJira.length
        ? {
            people: withJira.length,
            historyKnown: activity.hasHistory,
            transitions: sumJira(withJira, "transitions"),
            completed: sumJira(withJira, "completed"),
            reopened: sumJira(withJira, "reopened"),
            pickedUp: sumJira(withJira, "pickedUp"),
            edits: sumJira(withJira, "edits"),
            created: sumJira(withJira, "created"),
          }
        : null,
    },
    byStatus: summary.byStatus.filter((b) => b.issues > 0),
    // Where the per-person activity block stands, so the document can caption
    // it rather than print bare numbers. `truncated` is the one that matters:
    // Jira's changelog expand is bounded per issue and does not paginate, so a
    // long-running ticket's older history is simply not there — and a count
    // built over it is a floor, which the page has to say.
    activity: {
      available: activity.hasHistory,
      from: activity.window.from,
      truncated: activity.truncated,
    },
    people,
    boards,
    tickets,
    github: {
      // Which of the three absent cases this is, because the document has to say
      // so rather than print zeroes: no query, no roster logins, or fine.
      available: Boolean(stats) && withGithub.length > 0,
      queried: Boolean(stats),
      mapped: withGithub.length,
      unmapped: teamPeople.length - withGithub.length,
      since,
      from: sample?.from || "",
      clamped: Boolean(sample?.clamped),
      // A repo that answered for pull requests but not for commits, or one whose
      // history ran past the page cap, makes every figure below it an undercount.
      // Carried through so the document can say so: the whole point of separating
      // an absent number from a zero is lost if a partial answer prints as a
      // whole one.
      failures: (stats?.failures || []).map((f) => ({
        repo: f.repo,
        type: f.type,
        message: f.message,
      })),
      truncated: [...(stats?.truncated || [])],
      reached: [...(stats?.reached || [])],
    },
  };
}

function bump(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      issues: 0,
      points: 0,
      doneIssues: 0,
      donePoints: 0,
      addedAfterStart: 0,
      carriedIn: 0,
    });
  }
  return map.get(key);
}

function sumOf(people, field) {
  return people.reduce((n, person) => n + (person.github?.[field] || 0), 0);
}

function sumJira(people, field) {
  return people.reduce((n, person) => n + (person.jira?.[field] || 0), 0);
}
