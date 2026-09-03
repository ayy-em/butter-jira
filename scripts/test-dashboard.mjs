#!/usr/bin/env node
// Unit checks for sprint dashboard aggregation: working-day arithmetic, the
// sprint window across several boards, carry-in and scope-change detection,
// per-status/board/person buckets, hygiene scoring, snapshot storage, the sprint
// freeze and its diff, and the burndown series. No dependencies, no network, no
// browser.
//
// Usage: node scripts/test-dashboard.mjs

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
const snap = await import(new URL("../js/snapshots.js", import.meta.url));
const frz = await import(new URL("../js/freeze.js", import.meta.url));

// ── Minimal DOM shim, so the SVG builders can be exercised headlessly ────────
// The palette validator checks colour; it cannot catch NaN coordinates, a bar
// wider than its plot, or a label placed outside the viewBox. Those are the
// geometry faults that make a chart look broken, so they get asserted here.

class FakeNode {
  constructor(name) {
    this.tagName = name;
    this.attrs = {};
    this.children = [];
    this.style = {};
    this.classList = { add() {}, toggle() {}, remove() {} };
    this._text = "";
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(c); }
  addEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 220 }; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  descendants() {
    return this.children.flatMap((c) => (c instanceof FakeNode ? [c, ...c.descendants()] : [c]));
  }
}
globalThis.document = {
  createElementNS: (_ns, name) => new FakeNode(name),
  createElement: (name) => new FakeNode(name),
};

const charts = await import(new URL("../js/charts.js", import.meta.url));

const numbersIn = (node) => {
  const out = [];
  for (const el of [node, ...node.descendants()]) {
    if (!(el instanceof FakeNode)) continue;
    for (const [k, v] of Object.entries(el.attrs)) {
      // The root <svg> carries width="100%" for responsiveness — a presentation
      // attribute, not a coordinate.
      if (v.endsWith("%")) continue;
      if (k === "d") {
        for (const m of v.matchAll(/-?\d*\.?\d+(e[+-]?\d+)?|NaN|Infinity/gi)) out.push({ el, k, raw: m[0], n: Number(m[0]) });
      } else if (/^(x|y|x1|x2|y1|y2|cx|cy|r|width|height|stroke-width)$/.test(k)) {
        out.push({ el, k, raw: v, n: Number(v) });
      }
    }
  }
  return out;
};
const allFinite = (node) => numbersIn(node).every((e) => Number.isFinite(e.n));
const textNodes = (node) => [node, ...node.descendants()].filter((e) => e instanceof FakeNode && e.tagName === "text");

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["cf_sp"], sprint: ["cf_sprint"] },
};
local = { schemaVersion: 2 };
await cfg.loadConfig();
await team.loadTeam();

