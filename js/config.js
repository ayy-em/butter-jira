// Single source of truth for everything instance-specific: which Jira site to
// talk to, which boards are in scope, how this Jira names its custom fields,
// and optional org branding.
//
// Resolution order (later wins):
//   1. DEFAULTS below — safe, org-neutral, committed
//   2. config.local.json — untracked local overrides (see config.local.example.json)
//   3. chrome.storage.sync — whatever the user set in the Settings page
//
// `additionalFields` is the exception: it is the union of the local file and
// storage, so a local override can always add fields without fighting the UI.

import { runtimeUrl, syncGet, syncSet } from "./browser.js";
import { runMigrations } from "./migrations.js";

const LOCAL_OVERRIDE_FILE = "config.local.json";

// Field roles the app needs, with the Jira field names to look for during
// discovery. Custom field IDs (customfield_10016 and friends) are assigned
// per Jira site and are never the same twice, so they must be resolved at
// runtime rather than hardcoded. Each role resolves to an ordered list of
// candidate field IDs; the first one carrying a usable value wins.
export const FIELD_ROLES = {
  storyPoints: {
    label: "Story points",
    names: ["Story Points", "Story point estimate", "Story Points estimate"],
  },
  startDate: {
    label: "Start date",
    names: ["Start date", "Start Date", "Target start"],
  },
  epicLink: {
    label: "Epic link",
    names: ["Epic Link", "Parent Link"],
  },
  // Company-managed Jira gives an epic a short label of its own, separate from
  // its summary — "Checkout rewrite" rather than "Rewrite the checkout flow to
  // support split payments". That is what belongs in a narrow column. Team-
  // managed projects have no such field, so callers fall back to the summary.
  epicName: {
    label: "Epic name",
    names: ["Epic Name"],
  },
  sprint: {
    label: "Sprint",
    names: ["Sprint"],
  },
};

// Fields every view needs, independent of Jira instance.
const BASE_ISSUE_FIELDS = [
  "key", "id", "summary", "issuetype", "status", "priority",
  "assignee", "created", "updated", "duedate",
  "parent", "subtasks", "components", "labels",
];

// Assigned to boards that arrive without a colour (e.g. imported from Jira).
export const BOARD_PALETTE = [
  "#4F8EF7", "#F7914F", "#4FCF8E", "#A855F7",
  "#EAB308", "#EC4899", "#14B8A6", "#F43F5E",
];

export const DEFAULT_STATUS_GROUPS = [
  { name: "To Do", statuses: ["To Do", "To Do List", "Open", "Backlog", "New"] },
  { name: "In Progress", statuses: ["In Progress", "In Development"] },
  { name: "In Review", statuses: ["In Review", "In Code Review", "Code Review", "Review"] },
  { name: "Done", statuses: ["Done", "Closed", "Resolved"] },
];

const DEFAULTS = {
  configVersion: 1,
  site: {
    baseUrl: "",      // e.g. https://your-org.atlassian.net — set during setup
    wikiPath: "/wiki",
  },
  brand: {
    productName: "butter_jira",
    tagline: "Because the other one sucks.",
    orgName: "",      // shown next to the nav logo when set
    orgLogo: "",      // path to an untracked file, e.g. assets/brand/logo.png
  },
  boards: [],         // [{ id, name, projectKey, color }]
  statusGroups: DEFAULT_STATUS_GROUPS,
  fields: {           // role -> [fieldId, ...], filled in by discovery
    storyPoints: [],
    startDate: [],
    epicLink: [],
    epicName: [],
    sprint: [],
  },
  additionalFields: [], // extra field IDs to request on every issue query
  // Monitoring checks are on unless explicitly muted — see js/monitor.js.
  monitorChecks: {},
  // Optional second data source (M11). `repos` is an allowlist, not a filter:
  // nothing is fetched from GitHub unless it is named here, so an empty list
  // means the feature is off however the other keys are set. Non-secret, so it
  // syncs — the token does not (see js/credentials.js).
  github: {
    enabled: false,
    host: "github.com",  // anything else is GitHub Enterprise Server
    org: "",
    repos: [],           // ["org/repo", ...] — typed in by the user, never discovered
  },
};

