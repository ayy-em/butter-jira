// Quarterly overview model — the figures behind quarter.html, as a pure function
// over what the page fetched, so it tests without a browser or a network.
//
// ── What it counts, settled 2026-09-29 when the document was scoped ──────────
//
//   * **Calendar quarters, ISO weeks.** A week runs Monday to Sunday and belongs
//     to every quarter it overlaps; the first and last are clipped to the
//     quarter's own dates and marked partial, so a three-day week does not read
//     as a slow one. A quarter still running stops at today.
//   * **Jira activity is a weighted sum**, per week and per person:
//     comments + 3 × tickets closed + tickets opened + 3 × epics closed. The
//     weights live in `JIRA_WEIGHTS` and are printed on the document, so the
//     number never has to be taken on trust.
//   * **A close is credited to the assignee at the moment it closed**, not to
//     whoever moved the card — that is often a lead tidying the board. Reopened
//     and re-closed inside the quarter counts once, at its last close.
//   * **Commits to main are every commit in the default branch's history**,
//     including each commit inside a merged pull request. Lines to main keep the
//     app's one definition (`statsFor`): merged pull-request diffs plus direct
//     pushes, because a merge commit's diff restates its pull request's.
//   * **Sub-tasks count for comments only.** Their open and close restate the
//     parent's, the rule every other screen already follows. Epics are counted
//     as epics, never as tickets.
//   * **Charts leave out weeks with fewer than three whole days** inside the
//     quarter so far (usually the first and last); every figure still counts
//     them.
//   * **The team is the roster.** Team figures are the sum of the per-person
//     rows, so the summary table and the per-person table cannot disagree. With
//     no roster, everyone who appears in the Jira data is a row.
//
// **Per person, deliberately.** This reverses the 2026-09-03 rule that kept
// quarter-length line and pull-request counts team-level, and
// — asked for the same day — the per-person table is ordered by `rankPeople`, a
// weighted sum of each person's rank on Jira activity, commits to main and
// lines to main, rather than by name. The small multiples stay in name order.
// The document keeps its not-an-assessment footer.

import { doneResolver } from "./activity.js";
import { isEpic, isSubtask } from "./monitor.js";
import { statsFor } from "./github.js";

export const JIRA_WEIGHTS = { comments: 1, closed: 3, opened: 1, epicsClosed: 3 };

const DAY_MS = 86400000;
export const MIN_CHART_DAYS = 3;

