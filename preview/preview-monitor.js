// Local preview harness for the Monitor.
//
// Mounts the real js/views/monitor.js against stubbed extension storage and a
// stubbed Jira, so the hygiene checks can be looked at without a site or a
// token. Not shipped: scripts/build.mjs copies an explicit file list, and this
// is not on it. Open with:
//
//   open preview-monitor.html            (or serve the folder over http)
//
// Monitor and Kanban were the two views with no harness, and every light-theme
// bug the 2026-09-05 design review found was in a view that had none. The
// states below are the ones a screenshot cannot otherwise reach: this screen
// is mostly *conditional* — a check can be unavailable, a roster can be absent,
// every check can be muted, and the good day, when there is nothing to report,
// is the state a live Jira will never show you on demand.
//
// Fixture states:
//   ?theme=light      the theme most bugs hide in
//   ?clean=1          every issue in order — the "nothing to fix" headline
//   ?fields=none      no story points field mapped, so that check is
//                     unavailable rather than flagging every issue
//   ?roster=off       no team roster, so the Team Only toggle is absent
//   ?checks=muted     every check muted — the empty state
//   ?scope=all        starts on the wider scope, with the backlog folded in
//
// Self-contained rather than built on preview-fixture.js, following
// preview-gantt.js: this view wants issues that are deliberately *wrong* in
// four specific ways, which is the opposite of the tidy sprint that fixture
// keeps stable for the dashboard and the recap.

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

// ── Stubbed extension storage ───────────────────────────────────────────────
const local = {};
const sync = {};
const pick = (store, keys) =>
  keys == null
    ? { ...store }
    : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
      );
const area = (store) => ({
  get: (keys) => Promise.resolve(pick(store, keys)),
  set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
  remove: (keys) => { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
});
globalThis.chrome = {
  runtime: { getURL: (p) => `../${p}` },
  storage: { local: area(local), sync: area(sync) },
};
if (params.get("scope") === "all") local.monitorScope = "all";

const day = 86400000;
const iso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * day);
  // Local components, not toISOString(): a due date is a calendar day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const PEOPLE = [
  ["Avery Quinn", "acc-0"],
  ["Bo Ferreira", "acc-1"],
  ["Cy Nakamura", "acc-2"],
  // Deliberately not on the roster: the Team Only toggle has to have something
  // to hide, and "assigned to somebody outside the team" is the case it exists
  // for.
  ["Kit Marlowe", "acc-9"],
];

const CAT = { new: "new", doing: "indeterminate", done: "done" };
const clean = params.get("clean") === "1";

// [key, type, assignee index or null, epic key or null, due offset or null,
//  points or null, status category]
//
// Written out rather than generated: each row is a specific finding, and the
// point of a fixture for this screen is that every check has something to say
// and each says a different amount.
const SPEC = [
  ["ACME-101", "Story", 0, "ACME-100", -2, 5, CAT.doing],
  ["ACME-102", "Story", null, "ACME-100", 4, 3, CAT.doing],       // unassigned
  ["ACME-103", "Story", 1, null, 3, 2, CAT.doing],               // no epic
  ["ACME-104", "Story", 2, "ACME-100", null, 8, CAT.new],         // no due date
  ["ACME-105", "Bug", 0, "ACME-100", 6, null, CAT.new],           // no points
  ["ACME-106", "Story", null, null, null, null, CAT.new],        // all four
  ["ACME-107", "Sub-task", null, null, null, null, CAT.doing],   // excluded: sub-task
  ["ACME-100", "Epic", 0, null, 30, null, CAT.doing],            // excluded: epic
  ["ACME-108", "Story", 1, "ACME-100", -8, 3, CAT.done],          // excluded: done
  ["ACME-109", "Story", 3, "ACME-100", 9, null, CAT.doing],       // outside the team
  ["PLAT-11", "Story", 2, "PLAT-10", 5, 5, CAT.doing],
  ["PLAT-12", "Story", null, "PLAT-10", 2, 3, CAT.doing],       // unassigned
  ["PLAT-13", "Task", 1, null, null, 2, CAT.new],               // no epic, no due
];

const SUMMARIES = {
  "ACME-101": "Fix the retry backoff",
  "ACME-102": "Backfill the January export",
  "ACME-103": "Retry the delivery webhook",
  "ACME-104": "Split the index writer",
  "ACME-105": "Rounding in the usage report",
  "ACME-106": "Bulk import, second pass",
  "ACME-107": "Add the fixture for the retry path",
  "ACME-100": "Importer rewrite",
  "ACME-108": "Archive the 2024 exports",
  "ACME-109": "Nightly job alerting",
  "PLAT-11": "Cut over the read path",
  "PLAT-12": "Warehouse cost budget",
  "PLAT-13": "Rotate the runner images",
};

const STATUS_FOR = {
  [CAT.new]: { name: "To Do", statusCategory: { key: CAT.new } },
  [CAT.doing]: { name: "In Progress", statusCategory: { key: CAT.doing } },
  [CAT.done]: { name: "Done", statusCategory: { key: CAT.done } },
};

const BOARD_OF = { ACME: 1, PLAT: 2 };

