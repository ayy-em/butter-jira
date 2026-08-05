// Config export/import.
//
// The belt-and-braces answer to "I lost my settings": a JSON file you can keep,
// hand to a teammate, or carry to another browser. The API token is excluded by
// default — including it puts a live credential in a file on disk, which is the
// user's call to make explicitly, not a default.

import { CONFIG, DEFAULT_STATUS_GROUPS, normalizeBaseUrl } from "./config.js";
import { SCHEMA_VERSION } from "./migrations.js";

export const EXPORT_FORMAT = "butterjira-config";
export const EXPORT_VERSION = 1;

// `now` and `credentials` are injected so this stays pure and testable.
export function buildExport({ now = new Date(), credentials = null, includeToken = false } = {}) {
  const payload = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    config: {
      site: { ...CONFIG.site },
      brand: { ...CONFIG.brand },
      boards: (CONFIG.boards || []).map((b) => ({ ...b })),
      statusGroups: (CONFIG.statusGroups || []).map((g) => ({ ...g, statuses: [...g.statuses] })),
      fields: Object.fromEntries(
        Object.entries(CONFIG.fields || {}).map(([role, ids]) => [role, [...(ids || [])]])
      ),
      additionalFields: [...(CONFIG.additionalFields || [])],
    },
  };

  if (credentials?.email) {
    payload.account = { email: credentials.email };
    if (includeToken && credentials.token) {
      payload.account.token = credentials.token;
      payload.account.tokenExpiresAt = credentials.tokenExpiresAt || null;
      payload.containsSecret = true;
    }
  }

  return payload;
}

export function exportFilename(now = new Date()) {
  return `butterjira-config-${now.toISOString().slice(0, 10)}.json`;
}

// Validates and normalises an imported payload. Returns
// { ok, config, account, warnings, error } — never throws on bad input.
export function parseImport(text) {
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object" };
  }
  if (raw.format !== EXPORT_FORMAT) {
    return { ok: false, error: "Not a ButterJira config export" };
  }
  if (Number(raw.formatVersion) > EXPORT_VERSION) {
    warnings.push(
      `File was written by a newer version (format v${raw.formatVersion}); unknown keys are ignored.`
    );
  }

  const src = raw.config && typeof raw.config === "object" ? raw.config : {};
  const config = {};

  const baseUrl = normalizeBaseUrl(src.site?.baseUrl);
  if (src.site?.baseUrl && !baseUrl) warnings.push("Site URL in the file was unreadable and was skipped.");
  if (baseUrl) {
    config.site = { baseUrl };
    if (typeof src.site.wikiPath === "string") config.site.wikiPath = src.site.wikiPath;
  }

  if (src.brand && typeof src.brand === "object") {
    config.brand = {};
    for (const key of ["productName", "tagline", "orgName", "orgLogo"]) {
      if (typeof src.brand[key] === "string") config.brand[key] = src.brand[key];
    }
  }

  if (Array.isArray(src.boards)) {
    const boards = src.boards
      .filter((b) => b && Number(b.id) > 0)
      .map((b) => ({
        id: Number(b.id),
        name: String(b.name || b.projectKey || `Board ${b.id}`),
        projectKey: String(b.projectKey || ""),
        color: typeof b.color === "string" ? b.color : "",
      }));
    const dropped = src.boards.length - boards.length;
    if (dropped > 0) warnings.push(`${dropped} board entr${dropped === 1 ? "y" : "ies"} skipped (missing a valid id).`);
    config.boards = boards;
  }

  if (Array.isArray(src.statusGroups)) {
    const groups = src.statusGroups
      .filter((g) => g && typeof g.name === "string" && g.name.trim() && Array.isArray(g.statuses))
      .map((g) => ({
        name: g.name.trim(),
        statuses: g.statuses.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()),
      }))
      .filter((g) => g.statuses.length);
    config.statusGroups = groups.length ? groups : DEFAULT_STATUS_GROUPS;
    if (!groups.length) warnings.push("No usable status groups in the file; defaults kept.");
  }

  if (src.fields && typeof src.fields === "object") {
    config.fields = Object.fromEntries(
      Object.entries(src.fields)
        .filter(([, ids]) => Array.isArray(ids))
        .map(([role, ids]) => [role, ids.filter((id) => typeof id === "string" && id.trim())])
    );
  }

  if (Array.isArray(src.additionalFields)) {
    config.additionalFields = [
      ...new Set(src.additionalFields.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())),
    ];
  }

  const account = {};
  if (typeof raw.account?.email === "string") account.email = raw.account.email;
  if (typeof raw.account?.token === "string") {
    account.token = raw.account.token;
    if (typeof raw.account.tokenExpiresAt === "string") {
      account.tokenExpiresAt = raw.account.tokenExpiresAt;
    }
    warnings.push("File contains an API token — it will be stored on this device.");
  }

  if (!Object.keys(config).length && !Object.keys(account).length) {
    return { ok: false, error: "File contained nothing importable" };
  }

  return { ok: true, config, account, warnings };
}

// Triggers a file download from an extension page. No `downloads` permission
// needed — an object URL on a synthetic <a> is enough.
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
