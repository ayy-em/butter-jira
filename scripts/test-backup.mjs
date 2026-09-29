#!/usr/bin/env node
// Unit checks for the device backup: what goes in the file and what never does,
// and the restore rule — the device's own data wins, the backup fills the gaps.
//
// Usage: node scripts/test-backup.mjs

const store = { local: {}, sync: {} };
const area = (name) => ({
  get: async (keys) => (keys == null ? { ...store[name] } : Object.fromEntries([].concat(keys).filter((k) => k in store[name]).map((k) => [k, store[name][k]]))),
  set: async (o) => { Object.assign(store[name], o); },
  remove: async () => {},
});
globalThis.chrome = { runtime: { getURL: (p) => p }, storage: { local: area("local"), sync: area("sync") } };
globalThis.fetch = async () => ({ ok: false, status: 404 });

const b = await import(new URL("../js/backup.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const local = {
  email: "someone@example.com",
  token: "secret-jira",
  githubToken: "secret-gh",
  oneOnes: { people: { "acc-1": { sessions: [{ id: "s1" }] } } },
  cache_sprintIssues_1_2: { value: [] },
  sprintSnapshots: { "10": [{ date: "2026-09-01", totalPoints: 5 }, { date: "2026-09-02", totalPoints: 4 }] },
  sprintFreezes: { "10": { takenAt: "2026-09-01T08:00:00Z", rows: [{ key: "A-1" }] } },
  myTodos: [{ id: "t1", text: "Mine" }],
  teams: { activeTeamId: "default", teams: [{ id: "default", members: [{ accountId: "acc-1", jiraName: "Ada" }] }] },
  standupPrefs: { durations: {} },
  schemaVersion: 2,
};
const sync = { site: { baseUrl: "https://x.atlassian.net" }, boards: [{ id: 1 }] };

section("building");
const plain = b.buildBackup({ local, sync, now: new Date("2026-09-29T10:00:00Z") });
const text = JSON.stringify(plain);
check("format and version stamped", plain.format === b.BACKUP_FORMAT && plain.version === 1);
check("no tokens or email", !text.includes("secret-jira") && !text.includes("secret-gh") && !text.includes("someone@example.com"));
check("no 1:1 notes", !("oneOnes" in plain.stores) && !text.includes('"s1"'));
check("no response caches", !text.includes("cache_"));
check("snapshots, freezes, todos, config, prefs included",
  plain.stores.snapshots["10"].length === 2 && plain.stores.freezes["10"] && plain.stores.todos.length === 1 &&
  plain.config.site.baseUrl && plain.preferences.standupPrefs);
check("roster only when asked", !plain.stores.roster && b.buildBackup({ local, sync, includeRoster: true }).stores.roster);
check("filename is dated", b.backupFilename(new Date("2026-09-29T10:00:00Z")) === "butterjira-backup-2026-09-29.json");

section("reading");
check("a backup parses", b.parseBackup(text).ok);
check("a config export is pointed at Import config", /Import config/.test(b.parseBackup(JSON.stringify({ format: "butterjira-config" })).error));
check("a newer version is refused", !b.parseBackup(JSON.stringify({ ...plain, version: 99 })).ok);
check("garbage is refused", !b.parseBackup("{nope").ok);

section("merging — the device wins, the backup fills gaps");
const snaps = b.mergeSnapshots(
  { "10": [{ date: "2026-09-02", totalPoints: 99 }] },
  { "10": [{ date: "2026-09-01", totalPoints: 5 }, { date: "2026-09-02", totalPoints: 4 }], "11": [{ date: "2026-09-15" }] }
);
check("missing days are added", snaps.value["10"].length === 2 && snaps.added === 2);
check("a day both have keeps the device's row", snaps.value["10"].find((d) => d.date === "2026-09-02").totalPoints === 99);
check("days stay in order", snaps.value["10"][0].date === "2026-09-01");
const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), [{ date: `2026-01-${String(i + 1).padStart(2, "0")}` }]]));
check("the 8-sprint bound still holds", Object.keys(b.mergeSnapshots({}, many).value).length === 8);
const frz = b.mergeFreezes({ "10": { rows: [], takenAt: "b" } }, { "10": { rows: [1], takenAt: "a" }, "11": { rows: [], takenAt: "c" } });
check("a freeze already here is kept", frz.value["10"].takenAt === "b" && frz.added === 1);
const todos = b.mergeTodos([{ id: "t1", text: "mine" }], [{ id: "t1", text: "old" }, { id: "t2", text: "new" }]);
check("todos union by id, device wins", todos.value.length === 2 && todos.value[0].text === "mine" && todos.added === 1);
const roster = b.mergeRoster(local.teams, { teams: [{ id: "default", members: [{ accountId: "acc-1", jiraName: "Old" }, { accountId: "acc-2" }] }, { id: "t2", members: [{ email: "x@y" }] }] });
check("roster adds missing people and teams only", roster.added === 2 && roster.value.teams[0].members[0].jiraName === "Ada");
check("an empty device roster takes the backup's", b.mergeRoster({ teams: [{ id: "default", members: [] }] }, local.teams).added === 1);

section("planning a restore");
const plan = b.planRestore(plain, { local: { myTodos: [] }, sync: {} });
check("config restored onto an unconfigured install", plan.config === "restored" && plan.syncWrites.site);
check("preferences fill in where none exist", plan.localWrites.standupPrefs && plan.added.preferences === 1);
const plan2 = b.planRestore(plain, { local, sync });
check("config kept on a configured install", plan2.config === "kept" && !Object.keys(plan2.syncWrites).length);
check("existing preferences are not touched", !("standupPrefs" in plan2.localWrites));
check("restoring onto the same data adds nothing", plan2.added.snapshotDays === 0 && plan2.added.todos === 0 && plan2.added.freezes === 0);
check("a restore never writes tokens or 1:1 notes", !["token", "githubToken", "email", "oneOnes"].some((k) => k in plan.localWrites));

section("through storage");
Object.assign(store.local, local);
Object.assign(store.sync, sync);
const made = await b.createBackup();
check("createBackup reads the device", made.stores.todos.length === 1 && made.config.site.baseUrl);
store.local.myTodos = [];
await b.applyRestore(b.planRestore(made, await b.readDeviceState()));
check("applyRestore writes the merge", store.local.myTodos.length === 1 && store.local.token === "secret-jira");

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
