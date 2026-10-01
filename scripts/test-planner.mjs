#!/usr/bin/env node
// Unit checks for the sprint planner (M15): working days and the Jira sprint
// date rule, capacity and the buffer, the draft's shape and its commit rule
// (nothing unassigned, nothing unestimated), candidate ordering, epic remaining
// work, the push plan worked out against a re-read Jira, and the push itself —
// batches broken up on failure, each failure retried three times, a dead token
// stopping everything. The transport is a stub; nothing touches a network.
//
// Usage: node scripts/test-planner.mjs

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
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { saveConfig } = await import(new URL("../js/config.js", import.meta.url));
await saveConfig({ site: { baseUrl: "https://example.atlassian.net" }, fields: { storyPoints: ["sp"] } });
const P = await import(new URL("../js/planner.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const issue = (key, { status = "To Do", cat = "new", assignee = null, sp = null, type = "Story", due = null, epic = null, labels = [], priority = "Medium", boardId = 1 } = {}) => ({
  key,
  boardId,
  boardIds: [boardId],
  fields: {
    summary: `Work ${key}`,
    status: { name: status, statusCategory: { key: cat } },
    assignee: assignee ? { accountId: assignee, displayName: assignee } : null,
    issuetype: { name: type, subtask: type === "Sub-task", id: "10001" },
    priority: { name: priority },
    labels,
    duedate: due,
    parent: epic ? { key: epic, fields: { issuetype: { name: "Epic" } } } : null,
    ...(sp === null ? {} : { sp }),
  },
});

// ── Numbers ────────────────────────────────────────────────────────────────
section("Points");
check("quarters survive", P.parsePoints("0.25") === 0.25 && P.parsePoints("1,5") === 1.5);
check("junk and negatives are not points", P.parsePoints("x") === null && P.parsePoints("-1") === null && P.parsePoints("") === null);
check("no float noise", P.fmtPoints(0.1 + 0.2) === "0.3" && P.fmtPoints(8) === "8" && P.fmtPoints(null) === "–");

// ── Working days ───────────────────────────────────────────────────────────
section("Working days");
check("two weeks Monday to Friday is ten", P.workingDaysBetween("2026-10-05", "2026-10-16") === 10);
check("weekends at both ends are not counted", P.workingDaysBetween("2026-10-03", "2026-10-18") === 10);
check("one day", P.workingDaysBetween("2026-10-05", "2026-10-05") === 1);
check("backwards or blank is zero", P.workingDaysBetween("2026-10-16", "2026-10-05") === 0 && P.workingDaysBetween("", "2026-10-05") === 0);

// Built from local times, so the rule is tested in whatever timezone this runs.
const at = (y, m, d, h) => new Date(y, m - 1, d, h).toISOString();
const monToMon = P.sprintDateRange({ startDate: at(2026, 10, 5, 10), endDate: at(2026, 10, 19, 10) });
check("Jira's Monday-to-Monday sprint drops its last day", monToMon?.end === "2026-10-18" && P.workingDaysBetween(monToMon.start, monToMon.end) === 10);
const monToFri = P.sprintDateRange({ startDate: at(2026, 10, 5, 9), endDate: at(2026, 10, 16, 17) });
check("a sprint ending Friday counts as written", monToFri?.start === "2026-10-05" && monToFri.end === "2026-10-16");
check("undated sprint has no range", P.sprintDateRange({ name: "x" }) === null);
const def = P.defaultDateRange(new Date(2026, 8, 30)); // a Wednesday
check("default range starts the coming Monday and is ten days", def.start === "2026-10-05" && P.workingDaysBetween(def.start, def.end) === 10);

