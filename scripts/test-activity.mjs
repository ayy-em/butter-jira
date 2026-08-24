#!/usr/bin/env node
// Unit checks for per-person Jira activity: changelog compaction at the fetch
// boundary, the windowed activity model, how done-ness is decided from a status
// *name* when the changelog carries no status category, and the framing rules
// the module commits to (ordered by name, absence distinguished from zero,
// truncation carried rather than hidden).
//
// No dependencies, no network, no browser — the reader is pure, and the panels
// read it.
//
// Usage: node scripts/test-activity.mjs

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
      remove: (keys) => { for (const k of [].concat(keys)) delete sync[k]; return Promise.resolve(); },
    },
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete local[k]; return Promise.resolve(); },
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const cfg = await import(new URL("../js/config.js", import.meta.url));
const team = await import(new URL("../js/team.js", import.meta.url));
const act = await import(new URL("../js/activity.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (title) => console.log(`\n── ${title} ──`);

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["cf_sp"] },
  statusGroups: [
    { name: "To Do", statuses: ["To Do", "Open"] },
    { name: "In Progress", statuses: ["In Progress"] },
    { name: "In Review", statuses: ["In Review"] },
    { name: "Done", statuses: ["Done", "Afgerond"] },
  ],
};
local = { schemaVersion: 2 };
await cfg.loadConfig();

await team.saveTeam({
  activeTeamId: "default",
  teams: [{
    id: "default",
    name: "Data Engineering",
    members: [
      { accountId: "acc-1", jiraName: "Avery Quinn", active: true },
      { accountId: "acc-2", jiraName: "Blake Rivers", nameOverride: "Blake R", active: true },
      // On the roster but never named by an issue in the fixtures below, so the
      // only way a label reaches them is the roster fallback.
      { accountId: "acc-9", jiraName: "Dana Okonjo", active: true },
    ],
  }],
});
await team.loadTeam();

const SINCE = "2026-08-10T00:00:00.000Z";
const UNTIL = "2026-08-20T00:00:00.000Z";
const IN = "2026-08-15T10:00:00.000Z";
const BEFORE = "2026-08-01T10:00:00.000Z";
const AFTER = "2026-08-25T10:00:00.000Z";

const person = (id, name) => ({ accountId: id, displayName: name });

// A raw Jira changelog, in the shape the API actually sends it.
function rawLog(entries, total = null) {
  return {
    startAt: 0,
    maxResults: entries.length,
    total: total ?? entries.length,
    histories: entries.map(({ by, at, items }) => ({
      id: "h",
      author: by ? { accountId: by, displayName: by, avatarUrls: { "48x48": "http://x/a.png" } } : null,
      created: at,
      items,
    })),
  };
}

const statusItem = (from, to) => ({
  field: "status", fieldId: "status", fieldtype: "jira",
  from: "1", fromString: from, to: "2", toString: to,
});
const assigneeItem = (fromId, fromName, toId, toName) => ({
  field: "assignee", fieldId: "assignee", fieldtype: "jira",
  from: fromId, fromString: fromName, to: toId, toString: toName,
});
const pointsItem = () => ({
  field: "Story Points", fieldId: "cf_sp", fieldtype: "custom",
  from: null, fromString: "3", to: null, toString: "5",
});

function issue(key, opts = {}) {
  return {
    key,
    fields: {
      summary: opts.summary || key,
      issuetype: { name: opts.subtask ? "Deeltaak" : "Story", subtask: Boolean(opts.subtask) },
      status: {
        name: opts.status || "In Progress",
        statusCategory: { key: opts.category || "indeterminate" },
      },
      assignee: opts.assignee || null,
      creator: opts.creator || null,
      created: opts.created || BEFORE,
    },
    changelog: opts.log || undefined,
  };
}

// ── Compaction ───────────────────────────────────────────────────────────────
section("compactHistory — the fetch-boundary reduction");