const GROUPS = [
  { name: "To Do", statuses: ["To Do"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "Done", statuses: ["Done"] },
];
const BOARDS = [
  { id: 1, name: "ABC", color: "#111111" },
  { id: 2, name: "DEF", color: "#222222" },
];

let seq = 0;
function issue(o = {}) {
  const {
    status = "To Do", doneCategory, points = 3, board = 1, assignee = { accountId: "acc-1", displayName: "Ada Lovelace" },
    created = "2026-08-01", sprint, subtask = false, key,
  } = o;
  seq++;
  const fields = {
    issuetype: { name: subtask ? "Sub-task" : "Story", subtask },
    status: { name: status, statusCategory: { key: doneCategory || (status === "Done" ? "done" : "indeterminate") } },
    assignee,
    created,
    summary: `Issue ${seq}`,
  };
  if (points !== null) fields.cf_sp = points;
  if (sprint !== undefined) fields.cf_sprint = sprint;
  return { key: key || `ABC-${seq}`, id: String(seq), boardId: board, fields };
}
const SPRINT = { id: 10, name: "Sprint 42", goal: "Ship the thing", startDate: "2026-08-03", endDate: "2026-08-14" };

section("working days");
check("Mon to Fri is 5", dash.workingDaysBetween("2026-08-03", "2026-08-07") === 5);
check("weekend excluded", dash.workingDaysBetween("2026-08-08", "2026-08-09") === 0);
check("two-week sprint is 10", dash.workingDaysBetween("2026-08-03", "2026-08-14") === 10);
check("same day counts as one", dash.workingDaysBetween("2026-08-03", "2026-08-03") === 1);
check("reversed range is zero", dash.workingDaysBetween("2026-08-07", "2026-08-03") === 0);
check("missing dates tolerated", dash.workingDaysBetween(null, "2026-08-07") === 0);
check("isoDay formats", dash.isoDay("2026-08-06T22:00:00Z") !== null);

section("sprint window across boards");
let w = dash.sprintWindow([
  { startDate: "2026-08-03", endDate: "2026-08-14" },
  { startDate: "2026-08-05", endDate: "2026-08-19" },
]);
check("earliest start wins", dash.isoDay(w.start) === "2026-08-03");
check("latest end wins", dash.isoDay(w.end) === "2026-08-19");
check("no sprints -> null window", dash.sprintWindow([]).start === null);
check("sprint without dates tolerated", dash.sprintWindow([{ name: "x" }]).start === null);

section("carry-in detection");
check("closed sprint in history counts",
  dash.wasCarriedIn(issue({ sprint: [{ id: 9, state: "closed" }, { id: 10, state: "active" }] }), [10]) === true);
check("only the active sprint does not",
  dash.wasCarriedIn(issue({ sprint: [{ id: 10, state: "active" }] }), [10]) === false);
check("another non-active sprint counts",
  dash.wasCarriedIn(issue({ sprint: [{ id: 8 }, { id: 10 }] }), [10]) === true);
check("legacy serialised blob with CLOSED counts",
  dash.wasCarriedIn(issue({ sprint: ["com.x.Sprint@1[id=9,state=CLOSED,name=Sprint 41]"] }), [10]) === true);
check("no sprint field -> false", dash.wasCarriedIn(issue({}), [10]) === false);
check("single object rather than array handled",
  dash.wasCarriedIn(issue({ sprint: { id: 9, state: "closed" } }), [10]) === true);

section("scope added after start");
check("created after start counts",
  dash.wasAddedAfterStart(issue({ created: "2026-08-06" }), dash.startOfDay("2026-08-03")) === true);
check("created before start does not",
  dash.wasAddedAfterStart(issue({ created: "2026-07-30" }), dash.startOfDay("2026-08-03")) === false);
check("created on the start day does not",
  dash.wasAddedAfterStart(issue({ created: "2026-08-03" }), dash.startOfDay("2026-08-03")) === false);
check("no window -> false", dash.wasAddedAfterStart(issue({}), null) === false);

section("totals");
let summary = dash.summarize({
  issues: [
    issue({ points: 5, status: "Done" }),
    issue({ points: 3, status: "In Progress" }),
    issue({ points: null, status: "To Do" }),
    issue({ points: 2, status: "To Do", subtask: true }),   // excluded
  ],
  sprints: [SPRINT],
  statusGroups: GROUPS,
  boards: BOARDS,
  now: new Date("2026-08-07T12:00:00"),
});
check("sub-tasks excluded from the count", summary.issueCount === 3);
check("sub-task count reported separately", summary.subtaskCount === 1);
check("sub-task points not added to the total", summary.totalPoints === 8);
check("done points", summary.donePoints === 5);
check("open points", summary.openPoints === 3);
check("done issues", summary.doneIssues === 1);
check("unestimated counted", summary.unestimated === 1);
check("completion by points", Math.round(summary.completionByPoints * 100) === 63);
check("completion by issues", Math.round(summary.completionByIssues * 100) === 33);
check("projected carry-out is everything open", summary.projectedCarryOut === 2);
check("carry-out points", summary.projectedCarryOutPoints === 3);
check("sprint name surfaced", summary.sprintNames[0] === "Sprint 42");
check("goal surfaced", summary.goals[0] === "Ship the thing");

section("no estimates at all");
summary = dash.summarize({
  issues: [issue({ points: null }), issue({ points: null, status: "Done" })],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
check("completion by points is null, not zero", summary.completionByPoints === null);
check("completion by issues still works", summary.completionByIssues === 0.5);
check("total points zero", summary.totalPoints === 0);

section("empty sprint");
summary = dash.summarize({ issues: [], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS });
check("no issues -> null completion", summary.completionByIssues === null);
check("no crash on empty", summary.issueCount === 0);
check("status buckets still present", summary.byStatus.length === 3);

section("status buckets");
summary = dash.summarize({
  issues: [
    issue({ status: "To Do", points: 1 }),
    issue({ status: "In Progress", points: 2 }),
    issue({ status: "Done", points: 4 }),
    issue({ status: "Blocked", points: 8 }),   // unmapped
  ],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
check("configured order preserved",
  summary.byStatus.slice(0, 3).map((b) => b.key).join() === "To Do,In Progress,Done");
check("unmapped status appended", summary.byStatus[3].key === "Blocked");
check("points bucketed", summary.byStatus[2].points === 4);
check("unmapped status keeps its points", summary.byStatus[3].points === 8);

section("board buckets");
summary = dash.summarize({
  issues: [issue({ board: 1, points: 3 }), issue({ board: 2, points: 5 }), issue({ board: 2, points: 2 })],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
check("board labels attached", summary.byBoard.map((b) => b.label).join() === "ABC,DEF");
check("board points summed", summary.byBoard[1].points === 7);
check("board colour carried for the key", summary.byBoard[0].color === "#111111");

section("person buckets");
await team.saveMembers([{ accountId: "acc-1", jiraName: "Ada Lovelace", nameOverride: "Ada" }]);
summary = dash.summarize({
  issues: [
    issue({ assignee: { accountId: "acc-1", displayName: "Ada Lovelace" }, points: 8 }),
    issue({ assignee: { accountId: "acc-9", displayName: "Zoe Outsider" }, points: 3 }),
    issue({ assignee: null, points: 1 }),
  ],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
check("sorted by points", summary.byPerson[0].points === 8);
check("roster override used as the label", summary.byPerson[0].label === "Ada");
check("roster membership flagged", summary.byPerson[0].onTeam === true);
check("outsider flagged", summary.byPerson.find((p) => p.label === "Zoe Outsider").onTeam === false);
check("unassigned bucketed", summary.byPerson.some((p) => p.label === "Unassigned"));
check("unassigned has no team flag", summary.byPerson.find((p) => p.label === "Unassigned").onTeam === null);

section("in review + done");
const REVIEW_GROUPS = [
  { name: "To Do", statuses: ["To Do"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "In Code Review", statuses: ["Peer check"] },   // group name carries it
  { name: "Done", statuses: ["Done"] },
];
check("review status matched by name",
  dash.isInReview(issue({ status: "In Code Review" }), GROUPS) === true);
check("review matched via the group name, not the status",
  dash.isInReview(issue({ status: "Peer check" }), REVIEW_GROUPS) === true);
check("a status no group claims still matches on its own name",
  dash.isInReview(issue({ status: "Ready for Review" }), GROUPS) === true);
check("in progress is not in review",
  dash.isInReview(issue({ status: "In Progress" }), GROUPS) === false);
check("done is never also in review",
  dash.isInReview(issue({ status: "Done" }), GROUPS) === false);
check("a done-category status named for review counts as done, not review",
  dash.isInReview(issue({ status: "Reviewed", doneCategory: "done" }), GROUPS) === false);

summary = dash.summarize({
  issues: [
    issue({ assignee: { accountId: "acc-1", displayName: "Ada" }, status: "To Do", points: 5 }),
    issue({ assignee: { accountId: "acc-1", displayName: "Ada" }, status: "In Code Review", points: 3 }),
    issue({ assignee: { accountId: "acc-1", displayName: "Ada" }, status: "Done", points: 2 }),
    issue({ assignee: { accountId: "acc-9", displayName: "Zoe" }, status: "In Progress", points: 4 }),
  ],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
const ada = summary.byPerson.find((p) => p.label === "Ada");
const zoe = summary.byPerson.find((p) => p.label === "Zoe");
check("review points bucketed per person", ada.reviewPoints === 3);
check("review issues bucketed per person", ada.reviewIssues === 1);
check("done stays separate from review", ada.donePoints === 2);
check("nobody is counted twice", ada.reviewIssues + ada.doneIssues === 2);
check("sprint-level review points", summary.reviewPoints === 3);
check("sprint-level review issues", summary.reviewIssues === 1);

let progress = dash.reviewOrDone(ada);
check("review + done issues combined", progress.issues === 2);
check("review + done points combined", progress.points === 5);
check("share is points-based", progress.share === 0.5);
check("share of untouched work is zero, not null", dash.reviewOrDone(zoe).share === 0);

check("totals bucket mirrors the sprint", summary.totals.points === 14);
check("totals row agrees with the rows",
  dash.reviewOrDone(summary.totals).points === ada.donePoints + ada.reviewPoints);

progress = dash.reviewOrDone({ issues: 2, points: 0, doneIssues: 1, donePoints: 0, reviewIssues: 0, reviewPoints: 0 });
check("no estimates -> null share, not zero", progress.share === null);
check("unestimated work still counts its tickets", progress.issues === 1);
check("an empty bucket does not throw", dash.reviewOrDone({}).share === null);
check("review buckets present on status rows",
  summary.byStatus.every((b) => typeof b.reviewPoints === "number"));
check("review buckets present on empty board rows",
  dash.summarize({ issues: [], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS })
    .byBoard.every((b) => b.reviewIssues === 0));

section("compact numbers");
const utils = await import(new URL("../js/utils.js", import.meta.url));
check("under a thousand is printed whole", utils.compactNum(999) === "999");
check("thousands keep one decimal", utils.compactNum(1234) === "1.2k");
check("five figures drop the decimal", utils.compactNum(15400) === "15k");
check("zero is zero, not a dash", utils.compactNum(0) === "0");
check("rubbish reads as zero", utils.compactNum(null) === "0");

section("days remaining");
summary = dash.summarize({
  issues: [issue({})], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
  now: new Date("2026-08-10T09:00:00"),   // Monday of week 2
});
check("total working days", summary.daysTotal === 10);
check("remaining counts today", summary.daysRemaining === 5);
check("elapsed derived", summary.daysElapsed === 5);
check("not overdue mid-sprint", summary.isOverdue === false);
summary = dash.summarize({
  issues: [issue({})], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
  now: new Date("2026-08-20T09:00:00"),
});
check("past the end is overdue", summary.isOverdue === true);
check("no negative days remaining", summary.daysRemaining === 0);

section("hygiene score");
summary = dash.summarize({
  issues: [issue({ points: 3, assignee: { accountId: "acc-1", displayName: "Ada" } })],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
let score = dash.hygieneScore(summary);
check("score is a ratio", score !== null && score >= 0 && score <= 1);
check("label for a healthy score", dash.hygieneLabel(0.95).state === "good");
check("label for gaps", dash.hygieneLabel(0.8).state === "warning");
check("label for trouble", dash.hygieneLabel(0.4).state === "critical");
check("label for no data", dash.hygieneLabel(null).state === "unknown");
check("empty sprint scores null",
  dash.hygieneScore(dash.summarize({ issues: [], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS })) === null);

section("snapshot storage");
local = {};
const key = snap.sprintKey([{ id: 10 }, { id: 11 }]);
check("key from sprint ids", key === "10+11");
check("key order-independent", snap.sprintKey([{ id: 11 }, { id: 10 }]) === "10+11");
check("no sprints -> placeholder key", snap.sprintKey([]) === "no-sprint");
summary = dash.summarize({ issues: [issue({ points: 5 })], sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS });
await snap.recordSnapshot(key, snap.snapshotFrom(summary, "2026-08-05"));
let stored = await snap.loadSnapshots(key);
check("snapshot stored", stored.length === 1);
check("open points recorded", stored[0].openPoints === 5);
await snap.recordSnapshot(key, { ...snap.snapshotFrom(summary, "2026-08-05"), openPoints: 4 });
stored = await snap.loadSnapshots(key);
check("same day overwrites rather than appending", stored.length === 1 && stored[0].openPoints === 4);
await snap.recordSnapshot(key, { ...snap.snapshotFrom(summary, "2026-08-04"), openPoints: 9 });
stored = await snap.loadSnapshots(key);
check("kept in date order", stored.map((s) => s.date).join() === "2026-08-04,2026-08-05");
check("other sprints isolated", (await snap.loadSnapshots("999")).length === 0);
check("snapshot without a date is ignored", (await snap.recordSnapshot(key, {})).length === 2);

section("snapshot per-person block");
local = {};
summary = dash.summarize({
  issues: [
    issue({ assignee: { accountId: "acc-1", displayName: "Ada" }, status: "Done", points: 5 }),
    issue({ assignee: { accountId: "acc-1", displayName: "Ada" }, status: "To Do", points: 3 }),
    issue({ assignee: { accountId: "acc-9", displayName: "Zoe" }, status: "In Progress", points: 2 }),
    issue({ assignee: null, points: 1 }),
  ],
  sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS,
});
let people = snap.snapshotFrom(summary, "2026-08-06").byPerson;
check("keyed by account id", Object.keys(people).sort().join() === "__unassigned__,acc-1,acc-9");
check("assigned points per person", people["acc-1"].points === 8 && people["acc-9"].points === 2);
check("issue counts per person", people["acc-1"].issues === 2 && people["acc-9"].issues === 1);
check("done split per person", people["acc-1"].donePoints === 5 && people["acc-1"].doneIssues === 1);
check("nothing done is zero, not absent", people["acc-9"].donePoints === 0 && people["acc-9"].doneIssues === 0);
check("display name stored alongside the id", people["acc-1"].label === "Ada");
check("unassigned is a row like any other", people["__unassigned__"].points === 1);
check("rows sum to the day's totals",
  Object.values(people).reduce((n, p) => n + p.points, 0) === summary.totalPoints &&
  Object.values(people).reduce((n, p) => n + p.issues, 0) === summary.issueCount);
check("no onTeam flag is stored", !("onTeam" in people["acc-1"]));
await snap.recordSnapshot(key, snap.snapshotFrom(summary, "2026-08-06"));
stored = await snap.loadSnapshots(key);
check("per-person block survives the storage round trip",
  stored[0].byPerson["acc-1"].donePoints === 5);
check("a summary with no person buckets records an empty block",
  Object.keys(snap.snapshotFrom({}, "2026-08-06").byPerson).length === 0);

section("snapshot pruning");
local = {};
for (let i = 0; i < 12; i++) {
  await snap.recordSnapshot(`sprint-${i}`, { date: `2026-07-${String(i + 1).padStart(2, "0")}`, openPoints: 1 });
}
const all = (await chrome.storage.local.get(["sprintSnapshots"])).sprintSnapshots;
check("old sprints pruned", Object.keys(all).length === 8);
check("most recent sprint kept", Boolean(all["sprint-11"]));
check("oldest sprint dropped", !all["sprint-0"]);

// ── Sprint freeze and diff (M13) ────────────────────────────────────────────

section("taking a freeze");
local = {};
const withDue = (o, duedate) => {
  const i = issue(o);
  i.fields.duedate = duedate;
  return i;
};
const FROZEN_ISSUES = [
  issue({ key: "ABC-1", points: 3, status: "To Do" }),
  withDue({ key: "ABC-2", points: 5, status: "In Progress" }, "2026-08-10"),
  issue({ key: "ABC-3", points: 2, status: "Done" }),
  issue({ key: "ABC-4", points: null, status: "To Do", assignee: null }),
  // A sub-task, which must not be frozen: its points duplicate the parent's,
  // and a diff whose counts disagreed with the dashboard above it is worse than
  // no diff.
  issue({ key: "ABC-90", points: 8, subtask: true }),
];
let freeze = frz.freezeFrom({
  issues: FROZEN_ISSUES, sprints: [SPRINT], statusGroups: GROUPS,
  now: new Date("2026-08-03T09:00:00Z"),
});
check("sub-tasks are excluded, as they are from the totals", freeze.rows.length === 4);
check("the points frozen match the countable issues", freeze.totalPoints === 10);
check("a freeze on the sprint's start day knows it is one", freeze.atStart === true);
check("and records which working day it was taken on", freeze.dayOfSprint === 1);
const row = freeze.rows.find((r) => r.key === "ABC-2");
check("a row carries the estimate", row.points === 5);
check("a row carries the due date", row.dueDate === "2026-08-10");
check("a row carries the status and its group", row.status === "In Progress" && row.statusGroup === "In Progress");
check("a row carries the status category, not just the name",
  freeze.rows.find((r) => r.key === "ABC-3").category === "done");
check("a row carries the assignee id", row.assignee === "acc-1");
check("and the name as it read that day — the roster is current, history is not",
  row.assigneeName === "Ada Lovelace");
check("an unassigned issue freezes as unassigned, not as missing",
  freeze.rows.find((r) => r.key === "ABC-4").assignee === null);
check("no estimate freezes as null, distinct from zero",
  freeze.rows.find((r) => r.key === "ABC-4").points === null);
check("the board id is kept, so a multi-board diff can say which sprint",
  row.boardId === 1);

const late = frz.freezeFrom({
  issues: FROZEN_ISSUES, sprints: [SPRINT], statusGroups: GROUPS,
  now: new Date("2026-08-06T09:00:00Z"),
});
check("a mid-sprint freeze does not claim to be a start-of-sprint one", late.atStart === false);
check("and says which day it is", late.dayOfSprint === 4);

section("what the freeze lets the app claim");
check("no freeze is the creation-date approximation, and says so",
  frz.scopeBasis(null).exact === false && /creation date/.test(frz.scopeBasis(null).note));
check("a start-of-sprint freeze is exact", frz.scopeBasis(freeze).exact === true);
check("a mid-sprint freeze is NOT called exact — it is blind to what came before",
  frz.scopeBasis(late).exact === false && frz.scopeBasis(late).basis === "freeze");
check("and it says which day it can see from", /day 4/.test(frz.scopeBasis(late).note));

section("the scope figure changes basis, not silently");
// Dragged in: created long before the sprint, so the creation-date figure
// cannot see it. This is the whole reason a freeze is worth keeping.
const draggedIn = issue({ key: "ABC-7", points: 4, created: "2026-07-01" });
const bornLate = issue({ key: "ABC-8", points: 1, created: "2026-08-05" });
const NOW_ISSUES = [...FROZEN_ISSUES, draggedIn, bornLate];
let plain = dash.summarize({ issues: NOW_ISSUES, sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS });
check("without a freeze, an old issue dragged in is invisible", plain.addedAfterStart === 1);
check("and the summary says the figure is not from a freeze", plain.scopeFromFreeze === false);
let exact = dash.summarize({
  issues: NOW_ISSUES, sprints: [SPRINT], statusGroups: GROUPS, boards: BOARDS, freeze,
});
check("with a freeze, both are counted", exact.addedAfterStart === 2);
check("and their points with them", exact.addedAfterStartPoints === 5);
check("the summary says which basis it used", exact.scopeFromFreeze === true);
check("nothing else about the summary moves",
  exact.totalPoints === plain.totalPoints && exact.doneIssues === plain.doneIssues);

section("the diff");
const changed = [
  // Two buckets at once: re-estimated *and* re-assigned, which is also the case
  // the reconciliation has to count as one changed issue rather than two.
  issue({ key: "ABC-1", points: 8, status: "To Do", assignee: { accountId: "acc-9", displayName: "Zoe" } }),
  withDue({ key: "ABC-2", points: 5, status: "In Progress" }, "2026-08-17"), // re-dated
  issue({ key: "ABC-3", points: 2, status: "In Progress" }),              // regressed
  issue({ key: "ABC-4", points: null, status: "To Do", assignee: { accountId: "acc-9", displayName: "Zoe" } }),
  draggedIn,
  bornLate,
  issue({ key: "ABC-90", points: 8, subtask: true }),
];
// ABC-... nothing: every frozen issue is still here, so nothing is pulled out
// yet. The pulled-out case gets its own scenario below.
let diff = frz.diffFreeze({
  freeze, issues: changed, sprints: [SPRINT], statusGroups: GROUPS, departed: [],
});
check("crept in is split in two, which the approximation cannot do",
  diff.counts.createdAfter === 1 && diff.counts.draggedIn === 1);
check("the new issue is the one created after the freeze",
  diff.createdAfter[0].key === "ABC-8");
check("the old one is the one dragged in", diff.draggedIn[0].key === "ABC-7");
check("re-estimation is then -> now with a delta",
  diff.reEstimated[0].key === "ABC-1" && diff.reEstimated[0].from === 3 &&
  diff.reEstimated[0].to === 8 && diff.reEstimated[0].delta === 5);
check("the sprint's total change from re-estimation alone", diff.points.reEstimated === 5);
check("a moved due date carries the direction and the number of days",
  diff.reDated[0].key === "ABC-2" && diff.reDated[0].days === 7 &&
  diff.reDated[0].direction === "later");
const moved = diff.reassigned.find((r) => r.key === "ABC-1");
check("a re-assignment names both people rather than both ids",
  moved.fromName === "Ada Lovelace" && moved.toName === "Zoe");
check("the name it prints for 'from' is the one stored at the freeze, not resolved now",
  moved.from === "acc-1" && moved.fromName === "Ada Lovelace");
check("picking up an unassigned issue reads as Unassigned, not as a blank",
  diff.reassigned.find((r) => r.key === "ABC-4").fromName === "Unassigned");
check("done at the freeze and not done now is a regression",
  diff.regressed[0].key === "ABC-3" && diff.regressed[0].from === "Done");
check("an unchanged issue is in no bucket",
  !diff.reEstimated.concat(diff.reDated, diff.reassigned, diff.regressed).some((r) => r.key === "ABC-90"));

section("the diff reconciles with the sprint total");
check("frozen − pulled out + crept in = now",
  diff.counts.frozen - diff.counts.pulledOut + diff.counts.creptIn === diff.counts.now);
check("changed + unchanged = what carried through",
  diff.counts.changed + diff.counts.unchanged === diff.counts.carriedThrough);
check("an issue in two buckets is counted as changed once",
  diff.counts.changed === 4);
check("the sub-task is in neither total", diff.counts.now === 6);

section("what left the sprint, and where it went");
const remaining = changed.filter((i) => i.key !== "ABC-1" && i.key !== "ABC-3");
check("the keys to look up are exactly the ones that left",
  frz.departedKeys(freeze, remaining).sort().join() === "ABC-1,ABC-3");
const backInBacklog = issue({ key: "ABC-1" });
const movedOn = issue({ key: "ABC-3", sprint: [{ id: 77, name: "Sprint 43", state: "future" }] });
diff = frz.diffFreeze({
  freeze, issues: remaining, sprints: [SPRINT], statusGroups: GROUPS,
  departed: [backInBacklog, movedOn],
});
check("an issue with no sprint went back to the backlog",
  diff.pulledOut.find((r) => r.key === "ABC-1").where === "backlog");
check("an issue in another sprint says which one",
  diff.pulledOut.find((r) => r.key === "ABC-3").whereLabel === "Sprint 43");
check("the points that left are counted", diff.points.pulledOut === 5);
diff = frz.diffFreeze({
  freeze, issues: remaining, sprints: [SPRINT], statusGroups: GROUPS, departed: [],
});
check("an issue Jira did not answer for is gone, and the wording admits both reasons",
  diff.pulledOut[0].where === "gone" && /no longer visible/.test(diff.pulledOut[0].whereLabel));
check("the serialised sprint blob older instances send is read too",
  frz.diffFreeze({
    freeze, issues: remaining, sprints: [SPRINT], statusGroups: GROUPS,
    departed: [{ key: "ABC-1", fields: { cf_sprint: ["com.x.Sprint@1[id=77,state=FUTURE,name=Sprint 43]"] } }],
  }).pulledOut.find((r) => r.key === "ABC-1").whereLabel === "Sprint 43");

section("the diff's edges");
check("no freeze means no diff, not an empty one",
  frz.diffFreeze({ freeze: null, issues: changed }) === null);
const unchangedDiff = frz.diffFreeze({
  freeze, issues: FROZEN_ISSUES, sprints: [SPRINT], statusGroups: GROUPS, departed: [],
});
check("a sprint nobody touched has empty buckets and a full unchanged count",
  unchangedDiff.counts.changed === 0 && unchangedDiff.counts.unchanged === 4);
check("an estimate read back as a string is not a re-estimation",
  frz.diffFreeze({
    freeze,
    issues: FROZEN_ISSUES.map((i) => (i.key === "ABC-1" ? { ...i, fields: { ...i.fields, cf_sp: "3" } } : i)),
    sprints: [SPRINT], statusGroups: GROUPS, departed: [],
  }).reEstimated.length === 0);
check("clearing an estimate IS a re-estimation, and reads as one",
  frz.diffFreeze({
    freeze,
    issues: FROZEN_ISSUES.map((i) => (i.key === "ABC-1" ? { ...i, fields: { ...i.fields, cf_sp: null } } : i)),
    sprints: [SPRINT], statusGroups: GROUPS, departed: [],
  }).reEstimated[0].to === null);
check("setting a due date that was not there says 'set', not '0 days later'",
  frz.diffFreeze({
    freeze,
    issues: FROZEN_ISSUES.map((i) => (i.key === "ABC-1" ? withDue({ key: "ABC-1", points: 3 }, "2026-08-09") : i)),
    sprints: [SPRINT], statusGroups: GROUPS, departed: [],
  }).reDated[0].direction === "set");
check("not-done at the freeze and done now is not a regression",
  frz.diffFreeze({
    freeze,
    issues: FROZEN_ISSUES.map((i) => (i.key === "ABC-1" ? issue({ key: "ABC-1", points: 3, status: "Done" }) : i)),
    sprints: [SPRINT], statusGroups: GROUPS, departed: [],
  }).regressed.length === 0);

section("freeze storage");
local = {};
const fkey = snap.sprintKey([SPRINT]);
check("a freeze for an unknown sprint is null, not an empty record",
  (await frz.loadFreeze(fkey)) === null);
check("recording returns nothing replaced the first time",
  (await frz.recordFreeze(fkey, freeze)) === null);
check("it survives the round trip",
  (await frz.loadFreeze(fkey)).rows.length === 4);
const replaced = await frz.recordFreeze(fkey, late);
check("a re-freeze hands back what it discarded, so the caller can name it",
  replaced.takenOn === "2026-08-03");
check("and the new one is what is stored",
  (await frz.loadFreeze(fkey)).takenOn === "2026-08-06");
check("a record with no rows is refused rather than stored as an empty freeze",
  (await frz.recordFreeze("other", {})) === null && (await frz.loadFreeze("other")) === null);
check("other sprints are isolated", (await frz.loadFreeze("999")) === null);

section("freeze pruning");
local = {};
for (let i = 0; i < 12; i++) {
  await frz.recordFreeze(`sprint-${i}`, {
    takenAt: `2026-07-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`,
    takenOn: `2026-07-${String(i + 1).padStart(2, "0")}`,
    rows: [],
  });
}
const freezes = (await chrome.storage.local.get(["sprintFreezes"])).sprintFreezes;
check("pruned to the same depth as snapshots, from the same constant",
  Object.keys(freezes).length === snap.MAX_SPRINTS_KEPT);
check("the most recent freeze is kept", Boolean(freezes["sprint-11"]));
check("the oldest is dropped", !freezes["sprint-0"]);

section("what a freeze costs on the device");
// The roadmap's risk register calls per-issue rows for eight sprints the largest
// thing this extension keeps, so it is measured rather than assumed. A realistic
// sprint: 60 issues with full summaries, names and dates.
const bigSprint = Array.from({ length: 60 }, (_, i) =>
  withDue(
    {
      key: `ABC-${1000 + i}`,
      points: (i % 8) + 1,
      status: i % 3 === 0 ? "Done" : "In Progress",
      assignee: { accountId: `557058:0000-0000-0000-${i}`, displayName: "A Colleague Name" },
    },
    "2026-08-14"
  )
);
for (const i of bigSprint) {
  i.fields.summary = "A realistically long issue summary that says what the work actually is";
  i.fields.parent = { key: "ABC-1" };
}
const bigFreeze = frz.freezeFrom({
  issues: bigSprint, sprints: [SPRINT], statusGroups: GROUPS, now: new Date("2026-08-03T09:00:00Z"),
});
const bytes = frz.freezeBytes(bigFreeze);
console.log(`      … 60 issues freeze to ${bytes} bytes; eight of them, ${Math.round((bytes * 8) / 1024)} KB`);
check("a 60-issue sprint freezes to well under 100 KB", bytes < 100 * 1024);
check("eight of them stay under a megabyte — chrome.storage.local allows far more",
  bytes * snap.MAX_SPRINTS_KEPT < 1024 * 1024);
local = {};

section("burndown series");
const window = { start: dash.startOfDay("2026-08-03"), end: dash.startOfDay("2026-08-07") };
let series = dash.buildBurndown({ snapshots: [], window, totalPoints: 20 });
check("no snapshots -> not ready", series.ready === false);
check("reports how many are needed", series.need === 2);
series = dash.buildBurndown({
  snapshots: [{ date: "2026-08-03", openPoints: 20, totalPoints: 20 }],
  window, totalPoints: 20,
});
check("one snapshot is not a trend", series.ready === false);
series = dash.buildBurndown({
  snapshots: [
    { date: "2026-08-03", openPoints: 20, totalPoints: 20 },
    { date: "2026-08-04", openPoints: 16, totalPoints: 20 },
    { date: "2026-08-05", openPoints: 15, totalPoints: 20 },
  ],
  window, totalPoints: 20, now: new Date("2026-08-05T12:00:00"),
});
check("ready with two or more", series.ready === true);
check("working days only", series.days.join() === "2026-08-03,2026-08-04,2026-08-05,2026-08-06,2026-08-07");
check("ideal starts at the opening scope", series.ideal[0].points === 20);
check("ideal ends at zero", series.ideal[series.ideal.length - 1].points === 0);
check("actual plotted", series.actual.length === 3);
check("delta vs ideal computed", series.deltaPoints === 15 - 10);
check("behind the line is flagged", series.onTrack === false);
series = dash.buildBurndown({
  snapshots: [
    { date: "2026-08-03", openPoints: 20, totalPoints: 20 },
    { date: "2026-08-05", openPoints: 4, totalPoints: 20 },
  ],
  window, totalPoints: 20, now: new Date("2026-08-05T12:00:00"),
});
check("ahead of the line is flagged", series.onTrack === true);
check("no window -> null", dash.buildBurndown({ snapshots: [], window: {}, totalPoints: 5 }) === null);
series = dash.buildBurndown({
  snapshots: [
    { date: "2026-08-01", openPoints: 20 },   // before the sprint window
    { date: "2026-08-03", openPoints: 18 },
    { date: "2026-08-04", openPoints: 12 },
  ],
  window, totalPoints: 20, now: new Date("2026-08-04T12:00:00"),
});
check("snapshots outside the window are dropped from the plot",
  series.actual.every((p) => series.days.includes(p.date)));

section("chart geometry — bars");
let svg = charts.horizontalBars(
  [
    { label: "ABC", value: 34, hint: "3/8 done" },
    { label: "A board with a very long name indeed", value: 5 },
    { label: "Zero", value: 0 },
  ],
  { width: 520 }
);
check("bars: every coordinate is finite", allFinite(svg));
check("bars: viewBox set", svg.attrs.viewBox === "0 0 520 92");
check("bars: one row label per row", textNodes(svg).filter((t) => t.attrs.class === "chart-label").length === 3);
check("bars: one value label per row", textNodes(svg).filter((t) => t.attrs.class === "chart-value").length === 3);
check("bars: a zero-value row draws no fill, only its track",
  svg.descendants().filter((e) => e.tagName === "path").length === 5);
check("bars: value labels stay inside the viewBox",
  textNodes(svg).every((t) => Number(t.attrs.x) <= 520));
check("bars: nothing drawn to the left of the plot",
  numbersIn(svg).filter((e) => e.k === "x").every((e) => e.n >= 0));
check("bars: rows have tooltips",
  svg.descendants().some((e) => e.tagName === "title" && e.textContent.includes("3/8 done")));
check("bars: empty input yields an empty state", charts.horizontalBars([]).attrs === undefined ||
  charts.horizontalBars([]).className === "chart-empty");
svg = charts.horizontalBars([{ label: "Huge", value: 1e6 }], { width: 520 });
check("bars: a huge value still fits the plot", allFinite(svg));

section("chart geometry — stacked bar");
svg = charts.stackedBar(
  [
    { label: "To Do", value: 12, fill: "#86b6ef", labelInk: "#0b0b0b" },
    { label: "In Progress", value: 8, fill: "#5598e7", labelInk: "#0b0b0b" },
    { label: "Done", value: 20, fill: "#1c5cab", labelInk: "#ffffff" },
  ],
  { width: 520, height: 30 }
);
check("stack: coordinates finite", allFinite(svg));
check("stack: one segment per non-zero value",
  svg.descendants().filter((e) => e.tagName === "path").length === 3);
check("stack: segments never exceed the width",
  numbersIn(svg).filter((e) => e.k === "d").every((e) => e.n <= 521));
check("stack: every segment has a tooltip with its share",
  svg.descendants().filter((e) => e.tagName === "title" && e.textContent.includes("%")).length === 3);
check("stack: zero-value segments are skipped",
  charts.stackedBar([
    { label: "A", value: 5, fill: "#111" },
    { label: "B", value: 0, fill: "#222" },
  ], { width: 200 }).descendants().filter((e) => e.tagName === "path").length === 1);
check("stack: all-zero input yields an empty state",
  charts.stackedBar([{ label: "A", value: 0, fill: "#111" }]).className === "chart-empty");

// A label is only drawn inside a segment when it genuinely fits — a clipped
// label is worse than none.
svg = charts.stackedBar(
  [
    { label: "Tiny", value: 1, fill: "#111", labelInk: "#fff" },
    { label: "Big", value: 99, fill: "#222", labelInk: "#fff" },
  ],
  { width: 400, labelMinWidth: 44 }
);
check("stack: a too-narrow segment gets no inline label",
  textNodes(svg).length === 1);

section("chart geometry — burndown");
const days = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
svg = charts.burndownChart(
  {
    days,
    ideal: days.map((date, i) => ({ date, points: 20 * (1 - i / (days.length - 1)) })),
    actual: [
      { date: "2026-08-03", points: 20 },
      { date: "2026-08-04", points: 17 },
      { date: "2026-08-05", points: 11 },
    ],
  },
  { width: 640, height: 220 }
);
check("burndown: coordinates finite", allFinite(svg));
check("burndown: three gridlines", svg.descendants().filter((e) => e.attrs.class === "chart-grid").length === 3);
check("burndown: ideal line is dashed", svg.descendants().some((e) => e.attrs["stroke-dasharray"]));
check("burndown: lines are 2px", svg.descendants().filter((e) => e.tagName === "path" && e.attrs["stroke-width"])
  .every((e) => e.attrs["stroke-width"] === "2"));
check("burndown: markers are at least 8px across",
  svg.descendants().filter((e) => e.tagName === "circle").every((e) => Number(e.attrs.r) >= 4));
check("burndown: markers carry a surface ring",
  svg.descendants().filter((e) => e.tagName === "circle").every((e) => e.attrs["stroke-width"] === "2"));
check("burndown: area wash is a wash, not a block",
  svg.descendants().some((e) => e.attrs.opacity === "0.1"));
check("burndown: only the endpoints get date labels",
  textNodes(svg).filter((t) => t.textContent.includes("-")).length === 2);
check("burndown: no value label on every point",
  textNodes(svg).length <= 5);
check("burndown: every plotted point has a tooltip",
  svg.descendants().filter((e) => e.tagName === "title").length === 3);
check("burndown: plot stays inside the viewBox",
  numbersIn(svg).filter((e) => e.k === "cx" || e.k === "x").every((e) => e.n >= 0 && e.n <= 640));
check("burndown: y coordinates stay inside the viewBox",
  numbersIn(svg).filter((e) => e.k === "cy").every((e) => e.n >= 0 && e.n <= 220));

// Degenerate inputs that would otherwise produce NaN paths.
svg = charts.burndownChart(
  { days: ["2026-08-03", "2026-08-04"], ideal: [{ date: "2026-08-03", points: 0 }, { date: "2026-08-04", points: 0 }], actual: [] },
  { width: 640, height: 220 }
);
check("burndown: an all-zero sprint does not produce NaN", allFinite(svg));
svg = charts.burndownChart(
  { days: ["2026-08-03"], ideal: [{ date: "2026-08-03", points: 5 }], actual: [{ date: "2026-08-03", points: 5 }] },
  { width: 640, height: 220 }
);
check("burndown: a single day does not divide by zero", allFinite(svg));

section("legend");
const lg = charts.legend([
  { label: "Points remaining", fill: "#5598e7" },
  { label: "Ideal", fill: "#898781", dashed: true },
]);
check("legend: one entry per series", lg.children.length === 2);
check("legend: labels are text, not colour-only",
  lg.children.every((c) => c.children.some((k) => k.textContent)));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