section("Dutch public holidays");
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
check("Easter Sunday for known years", iso(P.easterSunday(2026)) === "2026-04-05" && iso(P.easterSunday(2025)) === "2025-04-20" && iso(P.easterSunday(2024)) === "2024-03-31");
const nl26 = Object.fromEntries(P.dutchHolidays(2026).map((h) => [h.name, h]));
check("Easter-based days follow Easter", nl26["Easter Monday"].date === "2026-04-06" && nl26["Ascension Day"].date === "2026-05-14" && nl26["Whit Monday"].date === "2026-05-25");
check("King's Day moves to the 26th when the 27th is a Sunday", P.dutchHolidays(2025).find((h) => h.name === "King's Day").date === "2025-04-26" && nl26["King's Day"].date === "2026-04-27");
check("Liberation Day is a day off only in lustrum years", nl26["Liberation Day"].dayOff === false && P.dutchHolidays(2030).find((h) => h.name === "Liberation Day").dayOff === true);
check("Good Friday is listed but not taken off", nl26["Good Friday"].dayOff === false);
const december = P.holidaysBetween("2025-12-22", "2026-01-09");
check("a range across New Year finds Christmas, Boxing Day and New Year's Day", december.map((h) => h.name).join() === "Christmas Day,Boxing Day,New Year's Day");
check("weekend holidays are left out", P.holidaysBetween("2027-12-20", "2027-12-31").length === 0); // 25th and 26th fall on a weekend in 2027
const xmas = P.normalizeDraft({ start: "2025-12-22", end: "2026-01-02" });
check("suggested working days take holidays off", P.workingDaysBetween(xmas.start, xmas.end) === 10 && P.suggestedWorkingDays(xmas) === 7);
xmas.holidays["2025-12-26"] = false;
check("an unticked holiday is worked", P.suggestedWorkingDays(xmas) === 8);
check("no calendar, no holidays", P.suggestedWorkingDays(xmas, { calendar: "none" }) === 10);
check("holiday choices survive the draft's round trip", P.normalizeDraft({ holidays: { "2026-12-26": false, junk: true, "2026-12-25": "yes" } }).holidays["2026-12-26"] === false &&
  Object.keys(P.normalizeDraft({ holidays: { junk: true, "2026-12-25": "yes" } }).holidays).length === 0);
check("team capacity uses the calendar", P.teamCapacity({ ...xmas, people: [{ accountId: "a", days: null, buffer: null }], buffer: { mode: "percent", value: 0 } }, { calendar: "nl" }).available === 8);

// ── Capacity ───────────────────────────────────────────────────────────────
section("Capacity");
const pct = P.personCapacity({ workingDays: 10, buffer: { mode: "percent", value: 20 } });
check("10 days with a 20% buffer is 8 points", pct.available === 8 && pct.buffer === 2 && pct.base === 10);
const abs = P.personCapacity({ workingDays: 10, buffer: { mode: "points", value: 1.5 } });
check("an absolute buffer comes off each person", abs.available === 8.5);
const pto = P.personCapacity({ workingDays: 10, days: 7, buffer: { mode: "percent", value: 20 } });
check("leave lowers days and the percent buffer follows", pto.available === 5.6);
const override = P.personCapacity({ workingDays: 10, buffer: { mode: "percent", value: 20 }, bufferOverride: 0 });
check("a per-person buffer override wins, including zero", override.available === 10);
check("the buffer never makes capacity negative", P.personCapacity({ workingDays: 1, buffer: { mode: "points", value: 5 } }).available === 0);
check("bands at 100% and 120%", P.loadBand(8, 8).band === "ok" && P.loadBand(9, 8).band === "full" && P.loadBand(10, 8).band === "over");
check("no capacity and nothing planned is none, not a division", P.loadBand(0, 0).band === "none" && P.loadBand(1, 0).band === "over");

section("Points per day");
check("8 hours per point is one point a day", P.pointsPerDayFor(8) === 1 && P.pointsPerDayFor(4) === 2);
check("nonsense falls back to one a day", P.pointsPerDayFor(0) === 1 && P.pointsPerDayFor("x") === 1 && P.pointsPerDayFor(-2) === 1);
const half = P.personCapacity({ workingDays: 10, buffer: { mode: "percent", value: 20 }, pointsPerDay: 2 });
check("half-day points double capacity, and the % buffer scales with it", half.base === 20 && half.available === 16 && half.days === 10);
const halfAbs = P.personCapacity({ workingDays: 10, buffer: { mode: "points", value: 3 }, pointsPerDay: 2 });
check("a # buffer stays points", halfAbs.available === 17);

