// Local preview harness for the 1:1 screen (M14).
//
// Mounts the real js/views/oneone.js against stubbed extension storage, a
// stubbed Jira and a stubbed GitHub window, so both screens — the picker and
// the sheet — can be looked at without a site, a token or a colleague. Not
// shipped: scripts/build.mjs copies an explicit file list and this is not on
// it. Open with:
//
//   open preview-oneone.html             (or serve the folder over http)
//   open preview-oneone.html?sheet=1     straight into a person's sheet
//
// Self-contained rather than built on preview-fixture.js, following
// preview-monitor.js and preview-gantt.js. That fixture keeps a tidy sprint
// stable for the dashboard and the recap; this screen needs a different shape
// entirely — issues with *dates* for the mini-Gantt, a person whose work
// straddles the window edge, a colleague with no GitHub login, and a stored 1:1
// archive, none of which belong in the shared sprint.
//
// Fixture states:
//   ?theme=light     the theme most bugs hide in
//   ?sheet=1         open a person's sheet rather than the picker
//   ?who=fresh       a person with no completed 1:1 — the first-session window
//   ?who=nogithub    a person with no GitHub login mapped
//   ?github=off      GitHub sync switched off entirely
//   ?stats=clamped   a window starting before GitHub's 45-day reach
//   ?history=off     Jira returns no changelog — closed/moved are dashes
//   ?notes=empty     no stored notes or archive at all
//   ?dates=off       nothing carries a start or due date — the empty Gantt
//   ?roster=empty    no roster, which is the picker's blocked state

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

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const dayOf = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// ── Synthetic people ────────────────────────────────────────────────────────
//
// Invented, as every fixture in this repo is: a preview is a public file, and a
// screen whose entire subject is notes about a named colleague is the last
// place a real name belongs.
//
// [name, githubLogin, lastMetDaysAgo | null]
const PEOPLE = [
  ["Avery Quinn", "averyq", 14],
  ["Bo Ferreira", "boferreira", 7],
  ["Cy Nakamura", "", 21],
  ["Devi Okonjo", "deviok", null],
  ["Emil Vance", "emilv", 3],
];

const WHO = { fresh: 3, nogithub: 2 }[params.get("who")] ?? 0;
const SUBJECT = `acc-${WHO}`;

const CATEGORY = {
  "To Do": "new",
  "In Progress": "indeterminate",
  "In Code Review": "indeterminate",
  Done: "done",
};

const BOARDS = [
  { id: 1, name: "ACME", projectKey: "ACME", color: "#4F8EF7" },
  { id: 2, name: "PLAT", projectKey: "PLAT", color: "#F7914F" },
];

// Deliberately dated. The mini-Gantt is the one thing on this screen that
// cannot be previewed from an undated fixture, and the interesting cases are
// the edges: a bar that starts before the horizon, one that ends past it, a due
// date with no start (a point), and one already overdue.
//
// [status, points, startOffset, dueOffset, personIdx]
const SPEC = [
  ["In Progress", 5, -4, 6, 0],
  ["In Code Review", 3, -1, 2, 0],
  ["To Do", 8, 10, 24, 0],
  ["In Progress", 2, -60, 30, 0],   // clipped at the start
  ["To Do", 3, 30, 120, 0],         // clipped at the end
  ["To Do", 1, null, -3, 0],        // a point, and overdue
  ["In Progress", 5, null, 4, 0],   // a point in the future
  ["Done", 3, -12, -6, 0],
  ["Done", 5, -9, -2, 0],
  ["In Progress", 3, -2, 9, 1],
  ["To Do", 5, 3, 12, 1],
  ["Done", 2, -8, -4, 1],
  ["In Progress", 8, -6, 1, 2],
  ["To Do", 2, null, null, 2],      // no dates at all — off the strip
  ["Done", 1, -10, -7, 3],
  ["In Progress", 2, -3, 5, 4],
];

const WORKFLOW = ["To Do", "In Progress", "In Code Review", "Done"];

let seq = 0;
const ISSUES = [];
for (const [status, points, startOff, dueOff, personIdx] of SPEC) {
  seq++;
  const board = BOARDS[seq % BOARDS.length];
  const undated = params.get("dates") === "off";
  const fields = {
    summary: `${status === "Done" ? "Shipped" : "Work item"} ${seq} for ${PEOPLE[personIdx][0]}`,
    status: { name: status, statusCategory: { key: CATEGORY[status] } },
    issuetype: { name: seq % 5 === 0 ? "Epic" : "Story", subtask: false },
    assignee: { accountId: `acc-${personIdx}`, displayName: PEOPLE[personIdx][0] },
    creator: { accountId: `acc-${personIdx}`, displayName: PEOPLE[personIdx][0] },
    created: daysAgo(seq % 4 === 0 ? 3 : 30),
    cf_sp: points,
  };
  if (!undated && startOff !== null) fields.cf_start = dayOf(startOff);
  if (!undated && dueOff !== null) fields.duedate = dayOf(dueOff);
  // One person's work is deliberately stuck: a blocked status and an overdue
  // date are the two halves of that section, and a fixture with neither shows
  // the empty state and nothing else.
  if (seq === 6) fields.status = { name: "Blocked — waiting on vendor", statusCategory: { key: "indeterminate" } };
  ISSUES.push({
    id: String(seq),
    key: `${board.projectKey}-${100 + seq}`,
    fields,
    changelog: changelogFor(status, personIdx, seq),
  });
}

