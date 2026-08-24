#!/usr/bin/env node
// Connectivity + API-shape check against a real Jira site. Everything
// instance-specific comes from the environment, nothing is hardcoded.
//
// Usage:
//   JIRA_SITE=your-org.atlassian.net \
//   JIRA_EMAIL=you@example.com \
//   JIRA_TOKEN=your_api_token \
//   [JIRA_PROJECTS=ABC,DEF] \
//   node scripts/jira-smoke.js

const SITE = process.env.JIRA_SITE;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_TOKEN;
const PROJECTS = (process.env.JIRA_PROJECTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!SITE || !EMAIL || !TOKEN) {
  console.error("Set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN environment variables");
  process.exit(1);
}

const BASE = /^https?:\/\//i.test(SITE) ? SITE.replace(/\/$/, "") : `https://${SITE}`;
const AUTH = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else           { console.error(`  ✗ ${msg}`); failed++; }
}

async function jiraGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(text.slice(0, 200)), { status: res.status });
  return JSON.parse(text);
}

async function searchPost(body) {
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { Authorization: AUTH, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(text.slice(0, 200)), { status: res.status });
  return JSON.parse(text);
}

// ── Test 1: credentials are valid ─────────────────────────────────────────────
console.log(`\n── Test 1: GET /rest/api/3/myself — ${BASE} ─────────`);
try {
  const me = await jiraGet("/rest/api/3/myself");
  assert(Boolean(me.accountId), `authenticated as ${me.displayName} (${me.accountId})`);
} catch (e) {
  console.error(`  ✗ ${e.status ?? ""}: ${e.message}`);
  if (e.status === 401) console.error("    401 usually means an expired or mistyped API token.");
  failed++;
}

// ── Test 2: field discovery resolves the roles the app needs ───────────────────
console.log("\n── Test 2: GET /rest/api/3/field — field roles ─────────────────");
const FIELD_ROLES = {
  "Story points": ["Story Points", "Story point estimate", "Story Points estimate"],
  "Start date": ["Start date", "Start Date", "Target start"],
  "Epic link": ["Epic Link", "Parent Link"],
  Sprint: ["Sprint"],
};
let startDateField = null;
try {
  const fields = await jiraGet("/rest/api/3/field");
  assert(Array.isArray(fields) && fields.length > 0, `site exposes ${fields.length} fields`);
  for (const [role, names] of Object.entries(FIELD_ROLES)) {
    const match = fields.find((f) =>
      names.some((n) => n.toLowerCase() === (f.name || "").trim().toLowerCase())
    );
    assert(Boolean(match), `${role} -> ${match ? match.id : "UNRESOLVED (set it manually in Settings)"}`);
    if (role === "Start date" && match) startDateField = match.id;
  }
} catch (e) {
  console.error(`  ✗ ${e.status ?? ""}: ${e.message}`);
  failed++;
}

// ── Test 3: boards are listable ───────────────────────────────────────────────
console.log("\n── Test 3: GET /rest/agile/1.0/board ───────────────────────────");
try {
  const data = await jiraGet("/rest/agile/1.0/board?maxResults=5");
  assert(Array.isArray(data.values), `boards visible: ${data.total ?? data.values?.length ?? 0}`);
  (data.values || []).slice(0, 5).forEach((b) =>
    console.log(`    #${b.id}  ${b.name}  ${b.location?.projectKey ?? ""}`)
  );
} catch (e) {
  console.error(`  ✗ ${e.status ?? ""}: ${e.message}`);
  failed++;
}

// ── Test 4: epic search + cursor pagination ───────────────────────────────────
console.log("\n── Test 4: POST /rest/api/3/search/jql — epics ─────────────────");
const jql = PROJECTS.length
  ? `issuetype = Epic AND project in (${PROJECTS.join(",")})`
  : "issuetype = Epic ORDER BY created DESC";
const searchFields = ["key", "summary", "duedate", "status", "assignee"];
if (startDateField) searchFields.push(startDateField);
try {
  const page1 = await searchPost({ jql, fields: searchFields, maxResults: 2 });
  assert(Array.isArray(page1.issues), `page 1 returned ${page1.issues?.length ?? 0} issues (isLast=${page1.isLast})`);
  if (startDateField) {
    const dated = (page1.issues || []).filter(
      (i) => i.fields?.[startDateField] && i.fields?.duedate
    );
    console.log(`    ${dated.length} of ${page1.issues?.length ?? 0} sampled epics have start + due dates`);
  }
  if (!page1.isLast && page1.nextPageToken) {
    const page2 = await searchPost({
      jql, fields: searchFields, maxResults: 2, nextPageToken: page1.nextPageToken,
    });
    assert(Array.isArray(page2.issues), `cursor pagination works (page 2: ${page2.issues.length} issues)`);
  } else {
    console.log("    only one page of results — pagination not exercised");
  }
} catch (e) {
  console.error(`  ✗ ${e.status ?? ""}: ${e.message}`);
  failed++;
}

