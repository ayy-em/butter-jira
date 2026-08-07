// GitHub sync: open pull requests, recent merges and open issues for the repos
// the team has explicitly declared.
//
// Three decisions worth stating up front, because each is a departure from the
// obvious implementation:
//
//   1. **The repo list is the scope, and it is never inferred.** Nothing here
//      asks GitHub "what does this token can see" and works from the answer. A
//      repo appears in the standup only because someone typed it into Settings.
//      That keeps a token with wide repo access from quietly pulling half the
//      org into a team's standup.
//   2. **No search API.** `search(query: "org:X is:pr is:open")` answers the
//      whole org in one call — which is precisely the wrong scope — and it is
//      metered against a 30/minute budget with a 256-character query ceiling
//      that a dozen `repo:` qualifiers would breach. Aliased
//      `repository(owner:, name:)` fields ask for exactly the declared repos,
//      in one POST, against the ordinary 5000-point/hour budget.
//   3. **Never fatal.** Every failure degrades to "no panel". A dead GitHub
//      token must not read as the app being broken, so nothing here dispatches
//      the app-wide `jira-auth-error` the Jira layer uses, and a repo the token
//      cannot reach is reported as that one repo failing rather than as the
//      whole fetch failing.

import { CONFIG } from "./config.js";
import { getGithubToken, recordGithubTokenExpiry } from "./credentials.js";
// Login normalisation lives with the roster, since that is where a login is
// stored and edited. Re-exported here so GitHub callers have one import.
import { normalizeGithubLogin } from "./team.js";

export { normalizeGithubLogin };

export const DEFAULT_GITHUB_HOST = "github.com";

// How much to ask for per repo. Generous enough that a busy repo is not
// silently truncated, small enough that ten repos stay cheap in GraphQL points.
export const OPEN_PR_LIMIT = 50;
export const MERGED_PR_LIMIT = 30;
export const OPEN_ISSUE_LIMIT = 30;

// ── Normalisation ────────────────────────────────────────────────────────────

// Org / owner names follow the same rules as user logins.
export function normalizeGithubOrg(input) {
  return normalizeGithubLogin(input);
}

// "github.com", "github.example.com", or "" when unreadable. A scheme, a path
// or a stray @ are all tolerated on the way in, since this is a paste target.
export function normalizeGithubHost(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_GITHUB_HOST;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).host;
    // api.github.com is what the API base derives *to*; someone typing it as
    // the host would otherwise produce api.api.github.com.
    return host === "api.github.com" ? DEFAULT_GITHUB_HOST : host;
  } catch {
    return "";
  }
}

export function isEnterpriseHost(host) {
  return normalizeGithubHost(host) !== DEFAULT_GITHUB_HOST;
}

// REST base. GitHub Enterprise Server serves the v3 REST API under /api/v3 on
// the same host, rather than on a separate api. subdomain.
export function githubRestBase(host) {
  const clean = normalizeGithubHost(host);
  if (!clean) return "";
  return clean === DEFAULT_GITHUB_HOST
    ? "https://api.github.com"
    : `https://${clean}/api/v3`;
}

export function githubGraphqlUrl(host) {
  const clean = normalizeGithubHost(host);
  if (!clean) return "";
  return clean === DEFAULT_GITHUB_HOST
    ? "https://api.github.com/graphql"
    : `https://${clean}/api/graphql`;
}

// The origin a Chrome host permission has to cover. GHES cannot be known at
// build time, so its origin is requested at runtime.
export function githubOrigin(host) {
  const clean = normalizeGithubHost(host);
  if (!clean) return "";
  return clean === DEFAULT_GITHUB_HOST
    ? "https://api.github.com/*"
    : `https://${clean}/*`;
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

// Accepts whatever someone has to hand: a bare name, owner/name, a browser URL
// off the repo page, or an SSH remote. Returns { owner, name } or null.
//
// `defaultOwner` fills in the bare-name case, which is the common one — a team
// declaring five repos in one org should not have to type the org five times.
// The strict character classes are also the injection guard: these values are
// interpolated into a GraphQL document as string literals, and anything that
// could close the quote is rejected here rather than escaped later.
export function parseRepoRef(input, defaultOwner = "") {
  let raw = String(input ?? "").trim();
  if (!raw) return null;

  // git@host:owner/name.git
  const ssh = raw.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  if (ssh) raw = ssh[1];

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return null;
    }
  }

  raw = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!raw) return null;

  const parts = raw.split("/").filter(Boolean);
  // A URL carries trailing segments (/pull/12, /tree/main); the repo is always
  // the first two path segments.
  const owner = parts.length >= 2 ? parts[0] : normalizeGithubOrg(defaultOwner);
  const name = parts.length >= 2 ? parts[1] : parts[0];

  const cleanOwner = normalizeGithubOrg(owner);
  if (!cleanOwner || !name || !REPO_NAME_RE.test(name)) return null;
  // "." and ".." are valid against the character class but are not repos.
  if (/^\.+$/.test(name)) return null;
  return { owner: cleanOwner, name };
}