// A sub-task, which must not be counted: its points duplicate the parent's and
// its transitions would make one piece of work read as two.
ISSUES.push({
  id: "s1",
  key: "ACME-901",
  fields: {
    summary: "A sub-task, excluded everywhere",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Sub-task", subtask: true },
    assignee: { accountId: SUBJECT, displayName: PEOPLE[WHO][0] },
    created: daysAgo(4),
    cf_sp: 99,
    duedate: dayOf(2),
  },
});

function changelogFor(status, personIdx, n) {
  if (params.get("history") === "off") return undefined;
  const target = WORKFLOW.indexOf(status);
  if (target < 1) return undefined;
  const mover = { accountId: `acc-${personIdx}`, displayName: PEOPLE[personIdx][0] };
  const histories = [];
  for (let step = 1; step <= target; step++) {
    histories.push({
      id: `h${n}-${step}`,
      author: mover,
      created: daysAgo(6 - step),
      items: [{
        field: "status", fieldId: "status",
        from: String(step), fromString: WORKFLOW[step - 1],
        to: String(step + 1), toString: WORKFLOW[step],
      }],
    });
  }
  return {
    startAt: 0,
    maxResults: histories.length,
    // Every fifth issue overstates its total, so the "these counts are a floor"
    // caveat renders without waiting for a real ticket to ping-pong for months.
    total: n % 5 === 0 ? histories.length + 30 : histories.length,
    histories,
  };
}

// ── Stubbed Jira ─────────────────────────────────────────────────────────────

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    // Cloned, because `compactChangelogs` rewrites each issue in place at the
    // API boundary: handing out the fixture's own objects means the second
    // fetch sees what the first consumed.
    json: async () => structuredClone(body),
    text: async () => JSON.stringify(body),
  });

  const sprintList = /\/board\/(\d+)\/sprint(\?|$)/.exec(url);
  if (sprintList) {
    const id = Number(sprintList[1]);
    return json({
      values: [{
        id: 400 + id,
        name: `Sprint ${40 + id}`,
        state: "active",
        startDate: daysAgo(9),
        endDate: daysAgo(-5),
      }],
    });
  }

  const sprintIssues = /\/board\/(\d+)\/sprint\/(\d+)\/issue/.exec(url);
  if (sprintIssues) {
    const boardId = Number(sprintIssues[1]);
    const mine = ISSUES.filter((i) => BOARDS[Number(i.id.replace(/\D/g, "")) % BOARDS.length]?.id === boardId);
    return json({ issues: mine.length ? mine : ISSUES, total: ISSUES.length });
  }

  // The two JQL reads this screen adds: the windowed reader, and one person's
  // open queue. Answered from the same issue set — a preview does not need two.
  if (/\/rest\/api\/3\/search\/jql/.test(url)) {
    const jql = options.body ? String(JSON.parse(options.body).jql || "") : "";
    const assignee = /assignee = "([^"]+)"/.exec(jql);
    if (assignee) {
      return json({
        issues: ISSUES.filter(
          (i) =>
            i.fields.assignee?.accountId === assignee[1] &&
            i.fields.status?.statusCategory?.key !== "done"
        ),
        isLast: true,
      });
    }
    return json({ issues: ISSUES, isLast: true });
  }

  const single = /\/rest\/api\/3\/issue\/([A-Za-z]+-\d+)(\?|$)/.exec(url);
  if (single) {
    const found = ISSUES.find((i) => i.key === single[1]);
    return json(found || { key: single[1], fields: { summary: "Not in the fixture" } });
  }

  return json({ values: [], issues: [], total: 0 });
};

// ── Config, roster, credentials ──────────────────────────────────────────────