// ── Draft ──────────────────────────────────────────────────────────────────
section("Draft shape");
const junk = P.normalizeDraft({
  stage: "plan",
  boards: [{ id: 1, target: 55, sources: [44, 44, ""] }, { id: 1, target: 9 }, { id: "" }],
  buffer: { mode: "bogus", value: "20" },
  people: [{ accountId: "a", days: "7" }, { accountId: "a" }, { accountId: "" }],
  added: { "ACME-1": 55, "not a key": 1 },
  removed: ["ACME-2", "ACME-2", "nope"],
  edits: { "ACME-3": { points: "2", assignee: "" }, "ACME-4": {} },
  workingDays: "x",
});
check("ids become strings, duplicates go", junk.boards.length === 1 && junk.boards[0].target === "55" && junk.boards[0].sources.join() === "44");
check("unknown buffer mode falls back to percent", junk.buffer.mode === "percent" && junk.buffer.value === 20);
check("people deduplicated, days parsed", junk.people.length === 1 && junk.people[0].days === 7 && junk.people[0].buffer === null);
check("only issue keys survive", Object.keys(junk.added).join() === "ACME-1" && junk.removed.join() === "ACME-2");
check("an empty edit is dropped; a cleared assignee is null", !junk.edits["ACME-4"] && junk.edits["ACME-3"].assignee === null && junk.edits["ACME-3"].points === 2);
check("a bad working-days override is no override", junk.workingDays === null && junk.stage === "plan");
check("a new draft holds back 20%", P.emptyDraft().buffer.mode === "percent" && P.emptyDraft().buffer.value === 20);
check("a stored draft keeps its own buffer, zero included", P.normalizeDraft({ buffer: { mode: "points", value: 0 } }).buffer.value === 0);
check("garbage in is an empty draft out", P.normalizeDraft("x").stage === "config" && P.normalizeDraft(null).boards.length === 0);

await P.saveDraft({ ...P.emptyDraft(), stage: "plan", people: [{ accountId: "z" }] });
const loaded = await P.loadDraft();
check("the draft round-trips through device storage", loaded.stage === "plan" && loaded.people[0].accountId === "z" && Boolean(local[P.PLANNER_KEY]));
check("and never touches synced storage", !(P.PLANNER_KEY in sync));
await P.clearDraft();
check("discarding removes it", !(P.PLANNER_KEY in local));

// ── The commit rule ────────────────────────────────────────────────────────
section("Nothing unassigned, nothing unestimated");
const draft = P.normalizeDraft({ boards: [{ id: "1", target: "55" }, { id: "2", target: "66" }], people: [{ accountId: "amy" }, { accountId: "bo" }] });
const bare = issue("ACME-10");
check("an unassigned, unestimated issue lacks both", P.missingForCommit(draft, bare).join() === "assignee,points");
check("zero points is not an estimate", P.missingForCommit(draft, issue("ACME-11", { assignee: "amy", sp: 0 })).join() === "points");
P.setEdit(draft, bare, { assignee: "amy", points: 0.5 });
check("edits count toward the rule", P.canCommit(draft, bare));
check("the baseline records Jira's values at the first edit", draft.baseline["ACME-10"].assignee === null && draft.baseline["ACME-10"].points === null);
const owned = issue("ACME-12", { assignee: "amy", sp: 3 });
P.setEdit(draft, owned, { points: 5 });
P.setEdit(draft, owned, { points: 3 });
check("an edit back to Jira's own value is no edit", !draft.edits["ACME-12"] && !draft.baseline["ACME-12"]);