const wide = issue("ABC-1", {
  log: rawLog([
    { by: "acc-1", at: IN, items: [statusItem("To Do", "In Progress"), pointsItem()] },
    { by: "acc-2", at: IN, items: [assigneeItem("acc-1", "Avery Quinn", "acc-2", "Blake Rivers")] },
  ]),
});
const compact = act.compactHistory(wide);

check("one event per changelog item, not per entry", compact.events.length === 3);
check("author id is carried", compact.events[0].by === "acc-1");
check("timestamp is carried", compact.events[0].at === IN);
check("a status item is recognised by fieldId", compact.events[0].kind === "status");
check("a custom field is an edit, not a transition", compact.events[1].kind === "field");
check("an assignee item is recognised", compact.events[2].kind === "assignee");
check("display values are kept for printing", compact.events[0].to === "In Progress");
check("raw ids are kept for identifying people", compact.events[2].toId === "acc-2");
check("field label is kept raw for an unrecognised field", compact.events[1].field === "Story Points");

check(
  "avatar URLs and nested author records do not survive compaction",
  !JSON.stringify(compact).includes("avatarUrls")
);
const rawBytes = JSON.stringify(wide.changelog).length;
const compactBytes = JSON.stringify(compact).length;
check(`compaction shrinks the payload (${rawBytes}B -> ${compactBytes}B)`, compactBytes < rawBytes);

check("no changelog yields null rather than an empty model", act.compactHistory(issue("ABC-2")) === null);
check("a changelog with no histories compacts to zero events",
  act.compactHistory(issue("ABC-3", { log: rawLog([]) })).events.length === 0);

// Localised sites: `fieldId` is untranslated, so the Dutch label still reads as
// a transition. And a field whose id is present but unrecognised is an edit even
// if its *name* looks like a status — the exact misread the guard exists for.
const localised = act.compactHistory(issue("ABC-4", {
  log: rawLog([
    { by: "acc-1", at: IN, items: [{ field: "Status", fieldId: "status", fromString: "Open", toString: "Afgerond" }] },
    { by: "acc-1", at: IN, items: [{ field: "Status of review", fieldId: "cf_999", fromString: "a", toString: "b" }] },
    { by: "acc-1", at: IN, items: [{ field: "Toegewezen persoon", fromString: "x", toString: "y" }] },
  ]),
}));
check("a localised label with a known fieldId is still a transition", localised.events[0].kind === "status");
check("a custom field named like a status is an edit", localised.events[1].kind === "field");
check("a localised name with no fieldId falls back to the name", localised.events[2].kind === "assignee");

section("truncation — carried, never hidden");

const deep = act.compactHistory(issue("ABC-5", {
  log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("To Do", "In Progress")] }], 140),
}));
check("truncated is set when total exceeds what was returned", deep.truncated === true);
check("the total Jira reported is kept", deep.total === 140);
check("what was actually returned is kept", deep.returned === 1);
check("a complete history is not marked truncated",
  act.compactHistory(issue("ABC-6", { log: rawLog([{ by: "acc-1", at: IN, items: [pointsItem()] }]) })).truncated === false);

section("compactChangelogs — in place, before the cache");

const batch = [
  issue("ABC-7", { log: rawLog([{ by: "acc-1", at: IN, items: [pointsItem()] }]) }),
  issue("ABC-8"),
];
act.compactChangelogs(batch);
check("the raw changelog is removed from the issue", batch[0].changelog === undefined);
check("the compact history replaces it", Array.isArray(batch[0].history?.events));
check("an issue with no changelog is untouched", batch[1].history === undefined);
check("the array is returned for chaining", act.compactChangelogs([]).length === 0);

// ── The model ────────────────────────────────────────────────────────────────
section("activityFrom — transitions and completions");

const groups = cfg.CONFIG.statusGroups;
const build = (issues, opts = {}) =>
  act.activityFrom(act.compactChangelogs(issues), {
    since: SINCE, until: UNTIL, statusGroups: groups, ...opts,
  });