const { loadConfig, saveConfig, CONFIG } = await import("../js/config.js");
await saveConfig({
  site: { baseUrl: "https://example.atlassian.net", wikiPath: "/wiki" },
  brand: { productName: "butter_jira", orgName: "Preview Org", orgLogo: "" },
  boards: BOARDS,
  fields: { storyPoints: ["cf_sp"], startDate: ["cf_start"], sprint: ["cf_sprint"], epicLink: [], epicName: [] },
  statusGroups: [
    { name: "To Do", statuses: ["To Do", "Open", "Backlog"] },
    { name: "In Progress", statuses: ["In Progress", "Blocked — waiting on vendor"] },
    { name: "In Code Review", statuses: ["In Code Review"] },
    { name: "Done", statuses: ["Done", "Closed", "Resolved"] },
  ],
  github:
    params.get("github") === "off"
      ? { enabled: false, host: "github.com", org: "", repos: [] }
      : { enabled: true, host: "github.com", org: "example", repos: ["example/alpha"] },
});
await loadConfig();

const { saveCredentials } = await import("../js/credentials.js");
await saveCredentials({ email: "preview@example.invalid", token: "preview-token" });

const { loadBoards } = await import("../js/utils.js");
await loadBoards();

const { TEAMS, saveTeam } = await import("../js/team.js");
TEAMS.activeTeamId = "default";
TEAMS.teams = [{
  id: "default",
  name: "Data Engineering",
  members:
    params.get("roster") === "empty"
      ? []
      : PEOPLE.map((p, i) => ({
          accountId: `acc-${i}`,
          jiraName: p[0],
          nameOverride: "",
          email: "",
          active: true,
          githubLogin: p[1],
          slackHandle: "",
          avatarUrl: "",
        })),
}];
await saveTeam(TEAMS);

// ── GitHub, seeded straight into the caches ─────────────────────────────────

const { activityCacheKey, statsCacheKey } = await import("../js/github.js");

if (params.get("github") !== "off") {
  const prs = [];
  const commits = [];
  const reviews = [];
  PEOPLE.forEach((person, i) => {
    if (!person[1]) return;
    for (let n = 0; n < 1 + ((i * 2) % 4); n++) {
      const merged = n % 2 === 0;
      prs.push({
        repo: "example/alpha",
        number: 500 + i * 20 + n,
        title: `Change ${n + 1} from ${person[0]}`,
        url: "#",
        author: person[1],
        state: merged ? "MERGED" : "OPEN",
        createdAt: daysAgo(1 + (n % 6)),
        updatedAt: daysAgo(1),
        mergedAt: merged ? daysAgo(1 + (n % 3)) : "",
        baseRef: "main",
        toDefaultBranch: true,
        additions: 140 + i * 337 + n * 461,
        deletions: 32 + i * 109 + n * 217,
      });
    }
    const target = PEOPLE[(i + 1) % PEOPLE.length];
    if (target[1]) {
      reviews.push({
        repo: "example/alpha",
        number: 600 + i,
        author: person[1],
        prAuthor: target[1],
        submittedAt: daysAgo(2),
        state: "APPROVED",
        comments: 2,
      });
    }
    if (i % 3 === 0) {
      commits.push({
        repo: "example/alpha",
        oid: `c${i}`,
        author: person[1],
        committedDate: daysAgo(2),
        additions: 60 + i * 91,
        deletions: 14 + i * 23,
      });
    }
  });

  local[statsCacheKey(CONFIG)] = {
    ts: Date.now(),
    value: {
      fetchedAt: new Date().toISOString(),
      // ?stats=clamped pulls the fetch window in to a week, so a fortnightly
      // sheet has to say its GitHub half covers less than it asked for.
      since: params.get("stats") === "clamped" ? daysAgo(7) : daysAgo(45),
      repos: ["example/alpha"],
      reached: ["example/alpha"],
      truncated: [],
      failures: [],
      pullRequests: prs,
      reviews,
      comments: [],
      commits,
    },
  };

  // The open-pull-request lists behind "what is stuck", in the four states the
  // ordering exists to rank. One of them is somebody else's, waiting on the
  // subject's review, which is the ten-second unblock.
  local[activityCacheKey(CONFIG)] = {
    ts: Date.now(),
    value: {
      fetchedAt: new Date().toISOString(),
      repos: ["example/alpha"],
      reached: ["example/alpha"],
      pullRequests: [
        pr(700, "Importer retry loop", PEOPLE[WHO][1] || "someone", "changes-requested", 9),
        pr(701, "Drop the legacy column", PEOPLE[WHO][1] || "someone", "checks-failing", 4),
        pr(702, "Bump the parser", PEOPLE[WHO][1] || "someone", "approved", 6),
        pr(703, "Split the writer", PEOPLE[WHO][1] || "someone", "waiting-review", 1),
        {
          ...pr(704, "Somebody else's change", "otherperson", "waiting-review", 3),
          reviewers: [PEOPLE[WHO][1] || "someone"],
        },
      ],
      merged: [],
      issues: [],
      failures: [],
    },
  };
}

