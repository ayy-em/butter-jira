// Shared preview fixture.
//
// Stubbed extension storage and a stubbed Jira/GitHub network, seeded with a
// deterministic sprint, so any real view can be mounted against it without a
// site, a token or a roster. Imported — not copied — by preview-dashboard.js and
// preview-recap.js: two harnesses with two copies of this would drift, and then
// the two screens would be previewed against different sprints.
//
// Top-level await is deliberate. A static `import` of this module finishes before
// the importing module's body runs, so a harness can simply import it and then
// dynamically import the view, knowing the stubs are already in place.
//
// ?theme=light · ?github=off · ?stats=slow · ?stats=error · ?sprint=undated
// ?push=off · ?roster=empty · ?avatars=off · ?jira=slow · ?stats=partial

export const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
// Nine days into a two-week sprint, which is when somebody stops to look at the
// numbers.
const SPRINT_START = daysAgo(9);

// Synthetic people, deliberately. The names here are invented and the avatars are
// generated inline below — no colleague's name or photograph belongs in a fixture
// file, and assets/avatars holds real ones.
//
// name, githubLogin, then one entry per ticket: [status, points]. Written out
// rather than generated so each row makes a point: a mixed row, a finished row, a
// row with no estimates at all (dash, not 0%), and a row with nobody mapped on
// GitHub (dash in the PR columns, not a nought).
const PEOPLE = [
  ["Avery Quinn", "averyq", [["Done", 5], ["Done", 3], ["In Code Review", 8], ["In Progress", 2], ["To Do", 3]]],
  ["Bo Ferreira", "boferreira", [["Done", 2], ["In Code Review", 3], ["In Review", 1], ["To Do", 5], ["To Do", 3]]],
  ["Cy Nakamura", "cynakamura", [["Done", 3], ["Done", 5], ["Done", 2]]],
  ["Devi Okonjo", "deviok", [["In Progress", null], ["In Code Review", null], ["To Do", null]]],
  ["Emil Vance", "", [["In Review", 5], ["In Progress", 3]]],
  ["Freya Salib", "freyas", [["To Do", 8], ["To Do", 5], ["In Progress", 13]]],
];