const msOf = (iso) => {
  if (!iso) return 0;
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

// ── Quarters and weeks ──────────────────────────────────────────────────────

// The calendar quarter containing a date, in local time: the site's week and
// the reader's week are the same week.
export function quarterOf(date) {
  const d = new Date(date);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return quarterNamed(d.getFullYear(), q);
}

export function quarterNamed(year, q) {
  const start = new Date(year, (q - 1) * 3, 1);
  const end = new Date(year, q * 3, 1); // exclusive
  return { year, q, key: `${year}-Q${q}`, label: `Q${q} ${year}`, start, end };
}

// `current`, `previous`, or an explicit `2026-Q3`. Anything else is the current
// quarter, which is what the dashboard's menu item opens.
export function resolveQuarter(param = "current", now = new Date()) {
  const text = String(param || "current").trim().toLowerCase();
  const current = quarterOf(now);
  let quarter = current;
  const named = /^(\d{4})-?q([1-4])$/.exec(text);
  if (named) quarter = quarterNamed(Number(named[1]), Number(named[2]));
  else if (text === "previous") {
    quarter = current.q === 1 ? quarterNamed(current.year - 1, 4) : quarterNamed(current.year, current.q - 1);
  }
  const running = now.getTime() < quarter.end.getTime();
  return {
    ...quarter,
    running,
    // Where the figures stop: today for a quarter still running, its end for
    // one that is over. A quarter in the future has nothing to count.
    until: running ? new Date(Math.max(quarter.start.getTime(), now.getTime())) : quarter.end,
    future: now.getTime() < quarter.start.getTime(),
  };
}

// ISO 8601 week number: the week containing the year's first Thursday is 1.
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

// Every ISO week overlapping [start, until), clipped to it.
export function weeksIn(start, until) {
  const weeks = [];
  const from = start.getTime();
  const to = until.getTime();
  for (let monday = mondayOf(start); monday.getTime() < to; ) {
    const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
    const wStart = Math.max(monday.getTime(), from);
    const wEnd = Math.min(next.getTime(), to);
    weeks.push({
      key: `W${isoWeek(monday)}`,
      monday: new Date(monday),
      start: new Date(wStart),
      end: new Date(wEnd),
      days: Math.round((wEnd - wStart) / DAY_MS),
      partial: wEnd - wStart < 7 * DAY_MS - 3600000, // an hour of slack for DST
      // Whole days of the week that fall inside the quarter and have already
      // happened. A week with fewer than `MIN_CHART_DAYS` of them is left off
      // the charts — two days of a week plotted beside full ones reads as a
      // collapse — but its events still count in every figure.
      charted: Math.floor((wEnd - wStart + 3600000) / DAY_MS) >= MIN_CHART_DAYS,
    });
    monday = next;
  }
  return weeks;
}

function weekIndexer(weeks) {
  return (iso) => {
    const at = msOf(iso);
    if (!at) return -1;
    for (let i = 0; i < weeks.length; i++) {
      if (at >= weeks[i].start.getTime() && at < weeks[i].end.getTime()) return i;
    }
    return -1;
  };
}

// ── Jira ────────────────────────────────────────────────────────────────────

// Who held an issue at a given moment. The assignee changes after that moment
// are walked back: the first one's `from` is who held it then. None after it
// means the current assignee did.
export function assigneeAt(issue, iso) {
  const at = msOf(iso);
  const later = (issue?.history?.events || [])
    .filter((e) => e.kind === "assignee" && msOf(e.at) > at)
    .sort((a, b) => msOf(a.at) - msOf(b.at));
  if (later.length) return later[0].fromId ? String(later[0].fromId) : "";
  return issue?.fields?.assignee?.accountId ? String(issue.fields.assignee.accountId) : "";
}

// The moment an issue closed inside the window, or 0. The last not-done → done
// transition in the window, so a reopen-and-reclose counts at its final close.
// An issue with no history at all falls back to its resolution date, if it is
// done now — the only thing a site without the changelog expand can say.
function closedAt(issue, isDoneStatus, inWindow) {
  const events = issue?.history?.events;
  if (Array.isArray(events)) {
    let last = 0;
    for (const e of events) {
      if (e.kind !== "status" || !inWindow(e.at)) continue;
      if (isDoneStatus(e.to) && !isDoneStatus(e.from)) last = Math.max(last, msOf(e.at));
    }
    if (last) return last;
    // History present but truncated: the close may be in the part Jira did not
    // return. The resolution date is the fallback there too.
    if (!issue.history.truncated) return 0;
  }
  const resolved = issue?.fields?.resolutiondate;
  const doneNow = issue?.fields?.status?.statusCategory?.key === "done";
  return doneNow && inWindow(resolved) ? msOf(resolved) : 0;
}

function blankWeeks(n) {
  return Array.from({ length: n }, () => ({
    comments: 0, opened: 0, closed: 0, epicsClosed: 0, commits: 0,
  }));
}

export function jiraScore(c) {
  return (
    JIRA_WEIGHTS.comments * (c.comments || 0) +
    JIRA_WEIGHTS.closed * (c.closed || 0) +
    JIRA_WEIGHTS.opened * (c.opened || 0) +
    JIRA_WEIGHTS.epicsClosed * (c.epicsClosed || 0)
  );
}

const fold = (login) => String(login || "").trim().toLowerCase();

// ── The model ───────────────────────────────────────────────────────────────

// `members` are roster entries — { accountId, label, githubLogin } — and are
// the rows. `stats` is `getQuarterStats`' answer, or null when GitHub is off or
// failed; every GitHub figure is then null rather than zero.
export function buildQuarter({
  quarter,
  issues = [],
  epicsInProgress = [],
  stats = null,
  members = [],
  statusGroups = [],
  labelFor = (id) => id,
  now = new Date(),
} = {}) {
  const from = quarter.start.getTime();
  const to = quarter.until.getTime();
  const inWindow = (iso) => {
    const at = msOf(iso);
    return at > 0 && at >= from && at < to;
  };
  const weeks = weeksIn(quarter.start, quarter.until);
  const weekOf = weekIndexer(weeks);
  const isDoneStatus = doneResolver(issues, statusGroups);

  // Rows. A roster decides who they are; without one, whoever turns up.
  const rosterMode = members.length > 0;
  const people = new Map();
  const personFor = (accountId, label) => {
    const id = String(accountId || "");
    if (!id) return null;
    if (!people.has(id)) {
      if (rosterMode) return null;
      people.set(id, { accountId: id, label: label || labelFor(id) || id, githubLogin: "" });
    }
    return people.get(id);
  };
  for (const m of members) {
    people.set(String(m.accountId), { accountId: String(m.accountId), label: m.label, githubLogin: m.githubLogin || "" });
  }
  const tallies = new Map(); // accountId -> weekly array
  const tally = (id) => {
    if (!tallies.has(id)) tallies.set(id, blankWeeks(weeks.length));
    return tallies.get(id);
  };

  const epicsClosed = [];
  const outside = { comments: 0, opened: 0, closed: 0, epicsClosed: 0, commits: 0 };
  let unassignedClosures = 0;
  const historyTruncated = [];
  const commentsTruncated = [];
  const hasHistory = issues.some((i) => i?.history);

  const credit = (accountId, field, iso, fallbackLabel) => {
    const w = weekOf(iso);
    if (w < 0) return;
    const person = personFor(accountId, fallbackLabel);
    if (!person) {
      outside[field]++;
      return;
    }
    tally(person.accountId)[w][field]++;
  };

  for (const issue of issues) {
    if (!issue) continue;
    const key = issue.key || "";
    if (issue.history?.truncated) historyTruncated.push(key);
    if (issue.comments?.truncated) commentsTruncated.push(key);

    for (const c of issue.comments?.events || []) {
      if (!c.by || !inWindow(c.at)) continue;
      credit(c.by, "comments", c.at, c.name);
    }

    if (isSubtask(issue)) continue;
    const epic = isEpic(issue);

    const creator = issue.fields?.creator || issue.fields?.reporter;
    if (!epic && creator?.accountId && inWindow(issue.fields?.created)) {
      credit(creator.accountId, "opened", issue.fields.created, creator.displayName);
    }

    const closed = closedAt(issue, isDoneStatus, inWindow);
    if (!closed) continue;
    const iso = new Date(closed).toISOString();
    const holder = assigneeAt(issue, iso);
    if (epic) {
      epicsClosed.push({
        key,
        summary: issue.fields?.summary || "",
        closedAt: iso,
        assignee: holder ? people.get(holder)?.label || labelFor(holder) || "" : "",
        board: issue.boardName || "",
      });
    }
    if (!holder) {
      if (!epic) unassignedClosures++;
      continue;
    }
    credit(holder, epic ? "epicsClosed" : "closed", iso, issue.fields?.assignee?.displayName);
  }

  // ── GitHub ──
  const githubKnown = Boolean(stats);
  const byLogin = new Map();
  for (const p of people.values()) if (p.githubLogin) byLogin.set(fold(p.githubLogin), p);
  if (githubKnown) {
    for (const commit of stats.mainHistory || []) {
      if (!inWindow(commit.committedDate)) continue;
      const person = byLogin.get(fold(commit.author));
      const w = weekOf(commit.committedDate);
      if (w < 0) continue;
      if (person) tally(person.accountId)[w].commits++;
      else outside.commits++;
    }
  }
  const since = quarter.start.toISOString();
  const until = quarter.until.toISOString();

  // ── Rows ──
  const rows = [...people.values()]
    .map((p) => {
      const weekly = tally(p.accountId);
      const sum = (f) => weekly.reduce((n, w) => n + w[f], 0);
      const gh = githubKnown && p.githubLogin ? statsFor(stats, p.githubLogin, { since, until }) : null;
      const jira = {
        opened: sum("opened"),
        closed: sum("closed"),
        comments: sum("comments"),
        epicsClosed: sum("epicsClosed"),
      };
      return {
        accountId: p.accountId,
        label: p.label,
        githubLogin: p.githubLogin,
        weekly: weekly.map((w) => ({ jira: jiraScore(w), commits: githubKnown && p.githubLogin ? w.commits : null })),
        jira: { ...jira, score: jiraScore(jira) },
        github: gh
          ? {
              prsOpened: gh.prsOpened,
              commits: sum("commits"),
              reviews: gh.reviews,
              additions: gh.additions,
              deletions: gh.deletions,
              lines: gh.lines,
            }
          : null,
      };
    })
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  // ── Team ── the sum of the rows, week by week.
  const teamWeekly = weeks.map((week, i) => {
    const c = { comments: 0, opened: 0, closed: 0, epicsClosed: 0, commits: 0 };
    for (const p of people.values()) {
      const w = tally(p.accountId)[i];
      for (const f of Object.keys(c)) c[f] += w[f];
    }
    return { ...week, ...c, jira: jiraScore(c), github: githubKnown ? c.commits : null };
  });

  const total = (f) => teamWeekly.reduce((n, w) => n + w[f], 0);
  const withGithub = rows.filter((r) => r.github);
  const ghTotal = (f) => withGithub.reduce((n, r) => n + r.github[f], 0);
  const fullWeeks = teamWeekly.filter((w) => !w.partial);
  const avg = (f) => (fullWeeks.length ? fullWeeks.reduce((n, w) => n + (w[f] || 0), 0) / fullWeeks.length : null);

  const team = {
    opened: total("opened"),
    closed: total("closed"),
    comments: total("comments"),
    epicsClosed: total("epicsClosed"),
    jiraScore: total("jira"),
    jiraPerWeek: avg("jira"),
    github: githubKnown
      ? {
          commits: total("commits"),
          commitsPerWeek: avg("commits"),
          prsOpened: ghTotal("prsOpened"),
          reviews: ghTotal("reviews"),
          additions: ghTotal("additions"),
          deletions: ghTotal("deletions"),
          lines: ghTotal("lines"),
        }
      : null,
  };

  epicsClosed.sort((a, b) => msOf(a.closedAt) - msOf(b.closedAt));
  const closedKeys = new Set(epicsClosed.map((e) => e.key));
  const inProgress = (epicsInProgress || [])
    .filter((e) => e && !closedKeys.has(e.key))
    .map((e) => ({
      key: e.key,
      summary: e.fields?.summary || "",
      status: e.fields?.status?.name || "",
      assignee: e.fields?.assignee
        ? people.get(String(e.fields.assignee.accountId))?.label || e.fields.assignee.displayName || ""
        : "",
      board: e.boardName || "",
    }));

  return {
    quarter,
    weeks: teamWeekly,
    team,
    people: rows,
    epicsClosed,
    epicsInProgress: inProgress,
    rosterMode,
    notes: {
      hasHistory,
      historyTruncated,
      commentsTruncated,
      unassignedClosures,
      outside,
      unmapped: rows.filter((r) => !r.githubLogin).length,
      github: stats
        ? {
            from: stats.since,
            clamped: msOf(stats.since) > from,
            truncated: stats.truncated || [],
            failures: stats.failures || [],
            unattributedCommits: stats.unattributedCommits || 0,
          }
        : null,
    },
    generatedAt: now.toISOString(),
  };
}

// ── Ordering the per-person table ───────────────────────────────────────────
//
// Each person is ranked on three quarter totals — Jira activity score, commits
// to main, lines to main — highest first, with ties sharing a rank (1, 2, 2, 4).
// The ranks are weighted and summed, and the lowest sum leads. Ranks rather than
// raw figures, so lines of code (thousands) cannot drown the other two (tens).
// A missing GitHub figure ranks as zero: no login is not a reason to sort first.
export const RANK_WEIGHTS = { jira: 1, commits: 1, lines: 1 };

function competitionRanks(values) {
  return values.map((v) => 1 + values.filter((other) => other > v).length);
}

export function rankPeople(rows = [], weights = RANK_WEIGHTS) {
  const metric = {
    jira: rows.map((r) => r.jira?.score || 0),
    commits: rows.map((r) => r.github?.commits || 0),
    lines: rows.map((r) => r.github?.lines || 0),
  };
  const ranks = Object.fromEntries(Object.entries(metric).map(([k, v]) => [k, competitionRanks(v)]));
  return rows
    .map((row, i) => ({
      ...row,
      ranks: { jira: ranks.jira[i], commits: ranks.commits[i], lines: ranks.lines[i] },
      rankScore:
        (weights.jira || 0) * ranks.jira[i] +
        (weights.commits || 0) * ranks.commits[i] +
        (weights.lines || 0) * ranks.lines[i],
    }))
    .sort((a, b) => a.rankScore - b.rankScore || String(a.label).localeCompare(String(b.label)));
}