const STORAGE_KEYS = [
  "configVersion", "site", "brand", "boards",
  "statusGroups", "fields", "additionalFields", "monitorChecks", "github",
];

// Live config object. Mutated in place so modules can hold a reference.
export const CONFIG = structuredClone(DEFAULTS);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Shallow-merges one level into nested objects, replaces arrays outright.
function mergeInto(target, patch) {
  if (!isPlainObject(patch)) return target;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      Object.assign(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

async function readLocalOverrides() {
  // Untracked and usually absent — a 404 here is the normal case, not an error.
  try {
    const resp = await fetch(runtimeUrl(LOCAL_OVERRIDE_FILE));
    if (!resp.ok) return null;
    const parsed = await resp.json();
    if (!isPlainObject(parsed)) return null;
    // Keys starting with "_" are documentation in the example file, not config.
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !key.startsWith("_"))
    );
  } catch {
    return null;
  }
}

export async function loadConfig() {
  // Storage shape is brought up to date before anything reads it.
  await runMigrations();

  const local = await readLocalOverrides();
  const stored = await syncGet(STORAGE_KEYS);

  Object.assign(CONFIG, structuredClone(DEFAULTS));
  mergeInto(CONFIG, local);

  const localExtra = Array.isArray(local?.additionalFields) ? local.additionalFields : [];
  mergeInto(CONFIG, stored);

  // Union so a local override always contributes, whatever the UI holds.
  const storedExtra = Array.isArray(stored.additionalFields) ? stored.additionalFields : [];
  CONFIG.additionalFields = [...new Set([...localExtra, ...storedExtra])].filter(Boolean);

  if (!CONFIG.statusGroups?.length) CONFIG.statusGroups = DEFAULT_STATUS_GROUPS;
  CONFIG.site.baseUrl = normalizeBaseUrl(CONFIG.site.baseUrl);
  return CONFIG;
}

export async function saveConfig(patch) {
  mergeInto(CONFIG, patch);
  if (patch.site?.baseUrl !== undefined) {
    CONFIG.site.baseUrl = normalizeBaseUrl(CONFIG.site.baseUrl);
  }
  const toStore = {};
  for (const key of STORAGE_KEYS) toStore[key] = CONFIG[key];
  await syncSet(toStore);
  return CONFIG;
}

