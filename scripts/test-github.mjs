#!/usr/bin/env node
// Unit checks for the GitHub sync layer (M11) — the pure parts: repo-reference
// parsing, API base derivation for github.com vs GHES, the aliased GraphQL
// document, response -> view model, review-state and staleness derivation,
// per-person slicing, and the roster matcher.
//
// The transport is exercised too, against a stubbed fetch, because the two
// behaviours that matter most are transport-shaped: a partial failure must
// degrade to "that one repo", and the token expiry header must be recorded.
//
// Usage: node scripts/test-github.mjs

const GITHUB_URL = new URL("../js/github.js", import.meta.url);
const CONFIG_URL = new URL("../js/config.js", import.meta.url);
const TEAM_URL = new URL("../js/team.js", import.meta.url);
const CREDS_URL = new URL("../js/credentials.js", import.meta.url);

let storage = {};      // chrome.storage.sync
let localStore = {};   // chrome.storage.local
let nextResponse = null;
let requests = [];

const pick = (store, keys) =>
  Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  );

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: {
      get: (keys, cb) => (cb ? cb(pick(storage, keys)) : Promise.resolve(pick(storage, keys))),
      set: (obj, cb) => { Object.assign(storage, obj); cb?.(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete storage[k]; cb?.(); return Promise.resolve(); },
    },
    local: {
      get: (keys, cb) => {
        const out = keys == null ? { ...localStore } : pick(localStore, keys);
        return cb ? cb(out) : Promise.resolve(out);
      },
      set: (obj, cb) => { Object.assign(localStore, obj); cb?.(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete localStore[k]; cb?.(); return Promise.resolve(); },
    },
  },
};

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("config.local.json")) return { ok: false, status: 404 };
  requests.push({ url: u, options });
  const resp = nextResponse || { status: 200, body: { data: {} }, headers: {} };
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    headers: { get: (name) => resp.headers?.[name.toLowerCase()] ?? null },
    json: async () => resp.body,
    text: async () => JSON.stringify(resp.body ?? ""),
  };
};

const gh = await import(GITHUB_URL);
const cfg = await import(CONFIG_URL);
const team = await import(TEAM_URL);
const creds = await import(CREDS_URL);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (title) => console.log(`\n── ${title} ──`);

// ─────────────────────────────────────────────────────────────────────────────
section("login normalisation");
check("plain login", team.normalizeGithubLogin("octocat") === "octocat");
check("leading @ dropped", team.normalizeGithubLogin("@octocat") === "octocat");
check("profile URL reduced", team.normalizeGithubLogin("https://github.com/octo-cat") === "octo-cat");
check("URL with trailing path", team.normalizeGithubLogin("https://github.com/octo-cat/repo") === "octo-cat");
check("inner hyphen allowed", team.normalizeGithubLogin("sam-lee") === "sam-lee");
check("double hyphen rejected", team.normalizeGithubLogin("sam--lee") === "");
check("leading hyphen rejected", team.normalizeGithubLogin("-sam") === "");
check("trailing hyphen rejected", team.normalizeGithubLogin("sam-") === "");
check("underscore rejected", team.normalizeGithubLogin("sam_lee") === "");
check("space rejected", team.normalizeGithubLogin("Sam Lee") === "");
check("39 chars allowed", team.normalizeGithubLogin("a".repeat(39)) === "a".repeat(39));
check("40 chars rejected", team.normalizeGithubLogin("a".repeat(40)) === "");
check("empty stays empty", team.normalizeGithubLogin("") === "");
check("case preserved", team.normalizeGithubLogin("OctoCat") === "OctoCat");

section("API base derivation");
check("github.com REST", gh.githubRestBase("github.com") === "https://api.github.com");
check("github.com GraphQL", gh.githubGraphqlUrl("github.com") === "https://api.github.com/graphql");
check("empty host defaults to github.com", gh.githubRestBase("") === "https://api.github.com");
check("GHES REST", gh.githubRestBase("github.example.com") === "https://github.example.com/api/v3");
check("GHES GraphQL", gh.githubGraphqlUrl("github.example.com") === "https://github.example.com/api/graphql");
check("scheme tolerated", gh.githubRestBase("https://github.example.com/") === "https://github.example.com/api/v3");
check("api.github.com folded back", gh.githubRestBase("api.github.com") === "https://api.github.com");
check("host casing normalised", gh.normalizeGithubHost("GitHub.Example.COM") === "github.example.com");
check("enterprise detected", gh.isEnterpriseHost("github.example.com") === true);
check("github.com is not enterprise", gh.isEnterpriseHost("github.com") === false);
check("github.com origin", gh.githubOrigin("github.com") === "https://api.github.com/*");
check("GHES origin covers the whole host", gh.githubOrigin("gh.internal") === "https://gh.internal/*");

