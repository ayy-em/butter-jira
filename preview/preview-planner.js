// Local preview harness for Launch → Sprint planner (M15).
//
// The shared fixture's boards, roster and active sprints, plus what the planner
// reads that no other screen does: an upcoming sprint per board, with a couple
// of issues already in it, and a backlog with epics, labels, an issue on hold
// and a few unestimated ones. Every write is answered and logged to the
// console, so a push can be driven end to end. Invented data only. Not shipped.
//
// States: ?theme=light · ?push=fail (moving PLAT-312 is always refused, to see
// the batch break up, the retries and the report) · ?stage=plan (start on the
// plan screen with a prepared setup)
import { params } from "./preview-fixture.js";

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const nextMonday = (() => {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d.getTime();
})();

const FUTURE = {
  1: { id: 42, name: "Sprint 42: Importer v2", state: "future", startDate: iso(nextMonday), endDate: iso(nextMonday + 14 * DAY) },
  2: { id: 19, name: "PLAT 19: Index cutover", state: "future", startDate: iso(nextMonday), endDate: iso(nextMonday + 14 * DAY) },
  3: { id: 8, name: "DATA 8", state: "future" },
};
const PROJECT = { 1: "ACME", 2: "PLAT", 3: "DATA" };
const EPICS = { 1: ["ACME-700", "Importer v2"], 2: ["PLAT-300", "Index cutover"], 3: ["DATA-50", "Pipeline alerts"] };

const status = (name, key) => ({ name, statusCategory: { key } });
const TODO = status("To Do", "new");
const HOLD = status("On Hold", "indeterminate");
const PROG = status("In Progress", "indeterminate");
const person = (i) => ({ accountId: `acc-${i}`, displayName: ["Avery Quinn", "Bo Ferreira", "Cy Nakamura", "Devi Okonjo", "Emil Vance", "Freya Salib"][i] });

const issues = new Map();
function make(board, n, { summary, st = TODO, who = null, sp = null, epic = true, labels = [], priority = "Medium", due = null }) {
  const key = `${PROJECT[board]}-${n}`;
  const fields = {
    summary,
    status: st,
    assignee: who === null ? null : person(who),
    issuetype: { id: "10001", name: n % 3 ? "Story" : "Task", subtask: false },
    priority: { name: priority },
    labels,
    duedate: due,
    parent: epic ? { key: EPICS[board][0], fields: { summary: EPICS[board][1], issuetype: { name: "Epic" } } } : null,
  };
  if (sp !== null) fields.cf_sp = sp;
  const issue = { id: String(9000 + issues.size), key, fields };
  issues.set(key, issue);
  return issue;
}

// An issue from a board nobody configured, for "add by key or link".
function outsider(key) {
  const issue = { id: `o-${key}`, key, fields: { summary: "An issue from a board not being planned", status: TODO, assignee: null, issuetype: { id: "10001", name: "Task", subtask: false }, priority: { name: "Low" }, labels: [], cf_sp: 1 } };
  issues.set(key, issue);
  return issue;
}

const BACKLOG = {
  1: [
    make(1, 710, { summary: "Map legacy column names on import", st: PROG, who: 0, sp: 3, labels: ["importer"] }),
    make(1, 711, { summary: "Dry-run mode for the importer", sp: 2, labels: ["importer"], priority: "High" }),
    make(1, 712, { summary: "Importer progress bar", labels: ["ux"] }),
    make(1, 713, { summary: "Waiting on vendor schema", st: HOLD, who: 1, sp: 1, epic: false }),
    make(1, 714, { summary: "Retry failed rows", who: 2, sp: 5, due: iso(Date.now() - 3 * DAY).slice(0, 10) }),
  ],
  2: [
    make(2, 310, { summary: "Dual-write both index paths", who: 3, sp: 5, priority: "Highest" }),
    make(2, 311, { summary: "Backfill the new index", labels: ["ops"] }),
    make(2, 312, { summary: "Delete the old writer", sp: 2, epic: false }),
  ],
  3: [
    make(3, 60, { summary: "Alert on stalled pipelines", sp: 3 }),
    make(3, 61, { summary: "Page on missing partitions", labels: ["ops"] }),
  ],
};
const IN_FUTURE = {
  1: [make(1, 720, { summary: "Importer v2 kick-off spike", who: 0, sp: 1 })],
  2: [make(2, 320, { summary: "Nobody owns this yet", sp: 2 })],
  3: [],
};