const inTarget = new Set(["ACME-20"]);
P.addToPlan(draft, bare, inTarget);
check("an issue joins its own board's target", draft.added["ACME-10"] === "55");
check("an issue from an unplanned board joins the first target", P.targetFor(draft, issue("OTHER-1", { boardId: 9 })) === "55");
check("an issue on the second board joins that board's target", P.targetFor(draft, issue("PLAT-1", { boardId: 2 })) === "66");
const crossed = { ...issue("MDS-4", { boardId: 7 }), planBoardId: "2" };
check("a cross-board leftover joins the target of the board it was picked under", P.targetFor(draft, crossed) === "66");
check("a source ref is a bare id on its own board, board:sprint on another", P.sourceRef(2, 41, "2") === "41" && P.sourceRef(7, 90, "2") === "7:90");
check("source refs parse back", JSON.stringify(P.parseSourceRef("7:90", "2")) === '{"boardId":"7","sprintId":"90"}' && JSON.stringify(P.parseSourceRef("41", "2")) === '{"boardId":"2","sprintId":"41"}');
const already = issue("ACME-20", { assignee: "bo", sp: 2 });
P.addToPlan(draft, already, inTarget);
check("adding what is already in the target is not a move", !draft.added["ACME-20"]);
P.removeFromPlan(draft, already, inTarget);
check("taking out an issue already in the target queues a move out", draft.removed.includes("ACME-20") && !P.isPlanned(draft, already, inTarget));
P.addToPlan(draft, already, inTarget);
check("putting it back cancels that", !draft.removed.includes("ACME-20") && P.isPlanned(draft, already, inTarget));
P.removeFromPlan(draft, bare, inTarget);
check("taking out something only the draft added just forgets it", !draft.added["ACME-10"] && !draft.removed.includes("ACME-10"));

// ── Candidates ─────────────────────────────────────────────────────────────
section("Candidates");
const pool = [
  issue("A-1", { status: "To Do", cat: "new" }),
  issue("A-2", { status: "On Hold", cat: "indeterminate" }),
  issue("A-3", { status: "In Review", cat: "indeterminate" }),
  issue("A-4", { status: "Done", cat: "done" }),
  issue("A-5", { status: "In Progress", cat: "indeterminate" }),
  issue("A-6", { type: "Epic" }),
  issue("A-7", { type: "Sub-task" }),
  issue("A-8", { status: "Blocked", cat: "indeterminate" }),
  issue("A-9", { status: "Rejected", cat: "done" }),
];
const sorted = P.sortCandidates(pool.filter(P.isPlannable)).map((i) => i.key).join();
check("under way first, then to do, then on hold; board order within each", sorted === "A-3,A-5,A-1,A-2,A-8", sorted);
check("done, rejected, epics and sub-tasks are not candidates", !sorted.includes("A-4") && !sorted.includes("A-9") && !sorted.includes("A-6") && !sorted.includes("A-7"));
const split = P.splitCandidates({
  carryover: [pool[0], pool[2]],
  backlog: [pool[0], pool[4], issue("A-10")],
  extra: [issue("X-1")],
  isInPlan: (i) => i.key === "A-10",
});
check("leftovers are carryover and never also backlog", split.carryover.map((i) => i.key).join() === "A-3,A-1" && !split.backlog.some((i) => i.key === "A-1"));
check("issues added by key lead the backlog; planned ones are not offered", split.backlog.map((i) => i.key).join() === "X-1,A-5");

