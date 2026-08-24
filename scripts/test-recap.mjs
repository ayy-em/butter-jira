#!/usr/bin/env node
// Unit checks for the sprint recap model: the combined figures, per-person
// contribution rows, the board split, the ticket list and its provenance flags,
// and how the document is told that GitHub could not answer. No dependencies, no
// network, no browser — the model is pure, and the renderer reads it.
//
// Usage: node scripts/test-recap.mjs

let sync = {};
let local = {};
const pick = (store, keys) =>
  Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  );

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: {
      get: (keys) => Promise.resolve(keys == null ? { ...sync } : pick(sync, keys)),
      set: (obj) => { Object.assign(sync, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete sync[k]; return Promise.resolve(); },
    },
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete local[k]; return Promise.resolve(); },
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const cfg = await import(new URL("../js/config.js", import.meta.url));
const team = await import(new URL("../js/team.js", import.meta.url));
const dash = await import(new URL("../js/dashboard.js", import.meta.url));
const recapMod = await import(new URL("../js/recap.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (title) => console.log(`\n── ${title} ──`);

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["cf_sp"], sprint: ["cf_sprint"] },
};
local = { schemaVersion: 2 };
await cfg.loadConfig();

// Two roster members: one with a GitHub login and a photo, one with neither.
await team.saveTeam({
  activeTeamId: "default",
  teams: [{
    id: "default",
    name: "Data Engineering",
    members: [
      { accountId: "acc-1", jiraName: "Avery Quinn", githubLogin: "averyq", avatarOverride: "assets/avatars/nobody.png", active: true },
      { accountId: "acc-2", jiraName: "Bo Ferreira", githubLogin: "", active: true },
    ],
  }],
});
await team.loadTeam();

