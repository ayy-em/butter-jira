#!/usr/bin/env node
// Unit checks for the sprint hygiene checks: which issue types each check
// applies to, what it flags, muting, and the cross-check "fix these first"
// ranking. No dependencies, no network, no browser.
//
// Usage: node scripts/test-monitor.mjs

const MONITOR_URL = new URL("../js/monitor.js", import.meta.url);
const CONFIG_URL = new URL("../js/config.js", import.meta.url);
const TEAM_URL = new URL("../js/team.js", import.meta.url);

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
      get: (keys) => Promise.resolve(pick(sync, keys)),
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

const cfg = await import(CONFIG_URL);
const team = await import(TEAM_URL);
const mon = await import(MONITOR_URL);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

// Story points and epic link resolve through the configured field mapping.
sync = { site: { baseUrl: "https://x.atlassian.net" }, fields: { storyPoints: ["cf_sp"], epicLink: ["cf_epic"] } };
local = { schemaVersion: 2 };
await cfg.loadConfig();
await team.loadTeam();

let seq = 0;
function issue(overrides = {}) {
  const {
    type = "Story", subtask = false, hierarchyLevel, status = "In Progress",
    assignee = { accountId: "acc-1", displayName: "Ada Lovelace" },
    epic = "ABC-100", duedate = "2026-08-20", points = 3, key,
  } = overrides;
  seq++;
  const issuetype = { name: type, subtask };
  if (hierarchyLevel !== undefined) issuetype.hierarchyLevel = hierarchyLevel;
  const fields = { issuetype, status: { name: status }, assignee, summary: `Issue ${seq}` };
  if (epic !== null) fields.cf_epic = epic;
  if (duedate !== null) fields.duedate = duedate;
  if (points !== null) fields.cf_sp = points;
  return { key: key || `ABC-${seq}`, id: String(seq), boardId: 1, fields };
}
const sectionFor = (sections, id) => sections.find((s) => s.id === id);

section("issue-type detection");
check("subtask boolean", mon.isSubtask(issue({ subtask: true })) === true);
check("hierarchyLevel -1 is a subtask", mon.isSubtask(issue({ hierarchyLevel: -1 })) === true);
check("name fallback", mon.isSubtask(issue({ type: "Sub-task" })) === true);
check("name fallback without hyphen", mon.isSubtask(issue({ type: "Subtask" })) === true);
check("story is not a subtask", mon.isSubtask(issue()) === false);
check("epic by name", mon.isEpic(issue({ type: "Epic" })) === true);
check("epic by hierarchyLevel", mon.isEpic(issue({ hierarchyLevel: 1 })) === true);
check("hierarchyLevel wins over name", mon.isEpic(issue({ type: "Epic", hierarchyLevel: 0 })) === false);
check("story is not an epic", mon.isEpic(issue()) === false);

section("unassigned check");
let sections = mon.runChecks([
  issue({ assignee: null }),
  issue({ assignee: null, type: "Epic" }),            // epics excluded
  issue({ assignee: null, status: "Done" }),          // done excluded
  issue({ assignee: null, subtask: true }),           // subtasks DO count here
  issue(),                                            // assigned
], {});
let s = sectionFor(sections, "unassigned");
check("flags unassigned work", s.count === 2);
check("epics excluded", !s.issues.some((i) => mon.isEpic(i)));
check("done work excluded", !s.issues.some((i) => i.fields.status.name === "Done"));
check("subtasks included", s.issues.some((i) => mon.isSubtask(i)));
check("considered count excludes skipped types", s.considered === 3);

section("no epic parent check");
sections = mon.runChecks([
  issue({ epic: null }),
  issue({ epic: null, subtask: true }),               // subtask excluded — the ask
  issue({ epic: null, type: "Epic" }),                // an epic has no epic
  issue({ epic: null, status: "Done" }),
  issue({ epic: "ABC-100" }),
], {});
s = sectionFor(sections, "noEpic");
check("flags orphan stories", s.count === 1);
check("subtasks excluded", !s.issues.some((i) => mon.isSubtask(i)));
check("epics excluded", !s.issues.some((i) => mon.isEpic(i)));
check("considered count reflects exclusions", s.considered === 2);

section("no epic: team-managed projects link via parent");
sections = mon.runChecks([
  { key: "T-1", fields: { issuetype: { name: "Story" }, status: { name: "To Do" },
      parent: { key: "T-99", fields: { issuetype: { name: "Epic" } } } } },
  { key: "T-2", fields: { issuetype: { name: "Story" }, status: { name: "To Do" } } },
], {});
s = sectionFor(sections, "noEpic");
check("parent link counts as an epic", s.count === 1 && s.issues[0].key === "T-2");

section("no due date check");
sections = mon.runChecks([
  issue({ duedate: null }),
  issue({ duedate: null, subtask: true }),
  issue({ duedate: null, type: "Epic" }),
  issue({ duedate: "2026-09-01" }),
], {});
s = sectionFor(sections, "noDueDate");
check("flags undated work", s.count === 1);
check("subtasks and epics excluded", s.considered === 2);