export function repoSlug(repo) {
  return `${repo.owner}/${repo.name}`;
}

// A textarea of one repo per line -> deduped refs, plus the lines that could
// not be read so the UI can point at them instead of silently dropping them.
export function parseRepoList(text, defaultOwner = "") {
  const lines = String(text ?? "")
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

  const repos = [];
  const invalid = [];
  const seen = new Set();
  for (const line of lines) {
    const repo = parseRepoRef(line, defaultOwner);
    if (!repo) {
      invalid.push(line);
      continue;
    }
    const slug = repoSlug(repo).toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    repos.push(repo);
  }
  return { repos, invalid };
}

// ── Config ───────────────────────────────────────────────────────────────────

// The stored block, normalised on the way out. config.local.json can write it
// by hand, so nothing may assume the UI cleaned it first.
export function githubConfig(config = CONFIG) {
  const raw = config?.github || {};
  const org = normalizeGithubOrg(raw.org);
  const repos = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.repos) ? raw.repos : []) {
    // Stored as "owner/name" strings, but an object survives a hand-edit too.
    let ref = null;
    if (typeof entry === "string") {
      ref = parseRepoRef(entry, org);
    } else if (entry?.name) {
      // Guarded on `name`: without it, "owner/" would fall through to the
      // bare-name branch and silently resolve to `${org}/${owner}`.
      ref = parseRepoRef(`${entry.owner || org}/${entry.name}`, org);
    }
    if (!ref) continue;
    const slug = repoSlug(ref).toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    repos.push(ref);
  }
  return {
    enabled: raw.enabled === true,
    host: normalizeGithubHost(raw.host) || DEFAULT_GITHUB_HOST,
    org,
    repos,
  };
}

// Enabled, pointed at an org, and given at least one repo. Without a repo there
// is nothing to fetch — the allowlist is the scope, so an empty one means off.
export function isGithubConfigured(config = CONFIG) {
  const gh = githubConfig(config);
  return Boolean(gh.enabled && gh.org && gh.repos.length);
}

// ── Query ────────────────────────────────────────────────────────────────────

// One aliased `repository` field per declared repo. Aliases are positional
// (`r0`, `r1`, …) so the caller can map a partial failure back to the repo that
// caused it — GraphQL reports errors by path, not by content.
export function buildActivityQuery(repos, {
  openPrLimit = OPEN_PR_LIMIT,
  mergedLimit = MERGED_PR_LIMIT,
  issueLimit = OPEN_ISSUE_LIMIT,
} = {}) {
  const fields = repos
    .map((repo, i) => {
      if (!normalizeGithubOrg(repo.owner) || !REPO_NAME_RE.test(repo.name)) {
        throw new Error(`Unsafe repo reference: ${repoSlug(repo)}`);
      }
      return `  r${i}: repository(owner: "${repo.owner}", name: "${repo.name}") { ...RepoActivity }`;
    })
    .join("\n");

  return `query ButterJiraTeamActivity {
${fields}
}

fragment RepoActivity on Repository {
  nameWithOwner
  openPullRequests: pullRequests(states: OPEN, first: ${openPrLimit}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { ...PrFields }
  }
  mergedPullRequests: pullRequests(states: MERGED, first: ${mergedLimit}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes {
      number
      title
      url
      mergedAt
      author { login }
    }
  }
  openIssues: issues(states: OPEN, first: ${issueLimit}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes {
      number
      title
      url
      createdAt
      updatedAt
      author { login }
      assignees(first: 5) { nodes { login } }
    }
  }
}

fragment PrFields on PullRequest {
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  reviewDecision
  author { login }
  reviewRequests(first: 10) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug }
      }
    }
  }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
}`;
}

