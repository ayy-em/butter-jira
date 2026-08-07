#!/usr/bin/env node
// Unit checks for the team roster: storage shape, deduplication, display-name
// resolution, pending-member linking, the team-only filter, and roster
// export/import. No dependencies, no network, no browser.
//
// Usage: node scripts/test-team.mjs

const TEAM_URL = new URL("../js/team.js", import.meta.url);
const UTILS_URL = new URL("../js/utils.js", import.meta.url);
const FILTERS_URL = new URL("../js/components/filters.js", import.meta.url);
const CONFIG_URL = new URL("../js/config.js", import.meta.url);
const PORTABLE_URL = new URL("../js/portable.js", import.meta.url);

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
      get: (keys, cb) => cb(pick(sync, keys)),
      set: (obj, cb) => { Object.assign(sync, obj); cb?.(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete sync[k]; cb?.(); return Promise.resolve(); },
    },
    local: {
      get: (keys, cb) => {
        const out = keys == null ? { ...local } : pick(local, keys);
        return cb ? cb(out) : Promise.resolve(out);
      },
      set: (obj, cb) => { Object.assign(local, obj); cb?.(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete local[k]; cb?.(); return Promise.resolve(); },
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });
// filters.js registers a document-level click handler on import.
globalThis.document = { addEventListener: () => {}, querySelectorAll: () => [] };

const team = await import(TEAM_URL);
const utils = await import(UTILS_URL);
const filters = await import(FILTERS_URL);
const cfg = await import(CONFIG_URL);
const portable = await import(PORTABLE_URL);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const issue = (assignee, extra = {}) => ({ key: "ABC-1", fields: { assignee, ...extra } });
const person = (id, name, email = "") => ({ accountId: id, jiraName: name, email });

section("empty roster");
local = {};
await team.loadTeam();
check("default team created", team.activeTeam().id === team.DEFAULT_TEAM_ID);
check("no members", team.allMembers().length === 0);
check("hasRoster false", team.hasRoster() === false);
check("isOnTeam false for anyone", team.isOnTeam("acc-1") === false);
check("unknown accountId -> no member", team.memberFor("acc-1") === null);
check("null accountId tolerated", team.memberFor(null) === null);

section("normalizeMember");
let m = team.normalizeMember({ accountId: "  acc-1  ", email: " A@B.co ", displayName: "Ada Lovelace" });
check("accountId trimmed", m.accountId === "acc-1");
check("email trimmed", m.email === "A@B.co");
check("displayName read as jiraName", m.jiraName === "Ada Lovelace");
check("active defaults true", m.active === true);
check("capacity object present", typeof m.capacity === "object");
check("blank accountId -> null", team.normalizeMember({ accountId: "   " }).accountId === null);
check("emoji clipped to 4 chars", team.normalizeMember({ emoji: "🙂🙂🙂🙂🙂" }).emoji.length <= 4);
check("active:false respected", team.normalizeMember({ active: false }).active === false);

section("save + load round-trip");
local = {};
await team.loadTeam();
await team.saveMembers([person("acc-1", "Ada Lovelace"), person("acc-2", "Alan Turing")]);
check("stored device-local", Boolean(local.teams) && !("teams" in sync));
await team.loadTeam();
check("members reloaded", team.allMembers().length === 2);
check("hasRoster true", team.hasRoster() === true);
check("isOnTeam true", team.isOnTeam("acc-1") === true);
check("team shape carries id list for later switching",
  Array.isArray(team.TEAMS.teams) && team.TEAMS.activeTeamId === team.DEFAULT_TEAM_ID);

section("deduplication");
await team.saveMembers([
  person("acc-1", "Ada Lovelace", "ada@example.com"),
  person("acc-1", "Ada L."),                          // same accountId
  { email: "ada@example.com", jiraName: "Ada" },       // same email, no id
  person("acc-9", "Grace Hopper"),
]);
check("one entry per person", team.allMembers().length === 2);
check("first accountId kept", team.allMembers()[0].accountId === "acc-1");
check("email merged onto id entry", team.allMembers()[0].email === "ada@example.com");
check("distinct person kept", team.allMembers()[1].accountId === "acc-9");

section("active vs inactive vs unlinked");
await team.saveMembers([
  { ...person("acc-1", "Ada Lovelace"), active: true },
  { ...person("acc-2", "Alan Turing"), active: false },
  { email: "grace@example.com", jiraName: "Grace Hopper" },
]);
check("allMembers counts everyone", team.allMembers().length === 3);
check("activeMembers excludes inactive and unlinked", team.activeMembers().length === 1);
check("pendingMembers finds the unlinked one", team.pendingMembers().length === 1);
check("inactive member is not on team", team.isOnTeam("acc-2") === false);
check("inactive member still resolvable", team.memberFor("acc-2")?.jiraName === "Alan Turing");

