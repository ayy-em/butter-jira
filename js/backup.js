// Backup and restore of what this app records on the device and cannot fetch
// again. Built 2026-09-29.
//
// ── Decisions, taken 2026-09-29 ──────────────────────────────────────────────
//
//   * **A button, not a schedule.** Settings → Backup & transfer. An automatic
//     backup needs a trigger, and this app has no background schedule; a daily
//     download nobody asked for would also fill a Downloads folder.
//   * **One file for every store**, so a restore cannot bring back half of a
//     setup. Stores are listed in `STORES` below, and a new one is added there
//     rather than getting a backup of its own.
//   * **Restore merges; it never overwrites.** For every store the device's own
//     data wins where both have an entry, and the backup fills the gaps: days a
//     snapshot series is missing, freezes for sprints this device never saw,
//     todos it does not have. Restoring last month's file onto a device in use
//     loses nothing. Config is restored only onto an unconfigured install;
//     replacing a working config is what Import config is for.
//   * **What is never in the file.** Tokens and the account email (moving a
//     credential is Import/Export config's job, behind its own confirms), the
//     response caches, and **1:1 notes**, which Settings has promised since
//     2026-09-06 have no path off the device. The roster is included only when
//     its box is ticked, as in the config export.

import { localGet, localSet, syncGet, syncSet } from "./browser.js";
import { MAX_SPRINTS_KEPT } from "./snapshots.js";

export const BACKUP_FORMAT = "butterjira-backup";
export const BACKUP_VERSION = 1;

const MAX_DAYS_PER_SPRINT = 60; // js/snapshots.js keeps the same depth

// Config lives in sync storage; the list mirrors `STORAGE_KEYS` in js/config.js.
const CONFIG_KEYS = [
  "configVersion", "site", "brand", "boards",
  "statusGroups", "fields", "additionalFields", "monitorChecks", "github", "planner",
];

// Small conveniences, restored only where this device has none of its own.
const PREFERENCE_KEYS = [
  "standupPrefs", "standupMuted", "backlogPrefs", "monitorScope", "paletteRecents",
  "teamOnly", "recapConfig", "openJiraLinksInApp",
];

export const STORES = {
  snapshots: "sprintSnapshots",
  freezes: "sprintFreezes",
  todos: "myTodos",
  roster: "teams",
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ── Building ────────────────────────────────────────────────────────────────

export function buildBackup({ local = {}, sync = {}, includeRoster = false, now = new Date() } = {}) {
  const pick = (source, keys) =>
    Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    schemaVersion: local.schemaVersion ?? null,
    config: pick(sync, CONFIG_KEYS),
    stores: {
      snapshots: isObject(local[STORES.snapshots]) ? local[STORES.snapshots] : {},
      freezes: isObject(local[STORES.freezes]) ? local[STORES.freezes] : {},
      todos: Array.isArray(local[STORES.todos]) ? local[STORES.todos] : [],
      ...(includeRoster && local[STORES.roster] ? { roster: local[STORES.roster] } : {}),
    },
    preferences: pick(local, PREFERENCE_KEYS),
  };
}

export function backupFilename(now = new Date()) {
  return `butterjira-backup-${now.toISOString().slice(0, 10)}.json`;
}

// What a file holds, for the confirm and the status line.
export function describeBackup(backup) {
  const s = backup?.stores || {};
  const days = Object.values(s.snapshots || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  const members = (s.roster?.teams || []).reduce((n, t) => n + (t.members?.length || 0), 0);
  return {
    sprints: Object.keys(s.snapshots || {}).length,
    days,
    freezes: Object.keys(s.freezes || {}).length,
    todos: (s.todos || []).length,
    members,
    roster: Boolean(s.roster),
    config: Boolean(backup?.config?.site?.baseUrl),
  };
}

// ── Reading a file ──────────────────────────────────────────────────────────

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a JSON file" };
  }
  if (data?.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      error:
        data?.format === "butterjira-config"
          ? "This is a config export — use Import config for it"
          : "Not a butter_jira backup file",
    };
  }
  if (Number(data.version) > BACKUP_VERSION) {
    return { ok: false, error: "This backup was made by a newer version — update the extension first" };
  }
  if (!isObject(data.stores)) return { ok: false, error: "The file holds no stores" };
  return { ok: true, backup: data };
}

// ── Merging, local first ────────────────────────────────────────────────────

