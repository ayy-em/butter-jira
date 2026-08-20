// Local preview harness for the standup setup screen.
//
// Runs the real js/views/standup.js against stubbed extension storage and a
// stubbed Jira/GitHub network, so the screen can be looked at without a site,
// a token or a roster. Not shipped: scripts/build.mjs copies an explicit file
// list, and this is not on it. Open with:
//
//   open preview-standup.html            (or serve the folder over http)

const NAMES = [
  ["Pushpa", 16, 4, 0], ["Sasha", 11, 3, 1], ["Dimitrios", 6, 5, 0],
  ["Harsha", 12, 2, 1], ["Caroline", 9, 1, 0], ["Ruben", 10, 6, 0],
  ["Tulio", 7, 2, 0], ["Evgeny", 3, 8, 0], ["Lana", 2, 1, 2],
];

// ?theme=light · ?select=nobody · ?roster=empty · ?github=off · ?resume=1 ·
// ?start=1 · ?sprint=undated
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
// Nine days in, which is where a two-week sprint usually is when someone stops
// to look at the numbers.
const SPRINT_START = daysAgo(9);

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

const STATUSES = [
  ["To Do", "new"], ["In Progress", "indeterminate"], ["In Review", "indeterminate"],
  ["Blocked", "indeterminate"], ["Done", "done"],
];

function issuesFor(person, index, count) {
  return Array.from({ length: count }, (_, i) => {
    // Deterministic spread, so the preview looks the same on every reload.
    const s = STATUSES[(index * 3 + i) % STATUSES.length];
    const blocked = i < person[3];
    return {
      id: `${index}-${i}`,
      key: `CTS-${100 + index * 20 + i}`,
      boardId: 1,
      fields: {
        summary: `Work item ${i + 1} for ${person[0]}`,
        status: blocked
          ? { name: "Blocked", statusCategory: { key: "indeterminate" } }
          : { name: s[0], statusCategory: { key: s[1] } },
        assignee: { accountId: `acc-${index}`, displayName: person[0] },
        issuetype: { name: "Task" },
      },
    };
  });
}

const SPRINT_ISSUES = NAMES.flatMap((p, i) => issuesFor(p, i, p[1]));

globalThis.fetch = async (input) => {
  const url = String(input);
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.includes("/sprint?") || url.endsWith("/sprint")) {
    // Named the way a board owner actually names one — identifier plus a
    // description — so the setup card's sprint line shows the trim doing its
    // job rather than a name that happens to need no trimming.
    // ?sprint=undated drops the start date, which is what sends the GitHub
    // statistics onto their fallback window.
    return json({
      values: [{
        id: 41,
        name: "Sprint 41: Payments hardening",
        state: "active",
        startDate: params.get("sprint") === "undated" ? undefined : SPRINT_START,
      }],
    });
  }
  if (url.includes("/sprint/41/issue")) {
    return json({ issues: SPRINT_ISSUES, total: SPRINT_ISSUES.length });
  }
  return json({ values: [], issues: [], total: 0 });
};

// ── Seed config, roster and the GitHub cache ─────────────────────────────────

const { loadConfig, saveConfig, CONFIG } = await import("./js/config.js");
await saveConfig({
  site: { baseUrl: "https://example.atlassian.net", wikiPath: "/wiki" },
  boards: [{ id: 1, name: "CTS", projectKey: "CTS", color: "#4F8EF7" }],
  github: params.get("github") === "off"
    ? { enabled: false, host: "github.com", org: "", repos: [] }
    : { enabled: true, host: "github.com", org: "example", repos: ["example/alpha", "example/beta"] },
});
await loadConfig();

// BOARDS is a module-level array the API layer iterates; nothing fills it until
// this runs, and an empty one means "no sprints anywhere".
const { loadBoards } = await import("./js/utils.js");
await loadBoards();

const { TEAMS, saveTeam } = await import("./js/team.js");
TEAMS.activeTeamId = "default";
TEAMS.teams = [{
  id: "default",
  name: "CTS Data Team",
  members: (params.get("roster") === "empty" ? [] : NAMES).map((p, i) => ({
    accountId: `acc-${i}`,
    jiraName: p[0],
    nameOverride: "",
    email: "",
    active: true,
    githubLogin: p[0].toLowerCase(),
    slackHandle: "",
    avatarUrl: "",
  })),
}];
await saveTeam(TEAMS);

