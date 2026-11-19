// Standup recaps as Markdown files in a folder of the user's choosing.
//
// Each finished standup is written to
//   <chosen folder>/standup-recaps/<YYYY>/<MM>/standup_<YYYY>-<MM>-<DD>.md
// with a YAML metaheader (date, weekday, start time, duration, speaking time,
// each participant's talk time) above the recap text as it was posted to Slack.
// A second standup on the same day gets `_2`, `_3`, … rather than overwriting
// the first; rewriting the same standup (the text was edited after the first
// write) replaces its own file, recognised by the `id` in its metaheader.
//
// Why the File System Access API: an extension cannot otherwise write outside
// the Downloads folder. It exists in Chrome and Edge, not in Firefox, so there
// the setting says so and nothing is written. The folder handle cannot go into
// chrome.storage (it is not JSON), so it lives in this origin's IndexedDB,
// which the settings page and the app share. It is never in a config export or
// a backup: a handle means nothing on another machine.
//
// The browser only shows the folder's own name, never its full path, and asks
// for write access again in a new browser session unless "Allow on every visit"
// was picked. That prompt needs a click, so the end screen's "Save recap"
// button is the fallback when the automatic write finds no permission.

import { historyRecord } from "./standup.js";

export const RECAP_ROOT = "standup-recaps";

const DB_NAME = "butter_jira";
const STORE = "handles";
const HANDLE_KEY = "recapFolder";

// ── Pure: where, and what ───────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

// Local calendar date: a standup at 09:00 in Amsterdam belongs to that day,
// whatever UTC says.
export function localIsoDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Folder segments and the file name for a standup that started at `date`.
// `n` > 1 is the n-th standup of that day.
export function recapPath(date, n = 1) {
  const day = localIsoDay(date);
  const [year, month] = day.split("-");
  const suffix = n > 1 ? `_${n}` : "";
  return { dirs: [RECAP_ROOT, year, month], file: `standup_${day}${suffix}.md` };
}

// m:ss, or h:mm:ss past the hour.
export function clock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// JSON strings are valid YAML double-quoted scalars, so this is the whole of
// the escaping a name with a colon or a quote in it needs.
const yamlStr = (value) => JSON.stringify(String(value ?? ""));

// The file's text. `labelFor` turns an account id into the name shown; `digest`
// is the recap as it stands in the end screen's box (edits included).
export function recapMarkdown(session, { labelFor = (id) => id, digest = "" } = {}) {
  const record = historyRecord(session);
  const started = new Date(record.startedAt);
  const weekday = started.toLocaleDateString("en-GB", { weekday: "long" });
  const lines = [
    "---",
    `date: ${localIsoDay(started)}`,
    `weekday: ${weekday}`,
    `started: ${yamlStr(`${pad(started.getHours())}:${pad(started.getMinutes())}`)}`,
    `duration: ${yamlStr(clock(record.durationMs))}`,
    `speaking_time: ${yamlStr(clock(record.speakingMs))}`,
    `participant_count: ${record.attendees.length}`,
    "participants:",
  ];
  for (const a of record.attendees) {
    lines.push(`  - name: ${yamlStr(labelFor(a.accountId))}`);
    // null rather than 0:00 for someone the standup ended before reaching.
    lines.push(`    talk_time: ${a.spokeMs === null ? "null" : yamlStr(clock(a.spokeMs))}`);
    lines.push(`    planned: ${yamlStr(clock(a.plannedSec * 1000))}`);
  }
  lines.push(`ended_early: ${record.endedEarly}`);
  lines.push(`id: ${yamlStr(record.id)}`);
  lines.push("---", "");
  const body = String(digest || "").trim();
  lines.push(body || "_No parking-lot notes._", "");
  return lines.join("\n");
}

// The id a recap file was written for, read back from its metaheader.
export function recapIdOf(text) {
  const head = String(text || "").match(/^---\n([\s\S]*?)\n---/);
  const line = head?.[1].split("\n").find((l) => l.startsWith("id: "));
  if (!line) return "";
  try {
    return String(JSON.parse(line.slice(4)));
  } catch {
    return "";
  }
}

// ── The folder handle ───────────────────────────────────────────────────────

export function recapFolderSupported() {
  return typeof globalThis.showDirectoryPicker === "function" && typeof indexedDB !== "undefined";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getRecapFolder() {
  if (!recapFolderSupported()) return null;
  try {
    return (await idb("readonly", (s) => s.get(HANDLE_KEY))) || null;
  } catch {
    return null;
  }
}

// Opens the browser's folder picker; must run inside a click. Returns the
// handle, or null when the picker was dismissed.
export async function chooseRecapFolder() {
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({ id: "butter-jira-recaps", mode: "readwrite" });
  } catch (err) {
    if (err?.name === "AbortError") return null;
    throw err;
  }
  await idb("readwrite", (s) => s.put(handle, HANDLE_KEY));
  return handle;
}

export async function forgetRecapFolder() {
  if (!recapFolderSupported()) return;
  await idb("readwrite", (s) => s.delete(HANDLE_KEY));
}

// "granted", "prompt" or "denied". With `request`, asks — which needs a click.
export async function folderPermission(handle, { request = false } = {}) {
  if (!handle) return "denied";
  const opts = { mode: "readwrite" };
  try {
    const state = await handle.queryPermission(opts);
    if (state === "granted" || !request) return state;
    return await handle.requestPermission(opts);
  } catch {
    return "denied";
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function dirFor(root, dirs) {
  let dir = root;
  for (const name of dirs) dir = await dir.getDirectoryHandle(name, { create: true });
  return dir;
}

async function readIfExists(dir, file) {
  try {
    const handle = await dir.getFileHandle(file);
    return await (await handle.getFile()).text();
  } catch (err) {
    if (err?.name === "NotFoundError") return null;
    throw err;
  }
}

// The file this standup owns: its own earlier file, or the first free name of
// the day. A day with more than 20 standups is not a day this handles.
async function slotFor(dir, date, id) {
  for (let n = 1; n <= 20; n++) {
    const { file } = recapPath(date, n);
    const text = await readIfExists(dir, file);
    if (text === null || recapIdOf(text) === id) return file;
  }
  throw new Error("Too many standups on one day");
}

// Writes the recap. Returns the path written, relative to the chosen folder.
// Throws when there is no folder or no permission, so the caller can offer the
// click that grants it.
export async function writeRecap(root, session, { labelFor, digest } = {}) {
  const text = recapMarkdown(session, { labelFor, digest });
  const id = historyRecord(session).id;
  const date = new Date(session.startedAt);
  const { dirs } = recapPath(date);
  const dir = await dirFor(root, dirs);
  const file = await slotFor(dir, date, id);
  const writable = await (await dir.getFileHandle(file, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
  return [...dirs, file].join("/");
}

// Removes this standup's recap, for the end screen's "don't record". Only a
// file carrying this standup's id is touched.
export async function removeRecap(root, session) {
  const id = historyRecord(session).id;
  const date = new Date(session.startedAt);
  let dir = root;
  try {
    for (const name of recapPath(date).dirs) dir = await dir.getDirectoryHandle(name);
  } catch {
    return false;
  }
  for (let n = 1; n <= 20; n++) {
    const { file } = recapPath(date, n);
    const text = await readIfExists(dir, file);
    if (text !== null && recapIdOf(text) === id) {
      await dir.removeEntry(file);
      return true;
    }
  }
  return false;
}
