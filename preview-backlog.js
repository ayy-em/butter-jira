// Local preview harness for the backlog screen.
//
// Runs the real js/views/backlog.js against stubbed extension storage and a
// stubbed Jira, so the table can be looked at without a site or a token. Not
// shipped: scripts/build.mjs copies an explicit file list, and this is not on
// it. Serve the folder over http and open preview-backlog.html.
//
//   ?theme=light · ?group=status · ?empty=1

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

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
  runtime: { getURL: (p) => p },
  storage: { local: area(local), sync: area(sync) },
};

// ── Fake Jira ────────────────────────────────────────────────────────────────

// Deliberately includes statuses that the configured groups fold together
// ("In Development" → In Progress, "Code Review" → In Review) and a type the
// tone table does not know ("Spike"), so both fallbacks are visible.
const TYPES = ["Epic", "Story", "Task", "Bug", "Sub-task", "Spike"];
const STATUSES = [
  ["To Do", "new"], ["In Progress", "indeterminate"], ["In Development", "indeterminate"],
  ["Code Review", "indeterminate"], ["In Review", "indeterminate"], ["Done", "done"],
  ["Blocked", "indeterminate"],
];
const PEOPLE = ["Avery", "Bo", "Cy", "Devi", "Emil", "Freya", "Gil"];

const iso = (daysAgo) => new Date(Date.UTC(2026, 7, 7 - daysAgo)).toISOString();

function makeIssues(count, boardId, prefix) {
  return Array.from({ length: count }, (_, i) => {
    const type = TYPES[i % TYPES.length];
    const status = STATUSES[(i * 3) % STATUSES.length];
    const person = PEOPLE[i % PEOPLE.length];
    return {
      id: `${prefix}-${i}`,
      key: `${prefix}-${100 + i}`,
      boardId,
      fields: {
        summary: `${type} work item ${i + 1} — something that needs doing`,
        issuetype: { name: type },
        status: { name: status[0], statusCategory: { key: status[1] } },
        assignee: { accountId: `acc-${i % PEOPLE.length}`, displayName: person },
        duedate: i % 5 === 0 ? iso(i % 11) : null,
        updated: iso(i % 30),
        customfield_10016: [1, 2, 3, 5, 8, 13][i % 6],
      },
    };
  });
}

const EMPTY = params.get("empty") === "1";
const N = Number(params.get("n") || 120);
const BACKLOG = EMPTY ? [] : makeIssues(N, 1, "ACME");
const SPRINT = EMPTY ? [] : makeIssues(EMPTY ? 0 : Math.ceil(N / 3), 1, "SPR");

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (body) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  if (url.includes("/search/jql")) {
    return json({ issues: [], isLast: true });   // epic names: none
  }
  if (url.includes("/backlog")) return json({ issues: BACKLOG, total: BACKLOG.length });
  if (url.includes("/sprint/41/issue")) return json({ issues: SPRINT, total: SPRINT.length });
  if (url.includes("/sprint")) return json({ values: [{ id: 41, name: "Sprint 41", state: "active" }] });
  return json({ values: [], issues: [], total: 0 });
};

// ── Seed config and roster ───────────────────────────────────────────────────

const { loadConfig, saveConfig } = await import("./js/config.js");
await saveConfig({
  site: { baseUrl: "https://example.atlassian.net", wikiPath: "/wiki" },
  boards: [{ id: 1, name: "ACME", projectKey: "ACME", color: "#4F8EF7" }],
  fields: { storyPoints: ["customfield_10016"], startDate: [], epicLink: [], epicName: [], sprint: [] },
  statusGroups: [
    { name: "To Do", statuses: ["To Do", "Open", "Backlog", "New"] },
    { name: "In Progress", statuses: ["In Progress", "In Development"] },
    { name: "In Review", statuses: ["In Review", "Code Review", "In Code Review"] },
    { name: "Blocked", statuses: ["Blocked", "On Hold"] },
    { name: "Done", statuses: ["Done", "Closed", "Resolved"] },
  ],
});
await loadConfig();

const { loadBoards } = await import("./js/utils.js");
await loadBoards();

const { TEAMS, saveTeam } = await import("./js/team.js");
TEAMS.activeTeamId = "default";
TEAMS.teams = [{
  id: "default",
  name: "Preview Team",
  members: PEOPLE.map((name, i) => ({
    accountId: `acc-${i}`, jiraName: name, nameOverride: "", email: "",
    active: true, githubLogin: "", slackHandle: "", avatarUrl: "",
  })),
}];
await saveTeam(TEAMS);

const prefs = {};
if (params.get("group")) prefs.groupBy = params.get("group");
if (params.get("sort")) {
  prefs.sortCol = params.get("sort");
  prefs.sortDir = params.get("dir") === "desc" ? "desc" : "asc";
}
if (params.get("density")) prefs.density = params.get("density");
if (Object.keys(prefs).length) local.backlogPrefs = prefs;

const { mount } = await import("./js/views/backlog.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);