// Accepts "org.atlassian.net", "https://org.atlassian.net/", "http://jira.internal"
// and returns a scheme-qualified origin with no trailing slash. "" stays "".
export function normalizeBaseUrl(input) {
  const raw = (input || "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function isConfigured() {
  return Boolean(CONFIG.site.baseUrl);
}

export function hasBoards() {
  return Array.isArray(CONFIG.boards) && CONFIG.boards.length > 0;
}

export function jiraUrl(path) {
  if (!CONFIG.site.baseUrl) throw new Error("Jira base URL is not configured");
  return `${CONFIG.site.baseUrl}${path}`;
}

export function browseUrl(issueKey) {
  return CONFIG.site.baseUrl ? `${CONFIG.site.baseUrl}/browse/${issueKey}` : "#";
}

// A bare Atlassian Cloud origin lands on the product picker rather than on
// Jira, so cloud sites get an explicit product path. Server/Data Center
// installs serve Jira from the origin itself.
function isCloudSite() {
  return siteHost().endsWith(".atlassian.net");
}

// Both of these return "" when the site is not configured yet, so callers can
// tell "no destination" apart from a real URL instead of rendering a dead link.
export function jiraHomeUrl() {
  if (!CONFIG.site.baseUrl) return "";
  return isCloudSite() ? `${CONFIG.site.baseUrl}/jira` : CONFIG.site.baseUrl;
}

export function wikiUrl() {
  return CONFIG.site.baseUrl
    ? `${CONFIG.site.baseUrl}${CONFIG.site.wikiPath || "/wiki"}`
    : "";
}

export function siteHost() {
  if (!CONFIG.site.baseUrl) return "";
  try {
    return new URL(CONFIG.site.baseUrl).host;
  } catch {
    return "";
  }
}

export function fieldIds(role) {
  const ids = CONFIG.fields?.[role];
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

// Roles that only one narrow query needs, and so are kept out of the field list
// every board-wide query carries. `epicName` exists on epics alone — asking for
// it on every story would be one more field on every row for nothing.
const NARROW_FIELD_ROLES = new Set(["epicName"]);

// Full field list for issue queries: base fields, every discovered role field,
// and anything the user added via additionalFields.
export function issueFields() {
  const roleFields = Object.keys(FIELD_ROLES)
    .filter((role) => !NARROW_FIELD_ROLES.has(role))
    .flatMap((role) => fieldIds(role));
  return [...new Set([...BASE_ISSUE_FIELDS, ...roleFields, ...CONFIG.additionalFields])];
}

// Extra fields only the single-issue detail view needs. Kept out of the list
// used for board-wide queries, where they would bloat every response.
const DETAIL_ONLY_FIELDS = [
  "description", "reporter", "project", "issuelinks",
  "resolutiondate", "timetracking",
];

export function detailIssueFields() {
  return [...new Set([...issueFields(), ...DETAIL_ONLY_FIELDS])];
}

// Field ids that carry a human name of their own, for attributing a failed
// write to something the user recognises. Custom fields are resolved through
// the discovered role mapping instead, so `customfield_10016` reads back as
// "Story points" on a site where that is what it holds.
const BASE_FIELD_LABELS = {
  summary: "Summary",
  description: "Description",
  assignee: "Assignee",
  reporter: "Reporter",
  duedate: "Due date",
  priority: "Priority",
  labels: "Labels",
  components: "Components",
  issuetype: "Issue type",
  project: "Project",
  parent: "Parent",
  status: "Status",
};

// The label to show for a field id in an error or a form row. Falls through to
// the id itself rather than inventing a name: an unrecognised `customfield_*`
// in a rejection is still the most useful thing to print, because it is what
// the site admin will search for.
export function fieldLabel(id) {
  const key = String(id ?? "");
  if (!key) return "";
  if (BASE_FIELD_LABELS[key]) return BASE_FIELD_LABELS[key];
  for (const [role, meta] of Object.entries(FIELD_ROLES)) {
    if (fieldIds(role).includes(key)) return meta.label;
  }
  return key;
}

// The configured id for a role, for writes. Reads tolerate several candidate
// ids and take the first with a value in it; a write has to pick exactly one.
//
// Which one matters more than it looks. Field discovery can resolve two ids for
// the same role — a site with both company-managed and team-managed projects has
// "Story Points" *and* "Story point estimate" — and `fieldValue` reads whichever
// of them the issue actually holds. So a write that always took the first would
// set a field nothing reads, and the estimate on screen would not budge. Given
// the issue, the field it already uses wins; without one (a create, where there
// is no issue yet) the first configured id is the answer.
export function writeFieldId(role, issue = null) {
  const ids = fieldIds(role);
  if (issue?.fields) {
    for (const id of ids) {
      const value = issue.fields[id];
      if (value !== undefined && value !== null && value !== "") return id;
    }
  }
  return ids[0] || null;
}

// First non-empty value across the candidate fields for a role.
export function fieldValue(issue, role) {
  const f = issue?.fields;
  if (!f) return null;
  for (const id of fieldIds(role)) {
    const value = f[id];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function boardPaletteColor(index) {
  return BOARD_PALETTE[index % BOARD_PALETTE.length];
}

// Stable, CSS-safe token for a board — used for generated Gantt bar classes.
export function boardSlug(boardId) {
  return `b${String(boardId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
