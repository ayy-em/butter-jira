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
    productName: "ButterJira",
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
    sprint: [],
  },
  additionalFields: [], // extra field IDs to request on every issue query
  // Monitoring checks are on unless explicitly muted — see js/monitor.js.
  monitorChecks: {},
};

const STORAGE_KEYS = [
  "configVersion", "site", "brand", "boards",
  "statusGroups", "fields", "additionalFields", "monitorChecks",
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
    const resp = await fetch(chrome.runtime.getURL(LOCAL_OVERRIDE_FILE));
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

function readStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

export async function loadConfig() {
  // Storage shape is brought up to date before anything reads it.
  await runMigrations();

  const local = await readLocalOverrides();
  const stored = await readStorage(STORAGE_KEYS);

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
  await chrome.storage.sync.set(toStore);
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

// Full field list for issue queries: base fields, every discovered role field,
// and anything the user added via additionalFields.
export function issueFields() {
  const roleFields = Object.keys(FIELD_ROLES).flatMap((role) => fieldIds(role));
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
