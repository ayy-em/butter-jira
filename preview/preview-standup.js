// Local preview harness for the standup setup screen.
//
// Runs the real js/views/standup.js against stubbed extension storage and a
// stubbed Jira/GitHub network, so the screen can be looked at without a site,
// a token or a roster. Not shipped: scripts/build.mjs copies an explicit file
// list, and this is not on it. Open with:
//
//   open preview-standup.html            (or serve the folder over http)

// Invented, like every other name in these harnesses: a preview is a public
// file and a roster of real colleagues is personal data.
const NAMES = [
  ["Avery", 16, 4, 0], ["Bo", 11, 3, 1], ["Cy", 6, 5, 0],
  ["Devi", 12, 2, 1], ["Emil", 9, 1, 0], ["Freya", 10, 6, 0],
  ["Gil", 7, 2, 0], ["Hana", 3, 8, 0], ["Ines", 2, 1, 2],
];

// ?theme=light · ?select=nobody · ?roster=empty · ?github=off · ?resume=1 ·
// ?start=1 · ?done=1 · ?sprint=undated · ?github=slow · ?github=stuck ·
// ?github=partial · ?ghhover=1
//
// The three GitHub states the seeded caches cannot reach on their own. Both
// caches are warm here, so the fetch normally settles before the first paint
// and the status line only ever says "connected": ?github=slow holds the
// sprint-window cache back for eight seconds, ?github=stuck never answers it
// at all — which is the case the status line exists for, and the one that
// raises the start-anyway warning — and ?github=partial answers it with two
// repos it could not read and one it had to cut short.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Set once js/github.js has been imported, since the key is derived from the
// configured repo list. Only this one key is held back: delaying the whole
// store would hold up the roster and the prefs as well, and what is being
// looked at is a GitHub fetch running behind a screen that is already up.
let heldKey = "";
const held = params.get("github");
const holdFor = async (keys) => {
  if (!heldKey || !keys) return;
  const wanted = Array.isArray(keys) ? keys : [keys];
  if (!wanted.includes(heldKey)) return;
  if (held === "slow") await sleep(8000);
  // Never resolves. The view is built to survive exactly this — the standup
  // starts without GitHub — so the harness is allowed to be this rude.
  if (held === "stuck") await new Promise(() => {});
};