const issueFrom = ([key, type, personIdx, epic, due, points, cat], i) => {
  const person = personIdx == null ? null : PEOPLE[personIdx];
  // ?clean=1 fills in everything every check asks for, which is the state
  // nobody's real Jira is ever in and the one the "nothing to fix" headline was
  // written for.
  const assignee = clean ? PEOPLE[i % 3] : person;
  return {
    id: String(6000 + i),
    key,
    boardId: BOARD_OF[key.split("-")[0]],
    fields: {
      summary: SUMMARIES[key] || key,
      issuetype: { name: type, subtask: type === "Sub-task" },
      status: STATUS_FOR[cat],
      assignee: assignee ? { displayName: assignee[0], accountId: assignee[1] } : null,
      duedate: clean ? iso(7) : due == null ? null : iso(due),
      customfield_points: clean ? 5 : points,
      parent: (clean ? "ACME-100" : epic) && type !== "Epic"
        ? { key: clean ? "ACME-100" : epic, fields: { summary: "Importer rewrite" } }
        : undefined,
      created: iso(-20),
      updated: iso(0),
    },
  };
};

const SPRINT_ISSUES = SPEC.map(issueFrom);
const BACKLOG_ISSUES = [
  ["ACME-140", "Story", null, null, null, null, CAT.new],
  ["ACME-141", "Story", 2, null, null, 3, CAT.new],
  ["PLAT-40", "Story", null, "PLAT-10", null, null, CAT.new],
].map((spec, i) => {
  const issue = issueFrom(spec, 200 + i);
  issue.fields.summary = { "ACME-140": "Index split, phase two", "ACME-141": "Rewrite the nightly snapshot", "PLAT-40": "Access review tooling" }[issue.key];
  return issue;
});

// ── Stubbed Jira ────────────────────────────────────────────────────────────
globalThis.fetch = async (input) => {
  const url = String(input);
  const json = (body) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => structuredClone(body), text: async () => JSON.stringify(body),
  });

  const sprintList = /\/board\/(\d+)\/sprint(\?|$)/.exec(url);
  if (sprintList) {
    return json({ values: [{ id: 40 + Number(sprintList[1]), name: `Sprint ${sprintList[1]}`, state: "active" }] });
  }
  const sprintIssues = /\/board\/(\d+)\/sprint\/(\d+)\/issue/.exec(url);
  if (sprintIssues) {
    const issues = SPRINT_ISSUES.filter((i) => i.boardId === Number(sprintIssues[1]));
    return json({ issues, total: issues.length });
  }
  const backlog = /\/board\/(\d+)\/backlog/.exec(url);
  if (backlog) {
    const issues = BACKLOG_ISSUES.filter((i) => i.boardId === Number(backlog[1]));
    return json({ issues, total: issues.length });
  }
  const single = /\/rest\/api\/3\/issue\/([A-Za-z]+-\d+)(\?|$)/.exec(url);
  if (single) {
    const issue = [...SPRINT_ISSUES, ...BACKLOG_ISSUES].find((i) => i.key === single[1]);
    return json(issue || SPRINT_ISSUES[0]);
  }
  return json({ values: [], issues: [], total: 0, isLast: true });
};

// ── Config ──────────────────────────────────────────────────────────────────
const { saveConfig } = await import("../js/config.js");
await saveConfig({
  site: { baseUrl: "https://preview.atlassian.net" },
  boards: [
    { id: 1, name: "Acme web", projectKey: "ACME", color: "#4F8EF7" },
    { id: 2, name: "Platform", projectKey: "PLAT", color: "#A855F7" },
  ],
  // ?fields=none leaves story points unmapped, which is the difference between
  // a check that is off and a check that has nothing to read. Monitor reports
  // the second as unavailable rather than flagging every issue in the sprint —
  // a check that flags everything teaches people to ignore it.
  fields: params.get("fields") === "none"
    ? { storyPoints: [], sprint: [], startDate: [], epicLink: [], epicName: [] }
    : { storyPoints: ["customfield_points"], sprint: [], startDate: [], epicLink: ["parent"], epicName: [] },
  monitorChecks: params.get("checks") === "muted"
    ? { unassigned: false, noEpic: false, noDueDate: false, noPoints: false }
    : {},
});

// BOARDS in js/utils.js is a module-level array the API layer iterates, and it
// stays empty until this runs — saveConfig() alone is not enough.
const { loadBoards } = await import("../js/utils.js");
await loadBoards();

// The roster decides whether the Team Only toggle exists at all, so it is a
// fixture state rather than a fixed fact. Synthetic names, as everywhere else
// here: no colleague belongs in a fixture file.
const { TEAMS, loadTeamOnly, saveTeam } = await import("../js/team.js");
if (params.get("roster") !== "off") {
  await saveTeam({
    activeTeamId: "default",
    teams: [{
      id: "default",
      name: "Data Engineering",
      members: PEOPLE.slice(0, 3).map(([jiraName, accountId]) => ({
        accountId, jiraName, nameOverride: "", email: "", active: true,
      })),
    }],
  });
} else {
  TEAMS.teams = [{ id: "default", name: "My team", members: [] }];
}
await loadTeamOnly();

const { mount } = await import("../js/views/monitor.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);
