#!/usr/bin/env node
// Unit checks for per-sprint history (M17): the draft row the dashboard writes,
// rows seeded from stored snapshots, sealing at rollover with the GitHub
// window, what a row may claim, retention, the delete that must stay deleted,
// the trend the velocity card reads, and the backup merge.
//
// No dependencies, no network, no browser.
//
// Usage: node scripts/test-history.mjs

let local = {};
const pick = (store, keys) =>
  Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]));
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete local[k]; return Promise.resolve(); },
    },
    sync: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const h = await import(new URL("../js/history.js", import.meta.url));
const bk = await import(new URL("../js/backup.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const sprint = (id, name, start, end) => ({ id, name, startDate: `${start}T08:00:00.000Z`, endDate: `${end}T16:00:00.000Z` });
const summary = { issueCount: 22, doneIssues: 9, totalPoints: 40.04, donePoints: 17.96 };

// ── The draft ────────────────────────────────────────────────────────────────

section("the running sprint's draft row");

{
  const draft = h.draftRow({
    key: "41",
    sprints: [sprint(41, "Sprint 41", "2026-10-26", "2026-11-06")],
    summary,
    scope: { basis: "freeze", original: 38 },
    now: new Date(2026, 10, 3, 12),
  });
  check("keyed by the sprint key, named and dated", draft.key === "41" && draft.name === "Sprint 41" && draft.start === "2026-10-26");
  check("not final", draft.final === false);
  check("the day's totals, rounded to a tenth", draft.pointsTotal === 40 && draft.pointsCompleted === 18 && draft.issuesClosed === 9);
  check("the commitment comes from the freeze", draft.pointsCommitted === 38 && draft.partial.jira === false);
  check("its reading is dated today", draft.lastReading === "2026-11-03");
  check("no GitHub half yet", draft.github === null);

  const approx = h.draftRow({ key: "41", sprints: [], summary, scope: { basis: "creation", original: 30 } });
  check("without a freeze there is no measured commitment, and the row says so",
    approx.pointsCommitted === null && approx.partial.jira === true);

  const two = h.draftRow({
    key: "18+41",
    sprints: [sprint(41, "Sprint 41", "2026-10-26", "2026-11-06"), sprint(18, "PLAT 18", "2026-10-27", "2026-11-07")],
    summary,
    scope: { basis: "freeze", original: 38 },
  });
  check("two boards' sprints are one row, spanning both", two.name === "Sprint 41 + PLAT 18" && two.end === "2026-11-07");
}

// ── Seeding ──────────────────────────────────────────────────────────────────

section("sprints from before the store existed are seeded from their last snapshot");

const days = [
  { date: "2026-10-12", totalPoints: 30, donePoints: 0, issueCount: 20, doneIssues: 0 },
  { date: "2026-10-23", totalPoints: 34, donePoints: 28, issueCount: 21, doneIssues: 17 },
];
const freeze = { rows: [{ key: "A-1" }], totalPoints: 31, sprintNames: ["Sprint 40"], sprintIds: ["40"], windowStart: "2026-10-12", windowEnd: "2026-10-23" };
{
  const row = h.seedRow({ key: "40", snapshots: days, freeze });
  check("the last day's figures", row.pointsCompleted === 28 && row.issues === 21 && row.issuesClosed === 17);
  check("name, dates and commitment from the freeze",
    row.name === "Sprint 40" && row.start === "2026-10-12" && row.end === "2026-10-23" && row.pointsCommitted === 31);
  check("no snapshot, no row", h.seedRow({ key: "x", snapshots: [] }) === null);
  const bare = h.seedRow({ key: "40", snapshots: days });
  check("no freeze: dates from the snapshots, commitment absent and flagged",
    bare.start === "2026-10-12" && bare.pointsCommitted === null && bare.partial.jira === true);
}

// ── Sealing ──────────────────────────────────────────────────────────────────

section("rollover seals a row with the sprint's own GitHub window");

const stats = {
  since: "2026-09-01T00:00:00.000Z",
  truncated: [],
  failures: [],
  pullRequests: [
    { author: "ana", createdAt: "2026-10-13T10:00:00Z", mergedAt: "2026-10-14T10:00:00Z", toDefaultBranch: true, additions: 100, deletions: 20 },
    { author: "bo", createdAt: "2026-10-20T10:00:00Z", mergedAt: "2026-10-28T10:00:00Z", toDefaultBranch: true, additions: 50, deletions: 5 },
    { author: "zed", createdAt: "2026-10-15T10:00:00Z", mergedAt: "2026-10-16T10:00:00Z", toDefaultBranch: true, additions: 999, deletions: 999 },
  ],
  reviews: [{ author: "bo", prAuthor: "ana", submittedAt: "2026-10-13T15:00:00Z", comments: 0 }],
  comments: [],
  commits: [],
};
{
  const span = h.closingSpan([{ start: "2026-10-12", end: "2026-10-23" }]);
  const figures = h.githubFigures(stats, ["ana", "bo"], span);
  check("team logins only, inside the sprint's dates",
    figures.prsOpened === 2 && figures.prsMerged === 1 && figures.prsReviewed === 1, JSON.stringify(figures));
  check("lines are those merged inside the sprint", figures.additions === 100 && figures.deletions === 20);
  check("no logins is no figures, not zeros", h.githubFigures(stats, [], span) === null);
  check("no stats is no figures", h.githubFigures(null, ["ana"], span) === null);
  check("a fetch window starting after the sprint is partial",
    h.githubFigures({ ...stats, since: "2026-10-20T00:00:00Z" }, ["ana"], span).partial === true);
  check("a repository cut short is partial",
    h.githubFigures({ ...stats, truncated: ["org/repo"] }, ["ana"], span).partial === true);

  const seeded = h.seedRow({ key: "40", snapshots: days, freeze });
  const sealed = h.finalRow(seeded, figures);
  check("sealed rows are final, with the figures and no stray flag inside them",
    sealed.final && sealed.github.prsMerged === 1 && !("partial" in sealed.github));
  check("read on its last day, the Jira half is whole", sealed.partial.jira === false);
  const early = h.finalRow({ ...seeded, lastReading: "2026-10-20" }, null);
  check("last read before its last day, the Jira half is a floor", early.partial.jira === true);
  check("GitHub off seals with no GitHub half", early.github === null && early.partial.github === false);
  check("completion is of the commitment", Math.abs(h.completionRate(sealed) - 28 / 31) < 1e-9);
  check("or of the total, with none", h.completionRate({ pointsCommitted: null, pointsTotal: 40, pointsCompleted: 10 }) === 0.25);
  check("nothing to measure against is no rate", h.completionRate({ pointsCommitted: 0, pointsTotal: 0, pointsCompleted: 0 }) === null);
}

// ── The write ────────────────────────────────────────────────────────────────

section("the dashboard's write, end to end");

{
  local = {};
  const draft41 = h.draftRow({
    key: "41",
    sprints: [sprint(41, "Sprint 41", "2026-10-26", "2026-11-06")],
    summary,
    scope: { basis: "freeze", original: 38 },
    now: new Date(2026, 10, 3, 12),
  });
  let asked = null;
  const first = await h.recordSprintHistory({
    liveKey: "41",
    draft: draft41,
    snapshots: { 40: days, 41: [{ date: "2026-11-03" }] },
    freezes: { 40: freeze },
    logins: ["ana", "bo"],
    loadStats: async (span) => { asked = span; return stats; },
  });
  const rows = h.sprintHistoryRows(await h.loadSprintHistory());
  check("the running sprint is stored as a draft", rows.find((r) => r.key === "41")?.final === false);
  check("a stored sprint that is not running is seeded and sealed",
    rows.find((r) => r.key === "40")?.final === true && first.closed.length === 1);
  check("GitHub is asked once, over the closing sprint's dates",
    asked && asked.since === new Date(2026, 9, 12).toISOString() && asked.until === new Date(2026, 9, 24).toISOString(),
    JSON.stringify(asked));
  check("oldest first", rows.map((r) => r.key).join() === "40,41");

  // The next sprint starts: 41 rolls over.
  let calls = 0;
  const draft42 = { ...draft41, key: "42", name: "Sprint 42", start: "2026-11-09", end: "2026-11-20", lastReading: "2026-11-09" };
  await h.recordSprintHistory({
    liveKey: "42", draft: draft42, snapshots: {}, freezes: {}, logins: ["ana"],
    loadStats: async () => { calls++; return stats; },
  });
  const after = await h.loadSprintHistory();
  check("rollover seals the outgoing draft", after.rows["41"].final === true && calls === 1);
  check("a reading taken before its last day marks it incomplete", after.rows["41"].partial.jira === true);
  check("a sealed row is left alone by later loads", after.rows["40"].github.prsMerged === 1);

  // Nothing closing: GitHub is not asked at all.
  calls = 0;
  await h.recordSprintHistory({ liveKey: "42", draft: draft42, snapshots: {}, freezes: {}, loadStats: async () => { calls++; return stats; } });
  check("no closing sprint, no GitHub fetch", calls === 0);

  // A GitHub failure leaves a closing row as a draft, to retry next load.
  local = {};
  await h.recordSprintHistory({
    liveKey: "41", draft: draft41, snapshots: { 40: days }, freezes: { 40: freeze },
    loadStats: async () => { throw new Error("rate limited"); },
  });
  check("a failed GitHub fetch leaves the row unsealed",
    (await h.loadSprintHistory()).rows["40"].final === false);

  // A sprint reopened in Jira after it was sealed keeps the sealed row.
  const sealedStore = { rows: { 40: { ...h.finalRow(h.seedRow({ key: "40", snapshots: days, freeze }), null) } } };
  const planned = h.planUpdate(sealedStore, { liveKey: "40", draft: { ...draft41, key: "40" } });
  check("a final row is never overwritten by a draft", planned.rows["40"].final === true);
}

// ── Retention and the delete ─────────────────────────────────────────────────

section("retention, and a delete that stays deleted");

{
  const many = {};
  for (let i = 0; i < h.MAX_HISTORY_ROWS + 10; i++) {
    const d = new Date(2020, 0, 1 + i * 14);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    many[`s${i}`] = { key: `s${i}`, start: iso, final: true };
  }
  await h.saveSprintHistory({ rows: many });
  const kept = h.sprintHistoryRows(await h.loadSprintHistory());
  check(`capped at ${h.MAX_HISTORY_ROWS} rows`, kept.length === h.MAX_HISTORY_ROWS);
  check("the oldest are the ones dropped", kept[0].key === "s10");

  await h.clearSprintHistory(new Date(2026, 10, 5));
  const cleared = await h.loadSprintHistory();
  check("a delete empties the store and records its day",
    Object.keys(cleared.rows).length === 0 && cleared.clearedOn === "2026-11-05");
  const reseeded = h.planUpdate(cleared, { liveKey: "41", snapshots: { 40: days }, freezes: { 40: freeze } });
  check("snapshots from before the delete are not seeded back", !reseeded.rows["40"]);
  const later = h.planUpdate(cleared, { liveKey: "43", snapshots: { 42: [{ date: "2026-11-20", donePoints: 5 }] } });
  check("a sprint recorded after it still is", Boolean(later.rows["42"]));
  check("the size Settings shows", h.sprintHistorySize({ rows: { a: { key: "a", start: "2026-01-05", final: true }, b: { key: "b", start: "2026-02-02", final: false } } }).sprints === 1);
  check("a corrupt store reads as empty", h.sprintHistoryRows("nonsense").length === 0 && h.normalizeSprintHistory(null).clearedOn === null);
}

// ── The trend ────────────────────────────────────────────────────────────────

section("the trend the velocity card draws");

{
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ key: `s${i}`, name: `Sprint ${30 + i}`, start: `2026-0${1 + Math.floor(i / 2)}-${i % 2 ? "15" : "01"}`, final: true, pointsCompleted: 20 + i, partial: { jira: i === 6 } });
  }
  rows.push({ key: "live", name: "Sprint 38", start: "2026-06-01", final: false, pointsCompleted: 4, partial: { jira: false } });
  const trend = h.trendRows(rows, { liveKey: "live" });
  check("the last six closed, then the running sprint", trend.length === 7 && trend[0].key === "s2" && trend[6].key === "live");
  check("the running sprint is flagged, the closed are not", trend[6].running === true && trend.slice(0, 6).every((r) => !r.running));
  check("a closed sprint's view ends at it",
    h.trendRows(rows, { liveKey: "", upTo: "2026-02-15" }).map((r) => r.key).join() === "s0,s1,s2,s3");
  check("viewing a closed sprint, an unsealed draft is not drawn as closed",
    !h.trendRows(rows, { liveKey: "" }).some((r) => r.key === "live"));
  check("an unsealed row being sealed this load is drawn with the closed",
    h.trendRows([...rows, { key: "closing", start: "2026-05-20", final: false, pointsCompleted: 9 }], { liveKey: "live" })
      .some((r) => r.key === "closing" && !r.running));
  const mean = h.meanCompleted(trend);
  check("the mean leaves out the running sprint and incomplete rows",
    mean === Math.round(((22 + 23 + 24 + 25 + 27) / 5) * 10) / 10, String(mean));
  check("no mean below two sprints", h.meanCompleted([{ pointsCompleted: 5, partial: {} }]) === null);
  check("labels: \"Sprint 41: Payments\" is S41", h.shortSprintName("Sprint 41: Payments hardening") === "S41");
  check("labels: several boards count the rest", h.shortSprintName("Sprint 41 + PLAT 18 + DATA 7") === "S41 +2");
  check("labels: long names are cut", h.shortSprintName("Hardening and cleanup") === "Hardenin…");
  check("labels: no name is a dash", h.shortSprintName("") === "—");
}