const area = (store) => ({
  get: async (keys) => {
    await holdFor(keys);
    return pick(store, keys);
  },
  set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
  remove: (keys) => { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
});

globalThis.chrome = {
  runtime: { getURL: (p) => `../${p}` },
  storage: { local: area(local), sync: area(sync) },
};

// ── Fake Jira ────────────────────────────────────────────────────────────────

const STATUSES = [
  ["To Do", "new"], ["In Progress", "indeterminate"], ["In Review", "indeterminate"],
  ["Blocked", "indeterminate"], ["Done", "done"],
];

// A plausible issue history, in the shape `expand=changelog` returns — the
// per-person activity cell and panel read this and nothing else.
//
// Shaped to make the panel's distinctions visible rather than to look busy: a
// ticket walks the workflow a step at a time so moves outnumber completions;
// every fourth is moved by somebody other than its assignee, so "who moved it"
// and "who owns it" come apart; every fifth was reassigned, so pick-ups exist;
// and every seventh reports a `total` well above what it returns, which is what
// makes the truncation caveat render. ?history=off drops the lot, which is the
// site-returned-no-history case.
const WORKFLOW = ["To Do", "In Progress", "In Review", "Done"];

function historyFor(status, index, i, count) {
  if (params.get("history") === "off") return undefined;
  const target = WORKFLOW.indexOf(status);
  const n = index * 20 + i;
  const moverIdx = n % 4 === 0 ? (index + 2) % NAMES.length : index;
  const author = { accountId: `acc-${moverIdx}`, displayName: NAMES[moverIdx][0] };
  const histories = [];

  if (n % 5 === 0) {
    const fromIdx = (index + 3) % NAMES.length;
    histories.push({
      id: `h${n}-a`, author, created: daysAgo(8),
      items: [{
        field: "assignee", fieldId: "assignee",
        from: `acc-${fromIdx}`, fromString: NAMES[fromIdx][0],
        to: `acc-${index}`, toString: NAMES[index][0],
      }],
    });
  }

  for (let step = 1; step <= Math.max(0, target); step++) {
    histories.push({
      id: `h${n}-${step}`, author, created: daysAgo(8 - step),
      items: [{
        field: "status", fieldId: "status",
        from: String(step), fromString: WORKFLOW[step - 1],
        to: String(step + 1), toString: WORKFLOW[step],
      }],
    });
  }

  if (n % 6 === 0) {
    histories.push({
      id: `h${n}-p`, author, created: daysAgo(3),
      items: [{ field: "Story Points", fieldId: "cf_sp", fromString: "3", toString: "5" }],
    });
  }

  // An authorless entry: a Jira automation. A real change, but not a person's
  // action, and it must not be pooled under anybody.
  if (n % 11 === 0) {
    histories.push({
      id: `h${n}-auto`, author: null, created: daysAgo(2),
      items: [{ field: "labels", fieldId: "labels", fromString: "", toString: "triaged" }],
    });
  }

  if (!histories.length) return undefined;
  return {
    startAt: 0,
    maxResults: histories.length,
    total: n % 7 === 0 ? histories.length + 30 : histories.length,
    histories,
  };
}

function issuesFor(person, index, count) {
  return Array.from({ length: count }, (_, i) => {
    // Deterministic spread, so the preview looks the same on every reload.
    const s = STATUSES[(index * 3 + i) % STATUSES.length];
    const blocked = i < person[3];
    const status = blocked ? "Blocked" : s[0];
    // Not always the assignee: who raised a ticket and who is doing it are
    // different questions, and a fixture where they always agree would hide the
    // creation figure being its own number.
    const creatorIdx = (index + i) % NAMES.length;
    return {
      id: `${index}-${i}`,
      key: `ACME-${100 + index * 20 + i}`,
      boardId: 1,
      fields: {
        summary: `Work item ${i + 1} for ${person[0]}`,
        status: blocked
          ? { name: "Blocked", statusCategory: { key: "indeterminate" } }
          : { name: s[0], statusCategory: { key: s[1] } },
        assignee: { accountId: `acc-${index}`, displayName: person[0] },
        creator: { accountId: `acc-${creatorIdx}`, displayName: NAMES[creatorIdx][0] },
        // Half created inside the sprint window, so "created" is a spread rather
        // than the same number for everybody.
        created: i % 2 === 0 ? daysAgo(5) : daysAgo(20),
        issuetype: { name: "Task" },
      },
      changelog: historyFor(status, index, i, count),
    };
  });
}

const SPRINT_ISSUES = NAMES.flatMap((p, i) => issuesFor(p, i, p[1]));

globalThis.fetch = async (input) => {
  const url = String(input);
  // Cloned: `compactChangelogs` reduces each issue's changelog in place at the
  // API boundary, and handing out the fixture's own objects meant a second fetch
  // saw what the first had consumed.
  const json = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
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

const { loadConfig, saveConfig, CONFIG } = await import("../js/config.js");
await saveConfig({
  site: { baseUrl: "https://example.atlassian.net", wikiPath: "/wiki" },
  boards: [{ id: 1, name: "ACME", projectKey: "ACME", color: "#4F8EF7" }],
  github: params.get("github") === "off"
    ? { enabled: false, host: "github.com", org: "", repos: [] }
    : { enabled: true, host: "github.com", org: "example", repos: ["example/alpha", "example/beta"] },
});
await loadConfig();

// BOARDS is a module-level array the API layer iterates; nothing fills it until
// this runs, and an empty one means "no sprints anywhere".
const { loadBoards } = await import("../js/utils.js");
await loadBoards();

const { TEAMS, saveTeam } = await import("../js/team.js");
TEAMS.activeTeamId = "default";
TEAMS.teams = [{
  id: "default",
  name: "Preview Team",
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

const { activityCacheKey, statsCacheKey } = await import("../js/github.js");
heldKey = statsCacheKey(CONFIG);
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
    // ?github=partial: one repo cut short at the page cap and two the token
    // could not read, which is what puts the status line on "partial" and fills
    // the hover panel with names rather than counts.
    truncated: held === "partial" ? ["example/alpha"] : [],
    failures: held === "partial"
      ? [
          { repo: "example/gamma", type: "not-found", message: "Repository not found" },
          { repo: "example/delta", type: "auth", message: "Resource not accessible by personal access token" },
        ]
      : [],
    pullRequests: windowPrs,
    reviews: windowReviews,
    comments: windowComments,
  },
};

if (params.get("resume") === "1") {
  const { SESSION_KEY, createSession } = await import("../js/standup.js");
  local[SESSION_KEY] = createSession({
    participants: NAMES.slice(0, 5).map((_, i) => ({ accountId: `acc-${i}` })),
    seed: 7,
    now: Date.now() - 300_000,
  });
  local[SESSION_KEY].index = 2;
}

const { mount } = await import("../js/views/standup.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);

// The hover panel behind the GitHub status, pinned open. A screenshot cannot
// hover, and this panel is the whole answer to "is it still fetching or is it
// stuck" — so it needs a way to be looked at.
if (params.get("ghhover") === "1") {
  const style = document.createElement("style");
  style.textContent =
    ".su-gh-report { opacity: 1 !important; visibility: visible !important; transform: none !important; }";
  document.head.appendChild(style);
}

if (params.get("select") === "nobody") document.querySelectorAll(".su-seg")[1]?.click();
if (params.get("start") === "1") document.querySelector(".su-start")?.click();

// ?done=1 — the end screen. It is the one screen in this view that cannot be
// reached without living through a meeting first, which is why it was the last
// part of the standup still wearing the previous generation's design: nobody
// looks at it except at the end of a real standup, when they are busy.
//
// The confirm is the real one and it fires because most of the roster has not
// spoken; it is answered here rather than suppressed, so this takes exactly the
// path a facilitator takes.
if (params.get("done") === "1") {
  document.querySelector(".su-start")?.click();
  // startNow() paints the stage asynchronously — it asks for fullscreen on the
  // way — so the End button does not exist on the tick that made it. Watched
  // for rather than polled on a timer: under headless Chrome's virtual clock a
  // sleep loop burns its whole budget before the app's own work has run, which
  // is a trap worth only falling into once.
  const end = await new Promise((resolve) => {
    const find = () =>
      [...document.querySelectorAll(".standup-ctrl")]
        .find((b) => b.textContent.trim().toLowerCase() === "end") || null;
    const found = find();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  // A parking-lot note, so the end screen has the panel it exists for. Without
  // one the summary is only the times, and the half of the screen with the
  // Copy-message and Download actions never renders.
  const parking = document.querySelector(".standup-parking-input");
  if (parking) {
    parking.value = "Index split needs a decision on the flag before Thursday.";
    parking.dispatchEvent(new Event("input", { bubbles: true }));
    parking.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const originalConfirm = window.confirm;
  window.confirm = () => true;   // most of the roster has not spoken; that is the point
  end.click();
  window.confirm = originalConfirm;
}

// ?pressure=0.8 · ?over=0.5 — pin the time-pressure channel so its states can
// be looked at without sitting through a two-minute slot and then running over
// it. Overwritten by the next clock tick, which is what makes this a viewing
// aid and not a way to fake the session: it holds only until the timer paints
// again, so a screenshot catches it and a live session cannot be stuck in it.
const pinned = { pressure: params.get("pressure"), over: params.get("over") };
if (pinned.pressure || pinned.over) {
  const paint = () => {
    const stage = document.querySelector(".standup-speaking");
    if (!stage) return;
    if (pinned.pressure) stage.style.setProperty("--pressure", pinned.pressure);
    if (pinned.over) {
      stage.style.setProperty("--overpressure", pinned.over);
      stage.classList.toggle("pressing", Number(pinned.over) > 0);
    }
  };
  setInterval(paint, 60);
  paint();
}