// ── Response -> view model ───────────────────────────────────────────────────

// Ranked by how stuck a pull request is, which is what decides whether it is
// worth thirty seconds of a standup:
//   1 changes-requested — the author is blocked and has to act
//   2 checks-failing    — same, and often unnoticed
//   3 approved          — one click from shipping, and nobody has clicked it
//   4 waiting-review    — blocked on someone else, which a standup can unblock
//   5 draft             — deliberately not ready; mentioned, not chased
export const PR_STATES = {
  CHANGES_REQUESTED: "changes-requested",
  CHECKS_FAILING: "checks-failing",
  APPROVED: "approved",
  WAITING_REVIEW: "waiting-review",
  DRAFT: "draft",
};

const STATE_RANK = {
  [PR_STATES.CHANGES_REQUESTED]: 1,
  [PR_STATES.CHECKS_FAILING]: 2,
  [PR_STATES.APPROVED]: 3,
  [PR_STATES.WAITING_REVIEW]: 4,
  [PR_STATES.DRAFT]: 5,
};

export const PR_STATE_LABELS = {
  [PR_STATES.CHANGES_REQUESTED]: "changes requested",
  [PR_STATES.CHECKS_FAILING]: "checks failing",
  [PR_STATES.APPROVED]: "approved, unmerged",
  [PR_STATES.WAITING_REVIEW]: "waiting on review",
  [PR_STATES.DRAFT]: "draft",
};

// Draft wins over everything: a failing check on a draft is the author's
// business, not the standup's.
export function prState(pr) {
  if (pr.isDraft) return PR_STATES.DRAFT;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return PR_STATES.CHANGES_REQUESTED;
  if (pr.checks === "FAILURE" || pr.checks === "ERROR") return PR_STATES.CHECKS_FAILING;
  if (pr.reviewDecision === "APPROVED") return PR_STATES.APPROVED;
  return PR_STATES.WAITING_REVIEW;
}

export function ageDays(iso, now = new Date()) {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86400000));
}

function loginOf(node) {
  return normalizeGithubLogin(node?.author?.login) || "";
}

// GraphQL answers 200 with a partial `data` and an `errors` array when one
// aliased field fails — a repo the token cannot see, or one that was renamed.
// Mapping those back onto the declared repo is what lets Settings say "this
// row is unreachable" instead of the whole panel disappearing.
export function toActivity(payload, repos, { now = new Date() } = {}) {
  const data = payload?.data || {};
  const failures = new Map();

  for (const err of payload?.errors || []) {
    const alias = Array.isArray(err?.path) ? String(err.path[0] || "") : "";
    const index = /^r(\d+)$/.test(alias) ? Number(alias.slice(1)) : -1;
    const repo = repos[index];
    const key = repo ? repoSlug(repo) : alias || "query";
    if (!failures.has(key)) {
      failures.set(key, {
        repo: repo ? repoSlug(repo) : "",
        type: err?.type || "",
        message: err?.message || "Request failed",
      });
    }
  }

  const pullRequests = [];
  const merged = [];
  const issues = [];
  const reached = [];

  repos.forEach((repo, i) => {
    const node = data[`r${i}`];
    const slug = repoSlug(repo);
    if (!node) {
      if (!failures.has(slug)) {
        failures.set(slug, { repo: slug, type: "NOT_FOUND", message: "No data returned" });
      }
      return;
    }
    reached.push(slug);

    for (const pr of node.openPullRequests?.nodes || []) {
      if (!pr) continue;
      const reviewers = (pr.reviewRequests?.nodes || [])
        .map((r) => normalizeGithubLogin(r?.requestedReviewer?.login))
        .filter(Boolean);
      const teamReviewers = (pr.reviewRequests?.nodes || [])
        .map((r) => (r?.requestedReviewer?.__typename === "Team" ? r.requestedReviewer.slug : ""))
        .filter(Boolean);
      const item = {
        repo: slug,
        number: pr.number,
        title: pr.title || "",
        url: pr.url || "",
        author: loginOf(pr),
        isDraft: Boolean(pr.isDraft),
        createdAt: pr.createdAt || "",
        updatedAt: pr.updatedAt || "",
        reviewDecision: pr.reviewDecision || null,
        checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
        reviewers,
        teamReviewers,
      };
      item.state = prState(item);
      item.ageDays = ageDays(item.createdAt, now);
      item.staleDays = ageDays(item.updatedAt, now);
      pullRequests.push(item);
    }

    for (const pr of node.mergedPullRequests?.nodes || []) {
      if (!pr) continue;
      merged.push({
        repo: slug,
        number: pr.number,
        title: pr.title || "",
        url: pr.url || "",
        author: loginOf(pr),
        mergedAt: pr.mergedAt || "",
      });
    }

    for (const issue of node.openIssues?.nodes || []) {
      if (!issue) continue;
      issues.push({
        repo: slug,
        number: issue.number,
        title: issue.title || "",
        url: issue.url || "",
        author: loginOf(issue),
        assignees: (issue.assignees?.nodes || [])
          .map((a) => normalizeGithubLogin(a?.login))
          .filter(Boolean),
        createdAt: issue.createdAt || "",
        updatedAt: issue.updatedAt || "",
        ageDays: ageDays(issue.createdAt, now),
      });
    }
  });

  return {
    fetchedAt: now.toISOString(),
    repos: repos.map(repoSlug),
    reached,
    pullRequests: pullRequests.sort(comparePrs),
    merged,
    issues,
    failures: [...failures.values()],
  };
}