function pr(number, title, author, state, ageDays) {
  return {
    repo: "example/alpha",
    number,
    title,
    url: "#",
    author,
    state,
    ageDays,
    reviewers: [],
    createdAt: daysAgo(ageDays),
    updatedAt: daysAgo(1),
  };
}

// ── Stored history: snapshots, a 1:1 archive, and a todo list ───────────────

if (params.get("notes") !== "empty") {
  const byPerson = (factor) =>
    Object.fromEntries(
      PEOPLE.map((p, i) => [
        `acc-${i}`,
        {
          label: p[0],
          points: 8 + ((i * 5 + factor * 3) % 14),
          issues: 3 + (i % 4),
          donePoints: 4 + ((i * 3 + factor) % 9),
          doneIssues: 2 + (i % 3),
        },
      ])
    );
  // Five sprints of stored history, which is enough for the bars to have a
  // shape and few enough that the "bounded by when this device started
  // recording" caveat still means something.
  local.sprintSnapshots = Object.fromEntries(
    [0, 1, 2, 3, 4].map((n) => [
      `${400 + n}`,
      [{
        date: new Date(Date.now() - (4 - n) * 14 * DAY).toISOString().slice(0, 10),
        totalPoints: 60,
        openPoints: 20,
        donePoints: 40,
        issueCount: 24,
        doneIssues: 15,
        byPerson: byPerson(n),
      }],
    ])
  );

  local.oneOnes = {
    people: Object.fromEntries(
      PEOPLE.filter((p) => p[2] !== null).map((p, idx) => {
        const i = PEOPLE.indexOf(p);
        const last = daysAgo(p[2]);
        return [
          `acc-${i}`,
          {
            lastCompletedAt: last,
            // An open action carried out of the last session, so the carried
            // rule and its date render without anyone completing a meeting.
            draft: {
              todos: [{
                id: `carry-${i}`,
                text: "Write up the migration plan",
                owner: "them",
                due: dayOf(6),
                done: false,
                carriedFrom: last,
              }],
              info: [],
              updatedAt: last,
            },
            sessions: [
              {
                id: `s-${i}-1`,
                completedAt: daysAgo(p[2] + 14),
                windowId: "2w",
                from: daysAgo(p[2] + 28),
                to: daysAgo(p[2] + 14),
                todos: [
                  { id: `a-${i}`, text: "Pair on the flaky test", owner: "them", due: "", done: true, carriedFrom: "" },
                  { id: `b-${i}`, text: "Chase the vendor contract", owner: "me", due: "", done: true, carriedFrom: "" },
                ],
                info: [{ id: `n-${i}`, text: "Wants more time on the platform side next quarter." }],
              },
              {
                id: `s-${i}-2`,
                completedAt: last,
                windowId: "2w",
                from: daysAgo(p[2] + 14),
                to: last,
                todos: [
                  { id: `c-${i}`, text: "Write up the migration plan", owner: "them", due: dayOf(6), done: false, carriedFrom: "" },
                  { id: `d-${i}`, text: "Unblock the API key request", owner: "me", due: "", done: idx % 2 === 0, carriedFrom: "" },
                ],
                info: [{ id: `m-${i}`, text: "Holiday the week after next." }],
              },
            ],
          },
        ];
      })
    ),
  };

  local.myTodos = [
    {
      id: "todo-1",
      text: "Unblock the API key request",
      source: "1on1",
      sourceLabel: PEOPLE[0][0],
      due: dayOf(-2),
      link: "",
      done: false,
      createdAt: daysAgo(9),
      doneAt: "",
      originId: "d-0",
    },
    {
      id: "todo-2",
      text: "Draft the quarter plan",
      source: "manual",
      sourceLabel: "",
      due: dayOf(5),
      link: "https://example.atlassian.net/wiki/spaces/PLAN",
      done: false,
      createdAt: daysAgo(3),
      doneAt: "",
      originId: "",
    },
    {
      id: "todo-3",
      text: "Book the retro room",
      source: "manual",
      sourceLabel: "",
      due: "",
      link: "",
      done: true,
      createdAt: daysAgo(12),
      doneAt: daysAgo(6),
      originId: "",
    },
  ];
}

// ── Mount ────────────────────────────────────────────────────────────────────

if (params.get("sheet")) location.hash = `#oneone/${SUBJECT}`;

const view = await import("../js/views/oneone.js");
const { getCredentials } = await import("../js/credentials.js");
await view.mount(document.getElementById("view-container"), await getCredentials());

// The picker navigates by hash; without the router there is nothing listening,
// so the harness re-mounts on its own.
window.addEventListener("hashchange", async () => {
  await view.mount(document.getElementById("view-container"), await getCredentials());
});
