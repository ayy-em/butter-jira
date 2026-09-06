#!/usr/bin/env node
// Unit checks for the Kanban board's pure layer: what a column editor is
// allowed to save, which statuses the app already knows about, and how issues
// fall into columns once it has saved.
//
// The board had no suite and no preview harness, which is why the design review
// kept finding things here. The specific thing this file exists for is the
// silent drop: both column editors used to end with
// `filter(g => g.name.trim() && g.statuses.length)`, so a column you had named
// but not finished was thrown away on save with no message — and the way to
// find out was to notice it missing from the board later.
//
// Usage: node scripts/test-kanban.mjs

let sync = {};
let local = {};
const pick = (store, keys) =>
  keys == null ? { ...store }
    : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
      );
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

const utils = await import(new URL("../js/utils.js", import.meta.url));
const board = await import(new URL("../js/components/board.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const issue = (key, status) => ({ key, fields: { status: { name: status } } });

// ── What the editor may save ───────────────────────────────────────────────
section("validateStatusGroups");
{
  const good = utils.validateStatusGroups([
    { name: "To Do", statuses: ["Backlog", "Selected for Dev"] },
    { name: "Done", statuses: ["Done"] },
  ]);
  check("a complete set is accepted", good.ok);
  check("…and comes back cleaned", JSON.stringify(good.groups) ===
    JSON.stringify([
      { name: "To Do", statuses: ["Backlog", "Selected for Dev"] },
      { name: "Done", statuses: ["Done"] },
    ]));
  check("no problems reported", good.problems.length === 0);
}
{
  // The row somebody added and never filled in. Not work — noise.
  const r = utils.validateStatusGroups([
    { name: "Done", statuses: ["Done"] },
    { name: "", statuses: [] },
  ]);
  check("an untouched row is dropped quietly", r.ok && r.groups.length === 1);
}
{
  const r = utils.validateStatusGroups([
    { name: "Done", statuses: ["Done"] },
    { name: "In Review", statuses: [] },
  ]);
  check("a named column with no statuses is refused", !r.ok);
  check("…and says which one", r.problems[0].message.includes("In Review"), r.problems[0].message);
  check("…and points at the row", r.problems[0].index === 1);
}
{
  const r = utils.validateStatusGroups([{ name: "", statuses: ["QA"] }]);
  check("statuses with no column name are refused", !r.ok);
  check("…naming the statuses, since there is no name to quote",
    r.problems[0].message.includes("QA"), r.problems[0].message);
}
{
  const r = utils.validateStatusGroups([
    { name: "Done", statuses: ["Done"] },
    { name: "done", statuses: ["Closed"] },
  ]);
  check("two columns with the same name are refused, case-insensitively", !r.ok);
  check("…and say so", r.problems[0].message.includes("both called"), r.problems[0].message);
}
{
  // resolveStatusGroup takes the first match, so the second column would
  // silently never see the status.
  const r = utils.validateStatusGroups([
    { name: "In Review", statuses: ["QA"] },
    { name: "Done", statuses: ["qa", "Done"] },
  ]);
  check("a status in two columns is refused", !r.ok);
  check("…and says an issue can only be in one",
    r.problems[0].message.includes("only be in one"), r.problems[0].message);
}
{
  const r = utils.validateStatusGroups([]);
  check("an empty set asks for at least one column", !r.ok && r.problems[0].index === -1);
  check("…with a message that says so", r.problems[0].message.includes("at least one"));
}
{
  const r = utils.validateStatusGroups([{ name: "  Done  ", statuses: ["  Done ", "", "Closed"] }]);
  check("names and statuses are trimmed", r.ok && r.groups[0].name === "Done");
  check("…and blank statuses dropped", JSON.stringify(r.groups[0].statuses) === JSON.stringify(["Done", "Closed"]));
}
{
  const shipped = (await import(new URL("../js/config.js", import.meta.url))).DEFAULT_STATUS_GROUPS;
  check("the defaults this app ships with pass its own validator",
    utils.validateStatusGroups(shipped).ok,
    JSON.stringify(utils.validateStatusGroups(shipped).problems));
}

// ── What the shelf offers ──────────────────────────────────────────────────
section("statusesInIssues");
{
  const found = utils.statusesInIssues([
    issue("A-1", "In Progress"),
    issue("A-2", "Backlog"),
    issue("A-3", "In Progress"),
    { key: "A-4", fields: {} },
  ]);
  check("one entry per distinct status", found.length === 2, JSON.stringify(found));
  check("sorted by name", found[0].name === "Backlog");
  check("counted", found.find((s) => s.name === "In Progress").count === 2);
  check("an issue with no status is skipped", !found.some((s) => !s.name));
  check("nothing in, nothing out", utils.statusesInIssues([]).length === 0);
  check("undefined is not a crash", utils.statusesInIssues(undefined).length === 0);
}
{
  // Jira's own casing is what gets shown, and the first spelling wins — the
  // alternative is a shelf with "In Progress" and "in progress" side by side.
  const found = utils.statusesInIssues([issue("A-1", "In Progress"), issue("A-2", "IN PROGRESS")]);
  check("case variants are one status", found.length === 1 && found[0].count === 2);
  check("…keeping the first spelling seen", found[0].name === "In Progress");
}

// ── And what the board then does with it ───────────────────────────────────
section("groupIssues");
{
  const groups = [
    { name: "To Do", statuses: ["Backlog", "Selected for Dev"] },
    { name: "Done", statuses: ["Done"] },
  ];
  const columns = board.groupIssues(
    [issue("A-1", "Backlog"), issue("A-2", "Done"), issue("A-3", "Blocked")],
    groups
  );
  check("configured columns come first, in order",
    columns[0].name === "To Do" && columns[1].name === "Done");
  // The forgiving behaviour, and the reason the editor says "each of which
  // becomes a column of its own" rather than "these issues will disappear".
  check("a status in no column gets a column of its own",
    columns[2]?.name === "Blocked" && columns[2].issues.length === 1,
    columns.map((c) => c.name).join(", "));
  check("matching is case-insensitive",
    board.groupIssues([issue("A-1", "backlog")], groups)[0].issues.length === 1);
}
{
  const groups = [{ name: "To Do", statuses: ["Backlog"] }, { name: "Done", statuses: ["Done"] }];
  const columns = board.groupIssues([issue("A-1", "Done")], groups, ["Done", "To Do"]);
  check("a saved column order is honoured", columns[0].name === "Done");
  check("a column dropped from the order still appears",
    board.groupIssues([], groups, ["Done"]).map((c) => c.name).join() === "Done,To Do");
}

// ── The keyboard path ──────────────────────────────────────────────────────
section("nextCardPosition");
{
  // Three columns: 3 cards, 0 cards, 2 cards. The empty one in the middle is
  // the case worth having — it is what a board looks like halfway through a
  // sprint, and stopping in it would read as the key having failed.
  const lengths = [3, 0, 2];
  const at = (col, row, key) => board.nextCardPosition(lengths, col, row, key);
  const same = (got, col, row) => got && got.col === col && got.row === row;

  check("down moves down the column", same(at(0, 0, "ArrowDown"), 0, 1));
  check("up moves back", same(at(0, 1, "ArrowUp"), 0, 0));
  check("up at the top does nothing", at(0, 0, "ArrowUp") === null);
  check("down at the bottom does nothing", at(0, 2, "ArrowDown") === null);
  check("right steps over the empty column", same(at(0, 0, "ArrowRight"), 2, 0));
  check("left steps back over it", same(at(2, 0, "ArrowLeft"), 0, 0));
  check("right off the end does nothing", at(2, 0, "ArrowRight") === null);
  check("left off the start does nothing", at(0, 0, "ArrowLeft") === null);
  check("crossing to a shorter column clamps to its last card",
    same(at(0, 2, "ArrowRight"), 2, 1));
  check("Home is the first card in this column", same(at(2, 1, "Home"), 2, 0));
  check("End is the last", same(at(0, 0, "End"), 0, 2));
  check("Home in an empty column does nothing", at(1, 0, "Home") === null);
  check("a key the board does not use is left alone", at(0, 0, "PageDown") === null);
  check("Enter is not this function's business", at(0, 0, "Enter") === null);
}
{
  const only = [1];
  check("a single card is its own Home and End",
    board.nextCardPosition(only, 0, 0, "Home").row === 0 &&
    board.nextCardPosition(only, 0, 0, "End").row === 0);
  check("…and has nowhere to arrow to",
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
      .every((k) => board.nextCardPosition(only, 0, 0, k) === null));
}

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