section("display names");
await team.saveMembers([
  { ...person("acc-1", "Ada Augusta Lovelace"), nameOverride: "Ada" },
  { ...person("acc-2", "Alan Mathison Turing") },
  { ...person("acc-3", "Grace Hopper"), emoji: "🚀", nameOverride: "Amazing Grace" },
]);
check("override wins", team.displayNameFor({ accountId: "acc-1", displayName: "Ada Augusta Lovelace" }) === "Ada");
check("no override -> first + last", team.displayNameFor({ accountId: "acc-2", displayName: "Alan Mathison Turing" }) === "Alan Turing");
check("emoji prefixed", team.displayNameFor({ accountId: "acc-3", displayName: "Grace Hopper" }) === "🚀 Amazing Grace");
check("off-roster falls back to Jira name",
  team.displayNameFor({ accountId: "acc-99", displayName: "Katherine Goble Johnson" }) === "Katherine Johnson");
check("null assignee -> Unassigned", team.displayNameFor(null) === "Unassigned");
check("single-word name survives", team.displayNameFor({ accountId: "x", displayName: "Prince" }) === "Prince");
check("shortenName handles empty", team.shortenName("") === "—");
check("memberLabel prefers override", team.memberLabel(team.allMembers()[0]) === "Ada");
check("memberLabel falls back to email",
  team.memberLabel(team.normalizeMember({ email: "x@example.com" })) === "x@example.com");

section("utils integration");
check("assigneeLabel uses roster",
  utils.assigneeLabel({ accountId: "acc-1", displayName: "Ada Augusta Lovelace" }) === "Ada");
check("local avatar override wins over Jira's",
  (await (async () => {
    await team.saveMembers([{ ...person("acc-1", "Ada"), avatarOverride: "assets/avatars/ada.png" }]);
    return utils.getAvatarUrl(issue({ accountId: "acc-1", avatarUrls: { "24x24": "https://jira/x.png" } }));
  })()) === "chrome-extension://test/assets/avatars/ada.png");
check("member's stored Jira avatar is not an override",
  (await (async () => {
    await team.saveMembers([{ ...person("acc-1", "Ada"), avatarUrl: "https://example.com/a.png" }]);
    return utils.getAvatarUrl(issue({ accountId: "acc-1", avatarUrls: { "24x24": "https://jira/x.png" } }));
  })()) === "https://jira/x.png");
check("jira avatar used when no override",
  utils.getAvatarUrl(issue({ accountId: "acc-77", avatarUrls: { "24x24": "https://jira/y.png" } })) === "https://jira/y.png");
check("no assignee -> null avatar", utils.getAvatarUrl(issue(null)) === null);

section("avatar override paths");
check("bare relative path kept", team.normalizeAvatarPath("assets/avatars/a.png") === "assets/avatars/a.png");
check("leading slash stripped", team.normalizeAvatarPath("/assets/avatars/a.png") === "assets/avatars/a.png");
check("whitespace trimmed", team.normalizeAvatarPath("  assets/a.png  ") === "assets/a.png");
check("http url rejected", team.normalizeAvatarPath("https://evil.example/a.png") === "");
check("data url rejected", team.normalizeAvatarPath("data:image/png;base64,AAA") === "");
check("traversal rejected", team.normalizeAvatarPath("../../etc/passwd") === "");
check("traversal mid-path rejected", team.normalizeAvatarPath("assets/../../x.png") === "");
check("empty stays empty", team.normalizeAvatarPath("") === "");
check("dots inside a filename are fine", team.normalizeAvatarPath("assets/a..b.png") === "assets/a..b.png");

section("slack handles");
check("bare handle kept", team.normalizeSlackHandle("ada") === "ada");
check("leading @ stripped", team.normalizeSlackHandle("@ada") === "ada");
check("repeated @ stripped", team.normalizeSlackHandle("@@ada") === "ada");
check("dots, dashes, underscores kept", team.normalizeSlackHandle("ada.lovelace_x-1") === "ada.lovelace_x-1");
// Slack display names carry spaces and accents — the digest has to reproduce
// them verbatim or the @-mention matches nobody.
check("spaces kept", team.normalizeSlackHandle("Ada Lovelace") === "Ada Lovelace");
check("leading @ stripped from a spaced name", team.normalizeSlackHandle("@Ada Lovelace") === "Ada Lovelace");
check("space after the @ tolerated", team.normalizeSlackHandle("@ Ada Lovelace") === "Ada Lovelace");
check("non-ascii kept", team.normalizeSlackHandle("Renée Örn") === "Renée Örn");
check("outer whitespace trimmed", team.normalizeSlackHandle("  ada  ") === "ada");
check("runs of whitespace collapsed", team.normalizeSlackHandle("Ada   Lovelace") === "Ada Lovelace");
check("newlines flattened", team.normalizeSlackHandle("Ada\nLovelace") === "Ada Lovelace");
check("tabs flattened", team.normalizeSlackHandle("Ada\tLovelace") === "Ada Lovelace");
check("no trailing space after truncation", (() => {
  const out = team.normalizeSlackHandle(`${"a".repeat(79)} bcd`);
  return out.length === 79 && !/\s$/.test(out);
})());
check("empty stays empty", team.normalizeSlackHandle("") === "");
check("only-@ stays empty", team.normalizeSlackHandle("@") === "");
check("undefined stays empty", team.normalizeSlackHandle(undefined) === "");
check("mention uses handle",
  (await (async () => {
    await team.saveMembers([{ ...person("acc-1", "Ada Lovelace"), slackHandle: "@ada" }]);
    return team.slackMentionFor("acc-1");
  })()) === "@ada");
