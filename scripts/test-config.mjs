#!/usr/bin/env node
// Unit checks for the configuration layer and field mapping — the logic that
// keeps this tool instance-agnostic. No dependencies, no network, no browser:
// chrome.* and fetch are stubbed below.
//
// Usage: node scripts/test-config.mjs

const CONFIG_URL = new URL("../js/config.js", import.meta.url);
const API_URL = new URL("../js/api.js", import.meta.url);
const UTILS_URL = new URL("../js/utils.js", import.meta.url);

let storage = {};
let localFile = null;
let routes = {};

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: {
      get: (keys, cb) =>
        cb(
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys])
              .filter((k) => k in storage)
              .map((k) => [k, storage[k]])
          )
        ),
      set: async (obj) => Object.assign(storage, obj),
    },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};
globalThis.document = { dispatchEvent: () => {} };
globalThis.CustomEvent = class {};
globalThis.btoa = (s) => Buffer.from(s).toString("base64");
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("config.local.json")) {
    return localFile ? { ok: true, json: async () => localFile } : { ok: false, status: 404 };
  }
  for (const [fragment, body] of Object.entries(routes)) {
    if (u.includes(fragment)) return { ok: true, status: 200, json: async () => body };
  }
  return { ok: false, status: 404, text: async () => "not found" };
};

const cfg = await import(CONFIG_URL);
const api = await import(API_URL);
const utils = await import(UTILS_URL);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (title) => console.log(`\n── ${title} ──`);
const creds = { email: "user@example.com", token: "test-token" };
const issue = (fields) => ({ key: "ABC-1", fields });

section("normalizeBaseUrl");
check("bare host gets https", cfg.normalizeBaseUrl("org.atlassian.net") === "https://org.atlassian.net");
check("trailing slash stripped", cfg.normalizeBaseUrl("https://org.atlassian.net/") === "https://org.atlassian.net");
check("path stripped", cfg.normalizeBaseUrl("https://org.atlassian.net/jira/x") === "https://org.atlassian.net");
check("http preserved for Data Center", cfg.normalizeBaseUrl("http://jira.internal") === "http://jira.internal");
check("empty stays empty", cfg.normalizeBaseUrl("") === "");
check("whitespace stays empty", cfg.normalizeBaseUrl("   ") === "");
check("garbage rejected", cfg.normalizeBaseUrl("::::") === "");

section("defaults: nothing configured");
storage = {}; localFile = null;
await cfg.loadConfig();
check("no boards baked in", cfg.CONFIG.boards.length === 0);
check("no site baked in", cfg.CONFIG.site.baseUrl === "");
check("isConfigured false", cfg.isConfigured() === false);
check("hasBoards false", cfg.hasBoards() === false);
check("status groups defaulted", cfg.CONFIG.statusGroups.length === 4);
check("jiraUrl throws when unconfigured", (() => { try { cfg.jiraUrl("/x"); return false; } catch { return true; } })());
check("browseUrl degrades to #", cfg.browseUrl("ABC-1") === "#");
check("no customfield IDs in issueFields", !cfg.issueFields().some((f) => f.startsWith("customfield_")));

section("config.local.json overrides");
localFile = {
  _comment: ["documentation, not config"],
  site: { baseUrl: "local-org.atlassian.net" },
  fields: { storyPoints: ["customfield_1"] },
  additionalFields: ["from_local"],
  brand: { orgName: "ExampleCo" },
};
await cfg.loadConfig();
check("underscore keys dropped", !("_comment" in cfg.CONFIG));
check("baseUrl normalised on load", cfg.CONFIG.site.baseUrl === "https://local-org.atlassian.net");
check("field mapping applied", cfg.CONFIG.fields.storyPoints[0] === "customfield_1");
check("unset roles keep defaults", cfg.CONFIG.fields.sprint.length === 0);
check("partial brand merge", cfg.CONFIG.brand.productName === "ButterJira" && cfg.CONFIG.brand.orgName === "ExampleCo");
check("additionalFields applied", cfg.CONFIG.additionalFields.includes("from_local"));

section("storage wins over local file; additionalFields merge");
storage = {
  site: { baseUrl: "https://stored.atlassian.net" },
  boards: [{ id: 7, name: "ABC", projectKey: "ABC" }],
  additionalFields: ["from_storage"],
};
await cfg.loadConfig();
check("storage baseUrl wins", cfg.CONFIG.site.baseUrl === "https://stored.atlassian.net");
check("local field mapping survives", cfg.CONFIG.fields.storyPoints[0] === "customfield_1");
check("additionalFields unioned",
  cfg.CONFIG.additionalFields.includes("from_local") && cfg.CONFIG.additionalFields.includes("from_storage"));
check("isConfigured true", cfg.isConfigured() === true);
check("hasBoards true", cfg.hasBoards() === true);
check("jiraUrl builds", cfg.jiraUrl("/rest/api/3/myself") === "https://stored.atlassian.net/rest/api/3/myself");
check("browseUrl builds", cfg.browseUrl("ABC-1") === "https://stored.atlassian.net/browse/ABC-1");
check("wikiUrl builds", cfg.wikiUrl() === "https://stored.atlassian.net/wiki");
check("siteHost extracted", cfg.siteHost() === "stored.atlassian.net");