const moved = build([
  issue("ABC-10", {
    status: "Done", category: "done",
    assignee: person("acc-1", "Avery Quinn"),
    log: rawLog([
      { by: "acc-1", at: IN, items: [statusItem("To Do", "In Progress")] },
      { by: "acc-1", at: IN, items: [statusItem("In Progress", "In Review")] },
      { by: "acc-2", at: IN, items: [statusItem("In Review", "Done")] },
    ]),
  }),
]);
const avery = act.activityFor(moved, "acc-1");
const blake = act.activityFor(moved, "acc-2");

check("transitions are counted per mover", avery.transitions === 2 && blake.transitions === 1);
check("the person who closed it gets the completion", blake.completed === 1);
check("a mid-workflow transition is not a completion", avery.completed === 0);
check("touched issues are listed, not just counted", avery.touchedIssues.includes("ABC-10"));
check("completed issues are listed", blake.completedIssues.includes("ABC-10"));

const reopened = build([
  issue("ABC-11", {
    status: "In Progress",
    log: rawLog([
      { by: "acc-1", at: IN, items: [statusItem("In Review", "Done")] },
      { by: "acc-2", at: IN, items: [statusItem("Done", "In Progress")] },
      { by: "acc-1", at: IN, items: [statusItem("In Progress", "Done")] },
    ]),
  }),
]);
check("a reopen is counted, not netted off a completion",
  act.activityFor(reopened, "acc-2").reopened === 1);
check("closing the same issue twice is two completions",
  act.activityFor(reopened, "acc-1").completed === 2);
check("...but one distinct completed issue",
  act.activityFor(reopened, "acc-1").completedIssues.length === 1);

section("done-ness from a status name alone");

// The changelog carries names, not categories. Source 1: an issue in hand whose
// current status names a category nobody configured.
const custom = build([
  issue("ABC-12", {
    status: "Shipped", category: "done",
    log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("In Review", "Shipped")] }]),
  }),
]);
check("a custom done status is learned from the issues in hand",
  act.activityFor(custom, "acc-1").completed === 1);

// Source 2: a status transitioned through and away from, which no current issue
// sits in — the configured status groups are the only thing that knows it.
const throughDone = build([
  issue("ABC-13", {
    status: "In Progress", category: "indeterminate",
    log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("In Review", "Afgerond")] }]),
  }),
]);
check("a configured done status is resolved from the status groups",
  act.activityFor(throughDone, "acc-1").completed === 1);

// Source 3: neither knows the name, so the same regex isDone falls back to.
const unknown = act.activityFrom(
  act.compactChangelogs([
    issue("ABC-14", {
      status: "In Progress", category: "indeterminate",
      log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("Open", "Resolved")] }]),
    }),
  ]),
  { since: SINCE, until: UNTIL, statusGroups: [] }
);
check("an unknown name falls back to the regex", act.activityFor(unknown, "acc-1").completed === 1);
check("a plainly-open status is not done",
  act.activityFor(build([
    issue("ABC-15", { log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("To Do", "In Progress")] }]) }),
  ]), "acc-1").completed === 0);

section("assignment — picked up, handed off, handed out");

const reassigned = build([
  issue("ABC-16", {
    assignee: person("acc-2", "Blake Rivers"),
    log: rawLog([
      { by: "acc-1", at: IN, items: [assigneeItem("acc-1", "Avery Quinn", "acc-2", "Blake Rivers")] },
    ]),
  }),
  issue("ABC-17", {
    assignee: person("acc-1", "Avery Quinn"),
    log: rawLog([
      { by: "acc-1", at: IN, items: [assigneeItem(null, null, "acc-1", "Avery Quinn")] },
    ]),
  }),
]);
const a16 = act.activityFor(reassigned, "acc-1");
const b16 = act.activityFor(reassigned, "acc-2");
check("the receiver gets the pick-up", b16.pickedUp === 1);
check("the person it left is counted as handing it out", a16.assignedOut === 1);
check("assigning to someone else is counted separately", a16.assignedToOthers === 1);
check("assigning to yourself is a pick-up, not a hand-out",
  a16.pickedUp === 1 && a16.assignedToOthers === 1);