section("repo references");
const ref = (input, owner) => {
  const parsed = gh.parseRepoRef(input, owner);
  return parsed ? gh.repoSlug(parsed) : null;
};
check("bare name takes the default org", ref("platform-api", "acme") === "acme/platform-api");
check("owner/name wins over the default", ref("other/platform-api", "acme") === "other/platform-api");
check("https URL", ref("https://github.com/acme/platform-api", "x") === "acme/platform-api");
check("URL with trailing path", ref("https://github.com/acme/platform-api/pull/12", "x") === "acme/platform-api");
check("URL with .git", ref("https://github.com/acme/platform-api.git", "x") === "acme/platform-api");
check("ssh remote", ref("git@github.com:acme/platform-api.git", "x") === "acme/platform-api");
check("GHES URL", ref("https://github.example.com/acme/api", "x") === "acme/api");
check("dots in repo name kept", ref("acme/docs.site", "x") === "acme/docs.site");
check("bare name without a default org is rejected", ref("platform-api", "") === null);
check("empty rejected", ref("   ", "acme") === null);
check("quote-injection rejected", ref('acme/a") { x } #', "acme") === null);
check("backslash rejected", ref("acme/a\\b", "acme") === null);
check("dot-only name rejected", ref("acme/..", "acme") === null);
check("bad owner rejected", ref("bad_owner/repo", "acme") === null);

const list = gh.parseRepoList(
  "platform-api\n acme/trading-ui \nhttps://github.com/acme/reporting\nplatform-api\nnot a repo\n",
  "acme"
);
check("list parsed", list.repos.map(gh.repoSlug).join(",") === "acme/platform-api,acme/trading-ui,acme/reporting");
check("duplicates collapsed", list.repos.length === 3);
check("unreadable lines reported, not dropped silently", list.invalid.length === 1 && list.invalid[0] === "not a repo");
check("comma-separated also works", gh.parseRepoList("a,b", "acme").repos.length === 2);

section("config gating");
const withGithub = (patch) => ({ github: patch });
check("off by default", gh.isGithubConfigured({}) === false);
check(
  "enabled with org and repos is configured",
  gh.isGithubConfigured(withGithub({ enabled: true, org: "acme", repos: ["acme/api"] })) === true
);
check(
  "enabled with no repos is NOT configured — the allowlist is the scope",
  gh.isGithubConfigured(withGithub({ enabled: true, org: "acme", repos: [] })) === false
);
check(
  "repos without enabled is off",
  gh.isGithubConfigured(withGithub({ enabled: false, org: "acme", repos: ["acme/api"] })) === false
);
check(
  "enabled without an org is off",
  gh.isGithubConfigured(withGithub({ enabled: true, org: "", repos: ["acme/api"] })) === false
);
const normalised = gh.githubConfig(withGithub({
  enabled: true,
  org: "Acme",
  host: "",
  repos: ["api", "Acme/api", "acme/web", "bad repo"],
}));
check("hand-edited config normalised", normalised.host === "github.com" && normalised.org === "Acme");
check("hand-edited repos deduped and cleaned", normalised.repos.map(gh.repoSlug).join(",") === "Acme/api,acme/web");

section("GraphQL document");
const repos = [
  { owner: "acme", name: "platform-api" },
  { owner: "acme", name: "trading-ui" },
];
const query = gh.buildActivityQuery(repos);
check("one aliased field per repo", /r0: repository\(owner: "acme", name: "platform-api"\)/.test(query));
check("second alias present", /r1: repository\(owner: "acme", name: "trading-ui"\)/.test(query));
check("no search() call — the repo list is the scope", !query.includes("search("));
check("open PRs requested", query.includes("openPullRequests: pullRequests(states: OPEN"));
check("merged PRs requested", query.includes("mergedPullRequests: pullRequests(states: MERGED"));
check("open issues requested", query.includes("openIssues: issues(states: OPEN"));
check("review requests included for the waiting-on-you lens", query.includes("reviewRequests(first: 10)"));
check("check rollup included", query.includes("statusCheckRollup"));
check(
  "an unsafe repo throws rather than being interpolated",
  (() => {
    try {
      gh.buildActivityQuery([{ owner: "acme", name: 'x") { y } #' }]);
      return false;
    } catch { return true; }
  })()
);