section("pre-config user: boards in storage, no site URL");
storage = { boards: [{ id: 103, name: "ABC", color: "#4F8EF7" }] };
localFile = null;
await cfg.loadConfig();
check("existing boards preserved", cfg.CONFIG.boards[0].id === 103);
check("missing site sends user to setup", cfg.isConfigured() === false);

section("saveConfig + helpers");
storage = {}; localFile = null;
await cfg.loadConfig();
await cfg.saveConfig({ site: { baseUrl: "x.atlassian.net" }, fields: { storyPoints: ["cf_a", "cf_b"] } });
check("saveConfig normalises URL", cfg.CONFIG.site.baseUrl === "https://x.atlassian.net");
check("saveConfig persists", storage.site.baseUrl === "https://x.atlassian.net");
check("configVersion persisted", storage.configVersion === 1);
check("first candidate wins", cfg.fieldValue({ fields: { cf_a: 5, cf_b: 9 } }, "storyPoints") === 5);
check("empty candidate falls through", cfg.fieldValue({ fields: { cf_a: null, cf_b: 9 } }, "storyPoints") === 9);
check("zero is a real value", cfg.fieldValue({ fields: { cf_a: 0 } }, "storyPoints") === 0);
check("unresolved role -> null", cfg.fieldValue({ fields: {} }, "sprint") === null);
check("issueless input -> null", cfg.fieldValue({}, "storyPoints") === null);
check("boardSlug is CSS-safe", cfg.boardSlug("10 3/x") === "b103x");
check("palette wraps", cfg.boardPaletteColor(0) === cfg.boardPaletteColor(cfg.BOARD_PALETTE.length));

section("field discovery: company-managed naming");
storage = { site: { baseUrl: "https://x.atlassian.net" } };
await cfg.loadConfig();
routes["/rest/api/3/field"] = [
  { id: "summary", name: "Summary" },
  { id: "customfield_10016", name: "Story Points" },
  { id: "customfield_10015", name: "Start date" },
  { id: "customfield_10014", name: "Epic Link" },
  { id: "customfield_10020", name: "Sprint" },
];
let map = await api.discoverFieldMappings(creds);
check("story points resolved", map.storyPoints[0] === "customfield_10016");
check("start date resolved", map.startDate[0] === "customfield_10015");
check("epic link resolved", map.epicLink[0] === "customfield_10014");
check("sprint resolved", map.sprint[0] === "customfield_10020");

section("field discovery: team-managed naming, odd casing");
routes["/rest/api/3/field"] = [
  { id: "customfield_10032", name: "Story point estimate" },
  { id: "customfield_10099", name: "story points" },
  { id: "customfield_10040", name: "  Start Date  " },
  { id: "customfield_10041", name: "Target start" },
];
map = await api.discoverFieldMappings(creds);
check("case-insensitive match", map.storyPoints.includes("customfield_10099"));
check("candidate order follows role name order",
  map.storyPoints[0] === "customfield_10099" && map.storyPoints[1] === "customfield_10032");
check("padded field names trimmed", map.startDate.includes("customfield_10040"));
check("all candidates kept", map.startDate.length === 2);
check("unmatched role -> empty", map.epicLink.length === 0);

section("field accessors");
await cfg.saveConfig({
  fields: {
    storyPoints: ["customfield_10016", "customfield_10032"],
    startDate: ["customfield_10015"],
    epicLink: ["customfield_10014"],
  },
});
check("numeric points", utils.getStoryPoints(issue({ customfield_10016: 5 })) === 5);
check("fallback field used", utils.getStoryPoints(issue({ customfield_10032: 8 })) === 8);
check("string points coerced", utils.getStoryPoints(issue({ customfield_10016: "3" })) === 3);
check("absent points -> null", utils.getStoryPoints(issue({})) === null);
check("zero points preserved", utils.getStoryPoints(issue({ customfield_10016: 0 })) === 0);
check("datetime trimmed to ISO date",
  utils.getStartDate(issue({ customfield_10015: "2026-03-01T00:00:00.000+0100" })) === "2026-03-01");
check("absent start date -> null", utils.getStartDate(issue({})) === null);
check("epic key from field", utils.getEpicKey(issue({ customfield_10014: "ABC-9" })) === "ABC-9");
check("epic key from object", utils.getEpicKey(issue({ customfield_10014: { key: "ABC-7" } })) === "ABC-7");
check("epic key from parent",
  utils.getEpicKey(issue({ parent: { key: "ABC-4", fields: { issuetype: { name: "Epic" } } } })) === "ABC-4");
check("no epic -> null", utils.getEpicKey(issue({})) === null);

section("issueFields composition");
await cfg.saveConfig({ additionalFields: ["customfield_10050"] });
const fields = cfg.issueFields();
check("base fields present", fields.includes("summary") && fields.includes("duedate") && fields.includes("labels"));
check("discovered fields present", fields.includes("customfield_10016") && fields.includes("customfield_10015"));
check("additional fields present", fields.includes("customfield_10050"));
check("no duplicates", new Set(fields).size === fields.length);

section("listBoards");
routes["/rest/agile/1.0/board"] = {
  values: [
    { id: 7, name: "Alpha board", type: "scrum", location: { projectKey: "ABC", projectName: "Alpha" } },
    { id: 8, name: "Orphan board", type: "kanban" },
  ],
  total: 2,
  isLast: true,
};
const boards = await api.listBoards(creds);
check("board mapped", boards[0].id === 7 && boards[0].projectKey === "ABC");
check("board without project tolerated", boards[1].projectKey === "");

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
