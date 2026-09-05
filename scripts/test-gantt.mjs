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

import { deliveryState, DUE_SOON_DAYS } from "../js/views/gantt.js";

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

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