section("PR state derivation");
const state = (pr) => gh.prState(pr);
check("draft beats everything", state({ isDraft: true, reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE" }) === "draft");
check("changes requested", state({ reviewDecision: "CHANGES_REQUESTED" }) === "changes-requested");
check("failing checks", state({ checks: "FAILURE" }) === "checks-failing");
check("errored checks count as failing", state({ checks: "ERROR" }) === "checks-failing");
check("approved and unmerged", state({ reviewDecision: "APPROVED" }) === "approved");
check("approved but failing checks is still failing", state({ reviewDecision: "APPROVED", checks: "FAILURE" }) === "checks-failing");
check("default is waiting on review", state({ reviewDecision: "REVIEW_REQUIRED" }) === "waiting-review");
check("no signal at all is waiting on review", state({}) === "waiting-review");
check("pending checks do not count as failing", state({ checks: "PENDING" }) === "waiting-review");

const NOW = new Date("2026-08-07T12:00:00Z"); // a Friday
check("age in whole days", gh.ageDays("2026-08-04T12:00:00Z", NOW) === 3);
check("same day is zero", gh.ageDays("2026-08-07T09:00:00Z", NOW) === 0);
check("a future date does not go negative", gh.ageDays("2026-08-09T00:00:00Z", NOW) === 0);
check("missing date is zero", gh.ageDays(null, NOW) === 0);

section("merged-since window");
// Local date parts, not toISOString(): the cutoff is local midnight, and in any
// timezone east of UTC that instant is still "yesterday" in UTC.
const dayOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
check("Tuesday reaches back to Monday", dayOf(gh.mergedSince(new Date(2026, 7, 11, 9))) === "2026-08-10");
check("Monday reaches back to Friday", dayOf(gh.mergedSince(new Date(2026, 7, 10, 9))) === "2026-08-07");
check("Sunday reaches back to Friday", dayOf(gh.mergedSince(new Date(2026, 7, 9, 9))) === "2026-08-07");

section("response -> view model");
const payload = {
  data: {
    r0: {
      nameWithOwner: "acme/platform-api",
      openPullRequests: {
        nodes: [
          {
            number: 10, title: "Old, changes requested", url: "u10", isDraft: false,
            createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
            reviewDecision: "CHANGES_REQUESTED", author: { login: "SamLee" },
            reviewRequests: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          },
          {
            number: 11, title: "Waiting on Ada", url: "u11", isDraft: false,
            createdAt: "2026-08-05T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
            reviewDecision: "REVIEW_REQUIRED", author: { login: "samlee" },
            reviewRequests: {
              nodes: [
                { requestedReviewer: { __typename: "User", login: "ada" } },
                { requestedReviewer: { __typename: "Team", slug: "platform" } },
              ],
            },
            commits: { nodes: [] },
          },
          {
            number: 12, title: "Draft", url: "u12", isDraft: true,
            createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z",
            reviewDecision: null, author: { login: "ada" },
            reviewRequests: { nodes: [] }, commits: { nodes: [] },
          },
        ],
      },
      mergedPullRequests: {
        nodes: [
          { number: 8, title: "Shipped today", url: "u8", mergedAt: "2026-08-07T08:00:00Z", author: { login: "samlee" } },
          { number: 7, title: "Shipped last month", url: "u7", mergedAt: "2026-07-01T08:00:00Z", author: { login: "samlee" } },
        ],
      },
      openIssues: {
        nodes: [
          {
            number: 40, title: "Flaky test", url: "u40",
            createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
            author: { login: "ada" }, assignees: { nodes: [{ login: "SamLee" }] },
          },
        ],
      },
    },
  },
  errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve to a Repository" }],
};

const activity = gh.toActivity(payload, repos, { now: NOW });
check("PRs collected", activity.pullRequests.length === 3);
check("merged collected", activity.merged.length === 2);
check("issues collected", activity.issues.length === 1);
check("reached repos recorded", activity.reached.join() === "acme/platform-api");
check("failing repo attributed by alias, not swallowed", activity.failures[0]?.repo === "acme/trading-ui");
check("failure keeps GitHub's message", /Could not resolve/.test(activity.failures[0]?.message || ""));
check("one repo failing does not fail the fetch", activity.pullRequests.length > 0);
check("most stuck first", activity.pullRequests[0].number === 10);
check("draft last", activity.pullRequests[2].number === 12);
check("team review requests kept separate from user ones",
  activity.pullRequests.find((p) => p.number === 11).reviewers.join() === "ada");
check("age derived", activity.pullRequests[0].ageDays === 10);
check("repo stamped on every row", activity.pullRequests.every((p) => p.repo === "acme/platform-api"));

check(
  "a missing alias with no error is still reported",
  gh.toActivity({ data: {} }, repos, { now: NOW }).failures.length === 2
);

section("per-person slices");
const sam = gh.activityFor(activity, "samlee", { now: NOW });
check("own open PRs, case-insensitively matched", sam.open.length === 2);
check("someone else's draft excluded", !sam.open.some((p) => p.number === 12));
check("nothing waiting on Sam", sam.reviewRequests.length === 0);
check("merged today included", sam.merged.some((p) => p.number === 8));
check("merged last month excluded", !sam.merged.some((p) => p.number === 7));
check("assigned issue matched case-insensitively", sam.issues.length === 1);

const ada = gh.activityFor(activity, "ada", { now: NOW });
check("Ada's own draft is hers", ada.open.length === 1 && ada.open[0].number === 12);
check("PR waiting on Ada is in her review list", ada.reviewRequests.length === 1);
check("a review request is not counted as her own work", !ada.open.some((p) => p.number === 11));

const nobody = gh.activityFor(activity, "", { now: NOW });
check("no login yields nothing, never everything", nobody.open.length === 0 && nobody.issues.length === 0);

section("roster matcher");
const proposal = gh.proposeGithubMatches(
  [
    { accountId: "1", jiraName: "Sam Lee", githubLogin: "", email: "" },
    { accountId: "2", jiraName: "Ada Byron", githubLogin: "", email: "" },
    { accountId: "3", jiraName: "Jo Park", githubLogin: "jopark", email: "" },
    { accountId: "4", jiraName: "Chris Kim", githubLogin: "", email: "" },
    { accountId: "5", jiraName: "Unlinked Person", githubLogin: "", email: "" },
  ],
  [
    { login: "sam-lee" }, { login: "abyron" }, { login: "jopark" },
    { login: "chriskim" }, { login: "chris-kim" }, { login: "someone-else" },
  ]
);
const matchFor = (id) => proposal.matches.find((m) => m.accountId === id)?.login;
check("hyphenated login matched to a two-word name", matchFor("1") === "sam-lee");
check("initial + surname matched", matchFor("2") === "abyron");
check("a member who already has a login is left alone", !proposal.matches.some((m) => m.accountId === "3"));
check("ambiguous match is not guessed", matchFor("4") === undefined);
check("ambiguity reported rather than dropped", proposal.ambiguous.some((a) => a.accountId === "4"));
check("no match for an unrecognisable name", matchFor("5") === undefined);
check("unclaimed org logins reported", proposal.unclaimed.includes("someone-else"));

const emailProposal = gh.proposeGithubMatches(
  [{ accountId: "1", jiraName: "", email: "octo.cat@example.com", githubLogin: "" }],
  [{ login: "octocat" }]
);
check("email local part used as a fallback key", emailProposal.matches[0]?.login === "octocat");

section("expiry header");
check("ISO parsed", gh.parseExpiryHeader("2026-12-31T23:59:59Z") === "2026-12-31");
check("GitHub's spaced format parsed", gh.parseExpiryHeader("2026-12-31 23:59:59 +0000") === "2026-12-31");
check("offset format parsed", gh.parseExpiryHeader("2027-01-15 12:00:00 -0800") === "2027-01-15");
check("absent header -> null", gh.parseExpiryHeader("") === null);
check("junk -> null", gh.parseExpiryHeader("soon") === null);

section("credential separation");
localStore = {};
await creds.saveCredentials({ email: "a@b.c", token: "jira-token" });
await creds.saveGithubToken("gh-token");
check("both tokens stored", localStore.token === "jira-token" && localStore.githubToken === "gh-token");
check("GitHub expiry starts unknown rather than guessed", localStore.githubTokenExpiresAt === null);
await creds.recordGithubTokenExpiry("2026-12-01");
check("expiry recorded from a response", localStore.githubTokenExpiresAt === "2026-12-01");
let ghStatus = await creds.githubTokenStatus(new Date("2026-11-25"));
check("expiring soon detected", ghStatus.expiringSoon === true && ghStatus.expired === false);
ghStatus = await creds.githubTokenStatus(new Date("2026-12-10"));
check("expired detected", ghStatus.expired === true);
await creds.clearGithubToken();
check("forgetting GitHub keeps Jira working", !localStore.githubToken && localStore.token === "jira-token");
check("Jira status untouched by GitHub", (await creds.tokenStatus()).hasToken === true);
await creds.recordGithubTokenExpiry("2027-01-01");
check("no token means no expiry to record", localStore.githubTokenExpiresAt === undefined);

section("transport");
storage = {
  site: { baseUrl: "https://x.atlassian.net" },
  github: { enabled: true, host: "github.com", org: "acme", repos: ["acme/platform-api", "acme/trading-ui"] },
};
await cfg.loadConfig();
localStore = {};
await creds.saveGithubToken("gh-token");
requests = [];
nextResponse = { status: 200, body: payload, headers: { "github-authentication-token-expiration": "2026-10-01 00:00:00 +0000" } };

const fetched = await gh.fetchTeamActivity({ now: NOW });
check("one request for every declared repo", requests.length === 1);
check("posted to the GraphQL endpoint", requests[0].url === "https://api.github.com/graphql");
check("bearer auth", requests[0].options.headers.Authorization === "Bearer gh-token");
check("query names both repos", /platform-api[\s\S]*trading-ui/.test(requests[0].options.body));
check("view model returned", fetched.pullRequests.length === 3);
await new Promise((r) => setTimeout(r, 0));   // the expiry write is fire-and-forget
check("expiry recorded from the response header", localStore.githubTokenExpiresAt === "2026-10-01");

storage.github = { enabled: true, host: "github.com", org: "acme", repos: [] };
await cfg.loadConfig();
let threw = "";
try { await gh.fetchTeamActivity({ now: NOW }); } catch (err) { threw = err.message; }
check("no repos means no request at all", /No repositories/.test(threw));

storage.github = { enabled: true, host: "github.com", org: "acme", repos: ["acme/platform-api"] };
await cfg.loadConfig();
await creds.clearGithubToken();
threw = "";
try { await gh.fetchTeamActivity({ now: NOW }); } catch (err) { threw = err.message; }
check("no token means no request", /No GitHub token/.test(threw));

await creds.saveGithubToken("gh-token");
requests = [];
nextResponse = { status: 401, body: { message: "Bad credentials" }, headers: {} };
let caught = null;
try { await gh.fetchTeamActivity({ now: NOW }); } catch (err) { caught = err; }
check("401 surfaces as an auth-kind error", caught?.kind === "auth" && caught.status === 401);

nextResponse = { status: 403, body: { message: "API rate limit exceeded" }, headers: {} };
caught = null;
try { await gh.fetchTeamActivity({ now: NOW }); } catch (err) { caught = err; }
check("rate limit told apart from a permission refusal", caught?.kind === "rate-limit");

nextResponse = { status: 200, body: { errors: [{ message: "Bad credentials" }] }, headers: {} };
caught = null;
try { await gh.fetchTeamActivity({ now: NOW }); } catch (err) { caught = err; }
check("a whole-query GraphQL failure throws", caught?.kind === "graphql");

section("repo access check");
requests = [];
nextResponse = { status: 200, body: { private: true }, headers: {} };
const access = await gh.checkRepoAccess(repos, { host: "github.com" }, "gh-token");
check("one REST call per repo", requests.length === 2);
check("private flag reported", access[0].ok === true && access[0].private === true);
nextResponse = { status: 404, body: { message: "Not Found" }, headers: {} };
const denied = await gh.checkRepoAccess([repos[0]], { host: "github.com" }, "gh-token");
check("an unreachable repo is a per-repo verdict, not an exception", denied[0].ok === false);
check("verdict carries a reason", /404/.test(denied[0].error));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
