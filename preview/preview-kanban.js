// Local preview harness for the Kanban board.
//
// Mounts the real js/views/kanban.js against stubbed extension storage and a
// stubbed Jira, so the board — and the column editor behind the COLUMNS button
// — can be looked at without a site or a token. Not shipped: scripts/build.mjs
// copies an explicit file list, and this is not on it. Open with:
//
//   open preview-kanban.html             (or serve the folder over http)
//
// This view had no harness, which is the reason it is where the design review
// kept finding things: there was nowhere to look at the column editor except a
// live Jira with somebody else's statuses in it.
//
// Fixture states:
//   ?theme=light   the theme most bugs hide in
//   ?editor=1      opens the column editor on load, which is the whole point
//   ?groups=stale  configured columns that do not match the site's statuses —
//                  what a fresh clone actually looks like on day one
//   ?groups=none   no configured columns at all
//   ?refuse=1      every transition refused, to see the drag/move refusal
//
// Self-contained rather than built on preview-fixture.js, following
// preview-gantt.js: this view wants a *wide* spread of statuses across two
// boards, which is the opposite of the tight, deterministic sprint that fixture
// exists to keep stable for the dashboard and the recap.

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

// ── The site's statuses ─────────────────────────────────────────────────────
// Deliberately not the four the app ships as defaults. A real site has more
// statuses than columns, spells them its own way, and has at least one nobody
// remembers — which is the case the column editor exists to serve.
const CAT = { new: "new", doing: "indeterminate", done: "done" };
const STATUSES = [
  ["Backlog", CAT.new],
  ["Selected for Dev", CAT.new],
  ["In Progress", CAT.doing],
  ["Blocked", CAT.doing],
  ["In Code Review", CAT.doing],
  ["Ready for QA", CAT.doing],
  ["QA", CAT.doing],
  ["Awaiting Release", CAT.doing],
  ["Done", CAT.done],
  ["Won't Do", CAT.done],
];
const status = (name) => {
  const found = STATUSES.find((s) => s[0] === name);
  return { name, statusCategory: { key: found ? found[1] : CAT.doing } };
};

const PEOPLE = [
  ["Avery Quinn", "acc-0"],
  ["Bo Ferreira", "acc-1"],
  ["Cy Nakamura", "acc-2"],
  ["Devi Okonjo", "acc-3"],
];

const day = 86400000;
const iso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * day);
  // Local components, not toISOString(): a due date is a calendar day, and
  // formatting one through UTC moves it a day east of Greenwich.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// [key, summary, status, assignee index, priority, due offset or null]
const ISSUE_SPEC = [
  ["ACME-101", "Fix the retry backoff", "In Progress", 0, "Highest", -2],
  ["ACME-102", "Backfill the January export", "In Code Review", 1, "High", 3],
  ["ACME-103", "Retry the delivery webhook", "Blocked", 0, "High", 1],
  ["ACME-104", "Split the index writer", "Selected for Dev", 2, "Medium", 9],
  ["ACME-105", "Drop the legacy importer", "Backlog", null, "Low", null],
  ["ACME-106", "Bulk import, second pass", "Ready for QA", 3, "Medium", 5],
  ["ACME-107", "Rounding in the usage report", "QA", 1, "Medium", null],
  ["ACME-108", "Nightly job alerting", "Awaiting Release", 2, "High", 2],
  ["ACME-109", "Archive the 2024 exports", "Done", 3, "Low", -6],
  ["ACME-110", "Duplicate submission guard", "Won't Do", null, "Low", null],
  ["PLAT-11", "Cut over the read path", "In Progress", 2, "Highest", 0],
  ["PLAT-12", "Warehouse cost budget", "Backlog", null, "Medium", null],
  ["PLAT-13", "Access review export", "In Code Review", 3, "Medium", 4],
  ["PLAT-14", "Observability baseline", "Blocked", 0, "High", -1],
  ["PLAT-15", "Rotate the runner images", "Done", 1, "Low", -9],
];

const BOARD_OF = { ACME: 1, PLAT: 2 };
const issueFrom = ([key, summary, statusName, personIdx, priority, due], i) => {
  const project = key.split("-")[0];
  const person = personIdx == null ? null : PEOPLE[personIdx];
  return {
    id: String(7000 + i),
    key,
    boardId: BOARD_OF[project],
    fields: {
      summary,
      issuetype: { name: "Story" },
      status: status(statusName),
      priority: { name: priority },
      duedate: due == null ? null : iso(due),
      assignee: person ? { displayName: person[0], accountId: person[1] } : null,
      created: iso(-20),
      updated: iso(0),
    },
  };
};

