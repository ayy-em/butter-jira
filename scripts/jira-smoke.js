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

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────`);
if (failed > 0) process.exit(1);