check("mention falls back to display name",
  (await (async () => {
    await team.saveMembers([{ ...person("acc-1", "Ada Lovelace") }]);
    return team.slackMentionFor("acc-1");
  })()) === "Ada Lovelace");

section("github login on the roster");
check("stored normalised", team.normalizeMember({ githubLogin: "@Sam-Lee" }).githubLogin === "Sam-Lee");
check("unusable login stored as empty rather than as junk",
  team.normalizeMember({ githubLogin: "sam lee" }).githubLogin === "");
check("absent login is empty, not undefined",
  team.normalizeMember({}).githubLogin === "");
check("login survives a save/load round trip",
  (await (async () => {
    await team.saveMembers([{ ...person("acc-1", "Sam Lee"), githubLogin: "samlee" }]);
    await team.loadTeam();
    return team.githubLoginFor("acc-1");
  })()) === "samlee");
check("lookup by login is case-insensitive",
  team.memberByGithubLogin("SAMLEE")?.accountId === "acc-1");
check("unknown login resolves to nobody", team.memberByGithubLogin("stranger") === null);
check("empty login resolves to nobody, not to the first member",
  team.memberByGithubLogin("") === null);
check("no login means no login", team.githubLoginFor("acc-nope") === "");

section("overdue detection");
const overdueIssue = (duedate, statusKey) => ({
  fields: { duedate, status: { statusCategory: { key: statusKey } } },
});
check("past due and in progress is overdue",
  utils.isOverdue(overdueIssue("2026-08-01", "indeterminate"), new Date(2026, 7, 6)) === true);
check("past due but done is not overdue",
  utils.isOverdue(overdueIssue("2026-08-01", "done"), new Date(2026, 7, 6)) === false);
check("due today is not overdue",
  utils.isOverdue(overdueIssue("2026-08-06", "indeterminate"), new Date(2026, 7, 6)) === false);
check("due tomorrow is not overdue",
  utils.isOverdue(overdueIssue("2026-08-07", "indeterminate"), new Date(2026, 7, 6)) === false);
check("no due date is never overdue",
  utils.isOverdue(overdueIssue(undefined, "indeterminate"), new Date(2026, 7, 6)) === false);
check("year boundary compares correctly",
  utils.isOverdue(overdueIssue("2025-12-31", "new"), new Date(2026, 0, 1)) === true);
check("todayIso pads single digits", utils.todayIso(new Date(2026, 0, 5)) === "2026-01-05");

section("extractAssignees ordering and flags");
await team.saveMembers([person("acc-1", "Ada Lovelace"), person("acc-2", "Alan Turing")]);
let extracted = utils.extractAssignees([
  issue({ accountId: "acc-9", displayName: "Zoe Outsider" }),
  issue({ accountId: "acc-2", displayName: "Alan Turing" }),
  issue(null),
  issue({ accountId: "acc-1", displayName: "Ada Lovelace" }),
  issue({ accountId: "acc-1", displayName: "Ada Lovelace" }),
]);
check("deduped", extracted.length === 3);
check("team members first", extracted[0].onTeam && extracted[1].onTeam && !extracted[2].onTeam);
check("alphabetical within group", extracted[0].displayName === "Ada Lovelace");
check("outsider flagged", extracted[2].onTeam === false);
check("unassigned ignored", !extracted.some((a) => a.accountId === undefined));
check("jiraName retained", extracted[2].jiraName === "Zoe Outsider");

section("team-only filter");
const rosterIssue = issue({ accountId: "acc-1", displayName: "Ada Lovelace" });
const outsideIssue = issue({ accountId: "acc-9", displayName: "Zoe Outsider" });
const unassignedIssue = issue(null);
check("outsider detected", team.isOutsideTeam(outsideIssue) === true);
check("member not outsider", team.isOutsideTeam(rosterIssue) === false);
check("unassigned not treated as outsider", team.isOutsideTeam(unassignedIssue) === false);

