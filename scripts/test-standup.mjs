#!/usr/bin/env node
// Unit checks for standup session logic: seeded ordering, phase transitions,
// pause arithmetic, overrun, resume, and the board grouping the stage reuses.
// No dependencies, no network, no browser.
//
// Time is injected everywhere, so these run instantly instead of waiting on
// real clocks — and they cover the cases a manual run-through never reaches
// (someone pausing for ten minutes, a tab throttled mid-sprint, a reload).
//
// Usage: node scripts/test-standup.mjs

const STANDUP_URL = new URL("../js/standup.js", import.meta.url);

let local = {};
let sync = {};
const pick = (store, keys) =>
  Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  );

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete local[k]; return Promise.resolve(); },
    },
    sync: {
      get: (keys) => Promise.resolve(keys == null ? { ...sync } : pick(sync, keys)),
      set: (obj) => { Object.assign(sync, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete sync[k]; return Promise.resolve(); },
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const su = await import(STANDUP_URL);
const board = await import(new URL("../js/components/board.js", import.meta.url));
const cfg = await import(new URL("../js/config.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const people = (n) => Array.from({ length: n }, (_, i) => ({ accountId: `acc-${i + 1}` }));
const T0 = 1_000_000;

section("seeded shuffle");
const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
check("same seed, same order",
  su.shuffleWithSeed(ids, 42).join() === su.shuffleWithSeed(ids, 42).join());
check("different seed, different order",
  su.shuffleWithSeed(ids, 42).join() !== su.shuffleWithSeed(ids, 43).join());
check("no one lost", su.shuffleWithSeed(ids, 7).slice().sort().join() === ids.slice().sort().join());
check("length preserved", su.shuffleWithSeed(ids, 7).length === ids.length);
check("actually reorders something",
  su.shuffleWithSeed(ids, 12345).join() !== ids.join());
check("single item survives", su.shuffleWithSeed(["only"], 1).join() === "only");
check("empty list tolerated", su.shuffleWithSeed([], 1).length === 0);
const randomA = su.makeRandom(99);
check("PRNG stays in range", Array.from({ length: 50 }, randomA).every((v) => v >= 0 && v < 1));

section("duration clamping");
check("default when unset", su.clampDuration(undefined) === su.DEFAULT_DURATION_SEC);
check("NaN falls back", su.clampDuration("banana") === su.DEFAULT_DURATION_SEC);
check("floor applied", su.clampDuration(1) === su.MIN_DURATION_SEC);
check("ceiling applied", su.clampDuration(99999) === su.MAX_DURATION_SEC);
check("normal value kept", su.clampDuration(180) === 180);
check("rounded", su.clampDuration(120.6) === 121);

section("session creation");
let s = su.createSession({ participants: people(3), seed: 5, now: T0 });
check("starts in countdown", s.phase === su.PHASES.COUNTDOWN);
check("everyone in the order", s.order.length === 3);
check("index starts at zero", s.index === 0);
check("durations defaulted", Object.values(s.durations).every((d) => d === su.DEFAULT_DURATION_SEC));
check("seed retained for resume", s.seed === 5);
check("not paused", su.isPaused(s) === false);
check("empty participant list goes straight to done",
  su.createSession({ participants: [], seed: 1, now: T0 }).phase === su.PHASES.DONE);
check("per-person durations respected",
  su.createSession({ participants: people(2), durations: { "acc-1": 300 }, seed: 1, now: T0 })
    .durations["acc-1"] === 300);
check("participants without accountId dropped",
  su.createSession({ participants: [{ accountId: "a" }, {}], seed: 1, now: T0 }).order.length === 1);

section("countdown phase");
s = su.createSession({ participants: people(2), seed: 5, now: T0 });
check("lead-in length", su.phaseTotalMs(s) === su.LEAD_IN_SEC * 1000);
check("full time remaining at start", su.phaseRemainingMs(s, T0) === su.LEAD_IN_SEC * 1000);
check("counts down", su.phaseRemainingMs(s, T0 + 2000) === (su.LEAD_IN_SEC - 2) * 1000);
check("no auto-advance early", su.shouldAutoAdvance(s, T0 + 2000) === false);
check("auto-advances at zero", su.shouldAutoAdvance(s, T0 + su.LEAD_IN_SEC * 1000) === true);
check("auto-advances when overshot", su.shouldAutoAdvance(s, T0 + 99999) === true);

section("countdown -> speaking");
s = su.advance(s, T0 + 5000);
check("now speaking", s.phase === su.PHASES.SPEAKING);
check("first person is current", su.currentId(s) === s.order[0]);
check("phase clock restarted", su.phaseElapsedMs(s, T0 + 5000) === 0);
check("speaking length from durations", su.phaseTotalMs(s) === su.DEFAULT_DURATION_SEC * 1000);
check("speaking never auto-advances", su.shouldAutoAdvance(s, T0 + 999999) === false);

section("overrun");
const overrunAt = T0 + 5000 + su.DEFAULT_DURATION_SEC * 1000 + 7000;
check("remaining goes negative", su.phaseRemainingMs(s, overrunAt) === -7000);
check("overrun flagged", su.isOverrun(s, overrunAt) === true);
check("not overrun before the limit", su.isOverrun(s, T0 + 6000) === false);
check("clock formats negatives", su.formatClock(-7000) === "-0:07");

section("overrun clock growth");
// `s` is speaking, started at T0 + 5000. overBy(n) is n seconds past the limit.
const near = (a, b) => Math.abs(a - b) < 1e-9;
const overBy = (sec) => T0 + 5000 + su.DEFAULT_DURATION_SEC * 1000 + sec * 1000;
check("normal size while time remains", su.overrunScale(s, T0 + 6000) === 1);
check("normal size at the moment the limit hits", su.overrunScale(s, overBy(0)) === 1);
check("holds until the first five seconds are up", su.overrunScale(s, overBy(4.9)) === 1);
check("first step at five seconds over",
  near(su.overrunScale(s, overBy(5)), 1 + su.OVERRUN_STEP_GROWTH));
check("holds between steps", near(su.overrunScale(s, overBy(9)), 1 + su.OVERRUN_STEP_GROWTH));
check("second step at ten seconds over",
  near(su.overrunScale(s, overBy(10)), 1 + 2 * su.OVERRUN_STEP_GROWTH));
check("keeps climbing", su.overrunScale(s, overBy(30)) > su.overrunScale(s, overBy(20)));
check("capped so the facilitator's controls stay put",
  su.overrunScale(s, overBy(60 * 60)) === su.OVERRUN_MAX_SCALE);
check("never below normal size",
  [-10, 0, 3, 5, 50, 5000].every((n) => su.overrunScale(s, overBy(n)) >= 1));
// The reset is the whole point: nothing resets this explicitly, so if it did
// not fall out of the phase timestamps, person two would inherit person one's
// swollen clock.
const nextPerson = su.advance(su.advance(s, overBy(20)), overBy(20) + su.HANDOFF_SEC * 1000);
check("back to normal for the next person",
  nextPerson.phase === su.PHASES.SPEAKING && su.overrunScale(nextPerson, overBy(21)) === 1);
const counting = su.createSession({ participants: people(2), seed: 5, now: T0 });
check("countdown phase never swells", su.overrunScale(counting, T0 + 999999) === 1);

section("sprint label trimming");
check("drops the descriptive tail", su.trimSprintLabel("DP-82: Blah-blah") === "DP-82");
check("keeps a bare identifier", su.trimSprintLabel("DP-82") === "DP-82");
check("cuts at the first number, not the last",
  su.trimSprintLabel("Sprint 12 — week 3") === "Sprint 12");
check("multi-digit runs stay whole", su.trimSprintLabel("DP-1234: things") === "DP-1234");
check("trailing punctuation goes", su.trimSprintLabel("DP-82 (carry-over)") === "DP-82");
check("a name with no digits is left alone",
  su.trimSprintLabel("Hardening sprint") === "Hardening sprint");
check("empty string tolerated", su.trimSprintLabel("") === "");
check("missing name does not throw", su.trimSprintLabel(undefined) === undefined);
check("trimming collapses two names for the same sprint",
  new Set(["DP-82: Payments", "DP-82 (carry-over)"].map(su.trimSprintLabel)).size === 1);

section("pause arithmetic");
s = su.createSession({ participants: people(2), seed: 5, now: T0 });
s = su.advance(s, T0);                       // speaking from T0
check("30s elapsed", su.phaseElapsedMs(s, T0 + 30000) === 30000);
s = su.pause(s, T0 + 30000);
check("paused", su.isPaused(s) === true);
check("clock frozen while paused", su.phaseElapsedMs(s, T0 + 90000) === 30000);
check("remaining frozen too",
  su.phaseRemainingMs(s, T0 + 90000) === su.DEFAULT_DURATION_SEC * 1000 - 30000);
s = su.resume(s, T0 + 90000);                // paused for a minute
check("resumed", su.isPaused(s) === false);
check("paused minute excluded", su.phaseElapsedMs(s, T0 + 100000) === 40000);
check("double pause is a no-op",
  su.phaseElapsedMs(su.pause(su.pause(s, T0 + 100000), T0 + 110000), T0 + 120000) === 40000);
check("resume without pause is a no-op", su.resume(s, T0 + 100000) === s);
check("togglePause pauses then resumes",
  su.isPaused(su.togglePause(s, T0 + 100000)) === true &&
  su.isPaused(su.togglePause(su.togglePause(s, T0 + 100000), T0 + 101000)) === false);

section("multiple pauses accumulate");
s = su.createSession({ participants: people(1), seed: 1, now: T0 });
s = su.advance(s, T0);
s = su.resume(su.pause(s, T0 + 10000), T0 + 20000);   // paused 10s
s = su.resume(su.pause(s, T0 + 30000), T0 + 45000);   // paused 15s
check("both pauses discounted", su.phaseElapsedMs(s, T0 + 50000) === 25000);

section("handoff and person transitions");
s = su.createSession({ participants: people(3), seed: 5, now: T0 });
s = su.advance(s, T0);                                   // speaking #1
const first = su.currentId(s);
check("next person known during speaking", su.nextId(s) === s.order[1]);
s = su.advance(s, T0 + 60000);                           // handoff
check("handoff phase", s.phase === su.PHASES.HANDOFF);
check("index not yet moved", su.currentId(s) === first);
check("handoff length", su.phaseTotalMs(s) === su.HANDOFF_SEC * 1000);
check("handoff auto-advances", su.shouldAutoAdvance(s, T0 + 60000 + su.HANDOFF_SEC * 1000) === true);
check("actual time recorded for the first speaker", s.actualMs[first] === 60000);
s = su.advance(s, T0 + 64000);                           // speaking #2
check("second person speaking", su.currentId(s) === s.order[1]);
check("index advanced", s.index === 1);

section("last person finishes the session");
s = su.advance(s, T0 + 100000);   // handoff
s = su.advance(s, T0 + 104000);   // speaking #3
check("on the last person", su.nextId(s) === null);
s = su.advance(s, T0 + 160000);
check("session done", s.phase === su.PHASES.DONE);
check("finish time stamped", s.finishedAt === T0 + 160000);
check("no longer running", su.isRunning(s) === false);
check("advance past done is a no-op", su.advance(s, T0 + 200000).phase === su.PHASES.DONE);
check("every speaker has a time", Object.keys(s.actualMs).length === 3);

section("ending early");
s = su.createSession({ participants: people(4), seed: 5, now: T0 });
s = su.advance(s, T0);
s = su.finish(s, T0 + 45000);
check("phase done", s.phase === su.PHASES.DONE);
check("partial time credited", s.actualMs[s.order[0]] === 45000);
check("unreached people have no time", s.actualMs[s.order[3]] === undefined);

section("adding time mid-answer");
s = su.createSession({ participants: people(1), durations: { "acc-1": 120 }, seed: 1, now: T0 });
s = su.advance(s, T0);
const before = su.phaseRemainingMs(s, T0 + 30000);
s = su.addTime(s, 60);
check("duration extended", s.durations["acc-1"] === 180);
check("remaining grew by the added time", su.phaseRemainingMs(s, T0 + 30000) === before + 60000);
check("elapsed untouched", su.phaseElapsedMs(s, T0 + 30000) === 30000);
check("addTime ignored outside speaking",
  su.addTime(su.createSession({ participants: people(1), seed: 1, now: T0 }), 60)
    .durations["acc-1"] === su.DEFAULT_DURATION_SEC);

section("planned totals");
const order = ["a", "b", "c"];
const durs = { a: 120, b: 180, c: 60 };
check("speaking total", su.plannedTotalSec(order, durs) === 360);
check("wall estimate adds lead-in and hand-offs",
  su.estimatedWallSec(order, durs) === 360 + su.LEAD_IN_SEC + su.HANDOFF_SEC * 2);
check("single person has no hand-offs",
  su.estimatedWallSec(["a"], durs) === 120 + su.LEAD_IN_SEC);
check("empty order is zero", su.estimatedWallSec([], durs) === 0);
check("missing durations default",
  su.plannedTotalSec(["x"], {}) === su.DEFAULT_DURATION_SEC);

section("clock formatting");
check("zero", su.formatClock(0) === "0:00");
check("seconds padded", su.formatClock(9000) === "0:09");
check("minutes", su.formatClock(125000) === "2:05");
check("ten minutes", su.formatClock(600000) === "10:00");
check("rounds down within the second", su.formatClock(1999) === "0:01");

section("persistence and resume");
local = {};
s = su.createSession({ participants: people(3), seed: 77, now: T0 });
s = su.advance(s, T0);
s = su.advance(s, T0 + 60000);          // handoff after person 1
await su.saveSession(s);
check("written device-local", Boolean(local[su.SESSION_KEY]));
let resumed = await su.loadSession();
check("session comes back", resumed !== null);
check("same order on resume", resumed.order.join() === s.order.join());
check("same position", resumed.index === s.index);
check("phase preserved", resumed.phase === su.PHASES.HANDOFF);
check("recorded times preserved", resumed.actualMs[s.order[0]] === 60000);
check("order reproducible from the seed alone",
  su.shuffleWithSeed(s.order.slice().sort(), resumed.seed).join() === s.order.join());

await su.saveSession(su.finish(s, T0 + 70000));
check("finished sessions are not offered for resume", (await su.loadSession()) === null);
await su.clearSession();
check("cleared", (await su.loadSession()) === null);
local = { [su.SESSION_KEY]: { order: [], phase: "speaking" } };
check("empty order not resumable", (await su.loadSession()) === null);
local = { [su.SESSION_KEY]: { junk: true } };
check("malformed session ignored", (await su.loadSession()) === null);

section("per-person parking lot");
let notesSession = su.createSession({ participants: people(3), seed: 5, now: T0 });
check("starts with no notes", JSON.stringify(notesSession.notesByPerson) === "{}");
const [p1, p2] = notesSession.order;
notesSession = {
  ...notesSession,
  notesByPerson: { [p1]: "  chase the vendor  ", [p2]: "" },
};
check("blank notes are skipped", su.notesEntries(notesSession).length === 1);
check("note is trimmed", su.notesEntries(notesSession)[0].note === "chase the vendor");
check("entry carries the person", su.notesEntries(notesSession)[0].id === p1);
notesSession = {
  ...notesSession,
  notesByPerson: { ...notesSession.notesByPerson, [p2]: "needs review" },
};
check("entries follow speaking order",
  su.notesEntries(notesSession).map((e) => e.id).join() === `${p1},${p2}`);
check("no notes -> no entries", su.notesEntries(su.createSession({ participants: people(2), seed: 1, now: T0 })).length === 0);
check("missing notesByPerson tolerated", su.notesEntries({ order: ["a"] }).length === 0);

// A session saved before notes were per-person carries one string for everyone.
local = {
  [su.SESSION_KEY]: {
    order: ["acc-1", "acc-2", "acc-3"],
    index: 1,
    phase: su.PHASES.SPEAKING,
    notes: "legacy note",
  },
};
const migrated = await su.loadSession();
check("legacy notes attributed to the current speaker",
  migrated.notesByPerson["acc-2"] === "legacy note");
check("legacy notes not spread to others",
  Object.keys(migrated.notesByPerson).length === 1);
check("legacy empty notes -> no entries",
  Object.keys(su.migrateSessionNotes({ order: ["a"], index: 0, notes: "   " }).notesByPerson).length === 0);
check("existing per-person notes left alone",
  su.migrateSessionNotes({ order: ["a"], index: 0, notesByPerson: { a: "keep" } }).notesByPerson.a === "keep");

section("slack digest — plain text");
const digestEntries = [
  { who: "@tulio", note: "TBD re: dbt restructure" },
  { who: "@ruben", note: "Avro remains king\nbackfill in progress\n" },
];
const digest = su.digestText({
  title: "Standup - 12.08.2026",
  entries: digestEntries,
  signoff: su.DIGEST_SIGNOFF,
});
check("title first, then a blank line",
  digest.split("\n").slice(0, 2).join("|") === "Standup - 12.08.2026|");
check("single-line note shares the bullet with the mention",
  digest.includes("- @tulio - TBD re: dbt restructure"));
check("multi-line note becomes sub-bullets under the mention",
  digest.includes("- @ruben\n    - Avro remains king\n    - backfill in progress"));
check("sign-off closes the message", digest.endsWith(`\n\n${su.DIGEST_SIGNOFF}`));
check("blank lines inside a note are dropped",
  su.digestText({ entries: [{ who: "@a", note: "one\n\n\ntwo" }] })
    === "- @a\n    - one\n    - two");
check("hand-typed bullets are not doubled",
  su.digestText({ entries: [{ who: "@a", note: "- one\n• two" }] })
    === "- @a\n    - one\n    - two");
check("a person with no note still gets a bullet",
  su.digestText({ entries: [{ who: "@a", note: "" }] }) === "- @a");
check("no title and no sign-off means no stray blank lines",
  su.digestText({ entries: [{ who: "@a", note: "x" }] }) === "- @a - x");
check("nothing at all is empty, not a crash", su.digestText() === "");

section("slack digest — clipboard HTML");
const html = su.digestHtml(digest);
check("first line is bold", html.startsWith("<p><b>Standup - 12.08.2026</b></p>"));
check("one list wraps every person",
  (html.match(/<ul>/g) || []).length === 2 && html.includes("<ul><li>@tulio"));
check("sub-bullets nest inside their person's item",
  html.includes("<li>@ruben<ul><li>Avro remains king</li><li>backfill in progress</li></ul></li>"));
check("sign-off is a plain paragraph, not bold",
  html.endsWith(`<p>${su.DIGEST_SIGNOFF}</p>`));
check("html in a note is escaped, not injected",
  su.digestHtml("- <script>x</script> & co")
    === "<ul><li>&lt;script&gt;x&lt;/script&gt; &amp; co</li></ul>");
check("urls become links",
  su.digestHtml("- see https://x.test/a?b=1&c=2 now")
    .includes('<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>'));
check("trailing punctuation stays out of the link",
  su.digestHtml("- see https://x.test/a.").includes("</a>.</li>"));
check("an edited box with an extra paragraph still parses",
  su.digestHtml("Title\n\n- a\n\nPS: later").endsWith("<p>PS: later</p>"));
check("a sub-bullet with no parent is promoted, not dropped",
  su.digestHtml("    - orphan") === "<ul><li>orphan</li></ul>");
check("empty text yields empty html", su.digestHtml("") === "");

section("attendance prefs");
local = {};
check("no prefs -> empty defaults",
  JSON.stringify(await su.loadPrefs()) === JSON.stringify({ attendance: [], durations: {} }));
await su.savePrefs({ attendance: ["acc-1", "acc-2"], durations: { "acc-1": 180 } });
let prefs = await su.loadPrefs();
check("attendance remembered", prefs.attendance.join() === "acc-1,acc-2");
check("durations remembered", prefs.durations["acc-1"] === 180);
local = { [su.PREFS_KEY]: { attendance: "not-an-array", durations: 5 } };
prefs = await su.loadPrefs();
check("bad stored prefs coerced", Array.isArray(prefs.attendance) && prefs.attendance.length === 0);
check("bad durations coerced", typeof prefs.durations === "object");

section("board grouping (shared with the Kanban view)");
sync = { site: { baseUrl: "https://x.atlassian.net" } };
local = { schemaVersion: 2 };
await cfg.loadConfig();
const GROUPS = [
  { name: "To Do", statuses: ["To Do", "Open"] },
  { name: "In Progress", statuses: ["In Progress"] },
  { name: "Done", statuses: ["Done"] },
];
const issueIn = (status, key = "ABC-1") => ({ key, fields: { status: { name: status } } });
let cols = board.groupIssues(
  [issueIn("To Do", "A-1"), issueIn("In Progress", "A-2"), issueIn("Open", "A-3")],
  GROUPS
);
check("one column per configured group", cols.length === 3);
check("statuses map onto their group", cols[0].issues.length === 2);
check("empty group still rendered", cols[2].issues.length === 0);
check("group order follows config", cols.map((c) => c.name).join() === "To Do,In Progress,Done");
cols = board.groupIssues([issueIn("Blocked", "A-9")], GROUPS);
check("unmapped status gets its own column", cols.length === 4 && cols[3].name === "Blocked");
cols = board.groupIssues([issueIn("To Do")], GROUPS, ["Done", "To Do", "In Progress"]);
check("saved column order respected", cols.map((c) => c.name).join() === "Done,To Do,In Progress");
cols = board.groupIssues([issueIn("To Do")], GROUPS, ["Nonexistent", "Done"]);
check("stale saved column dropped", !cols.some((c) => c.name === "Nonexistent"));
check("columns missing from saved order still appear", cols.length === 3);
check("issue without a status lands in To Do",
  board.groupIssues([{ key: "A-0", fields: {} }], GROUPS)[0].issues.length === 1);
check("no issues -> all groups empty",
  board.groupIssues([], GROUPS).every((c) => c.issues.length === 0));

section("hand-off phrases");
const phraseSession = (seed, index) => ({ seed, index });
check("returns one of the phrases",
  su.HANDOFF_PHRASES.includes(su.handoffPhrase(phraseSession(1, 0))));
check("stable across re-renders — pause and resume must not reshuffle it",
  su.handoffPhrase(phraseSession(42, 3)) === su.handoffPhrase(phraseSession(42, 3)));
check("varies by position",
  new Set([0, 1, 2, 3, 4].map((i) => su.handoffPhrase(phraseSession(42, i)))).size > 1);
check("varies by seed — two standups do not read identically",
  new Set([1, 2, 3, 4, 5].map((s) => su.handoffPhrase(phraseSession(s, 0)))).size > 1);
check("never repeats between consecutive speakers",
  [7, 42, 99, 12345, 2 ** 30].every((seed) =>
    Array.from({ length: 15 }, (_, i) => su.handoffPhrase(phraseSession(seed, i)))
      .every((phrase, i, all) => i === 0 || phrase !== all[i - 1])));
check("every phrase is reachable",
  new Set(
    [...Array(400).keys()].map((i) => su.handoffPhrase(phraseSession(i, i % 9)))
  ).size === su.HANDOFF_PHRASES.length);
check("a missing session does not throw",
  su.HANDOFF_PHRASES.includes(su.handoffPhrase(undefined)));
check("single-phrase list degrades to that phrase",
  su.handoffPhrase(phraseSession(1, 4), ["Only one"]) === "Only one");
check("empty list yields empty string, not undefined",
  su.handoffPhrase(phraseSession(1, 0), []) === "");
check("no phrase is blank", su.HANDOFF_PHRASES.every((p) => p.trim().length > 0));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
