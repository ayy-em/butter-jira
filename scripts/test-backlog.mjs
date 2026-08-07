#!/usr/bin/env node
// Unit checks for the Backlog view logic: grouping, sorting, pagination,
// column visibility, saved views, status tones and relative time.
//
// The arithmetic is where this view goes wrong quietly — you land on page 9,
// a filter cuts the list to 12 issues, and the table is empty with no
// explanation. All of that is injected-clock, injected-data, no browser.
//
// Usage: node scripts/test-backlog.mjs

let sync = {};
let local = {};
const pick = (store, keys) =>
  keys == null ? { ...store }
    : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
      );
// Resolved through a getter, not captured: the tests below reassign `local` to
// wipe it, and a captured reference would keep pointing at the old object.
const area = (read) => ({
  get: async (k) => pick(read(), k),
  set: async (o) => { Object.assign(read(), o); },
  remove: async (k) => { for (const x of [].concat(k)) delete read()[x]; },
});
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: { sync: area(() => sync), local: area(() => local) },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });
globalThis.document = { addEventListener: () => {}, querySelectorAll: () => [] };

const bl = await import(new URL("../js/backlog.js", import.meta.url));
const cfg = await import(new URL("../js/config.js", import.meta.url));
const utils = await import(new URL("../js/utils.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

sync.boards = [
  { id: 1, name: "ABC", projectKey: "ABC", color: "#4F8EF7" },
  { id: 2, name: "DEF", projectKey: "DEF", color: "#F7914F" },
];
sync.statusGroups = [
  { name: "To Do", statuses: ["To Do", "Backlog"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "In Review", statuses: ["In Review"] },
  { name: "On Hold", statuses: ["On Hold"] },
];
sync.fields = { storyPoints: ["cf_sp"] };
await cfg.loadConfig();
await utils.loadBoards();

const issue = (key, o = {}) => ({
  id: key,
  key,
  boardId: o.boardId ?? 1,
  boardName: o.boardName ?? "ABC",
  fields: {
    summary: o.summary ?? `Summary ${key}`,
    status: o.status ? { name: o.status, statusCategory: { key: o.category || "indeterminate" } } : undefined,
    issuetype: { name: o.type ?? "Story" },
    assignee: o.assignee === null ? null : (o.assignee ?? { accountId: "a1", displayName: "Alex Rivera" }),
    duedate: o.due ?? null,
    updated: o.updated ?? "2026-08-01T00:00:00Z",
    created: o.created ?? "2026-07-01T00:00:00Z",
    cf_sp: o.sp,
  },
});

section("density");
check("three modes", bl.DENSITIES.length === 3);
check("default is compact", bl.DEFAULT_DENSITY === "compact");
check("known mode accepted", bl.isDensity("cozy") === true);
check("unknown mode rejected", bl.isDensity("enormous") === false);

section("columns");
const defaults = bl.defaultColumns();
check("key and summary present by default", defaults.includes("key") && defaults.includes("summary"));
check("board off by default — the accent bar carries it", !defaults.includes("board"));
check("PR column not offered — the correlation does not exist yet",
  !bl.COLUMNS.some((c) => c.id === "pr"));
check("hiding a required column is refused",
  bl.toggleColumn(defaults, "summary").includes("summary"));
check("hiding an optional column works",
  !bl.toggleColumn(defaults, "due").includes("due"));
check("toggling twice restores it",
  bl.toggleColumn(bl.toggleColumn(defaults, "due"), "due").includes("due"));
check("re-enabling restores declaration order, not append order", (() => {
  const without = bl.toggleColumn(defaults, "type");
  const back = bl.toggleColumn(without, "type");
  return back.indexOf("type") < back.indexOf("epic");
})());
check("unknown stored ids dropped", !bl.normalizeColumns(["key", "summary", "bogus"]).includes("bogus"));
check("required columns re-added to a mangled list",
  bl.normalizeColumns(["due"]).includes("key") && bl.normalizeColumns(["due"]).includes("summary"));
check("garbage falls back to defaults", bl.normalizeColumns("nope").length === defaults.length);
check("a column added in a later version appears for existing users",
  bl.normalizeColumns(["select", "key", "summary"]).length === 3);

section("grouping");
const mixed = [
  issue("ABC-1", { status: "To Do" }),
  issue("ABC-2", { status: "In Progress", assignee: null }),
  issue("DEF-3", { status: "To Do", boardId: 2, boardName: "DEF" }),
];
check("none returns one bucket", bl.groupIssues(mixed, "none").length === 1);
check("the single bucket holds everything", bl.groupIssues(mixed, "none")[0].issues.length === 3);
check("an unknown grouping degrades to none", bl.groupIssues(mixed, "nonsense").length === 1);
const byBoard = bl.groupIssues(mixed, "board");
check("board grouping splits", byBoard.length === 2);
check("board labels resolved from config", byBoard.some((g) => g.label === "DEF"));
const byAssignee = bl.groupIssues(mixed, "assignee");
check("unassigned gets its own group", byAssignee.some((g) => g.label === "Unassigned"));
check("unassigned sorts last", byAssignee[byAssignee.length - 1].label === "Unassigned");
check("status grouping works", bl.groupIssues(mixed, "status").length === 2);
check("no issue is lost in grouping",
  bl.groupIssues(mixed, "status").reduce((n, g) => n + g.issues.length, 0) === 3);
const byEpic = bl.groupIssues(mixed, "epic", { epicLabel: (i) => (i.key === "ABC-1" ? "Checkout" : "") });
check("epicless issues collect under one group", byEpic.find((g) => g.label === "No epic").issues.length === 2);
check("groups are alphabetical", (() => {
  const labels = bl.groupIssues(
    [issue("A-1", { boardId: 2, boardName: "DEF" }), issue("A-2", { boardId: 1 })], "board"
  ).map((g) => g.label);
  return labels[0] === "ABC";
})());

section("sorting");
const forSort = [
  issue("ABC-2", { sp: 8, due: "2026-09-01", updated: "2026-08-05T00:00:00Z", status: "Done", category: "done" }),
  issue("ABC-1", { sp: 1, due: null, updated: "2026-08-07T00:00:00Z", status: "In Review" }),
  issue("ABC-3", { sp: 3, due: "2026-08-20", updated: "2026-08-01T00:00:00Z", status: "In Progress" }),
];
const keysOf = (list) => list.map((i) => i.key).join(",");
check("by key ascending", keysOf(bl.sortIssues(forSort, "key", "asc")) === "ABC-1,ABC-2,ABC-3");
check("by key descending", keysOf(bl.sortIssues(forSort, "key", "desc")) === "ABC-3,ABC-2,ABC-1");
check("by story points", keysOf(bl.sortIssues(forSort, "sp", "asc")) === "ABC-1,ABC-3,ABC-2");
check("by last updated, newest first", keysOf(bl.sortIssues(forSort, "updated", "desc")) === "ABC-1,ABC-2,ABC-3");
check("undated sorts last ascending", bl.sortIssues(forSort, "due", "asc")[2].key === "ABC-1");
check("undated STILL sorts last descending — no date is not a date",
  bl.sortIssues(forSort, "due", "desc")[2].key === "ABC-1");
check("status uses workflow order, not the alphabet",
  bl.sortIssues(forSort, "status", "asc")[0].key === "ABC-1");
check("done sinks to the bottom", bl.sortIssues(forSort, "status", "asc")[2].key === "ABC-2");
check("sorting does not mutate the input", keysOf(forSort) === "ABC-2,ABC-1,ABC-3");
check("unknown column leaves order alone", keysOf(bl.sortIssues(forSort, "bogus", "asc")) === "ABC-2,ABC-1,ABC-3");
check("empty list tolerated", bl.sortIssues([], "key", "asc").length === 0);

section("pagination");
const many = Array.from({ length: 277 }, (_, i) => issue(`ABC-${i + 1}`));
let page = bl.paginate(many, 1, 25);
check("first page slice", page.slice.length === 25);
check("range reads 1–25", page.from === 1 && page.to === 25);
check("total pages", page.totalPages === 12);
page = bl.paginate(many, 12, 25);
check("last page is partial", page.slice.length === 2);
check("last range", page.from === 276 && page.to === 277);
check("page beyond the end clamps, never blank", bl.paginate(many, 99, 25).page === 12);
check("page zero clamps up", bl.paginate(many, 0, 25).page === 1);
check("negative page clamps up", bl.paginate(many, -5, 25).page === 1);
check("a filter shrinking the list drags you back to a real page",
  bl.paginate(many.slice(0, 10), 9, 25).page === 1);
check("empty list is one page, not zero", bl.paginate([], 1, 25).totalPages === 1);
check("empty list reads 0 of 0", bl.paginate([], 1, 25).from === 0);
check("unknown page size falls back", bl.paginate(many, 1, 37).slice.length === bl.DEFAULT_PAGE_SIZE);

check("window at the start", JSON.stringify(bl.pageWindow(1, 12)) === '[1,2,"…",12]');
check("window in the middle", JSON.stringify(bl.pageWindow(6, 12)) === '[1,"…",5,6,7,"…",12]');
check("window at the end", JSON.stringify(bl.pageWindow(12, 12)) === '[1,"…",11,12]');
check("no ellipsis when it would hide one page",
  !bl.pageWindow(3, 5).includes("…") || bl.pageWindow(3, 5).length === 5);
check("single page", JSON.stringify(bl.pageWindow(1, 1)) === "[1]");
check("window never repeats a page", (() => {
  const w = bl.pageWindow(6, 12).filter((x) => x !== "…");
  return new Set(w).size === w.length;
})());

section("status tones");
check("to do is gray", bl.statusTone({ name: "To Do" }) === "gray");
check("in progress is blue", bl.statusTone({ name: "In Progress" }) === "blue");
check("in review is purple", bl.statusTone({ name: "In Review" }) === "purple");
check("on hold is orange", bl.statusTone({ name: "On Hold" }) === "orange");
check("blocked is red", bl.statusTone({ name: "Blocked" }) === "red");
check("done is green", bl.statusTone({ name: "Done" }) === "green");
check("a renamed done status still reads green via statusCategory",
  bl.statusTone({ name: "Shipped", statusCategory: { key: "done" } }) === "green");
check("an unknown in-flight status is blue via statusCategory",
  bl.statusTone({ name: "Marinating", statusCategory: { key: "indeterminate" } }) === "blue");
check("nothing at all is gray, not undefined", bl.statusTone(undefined) === "gray");
check("every tone produced is one of the six",
  ["To Do", "In Progress", "In Review", "On Hold", "Blocked", "Done", "Whatever"]
    .every((n) => bl.STATUS_TONES.includes(bl.statusTone({ name: n }))));

section("relative time");
const NOW = new Date("2026-08-07T12:00:00Z");
const rel = (iso) => bl.relativeTime(iso, NOW);
check("minutes", rel("2026-08-07T11:30:00Z") === "30m ago");
check("hours", rel("2026-08-07T10:00:00Z") === "2h ago");
check("yesterday is named, not counted", rel("2026-08-06T10:00:00Z") === "Yesterday");
check("days", rel("2026-08-04T12:00:00Z") === "3d ago");
check("months", rel("2026-06-07T12:00:00Z") === "2mo ago");
check("years", rel("2024-08-07T12:00:00Z") === "2y ago");
check("just now", rel("2026-08-07T11:59:50Z") === "just now");
check("a clock-skewed future date does not read as negative", rel("2026-08-09T12:00:00Z") === "just now");
check("missing date is empty, not 'Invalid Date'", rel(null) === "");
check("garbage is empty", rel("not a date") === "");

section("summary tiles");
const tiles = bl.summaryTiles([
  issue("A-1", { status: "To Do" }),
  issue("A-2", { status: "To Do" }),
  issue("A-3", { status: "In Progress" }),
  issue("A-4", { status: "On Hold" }),
  issue("A-5", { status: "Shipped" }),      // outside every configured group
], sync.statusGroups);
check("total is first", tiles[0].label === "Total issues");
check("total counts everything, including ungrouped statuses", tiles[0].count === 5);
check("one tile per configured status group", tiles.length === 5);
check("to do counted", tiles.find((t) => t.label === "To Do").count === 2);
check("on hold counted", tiles.find((t) => t.label === "On Hold").count === 1);
check("a status in no group inflates no tile",
  tiles.slice(1).reduce((n, t) => n + t.count, 0) === 4);
check("tiles follow configured groups, not hardcoded names — this is a whitelabel app",
  JSON.stringify(bl.summaryTiles([], [{ name: "Icebox", statuses: ["Icebox"] }]).map((t) => t.label))
    === '["Total issues","Icebox"]');
check("no status groups still yields a total", bl.summaryTiles([issue("A-1")], []).length === 1);

section("saved views");
let views = [];
views = bl.upsertView(views, { name: "My sprint", groupBy: "assignee", sortCol: "sp", sortDir: "asc" });
check("view stored", views.length === 1);
check("name kept", views[0].name === "My sprint");
check("id slugged", views[0].id === "my-sprint");
check("grouping kept", views[0].groupBy === "assignee");
check("columns normalised into the view", Array.isArray(views[0].columns) && views[0].columns.length > 0);
views = bl.upsertView(views, { name: "My sprint", groupBy: "board" });
check("same name replaces rather than duplicating", views.length === 1 && views[0].groupBy === "board");
check("a nameless view is refused", bl.upsertView(views, { name: "  " }).length === 1);
check("an invalid grouping in a stored view falls back",
  bl.normalizeView({ name: "x", groupBy: "bogus" }).groupBy === "none");
check("an invalid sort in a stored view falls back",
  bl.normalizeView({ name: "x", sortCol: "bogus" }).sortCol === "updated");
views = bl.removeView(views, "my-sprint");
check("removed", views.length === 0);
check("removing something absent is a no-op", bl.removeView(views, "nope").length === 0);
check("the list is capped rather than growing forever", (() => {
  let v = [];
  for (let i = 0; i < 30; i++) v = bl.upsertView(v, { name: `View ${i}` });
  return v.length === 20;
})());

section("preferences persist device-local");
local = {};
await bl.savePrefs({
  density: "cozy", groupBy: "epic", sortCol: "sp", sortDir: "asc",
  columns: ["select", "key", "summary"], perPage: 100, sidebarOpen: false, views: [],
});
check("written to local, not sync", Boolean(local[bl.PREFS_KEY]) && !(bl.PREFS_KEY in sync));
let loaded = await bl.loadPrefs();
check("density round-trips", loaded.density === "cozy");
check("grouping round-trips", loaded.groupBy === "epic");
check("page size round-trips", loaded.perPage === 100);
check("sidebar state round-trips", loaded.sidebarOpen === false);
local = {};
loaded = await bl.loadPrefs();
check("no stored prefs yields defaults", loaded.density === bl.DEFAULT_DENSITY);
check("default sort is last-updated, newest first",
  loaded.sortCol === "updated" && loaded.sortDir === "desc");
local[bl.PREFS_KEY] = { density: "huge", groupBy: "x", perPage: 7, sortCol: "y", views: "nope" };
loaded = await bl.loadPrefs();
check("corrupt stored prefs do not break the view",
  loaded.density === bl.DEFAULT_DENSITY && loaded.groupBy === "none" &&
  loaded.perPage === bl.DEFAULT_PAGE_SIZE && Array.isArray(loaded.views));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
