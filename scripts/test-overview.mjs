#!/usr/bin/env node
// Unit checks for the Team Overview derivations (js/overview.js) and the
// pieces of js/dashboard.js and js/charts.js it added: the sprint day, the
// status split, blocked detection, workload against capacity, scope change,
// carry-over risk, the like-for-like previous-sprint reads, review turnaround,
// the seven checklist checks, who has been quiet, and the donut's geometry.
// No dependencies, no network, no browser.
//
// Usage: node scripts/test-overview.mjs

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
      remove: () => Promise.resolve(),
    },
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: () => Promise.resolve(),
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

// Just enough DOM for the SVG builder.
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

const cfg = await import(new URL("../js/config.js", import.meta.url));
const team = await import(new URL("../js/team.js", import.meta.url));
const dash = await import(new URL("../js/dashboard.js", import.meta.url));
const ov = await import(new URL("../js/overview.js", import.meta.url));
const charts = await import(new URL("../js/charts.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["cf_sp"], sprint: ["cf_sprint"], flagged: ["cf_flag"] },
};
local = { schemaVersion: 2 };
await cfg.loadConfig();
await team.loadTeam();

const GROUPS = [
  { name: "To Do", statuses: ["To Do"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "In Review", statuses: ["In Review"] },
  { name: "Done", statuses: ["Done"] },
];
const CAT = { "To Do": "new", "In Progress": "indeterminate", "In Review": "indeterminate", Blocked: "indeterminate", "On hold": "indeterminate", Done: "done" };

let seq = 0;
function issue({ status = "To Do", points = null, who = "a", created = "2026-10-20T09:00:00Z", events = null, extra = {} } = {}) {
  seq++;
  const fields = {
    summary: `Issue ${seq}`,
    status: { name: status, statusCategory: { key: CAT[status] || "indeterminate" } },
    issuetype: { name: "Story", subtask: false },
    assignee: who ? { accountId: who, displayName: `Person ${who.toUpperCase()}` } : null,
    created,
    ...extra,
  };
  if (points !== null) fields.cf_sp = points;
  return { key: `ABC-${seq}`, fields, ...(events ? { history: { events } } : {}) };
}
const statusEvent = (at, from, to, by = "a") => ({ at, by, kind: "status", field: "status", from, to, fromId: "", toId: "" });

// A Mon 2026-10-26 → Fri 2026-11-06 sprint: ten working days.
const SPRINTS = [{ id: 7, name: "S7", startDate: "2026-10-26T08:00:00Z", endDate: "2026-11-06T17:00:00Z" }];

section("sprintDay");
{
  const issues = [issue({ points: 3 })];
  const at = (iso) => dash.summarize({ issues, sprints: SPRINTS, statusGroups: GROUPS, now: new Date(iso) });
  const wed2 = ov.sprintDay(at("2026-11-04T12:00:00"), new Date("2026-11-04T12:00:00"));
  check("Wed of week two is day 8 of 10", wed2.day === 8 && wed2.of === 10);
  check("share is day over days", near(wed2.share, 0.8));
  const mon = ov.sprintDay(at("2026-10-26T12:00:00"), new Date("2026-10-26T12:00:00"));
  check("the first Monday is day 1", mon.day === 1);
  const sat = ov.sprintDay(at("2026-10-31T12:00:00"), new Date("2026-10-31T12:00:00"));
  check("a Saturday is still the Friday's day", sat.day === 5);
  const after = ov.sprintDay(at("2026-11-10T12:00:00"), new Date("2026-11-10T12:00:00"));
  check("past the end reads ended, full", after.ended && after.share === 1);
  check("no dates, no day", ov.sprintDay(dash.summarize({ issues, sprints: [{ id: 1 }] })) === null);
  check("elapsedBefore counts days already behind", ov.elapsedBefore({ start: new Date(2026, 9, 26) }, "2026-11-04") === 7);
  const cut = ov.endOfWorkingDay("2026-10-26T08:00:00", 6);
  check("6th working day from a Monday is the next Monday", cut.getDate() === 2 && cut.getMonth() === 10);
  const clamp = ov.endOfWorkingDay("2026-10-26T08:00:00", 30, "2026-11-06T00:00:00");
  check("clamped to the sprint's end", clamp.getDate() === 6);
}

section("blocked detection");
{
  check("a Blocked status is blocked", dash.isBlocked(issue({ status: "Blocked" }), GROUPS));
  check("On hold reads as blocked", dash.isBlocked(issue({ status: "On hold" }), GROUPS));
  check("flagged in Jira is blocked", dash.isBlocked(issue({ status: "In Progress", extra: { cf_flag: [{ value: "Impediment" }] } }), GROUPS));
  check("an empty flag is not", !dash.isBlocked(issue({ status: "In Progress", extra: { cf_flag: [] } }), GROUPS));
  check("done is never blocked", !dash.isBlocked(issue({ status: "Done", extra: { cf_flag: [{ value: "Impediment" }] } }), GROUPS));
  const s = dash.summarize({
    issues: [issue({ status: "Blocked", points: 3 }), issue({ status: "In Progress", points: 2 })],
    sprints: SPRINTS,
    statusGroups: GROUPS,
  });
  check("summarize counts blocked and its points", s.blocked === 1 && s.blockedPoints === 3);
}

section("statusDistribution");
{
  const issues = [
    issue({ status: "To Do" }), issue({ status: "To Do" }),
    issue({ status: "In Progress" }), issue({ status: "In Review" }),
    issue({ status: "Done" }), issue({ status: "Blocked" }),
    { ...issue({ status: "Done" }), fields: { ...issue().fields, issuetype: { subtask: true } } },
  ];
  const d = ov.statusDistribution(issues, GROUPS);
  const by = Object.fromEntries(d.slices.map((s) => [s.label, s.count]));
  check("sub-tasks excluded from the total", d.total === 6);
  check("five slices in workflow order", d.slices.map((s) => s.label).join(",") === "To Do,In Progress,In Review,Done,Blocked");
  check("each issue in exactly one slice", by["To Do"] === 2 && by["In Progress"] === 1 && by["In Review"] === 1 && by.Done === 1 && by.Blocked === 1);
  check("shares sum to one", near(d.slices.reduce((n, s) => n + s.share, 0), 1));
  check("keys carried for the drill-down", d.slices[0].keys.length === 2);
}

section("workload");
{
  const issues = [
    issue({ who: "a", status: "Done", points: 3 }),
    issue({ who: "a", status: "In Progress", points: 8 }),
    issue({ who: "a", status: "In Review", points: 2 }),
    issue({ who: "b", status: "In Progress", points: 2.5 }),
    issue({ who: null, status: "To Do", points: 5 }),
  ];
  const summary = dash.summarize({ issues, sprints: SPRINTS, statusGroups: GROUPS, now: new Date("2026-11-04T12:00:00") });
  const members = [
    { accountId: "b", role: "Data Engineer" },
    { accountId: "a", role: "Data Analyst" },
    { accountId: "c", role: "Data Engineer" },
  ];
  const w = ov.workload({ summary, members, daysRemaining: 3, hoursPerPoint: 8 });
  check("every roster member gets a row", w.rows.length === 3);
  check("ordered by name, not by load", w.rows.map((r) => r.key).join(",") === "a,b,c");
  const a = w.rows.find((r) => r.key === "a");
  check("open excludes done and review", a.openPoints === 8);
  check("capacity is days × 8h ÷ hours a point", w.capacity === 3);
  check("8 open over 3 capacity is over", a.state === "over");
  check("2.5 open over 3 capacity is near", w.rows.find((r) => r.key === "b").state === "near");
  check("nobody's work reads idle", w.rows.find((r) => r.key === "c").state === "idle");
  check("role carried from the roster", a.role === "Data Analyst");
  const unest = dash.summarize({ issues: [issue({ who: "d", status: "In Progress" })], sprints: SPRINTS, statusGroups: GROUPS, now: new Date("2026-11-04T12:00:00") });
  check("work held with no estimates is not OK", ov.workload({ summary: unest, members: [{ accountId: "d" }], daysRemaining: 3 }).rows[0].state === "unestimated");
  check("unassigned is returned apart", w.unassigned.issues === 1 && w.unassigned.points === 5);
  check("ended sprint has no capacity", ov.workload({ summary, members, daysRemaining: 0 }).capacity === null);
  const noRoster = ov.workload({ summary, members: [], daysRemaining: 3 });
  check("without a roster, holders of work are listed, unassigned not", noRoster.rows.length === 2);
}

section("scopeChange");
{
  const diff = {
    counts: { creptIn: 3, pulledOut: 1 },
    points: { frozen: 40, creptIn: 9, pulledOut: 2, reEstimated: 1 },
    scope: { exact: true },
  };
  const s = ov.scopeChange({ diff });
  check("net is added − removed + re-estimated", s.net === 8);
  check("share is of the original commitment", near(s.share, 0.2));
  check("freeze basis is exact", s.exact && s.basis === "freeze");
  const approx = ov.scopeChange({ summary: { totalPoints: 30, addedAfterStartPoints: 6, addedAfterStart: 2 } });
  check("without a freeze, removed is unknown, not zero", approx.removed === null);
  check("original is now minus added", approx.original === 24 && near(approx.share, 0.25));
}

section("carryOverRisk");
{
  const summary = {
    totalPoints: 40, donePoints: 10, openPoints: 30, daysElapsed: 5, daysRemaining: 5, daysTotal: 10,
    window: { start: new Date(2026, 9, 26) }, isOverdue: false,
  };
  const r = ov.carryOverRisk({ summary, snapshots: [], now: new Date(2026, 10, 2, 12) });
  // 2 points a day over 5 days leaves 20 of 30 open: 20/40.
  check("spill is open minus pace × days left", near(r.risk, 0.5) && near(r.spillPoints, 20));
  check("no earlier reading, no change", r.delta === null);
  const snaps = [{ date: "2026-10-30", totalPoints: 40, openPoints: 34, donePoints: 6 }];
  const r2 = ov.carryOverRisk({ summary, snapshots: snaps, now: new Date(2026, 10, 2, 12) });
  // On Fri 30 Oct, 4 days behind: 1.5/day × 6 left = 9 of 34 → 25/40.
  check("previous reading recomputed the same way", near(r2.previous, 0.625));
  check("change is now minus then", near(r2.delta, -0.125));
  check("day one has no pace", ov.carryOverRisk({ summary: { ...summary, daysElapsed: 0 } }).risk === null);
  const ended = ov.carryOverRisk({ summary: { ...summary, isOverdue: true } });
  check("an ended sprint reports what is still open", near(ended.risk, 0.75) && ended.ended);
}

section("previous readings and the previous sprint");
{
  const snaps = [
    { date: "2026-11-02", blocked: 2 },
    { date: "2026-11-03", blocked: 3 },
    { date: "2026-11-04", blocked: 9 },
    { date: "2026-11-01" },
  ];
  const p = ov.previousReading(snaps, "blocked", new Date(2026, 10, 4, 12));
  check("latest earlier day carrying the field", p.date === "2026-11-03" && p.value === 3);
  check("none before the first", ov.previousReading([{ date: "2026-11-04", blocked: 1 }], "blocked", new Date(2026, 10, 4)) === null);

  const closed = [{ id: 9, state: "closed" }, { id: 8, state: "closed" }, { id: 7, state: "closed" }];
  check("running sprint → last closed", ov.previousSprintFor({ id: 10, state: "active" }, closed).id === 9);
  check("closed sprint → the one before it", ov.previousSprintFor({ id: 8, state: "closed" }, closed).id === 7);
  check("oldest has none", ov.previousSprintFor({ id: 7, state: "closed" }, closed) === null);

  const prev = [
    issue({ status: "Done", events: [statusEvent("2026-10-14T10:00:00Z", "In Progress", "Done")] }),
    issue({ status: "Done", events: [statusEvent("2026-10-21T10:00:00Z", "In Progress", "Done")] }),
    issue({ status: "Done" }),
    issue({ status: "In Progress", events: [statusEvent("2026-10-15T10:00:00Z", "To Do", "In Progress")] }),
  ];
  const by = ov.closedBy(prev, { from: "2026-10-12T00:00:00Z", cutoff: "2026-10-16T23:59:59Z", statusGroups: GROUPS });
  check("closed by the cutoff, not after it", by.count === 1);
  check("a done issue with no history makes it a floor", by.partial);
}

section("reviewTurnaround");
{
  const stats = {
    since: "2026-10-01T00:00:00Z",
    pullRequests: [
      { repo: "r", number: 1, author: "x", createdAt: "2026-10-27T10:00:00Z" },
      { repo: "r", number: 2, author: "x", createdAt: "2026-10-28T10:00:00Z" },
      { repo: "r", number: 3, author: "y", createdAt: "2026-10-29T10:00:00Z" },
      { repo: "r", number: 4, author: "y", createdAt: "2026-10-29T10:00:00Z" },
      { repo: "r", number: 5, author: "y", createdAt: "2026-10-10T10:00:00Z" },
    ],
    reviews: [
      { repo: "r", number: 1, author: "y", prAuthor: "x", submittedAt: "2026-10-28T10:00:00Z" },
      { repo: "r", number: 1, author: "z", prAuthor: "x", submittedAt: "2026-10-27T22:00:00Z" },
      { repo: "r", number: 2, author: "y", prAuthor: "x", submittedAt: "2026-10-31T10:00:00Z" },
      { repo: "r", number: 3, author: "y", prAuthor: "y", submittedAt: "2026-10-29T12:00:00Z" },
      { repo: "r", number: 4, author: "x", prAuthor: "y", submittedAt: "2026-10-30T10:00:00Z" },
    ],
  };
  const t = ov.reviewTurnaround(stats, { since: "2026-10-26T00:00:00Z" });
  // Waits: PR1 0.5 (earliest review), PR2 3, PR4 1 → median 1.
  check("first review by someone else, median of the waits", near(t.median, 1));
  check("own reviews don't count; unreviewed counted apart", t.reviewed === 3 && t.unreviewed === 1);
  check("outside the window is ignored", ov.reviewTurnaround(stats, { since: "2026-10-01", until: "2026-10-20" }).median === null);
  check("no stats, no answer", ov.reviewTurnaround(null) === null);
}

section("attentionChecks");
{
  const now = new Date("2026-11-04T12:00:00");
  const issues = [
    issue({ status: "In Progress", points: 3, extra: { duedate: "2026-11-01" } }),
    issue({ status: "Done", points: 3, extra: { duedate: "2026-11-01" } }),
    issue({ status: "Blocked", points: 2, events: [statusEvent("2026-10-30T09:00:00Z", "In Progress", "Blocked")] }),
    issue({ status: "Blocked", points: 2, events: [statusEvent("2026-11-03T09:00:00Z", "In Progress", "Blocked")] }),
    issue({ status: "Blocked", points: 2 }),
    issue({ status: "To Do", who: null }),
    issue({ status: "To Do", created: "2026-11-02T09:00:00Z", points: 1 }),
  ];
  const prs = [
    { repo: "r", number: 1, state: "waiting-review", ageDays: 4, title: "old" },
    { repo: "r", number: 2, state: "waiting-review", ageDays: 1, title: "new" },
    { repo: "r", number: 3, state: "approved", ageDays: 9, title: "approved" },
  ];
  const links = [
    {
      key: issues[0].key,
      fields: {
        summary: "x",
        issuelinks: [
          { type: { inward: "is blocked by" }, inwardIssue: { key: "XYZ-1", fields: { status: { name: "To Do", statusCategory: { key: "new" } } } } },
          { type: { inward: "is blocked by" }, inwardIssue: { key: "XYZ-2", fields: { status: { name: "Done", statusCategory: { key: "done" } } } } },
          { type: { outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "XYZ-3" } },
        ],
      },
    },
    { key: issues[1].key, fields: { issuelinks: [{ type: { inward: "is blocked by" }, inwardIssue: { key: "XYZ-4", fields: { status: { statusCategory: { key: "new" } } } } }] } },
  ];
  const checks = ov.attentionChecks({
    issues, statusGroups: GROUPS, windowStart: new Date(2026, 9, 26), pullRequests: prs,
    githubState: "ready", links, linksState: "ready", now,
  });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  check("seven checks", checks.length === 7);
  check("overdue skips done", by.overdue.count === 1);
  check("blocked over two days, plus the one with no history", by.blocked.count === 2);
  check("an unknown blocked age says so", by.blocked.rows.some((r) => /unknown/.test(r.detail)));
  check("PRs waiting past two days only", by.prs.count === 1 && by.prs.rows[0].key === "r#1");
  check("unestimated open work", by.unestimated.count === 1);
  check("unassigned open work", by.unassigned.count === 1);
  check("scope added after the start, by creation without a freeze", by.added.count === 1);
  check("dependencies: open blocker on an open issue only", by.deps.count === 1 && /XYZ-1/.test(by.deps.rows[0].detail));
  const waiting = ov.attentionChecks({ issues, pullRequests: null, githubState: "loading", links: null, linksState: "loading", now });
  const w = Object.fromEntries(waiting.map((c) => [c.id, c]));
  check("still looking is a state, not zero", w.prs.state === "loading" && w.deps.state === "loading");
  check("GitHub off says off", ov.attentionChecks({ issues, githubState: "off", now }).find((c) => c.id === "prs").state === "off");
  const freeze = { rows: issues.slice(0, 6).map((i) => ({ key: i.key })) };
  const frozen = ov.attentionChecks({ issues, freeze, now }).find((c) => c.id === "added");
  check("with a freeze, added is set membership", frozen.count === 1 && frozen.rows[0].key === issues[6].key);
}

section("quietMembers and sinceLastStandup");
{
  const members = [
    { accountId: "a", githubLogin: "al" },
    { accountId: "b", githubLogin: "bo" },
    { accountId: "c", githubLogin: "" },
  ];
  const jira = { hasHistory: true, byPerson: [{ key: "a", transitions: 2 }, { key: "b", transitions: 0, edits: 0 }] };
  const statsFor = (_s, login) => (login === "bo" ? { prsOpened: 1 } : { prsOpened: 0 });
  const q = ov.quietMembers({ members, jira, github: {}, statsFor, since: "x" });
  check("moved in Jira or pushed on GitHub is not quiet", q.quiet.map((m) => m.accountId).join(",") === "c");
  const blind = ov.quietMembers({ members, jira: { hasHistory: false, byPerson: [] }, github: null });
  check("no history and no GitHub cannot tell", blind.unknown);

  const issues = [
    issue({ status: "Done", events: [statusEvent("2026-11-03T15:00:00Z", "In Review", "Done")] }),
    issue({ status: "In Progress", events: [statusEvent("2026-11-03T16:00:00Z", "To Do", "In Progress"), statusEvent("2026-11-01T10:00:00Z", "x", "To Do")] }),
    issue({ status: "To Do", created: "2026-11-03T17:00:00Z" }),
  ];
  const m = ov.sinceLastStandup({ issues, since: "2026-11-03T09:30:00Z", statusGroups: GROUPS });
  check("closed since the standup", m.closed.length === 1);
  check("moves counted inside the window only", m.moves === 2);
  check("created since the standup", m.created.length === 1);
  check("no standup, no reading", ov.sinceLastStandup({ issues, since: "" }) === null);
}

section("roster role");
{
  check("role kept, trimmed", team.normalizeMember({ role: "  Data Engineer " }).role === "Data Engineer");
  check("role defaults empty", team.normalizeMember({}).role === "");
  check("role clipped to 40", team.normalizeMember({ role: "x".repeat(60) }).role.length === 40);
}

section("donutChart");
{
  const svg = charts.donutChart(
    [
      { label: "To Do", value: 4, fill: "#111" },
      { label: "Done", value: 5, fill: "#222" },
      { label: "Blocked", value: 1, fill: "#333" },
      { label: "Empty", value: 0, fill: "#444" },
    ],
    { size: 160, thickness: 20, centerValue: "10", centerLabel: "issues" }
  );
  const all = [svg, ...svg.descendants()].filter((n) => n instanceof FakeNode);
  const paths = all.filter((n) => n.tagName === "path");
  check("one path per non-empty segment", paths.length === 3);
  const coords = paths.flatMap((p) => [...p.attrs.d.matchAll(/-?\d*\.?\d+/g)].map((m) => Number(m[0])));
  check("every coordinate finite", coords.every(Number.isFinite));
  check("every coordinate inside the viewBox", coords.every((n) => n >= 0 && n <= 160));
  check("total in the middle", all.some((n) => n.tagName === "text" && n.textContent === "10"));
  const titles = all.filter((n) => n.tagName === "title").map((n) => n.textContent);
  check("each segment names itself with its share", titles.includes("Blocked: 1 (10%)"));
  const one = charts.donutChart([{ label: "Done", value: 3, fill: "#222" }], {});
  check("a single segment is a full ring", one.descendants().filter((n) => n.tagName === "path").length === 1);
  check("nothing to show is an empty state", charts.donutChart([{ label: "x", value: 0 }], {}).tagName === "div");
}

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
