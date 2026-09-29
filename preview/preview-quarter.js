// Local preview harness for the quarterly overview.
//
// Runs the real js/quarter-page.js on top of the shared preview fixture (its
// config, roster and chrome shim), and answers the two quarter-only Jira
// searches and the quarter GitHub window with a synthetic quarter: a few hundred
// issues with histories and comments, spread over the weeks, and a default
// branch history per person. Deterministic, so a screenshot means the same
// thing twice. Not shipped.
//
// States: ?github=off · ?stats=error · ?q=previous · ?roster=empty · ?print=1
import { params, CONFIG } from "./preview-fixture.js";

const { quarterStatsCacheKey } = await import("../js/github.js");
const { resolveQuarter } = await import("../js/quarter.js");

const quarter = resolveQuarter(params.get("q") || "current", new Date());
const from = quarter.start.getTime();
const to = quarter.until.getTime();

// A small LCG: stable across reloads.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (list) => list[Math.floor(rand() * list.length)];
const when = () => new Date(from + rand() * (to - from)).toISOString();

const PEOPLE = [
  ["acc-0", "Avery Quinn", "averyq"],
  ["acc-1", "Bo Ferreira", "boferreira"],
  ["acc-2", "Cy Nakamura", "cynakamura"],
  ["acc-3", "Devi Okonjo", "deviok"],
  ["acc-4", "Emil Vance", ""],
  ["acc-5", "Freya Salib", "freyas"],
];
const who = (p) => ({ accountId: p[0], displayName: p[1] });
const done = { name: "Done", statusCategory: { key: "done" } };
const doing = { name: "In Progress", statusCategory: { key: "indeterminate" } };

const issues = [];
for (let n = 1; n <= 260; n++) {
  const project = pick(["ACME", "PLAT", "DATA"]);
  const creator = pick(PEOPLE);
  const assignee = pick(PEOPLE);
  const epic = n % 23 === 0;
  const created = when();
  const closes = rand() < 0.62;
  const closedAt = closes ? new Date(Math.min(to - 1, Date.parse(created) + rand() * 20 * 86400000)).toISOString() : "";
  const histories = closes
    ? [{
        id: `q${n}`, author: who(assignee), created: closedAt,
        items: [{ field: "status", fieldId: "status", fromString: "In Progress", toString: "Done", from: "3", to: "4" }],
      }]
    : [];
  const comments = Array.from({ length: Math.floor(rand() * 4) }, () => ({ author: who(pick(PEOPLE)), created: when() }));
  issues.push({
    id: String(9000 + n),
    key: `${project}-${1000 + n}`,
    fields: {
      summary: epic ? `Epic: ${pick(["Settlement rework", "Importer v2", "Index split", "Audit trail", "Reporting API"])}` : `Quarter ticket ${n}`,
      issuetype: epic ? { name: "Epic", hierarchyLevel: 1 } : { name: "Story", hierarchyLevel: 0 },
      status: closes ? done : doing,
      created,
      creator: who(creator),
      assignee: who(assignee),
      comment: { total: comments.length, comments },
    },
    changelog: { total: histories.length, histories },
  });
}
const inProgressEpics = ["Pricing engine", "Registry sync", "Onboarding flow"].map((summary, i) => ({
  id: String(9900 + i),
  key: `PLAT-${900 + i}`,
  fields: { summary, issuetype: { name: "Epic", hierarchyLevel: 1 }, status: doing, assignee: who(PEOPLE[i * 2]) },
}));

const base = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (/\/rest\/api\/3\/search\/jql/.test(url) && options.body) {
    const jql = String(JSON.parse(options.body).jql || "");
    const body = (list) => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => structuredClone({ issues: list, isLast: true }),
      text: async () => JSON.stringify({ issues: list, isLast: true }),
    });
    if (/statusCategory = "In Progress"/.test(jql)) return body(inProgressEpics);
    if (/updated >=/.test(jql)) return body(issues);
  }
  return base(input, options);
};

// The GitHub quarter window, seeded where `getQuarterStats` reads it.
if (params.get("github") !== "off" && params.get("stats") !== "error") {
  const mainHistory = [];
  const pullRequests = [];
  const reviews = [];
  PEOPLE.forEach((p, i) => {
    if (!p[2]) return;
    const count = 30 + i * 17;
    for (let n = 0; n < count; n++) {
      mainHistory.push({ repo: "example/alpha", oid: `${i}-${n}`, author: p[2], committedDate: when(), viaPr: n % 3 !== 0 });
    }
    for (let n = 0; n < 8 + i * 3; n++) {
      const created = when();
      pullRequests.push({
        repo: "example/alpha", number: i * 100 + n, author: p[2], createdAt: created, updatedAt: created,
        mergedAt: n % 4 ? created : "", toDefaultBranch: true, additions: 80 + n * 37, deletions: 20 + n * 11,
      });
      reviews.push({ repo: "example/alpha", number: i * 100 + n, author: PEOPLE[(i + 1) % 6][2] || "averyq", prAuthor: p[2], submittedAt: created, comments: 1 });
    }
  });
  const since = quarter.start.toISOString();
  const until = quarter.running ? "" : quarter.end.toISOString();
  await chrome.storage.local.set({
    [quarterStatsCacheKey(CONFIG, since, until)]: {
      ts: Date.now(),
      value: {
        fetchedAt: new Date().toISOString(), since, until, repos: ["example/alpha", "example/beta"],
        reached: ["example/alpha", "example/beta"], truncated: [], failures: [],
        pullRequests, reviews, comments: [], commits: [], mainHistory, unattributedCommits: 4,
      },
    },
  });
}

await import("../js/quarter-page.js");