// ── Test 5: changelog expand on the agile endpoint ────────────────────────────
// The spike the roadmap asks for before per-person Jira activity is built. Two
// questions, and the answers change the cost of the feature rather than whether
// it works:
//
//   1. Does `/rest/agile/1.0/board/{id}/sprint/{id}/issue` honour
//      `expand=changelog`? If it does, the history rides the request the app
//      already makes and costs nothing. If it does not, the fallback is the JQL
//      search path — one query per board rather than none.
//   2. What is the per-issue entry cap on this site? Jira returns the most
//      recent entries alongside a `total`, and a ticket that has ping-ponged
//      for months can exceed it. Whatever the number is, the reader has to
//      carry a `truncated` flag rather than print an undercount as a whole.
console.log("\n── Test 5: expand=changelog — per-person activity spike ─────────");
try {
  const boards = await jiraGet("/rest/agile/1.0/board?maxResults=50");
  const candidates = PROJECTS.length
    ? (boards.values || []).filter((b) => PROJECTS.includes(b.location?.projectKey))
    : boards.values || [];

  let probed = null;
  for (const board of candidates) {
    const sprints = await jiraGet(`/rest/agile/1.0/board/${board.id}/sprint?state=active`);
    const sprint = (sprints.values || [])[0];
    if (sprint) { probed = { board, sprint }; break; }
  }

  if (!probed) {
    console.log("    no active sprint on any visible board — spike not exercised");
  } else {
    const { board, sprint } = probed;
    console.log(`    probing board #${board.id} ${board.name} / sprint #${sprint.id} ${sprint.name}`);

    const agile = await jiraGet(
      `/rest/agile/1.0/board/${board.id}/sprint/${sprint.id}/issue` +
        `?fields=key,created,creator&expand=changelog&maxResults=50`
    );
    const withLog = (agile.issues || []).filter((i) => i.changelog);
    assert(
      withLog.length > 0,
      `Q1: agile endpoint honours expand=changelog — ${withLog.length} of ${agile.issues?.length ?? 0} issues carry one` +
        (withLog.length ? "" : " (FALLBACK NEEDED: use the JQL search path, one query per board)")
    );

    // `creator` and `created` are the other half of the feature and need no
    // expand at all — confirm they are actually populated before anything is
    // built on them.
    const withCreator = (agile.issues || []).filter((i) => i.fields?.creator?.accountId);
    assert(
      withCreator.length > 0,
      `creator + created populated on ${withCreator.length} of ${agile.issues?.length ?? 0} issues (issues-created-per-person needs no expand)`
    );

    if (withLog.length) {
      // The cap, read rather than assumed. `maxResults` inside the changelog is
      // what Jira applied; `total` is how many entries exist.
      let capSeen = 0;
      let truncatedCount = 0;
      let deepest = null;
      for (const issue of withLog) {
        const log = issue.changelog;
        const returned = (log.histories || []).length;
        capSeen = Math.max(capSeen, log.maxResults ?? returned);
        if ((log.total ?? returned) > returned) {
          truncatedCount++;
          if (!deepest || log.total > deepest.total) {
            deepest = { key: issue.key, total: log.total, returned };
          }
        }
      }
      console.log(`    Q2: per-issue entry cap on this site: ${capSeen}`);
      if (truncatedCount) {
        console.log(
          `    ${truncatedCount} of ${withLog.length} sampled issues exceed it` +
            (deepest ? ` — deepest ${deepest.key}: ${deepest.returned} of ${deepest.total} entries` : "")
        );
      } else {
        console.log(`    none of the ${withLog.length} sampled issues exceed it`);
      }

      // What a compact history entry costs, since whole changelogs would
      // multiply a cached payload to carry data the app discards most of.
      const entries = withLog.flatMap((i) => i.changelog.histories || []);
      const rawBytes = JSON.stringify(withLog.map((i) => i.changelog)).length;
      const compact = entries.flatMap((h) =>
        (h.items || []).map((it) => [
          h.author?.accountId ?? "", it.field ?? it.fieldId ?? "",
          it.fromString ?? "", it.toString ?? "", h.created ?? "",
        ])
      );
      const compactBytes = JSON.stringify(compact).length;
      console.log(
        `    ${entries.length} history entries -> ${compact.length} compact items: ` +
          `${(rawBytes / 1024).toFixed(1)}kB raw vs ${(compactBytes / 1024).toFixed(1)}kB reduced ` +
          `(${Math.round((1 - compactBytes / rawBytes) * 100)}% smaller)`
      );

      // The field names this site uses, since the reader matches on them and
      // they are localised on some sites.
      const fieldNames = [...new Set(entries.flatMap((h) => (h.items || []).map((i) => i.field)))];
      console.log(`    fields appearing in history: ${fieldNames.slice(0, 12).join(", ")}`);
    }

    // Does the backlog twin take it too? Not used today — the app deliberately
    // fetches the backlog without the expand, since every consumer of activity
    // asks about a sprint — but worth knowing before a screen wants it.
    const backlog = await jiraGet(
      `/rest/agile/1.0/board/${board.id}/backlog?fields=key&expand=changelog&maxResults=10`
    );
    const backlogLogs = (backlog.issues || []).filter((i) => i.changelog).length;
    console.log(
      `    backlog endpoint (not used today): ${backlogLogs} of ${backlog.issues?.length ?? 0} sampled issues carry a changelog`
    );
  }
} catch (e) {
  console.error(`  ✗ ${e.status ?? ""}: ${e.message}`);
  failed++;
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────`);
if (failed > 0) process.exit(1);