// Most stuck first; within a state, the one that has been sitting longest.
export function comparePrs(a, b) {
  const rank = (STATE_RANK[a.state] || 9) - (STATE_RANK[b.state] || 9);
  if (rank !== 0) return rank;
  if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
  return `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`);
}

// ── Per-person slices ────────────────────────────────────────────────────────

// Start of the previous working day, so a Monday standup still sees what was
// merged on Friday. Anything shorter makes the panel lie every Monday.
export function mergedSince(now = new Date()) {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 1 = Monday: reach back to Friday. Sunday (0) reaches back to Friday too.
  const back = since.getDay() === 1 ? 3 : since.getDay() === 0 ? 2 : 1;
  since.setDate(since.getDate() - back);
  return since;
}

// GitHub logins are case-insensitive, and the case in an API response is not
// necessarily the case someone typed into the roster. Every comparison in this
// module folds case; only display keeps the original.
const fold = (login) => normalizeGithubLogin(login).toLowerCase();

// Everything one person should be able to talk to, given their GitHub login.
// An empty login yields empty lists rather than everyone's work.
export function activityFor(activity, login, { now = new Date() } = {}) {
  const me = fold(login);
  const empty = { open: [], reviewRequests: [], merged: [], issues: [] };
  if (!me || !activity) return empty;

  const cutoff = mergedSince(now).getTime();
  return {
    open: activity.pullRequests.filter((pr) => fold(pr.author) === me),
    // Somebody else's PR waiting on this person — the ten-second unblock.
    reviewRequests: activity.pullRequests.filter(
      (pr) => fold(pr.author) !== me && pr.reviewers.some((r) => fold(r) === me)
    ),
    merged: activity.merged
      .filter((pr) => fold(pr.author) === me && new Date(pr.mergedAt).getTime() >= cutoff)
      .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))),
    issues: activity.issues.filter((i) => i.assignees.some((a) => fold(a) === me)),
  };
}

// ── Assisted roster mapping ──────────────────────────────────────────────────

// Nothing here is authoritative — GitHub does not know a person's Jira name,
// and plenty of logins are pseudonyms. So this proposes, never applies: only
// members with no login yet are considered, an ambiguous match is left alone
// rather than guessed, and every row stays editable afterwards. The same
// assisted-not-automatic shape as the Jira roster import.
function nameKeys(member) {
  const keys = new Set();

  const name = String(member.nameOverride || member.jiraName || "").toLowerCase();
  const parts = name.replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  if (parts.length) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    keys.add(parts.join(""));
    if (parts.length >= 2) {
      keys.add(`${first}${last}`);
      keys.add(`${first[0]}${last}`);
      keys.add(`${first}${last[0]}`);
      keys.add(`${last}${first[0]}`);
    }
  }

  // The email local part is often the login verbatim, and it is the only key
  // available for someone added by email with no display name yet.
  const local = String(member.email || "").split("@")[0].toLowerCase();
  if (local) keys.add(local.replace(/[^a-z0-9]/g, ""));

  return [...keys].filter(Boolean);
}

