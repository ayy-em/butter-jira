#!/usr/bin/env node
// Unit checks for the roadmap's delivery colouring.
//
// The bars used to be coloured by board, which says who owns an epic and
// nothing about whether it is going to land. `deliveryState` is the derivation
// behind the fill, and it is date arithmetic against "today" — the kind that
// works all year and then goes wrong on a boundary, so the boundaries are what
// is tested here.
//
// Usage: node scripts/test-gantt.mjs

import {
  deliveryState, DUE_SOON_DAYS, rangeDays, modeForRange, columnStart, clipToRange,
  normalizeDisplay, DEFAULT_DISPLAY, isCompleted, issueTitle,
  defaultRange, stickyTitleBox, stickyLabelX, wrapTitle, normalizeFilters, runsPastRange,
  startsBeforeRange, dayMonth,
} from "../js/views/gantt.js";

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

// A fixed "today" so these checks read the same in June as in December.
const TODAY = new Date(2026, 8, 5); // 2026-09-05, local
const day = 86400000;
// Local calendar date, not `toISOString()`. A Jira due date is a calendar day
// written in the site's own terms, and formatting one through UTC shifts it a
// day backwards anywhere east of Greenwich — which is exactly the mistake this
// file exists to catch, so the helper must not make it too.
const iso = (offset) => {
  const d = new Date(TODAY.getTime() + offset * day);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const epic = (due, categoryKey = "indeterminate") => ({
  fields: {
    duedate: due,
    status: { name: "In Progress", statusCategory: { key: categoryKey } },
  },
});
const state = (due, key) => deliveryState(epic(due, key), TODAY);

section("the four states");
check("well ahead of its due date is on track", state(iso(30)) === "on-track");
check("inside the warning window is due soon", state(iso(3)) === "due-soon");
check("past its due date and still open is overdue", state(iso(-1)) === "overdue");
check("finished is done, whatever its dates say", state(iso(-30), "done") === "done");
check("no due date at all is untracked", state(null) === "untracked");
check("an empty due date is untracked, not overdue", state("") === "untracked");

section("boundaries");
check("due today is due soon, not overdue", state(iso(0)) === "due-soon");
check("the last day of the window is still due soon",
  state(iso(DUE_SOON_DAYS)) === "due-soon");
check("one day past the window is on track",
  state(iso(DUE_SOON_DAYS + 1)) === "on-track");
check("yesterday is overdue", state(iso(-1)) === "overdue");

section("done outranks everything");
check("done and overdue reads as done", state(iso(-10), "done") === "done");
check("done and due soon reads as done", state(iso(2), "done") === "done");
check("done with no due date reads as done", state(null, "done") === "done");

section("degrades rather than throws");
check("a missing epic is untracked", deliveryState(undefined, TODAY) === "untracked");
check("an epic with no fields is untracked", deliveryState({}, TODAY) === "untracked");
check("no status block is not treated as done",
  deliveryState({ fields: { duedate: iso(-1) } }, TODAY) === "overdue");

section("time of day does not move the answer");
// A due date is a calendar day. Comparing it against a timestamp would make
// "due today" overdue from one minute past midnight.
const lateToday = new Date(2026, 8, 5, 23, 59, 59);
const earlyToday = new Date(2026, 8, 5, 0, 0, 1);
check("due today reads the same at one past midnight and at midnight minus one",
  deliveryState(epic("2026-09-05"), earlyToday) ===
  deliveryState(epic("2026-09-05"), lateToday));
check("due today is not overdue late in the evening",
  deliveryState(epic("2026-09-05"), lateToday) === "due-soon");

section("zoom follows the chosen range");
// Picking a two-month range used to leave the chart on Month, padded out to a
// year either side: two columns that mattered among a dozen that did not.
check("a range counts both of its ends", rangeDays("2026-03-01", "2026-03-01") === 1);
check("a leap February is 29 days", rangeDays("2028-02-01", "2028-02-29") === 29);
check("a range across the clocks changing is still whole days",
  rangeDays("2026-03-01", "2026-03-31") === 31 && rangeDays("2026-10-01", "2026-10-31") === 31);
check("two weeks reads by the day", modeForRange(14) === "Day");
check("two months reads by the week", modeForRange(rangeDays("2026-09-01", "2026-10-31")) === "Week");
check("a year reads by the month", modeForRange(rangeDays("2026-01-01", "2026-12-31")) === "Month");
check("a leap year is still a year", modeForRange(rangeDays("2028-01-01", "2028-12-31")) === "Month");
check("three years reads by the quarter", modeForRange(3 * 365) === "Quarter Year");

section("a zoomed axis opens on a column boundary");
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join("-");
const thu = new Date(2026, 9, 29, 15, 30); // Thursday 2026-10-29, mid-afternoon
check("Day starts at that day's midnight",
  ymd(columnStart(thu, "Day")) === "2026-10-29" && columnStart(thu, "Day").getHours() === 0);
check("Week starts on the Monday", ymd(columnStart(thu, "Week")) === "2026-10-26");
check("a Sunday belongs to the week before it",
  ymd(columnStart(new Date(2026, 10, 1), "Week")) === "2026-10-26");
check("a Monday is its own week's start",
  ymd(columnStart(new Date(2026, 9, 26), "Week")) === "2026-10-26");
check("Week across a month end", ymd(columnStart(new Date(2026, 6, 2), "Week")) === "2026-6-29");
check("Month starts on the first", ymd(columnStart(thu, "Month")) === "2026-10-1");
check("Quarter starts on its first month", ymd(columnStart(thu, "Quarter Year")) === "2026-10-1");
check("February is in Q1", ymd(columnStart(new Date(2026, 1, 14), "Quarter Year")) === "2026-1-1");
check("June is in Q2", ymd(columnStart(new Date(2026, 5, 30), "Quarter Year")) === "2026-4-1");

section("bars are cut to the range");
const R = ["2026-09-01", "2026-10-31"];
const clip = (s, e) => JSON.stringify(clipToRange(s, e, R));
check("inside the range is untouched",
  clip("2026-09-10", "2026-10-01") === JSON.stringify({ start: "2026-09-10", end: "2026-10-01" }));
check("started before the range starts at its edge",
  clip("2026-01-01", "2026-09-15") === JSON.stringify({ start: "2026-09-01", end: "2026-09-15" }));
check("due after the range ends at its edge",
  clip("2026-10-20", "2027-02-01") === JSON.stringify({ start: "2026-10-20", end: "2026-10-31" }));
check("spanning the whole range fills it",
  clip("2026-01-01", "2027-01-01") === JSON.stringify({ start: "2026-09-01", end: "2026-10-31" }));
check("no range leaves the dates alone",
  JSON.stringify(clipToRange("2026-01-01", "2027-01-01", null)) ===
  JSON.stringify({ start: "2026-01-01", end: "2027-01-01" }));

section("display settings");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check("nothing stored is the defaults", same(normalizeDisplay(undefined), DEFAULT_DISPLAY));
check("the defaults show keys, beside the bars, with completed work",
  same(DEFAULT_DISPLAY, { showKeys: true, titlesInside: false, hideCompleted: false }));
check("a stored setting is kept",
  normalizeDisplay({ hideCompleted: true }).hideCompleted === true &&
  normalizeDisplay({ hideCompleted: true }).showKeys === true);
check("a mistyped field falls back to its default",
  normalizeDisplay({ showKeys: "no", titlesInside: 1 }).showKeys === true &&
  normalizeDisplay({ showKeys: "no", titlesInside: 1 }).titlesInside === false);
check("unknown fields are dropped", !("extra" in normalizeDisplay({ extra: true })));
check("a stored string is not a settings object", same(normalizeDisplay("inside"), DEFAULT_DISPLAY));

section("completed and titles");
const st = (name, key) => ({ fields: { status: { name, statusCategory: { key } } } });
check("done by category is completed, whatever it is called", isCompleted(st("Released", "done")));
check("in progress is not completed", !isCompleted(st("In Progress", "indeterminate")));
check("a bare Done with no category is completed", isCompleted({ fields: { status: { name: "Done" } } }));
check("no status is not completed", !isCompleted({ fields: {} }) && !isCompleted(undefined));
check("a title leads with its key", issueTitle("DP-1", "Importer") === "DP-1 — Importer");
check("without keys it is the summary alone", issueTitle("DP-1", "Importer", false) === "Importer");
check("without keys and without a summary the key stands in", issueTitle("DP-1", "", false) === "DP-1");

section("the default timeframe");
// From last week's Monday to the Friday four weeks after this one.
const dr = (y, m, d) => defaultRange(new Date(y, m - 1, d, 15, 0)).join(" → ");
check("on a Thursday", dr(2026, 10, 29) === "2026-10-19 → 2026-11-27");
check("on a Monday, last week is the seven days before",
  dr(2026, 10, 26) === "2026-10-19 → 2026-11-27");
check("on a Sunday, it is still the week that Sunday ends",
  dr(2026, 11, 1) === "2026-10-19 → 2026-11-27");
check("across a year end", dr(2026, 12, 30) === "2026-12-21 → 2027-01-29");
check("about six weeks, so it opens by the week",
  modeForRange(rangeDays(...defaultRange(new Date(2026, 9, 29)))) === "Week");

section("titles stay on screen");
// A bar from 100 to 900 on the chart; the screen shows 0–500 unless moved.
const box = (vs, ve) => stickyTitleBox(100, 900, vs, ve, { lead: 6, pad: 6, min: 72 });
check("bar fully on screen: title at its own start",
  box(0, 1000).x === 106 && box(0, 1000).width === 788);
check("bar's start scrolled off: title at the screen's left edge", box(300, 800).x === 306);
check("no wider than the part on screen", box(300, 800).width === 488);
check("near the bar's end it stops, at its minimum width",
  box(880, 1400).x === 822 && box(880, 1400).width === 72);
check("bar off screen to the right: title at its start", box(-500, 0).x === 106);
check("too narrow for a title at all", stickyTitleBox(100, 160, 0, 500) === null);

const lx = (vs, ve) => stickyLabelX(100, 900, vs, ve, 200);
check("label centred on the bar when it is all on screen", lx(0, 1000) === 500);
check("label centred on the part on screen", lx(300, 800) === 550);
check("label never past the bar's start", lx(-400, 150) === 204);
check("label never past the bar's end", lx(850, 1400) === 796);
check("a label wider than its bar belongs beside it", stickyLabelX(100, 150, 0, 500, 200) === null);
check("room is kept for a caret inside the bar",
  stickyLabelX(0, 300, -100, 150, 200, { lead: 20 }) === 120);
check("a label that fits the bar but not the bar and its caret goes beside it",
  stickyLabelX(0, 210, 0, 500, 200, { lead: 20 }) === null &&
  stickyLabelX(0, 210, 0, 500, 200) === 105);

section("export titles wrap like the live ones");
// One unit per character, so widths are easy to reason about.
const m = (t) => t.length;
const wrap = (t, w, n) => JSON.stringify(wrapTitle(t, w, m, n));
check("short enough stays one line", wrap("DP-1 — Importer", 20, 3) === JSON.stringify(["DP-1 — Importer"]));
check("wraps at spaces", wrap("aaa bbb ccc", 7, 3) === JSON.stringify(["aaa bbb", "ccc"]));
check("three lines at most, the last cut with an ellipsis",
  wrap("aaa bbb ccc ddd eee fff ggg", 7, 3) === JSON.stringify(["aaa bbb", "ccc ddd", "eee ff…"]));
check("exactly three full lines has no ellipsis",
  wrap("aaa bbb ccc", 3, 3) === JSON.stringify(["aaa", "bbb", "ccc"]));
check("a word longer than a line is broken", wrap("abcdefghij", 4, 3) === JSON.stringify(["abcd", "efgh", "ij"]));
check("a word too long for all three lines ends in an ellipsis",
  wrap("abcdefghijklmnop", 4, 3) === JSON.stringify(["abcd", "efgh", "ijk…"]));
check("every line fits", wrapTitle("Warehouse migration: move the reporting marts off the legacy cluster", 18, m)
  .every((l) => l.length <= 18));
check("empty text is no lines", wrap("", 10, 3) === "[]");

section("saved filters come back valid");
const nf = normalizeFilters;
check("nothing saved is the default timeframe, nothing hidden",
  nf(undefined).tfType === "default" && nf(undefined).mode === null &&
  nf(undefined).hiddenEpics.length === 0);
check("a saved custom range comes back", (() => {
  const f = nf({ tfType: "custom", tfStart: "2026-10-22", tfEnd: "2026-12-11" });
  return f.tfType === "custom" && f.tfStart === "2026-10-22" && f.tfEnd === "2026-12-11";
})());
check("a custom range saved backwards comes back forwards",
  nf({ tfType: "custom", tfStart: "2026-12-11", tfEnd: "2026-10-22" }).tfStart === "2026-10-22");
check("a custom range missing a date is the default timeframe",
  nf({ tfType: "custom", tfStart: "2026-10-22" }).tfType === "default");
check("a malformed date is not a date",
  nf({ tfType: "custom", tfStart: "22/10/2026", tfEnd: "2026-12-11" }).tfType === "default");
check("an unknown timeframe is the default", nf({ tfType: "fortnight" }).tfType === "default");
check("dates are dropped for a preset timeframe",
  nf({ tfType: "year", tfStart: "2026-01-01", tfEnd: "2026-02-01" }).tfStart === null);
check("a saved zoom comes back", nf({ mode: "Quarter Year" }).mode === "Quarter Year");
check("an unknown zoom is none", nf({ mode: "Fortnight" }).mode === null);
check("hidden lists keep strings and board ids, drop the rest",
  JSON.stringify(nf({ hiddenBoards: [1, "2", null, {}], hiddenStatuses: "Done" }).hiddenBoards) === '[1,"2"]' &&
  nf({ hiddenStatuses: "Done" }).hiddenStatuses.length === 0);

section("bars that run past the view");
const R2 = ["2026-10-19", "2026-11-27"];
check("due after the last day shown runs past", runsPastRange({ _to: "2026-12-15" }, R2));
check("due on the last day shown does not", !runsPastRange({ _to: "2026-11-27" }, R2));
check("due inside the view does not", !runsPastRange({ _to: "2026-11-01" }, R2));
check("all time has no edge to run past", !runsPastRange({ _to: "2030-01-01" }, null));
check("no due date does not", !runsPastRange({}, R2));
check("started before the first day shown starts before", startsBeforeRange({ _from: "2026-10-01" }, R2));
check("started on the first day shown does not", !startsBeforeRange({ _from: "2026-10-19" }, R2));
check("all time has no edge to start before", !startsBeforeRange({ _from: "2020-01-01" }, null));
check("the date under a mark is DD.MM", dayMonth("2026-12-15") === "15.12" && dayMonth("2026-01-05") === "05.01");
check("no date, no label", dayMonth(null) === "" && dayMonth("15/12") === "");

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
