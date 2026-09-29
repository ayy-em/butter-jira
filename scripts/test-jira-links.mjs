#!/usr/bin/env node
// Unit checks for the Jira-links redirect rules: which URLs are redirected and
// where to, which pass through, the escape hatch, and the site scope. The rules
// are run here as JavaScript regexes with the same substitution Chrome applies;
// they use only syntax RE2 (declarativeNetRequest's engine) also accepts.
//
// Usage: node scripts/test-jira-links.mjs

globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://abc/${p}` }, storage: { local: {}, sync: {} } };
const links = await import(new URL("../js/jira-links.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};

const HOST = "acme.atlassian.net";
const rules = links.buildRules(HOST, {
  issuePage: "chrome-extension://abc/issue.html",
  appPage: "chrome-extension://abc/app.html",
});

// What the browser would do with a top-level navigation: highest priority wins,
// allow beats redirect at a higher priority.
function navigate(url) {
  const host = new URL(url).host;
  const hits = rules
    .filter((r) => {
      const c = r.condition;
      if (c.requestDomains && !c.requestDomains.includes(host)) return false;
      if (c.urlFilter && !url.includes(c.urlFilter)) return false;
      if (c.regexFilter && !new RegExp(c.regexFilter).test(url)) return false;
      return true;
    })
    .sort((a, b) => b.priority - a.priority);
  const top = hits[0];
  if (!top || top.action.type === "allow") return url;
  return url.replace(new RegExp(top.condition.regexFilter), top.action.redirect.regexSubstitution.replace(/\\(\d)/g, "$$$1"));
}

const base = `https://${HOST}`;
check("browse link → issue page", navigate(`${base}/browse/ABC-123`) === "chrome-extension://abc/issue.html?key=ABC-123");
check("browse link with query → issue page", navigate(`${base}/browse/ABC-123?focusedCommentId=5`) === "chrome-extension://abc/issue.html?key=ABC-123");
check("selectedIssue on a board → issue page", navigate(`${base}/jira/software/projects/ABC/boards/12?selectedIssue=ABC-9`) === "chrome-extension://abc/issue.html?key=ABC-9");
check("selectedIssue not first param", navigate(`${base}/jira/software/c/projects/ABC/boards/12?quickFilter=3&selectedIssue=ABC-9`) === "chrome-extension://abc/issue.html?key=ABC-9");
check("board → kanban", navigate(`${base}/jira/software/projects/ABC/boards/12`) === "chrome-extension://abc/app.html#kanban");
check("company-managed board → kanban", navigate(`${base}/jira/software/c/projects/ABC/boards/12/`) === "chrome-extension://abc/app.html#kanban");
check("board backlog → backlog", navigate(`${base}/jira/software/projects/ABC/boards/12/backlog`) === "chrome-extension://abc/app.html#backlog");
check("backlog with selectedIssue → the issue", navigate(`${base}/jira/software/projects/ABC/boards/12/backlog?selectedIssue=ABC-2`) === "chrome-extension://abc/issue.html?key=ABC-2");

const untouched = [
  `${base}/browse/ABC`,
  `${base}/jira/software/projects/ABC/boards/12/timeline`,
  `${base}/issues/?filter=10001`,
  `${base}/jira/dashboards/10000`,
  `${base}/wiki/spaces/ENG/pages/1`,
  `${base}/jira/software/projects/ABC/settings`,
  `https://other.atlassian.net/browse/ABC-1`,
];
for (const url of untouched) check(`passes through: ${url.replace(base, "")}`, navigate(url) === url);

check("escape hatch lets a browse link through", navigate(`${base}/browse/ABC-1?butterjira=skip`) === `${base}/browse/ABC-1?butterjira=skip`);
check("withSkip adds the marker", links.withSkip(`${base}/browse/ABC-1`) === `${base}/browse/ABC-1?butterjira=skip`);
check("withSkip keeps a query and a hash", links.withSkip(`${base}/x?a=1#top`) === `${base}/x?a=1&butterjira=skip#top`);
check("withSkip leaves a dead link alone", links.withSkip("#") === "#");

check("main-frame only — API calls are never touched", rules.every((r) => r.condition.resourceTypes.join() === "main_frame"));
check("non-Cloud host gets no rules", links.buildRules("jira.example.com", { issuePage: "x", appPage: "y" }).length === 0);
check("host is escaped, not a wildcard", !new RegExp(rules[1].condition.regexFilter).test("https://acmeXatlassian.net/browse/ABC-1"));
check("rule ids are unique", new Set(rules.map((r) => r.id)).size === rules.length);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