check("an assignment is not a transition", b16.transitions === 0);

// A person who only ever appears as a changelog author — never as an assignee or
// creator on any issue in hand — still gets a bucket, and gets their name from
// the roster.
const authorOnly = build([
  issue("ABC-18", {
    assignee: person("acc-1", "Avery Quinn"),
    log: rawLog([{ by: "acc-9", at: IN, items: [statusItem("To Do", "In Progress")] }]),
  }),
]);
const dana = authorOnly.byPerson.find((p) => p.key === "acc-9");
check("a changelog-only author still gets a bucket", Boolean(dana));
check("their name comes from the roster", dana.label === "Dana Okonjo");
check("a roster nameOverride is preferred over the Jira name",
  build([
    issue("ABC-19", {
      assignee: person("acc-2", "Blake Rivers"),
      log: rawLog([{ by: "acc-2", at: IN, items: [pointsItem()] }]),
    }),
  ]).byPerson.find((p) => p.key === "acc-2").label === "Blake R");

section("edits, creations and what is deliberately not counted");

const edited = build([
  issue("ABC-20", {
    creator: person("acc-1", "Avery Quinn"), created: IN,
    log: rawLog([{ by: "acc-2", at: IN, items: [pointsItem()] }]),
  }),
  // Created before the window opened, so it is not a creation *this* sprint.
  issue("ABC-21", { creator: person("acc-1", "Avery Quinn"), created: BEFORE }),
  // Created after it closed.
  issue("ABC-22", { creator: person("acc-2", "Blake Rivers"), created: AFTER }),
]);
check("a field edit is counted as an edit", act.activityFor(edited, "acc-2").edits === 1);
check("an issue created in the window is counted", act.activityFor(edited, "acc-1").created === 1);
check("created issues are listed", act.activityFor(edited, "acc-1").createdIssues.includes("ABC-20"));
check("an issue created before the window is not", act.activityFor(edited, "acc-1").created === 1);
check("an issue created after the window is not", act.activityFor(edited, "acc-2").created === 0);

// Creations need no changelog, so they are known whenever the issues were
// fetched — and a bucket built from them alone still has to say that its
// history-derived half is an absence rather than a row of zeroes.
const createdOnly = build([issue("ABC-23", { creator: person("acc-1", "A"), created: IN })]);
const only = act.activityFor(createdOnly, "acc-1");
check("an issue with no history still contributes its creation", only?.created === 1);
check("...and the bucket says its history half is unknown", only.historyKnown === false);
check("...while a bucket from a fetched history says it is known",
  act.activityFor(edited, "acc-2").historyKnown === true);

const subtasks = build([
  issue("ABC-24", {
    subtask: true,
    log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("To Do", "Done")] }]),
  }),
]);
check("sub-tasks are excluded, as everywhere else in the app",
  subtasks.byPerson.length === 0);

const automated = build([
  issue("ABC-25", {
    log: rawLog([{ by: null, at: IN, items: [statusItem("To Do", "Done")] }]),
  }),
]);
check("an authorless entry (automation) is dropped, not pooled as a person",
  automated.byPerson.length === 0);

section("the window");

const windowed = build([
  issue("ABC-26", {
    log: rawLog([
      { by: "acc-1", at: BEFORE, items: [statusItem("To Do", "In Progress")] },
      { by: "acc-1", at: IN, items: [statusItem("In Progress", "In Review")] },
      { by: "acc-1", at: AFTER, items: [statusItem("In Review", "Done")] },
    ]),
  }),
]);
check("only in-window events count", act.activityFor(windowed, "acc-1").transitions === 1);
check("the window is reported back", windowed.window.from === SINCE && windowed.window.to === UNTIL);

