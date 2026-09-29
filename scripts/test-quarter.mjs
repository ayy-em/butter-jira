#!/usr/bin/env node
// Unit checks for the quarterly overview model: quarter and ISO-week bounds,
// the weighted Jira score, close credit to the assignee at the time, sub-task
// and epic handling, commits to main from the full default-branch history, and
// the team row being the sum of the people rows. No network, no browser.
//
// Usage: node scripts/test-quarter.mjs

const store = {};
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: {
      get: async (k) => (k == null ? { ...store } : Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, store[x]]))),
      set: async (o) => { Object.assign(store, o); },
      remove: async () => {},
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const q = await import(new URL("../js/quarter.js", import.meta.url));
const api = await import(new URL("../js/api.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (title) => console.log(`\n── ${title} ──`);

// ── Quarters ──
section("quarters");
const now = new Date(2026, 8, 29, 12); // 2026-09-29
const cur = q.resolveQuarter("current", now);
check("current quarter is Q3 2026", cur.key === "2026-Q3");
check("current quarter is running and stops today", cur.running && cur.until.getTime() === now.getTime());
const prev = q.resolveQuarter("previous", now);
check("previous quarter is Q2 2026", prev.key === "2026-Q2" && !prev.running);
check("previous quarter ends 1 July exclusive", prev.until.getTime() === new Date(2026, 6, 1).getTime());
check("Q1 previous wraps the year", q.resolveQuarter("previous", new Date(2026, 1, 3)).key === "2025-Q4");
check("explicit key parses", q.resolveQuarter("2025-q2", now).key === "2025-Q2");
check("a future quarter is flagged", q.resolveQuarter("2027-Q1", now).future);

// ── Weeks ──
section("ISO weeks");
check("2026-01-01 is ISO week 1", q.isoWeek(new Date(2026, 0, 1)) === 1);
check("2026-09-29 is ISO week 40", q.isoWeek(new Date(2026, 8, 29)) === 40);
const q3 = q.quarterNamed(2026, 3);
const weeks = q.weeksIn(q3.start, q3.end);
check("Q3 2026 spans 14 ISO weeks (W27..W40)", weeks.length === 14 && weeks[0].key === "W27" && weeks[13].key === "W40");
check("first week is clipped to 1 July and partial", weeks[0].start.getTime() === q3.start.getTime() && weeks[0].partial);
check("a middle week is whole", !weeks[5].partial && weeks[5].days === 7);
check("last week is clipped to 30 Sept", weeks[13].partial && weeks[13].days === 3);

// ── Score ──
section("Jira score");
check("weights: comments + 3×closed + opened + 3×epics", q.jiraScore({ comments: 2, closed: 1, opened: 4, epicsClosed: 1 }) === 2 + 3 + 4 + 3);

// ── Model ──
section("model");
const at = (m, d, h = 12) => new Date(2026, m - 1, d, h).toISOString();
const done = { name: "Done", statusCategory: { key: "done" } };
const doing = { name: "In Progress", statusCategory: { key: "indeterminate" } };
const person = (id) => ({ accountId: id, displayName: id.toUpperCase() });
const story = { name: "Story", hierarchyLevel: 0 };
const epicType = { name: "Epic", hierarchyLevel: 1 };
const subtask = { name: "Sub-task", subtask: true, hierarchyLevel: -1 };
const statusEvent = (when, by, from, to) => ({ at: when, by, kind: "status", field: "status", from, to, fromId: "", toId: "" });
const assignEvent = (when, by, fromId, toId) => ({ at: when, by, kind: "assignee", field: "assignee", from: "", to: "", fromId, toId });

const issues = [
  // Opened by a, closed by lead while assigned to b; later reassigned to c.
  {
    key: "A-1",
    fields: { issuetype: story, status: done, created: at(7, 6), creator: person("a"), assignee: person("c"), summary: "One" },
    history: {
      events: [
        statusEvent(at(7, 8), "lead", "In Progress", "Done"),
        assignEvent(at(7, 20), "lead", "b", "c"),
      ],
      truncated: false,
    },
    comments: { events: [{ by: "a", at: at(7, 7) }, { by: "b", at: at(7, 8) }, { by: "b", at: at(6, 1) }], truncated: false },
  },
  // Reopened and re-closed: counts once, at the last close.
  {
    key: "A-2",
    fields: { issuetype: story, status: done, created: at(5, 1), creator: person("b"), assignee: person("a") },
    history: {
      events: [
        statusEvent(at(7, 14), "a", "In Progress", "Done"),
        statusEvent(at(7, 15), "a", "Done", "In Progress"),
        statusEvent(at(8, 4), "a", "In Progress", "Done"),
      ],
      truncated: false,
    },
  },
  // Sub-task: its close does not count, its comment does.
  {
    key: "A-3",
    fields: { issuetype: subtask, status: done, created: at(7, 9), creator: person("a"), assignee: person("a") },
    history: { events: [statusEvent(at(7, 10), "a", "In Progress", "Done")], truncated: false },
    comments: { events: [{ by: "a", at: at(7, 10) }], truncated: false },
  },
  // Epic closed by b, not a ticket.
  {
    key: "A-4",
    fields: { issuetype: epicType, status: done, created: at(7, 2), creator: person("b"), assignee: person("b"), summary: "Big thing" },
    history: { events: [statusEvent(at(9, 1), "b", "In Progress", "Done")], truncated: false },
  },
  // No history: resolution date fallback, current assignee.
  {
    key: "A-5",
    fields: { issuetype: story, status: done, created: at(4, 1), creator: person("a"), assignee: person("b"), resolutiondate: at(8, 12) },
  },
  // Closed by someone off the roster.
  {
    key: "A-6",
    fields: { issuetype: story, status: doing, created: at(7, 22), creator: person("x"), assignee: person("x") },
    history: { events: [], truncated: false },
  },
];

const stats = {
  since: q3.start.toISOString(),
  pullRequests: [
    { author: "alice", createdAt: at(7, 3), mergedAt: at(7, 4), toDefaultBranch: true, additions: 100, deletions: 20 },
    { author: "bob", createdAt: at(6, 3), mergedAt: at(7, 4), toDefaultBranch: true, additions: 5, deletions: 5 },
  ],
  reviews: [
    { author: "bob", prAuthor: "alice", submittedAt: at(7, 4), comments: 0 },
    { author: "alice", prAuthor: "alice", submittedAt: at(7, 4), comments: 0 },
  ],
  comments: [],
  commits: [{ author: "bob", committedDate: at(7, 21), additions: 7, deletions: 3 }],
  mainHistory: [
    { author: "alice", committedDate: at(7, 4), viaPr: true },
    { author: "Alice", committedDate: at(7, 4), viaPr: true },
    { author: "bob", committedDate: at(7, 21), viaPr: false },
    { author: "stranger", committedDate: at(7, 21), viaPr: false },
    { author: "bob", committedDate: at(6, 20), viaPr: false },
  ],
  truncated: [],
  failures: [],
  unattributedCommits: 2,
};

const members = [
  { accountId: "b", label: "Bea", githubLogin: "bob" },
  { accountId: "a", label: "Al", githubLogin: "alice" },
  { accountId: "c", label: "Cy", githubLogin: "" },
];

const model = q.buildQuarter({ quarter: q.resolveQuarter("2026-Q3", now), issues, stats, members, now });
const row = (id) => model.people.find((p) => p.accountId === id);

check("rows are ordered by name", model.people.map((p) => p.label).join(",") === "Al,Bea,Cy");
check("a opened A-1 and the sub-task is not counted", row("a").jira.opened === 1);
check("A-1 close goes to b (assignee at close), not the lead or c", row("b").jira.closed >= 1 && row("c").jira.closed === 0);
check("reopened A-2 counts once, for a", row("a").jira.closed === 1);
check("A-5 falls back to resolution date and current assignee b", row("b").jira.closed === 2);
check("epic close is counted as an epic for b", row("b").jira.epicsClosed === 1 && model.epicsClosed[0]?.key === "A-4");
check("comments: a has 2 (incl. sub-task), b has 1 in-quarter", row("a").jira.comments === 2 && row("b").jira.comments === 1);
check("b's score = 1 comment + 3×2 closed + 0 opened + 3×1 epic", row("b").jira.score === 1 + 6 + 0 + 3);
check("off-roster activity is left out and counted", model.notes.outside.opened === 1);
check("commits: every main-history commit, case-insensitive login", row("a").github.commits === 2);
check("commits outside the quarter are dropped", row("b").github.commits === 1);
check("PRs opened only inside the quarter", row("a").github.prsOpened === 1 && row("b").github.prsOpened === 0);
check("own-PR reviews are not counted", row("b").github.reviews === 1 && row("a").github.reviews === 0);
check("lines = merged PR diffs + direct pushes", row("a").github.lines === 120 && row("b").github.lines === 20);
check("a person with no login has null GitHub, not zero", row("c").github === null && row("c").weekly.every((w) => w.commits === null));
check("team commits = sum of rows", model.team.github.commits === 3);
check("team closed = sum of rows", model.team.closed === model.people.reduce((n, p) => n + p.jira.closed, 0));
check("team Jira score = sum of weekly scores", model.team.jiraScore === model.weeks.reduce((n, w) => n + w.jira, 0));
check("weekly series spans every week", model.weeks.length === 13 + 1 && row("a").weekly.length === model.weeks.length);
check("A-1's close lands in W28 for b", model.people.find((p) => p.accountId === "b").weekly[1].jira >= 3);

const noGh = q.buildQuarter({ quarter: q.resolveQuarter("2026-Q3", now), issues, stats: null, members, now });
check("without GitHub, team github is null", noGh.team.github === null && noGh.weeks.every((w) => w.github === null));

const noRoster = q.buildQuarter({ quarter: q.resolveQuarter("2026-Q3", now), issues, members: [], now, labelFor: (id) => id.toUpperCase() });
check("with no roster, everyone seen is a row", noRoster.people.some((p) => p.accountId === "x") && !noRoster.rosterMode);

section("weeks on the charts");
const running = q.weeksIn(q3.start, new Date(2026, 8, 29, 12));
check("a 5-day first week is charted", running[0].charted);
check("a week with 1 full day so far is left off", !running[running.length - 1].charted);
check("the closed quarter's 3-day last week is charted", weeks[13].charted);
check("a 2-day week is left off", !q.weeksIn(new Date(2026, 9, 3), new Date(2026, 9, 5))[0].charted);
check("left-off weeks still count in totals", model.weeks.length === 14);

section("ranking the per-person table");
const rows = [
  { label: "Al", jira: { score: 50 }, github: { commits: 10, lines: 100 } },
  { label: "Bea", jira: { score: 40 }, github: { commits: 30, lines: 5000 } },
  { label: "Cy", jira: { score: 90 }, github: null },
  { label: "Di", jira: { score: 40 }, github: { commits: 30, lines: 5000 } },
];
const ranked = q.rankPeople(rows);
check("ranks per metric, ties share (competition ranking)", ranked.find((r) => r.label === "Bea").ranks.jira === 3 && ranked.find((r) => r.label === "Di").ranks.jira === 3);
check("combined = sum of ranks, lowest first", ranked.map((r) => r.label).join(",") === "Bea,Di,Al,Cy");
check("no GitHub ranks as zero, not first", ranked.find((r) => r.label === "Cy").ranks.commits === 4);
check("weights apply", q.rankPeople(rows, { jira: 10, commits: 1, lines: 1 })[0].label === "Cy");
check("input not mutated", !("ranks" in rows[0]));

section("chart scale");
const charts = await import(new URL("../js/charts.js", import.meta.url));
const sc = (v, t) => charts.niceScale(v, t);
check("110 over 4 ticks → 0..125 by 25", sc(110, 4).max === 125 && sc(110, 4).step === 25);
check("33 over 4 ticks → 0..40 by 10", sc(33, 4).max === 40 && sc(33, 4).step === 10);
check("small counts step by whole numbers", sc(2, 3).step === 1 && sc(2, 3).max === 2);
check("zero data still draws an axis", sc(0, 3).max === 3);

section("assignee at a moment");
check("walks back to the holder at the time", q.assigneeAt(issues[0], at(7, 8)) === "b");
check("after the last change it is the current assignee", q.assigneeAt(issues[0], at(7, 25)) === "c");

section("comment compaction");
const compact = api.compactComments({ fields: { comment: { total: 3, comments: [{ author: { accountId: "a", displayName: "A" }, created: at(7, 1), body: "x" }] } } });
check("keeps author and date only", compact.events.length === 1 && compact.events[0].by === "a" && !("body" in compact.events[0]));
check("flags a short page as truncated", compact.truncated);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