// Per sprint, the union of days; a day both sides have keeps the device's row.
// Then the same bounds `recordSnapshot` keeps.
export function mergeSnapshots(local = {}, incoming = {}) {
  const all = { ...(isObject(local) ? local : {}) };
  let added = 0;
  for (const [key, list] of Object.entries(isObject(incoming) ? incoming : {})) {
    if (!Array.isArray(list)) continue;
    const mine = Array.isArray(all[key]) ? all[key] : [];
    const have = new Set(mine.map((d) => d?.date));
    const extra = list.filter((d) => d?.date && !have.has(d.date));
    added += extra.length;
    all[key] = [...mine, ...extra]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-MAX_DAYS_PER_SPRINT);
  }
  const keys = Object.keys(all);
  if (keys.length > MAX_SPRINTS_KEPT) {
    const kept = keys
      .map((k) => ({ k, last: all[k]?.[all[k].length - 1]?.date || "" }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .slice(0, MAX_SPRINTS_KEPT)
      .map((e) => e.k);
    for (const k of keys) if (!kept.includes(k)) delete all[k];
  }
  return { value: all, added };
}

// A freeze is a record of a moment. The device's wins; the backup supplies
// sprints this device never froze.
export function mergeFreezes(local = {}, incoming = {}) {
  const all = { ...(isObject(local) ? local : {}) };
  let added = 0;
  for (const [key, freeze] of Object.entries(isObject(incoming) ? incoming : {})) {
    if (all[key] || !Array.isArray(freeze?.rows)) continue;
    all[key] = freeze;
    added++;
  }
  const keys = Object.keys(all);
  if (keys.length > MAX_SPRINTS_KEPT) {
    const kept = keys
      .sort((a, b) => String(all[b]?.takenAt || "").localeCompare(String(all[a]?.takenAt || "")))
      .slice(0, MAX_SPRINTS_KEPT);
    for (const k of Object.keys(all)) if (!kept.includes(k)) delete all[k];
  }
  return { value: all, added };
}

export function mergeTodos(local = [], incoming = []) {
  const mine = Array.isArray(local) ? local : [];
  const ids = new Set(mine.map((t) => t?.id).filter(Boolean));
  const extra = (Array.isArray(incoming) ? incoming : []).filter((t) => t?.id && !ids.has(t.id));
  return { value: [...mine, ...extra], added: extra.length };
}

// Teams by id, members by account id or email; the device's entries first, so
// its values win and the backup only fills blanks (the rule `normalizeStructure`
// already applies to duplicates).
export function mergeRoster(local, incoming) {
  if (!isObject(incoming) || !Array.isArray(incoming.teams)) return { value: local, added: 0 };
  if (!isObject(local) || !Array.isArray(local.teams) || !local.teams.some((t) => t.members?.length)) {
    const added = incoming.teams.reduce((n, t) => n + (t.members?.length || 0), 0);
    return { value: incoming, added };
  }
  const teams = local.teams.map((t) => ({ ...t, members: [...(t.members || [])] }));
  let added = 0;
  const idOf = (m) => (m?.accountId ? `id:${m.accountId}` : m?.email ? `mail:${String(m.email).toLowerCase()}` : "");
  for (const team of incoming.teams) {
    const target = teams.find((t) => t.id === team.id);
    if (!target) {
      teams.push(team);
      added += team.members?.length || 0;
      continue;
    }
    const known = new Set(target.members.map(idOf).filter(Boolean));
    for (const m of team.members || []) {
      const id = idOf(m);
      if (id && known.has(id)) continue;
      target.members.push(m);
      added++;
    }
  }
  return { value: { ...local, teams }, added };
}

// Everything a restore would write, and what it would add, without writing.
export function planRestore(backup, { local = {}, sync = {} } = {}) {
  const s = backup?.stores || {};
  const snapshots = mergeSnapshots(local[STORES.snapshots], s.snapshots);
  const freezes = mergeFreezes(local[STORES.freezes], s.freezes);
  const todos = mergeTodos(local[STORES.todos], s.todos);
  const roster = s.roster ? mergeRoster(local[STORES.roster], s.roster) : { value: undefined, added: 0 };

  const localWrites = {
    [STORES.snapshots]: snapshots.value,
    [STORES.freezes]: freezes.value,
    [STORES.todos]: todos.value,
  };
  if (roster.value !== undefined) localWrites[STORES.roster] = roster.value;
  const prefs = [];
  for (const [key, value] of Object.entries(isObject(backup?.preferences) ? backup.preferences : {})) {
    if (PREFERENCE_KEYS.includes(key) && local[key] === undefined) {
      localWrites[key] = value;
      prefs.push(key);
    }
  }

  const configured = Boolean(sync?.site?.baseUrl);
  const restoreConfig = !configured && Boolean(backup?.config?.site?.baseUrl);
  const syncWrites = restoreConfig
    ? Object.fromEntries(Object.entries(backup.config).filter(([k]) => CONFIG_KEYS.includes(k)))
    : {};

  return {
    localWrites,
    syncWrites,
    added: {
      snapshotDays: snapshots.added,
      freezes: freezes.added,
      todos: todos.added,
      members: roster.added,
      preferences: prefs.length,
    },
    config: restoreConfig ? "restored" : backup?.config?.site?.baseUrl ? "kept" : "none",
  };
}

// ── Storage ─────────────────────────────────────────────────────────────────

export async function readDeviceState() {
  const [local, sync] = await Promise.all([localGet(null), syncGet(CONFIG_KEYS)]);
  return { local: local || {}, sync: sync || {} };
}

export async function createBackup({ includeRoster = false, now = new Date() } = {}) {
  const { local, sync } = await readDeviceState();
  return buildBackup({ local, sync, includeRoster, now });
}

export async function applyRestore(plan) {
  await localSet(plan.localWrites);
  if (Object.keys(plan.syncWrites).length) await syncSet(plan.syncWrites);
}