// A generated avatar, so the harness can exercise the <img> path — and the
// initials fallback beside it — without touching a real photograph. Half the
// roster gets one; ?avatars=off drops them all.
const AVATAR_TINTS = ["#4F8EF7", "#4FCF8E", "#A855F7", "#F7914F", "#EC4899", "#14B8A6"];
function avatarDataUri(name, i) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
    `<rect width="96" height="96" fill="${AVATAR_TINTS[i % AVATAR_TINTS.length]}"/>` +
    `<text x="48" y="62" font-family="sans-serif" font-size="38" font-weight="600"` +
    ` fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
function avatarUrlsFor(name, i) {
  if (params.get("avatars") === "off" || i % 2 === 1) return undefined;
  const uri = avatarDataUri(name, i);
  return { "48x48": uri, "32x32": uri, "24x24": uri };
}


const local = {};
const sync = {};
const pick = (store, keys) =>
  keys == null
    ? { ...store }
    : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
      );

// Set once the config is loaded, so ?stats=slow can hold back exactly the one
// read the delivery table waits on — which is what exercises its repaint.
let slowKey = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const area = (store, { slow = false } = {}) => ({
  get: async (keys) => {
    const wanted = keys == null ? [] : [].concat(keys);
    if (slow && slowKey && wanted.includes(slowKey)) await sleep(2500);
    return pick(store, keys);
  },
  set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
  remove: (keys) => { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
});

globalThis.chrome = {
  runtime: { getURL: (p) => p },
  storage: {
    local: area(local, { slow: params.get("stats") === "slow" }),
    sync: area(sync),
  },
};

// ── Fake Jira ────────────────────────────────────────────────────────────────

// Three boards, each with its own active sprint, because that is the shape the
// recap has to handle: one of them starts two days earlier, which is what makes
// the combined window the *earliest* start rather than any single sprint's.
const BOARD_FIXTURE = [
  { id: 1, name: "ACME", projectKey: "ACME", color: "#4F8EF7",
    sprint: { id: 41, name: "Sprint 41: Payments hardening", goal: "Ship the importer job and clear the review backlog", startsAgo: 9, endsIn: 5 } },
  { id: 2, name: "PLAT", projectKey: "PLAT", color: "#F7914F",
    sprint: { id: 18, name: "PLAT 18: Index split", goal: "Split the index writer and keep the old path behind a flag", startsAgo: 9, endsIn: 5 } },
  { id: 3, name: "DATA", projectKey: "DATA", color: "#4FCF8E",
    sprint: { id: 7, name: "DATA 7: Pipeline hardening", goal: "", startsAgo: 11, endsIn: 3 } },
];

const CATEGORY = {
  "To Do": "new",
  "In Progress": "indeterminate",
  "In Code Review": "indeterminate",
  "In Review": "indeterminate",
  Done: "done",
};

let seq = 0;
const ISSUES_BY_BOARD = new Map(BOARD_FIXTURE.map((b) => [b.id, []]));

// A plausible issue history, in the shape `expand=changelog` actually returns —
// the per-person activity panels read this and nothing else.
//
// Written to make the panels' distinctions visible rather than to look busy:
// a ticket walks the workflow one step at a time so transitions outnumber
// completions; every fourth one is moved by somebody other than its assignee, so
// "moved" and "assigned" come apart; every seventh was reassigned, so pick-ups
// exist; and every ninth reports a `total` far above what it returns, which is
// what makes the truncation caveat render on both the standup and the document.
const WORKFLOW = ["To Do", "In Progress", "In Code Review", "In Review", "Done"];

function changelogFor(status, personIdx, n) {
  if (params.get("history") === "off") return undefined;

  const target = WORKFLOW.indexOf(status);
  const histories = [];
  // Whoever moved it: usually the assignee, sometimes a colleague, which is the
  // whole reason the panel counts movers rather than assignees.
  const moverIdx = n % 4 === 0 ? (personIdx + 2) % PEOPLE.length : personIdx;
  const mover = {
    accountId: `acc-${moverIdx}`,
    displayName: PEOPLE[moverIdx][0],
    avatarUrls: avatarUrlsFor(PEOPLE[moverIdx][0], moverIdx),
  };

  for (let step = 1; step <= Math.max(0, target); step++) {
    histories.push({
      id: `h${n}-${step}`,
      author: mover,
      created: daysAgo(8 - step),
      items: [{
        field: "status", fieldId: "status", fieldtype: "jira",
        from: String(step), fromString: WORKFLOW[step - 1],
        to: String(step + 1), toString: WORKFLOW[step],
      }],
    });
  }

  if (n % 7 === 0) {
    const fromIdx = (personIdx + 3) % PEOPLE.length;
    histories.unshift({
      id: `h${n}-a`,
      author: mover,
      created: daysAgo(8),
      items: [{
        field: "assignee", fieldId: "assignee", fieldtype: "jira",
        from: `acc-${fromIdx}`, fromString: PEOPLE[fromIdx][0],
        to: `acc-${personIdx}`, toString: PEOPLE[personIdx][0],
      }],
    });
  }

  if (n % 6 === 0) {
    histories.push({
      id: `h${n}-p`,
      author: mover,
      created: daysAgo(4),
      items: [{
        field: "Story Points", fieldId: "cf_sp", fieldtype: "custom",
        from: null, fromString: "3", to: null, toString: "5",
      }],
    });
  }

  // An authorless entry: a Jira automation, which is a real change but not a
  // person's action, and must not be pooled under anybody.
  if (n % 11 === 0) {
    histories.push({
      id: `h${n}-auto`,
      author: null,
      created: daysAgo(3),
      items: [{ field: "labels", fieldId: "labels", fromString: "", toString: "triaged" }],
    });
  }

  if (!histories.length) return undefined;
  return {
    startAt: 0,
    maxResults: histories.length,
    // Deliberately overstated on every ninth issue, so both consumers have to
    // print "at least this many" rather than a total.
    total: n % 9 === 0 ? histories.length + 40 : histories.length,
    histories,
  };
}

PEOPLE.forEach((person, i) => {
  person[2].forEach(([status, points], n) => {
    seq++;
    // Round-robin across the boards, so every board block has content and the
    // ticket list has something to group.
    const board = BOARD_FIXTURE[(i + n) % BOARD_FIXTURE.length];
    // Every fifth ticket was created after the sprint began: that is the scope
    // creep the recap flags, per person and per board.
    const crept = seq % 5 === 0;
    const fields = {
      summary: `${status === "Done" ? "Shipped" : "Work item"} ${seq} for ${person[0]}`,
      status: { name: status, statusCategory: { key: CATEGORY[status] } },
      assignee: {
        accountId: `acc-${i}`,
        displayName: person[0],
        avatarUrls: avatarUrlsFor(person[0], i),
      },
      issuetype: { name: "Story", subtask: false },
      created: crept ? daysAgo(2) : daysAgo(12),
    };
    if (points !== null) fields.cf_sp = points;
    // Not always the assignee: "who created this" and "who is doing it" are
    // different questions, and a fixture where they always agree would hide the
    // per-person creation figure being its own number.
    const creatorIdx = crept ? (i + 1) % PEOPLE.length : i;
    fields.creator = {
      accountId: `acc-${creatorIdx}`,
      displayName: PEOPLE[creatorIdx][0],
      avatarUrls: avatarUrlsFor(PEOPLE[creatorIdx][0], creatorIdx),
    };
    ISSUES_BY_BOARD.get(board.id).push({
      id: String(seq),
      key: `${board.projectKey}-${100 + seq}`,
      fields,
      changelog: changelogFor(status, i, seq),
    });
  });
});

// Unassigned work still has to appear, and a sub-task must not: its points
// duplicate the parent's.
ISSUES_BY_BOARD.get(1).push({
  id: "u1", key: "ACME-900",
  fields: {
    summary: "Nobody has picked this up", status: { name: "To Do", statusCategory: { key: "new" } },
    assignee: null, issuetype: { name: "Task", subtask: false }, created: daysAgo(3), cf_sp: 2,
  },
});
ISSUES_BY_BOARD.get(1).push({
  id: "s1", key: "ACME-901",
  fields: {
    summary: "A sub-task, excluded from the totals",
    status: { name: "In Code Review", statusCategory: { key: "indeterminate" } },
    assignee: { accountId: "acc-0", displayName: PEOPLE[0][0], avatarUrls: avatarUrlsFor(PEOPLE[0][0], 0) },
    issuetype: { name: "Sub-task", subtask: true }, created: daysAgo(4), cf_sp: 99,
  },
});

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  // ?jira=slow holds the *agile* endpoints back — the sprint reads a view waits
  // on — so the fetching state can be looked at. Deliberately not every request:
  // delaying config.local.json too would hold up this fixture's own bootstrap and
  // the page would never even start.
  if (params.get("jira") === "slow" && url.includes("/rest/agile/")) await sleep(2000);
  // Cloned, because a real response is a fresh parse every time and some
  // readers reduce what they get in place — `compactChangelogs` replaces each
  // issue's changelog with a compact form at the API boundary. Handing out the
  // fixture's own objects meant the second fetch saw what the first had
  // consumed.
  const json = (body) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => structuredClone(body), text: async () => JSON.stringify(body),
  });
  const refusal = (status, body) => ({
    ok: false, status, headers: { get: () => null },
    json: async () => structuredClone(body), text: async () => JSON.stringify(body),
  });
  // What Jira answers a link create and a link delete with: nothing at all,
  // which is why both re-read the issue rather than rendering a response.
  const noContent = () => ({
    ok: true, status: 204, headers: { get: () => null },
    json: async () => null, text: async () => "",
  });

  const sprintList = /\/board\/(\d+)\/sprint(\?|$)/.exec(url);
  if (sprintList) {
    const board = BOARD_FIXTURE.find((b) => b.id === Number(sprintList[1]));
    if (!board) return json({ values: [] });
    const undated = params.get("sprint") === "undated";
    return json({
      values: [{
        id: board.sprint.id,
        name: board.sprint.name,
        goal: board.sprint.goal,
        state: "active",
        startDate: undated ? undefined : daysAgo(board.sprint.startsAgo),
        endDate: undated ? undefined : daysAgo(-board.sprint.endsIn),
      }],
    });
  }

  const sprintIssues = /\/board\/(\d+)\/sprint\/(\d+)\/issue/.exec(url);
  if (sprintIssues) {
    const issues = ISSUES_BY_BOARD.get(Number(sprintIssues[1])) || [];
    return json({ issues, total: issues.length });
  }

  // ── One issue, for the detail panel ──────────────────────────────────────
  // The detail is the screen the field-edit cells live on, so the fixture has to
  // answer for a single issue as well as for a board's worth. Any key resolves —
  // the harness is for looking at the layout, not for navigating a graph.
  const comments = /\/rest\/api\/3\/issue\/([^/?]+)\/comment/.exec(url);
  if (comments) return json(COMMENT_FIXTURE);

  const transitions = /\/rest\/api\/3\/issue\/([^/?]+)\/transitions/.exec(url);
  if (transitions) return json({ transitions: [] });

  const single = /\/rest\/api\/3\/issue\/([A-Za-z]+-\d+)(\?|$)/.exec(url);
  if (single) return json(issueDetailFixture(single[1]));

  // ── Issue links, for the link picker ──────────────────────────────────────
  // Four types, and none of them is matched by name anywhere in the app: the
  // picker offers whatever phrases come back. "Relates" has the same word on
  // both sides, which is the case that must appear once rather than twice, and
  // "Veroorzaakt" is named the way a site names its own — a fixture that called
  // everything by its English default would let a name match pass unnoticed.
  if (/\/rest\/api\/3\/issueLinkType/.test(url)) {
    return json({ issueLinkTypes: LINK_TYPES });
  }

  // ?link=refuse answers the way Jira refuses a link it understood — the panel
  // puts the sentence above the results rather than on a field, because a link
  // failure is about the pair and not about one input.
  if (/\/rest\/api\/3\/issueLink(\/|$|\?)/.test(url)) {
    if (options.method === "DELETE") {
      return params.get("link") === "refuse"
        ? refusal(403, { errorMessages: ["You do not have permission to unlink these issues."] })
        : noContent();
    }
    return params.get("link") === "refuse"
      ? refusal(400, { errorMessages: ["An issue cannot be linked to itself."] })
      : noContent();
  }

  // The link picker's own search. Matched on the query rather than on the path
  // because `getEpicNames` posts to the same endpoint, and answering both with
  // issues would put epics in the epic dropdown twice over.
  if (/\/rest\/api\/3\/search\/jql/.test(url)) {
    const jql = options.body ? String(JSON.parse(options.body).jql || "") : "";
    if (/^(summary ~|key =)/.test(jql)) return json({ issues: LINK_SEARCH_RESULTS, isLast: true });
  }

  // ── createmeta, for the create-issue panel ────────────────────────────────
  // The panel's whole premise is that the form is whatever the site says it is,
  // so the fixture answers with a field list that exercises every control once:
  // required text, rich text, a person, a single select, a date, a label list, a
  // multi-select, a number, and agile's two board-backed fields.
  //
  // ?createmeta=blocked adds a required field of a type the form does not
  // render, which is the case the panel has to refuse rather than guess at.
  // ?createmeta=minimal strips it back to a summary, which is what a
  // team-managed project with no required fields actually looks like.
  const createTypes = /\/issue\/createmeta\/([^/]+)\/issuetypes(\?|$)/.exec(url);
  if (createTypes) {
    return json({ maxResults: 50, startAt: 0, total: 4, isLast: true, issueTypes: CREATE_TYPES });
  }

  const createFields = /\/issue\/createmeta\/([^/]+)\/issuetypes\/(\d+)/.exec(url);
  if (createFields) {
    const fields = createFieldsFor(createFields[2]);
    return json({ maxResults: 100, startAt: 0, total: fields.length, isLast: true, fields });
  }

  // ?create=refuse answers the way Jira refuses a create it understood: a 400
  // with the field named, which is what the panel puts on the row.
  if (/\/rest\/api\/3\/issue$/.test(url)) {
    if (params.get("create") === "refuse") {
      return {
        ok: false, status: 400, headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            errorMessages: [],
            errors: { customfield_10099: "Acceptance criteria is required." },
          }),
        json: async () => ({}),
      };
    }
    return json({ id: "10500", key: "ABC-4242", self: "https://example.atlassian.net/rest/api/3/issue/10500" });
  }

  // ?stats=error: no cache and no token, so the window query fails the way a
  // missing token fails in the product.
  return json({ values: [], issues: [], total: 0 });
};

// A detail-shaped issue: renderedFields for the description, sub-tasks and a
// link so both groups in that section draw, and an estimate and a due date so
// the editable cells have something to show before anything is typed.
//
// ?detail=bare strips it to an unassigned, unestimated, unlinked issue, which is
// the state the cells are most likely to be wrong in — every one of them showing
// an em dash and still having to be clickable.
function issueDetailFixture(key) {
  const bare = params.get("detail") === "bare";
  return {
    id: "9001",
    key,
    renderedFields: {
      description: bare
        ? ""
        : "<p>The description, as Jira renders it — <strong>ADF</strong> arrives " +
          "as HTML and goes through the sanitiser before it reaches the page.</p>" +
          "<ul><li>a list item</li><li>and another</li></ul>",
    },
    fields: {
      summary: "Move the estimate onto the card without opening Jira",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Story", subtask: false },
      priority: { name: "Medium" },
      assignee: bare
        ? null
        : { accountId: "acc-0", displayName: PEOPLE[0][0], avatarUrls: avatarUrlsFor(PEOPLE[0][0], 0) },
      reporter: { accountId: "acc-1", displayName: PEOPLE[1][0], avatarUrls: avatarUrlsFor(PEOPLE[1][0], 1) },
      created: daysAgo(12),
      updated: daysAgo(1),
      duedate: bare ? null : new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      labels: bare ? [] : ["frontend", "sprint-goal"],
      components: [],
      project: { key: key.split("-")[0], name: "Acme platform" },
      cf_sp: bare ? undefined : 5,
      cf_sprint: [{ id: 501, name: "Sprint 42", state: "active" }],
      subtasks: bare
        ? []
        : [{
            key: `${key.split("-")[0]}-901`,
            fields: {
              summary: "A sub-task that already exists",
              status: { name: "Done", statusCategory: { key: "done" } },
              issuetype: { name: "Deeltaak", subtask: true },
            },
          }],
      // `id` is what makes a row removable — without one there is no link to
      // DELETE, and the ✕ is correctly absent.
      issuelinks: bare
        ? []
        : [{
            id: "20001",
            type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
            outwardIssue: {
              key: `${key.split("-")[0]}-950`,
              fields: {
                summary: "The thing this one is holding up",
                status: { name: "To Do", statusCategory: { key: "new" } },
                issuetype: { name: "Story", subtask: false },
              },
            },
          }],
    },
  };
}

// The site's own link types. Deliberately not the English defaults throughout:
// nothing in the app matches a link type by name, and a fixture that used only
// familiar names could not show that.
const LINK_TYPES = [
  { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  { id: "10001", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
  // Symmetric: one phrase for both directions, so the picker must offer it once.
  { id: "10002", name: "Relates", inward: "relates to", outward: "relates to" },
  { id: "10003", name: "Veroorzaakt", inward: "wordt veroorzaakt door", outward: "veroorzaakt" },
];

// What the picker's search finds. One of them is already linked in the detail
// fixture, so the filtered-out case is visible without typing a second query.
const LINK_SEARCH_RESULTS = [
  {
    id: "9101", key: "ACME-950",
    fields: {
      summary: "The thing this one is holding up",
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Story", subtask: false },
    },
  },
  {
    id: "9102", key: "ACME-311",
    fields: {
      summary: "Storage adapter rewrite",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Task", subtask: false },
    },
  },
  {
    id: "9103", key: "GOS-64",
    fields: {
      summary: "Bulk delete is slow on large exports",
      status: { name: "Done", statusCategory: { key: "done" } },
      issuetype: { name: "Bug", subtask: false },
    },
  },
];

const COMMENT_FIXTURE = {
  total: 1,
  comments: [{
    id: "1",
    author: { accountId: "acc-1", displayName: PEOPLE[1][0], avatarUrls: avatarUrlsFor(PEOPLE[1][0], 1) },
    created: daysAgo(1),
    renderedBody: "<p>Bumped the estimate — the migration is bigger than it looked.</p>",
  }],
};

const CREATE_TYPES = [
  { id: "10001", name: "Story", subtask: false, hierarchyLevel: 0 },
  { id: "10002", name: "Task", subtask: false, hierarchyLevel: 0 },
  { id: "10004", name: "Bug", subtask: false, hierarchyLevel: 0 },
  // Named in Dutch on purpose: the sub-task type is discovered by its `subtask`
  // flag, and a fixture that called it "Sub-task" would let a name match pass.
  { id: "10003", name: "Deeltaak", subtask: true, hierarchyLevel: -1 },
];

function createFieldsFor(typeId) {
  const f = (fieldId, name, schema, extra = {}) => ({ fieldId, name, schema, required: false, ...extra });
  const fields = [
    f("summary", "Summary", { type: "string", system: "summary" }, { required: true }),
    f("description", "Description", { type: "string", system: "description" }),
    f("assignee", "Assignee", { type: "user", system: "assignee" }),
    f("duedate", "Due date", { type: "date", system: "duedate" }),
    f("priority", "Priority", { type: "priority", system: "priority" }, {
      allowedValues: [
        { id: "1", name: "Highest" }, { id: "2", name: "High" },
        { id: "3", name: "Medium" }, { id: "4", name: "Low" },
      ],
      hasDefaultValue: true, defaultValue: { id: "3" },
    }),
  ];
  if (params.get("createmeta") === "minimal") return [fields[0]];

  fields.push(
    f("labels", "Labels", { type: "array", items: "string", system: "labels" }),
    f("components", "Components", { type: "array", items: "component", system: "components" }, {
      allowedValues: [{ id: "9", name: "api" }, { id: "10", name: "web" }, { id: "11", name: "infra" }],
    }),
    f("cf_sp", "Story Points", { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" }),
    f("cf_sprint", "Sprint", { type: "array", items: "string", custom: "com.pyxis.greenhopper.jira:gh-sprint" }),
    f("customfield_10014", "Epic Link", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" }),
    // Optional and unrenderable: the panel lists it as left unset rather than
    // pretending the form is the whole of Jira's.
    f("customfield_10098", "Request participants", { type: "sd-request-participants" })
  );
  // A bug asks one more question than a story does, which is the point of
  // reading the layout per issue type rather than per project.
  if (typeId === "10004") {
    fields.push(f("customfield_10097", "Steps to reproduce", {
      type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
    }, { required: true }));
  }
  if (params.get("createmeta") === "blocked") {
    fields.push(f("customfield_10096", "Approvers", { type: "sd-approvals" }, { required: true }));
  }
  return fields;
}

// ── Seed config, roster and the GitHub window cache ──────────────────────────

export const { loadConfig, saveConfig, CONFIG } = await import("./js/config.js");
await saveConfig({
  site: { baseUrl: "https://example.atlassian.net", wikiPath: "/wiki" },
  // The recap header prints brand.orgLogo when it is set. Pointed at the app's
  // own tracked logo rather than assets/brand/, which is a gitignored working
  // folder — a preview has to render in a fresh clone. ?logo=off exercises the
  // text fallback.
  brand: params.get("logo") === "off"
    ? { productName: "butter_jira", orgName: "Preview Org", orgLogo: "" }
    : { productName: "butter_jira", orgName: "Preview Org", orgLogo: "assets/logo.png" },
  boards: BOARD_FIXTURE.map(({ id, name, projectKey, color }) => ({ id, name, projectKey, color })),
  fields: { storyPoints: ["cf_sp"], sprint: ["cf_sprint"], startDate: [], epicLink: [], epicName: [] },
  // The split the delivery table is built to read: a dedicated code review
  // column beside a general review one.
  statusGroups: [
    { name: "To Do", statuses: ["To Do", "Open", "Backlog"] },
    { name: "In Progress", statuses: ["In Progress", "In Development"] },
    { name: "In Code Review", statuses: ["In Code Review", "Code Review"] },
    { name: "In Review", statuses: ["In Review", "Review"] },
    { name: "Done", statuses: ["Done", "Closed", "Resolved"] },
  ],
  github: params.get("github") === "off"
    ? { enabled: false, host: "github.com", org: "", repos: [] }
    : { enabled: true, host: "github.com", org: "example", repos: ["example/alpha", "example/beta"] },
});
await loadConfig();

// A page that reads its own credentials — recap.html does, the way issue.html
// does — needs them in storage rather than handed in as an argument. Synthetic,
// obviously, and only ever in the stubbed store this file installs.
const { saveCredentials } = await import("./js/credentials.js");
await saveCredentials({ email: "preview@example.invalid", token: "preview-token" });

// BOARDS is a module-level array the API layer iterates; nothing fills it until
// this runs, and an empty one means "no sprints anywhere".
const { loadBoards } = await import("./js/utils.js");
await loadBoards();

const { TEAMS, saveTeam } = await import("./js/team.js");
TEAMS.activeTeamId = "default";
TEAMS.teams = [{
  id: "default",
  name: "Data Engineering",
  // One person is deliberately absent from the roster, so their row shows what an
  // unmapped person looks like.
  members: PEOPLE.filter((p) => p[1]).map((p, i) => ({
    accountId: `acc-${PEOPLE.indexOf(p)}`,
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

const { statsCacheKey } = await import("./js/github.js");
slowKey = statsCacheKey(CONFIG);

// ?stats=partial keeps the payload but marks one repo as half-answered and
// another as truncated — the state where every GitHub figure below is an
// undercount, which the document has to say rather than print as a whole number.
const partialStats = params.get("stats") === "partial";

if (params.get("stats") !== "error") {
  // Deterministic per person: pull requests opened during the sprint, half of
  // them merged to the default branch, with diffs big enough that the compact
  // formatter has something to do.
  const windowPrs = [];
  PEOPLE.forEach((person, i) => {
    if (!person[1]) return;
    for (let n = 0; n < 1 + ((i * 3) % 5); n++) {
      const merged = n % 2 === 0;
      windowPrs.push({
        repo: n % 2 ? "example/alpha" : "example/beta",
        number: 500 + i * 20 + n,
        title: `Sprint change ${n + 1} from ${person[0]}`,
        url: "#",
        author: person[1],
        state: merged ? "MERGED" : "OPEN",
        createdAt: daysAgo(1 + (n % 7)),
        updatedAt: daysAgo(1),
        mergedAt: merged ? daysAgo(1 + (n % 3)) : "",
        baseRef: "main",
        toDefaultBranch: true,
        additions: 140 + i * 337 + n * 461,
        deletions: 32 + i * 109 + n * 217,
      });
    }
  });

  // Direct pushes to main: every third person works that way, so their row is
  // carried largely by commits with no pull request behind them. ?push=off drops
  // them, which is the before-and-after of counting them at all.
  const commits = [];
  if (params.get("push") !== "off") {
    PEOPLE.forEach((person, i) => {
      if (!person[1] || i % 3 !== 2) return;
      for (let n = 0; n < 2 + (i % 3); n++) {
        commits.push({
          repo: "example/alpha",
          oid: `c${i}${n}`,
          author: person[1],
          committedDate: daysAgo(1 + (n % 6)),
          additions: 60 + i * 91 + n * 37,
          deletions: 14 + i * 23 + n * 11,
        });
      }
    });
  }

  // Reviews and comments, always on somebody else's pull request — the statistic
  // deliberately excludes replies on your own, so crediting them here would test
  // nothing.
  const windowReviews = [];
  const windowComments = [];
  PEOPLE.forEach((person, i) => {
    if (!person[1]) return;
    const target = PEOPLE[(i + 1) % PEOPLE.length];
    if (!target[1]) return;
    for (let n = 0; n < 1 + ((i * 3) % 5); n++) {
      windowReviews.push({
        repo: "example/alpha",
        number: 500 + ((i + 1) % PEOPLE.length) * 20,
        author: person[1],
        prAuthor: target[1],
        submittedAt: daysAgo(1 + (n % 5)),
        state: n % 3 === 0 ? "APPROVED" : "COMMENTED",
        comments: n % 4,
      });
    }
    for (let n = 0; n < 1 + ((i * 2) % 4); n++) {
      windowComments.push({
        repo: "example/beta",
        number: 600 + ((i + 1) % PEOPLE.length),
        author: person[1],
        prAuthor: target[1],
        createdAt: daysAgo(1 + (n % 4)),
      });
    }
  });

  local[slowKey] = {
    ts: Date.now(),
    value: {
      fetchedAt: new Date().toISOString(),
      since: daysAgo(45),
      repos: ["example/alpha", "example/beta"],
      reached: ["example/alpha", "example/beta"],
      truncated: partialStats ? ["example/beta"] : [],
      failures: partialStats
        ? [{
            repo: "example/alpha",
            type: "graphql",
            message: "Direct pushes unavailable — Resource not accessible by personal access token",
          }]
        : [],
      pullRequests: windowPrs,
      reviews: windowReviews,
      comments: windowComments,
      commits,
    },
  };
}