section("no story points check");
sections = mon.runChecks([
  issue({ points: null }),
  issue({ points: 0 }),                               // zero is an estimate
  issue({ points: null, subtask: true }),
  issue({ points: 5 }),
], {});
s = sectionFor(sections, "noPoints");
check("flags unestimated work", s.count === 1);
check("zero points is not missing", !s.issues.some((i) => i.fields.cf_sp === 0));

section("unresolved field mapping does not manufacture findings");
sync = { site: { baseUrl: "https://x.atlassian.net" }, fields: {} };
await cfg.loadConfig();
sections = mon.runChecks([issue({ points: 5, epic: "ABC-100" }), issue({ points: null })], {});
s = sectionFor(sections, "noPoints");
check("points check reports unavailable, not 2 findings", s.count === 0 && Boolean(s.unavailable));
check("unavailable reason points at Settings", s.unavailable.includes("Field mapping"));
check("nothing considered when unavailable", s.considered === 0);
check("unavailable check contributes nothing to the total",
  mon.totalFindings(sections) === sectionFor(sections, "noEpic").count + sectionFor(sections, "unassigned").count + sectionFor(sections, "noDueDate").count);
s = sectionFor(sections, "noEpic");
check("epic check still runs via parent fallback", s.unavailable === null);
check("epic check warns that the field is unmapped", Boolean(s.caveat) && s.caveat.includes("parent field"));

sync = { site: { baseUrl: "https://x.atlassian.net" }, fields: { storyPoints: ["cf_sp"], epicLink: ["cf_epic"] } };
await cfg.loadConfig();
sections = mon.runChecks([issue({ points: null })], {});
check("points check runs once a field is mapped", sectionFor(sections, "noPoints").unavailable === null);
check("no caveat when epic link is mapped", sectionFor(sections, "noEpic").caveat === null);

section("statusCategory beats status name");
sections = mon.runChecks([
  { key: "S-1", fields: { issuetype: { name: "Story" }, assignee: null,
      status: { name: "Shipped", statusCategory: { key: "done" } } } },
  { key: "S-2", fields: { issuetype: { name: "Story" }, assignee: null,
      status: { name: "Done", statusCategory: { key: "indeterminate" } } } },
], {});
s = sectionFor(sections, "unassigned");
check("custom done status excluded via category", !s.issues.some((i) => i.key === "S-1"));
check('status literally named "Done" but not done is included', s.issues.some((i) => i.key === "S-2"));

section("muting");
check("all checks on by default", mon.runChecks([], {}).length === mon.MONITOR_CHECKS.length);
check("isCheckEnabled defaults true", mon.isCheckEnabled({}, "unassigned") === true);
check("explicit false mutes", mon.isCheckEnabled({ unassigned: false }, "unassigned") === false);
check("explicit true keeps", mon.isCheckEnabled({ unassigned: true }, "unassigned") === true);
sections = mon.runChecks([issue({ assignee: null, epic: null })], { unassigned: false });
check("muted section absent", !sectionFor(sections, "unassigned"));
check("other sections unaffected", Boolean(sectionFor(sections, "noEpic")));
check("declaration order preserved",
  JSON.stringify(mon.runChecks([], {}).map((x) => x.id)) ===
  JSON.stringify(mon.MONITOR_CHECKS.map((c) => c.id)));

section("totals and empty input");
sections = mon.runChecks([issue({ assignee: null, epic: null, duedate: null, points: null })], {});
check("one bad issue trips four checks", mon.totalFindings(sections) === 4);
check("empty input -> zero findings", mon.totalFindings(mon.runChecks([], {})) === 0);
check("non-array input tolerated", mon.totalFindings(mon.runChecks(null, {})) === 0);
check("clean issue -> zero findings", mon.totalFindings(mon.runChecks([issue()], {})) === 0);

section("worst offenders");
sections = mon.runChecks([
  issue({ key: "ABC-BAD", assignee: null, epic: null, duedate: null, points: null }),
  issue({ key: "ABC-MEH", assignee: null, epic: null }),
  issue({ key: "ABC-OK", points: null }),
  issue({ key: "ABC-FINE" }),
], {});
let worst = mon.worstOffenders(sections);
check("ranked by number of checks tripped", worst[0].issue.key === "ABC-BAD");
check("second place next", worst[1].issue.key === "ABC-MEH");
check("single-check issues excluded", !worst.some((w) => w.issue.key === "ABC-OK"));
check("clean issues excluded", !worst.some((w) => w.issue.key === "ABC-FINE"));
check("check labels attached", worst[0].checks.length === 4);
check("limit respected", mon.worstOffenders(sections, 1).length === 1);
check("no multi-check issues -> empty", mon.worstOffenders(mon.runChecks([issue({ points: null })], {})).length === 0);

section("badge memo");
check("starts unset", mon.getBadgeCount() === null);
mon.setBadgeCount(7);
check("stores count", mon.getBadgeCount() === 7);
mon.setBadgeCount(0);
check("zero is retained, not treated as unset", mon.getBadgeCount() === 0);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