const tagged = [
  issue("E-1", { epic: "EP-1", sp: 3, labels: ["api"], priority: "High" }),
  issue("E-2", { epic: "EP-1" }),
  issue("E-3", { epic: "EP-2", sp: 5 }),
  issue("E-4", { epic: "EP-1", sp: 8, status: "Done", cat: "done" }),
  issue("E-5", {}),
];
const rem = P.epicRemaining(tagged);
check("each epic's open work, done excluded", rem.get("EP-1").open === 2 && rem.get("EP-1").points === 3 && rem.get("EP-1").unestimated === 1 && rem.get("EP-2").points === 5);
check("filter by epic, label, priority, text, and no epic", P.filterCandidates(tagged, { epic: "EP-1" }).length === 3 &&
  P.filterCandidates(tagged, { label: "api" }).length === 1 &&
  P.filterCandidates(tagged, { priority: "High" }).length === 1 &&
  P.filterCandidates(tagged, { text: "e-3" }).length === 1 &&
  P.filterCandidates(tagged, { epic: "__none__" }).map((i) => i.key).join() === "E-5");
const opts = P.filterOptions(tagged);
check("filter menus list what is on screen", opts.epics.join() === "EP-1,EP-2" && opts.labels.join() === "api");

check("issue refs: key, lowercase, browse link, board link", P.parseIssueRef("ACME-12") === "ACME-12" && P.parseIssueRef(" acme-12 ") === "ACME-12" &&
  P.parseIssueRef("https://x.atlassian.net/browse/PLAT-9?focused=1") === "PLAT-9" &&
  P.parseIssueRef("https://x.atlassian.net/jira/software/c/projects/A/boards/1?selectedIssue=A-77") === "A-77");
check("not a ref", P.parseIssueRef("hello") === "" && P.parseIssueRef("") === "");

// ── Tallies ────────────────────────────────────────────────────────────────
section("Tallies");
const tDraft = P.normalizeDraft({ people: [{ accountId: "amy" }, { accountId: "bo" }], workingDays: 10, buffer: { mode: "percent", value: 20 } });
const planned = [issue("T-1", { assignee: "amy", sp: 3 }), issue("T-2", { assignee: "amy", sp: 2.5 }), issue("T-3", { assignee: "zed", sp: 1 }), issue("T-4", { assignee: "bo" })];
P.setEdit(tDraft, planned[3], { points: 0.25 });
const t = P.tallies(tDraft, planned);
check("points and issue counts per person, edits included", t.people.get("amy").points === 5.5 && t.people.get("amy").issues === 2 && t.people.get("bo").points === 0.25);
check("people outside the plan are collected, and the total adds up", t.others.points === 1 && t.points === 6.75 && t.issues === 4);
const cap = P.teamCapacity(tDraft);
check("team capacity is the sum of each person's", cap.available === 16 && cap.byPerson.get("bo").available === 8);

