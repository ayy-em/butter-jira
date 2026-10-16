#!/usr/bin/env node
// Unit checks for the planning flow (M23): the working-day calendar the due
// dates are laid over, the split proposed from time already spent, the due
// dates themselves (each person's work oldest first), the sprint name and
// instants the create and start writes send, and the run — steps in order,
// stopping at the first refusal, resuming after the ones already done.
//
// Usage: node scripts/test-planflow.mjs

let sync = {};
let local = {};
const pick = (store, keys) =>
  Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]));
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
const F = await import(new URL("../js/planflow.js", import.meta.url));
const P = await import(new URL("../js/planner.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const GROUPS = [
  { name: "To Do", statuses: ["To Do"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "Done", statuses: ["Done"] },
];
const issue = (key, { sp = null, who = null, created = "2026-01-01T00:00:00Z", status = "To Do", cat = "new", history = null } = {}) => ({
  key,
  fields: {
    summary: key,
    status: { name: status, statusCategory: { key: cat } },
    assignee: who ? { accountId: who } : null,
    issuetype: { name: "Story" },
    created,
    ...(sp === null ? {} : { sp }),
  },
  ...(history ? { history: { events: history } } : {}),
});

section("Steps");
check("four steps, in the settled order", F.FLOW_STEPS.map((s) => s.id).join() === "setup,wrapup,plan,start");
check("an unknown step reads as the first", F.stepIndex("nope") === 0 && F.stepIndex("start") === 3);

section("Working days");
const days = F.workingDayList("2025-12-22", "2026-01-02", { calendar: "nl" });
check("weekends and holidays out, in order", days.join() === "2025-12-22,2025-12-23,2025-12-24,2025-12-29,2025-12-30,2025-12-31,2026-01-02");
check("an unticked holiday is a working day", F.workingDayList("2025-12-22", "2026-01-02", { calendar: "nl", overrides: { "2025-12-26": false } }).includes("2025-12-26"));
check("elapsed working days count both ends, weekends out", F.workingDaysElapsed("2026-10-05", "2026-10-09T12:00:00Z") === 5 && F.workingDaysElapsed("2026-10-09", "2026-10-12") === 2);

section("Sprint writes' inputs");
const inst = F.sprintInstants("2026-10-05", "2026-10-16");
check("start at 09:00 and end at 17:00 local", new Date(inst.startDate).getHours() === 9 && new Date(inst.endDate).getHours() === 17 && new Date(inst.endDate).getDate() === 16);
check("no dates, no instants", F.sprintInstants("", "2026-10-16") === null);
check("the next sprint's name counts on", F.nextSprintName("ACME Sprint 42") === "ACME Sprint 43" && F.nextSprintName("PLAT 19: Index cutover") === "PLAT 20: Index cutover");
check("a name with no number gets one", F.nextSprintName("Hardening") === "Hardening 2" && F.nextSprintName("", "DATA") === "DATA 1");

section("Wrap up");
const sub = { ...issue("S-1"), fields: { ...issue("S-1").fields, issuetype: { name: "Sub-task", subtask: true } } };
const out = F.wrapUpIssues([issue("A-1"), issue("A-2", { status: "Done", cat: "done" }), sub]);
check("open issues only, no sub-tasks", out.map((i) => i.key).join() === "A-1");

const hist = [
  { kind: "status", at: "2026-10-07T10:00:00Z", from: "To Do", to: "In Progress" },
  { kind: "status", at: "2026-10-06T10:00:00Z", from: "Backlog", to: "To Do" },
];
check("started is the first move out of the first column", F.startedAt(issue("A-3", { history: hist }), GROUPS) === "2026-10-07T10:00:00Z");
check("never started has no date", F.startedAt(issue("A-4"), GROUPS) === null);
const timed = F.proposeSplitPoints(issue("A-5", { sp: 5, history: hist }), { sprintStart: "2026-10-05", now: new Date("2026-10-09T12:00:00Z"), statusGroups: GROUPS });
check("part one from working days under way (Wed–Fri = 3 of 5)", timed.basis === "time" && timed.first === 3 && timed.second === 2, JSON.stringify(timed));
const capped = F.proposeSplitPoints(issue("A-6", { sp: 2, history: hist }), { sprintStart: "2026-10-05", now: new Date("2026-10-16T12:00:00Z"), statusGroups: GROUPS });
check("time past the estimate: part one keeps it all, part two needs its own estimate", capped.first === 2 && capped.second === null && capped.overrun === true);
const before = F.proposeSplitPoints(issue("A-7", { sp: 8, history: [{ kind: "status", at: "2026-09-20T10:00:00Z", from: "To Do", to: "In Progress" }] }), { sprintStart: "2026-10-05", now: new Date("2026-10-06T12:00:00Z"), statusGroups: GROUPS });
check("work started before the sprint counts from the sprint's start", before.first === 2, JSON.stringify(before));
const halves = F.proposeSplitPoints(issue("A-8", { sp: 3 }), { statusGroups: GROUPS });
check("no history: half each, to the quarter", halves.basis === "half" && halves.first === 1.5 && halves.second === 1.5);
check("half a day a point doubles the share", F.proposeSplitPoints(issue("A-9", { sp: 8, history: hist }), { sprintStart: "2026-10-05", now: new Date("2026-10-09T12:00:00Z"), statusGroups: GROUPS, pointsPerDay: 2 }).first === 6);
check("unestimated has nothing to split", F.proposeSplitPoints(issue("A-10"), {}).basis === "unestimated");

section("Due dates");
const plan = [
  issue("D-3", { sp: 2, who: "amy", created: "2026-03-01T00:00:00Z" }),
  issue("D-1", { sp: 1, who: "amy", created: "2026-01-01T00:00:00Z" }),
  issue("D-2", { sp: 0.5, who: "amy", created: "2026-02-01T00:00:00Z" }),
  issue("D-4", { sp: 3, who: "bo" }),
  issue("D-5", { who: "bo" }),
  issue("D-6", { sp: 1 }),
];
const due = F.proposeDueDates({ issues: plan, start: "2026-10-05", end: "2026-10-16" });
check("oldest first: 1 point → Mon, then 0.5 → Tue, then 2 → Thu", due.get("D-1").due === "2026-10-05" && due.get("D-2").due === "2026-10-06" && due.get("D-3").due === "2026-10-08",
  [...due].map(([k, v]) => `${k}:${v.due}`).join(" "));
check("each person runs their own clock", due.get("D-4").due === "2026-10-07");
check("unestimated and unassigned get no date", !due.has("D-5") && !due.has("D-6"));
const crowded = F.proposeDueDates({ issues: [issue("X-1", { sp: 12, who: "amy" })], start: "2026-10-05", end: "2026-10-16" });
check("more work than the sprint holds is dated on its last day and flagged", crowded.get("X-1").due === "2026-10-16" && crowded.get("X-1").over === true);
const draft = P.normalizeDraft({ people: [{ accountId: "amy" }] });
P.setEdit(draft, plan[1], { points: 5 });
const viaDraft = F.proposeDueDates({ issues: plan.slice(0, 3), assigneeOf: (i) => P.effective(draft, i).assignee, pointsOf: (i) => P.effective(draft, i).points, start: "2026-10-05", end: "2026-10-16" });
check("the draft's estimates move the dates", viaDraft.get("D-1").due === "2026-10-09" && viaDraft.get("D-3").due === "2026-10-14");
const ascension = F.proposeDueDates({ issues: [issue("H-1", { sp: 4, who: "amy" })], start: "2026-05-11", end: "2026-05-22", calendar: "nl" });
check("holidays are skipped (Ascension Day, Thursday 14 May 2026)", ascension.get("H-1").due === "2026-05-15");

section("Due dates in the draft and the push");
const dd = P.normalizeDraft({ edits: { "D-1": { dueDate: "2026-10-05" } } });
check("a due-date edit survives normalising", dd.edits["D-1"].dueDate === "2026-10-05");
const withDue = issue("D-1");
withDue.fields.duedate = "2026-10-30";
P.setEdit(dd, withDue, { dueDate: "2026-10-30" });
check("setting it back to Jira's value drops the edit", !dd.edits["D-1"]);
P.setEdit(dd, withDue, { dueDate: "2026-10-07" });
const pushPlan = P.buildPushPlan({ draft: dd, issues: new Map([["D-1", withDue]]), inTarget: new Map() });
check("the push writes the due date with its before and after", pushPlan.fieldWrites[0].changes.dueDate === "2026-10-07" && pushPlan.fieldWrites[0].from.dueDate === "2026-10-30");

section("Run");
const steps = F.runSteps({ hasWrites: true, outgoingSprintId: "41", targetSprintId: "42" });
check("push, close, start, freeze, all applying", steps.map((s) => `${s.id}:${s.applies}`).join() === "push:true,close:true,start:true,freeze:true");
check("no outgoing sprint, nothing to close", !F.runSteps({ targetSprintId: "42" }).find((s) => s.id === "close").applies);
check("an active target is not started again", !F.runSteps({ targetSprintId: "42", targetState: "active" }).find((s) => s.id === "start").applies);

const calls = [];
const ok = (id) => async () => { calls.push(id); };
const r1 = await F.executeRun(steps, { push: ok("push"), close: async () => { calls.push("close"); throw new Error("Sprint cannot be completed: it is not active"); }, start: ok("start"), freeze: ok("freeze") });
check("stops at the first refusal, with Jira's words", r1.failed?.id === "close" && /not active/.test(r1.failed.error) && calls.join() === "push,close");
check("what ran is marked done", r1.states.find((s) => s.id === "push").done && !r1.states.find((s) => s.id === "start").done);
calls.length = 0;
const resumed = F.runSteps({ hasWrites: true, outgoingSprintId: "41", targetSprintId: "42", done: { push: true } });
const r2 = await F.executeRun(resumed, { push: ok("push"), close: ok("close"), start: ok("start"), freeze: ok("freeze") });
check("a retry resumes after what is done, never repeating a write", !r2.failed && calls.join() === "close,start,freeze");
calls.length = 0;
const r3 = await F.executeRun(F.runSteps({ hasWrites: true, targetSprintId: "42" }), { push: async () => ({ ok: false, message: "ACME-1: refused" }), start: ok("start"), freeze: ok("freeze") });
check("a push that reports failures counts as a refusal", r3.failed?.id === "push" && r3.failed.error === "ACME-1: refused" && !calls.length);

section("Flow draft");
const fd = P.normalizeDraft({ flow: { step: "plan", boardId: 3, outgoingSprintId: 41, mode: "group", run: { push: true, close: "yes", bogus: true }, recapOpened: true } });
check("flow state normalises", fd.flow.step === "plan" && fd.flow.boardId === "3" && fd.flow.mode === "group" && fd.flow.recapOpened === true);
check("only real, finished run steps survive", JSON.stringify(fd.flow.run) === '{"push":true}');
check("the planner's draft carries no flow", P.normalizeDraft({}).flow === undefined);
await P.saveDraft(fd, new Date(), F.FLOW_KEY);
check("the flow keeps its own draft beside the planner's", local[F.FLOW_KEY]?.flow?.step === "plan" && !local[P.PLANNER_KEY]);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