// ── Backup ───────────────────────────────────────────────────────────────────

section("backup carries the history, and restore merges it");

{
  const sealed = { key: "40", final: true, lastReading: "2026-10-23", start: "2026-10-12" };
  const draft = { key: "41", final: false, lastReading: "2026-11-03", start: "2026-10-26" };
  const file = bk.buildBackup({ local: { sprintHistory: { rows: { 40: sealed, 41: draft }, clearedOn: "2026-01-01" } } });
  check("the backup holds the rows", Object.keys(file.stores.sprintHistory.rows).join() === "40,41");
  check("but not the device's delete day", !("clearedOn" in file.stores.sprintHistory));
  check("the description counts sealed sprints", bk.describeBackup(file).sprintHistory === 1);

  const m = bk.mergeSprintHistory({ rows: { 41: draft } }, { rows: { 40: sealed, 41: { ...draft, final: true } } });
  check("the file fills sprints the device lacks", Boolean(m.value.rows["40"]) && m.added === 1);
  check("a sealed row from the file replaces a draft here", m.value.rows["41"].final === true);
  const mine = bk.mergeSprintHistory({ rows: { 40: { ...sealed, pointsCompleted: 1 } } }, { rows: { 40: { ...sealed, pointsCompleted: 2 } } });
  check("otherwise the device's row wins", mine.value.rows["40"].pointsCompleted === 1 && mine.added === 0);
  const afterDelete = bk.mergeSprintHistory({ rows: {}, clearedOn: "2026-11-01" }, { rows: { 40: sealed } });
  check("a restore does not undo a delete with rows from before it", !afterDelete.value.rows["40"]);
  const old = bk.planRestore({ stores: {} }, { local: {} });
  check("a file from before M17 adds nothing and writes nothing", old.added.sprintHistory === 0 && !("sprintHistory" in old.localWrites));
}

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