const baseState = { boards: [], types: [], assigneeIds: [], statuses: [], search: "" };
let kept = filters.applyFilters([rosterIssue, outsideIssue, unassignedIssue], { ...baseState, teamOnly: true });
check("team-only drops outsiders", kept.length === 2);
check("team-only keeps unassigned", kept.includes(unassignedIssue));
check("team-only keeps members", kept.includes(rosterIssue));
kept = filters.applyFilters([rosterIssue, outsideIssue, unassignedIssue], { ...baseState, teamOnly: false });
check("filter off keeps everything", kept.length === 3);

section("team-only preference persistence");
local = {}; await team.loadTeam();
check("defaults off", (await team.loadTeamOnly()) === false);
await team.setTeamOnly(true);
check("persisted", local.teamOnly === true);
check("read back", (await team.loadTeamOnly()) === true);
check("isTeamOnly reflects it", team.isTeamOnly() === true);
check("not written to synced storage", !("teamOnly" in sync));

section("linking members added by email");
const staged = [
  team.normalizeMember({ email: "grace@example.com", nameOverride: "Grace" }),
  team.normalizeMember(person("acc-1", "Ada Lovelace")),
];
let linkResult = team.linkPendingMembers(staged, [
  { accountId: "acc-7", email: "grace@example.com", displayName: "Grace Hopper", avatarUrl: "https://x/g.png" },
]);
check("one linked", linkResult.linked === 1);
check("accountId filled in", linkResult.members[0].accountId === "acc-7");
check("override preserved", linkResult.members[0].nameOverride === "Grace");
check("jira name backfilled", linkResult.members[0].jiraName === "Grace Hopper");
check("avatar backfilled", linkResult.members[0].avatarUrl === "https://x/g.png");
check("already-linked untouched", linkResult.members[1].accountId === "acc-1");
linkResult = team.linkPendingMembers(staged, [
  { accountId: "acc-8", email: "GRACE@EXAMPLE.COM", displayName: "Grace H" },
]);
check("email match is case-insensitive", linkResult.linked === 1);
linkResult = team.linkPendingMembers(staged, [{ accountId: "acc-9", email: "someone@example.com" }]);
check("no match -> nothing linked", linkResult.linked === 0);
check("harvest without email cannot link",
  team.linkPendingMembers(staged, [{ accountId: "acc-9", displayName: "Grace Hopper" }]).linked === 0);

section("upsert / remove");
let list = [];
list = team.upsertMember(list, person("acc-1", "Ada"));
list = team.upsertMember(list, person("acc-1", "Ada Again"));
check("upsert dedupes", list.length === 1);
list = team.upsertMember(list, { email: "g@example.com", jiraName: "Grace" });
check("distinct email added", list.length === 2);
list = team.removeMember(list, { accountId: "acc-1" });
check("removed by accountId", list.length === 1 && list[0].email === "g@example.com");
list = team.removeMember(list, { email: "g@example.com" });
check("removed by email", list.length === 0);

section("roster export is opt-in");
sync = { site: { baseUrl: "https://x.atlassian.net" } };
local = { schemaVersion: 2 };
await cfg.loadConfig();
const members = [team.normalizeMember({ ...person("acc-1", "Ada Lovelace", "ada@example.com"), nameOverride: "Ada" })];
let payload = portable.buildExport({ now: new Date("2026-08-05T12:00:00Z"), members });
check("roster absent by default", payload.team === undefined);
check("no personal data flag", payload.containsPersonalData === undefined);
check("no colleague email in file", !JSON.stringify(payload).includes("ada@example.com"));
payload = portable.buildExport({ now: new Date("2026-08-05T12:00:00Z"), members, includeRoster: true });
check("roster present when asked", payload.team.members.length === 1);
check("personal data flagged", payload.containsPersonalData === true);
check("override carried", payload.team.members[0].nameOverride === "Ada");

section("roster import");
let parsed = portable.parseImport(JSON.stringify(payload));
check("roster parsed", parsed.ok && parsed.members.length === 1);
check("import warns about personal data", parsed.warnings.some((w) => w.includes("roster")));
parsed = portable.parseImport(JSON.stringify(portable.buildExport({ members })));
check("absent roster -> undefined, not empty", parsed.members === undefined);
parsed = portable.parseImport(JSON.stringify({
  format: portable.EXPORT_FORMAT,
  team: { members: [person("acc-1", "Ada"), {}, { nameOverride: "ghost" }] },
}));
check("identifierless entries dropped", parsed.members.length === 1);
check("drop warning raised", parsed.warnings.some((w) => w.includes("roster entr")));
check("roster-only file is importable", parsed.ok === true);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