export function proposeGithubMatches(members, orgMembers) {
  const takenLogins = new Set(
    members.map((m) => fold(m.githubLogin)).filter(Boolean)
  );

  // login -> comparable key, with separators dropped: "sam-lee" and "sam.lee"
  // both reduce to "samlee".
  const candidates = orgMembers
    .map((o) => normalizeGithubLogin(o.login))
    .filter((login) => login && !takenLogins.has(fold(login)))
    .map((login) => ({ login, key: login.toLowerCase().replace(/[^a-z0-9]/g, "") }));

  const matches = [];
  const ambiguous = [];
  const claimed = new Set();

  for (const member of members) {
    if (!member.accountId || normalizeGithubLogin(member.githubLogin)) continue;
    const keys = nameKeys(member);
    if (!keys.length) continue;

    const hits = candidates.filter(
      (c) => !claimed.has(c.login) && keys.includes(c.key)
    );
    if (hits.length === 1) {
      claimed.add(hits[0].login);
      matches.push({ accountId: member.accountId, login: hits[0].login });
    } else if (hits.length > 1) {
      ambiguous.push({ accountId: member.accountId, logins: hits.map((h) => h.login) });
    }
  }

  return {
    matches,
    ambiguous,
    // Org logins nobody on the roster claims. Usually fine — an org is bigger
    // than a team — but it is what makes "orphan PRs" explicable later.
    unclaimed: candidates.filter((c) => !claimed.has(c.login)).map((c) => c.login),
  };
}

// ── Transport ────────────────────────────────────────────────────────────────

// GitHub, unlike Atlassian, reports a token's real expiry on every
// authenticated call. Recorded rather than guessed at creation + a year.
export const EXPIRY_HEADER = "github-authentication-token-expiration";

