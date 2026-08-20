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

import { localGet, localSet } from "./browser.js";
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
//
// There is no draft rank because there are no drafts: a draft is work someone
// has explicitly marked as not ready, so it is dropped on the way in and never
// appears in a list, a count or a statistic. See `isDraft` in `toActivity`.
export const PR_STATES = {
  CHANGES_REQUESTED: "changes-requested",
  CHECKS_FAILING: "checks-failing",
  APPROVED: "approved",
  WAITING_REVIEW: "waiting-review",
};

const STATE_RANK = {
  [PR_STATES.CHANGES_REQUESTED]: 1,
  [PR_STATES.CHECKS_FAILING]: 2,
  [PR_STATES.APPROVED]: 3,
  [PR_STATES.WAITING_REVIEW]: 4,
};

export const PR_STATE_LABELS = {
  [PR_STATES.CHANGES_REQUESTED]: "changes requested",
  [PR_STATES.CHECKS_FAILING]: "checks failing",
  [PR_STATES.APPROVED]: "approved, unmerged",
  [PR_STATES.WAITING_REVIEW]: "waiting on review",
};

export function prState(pr) {
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
      // Drafts are dropped here rather than filtered at each call site, so that
      // no count anywhere in the app can disagree with the list beside it.
      if (pr.isDraft) continue;
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

// ── Sprint window ────────────────────────────────────────────────────────────

// A second query, and a second question. `fetchTeamActivity` answers "what is
// open right now"; this answers "what did each person do during the sprint",
// which the first document cannot serve:
//
//   * It needs pull requests that are already closed, the reviews and comments
//     written on them, and the diff size that landed on the default branch —
//     none of which the standup panel lists.
//   * It has to reach back over a whole sprint rather than take the newest 50
//     of everything, which means paginating, per repo.
//
// **The window is a fixed lookback, not the sprint's own dates.** That is what
// lets the fetch start the moment someone clicks STANDUP, before Jira has been
// asked when the sprint began: the network shape depends on nothing but the
// repo list. The sprint boundary is applied afterwards, in `statsFor`, over
// data that already covers it.
export const STATS_LOOKBACK_DAYS = 45;
export const STATS_PAGE_SIZE = 50;
// 6 pages × 50 = 300 pull requests per repo. A repo busier than that over 45
// days is reported as truncated rather than quietly undercounted.
export const STATS_MAX_PAGES = 6;
export const REVIEWS_PER_PR = 30;
export const COMMENTS_PER_PR = 40;
// Default-branch commits are a second, separate page loop: `history(since:)`
// windows server-side, so this one stops on its own rather than on a cutoff
// test. 100 × 4 = 400 commits per repo over the window. Most of those are
// discarded — anything that arrived through a pull request is already counted as
// that pull request's diff — which is the price of catching the ones that did
// not.
export const COMMITS_PAGE_SIZE = 100;
export const COMMITS_MAX_PAGES = 4;

// A board whose active sprint carries no start date still needs a window to
// count over. Fourteen days is the common sprint length here; every view that
// falls back to it says so rather than implying Jira supplied the date. Shared
// so the standup and the dashboard cannot come to mean two different things by
// "this sprint".
export const FALLBACK_SPRINT_DAYS = 14;

// Variables rather than interpolation, because this one is issued once per page
// per repo and the cursor changes every time. `last:` on the two nested
// connections, not `first:`: the window is recent, so the newest reviews and
// comments are the ones that can fall inside it.
export function buildWindowQuery({
  pageSize = STATS_PAGE_SIZE,
  reviewLimit = REVIEWS_PER_PR,
  commentLimit = COMMENTS_PER_PR,
} = {}) {
  return `query ButterJiraRepoWindow($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequests(first: ${pageSize}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        state
        createdAt
        updatedAt
        mergedAt
        baseRefName
        additions
        deletions
        author { login }
        reviews(last: ${reviewLimit}) {
          nodes {
            state
            submittedAt
            author { login }
            comments { totalCount }
          }
        }
        comments(last: ${commentLimit}) {
          nodes { createdAt author { login } }
        }
      }
    }
  }
}`;
}

// Commits on the default branch, so work pushed straight to main counts as
// having shipped. Pull requests cannot answer this: a direct push has no pull
// request, which is precisely what makes it invisible to the other query.
//
// `associatedPullRequests` is what keeps the two from double counting — a commit
// that arrived through a pull request is dropped here, because that pull
// request's own diff already accounts for it. Asking for one is enough: the
// question is whether there are any, not which.
export function buildCommitQuery({ pageSize = COMMITS_PAGE_SIZE } = {}) {
  return `query ButterJiraRepoCommits($owner: String!, $name: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: ${pageSize}, after: $cursor, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              committedDate
              additions
              deletions
              author { user { login } }
              associatedPullRequests(first: 1) { nodes { number } }
            }
          }
        }
      }
    }
  }
}`;
}

const DEFAULT_BRANCH_FALLBACK = /^(main|master)$/;

// True when this pull request landed on what the repo calls its main line.
// `defaultBranchRef` is present for any repo with commits; the name test is the
// fallback for the one case where it is not, and is deliberately narrow — a
// release branch must not be counted as main.
function targetsDefaultBranch(baseRef, defaultBranch) {
  if (!baseRef) return false;
  return defaultBranch ? baseRef === defaultBranch : DEFAULT_BRANCH_FALLBACK.test(baseRef);
}

const msOf = (iso) => {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

// One repo, paged newest-updated first and stopped as soon as a page runs off
// the end of the window. A pull request created, merged, reviewed or commented
// on inside the window has necessarily been updated inside it too, so the
// updated-at cutoff is a complete stop condition rather than a heuristic.
async function fetchRepoWindow(repo, { token, host, since, maxPages, query }) {
  const slug = repoSlug(repo);
  const pullRequests = [];
  const reviews = [];
  const comments = [];
  let defaultBranch = "";
  let cursor = null;
  let pages = 0;
  let done = false;

  while (!done && pages < maxPages) {
    const payload = await githubGraphql(query, token, host, {
      owner: repo.owner,
      name: repo.name,
      cursor,
    });
    const node = payload?.data?.repository;
    if (!node) {
      const err = payload?.errors?.[0];
      throw new GithubError(err?.message || "No data returned", {
        status: 200,
        kind: err?.type === "NOT_FOUND" ? "not-found" : "graphql",
      });
    }
    defaultBranch = node.defaultBranchRef?.name || defaultBranch;

    const conn = node.pullRequests || {};
    let reachedCutoff = false;
    for (const pr of conn.nodes || []) {
      if (!pr) continue;
      if (msOf(pr.updatedAt) < since) {
        reachedCutoff = true;
        break;
      }
      // Drafts are out of scope everywhere, so their reviews and comments go
      // with them: nobody is asked to review work that is not offered yet.
      if (pr.isDraft) continue;

      const author = loginOf(pr);
      pullRequests.push({
        repo: slug,
        number: pr.number,
        title: pr.title || "",
        url: pr.url || "",
        author,
        state: pr.state || "",
        createdAt: pr.createdAt || "",
        updatedAt: pr.updatedAt || "",
        mergedAt: pr.mergedAt || "",
        baseRef: pr.baseRefName || "",
        additions: Number(pr.additions) || 0,
        deletions: Number(pr.deletions) || 0,
      });

      for (const review of pr.reviews?.nodes || []) {
        const login = normalizeGithubLogin(review?.author?.login);
        // A review with no submittedAt is still PENDING — a draft review, and
        // out for the same reason a draft pull request is.
        if (!login || !review.submittedAt) continue;
        reviews.push({
          repo: slug,
          number: pr.number,
          author: login,
          prAuthor: author,
          submittedAt: review.submittedAt,
          state: review.state || "",
          // Inline comments belong to their review; the review body does not
          // count itself, so nothing here is counted twice.
          comments: Number(review.comments?.totalCount) || 0,
        });
      }

      for (const comment of pr.comments?.nodes || []) {
        const login = normalizeGithubLogin(comment?.author?.login);
        if (!login || !comment.createdAt) continue;
        comments.push({
          repo: slug,
          number: pr.number,
          author: login,
          prAuthor: author,
          createdAt: comment.createdAt,
        });
      }
    }

    pages++;
    done = reachedCutoff || !conn.pageInfo?.hasNextPage;
    cursor = conn.pageInfo?.endCursor || null;
  }

  return {
    pullRequests: pullRequests.map((pr) => ({
      ...pr,
      toDefaultBranch: targetsDefaultBranch(pr.baseRef, defaultBranch),
    })),
    reviews,
    comments,
    defaultBranch,
    // The page cap bit before the window did: this repo's older half is missing,
    // and the UI says so rather than presenting a short count as a full one.
    truncated: !done,
  };
}

// One repo's default-branch commits inside the window, keeping only what no pull
// request accounts for. `history(since:)` does the windowing server-side, so
// this pages until GitHub says there is no more rather than testing a cutoff.
async function fetchRepoCommits(repo, { token, host, since, maxPages, query }) {
  const slug = repoSlug(repo);
  const commits = [];
  let cursor = null;
  let pages = 0;
  let done = false;

  while (!done && pages < maxPages) {
    const payload = await githubGraphql(query, token, host, {
      owner: repo.owner,
      name: repo.name,
      since: new Date(since).toISOString(),
      cursor,
    });
    const node = payload?.data?.repository;
    if (!node) {
      const err = payload?.errors?.[0];
      throw new GithubError(err?.message || "No data returned", {
        status: 200,
        kind: err?.type === "NOT_FOUND" ? "not-found" : "graphql",
      });
    }

    // An empty repo has no default branch and so no history — not an error.
    const history = node.defaultBranchRef?.target?.history;
    if (!history) return { commits, truncated: false };

    for (const commit of history.nodes || []) {
      if (!commit) continue;
      // Arrived through a pull request: already counted as that PR's diff.
      if (commit.associatedPullRequests?.nodes?.length) continue;
      // A commit whose email is not linked to any GitHub account cannot be
      // attributed to a person, and guessing from the email would be worse.
      const login = normalizeGithubLogin(commit.author?.user?.login);
      if (!login) continue;
      commits.push({
        repo: slug,
        oid: commit.oid || "",
        author: login,
        committedDate: commit.committedDate || "",
        additions: Number(commit.additions) || 0,
        deletions: Number(commit.deletions) || 0,
      });
    }

    pages++;
    done = !history.pageInfo?.hasNextPage;
    cursor = history.pageInfo?.endCursor || null;
  }

  // Same meaning as the pull-request loop's: the page cap bit before the window
  // ran out, so this repo's older half is missing and the UI says so.
  return { commits, truncated: !done };
}

// Everything one person did with pull requests inside a window, given their
// GitHub login. Null — not zeroes — when there is nothing to answer from: an
// absent statistic and a genuine zero are different facts, and the UI shows
// them differently.
//
// Two definitions worth stating, because both could reasonably go the other way:
//
//   * **Reviews and comments are counted on other people's pull requests only.**
//     Replying to feedback on your own PR is authorship, not review, and
//     counting it would reward the noisiest thread.
//   * **Lines counted are lines that reached the default branch**, attributed to
//     the pull request's author, or to the commit's author when it was pushed
//     straight to main with no pull request at all. A merge into a feature
//     branch has not shipped, so it is not counted. Direct pushes were invisible
//     until they were asked for separately, which flattered anyone working
//     through pull requests and undercounted everyone else.
export function statsFor(stats, login, { since = "" } = {}) {
  const me = fold(login);
  if (!me || !stats) return null;

  const windowStart = Math.max(msOf(stats.since), since ? msOf(since) : 0);
  const inWindow = (iso) => msOf(iso) >= windowStart;
  const mine = (l) => fold(l) === me;

  let prsOpened = 0;
  let prsMerged = 0;
  let prAdditions = 0;
  let prDeletions = 0;
  for (const pr of stats.pullRequests || []) {
    if (!mine(pr.author)) continue;
    if (inWindow(pr.createdAt)) prsOpened++;
    if (pr.toDefaultBranch && pr.mergedAt && inWindow(pr.mergedAt)) {
      prsMerged++;
      prAdditions += pr.additions;
      prDeletions += pr.deletions;
    }
  }

  // Commits pushed straight to the default branch. `fetchRepoCommits` has
  // already dropped anything a pull request accounts for, so these add to the
  // pull-request diffs rather than overlapping them.
  let directCommits = 0;
  let directAdditions = 0;
  let directDeletions = 0;
  for (const commit of stats.commits || []) {
    if (!mine(commit.author) || !inWindow(commit.committedDate)) continue;
    directCommits++;
    directAdditions += commit.additions;
    directDeletions += commit.deletions;
  }

  let reviews = 0;
  let comments = 0;
  for (const review of stats.reviews || []) {
    if (!mine(review.author) || mine(review.prAuthor)) continue;
    if (!inWindow(review.submittedAt)) continue;
    reviews++;
    comments += review.comments;
  }
  for (const comment of stats.comments || []) {
    if (!mine(comment.author) || mine(comment.prAuthor)) continue;
    if (inWindow(comment.createdAt)) comments++;
  }

  return {
    from: new Date(windowStart).toISOString(),
    // The sprint started before the fetch window reaches: these numbers cover
    // the window, not the sprint, and whoever shows them has to say so.
    clamped: Boolean(since) && msOf(since) < msOf(stats.since),
    prsOpened,
    prsMerged,
    // Broken out as well as summed, so a tooltip can say what the total is made
    // of — "1.2k lines, 300 of them pushed straight to main" is a different
    // sentence about a team than the total alone.
    prAdditions,
    prDeletions,
    directCommits,
    directAdditions,
    directDeletions,
    additions: prAdditions + directAdditions,
    deletions: prDeletions + directDeletions,
    lines: prAdditions + prDeletions + directAdditions + directDeletions,
    reviews,
    comments,
    engagements: reviews + comments,
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

async function githubGraphql(query, token, host, variables = null) {
  const url = githubGraphqlUrl(host);
  if (!url) throw new GithubError("GitHub host is not configured", { kind: "config" });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
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

// The sprint-window counterpart: pull requests, reviews and comments over the
// last `lookbackDays`, per declared repo, paged. Repos run concurrently and
// pages run in order within a repo.
//
// Same never-fatal rule as the activity fetch, with one exception: if *no* repo
// could be reached the first error is rethrown. A dead token would otherwise
// render as every person having done nothing all sprint, which is worse than an
// absent panel.
export async function fetchTeamStats({
  config = CONFIG,
  token,
  now = new Date(),
  lookbackDays = STATS_LOOKBACK_DAYS,
  maxPages = STATS_MAX_PAGES,
  commitMaxPages = COMMITS_MAX_PAGES,
} = {}) {
  const gh = githubConfig(config);
  if (!gh.enabled) throw new GithubError("GitHub sync is off", { kind: "config" });
  if (!gh.repos.length) {
    throw new GithubError("No repositories configured", { kind: "config" });
  }
  const authToken = token || (await getGithubToken());
  if (!authToken) throw new GithubError("No GitHub token stored", { kind: "auth" });

  const sinceDate = new Date(now.getTime() - lookbackDays * 86400000);
  const query = buildWindowQuery();
  const commitQuery = buildCommitQuery();

  const results = await Promise.all(
    gh.repos.map(async (repo) => {
      const shared = {
        token: authToken,
        host: gh.host,
        since: sinceDate.getTime(),
      };
      try {
        // The pull-request window and the default-branch history are independent
        // page loops, so they run together. The commit half is allowed to fail
        // on its own: losing direct pushes is a smaller loss than losing the
        // whole repo, and it is reported rather than silently zeroed.
        const [data, commits] = await Promise.all([
          fetchRepoWindow(repo, { ...shared, maxPages, query }),
          fetchRepoCommits(repo, {
            ...shared,
            maxPages: commitMaxPages,
            query: commitQuery,
          }).catch((err) => ({ commits: [], truncated: false, error: err })),
        ]);
        return { repo, data, commits };
      } catch (err) {
        return { repo, error: err };
      }
    })
  );

  const reached = [];
  const truncated = [];
  const failures = [];
  const pullRequests = [];
  const reviews = [];
  const comments = [];
  const commits = [];
  for (const { repo, data, commits: history, error } of results) {
    const slug = repoSlug(repo);
    if (error) {
      failures.push({
        repo: slug,
        type: error instanceof GithubError ? error.kind : "error",
        message: error?.message || "Request failed",
      });
      continue;
    }
    reached.push(slug);
    if (data.truncated || history?.truncated) truncated.push(slug);
    pullRequests.push(...data.pullRequests);
    reviews.push(...data.reviews);
    comments.push(...data.comments);
    commits.push(...(history?.commits || []));
    // The repo was read; its direct pushes were not. Named separately from a
    // repo that could not be reached at all, because the fix differs.
    if (history?.error) {
      failures.push({
        repo: slug,
        type: history.error instanceof GithubError ? history.error.kind : "error",
        message: `Direct pushes unavailable — ${history.error?.message || "request failed"}`,
      });
    }
  }

  if (!reached.length) {
    const first = results.find((r) => r.error)?.error;
    throw first instanceof GithubError
      ? first
      : new GithubError(first?.message || "No repositories could be read", { kind: "error" });
  }

  return {
    fetchedAt: now.toISOString(),
    since: sinceDate.toISOString(),
    repos: gh.repos.map(repoSlug),
    reached,
    truncated,
    failures,
    pullRequests,
    reviews,
    comments,
    commits,
  };
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

export function statsCacheKey(config = CONFIG) {
  const gh = githubConfig(config);
  return `cache_github_stats_${gh.host}_${gh.repos.map(repoSlug).join(",")}`;
}

// In-flight requests, keyed the same way as the stored ones. This is what makes
// prewarming safe: the header's click and the view's own call land on the same
// promise instead of issuing the query twice, and the second caller does not
// have to know a first one happened.
const inflight = new Map();

function shared(key, force, run) {
  if (!force) {
    const hit = inflight.get(key);
    if (hit) return hit;
  }
  const promise = run();
  inflight.set(key, promise);
  // Cleared on settle, not on success: a failed fetch must be retryable, and
  // both arms are handled here so the derived promise never counts as unhandled.
  const clear = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

async function readCached(key, ttl) {
  try {
    const stored = await localGet(key);
    const entry = stored?.[key];
    if (entry && Date.now() - entry.ts <= ttl) return entry.value;
  } catch {
    // Storage unavailable — fetch rather than fail.
  }
  return null;
}

async function writeCached(key, value) {
  try {
    await localSet({ [key]: { value, ts: Date.now() } });
  } catch {
    // Quota errors must not lose the data we just fetched.
  }
}

export function getTeamActivity({ config = CONFIG, now = new Date(), force = false } = {}) {
  const key = activityCacheKey(config);
  return shared(key, force, async () => {
    const cached = force ? null : await readCached(key, ACTIVITY_TTL_MS);
    if (cached) return cached;
    const activity = await fetchTeamActivity({ config, now });
    await writeCached(key, activity);
    return activity;
  });
}

export function getTeamStats({ config = CONFIG, now = new Date(), force = false } = {}) {
  const key = statsCacheKey(config);
  return shared(key, force, async () => {
    const cached = force ? null : await readCached(key, ACTIVITY_TTL_MS);
    if (cached) return cached;
    const stats = await fetchTeamStats({ config, now });
    await writeCached(key, stats);
    return stats;
  });
}

// Called from the header the instant STANDUP is clicked, so the pull-request
// window — the slowest thing the standup asks for, and the only paged one — is
// already in flight while the sprint issues load and the facilitator ticks
// people off. Returns nothing useful on purpose: the view calls the same two
// functions and gets the same promises, errors included.
export function prewarmGithub({ config = CONFIG, now = new Date() } = {}) {
  if (!isGithubConfigured(config)) return false;
  for (const started of [getTeamActivity({ config, now }), getTeamStats({ config, now })]) {
    // Nobody is awaiting these yet. A rejection here is not an error anyone
    // asked about, so it must not reach the console as an unhandled one.
    started.catch(() => {});
  }
  return true;
}