const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const empty = () => ({ ok: true, status: 204, headers: { get: () => null }, json: async () => null, text: async () => "" });
const refuse = (status, body) => ({ ok: false, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const tag = (list, board) => list.map((i) => ({ ...structuredClone(i), boardId: board }));

let created = 0;
const base = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  if (method !== "GET" && !/search\/jql/.test(url)) console.info("[preview write]", method, url.replace(/^https:\/\/[^/]+/, ""), body);

  const future = /\/board\/(\d+)\/sprint\?.*state=future/.exec(url);
  if (future) return json({ values: [FUTURE[future[1]]].filter(Boolean), total: 1 });

  const sprintIssues = /\/board\/(\d+)\/sprint\/(\d+)\/issue/.exec(url);
  if (sprintIssues) {
    const board = Number(sprintIssues[1]);
    if (FUTURE[board]?.id === Number(sprintIssues[2])) {
      const list = tag(IN_FUTURE[board], board);
      return json({ issues: list, total: list.length });
    }
  }

  const backlog = /\/board\/(\d+)\/backlog/.exec(url);
  if (backlog) {
    const list = tag(BACKLOG[backlog[1]] || [], Number(backlog[1]));
    return json({ issues: list, total: list.length });
  }

  if (/\/rest\/api\/3\/search\/jql/.test(url)) {
    const jql = String(body?.jql || "");
    if (/issuetype = Epic/.test(jql)) {
      return json({ isLast: true, issues: Object.values(EPICS).map(([key, summary]) => ({ key, fields: { summary } })) });
    }
    if (/^key in \(/.test(jql)) {
      const keys = [...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const found = keys.map((k) => issues.get(k) || (/^OPS-\d+$/.test(k) ? outsider(k) : null)).filter(Boolean);
      return json({ isLast: true, issues: found.map((i) => structuredClone(i)) });
    }
  }

  const move = /\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue/.exec(url);
  if (move && method === "POST") {
    if (params.get("push") === "fail" && body.issues.includes("PLAT-312")) {
      return refuse(400, { errorMessages: ["Issue PLAT-312 cannot be moved: it is in a sprint on a board you cannot see."] });
    }
    for (const key of body.issues) {
      const hit = [...Object.entries(BACKLOG)].find(([, list]) => list.some((i) => i.key === key));
      if (hit) {
        const board = hit[0];
        const i = BACKLOG[board].findIndex((x) => x.key === key);
        IN_FUTURE[board].push(...BACKLOG[board].splice(i, 1));
      }
    }
    return empty();
  }
  if (/\/rest\/agile\/1\.0\/backlog\/issue/.test(url)) return empty();

  const put = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url);
  if (put && method === "PUT") {
    const issue = issues.get(put[1]);
    if (issue && body.fields) {
      if ("assignee" in body.fields) issue.fields.assignee = body.fields.assignee ? person(Number(body.fields.assignee.accountId.split("-")[1])) : null;
      if ("cf_sp" in body.fields) issue.fields.cf_sp = body.fields.cf_sp;
      if ("summary" in body.fields) issue.fields.summary = body.fields.summary;
      if ("duedate" in body.fields) issue.fields.duedate = body.fields.duedate;
    }
    return empty();
  }

  if (/\/rest\/api\/3\/issue\/[^/]+\/transitions/.test(url)) {
    if (method === "POST") return empty();
    return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } }] });
  }
  if (/\/rest\/api\/3\/issue$/.test(url) && method === "POST") {
    created++;
    const n = 990 + created;
    const project = body.fields.project.key;
    const board = Number(Object.entries(PROJECT).find(([, p]) => p === project)?.[0] || 1);
    const issue = make(board, n, { summary: body.fields.summary, epic: Boolean(body.fields.parent), due: body.fields.duedate || null });
    return json({ id: issue.id, key: issue.key });
  }
  return base(input, options);
};

const { localSet } = await import("../js/browser.js");
if (params.get("stage") === "plan") {
  await localSet({
    sprintPlanner: {
      v: 1, stage: "plan",
      boards: [{ id: "1", target: "42", sources: ["41"] }, { id: "2", target: "19", sources: ["18"] }],
      start: "", end: "", workingDays: 10, buffer: { mode: "percent", value: 20 },
      people: [0, 1, 2, 3, 5].map((i) => ({ accountId: `acc-${i}`, name: person(i).displayName, days: i === 2 ? 6 : null, buffer: null })),
      added: {}, removed: [], edits: {}, baseline: {}, extraKeys: [],
    },
  });
}

const { getCredentials } = await import("../js/credentials.js");
const { mount } = await import("../js/views/planner.js");
await mount(document.getElementById("view-container"), await getCredentials());