// "2026-12-31 23:59:59 +0100" and plain ISO both show up; a fine-grained token
// with no expiry sends no header at all.
export function parseExpiryHeader(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.replace(" ", "T").replace(/ ([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) {
    const fallback = new Date(raw);
    return Number.isFinite(fallback.getTime()) ? fallback.toISOString().slice(0, 10) : null;
  }
  return parsed.toISOString().slice(0, 10);
}

function headerValue(resp, name) {
  try {
    return resp.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function noteExpiry(resp) {
  const expiry = parseExpiryHeader(headerValue(resp, EXPIRY_HEADER));
  // Fire and forget: recording an expiry must never delay or fail a fetch.
  if (expiry) Promise.resolve(recordGithubTokenExpiry(expiry)).catch(() => {});
}

export class GithubError extends Error {
  constructor(message, { status = 0, kind = "error" } = {}) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.kind = kind;
  }
}

function describeStatus(status, body) {
  if (status === 401) return new GithubError("GitHub rejected the token (401)", { status, kind: "auth" });
  if (status === 403 && /rate limit/i.test(body)) {
    return new GithubError("GitHub rate limit reached", { status, kind: "rate-limit" });
  }
  if (status === 403) {
    return new GithubError(
      "GitHub refused the request (403) — the token may need org approval",
      { status, kind: "forbidden" }
    );
  }
  if (status === 404) return new GithubError("Not found (404)", { status, kind: "not-found" });
  return new GithubError(`GitHub API ${status}`, { status, kind: "error" });
}

async function githubRest(path, token, host) {
  const base = githubRestBase(host);
  if (!base) throw new GithubError("GitHub host is not configured", { kind: "config" });
  const resp = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  noteExpiry(resp);
  if (!resp.ok) throw describeStatus(resp.status, await resp.text().catch(() => ""));
  return resp.json();
}

async function githubGraphql(query, token, host) {
  const url = githubGraphqlUrl(host);
  if (!url) throw new GithubError("GitHub host is not configured", { kind: "config" });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  noteExpiry(resp);
  if (!resp.ok) throw describeStatus(resp.status, await resp.text().catch(() => ""));
  const payload = await resp.json();
  // A GraphQL 200 with data: null and top-level errors is a whole-query
  // failure (bad token scope, malformed document) rather than a per-repo one.
  if (!payload?.data && payload?.errors?.length) {
    throw new GithubError(payload.errors[0]?.message || "GraphQL request failed", {
      status: 200,
      kind: "graphql",
    });
  }
  return payload;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function verifyGithubToken({ host, org } = {}, token) {
  const user = await githubRest("/user", token, host);
  const result = { login: user.login || "", name: user.name || "", orgVisible: false };
  if (org) {
    try {
      await githubRest(`/orgs/${encodeURIComponent(org)}`, token, host);
      result.orgVisible = true;
    } catch {
      // A fine-grained token with only repository permissions cannot read the
      // org object. That is fine — repo access is what actually matters, and
      // it is checked per repo below.
      result.orgVisible = false;
    }
  }
  return result;
}

// Per-repo reachability, so Settings can mark the exact row that will fail
// rather than reporting one opaque error for the whole list. Adding a repo to
// the allowlist does not grant the token access to it; this is where that gap
// becomes visible.
export async function checkRepoAccess(repos, { host } = {}, token) {
  return Promise.all(
    repos.map(async (repo) => {
      try {
        const data = await githubRest(
          `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
          token,
          host
        );
        return { repo: repoSlug(repo), ok: true, private: Boolean(data.private) };
      } catch (err) {
        return {
          repo: repoSlug(repo),
          ok: false,
          error: err instanceof GithubError ? err.message : String(err?.message || err),
        };
      }
    })
  );
}

// Org members, for the assisted roster mapping. Needs the org-level
// "Members: read" permission; a 403 here is a missing permission, not a bug,
// and the caller offers manual entry instead.
//
// Capped at 500. This feeds a name matcher for a team of a dozen people, not a
// directory — and the caller reports how many logins came back, so a cap that
// bites is visible rather than silent.
export async function listOrgMembers({ host, org } = {}, token) {
  const members = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await githubRest(
      `/orgs/${encodeURIComponent(org)}/members?per_page=100&page=${page}`,
      token,
      host
    );
    if (!Array.isArray(batch) || !batch.length) break;
    members.push(...batch.map((m) => ({ login: m.login || "", avatarUrl: m.avatar_url || "" })));
    if (batch.length < 100) break;
  }
  return members;
}

// One POST for every declared repo. Returns the view model, or throws for a
// whole-query failure — callers treat a throw as "no panel", never as an app
// error.
export async function fetchTeamActivity({ config = CONFIG, token, now = new Date() } = {}) {
  const gh = githubConfig(config);
  if (!gh.enabled) throw new GithubError("GitHub sync is off", { kind: "config" });
  if (!gh.repos.length) {
    throw new GithubError("No repositories configured", { kind: "config" });
  }
  const authToken = token || (await getGithubToken());
  if (!authToken) throw new GithubError("No GitHub token stored", { kind: "auth" });

  const payload = await githubGraphql(buildActivityQuery(gh.repos), authToken, gh.host);
  return toActivity(payload, gh.repos, { now });
}

// ── Cache ────────────────────────────────────────────────────────────────────

// Keyed by the repo set, not by the org: changing the allowlist must not serve
// the previous list's answer. Same 5-minute TTL as the Jira cache, so leaving
// and re-entering standup does not re-query.
const ACTIVITY_TTL_MS = 5 * 60 * 1000;

export function activityCacheKey(config = CONFIG) {
  const gh = githubConfig(config);
  return `cache_github_${gh.host}_${gh.repos.map(repoSlug).join(",")}`;
}

export async function getTeamActivity({ config = CONFIG, now = new Date(), force = false } = {}) {
  const key = activityCacheKey(config);
  if (!force) {
    try {
      const stored = await chrome.storage.local.get(key);
      const entry = stored?.[key];
      if (entry && Date.now() - entry.ts <= ACTIVITY_TTL_MS) return entry.value;
    } catch {
      // Storage unavailable — fetch rather than fail.
    }
  }
  const activity = await fetchTeamActivity({ config, now });
  try {
    await chrome.storage.local.set({ [key]: { value: activity, ts: Date.now() } });
  } catch {
    // Quota errors must not lose the data we just fetched.
  }
  return activity;
}
