// Local preview harness for the roadmap (Gantt) view.
//
// Mounts the real js/views/gantt.js against stubbed extension storage and a
// stubbed Jira, so the chart can be looked at without a site or a token. Not
// shipped: scripts/build.mjs copies an explicit file list, and this is not on
// it. Open with:
//
//   open preview-gantt.html              (or serve the folder over http)
//
// This view had no harness, which is why its light theme shipped with dark
// zebra stripes and an invisible today marker: there was nowhere to look at it
// except a live Jira, and nobody looks at a live Jira in light theme on
// purpose.
//
// Fixture states: ?theme=light · ?epics=none · ?epics=undated
//
// The epics are laid out relative to today rather than on fixed dates, so the
// delivery colours and the today line stay meaningful whenever this is opened:
// two comfortably in the future, one inside the due-soon window, one overdue
// and still open, one done, and one with no due date at all.

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

const day = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

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

const STATUS = {
  todo: { name: "To Do", statusCategory: { key: "new" } },
  doing: { name: "In Progress", statusCategory: { key: "indeterminate" } },
  done: { name: "Done", statusCategory: { key: "done" } },
};

// [key, summary, startOffset, dueOffset, status] — offsets in days from today.
const EPIC_SPEC = [
  ["ACME-100", "Importer rewrite", -30, 40, STATUS.doing],
  ["ACME-140", "Index split, phase two", -6, 26, STATUS.doing],
  ["ACME-180", "Customer onboarding", -20, 4, STATUS.doing],
  ["ACME-210", "Delivery retries", -45, -9, STATUS.doing],
  ["ACME-240", "Raw ingestion", -60, -22, STATUS.done],
  ["PLAT-10", "Warehouse migration", -18, 55, STATUS.doing],
  ["PLAT-40", "Access review tooling", -12, 2, STATUS.doing],
  ["PLAT-70", "Observability baseline", -50, -3, STATUS.doing],
];

const EPICS = EPIC_SPEC.map(([key, summary, start, due, status], i) => ({
  id: String(9000 + i),
  key,
  fields: {
    summary,
    issuetype: { name: "Epic" },
    status,
    duedate: params.get("epics") === "undated" ? null : iso(due),
    customfield_start: iso(start),
    assignee: { displayName: "Avery Quinn", accountId: "acc-0" },
  },
}));

const CHILDREN = {
  "ACME-100": [
    ["ACME-101", "Fix the retry backoff", -20, 6, STATUS.doing],
    ["ACME-102", "Backfill the January export", -14, 18, STATUS.todo],
  ],
  "PLAT-10": [
    ["PLAT-11", "Cut over the read path", -10, 20, STATUS.doing],
  ],
};

const childIssue = ([key, summary, start, due, status]) => ({
  key,
  fields: {
    summary,
    issuetype: { name: "Story" },
    status,
    duedate: iso(due),
    customfield_start: iso(start),
    created: iso(start),
    updated: iso(0),
  },
});

// The epic query is a POST to /rest/api/3/search/jql with the JQL in the body,
// so the stub has to read `init`, not just the URL.
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  let body = {};
  try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
  const jql = body.jql || decodeURIComponent(url);
  const json = (body) => ({
    ok: true,
    status: 200,
    json: async () => structuredClone(body),
    text: async () => JSON.stringify(body),
  });

  if (url.includes("/search")) {
    // The epic query the roadmap makes on mount.
    if (jql.includes("issuetype = Epic")) {
      const issues = params.get("epics") === "none" ? [] : EPICS;
      return json({ issues, total: issues.length, isLast: true });
    }
    // Children of one epic, asked for when a caret is clicked.
    const parent = Object.keys(CHILDREN).find((k) => jql.includes(k));
    const kids = (CHILDREN[parent] || []).map(childIssue);
    return json({ issues: kids, total: kids.length, isLast: true });
  }
  return json({ values: [], issues: [], total: 0, isLast: true });
};

// Seed storage, then load the boards — `BOARDS` in js/utils.js is what
// getAllEpics() builds its project-key list from, and it stays empty until
// loadBoards() syncs it from the stored config. Without this the roadmap
// renders its empty state against a fixture full of epics.
const { saveConfig } = await import("./js/config.js");
await saveConfig({
  site: { baseUrl: "https://preview.atlassian.net" },
  boards: [
    { id: 1, name: "Acme web", projectKey: "ACME", color: "#4F8EF7" },
    { id: 2, name: "Platform", projectKey: "PLAT", color: "#A855F7" },
  ],
  fields: { startDate: ["customfield_start"], storyPoints: [], sprint: [], epicLink: [], epicName: [] },
});
const { loadBoards } = await import("./js/utils.js");
await loadBoards();

const { mount } = await import("./js/views/gantt.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);