// The same reader with a week-long window instead of a sprint — the parameter
// M14 needs, exercised here so it is not discovered later.
const week = act.activityFrom(
  act.compactChangelogs([
    issue("ABC-27", {
      log: rawLog([
        { by: "acc-1", at: "2026-08-11T09:00:00.000Z", items: [statusItem("To Do", "In Progress")] },
        { by: "acc-1", at: "2026-08-18T09:00:00.000Z", items: [statusItem("In Progress", "Done")] },
      ]),
    }),
  ]),
  { since: "2026-08-17T00:00:00.000Z", until: "2026-08-24T00:00:00.000Z", statusGroups: groups }
);
check("a week window over the same reader counts only that week",
  act.activityFor(week, "acc-1").transitions === 1);
check("an open-ended window has no upper bound",
  act.activityFor(
    act.activityFrom(act.compactChangelogs([
      issue("ABC-28", { log: rawLog([{ by: "acc-1", at: AFTER, items: [pointsItem()] }]) }),
    ]), { since: SINCE, statusGroups: groups }),
    "acc-1"
  ).edits === 1);

section("framing — the rules the module commits to");

const many = build([
  issue("ABC-30", {
    log: rawLog([
      // Blake does far more than Avery, and must still sort after them.
      { by: "acc-2", at: IN, items: [statusItem("To Do", "In Progress")] },
      { by: "acc-2", at: IN, items: [statusItem("In Progress", "In Review")] },
      { by: "acc-2", at: IN, items: [statusItem("In Review", "Done")] },
      { by: "acc-1", at: IN, items: [pointsItem()] },
    ]),
  }),
]);
check("people are ordered by name, never by output",
  many.byPerson.map((p) => p.label).join(",") === "Avery Quinn,Blake R");
check("no total, score or composite is exposed",
  !("total" in many.byPerson[0]) && !("score" in many.byPerson[0]));

const unassignedLast = act.activityFrom(
  act.compactChangelogs([
    issue("ABC-31", {
      creator: person(act.UNASSIGNED, "Zed"), created: IN,
      log: rawLog([{ by: "acc-1", at: IN, items: [pointsItem()] }]),
    }),
  ]),
  { since: SINCE, until: UNTIL, statusGroups: groups }
);
check("the unassigned bucket sorts last despite the name",
  unassignedLast.byPerson[unassignedLast.byPerson.length - 1].key === act.UNASSIGNED);

section("absence is not zero");

const noHistory = act.activityFrom([issue("ABC-32", { created: IN })], { since: SINCE, statusGroups: groups });
check("hasHistory is false when nothing carried one", noHistory.hasHistory === false);
check("an unknown person cannot be answered for without history",
  act.activityFor(noHistory, "acc-7") === null);
check("hasHistory is true once one issue carries one", moved.hasHistory === true);
check("a person with history and no actions is a zero, not an absence",
  act.activityFor(moved, "acc-9")?.transitions === 0);
check("no model at all answers null", act.activityFor(null, "acc-1") === null);
check("no account id answers null", act.activityFor(moved, "") === null);

section("truncation reaches the model");

const partial = build([
  issue("ABC-33", {
    log: rawLog([{ by: "acc-1", at: IN, items: [statusItem("To Do", "In Progress")] }], 300),
  }),
  issue("ABC-34", {
    log: rawLog([{ by: "acc-1", at: IN, items: [pointsItem()] }]),
  }),
]);
check("the truncated issue is named so a screen can say so",
  partial.truncated.length === 1 && partial.truncated[0] === "ABC-33");
check("a complete issue is not named", !partial.truncated.includes("ABC-34"));
check("counts still accrue from a truncated history",
  act.activityFor(partial, "acc-1").transitions === 1);

section("degenerate input");

check("no issues yields an empty model", act.activityFrom([]).byPerson.length === 0);
check("undefined issues does not throw", act.activityFrom().byPerson.length === 0);
check("no options does not throw", act.activityFrom([issue("ABC-35")]).byPerson.length === 0);
check("a null in the issue list is skipped",
  act.activityFrom([null, issue("ABC-36")]).byPerson.length === 0);
check("an unparseable timestamp is out of window",
  act.activityFor(build([
    issue("ABC-37", { log: rawLog([{ by: "acc-1", at: "not-a-date", items: [pointsItem()] }]) }),
  ]), "acc-1").edits === 0);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