// ── Push plan ──────────────────────────────────────────────────────────────
section("Push plan, against a fresh read");
const pDraft = P.normalizeDraft({
  boards: [{ id: "1", target: "55" }],
  people: [{ accountId: "amy" }],
  added: { "P-1": "55", "P-2": "55", "P-3": "55", "P-9": "55" },
  removed: ["P-5", "P-6"],
});
const fresh = new Map([
  ["P-1", issue("P-1", { assignee: "bo", sp: 2 })],
  ["P-2", issue("P-2", { assignee: "amy", sp: 1, status: "Done", cat: "done" })],
  ["P-3", issue("P-3", { assignee: "amy", sp: 3 })],
  ["P-4", issue("P-4", { assignee: null, sp: 2 })],
  ["P-5", issue("P-5", { assignee: "amy", sp: 1 })],
  ["P-7", issue("P-7", { assignee: "amy", sp: 1, due: "2020-01-01", status: "In Progress", cat: "indeterminate" })],
  ["P-8", issue("P-8", { assignee: "amy", sp: 1, due: "2099-01-01" })],
]);
pDraft.edits["P-1"] = { assignee: "amy" };
pDraft.baseline["P-1"] = { assignee: null, points: 2 }; // was unassigned when planned
pDraft.edits["P-3"] = { points: 3 }; // already what Jira has
fresh.set("P-10", issue("P-10", { type: "Sub-task" })); // no owner, no estimate
const inT = new Map([["55", new Set(["P-3", "P-4", "P-5", "P-7", "P-8", "P-10"])]]);
const plan = P.buildPushPlan({ draft: pDraft, issues: fresh, inTarget: inT, sprintEnd: "2026-10-16", now: new Date(2026, 9, 1) });
check("a field write for a real change only", plan.fieldWrites.length === 1 && plan.fieldWrites[0].key === "P-1" && plan.fieldWrites[0].changes.assignee === "amy");
check("a change made in Jira since planning is named", plan.conflicts.some((c) => c.key === "P-1" && /assignee changed/.test(c.message)));
check("a vanished issue is named, not moved", plan.conflicts.some((c) => c.key === "P-9"));
check("an issue done since planning is left alone", plan.skipped.some((s) => s.key === "P-2") && !plan.moves.flatMap((m) => m.keys).includes("P-2"));
check("what is already in the sprint is not moved again", plan.moves.length === 1 && plan.moves[0].keys.join() === "P-1");
check("a removal still in the sprint is moved out; one already gone is not", plan.removals.join() === "P-5");
check("an issue in the sprint without an owner blocks the push", plan.blocked.some((b) => b.key === "P-4" && /assignee/.test(b.message)));
check("a sub-task in the sprint is not held to the rule", !plan.blocked.some((b) => b.key === "P-10"));
check("overdue and due-after-the-sprint warn, and do not block", plan.warnings.some((w) => w.key === "P-7" && /overdue/.test(w.message)) &&
  plan.warnings.some((w) => w.key === "P-8" && /after the sprint/.test(w.message)) && !plan.blocked.some((b) => b.key === "P-7"));
check("the write count is every write", plan.writeCount === 3);

// ── Push ───────────────────────────────────────────────────────────────────
section("Push: retry each failure three times, then report by name");
const calls = [];
const sleeps = [];
const failures = new Map(); // key -> how many more times to fail
const makeApi = () => ({
  updateFields: async (iss, changes) => {
    calls.push(["fields", iss.key, changes]);
    const left = failures.get(iss.key) || 0;
    if (left) {
      failures.set(iss.key, left - 1);
      throw Object.assign(new Error(`${iss.key}: Story points must be a number`), { status: 400 });
    }
  },
  moveToSprint: async (sprintId, keys) => {
    calls.push(["move", sprintId, [...keys]]);
    for (const k of keys) {
      const left = failures.get(k) || 0;
      if (left) {
        failures.set(k, left - 1);
        throw new Error(`Issue ${k} cannot be moved`);
      }
    }
  },
  moveToBacklog: async (keys) => { calls.push(["backlog", [...keys]]); },
});
const bigPlan = {
  fieldWrites: [{ key: "F-1", issue: { key: "F-1" }, changes: { storyPoints: 2 } }, { key: "F-2", issue: { key: "F-2" }, changes: { storyPoints: 3 } }],
  moves: [{ sprintId: "55", keys: ["M-1", "M-2", "M-3"] }],
  removals: ["R-1"],
};
failures.set("F-2", 2); // fails twice, lands on the second retry
failures.set("M-2", 99); // never lands
const result = await P.executePush(bigPlan, makeApi(), { sleep: async (ms) => { sleeps.push(ms); } });
check("fields are written before sprint moves", calls[0][0] === "fields" && calls[2][0] === "move");
check("a failed batch is broken up so the rest land", result.done.some((d) => d.key === "M-1") && result.done.some((d) => d.key === "M-3"));
check("a flaky write lands on a retry", result.done.some((d) => d.key === "F-2"));
check("a failure is retried three times, then reported by key with Jira's words", result.failed.length === 1 && result.failed[0].key === "M-2" &&
  result.failed[0].tries === 4 && /cannot be moved/.test(result.failed[0].message), JSON.stringify(result.failed));
check("three rounds of retries, with a growing pause", sleeps.join() === P.RETRY_DELAYS_MS.join());
check("removals are pushed", result.done.some((d) => d.key === "R-1" && d.kind === "remove"));