const SPRINT_ISSUES = ISSUE_SPEC.map(issueFrom);
// The backlog is what ?All reveals; keys the sprint does not already carry, so
// the toggle visibly changes the board rather than looking like a no-op.
const BACKLOG_ISSUES = [
  ["ACME-140", "Index split, phase two", "Backlog", null, "Medium", null],
  ["ACME-141", "Rewrite the nightly snapshot", "Backlog", 2, "Low", null],
  ["PLAT-40", "Access review tooling", "Selected for Dev", null, "Medium", 30],
].map((spec, i) => issueFrom(spec, 100 + i));

// ── Stubbed Jira ────────────────────────────────────────────────────────────
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (body) => ({
    ok: true, status: 200, headers: { get: () => null },
    // Cloned: some readers reduce what they get in place, and handing out the
    // fixture's own objects means the second read sees what the first consumed.
    json: async () => structuredClone(body), text: async () => JSON.stringify(body),
  });

  const sprintList = /\/board\/(\d+)\/sprint(\?|$)/.exec(url);
  if (sprintList) {
    return json({ values: [{ id: 40 + Number(sprintList[1]), name: `Sprint ${sprintList[1]}`, state: "active" }] });
  }

  const sprintIssues = /\/board\/(\d+)\/sprint\/(\d+)\/issue/.exec(url);
  if (sprintIssues) {
    const boardId = Number(sprintIssues[1]);
    const issues = SPRINT_ISSUES.filter((i) => i.boardId === boardId);
    return json({ issues, total: issues.length });
  }

  const backlog = /\/board\/(\d+)\/backlog/.exec(url);
  if (backlog) {
    const boardId = Number(backlog[1]);
    const issues = BACKLOG_ISSUES.filter((i) => i.boardId === boardId);
    return json({ issues, total: issues.length });
  }

  // Moving a card asks the workflow what it allows, per issue, at the moment of
  // the move — so the harness answers per issue too. ?refuse=1 answers with a
  // workflow that allows nothing, which is the interesting half: it is the
  // refusal wording, not the happy path, that a room reads off a shared screen.
  const transitions = /\/rest\/api\/3\/issue\/([^/?]+)\/transitions/.exec(url);
  if (transitions) {
    if (params.get("refuse") === "1") return json({ transitions: [] });
    const key = decodeURIComponent(transitions[1]);
    const issue = [...SPRINT_ISSUES, ...BACKLOG_ISSUES].find((i) => i.key === key);
    const from = issue?.fields.status.name;
    return json({
      transitions: STATUSES.filter(([name]) => name !== from).map(([name], i) => ({
        id: String(100 + i),
        name: `Move to ${name}`,
        to: status(name),
      })),
    });
  }

  const single = /\/rest\/api\/3\/issue\/([A-Za-z]+-\d+)(\?|$)/.exec(url);
  if (single) {
    const issue = [...SPRINT_ISSUES, ...BACKLOG_ISSUES].find((i) => i.key === single[1]);
    return json(issue || SPRINT_ISSUES[0]);
  }

  return json({ values: [], issues: [], total: 0, isLast: true });
};

// ── Config ──────────────────────────────────────────────────────────────────
// ?groups=stale is the state a fresh clone is actually in: the four columns the
// app ships with, against a site that spells almost none of them that way. That
// is the screen the column editor has to rescue, so it is worth being able to
// open on purpose.
const GROUPS = {
  default: [
    { name: "To Do", statuses: ["Backlog", "Selected for Dev"] },
    { name: "In Progress", statuses: ["In Progress", "Blocked"] },
    { name: "In Review", statuses: ["In Code Review", "Ready for QA", "QA"] },
    { name: "Done", statuses: ["Awaiting Release", "Done", "Won't Do"] },
  ],
  stale: [
    { name: "To Do", statuses: ["To Do"] },
    { name: "In Progress", statuses: ["In Progress"] },
    { name: "In Review", statuses: ["In Review"] },
    { name: "Done", statuses: ["Done"] },
  ],
  none: [],
};

const { saveConfig } = await import("../js/config.js");
await saveConfig({
  site: { baseUrl: "https://preview.atlassian.net" },
  boards: [
    { id: 1, name: "Acme web", projectKey: "ACME", color: "#4F8EF7" },
    { id: 2, name: "Platform", projectKey: "PLAT", color: "#A855F7" },
  ],
  fields: { storyPoints: [], sprint: [], startDate: [], epicLink: [], epicName: [] },
  statusGroups: GROUPS[params.get("groups")] || GROUPS.default,
});

// BOARDS in js/utils.js is a module-level array the API layer iterates, and it
// stays empty until this runs — saveConfig() alone is not enough, and an empty
// BOARDS means "no sprints anywhere" rather than an error.
const { loadBoards } = await import("../js/utils.js");
await loadBoards();

const { mount } = await import("../js/views/kanban.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);

// The editor is the surface with the least support and the fewest eyes on it,
// and it is three clicks from a screenshot otherwise.
if (params.get("editor") === "1") {
  [...document.querySelectorAll(".kanban-group-btn")]
    .find((b) => b.textContent.trim().toLowerCase().startsWith("columns"))
    ?.click();
}