const { activityCacheKey, statsCacheKey } = await import("./js/github.js");
local[activityCacheKey(CONFIG)] = {
  ts: Date.now(),
  value: {
    fetchedAt: new Date().toISOString(),
    repos: ["example/alpha", "example/beta"],
    reached: Array.from({ length: 14 }, (_, i) => `example/repo-${i}`),
    pullRequests: NAMES.flatMap((p, i) =>
      Array.from({ length: p[2] }, (_, n) => ({
        repo: "example/alpha",
        number: 100 + i * 10 + n,
        title: `Change ${n + 1} from ${p[0]}`,
        url: "#",
        author: p[0].toLowerCase(),
        state: "waiting-review",
        reviewers: [],
        teamReviewers: [],
        ageDays: n + 1,
        staleDays: n,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))
    ),
    merged: [],
    issues: [],
    failures: [],
  },
};

// The sprint-window cache: what the per-person statistics are counted from.
// Deterministic per person — pull requests they opened and merged, and reviews
// and comments left on the *next* person's, so nobody is credited for reviewing
// themselves and the numbers differ enough between rows to be worth looking at.
const windowPrs = [];
const windowReviews = [];
const windowComments = [];
NAMES.forEach((p, i) => {
  const login = p[0].toLowerCase();
  const target = NAMES[(i + 1) % NAMES.length][0].toLowerCase();

  for (let n = 0; n < 1 + ((i * 2) % 4) + p[2]; n++) {
    const merged = n % 2 === 0;
    windowPrs.push({
      repo: n % 2 ? "example/alpha" : "example/beta",
      number: 500 + i * 20 + n,
      title: `Sprint change ${n + 1} from ${p[0]}`,
      url: "#",
      author: login,
      state: merged ? "MERGED" : "OPEN",
      createdAt: daysAgo(1 + (n % 7)),
      updatedAt: daysAgo(1),
      mergedAt: merged ? daysAgo(1 + (n % 3)) : "",
      baseRef: "main",
      toDefaultBranch: true,
      additions: 40 + i * 37 + n * 61,
      deletions: 12 + i * 9 + n * 17,
    });
  }

  for (let n = 0; n < 1 + ((i * 3) % 5); n++) {
    windowReviews.push({
      repo: "example/alpha",
      number: 500 + ((i + 1) % NAMES.length) * 20,
      author: login,
      prAuthor: target,
      submittedAt: daysAgo(1 + (n % 5)),
      state: n % 3 === 0 ? "APPROVED" : "COMMENTED",
      comments: n % 4,
    });
  }

  for (let n = 0; n < 1 + ((i * 2) % 4); n++) {
    windowComments.push({
      repo: "example/beta",
      number: 600 + ((i + 1) % NAMES.length),
      author: login,
      prAuthor: target,
      createdAt: daysAgo(1 + (n % 4)),
    });
  }
});

local[statsCacheKey(CONFIG)] = {
  ts: Date.now(),
  value: {
    fetchedAt: new Date().toISOString(),
    since: daysAgo(45),
    repos: ["example/alpha", "example/beta"],
    reached: ["example/alpha", "example/beta"],
    truncated: [],
    failures: [],
    pullRequests: windowPrs,
    reviews: windowReviews,
    comments: windowComments,
  },
};

if (params.get("resume") === "1") {
  const { SESSION_KEY, createSession } = await import("./js/standup.js");
  local[SESSION_KEY] = createSession({
    participants: NAMES.slice(0, 5).map((_, i) => ({ accountId: `acc-${i}` })),
    seed: 7,
    now: Date.now() - 300_000,
  });
  local[SESSION_KEY].index = 2;
}

const { mount } = await import("./js/views/standup.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);

if (params.get("select") === "nobody") document.querySelectorAll(".su-seg")[1]?.click();
if (params.get("start") === "1") document.querySelector(".su-start")?.click();