const GROUPS = [
  { name: "To Do", statuses: ["To Do"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "In Code Review", statuses: ["In Code Review"] },
  { name: "Done", statuses: ["Done"] },
];

const SPRINT_A = {
  id: 41, name: "Sprint 41", goal: "Ship the thing",
  startDate: "2026-08-03", endDate: "2026-08-14",
};
const SPRINT_B = {
  id: 18, name: "PLAT 18", goal: "",
  startDate: "2026-08-05", endDate: "2026-08-16",
};
const BOARDS = [
  { id: 1, name: "CTS", color: "#111111" },
  { id: 2, name: "PLAT", color: "#222222" },
];
const BOARD_SPRINTS = [
  { board: BOARDS[0], sprints: [SPRINT_A] },
  { board: BOARDS[1], sprints: [SPRINT_B] },
];

let seq = 0;
function issue(o = {}) {
  const {
    status = "To Do", points = 3, board = 1, account = "acc-1", name = "Avery Quinn",
    created = "2026-08-01", subtask = false, avatarUrls, sprint, key, summary,
    creator, log,
  } = o;
  seq++;
  const category = status === "Done" ? "done" : status === "To Do" ? "new" : "indeterminate";
  const fields = {
    summary: summary || `Issue ${seq}`,
    status: { name: status, statusCategory: { key: category } },
    assignee: account ? { accountId: account, displayName: name, avatarUrls } : null,
    issuetype: { name: subtask ? "Sub-task" : "Story", subtask },
    created,
  };
  if (points !== null) fields.cf_sp = points;
  if (sprint !== undefined) fields.cf_sprint = sprint;
  if (creator) fields.creator = { accountId: creator, displayName: creator };
  const built = { key: key || `CTS-${100 + seq}`, id: String(seq), boardId: board, fields };
  if (log) built.changelog = log;
  return built;
}

// An issue history, in the shape `expand=changelog` returns. `buildRecap` runs
// it through the same compaction the API boundary does, so the fixture is the
// raw shape and not the reduced one.
function log(entries, total = null) {
  return {
    startAt: 0,
    maxResults: entries.length,
    total: total ?? entries.length,
    histories: entries.map(({ by, at, items }) => ({
      id: "h",
      author: by ? { accountId: by, displayName: by } : null,
      created: at,
      items,
    })),
  };
}
const moved = (from, to) => ({
  field: "status", fieldId: "status", from: "1", fromString: from, to: "2", toString: to,
});

// The GitHub window payload, in the shape fetchTeamStats returns.
const STATS = {
  since: "2026-07-01T00:00:00Z",
  pullRequests: [
    { author: "averyq", createdAt: "2026-08-05T00:00:00Z", mergedAt: "2026-08-06T00:00:00Z", toDefaultBranch: true, additions: 100, deletions: 20 },
    { author: "averyq", createdAt: "2026-08-07T00:00:00Z", mergedAt: "", toDefaultBranch: false, additions: 5, deletions: 5 },
  ],
  reviews: [
    { author: "averyq", prAuthor: "someone", submittedAt: "2026-08-06T00:00:00Z", comments: 2 },
  ],
  comments: [
    { author: "averyq", prAuthor: "someone", createdAt: "2026-08-06T00:00:00Z" },
  ],
  commits: [
    { author: "averyq", committedDate: "2026-08-08T00:00:00Z", additions: 30, deletions: 10 },
  ],
};

function build({ issues, stats = STATS, now = new Date("2026-08-10T09:00:00") } = {}) {
  const sprints = [SPRINT_A, SPRINT_B];
  const summary = dash.summarize({ issues, sprints, statusGroups: GROUPS, boards: BOARDS, now });
  return recapMod.buildRecap({
    summary,
    issues,
    boardSprints: BOARD_SPRINTS,
    statusGroups: GROUPS,
    stats,
    since: SPRINT_A.startDate,
    now,
  });
}

section("calendar arithmetic");
check("inclusive of both ends", recapMod.calendarDays("2026-08-03", "2026-08-14") === 12);
check("one day is one day", recapMod.calendarDays("2026-08-03", "2026-08-03") === 1);
check("reversed is zero, not negative", recapMod.calendarDays("2026-08-14", "2026-08-03") === 0);
check("missing dates tolerated", recapMod.calendarDays(null, "2026-08-14") === 0);

section("shares");
check("a share is a fraction", recapMod.share(1, 4) === 0.25);
check("nothing to divide by is null, not zero", recapMod.share(0, 0) === null);
check("null rather than Infinity", recapMod.share(5, 0) === null);

section("avatars");
check("roster photo wins",
  recapMod.avatarFor("acc-1", { avatarUrls: { "48x48": "https://jira/x" } })
    === "chrome-extension://test/assets/avatars/nobody.png");
check("falls back to Jira's own",
  recapMod.avatarFor("acc-2", { avatarUrls: { "48x48": "https://jira/48" } }) === "https://jira/48");
check("then to a smaller Jira size",
  recapMod.avatarFor("acc-2", { avatarUrls: { "24x24": "https://jira/24" } }) === "https://jira/24");
check("and to nothing at all", recapMod.avatarFor("acc-2", null) === "");

section("combined figures");
let recap = build({
  issues: [
    issue({ status: "Done", points: 5 }),
    issue({ status: "In Code Review", points: 3 }),
    issue({ status: "To Do", points: 2, created: "2026-08-06" }),   // after the window start
    issue({ status: "To Do", points: null }),
  ],
});
check("points planned", recap.combined.pointsPlanned === 10);
check("points done", recap.combined.pointsDone === 5);
check("points in review", recap.combined.pointsInReview === 3);
check("wrapped up folds done and in review", recap.combined.pointsWrappedUp === 8);
check("wrapped-up share is points-based", recap.combined.wrappedUpByPoints === 0.8);
check("done share stays separate", recap.combined.completionByPoints === 0.5);
check("issues wrapped up", recap.combined.issuesWrappedUp === 2);
check("scope creep counted", recap.combined.addedAfterStart === 1);
check("scope creep points", recap.combined.addedAfterStartPoints === 2);
check("scope creep as a share of the sprint", recap.combined.scopeCreepShare === 0.2);
check("unestimated surfaced for the caveat", recap.combined.unestimated === 1);
check("issues the sprint started with excludes what crept in",
  recap.combined.issuesStartedWith === 3);
check("and never goes negative",
  build({ issues: [issue({ created: "2026-08-06" })] }).combined.issuesStartedWith === 0);
check("duration in both units",
  recap.days.calendar === 14 && recap.days.working === 10);
check("window is the earliest start across boards",
  new Date(recap.window.start).getDate() === 3);

section("no estimates at all");
recap = build({ issues: [issue({ points: null }), issue({ points: null, status: "Done" })] });
check("wrapped-up share is null, not zero", recap.combined.wrappedUpByPoints === null);
check("creep share is null too", recap.combined.scopeCreepShare === null);

section("people");
recap = build({
  issues: [
    issue({ account: "acc-1", name: "Avery Quinn", status: "Done", points: 5 }),
    issue({ account: "acc-1", name: "Avery Quinn", status: "In Code Review", points: 3, created: "2026-08-06" }),
    issue({ account: "acc-2", name: "Bo Ferreira", status: "To Do", points: 2 }),
    issue({ account: null, status: "To Do", points: 1 }),
  ],
});
check("one row per person, plus the unassigned bucket", recap.people.length === 3);
check("ordered by name", recap.people[0].label === "Avery Quinn" && recap.people[1].label === "Bo Ferreira");
check("the unassigned bucket sorts last, it is not a person",
  recap.people[2].accountId === "__unassigned__");

const avery = recap.people[0];
check("tickets counted", avery.tickets === 2);
check("wrapped up folds done and in review", avery.reviewOrDoneIssues === 2);
check("points wrapped up", avery.reviewOrDonePoints === 8);
check("share is points-based", avery.share === 1);
check("issue completion is counted separately from points", avery.issueShare === 1);
check("issue completion works with no estimates at all",
  build({ issues: [
    issue({ account: "acc-1", status: "Done", points: null }),
    issue({ account: "acc-1", status: "To Do", points: null }),
  ] }).people[0].issueShare === 0.5);
check("scope creep attributed to the person", avery.addedAfterStart === 1);
check("github block present when a login resolves", Boolean(avery.github));
// Both fixture PRs were opened inside the window; only one reached main.
check("PRs opened counts every one opened in the window", avery.github.prsOpened === 2);
check("PRs merged counts only the one that reached main", avery.github.prsMerged === 1);
check("direct pushes reported separately", avery.github.directCommits === 1);
check("reviews given", avery.github.reviews === 1);
check("review comments", avery.github.comments === 3);
check("lines fold merges and direct pushes", avery.github.lines === 160);

const bo = recap.people[1];
check("no login means no github block, not zeroes", bo.github === null);
check("but the Jira half is still there", bo.tickets === 1 && bo.points === 2);

section("boards");
recap = build({
  issues: [
    issue({ board: 1, status: "Done", points: 5 }),
    issue({ board: 1, status: "To Do", points: 3, created: "2026-08-06" }),
    issue({ board: 2, status: "Done", points: 8 }),
  ],
});
check("one block per configured board", recap.boards.length === 2);
check("sprint named on its own board",
  recap.boards[0].sprints[0].name === "Sprint 41" && recap.boards[1].sprints[0].name === "PLAT 18");
check("sprint dates carried", recap.boards[1].sprints[0].start === "2026-08-05");
check("a goal is optional", recap.boards[1].sprints[0].goal === "");
check("board points", recap.boards[0].points === 8 && recap.boards[1].points === 8);
check("board completion", recap.boards[0].completion === 0.625 && recap.boards[1].completion === 1);
check("creep attributed to its board",
  recap.boards[0].addedAfterStart === 1 && recap.boards[1].addedAfterStart === 0);
check("board colour carried for the block's edge", recap.boards[0].color === "#111111");

section("tickets");
recap = build({
  issues: [
    issue({ board: 2, status: "Done", key: "PLAT-9", summary: "Second board" }),
    issue({ board: 1, status: "Done", key: "CTS-300" }),
    issue({ board: 1, status: "To Do", key: "CTS-200", created: "2026-08-06" }),
    issue({ board: 1, status: "In Code Review", key: "CTS-100", sprint: [{ id: 9, state: "closed" }] }),
    issue({ board: 1, status: "To Do", key: "CTS-999", subtask: true }),
  ],
});
check("sub-tasks are not listed, matching the totals",
  !recap.tickets.some((t) => t.key === "CTS-999"));
check("grouped by board, then by the configured status order, then by key",
  recap.tickets.map((t) => t.key).join() === "CTS-200,CTS-100,CTS-300,PLAT-9");
check("board name resolved for the group heading", recap.tickets[0].board === "CTS");
check("status group resolved as well as the raw status",
  recap.tickets[1].status === "In Code Review" && recap.tickets[1].statusGroup === "In Code Review");
check("scope creep flagged per ticket",
  recap.tickets.find((t) => t.key === "CTS-200").addedAfterStart === true);
check("carry-in flagged per ticket",
  recap.tickets.find((t) => t.key === "CTS-100").carriedIn === true);
check("a done ticket says so, for the status pill",
  recap.tickets.find((t) => t.key === "CTS-300").done === true);
check("assignee resolved through the roster", recap.tickets[0].assignee === "Avery Quinn");
check("unestimated points stay null rather than becoming zero",
  build({ issues: [issue({ points: null })] }).tickets[0].points === null);

section("github availability");
recap = build({ issues: [issue({ account: "acc-1" })], stats: null });
check("no query at all is reported as such",
  recap.github.queried === false && recap.github.available === false);
check("and the combined block has no github section", recap.combined.github === null);

recap = build({ issues: [issue({ account: "acc-2", name: "Bo Ferreira" })] });
check("queried but nobody mapped is a different fact",
  recap.github.queried === true && recap.github.available === false);
check("unmapped people counted so the note can say how many", recap.github.unmapped === 1);

recap = build({
  issues: [issue({ account: "acc-1" }), issue({ account: "acc-2", name: "Bo Ferreira" })],
});
check("available once anyone is mapped", recap.github.available === true);
check("mapped and unmapped both reported",
  recap.github.mapped === 1 && recap.github.unmapped === 1);
check("combined github sums the per-person figures",
  recap.combined.github.lines === 160 && recap.combined.github.prsMerged === 1);
check("window start reported for the caveat line", recap.github.from !== "");

section("partial github answers");
recap = build({
  issues: [issue({ account: "acc-1" })],
  stats: {
    ...STATS,
    reached: ["acme/api", "acme/ui"],
    truncated: ["acme/ui"],
    failures: [{ repo: "acme/api", type: "graphql", message: "Direct pushes unavailable — Resource not accessible" }],
  },
});
check("a repo that only half answered is carried through, not dropped",
  recap.github.failures.length === 1 && recap.github.failures[0].repo === "acme/api");
check("the reason travels with it",
  /Direct pushes unavailable/.test(recap.github.failures[0].message));
check("truncation is carried through too", recap.github.truncated.join() === "acme/ui");
check("and which repos did answer", recap.github.reached.join() === "acme/api,acme/ui");
check("a clean payload reports neither",
  build({ issues: [issue({ account: "acc-1" })] }).github.failures.length === 0);
check("no stats at all does not crash the partial fields",
  build({ issues: [issue({ account: "acc-1" })], stats: null }).github.truncated.length === 0);

// A sprint that began before the fetch window reached back.
recap = build({
  issues: [issue({ account: "acc-1" })],
  stats: { ...STATS, since: "2026-08-08T00:00:00Z" },
});
check("a clamped window is flagged so the document can say so",
  recap.github.clamped === true);

section("empty sprint");
recap = build({ issues: [] });
check("no crash with nothing in the sprint", recap.combined.issues === 0);
check("no people", recap.people.length === 0);
check("boards still listed, so the document is not silently short",
  recap.boards.length === 2);
check("no tickets", recap.tickets.length === 0);

section("per-person Jira activity");

// Inside the sprint window (SPRINT_A starts 2026-08-03), so both the transition
// and the creation count.
const IN_SPRINT = "2026-08-05T10:00:00.000Z";
const PRE_SPRINT = "2026-07-20T10:00:00.000Z";

const activityRecap = build({
  issues: [
    issue({
      account: "acc-1", name: "Avery Quinn", status: "Done", created: IN_SPRINT, creator: "acc-1",
      log: log([
        { by: "acc-1", at: IN_SPRINT, items: [moved("To Do", "In Progress")] },
        { by: "acc-2", at: IN_SPRINT, items: [moved("In Progress", "Done")] },
      ]),
    }),
    issue({
      account: "acc-2", name: "Bo Ferreira", status: "In Progress", created: PRE_SPRINT, creator: "acc-2",
      log: log([{ by: "acc-1", at: IN_SPRINT, items: [moved("To Do", "In Progress")] }]),
    }),
  ],
});
const aRow = activityRecap.people.find((p) => p.accountId === "acc-1");
const bRow = activityRecap.people.find((p) => p.accountId === "acc-2");

check("each person carries a jira block", Boolean(aRow.jira) && Boolean(bRow.jira));
check("transitions are attributed to the mover, not the assignee", aRow.jira.transitions === 2);
check("a completion goes to whoever made it", bRow.jira.completed === 1);
check("...and not to the assignee of the issue", aRow.jira.completed === 0);
check("distinct completed issues are counted", bRow.jira.completedIssues === 1);
check("touched issues are counted", aRow.jira.touched === 2);
check("an issue created in the sprint counts", aRow.jira.created === 1);
check("an issue created before it does not", bRow.jira.created === 0);
check("the history half is marked known", aRow.jira.historyKnown === true);

check("the combined block sums the per-person figures",
  activityRecap.combined.jira.transitions === 3 && activityRecap.combined.jira.created === 1);
check("the combined block counts who it could answer for",
  activityRecap.combined.jira.people === 2);
check("the document is told history is available", activityRecap.activity.available === true);
check("the window is reported for the caption, as the sprint's own start",
  activityRecap.activity.from === new Date(activityRecap.window.start).toISOString());
check("nothing truncated means an empty list", activityRecap.activity.truncated.length === 0);

section("activity absence and truncation");

// No changelog anywhere: the transition half is an absence, and the creation
// half is still a real number because it never needed a history.
const noHistory = build({
  issues: [issue({ account: "acc-1", name: "Avery Quinn", created: IN_SPRINT, creator: "acc-1" })],
});
const noRow = noHistory.people.find((p) => p.accountId === "acc-1");
check("a site with no issue history still answers for creations", noRow.jira.created === 1);
check("...but marks the history half unknown", noRow.jira.historyKnown === false);
check("the document is told history is unavailable", noHistory.activity.available === false);
check("the combined block says so too", noHistory.combined.jira.historyKnown === false);

const cut = build({
  issues: [
    issue({
      key: "CTS-777", account: "acc-1", name: "Avery Quinn", created: PRE_SPRINT,
      log: log([{ by: "acc-1", at: IN_SPRINT, items: [moved("To Do", "In Progress")] }], 90),
    }),
  ],
});
check("a truncated history names its issue so the page can caveat it",
  cut.activity.truncated.length === 1 && cut.activity.truncated[0] === "CTS-777");
check("counts still accrue from the part that arrived",
  cut.people.find((p) => p.accountId === "acc-1").jira.transitions === 1);

// An automation is a real change but not a person's action.
const automated = build({
  issues: [
    issue({
      account: "acc-1", name: "Avery Quinn", created: PRE_SPRINT,
      log: log([{ by: null, at: IN_SPRINT, items: [moved("To Do", "In Progress")] }]),
    }),
  ],
});
check("an authorless entry is not attributed to anybody",
  automated.people.find((p) => p.accountId === "acc-1").jira.transitions === 0);

check("people stay in name order with the activity block attached",
  activityRecap.people.filter((p) => p.accountId !== "__unassigned__")
    .map((p) => p.label).join(",") === "Avery Quinn,Bo Ferreira");

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
