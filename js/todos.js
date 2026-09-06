// My todos — the manager's own list, across every 1:1 (M14).
//
// A 1:1 produces actions for both people in the room. The ones owned by *them*
// belong on their sheet and are carried forward there. The ones owned by *me*
// would otherwise be scattered across a dozen sheets, which is how a commitment
// made in a conversation quietly stops existing. So completing a 1:1 pushes
// them here, and this is the one list to read before the day starts.
//
// Deliberately flat and deliberately small: text, an optional deadline, an
// optional link, and where it came from. Not a project tracker — Jira is
// already open in the next tab, and anything worth tracking properly belongs
// there rather than in a local list with no history and no sharing.
//
// ── Storage ──────────────────────────────────────────────────────────────────
//
// Device-local extension storage, like everything else this app records. A
// daily automatic JSON backup was specified alongside this and moved out to the
// deferred backlog before any code: backing up one store is the wrong unit,
// since the roster, the snapshots, the freezes and the 1:1 archive all have the
// same problem and want one answer between them.
//
// Note that a todo sourced from a 1:1 carries a colleague's name in
// `sourceLabel`. That makes this list personal data by the same argument the
// 1:1 notes are, so it lives beside them: never `storage.sync`, never in a
// config export, and cleared by the same Settings action.

import { localGet, localSet } from "./browser.js";
import { safeUrl } from "./sanitize.js";
import { newId, normalizeDue } from "./oneone.js";

export const TODOS_KEY = "myTodos";

export const SOURCES = ["manual", "1on1"];

function text(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

function iso(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export function normalizeItem(raw = {}, now = new Date()) {
  return {
    id: text(raw.id, 64) || newId("m", now),
    text: text(raw.text, 500),
    // Where it came from, which is the difference between "I wrote this down"
    // and "I said this to someone". Only the second one has a person waiting.
    source: raw.source === "1on1" ? "1on1" : "manual",
    // The colleague's display name for a 1:1-sourced item. Empty for manual
    // ones — a source column that reads "manual · me" says nothing twice.
    sourceLabel: text(raw.sourceLabel, 80),
    due: normalizeDue(raw.due),
    // http(s) only, through the same allowlist the issue detail sanitises
    // Jira's HTML with. A `javascript:` href in a local list is still a
    // `javascript:` href.
    link: safeUrl(raw.link) || "",
    done: raw.done === true,
    createdAt: iso(raw.createdAt) || now.toISOString(),
    doneAt: raw.done === true ? iso(raw.doneAt) || now.toISOString() : "",
    // The 1:1 todo this came from. Carried so a second Complete on the same
    // person cannot push the same open action twice — see `mergeFromOneOne`.
    originId: text(raw.originId, 64),
  };
}

export function normalizeList(raw, now = new Date()) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => normalizeItem(item, now))
    .filter((item) => item.text.trim());
}

// Open first, then by deadline, then oldest first.
//
// Undated items sort after dated ones rather than before: an action with a date
// on it is the one with something to miss. Within the done half the most
// recently finished is first, which is the half people scan to check something
// actually got done.
export function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return String(b.doneAt).localeCompare(String(a.doneAt));
    if (Boolean(a.due) !== Boolean(b.due)) return a.due ? -1 : 1;
    if (a.due !== b.due) return a.due.localeCompare(b.due);
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export function isOverdueTodo(item, now = new Date()) {
  if (!item?.due || item.done) return false;
  return item.due < now.toISOString().slice(0, 10);
}

export function addTodo(list, raw, now = new Date()) {
  const item = normalizeItem(raw, now);
  if (!item.text.trim()) return list;
  return [...normalizeList(list, now), item];
}

export function updateTodo(list, id, patch, now = new Date()) {
  return normalizeList(list, now).map((item) =>
    item.id === id ? normalizeItem({ ...item, ...patch, id: item.id }, now) : item
  );
}

export function toggleTodo(list, id, now = new Date()) {
  return normalizeList(list, now).map((item) => {
    if (item.id !== id) return item;
    const done = !item.done;
    return normalizeItem({ ...item, done, doneAt: done ? now.toISOString() : "" }, now);
  });
}

export function removeTodo(list, id, now = new Date()) {
  return normalizeList(list, now).filter((item) => item.id !== id);
}

export function clearDone(list, now = new Date()) {
  return normalizeList(list, now).filter((item) => !item.done);
}

// Push the me-owned actions out of a completed 1:1 into this list.
//
// Idempotent by `originId`: a 1:1 whose open actions carry forward will offer
// the same action again at the next Complete, and it must land here once rather
// than once per meeting. An item already here and already ticked stays ticked —
// re-adding it would resurrect something the user has explicitly finished.
export function mergeFromOneOne(list, { todos = [], personLabel = "", now = new Date() } = {}) {
  const current = normalizeList(list, now);
  const known = new Set(current.map((item) => item.originId).filter(Boolean));
  const incoming = todos
    .filter((t) => t && t.owner === "me" && !t.done && String(t.text || "").trim())
    .filter((t) => !known.has(t.id))
    .map((t) =>
      normalizeItem(
        {
          text: t.text,
          source: "1on1",
          sourceLabel: personLabel,
          due: t.due,
          originId: t.id,
          createdAt: now.toISOString(),
        },
        now
      )
    );
  return [...current, ...incoming];
}

export function countOpen(list) {
  return (list || []).filter((item) => !item.done).length;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function loadTodos(now = new Date()) {
  const stored = await localGet([TODOS_KEY]);
  return normalizeList(stored[TODOS_KEY], now);
}

export async function saveTodos(list, now = new Date()) {
  const next = normalizeList(list, now);
  await localSet({ [TODOS_KEY]: next });
  return next;
}

export async function clearAllTodos() {
  await localSet({ [TODOS_KEY]: [] });
  return [];
}