calls.length = 0;
sleeps.length = 0;
const authApi = { ...makeApi(), updateFields: async () => { throw new Error("401 Unauthorized"); } };
const stopped = await P.executePush(bigPlan, authApi, { sleep: async (ms) => { sleeps.push(ms); } });
check("a dead token stops the push without retrying", stopped.authStopped && sleeps.length === 0 && !calls.some((c) => c[0] === "move"));

const sDraft = P.normalizeDraft({ added: { "M-1": "55", "M-2": "55" }, removed: ["R-1"], edits: { "F-1": { points: 2 } }, baseline: { "F-1": { points: null } } });
P.settleDraft(sDraft, result);
check("what landed leaves the draft; what failed stays for the next push", !sDraft.edits["F-1"] && !sDraft.added["M-1"] && sDraft.added["M-2"] === "55" && !sDraft.removed.length);

// ── Split ──────────────────────────────────────────────────────────────────
section("Split");
const names = P.splitNames("Rewrite the importer");
check("the original becomes part one and the new issue part two", names.first === "Rewrite the importer - pt.1" && names.second === "Rewrite the importer - pt.2");
const again = P.splitNames("Rewrite the importer - pt.2");
check("splitting part two keeps its name and makes part three", again.first === "Rewrite the importer - pt.2" && again.second === "Rewrite the importer - pt.3");
check("the old Placeholder: prefix is dropped", P.splitNames("Placeholder: Rewrite the importer pt.2").second === "Rewrite the importer - pt.3");
check("points divide between the parts", JSON.stringify(P.splitPoints(5, 2)) === '{"first":2,"second":3}' && JSON.stringify(P.splitPoints(5, 9)) === '{"first":5,"second":0}');
check("an unestimated original gives part two nothing", P.splitPoints(null, 1).second === null);
check("each part's comment names the other", /ACME-9/.test(P.splitComment({ other: "ACME-9", role: "first" })) && /continues ACME-5/.test(P.splitComment({ other: "ACME-5", role: "second" })));
const transitions = [
  { id: "1", toStatus: "Rejected", to: { statusCategory: { key: "done" } } },
  { id: "2", toStatus: "In Review", to: { statusCategory: { key: "indeterminate" } } },
  { id: "3", toStatus: "Closed", to: { statusCategory: { key: "done" } } },
];
check("closing picks a done status that is not a rejection", P.doneTransition(transitions)?.id === "3");
check("a status named Done wins", P.doneTransition([...transitions, { id: "4", toStatus: "Done", to: { statusCategory: { key: "done" } } }])?.id === "4");
check("no way to done is null", P.doneTransition([transitions[1]]) === null);
check("part two goes back to a To Do status, preferring one named so", P.todoTransition([
  { id: "a", toStatus: "Backlog", to: { statusCategory: { key: "new" } } },
  { id: "b", toStatus: "To Do", to: { statusCategory: { key: "new" } } },
  { id: "c", toStatus: "Done", to: { statusCategory: { key: "done" } } },
])?.id === "b" && P.todoTransition([{ id: "c", toStatus: "Done", to: { statusCategory: { key: "done" } } }]) === null);
check("the link is Relates where the site has it", P.splitLinkType([{ name: "Blocks" }, { name: "Relates", outward: "relates to" }])?.name === "Relates");
const fields = P.splitCreateFields(issue("ACME-5", { epic: "ACME-1", due: "2026-10-20" }));
check("part two keeps project, type, parent and due date", fields.project.key === "ACME" && fields.issuetype.id === "10001" && fields.parent.key === "ACME-1" && fields.duedate === "2026-10-20" && /pt\.2$/.test(fields.summary));
check("and can go without the due date", !P.splitCreateFields(issue("ACME-5", { due: "2026-10-20" }), { withDue: false }).duedate);
check("and can go without the parent", !P.splitCreateFields(issue("ACME-5", { epic: "ACME-1" }), { withParent: false }).parent);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
