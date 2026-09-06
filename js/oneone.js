// Weekly 1:1 sheet — the model behind the screen (M14).
//
// One person, one window: what is on their plate, what they did, what is stuck,
// what is planned — and, on the right, what the two people in the room agreed.
// This module holds everything that can be decided without a DOM, so the rules
// that matter are testable: which window a sheet opens on, what "Complete 1:1"
// does to the record, what carries into next time, and what the Slack paste
// says.
//
// ── The most sensitive thing this app stores ─────────────────────────────────
//
// Everything else here derives from Jira or GitHub and could be re-fetched. A
// 1:1 note is written by the user, about a named colleague, and exists nowhere
// else. So, decided when the milestone was scoped and not to be relaxed
// casually:
//
//   * **Device-local, never `storage.sync`.** Same store as the roster, for a
//     stronger reason than the roster had.
//   * **No export path at all.** There is no checkbox in the config export for
//     these, because there is nothing to tick — `js/portable.js` never reads
//     this key. The one way a note moves is the user pressing "Copy for Slack"
//     and pasting it themselves, which is a person moving text, not the app
//     sending anything anywhere.
//   * **Kept until cleared, and clearable in one place.** Retention is
//     deliberately unbounded — a 1:1 history that silently forgets last quarter
//     is worse than one that grows, and pruning notes about people on a timer
//     is its own bad surprise. That makes `clearAllOneOnes()` and the Settings
//     button in front of it the whole mitigation, so it has to stay findable.
//   * **Not a performance dashboard.** The screen shows one person at a time,
//     never two side by side, and no trend line over line counts. See the
//     framing note at the top of `js/activity.js`, which this inherits.
//
// ── Why "Complete 1:1" and not "last opened" ─────────────────────────────────
//
// The window a sheet opens on is *since the last completed 1:1 with that
// person*, which is the only rule that serves a mixed cadence — weekly with
// some people, fortnightly with others — without anyone configuring a cadence
// per colleague. It is deliberately not last-opened: opening a sheet by
// accident, or to check something on a Tuesday, must not move the boundary and
// silently hide a week of work from the next real conversation.

import { localGet, localSet } from "./browser.js";

export const ONEONE_KEY = "oneOnes";

// A draft is what has been typed since the last Complete. Past this age it is
// stale — a note typed a month ago reappearing mid-meeting as though it were
// this week's is worse than losing it. Carried-over actions survive the prune
// (see `pruneStaleDraft`): they are standing business, not scratch.
export const DRAFT_MAX_AGE_DAYS = 21;

// No sprint start date to work from. Same fourteen days `js/github.js` falls
// back to, and named the same way, so "this sprint" cannot come to mean two
// different lengths in two places.
export const FALLBACK_SPRINT_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// The toggle on the sheet. `last` is not in this list because it is not a
// choice the user makes — it is where the sheet opens, and picking any of these
// leaves it.
export const WINDOW_OPTIONS = [
  { id: "1w", label: "1 week", days: 7 },
  { id: "2w", label: "2 weeks", days: 14 },
  { id: "sprint", label: "This sprint", days: null },
];

export const OWNERS = ["me", "them"];

// ── Ids ──────────────────────────────────────────────────────────────────────

// Monotonic within a session and unique across them. Not crypto: these key list
// rows and dedupe a todo that has been carried into the personal list, and a
// collision costs a mis-ticked checkbox rather than anything durable.
let idSeq = 0;
export function newId(prefix = "i", now = new Date()) {
  idSeq = (idSeq + 1) % 100000;
  return `${prefix}-${now.getTime().toString(36)}-${idSeq.toString(36)}`;
}

// ── Normalisation ────────────────────────────────────────────────────────────
//
// Every read goes through these. Stored shapes outlive the code that wrote
// them, and a screen that trusts what came out of storage is a screen that
// breaks on the first hand-edited or half-migrated record.

// Control characters out, length capped. The same treatment
// `normalizeSlackHandle` gives roster input, and for the same reason: this text
// gets pasted into a Slack message, and a stray control character travels with
// it.
function text(value, max = 2000) {
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

// Due dates are dates, not instants: "by Friday" has no time of day, and
// storing one would print a timezone-shifted day to somebody travelling.
export function normalizeDue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

export function normalizeTodo(raw = {}, now = new Date()) {
  return {
    id: text(raw.id, 64) || newId("t", now),
    text: text(raw.text, 500),
    // Two owners, because every action in a 1:1 belongs to one of the two
    // people in the room. A roster picker would be more general and slower to
    // set mid-conversation, which is the only moment this is ever used.
    owner: raw.owner === "me" ? "me" : "them",
    due: normalizeDue(raw.due),
    done: raw.done === true,
    // The date of the session this came from, when it was carried rather than
    // typed. Printed under a rule above the new items so a standing action does
    // not read as something just agreed.
    carriedFrom: iso(raw.carriedFrom),
  };
}

export function normalizeInfoItem(raw = {}, now = new Date()) {
  return {
    id: text(raw.id, 64) || newId("n", now),
    text: text(raw.text, 1000),
  };
}

export function emptyDraft() {
  return { todos: [], info: [], updatedAt: "" };
}

export function normalizeDraft(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return emptyDraft();
  return {
    todos: (Array.isArray(raw.todos) ? raw.todos : []).map((t) => normalizeTodo(t, now)),
    info: (Array.isArray(raw.info) ? raw.info : []).map((i) => normalizeInfoItem(i, now)),
    updatedAt: iso(raw.updatedAt),
  };
}

export function normalizeSession(raw, now = new Date()) {
  const draft = normalizeDraft(raw, now);
  return {
    id: text(raw?.id, 64) || newId("s", now),
    completedAt: iso(raw?.completedAt),
    // The window the sheet was showing when it was completed, kept so a past
    // session can say what period it was about rather than only when it was.
    windowId: text(raw?.windowId, 16),
    from: iso(raw?.from),
    to: iso(raw?.to),
    todos: draft.todos,
    info: draft.info,
  };
}

export function emptyPerson() {
  return { lastCompletedAt: "", draft: emptyDraft(), sessions: [] };
}

export function normalizePerson(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return emptyPerson();
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .map((s) => normalizeSession(s, now))
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  return {
    lastCompletedAt:
      iso(raw.lastCompletedAt) ||
      // Recoverable from the archive when the marker itself is missing, which
      // beats silently reverting a fortnightly report to a one-week window.
      (sessions.length ? sessions[sessions.length - 1].completedAt : ""),
    draft: normalizeDraft(raw.draft, now),
    sessions,
  };
}

export function normalizeStore(raw, now = new Date()) {
  const people = {};
  const src = raw && typeof raw === "object" ? raw.people : null;
  if (src && typeof src === "object") {
    for (const [id, person] of Object.entries(src)) {
      if (!id) continue;
      people[String(id)] = normalizePerson(person, now);
    }
  }
  return { people };
}

export function personFor(store, accountId) {
  const raw = store?.people?.[String(accountId)];
  return raw ? normalizePerson(raw) : emptyPerson();
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export function isDraftStale(draft, now = new Date()) {
  const at = Date.parse(draft?.updatedAt || "");
  if (!Number.isFinite(at)) return false; // never touched: nothing to go stale
  return now.getTime() - at > DRAFT_MAX_AGE_DAYS * DAY_MS;
}

// Stale drafts lose what was typed and keep what was carried. The two halves
// answer to different rules: scratch that has sat for three weeks is misleading
// on a screen that looks current, while an action agreed last time is open
// business until it is ticked.
export function pruneStaleDraft(draft, now = new Date()) {
  const clean = normalizeDraft(draft, now);
  if (!isDraftStale(clean, now)) return clean;
  const carried = clean.todos.filter((t) => t.carriedFrom && !t.done);
  return { todos: carried, info: [], updatedAt: carried.length ? clean.updatedAt : "" };
}

export function draftFor(store, accountId, now = new Date()) {
  return pruneStaleDraft(personFor(store, accountId).draft, now);
}

// ── Windows ──────────────────────────────────────────────────────────────────

export function daysSince(isoDate, now = new Date()) {
  const at = Date.parse(isoDate || "");
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

// "14 days ago", "yesterday", "never" — what the picker row prints, and the
// only number on that screen. Whoever you are most overdue with should be
// legible without reading a date.
export function lastMetLabel(isoDate, now = new Date()) {
  const days = daysSince(isoDate, now);
  if (days === null) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// Where a sheet opens, and what the toggle does to it.
//
// `windowId` empty means "wherever this person should open" — since the last
// completed 1:1 if there has been one, and otherwise the current sprint. The
// first conversation with somebody wants the fuller picture, and the sprint is
// the window every other screen in this app already computes.
export function windowFor({
  windowId = "",
  lastCompletedAt = "",
  sprintStart = "",
  now = new Date(),
} = {}) {
  const to = now.toISOString();
  const hasSprint = Number.isFinite(Date.parse(sprintStart || ""));
  const sprintFrom = () =>
    hasSprint
      ? new Date(Date.parse(sprintStart)).toISOString()
      : new Date(now.getTime() - FALLBACK_SPRINT_DAYS * DAY_MS).toISOString();

  if (!windowId) {
    const days = daysSince(lastCompletedAt, now);
    if (days === null) {
      return {
        id: "sprint",
        from: sprintFrom(),
        to,
        label: "This sprint",
        // Said on the screen, because a first sheet showing a sprint where
        // every other sheet shows a fortnight is otherwise just confusing.
        note: "First 1:1 with this person — showing the current sprint.",
        basis: "first",
      };
    }
    return {
      id: "last",
      from: new Date(Date.parse(lastCompletedAt)).toISOString(),
      to,
      label: `Since your last 1:1 · ${lastMetLabel(lastCompletedAt, now)}`,
      note: "",
      basis: "last",
    };
  }

  if (windowId === "sprint") {
    return {
      id: "sprint",
      from: sprintFrom(),
      to,
      label: "This sprint",
      note: hasSprint ? "" : `No sprint start date — using ${FALLBACK_SPRINT_DAYS} days.`,
      basis: hasSprint ? "sprint" : "fallback",
    };
  }

  const option = WINDOW_OPTIONS.find((o) => o.id === windowId) || WINDOW_OPTIONS[0];
  return {
    id: option.id,
    from: new Date(now.getTime() - option.days * DAY_MS).toISOString(),
    to,
    label: option.label,
    note: "",
    basis: "fixed",
  };
}

// ── Completing a session ─────────────────────────────────────────────────────

// Freeze the draft into a dated, read-only entry; carry what is still open into
// the next one; stamp the clock.
//
// Read-only is the point of the archive: a record that can be revised is not a
// record of what was said. Nothing here deletes, so the archive only grows —
// see the retention note at the top.
export function completeSession(
  store,
  accountId,
  { draft, window: win = null, now = new Date() } = {}
) {
  const next = normalizeStore(store, now);
  const id = String(accountId);
  const person = personFor(next, id);
  const clean = normalizeDraft(draft ?? person.draft, now);
  const completedAt = now.toISOString();

  const session = normalizeSession(
    {
      id: newId("s", now),
      completedAt,
      windowId: win?.id || "",
      from: win?.from || "",
      to: win?.to || completedAt,
      todos: clean.todos,
      info: clean.info,
    },
    now
  );

  // Open actions move forward, tagged with the session they came from, and are
  // renumbered so ticking a carried item cannot reach back into the archive.
  const carried = session.todos
    .filter((t) => !t.done && t.text.trim())
    .map((t) =>
      normalizeTodo(
        { ...t, id: newId("t", now), carriedFrom: t.carriedFrom || completedAt },
        now
      )
    );

  next.people[id] = {
    lastCompletedAt: completedAt,
    draft: { todos: carried, info: [], updatedAt: carried.length ? completedAt : "" },
    sessions: [...person.sessions, session],
  };

  return { store: next, session, carried };
}

// Open actions in a person's current draft — what the picker row counts, so you
// know there is unfinished business before you open the sheet.
export function openTodoCount(store, accountId, now = new Date()) {
  return draftFor(store, accountId, now).todos.filter((t) => !t.done && t.text.trim()).length;
}

// ── The Slack paste ──────────────────────────────────────────────────────────

// What the person actually receives, and deliberately not a transcript of the
// left pane: the message is the meeting's outcomes, not its numbers.
//
// Plain text with Slack's own emphasis marks, because it is pasted into a
// message box rather than rendered by anything here. Owners are printed as
// words rather than a name, since "you" and "me" is exactly how the two people
// in the room said it.
export function slackText({ name = "", session = null, when = new Date() } = {}) {
  const clean = normalizeDraft(session, when);
  const lines = [];
  const stamp = Date.parse(session?.completedAt || "");
  const date = new Date(Number.isFinite(stamp) ? stamp : when.getTime())
    .toISOString()
    .slice(0, 10);

  lines.push(`*1:1 — ${name || "notes"} · ${date}*`);

  const written = clean.todos.filter((t) => t.text.trim());
  const fresh = written.filter((t) => !t.carriedFrom);
  const carried = written.filter((t) => t.carriedFrom && !t.done);
  const info = clean.info.filter((i) => i.text.trim());

  if (fresh.length) {
    lines.push("", "*TODO*");
    for (const todo of fresh) lines.push(todoLine(todo));
  }
  if (carried.length) {
    lines.push("", "*Still open from before*");
    for (const todo of carried) lines.push(todoLine(todo));
  }
  if (info.length) {
    lines.push("", "*Important info*");
    for (const item of info) lines.push(`• ${item.text.trim()}`);
  }

  if (lines.length === 1) lines.push("", "_Nothing was written down._");
  return lines.join("\n");
}

function todoLine(todo) {
  const box = todo.done ? "☑" : "☐";
  const owner = todo.owner === "me" ? "me" : "you";
  const due = todo.due ? ` — due ${todo.due}` : "";
  return `${box} [${owner}] ${todo.text.trim()}${due}`;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function loadOneOnes(now = new Date()) {
  const stored = await localGet([ONEONE_KEY]);
  return normalizeStore(stored[ONEONE_KEY], now);
}

export async function saveOneOnes(store, now = new Date()) {
  const next = normalizeStore(store, now);
  await localSet({ [ONEONE_KEY]: next });
  return next;
}

// The whole mitigation for unbounded retention. Nothing partial: one action,
// one confirm, everything about everybody gone.
export async function clearAllOneOnes() {
  await localSet({ [ONEONE_KEY]: { people: {} } });
  return { people: {} };
}

// How many sessions and how many people the clear would destroy, so the confirm
// can name it instead of asking "are you sure?" about an unknown quantity.
export function storeSize(store) {
  const people = Object.values(store?.people || {});
  return {
    people: people.filter(
      (p) => p.sessions?.length || p.draft?.todos?.length || p.draft?.info?.length
    ).length,
    sessions: people.reduce((n, p) => n + (p.sessions?.length || 0), 0),
  };
}

// ── The mini-Gantt strip ─────────────────────────────────────────────────────
//
// Full-bleed and short: every open issue and epic of theirs that carries a
// start or a due date, laid out over a *fixed* horizon of three weeks back and
// six weeks forward, with today drawn as a line.
//
// Fixed rather than following the window toggle, which is the one decision here
// worth defending. A strip that re-scaled every time the toggle moved would
// need its axis re-read every time; a fixed frame means position is read by
// habit — left of the line is late, right of it is coming — and the same piece
// of work sits in the same place from one week to the next. The window toggle
// governs what *happened*; this governs what is *scheduled*, and those are not
// the same period.

export const GANTT_DAYS_BACK = 21;
export const GANTT_DAYS_FORWARD = 42;

export function ganttWindow(now = new Date()) {
  const from = new Date(now.getTime() - GANTT_DAYS_BACK * DAY_MS);
  const to = new Date(now.getTime() + GANTT_DAYS_FORWARD * DAY_MS);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    fromMs: from.getTime(),
    toMs: to.getTime(),
    todayPct: (GANTT_DAYS_BACK / (GANTT_DAYS_BACK + GANTT_DAYS_FORWARD)) * 100,
  };
}

function dayMs(value) {
  const raw = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

// `[{ key, summary, start, end, leftPct, widthPct, clippedStart, clippedEnd }]`,
// ordered by start date so the strip reads left to right.
//
// An issue with only one of the two dates gets a marker rather than a bar — a
// one-day block at the date it does have — because inventing the missing end
// would draw a duration nobody entered. Anything falling entirely outside the
// horizon is dropped: it is not a bar of zero width at the edge, it is not on
// this chart.
export function ganttBars(issues = [], { now = new Date(), startOf = null } = {}) {
  const win = ganttWindow(now);
  const span = win.toMs - win.fromMs;
  const bars = [];

  for (const issue of issues) {
    if (!issue?.key) continue;
    const startRaw = startOf ? startOf(issue) : issue.fields?.startDate;
    const dueRaw = issue.fields?.duedate;
    const start = dayMs(startRaw);
    const due = dayMs(dueRaw);
    if (start === null && due === null) continue;

    const fromMs = start ?? due;
    // Inclusive of the due day itself: an issue due today is a bar that covers
    // today, not one that stops at midnight this morning.
    const toMs = (due ?? start) + DAY_MS;
    if (toMs <= win.fromMs || fromMs >= win.toMs) continue;

    const clampedFrom = Math.max(fromMs, win.fromMs);
    const clampedTo = Math.min(toMs, win.toMs);
    bars.push({
      key: issue.key,
      summary: String(issue.fields?.summary || ""),
      type: String(issue.fields?.issuetype?.name || ""),
      status: String(issue.fields?.status?.name || ""),
      boardId: issue.boardId ?? null,
      start: start === null ? "" : new Date(start).toISOString().slice(0, 10),
      end: due === null ? "" : new Date(due).toISOString().slice(0, 10),
      // A single date is a point in time, and the strip says so by drawing a
      // marker's worth of width rather than a span.
      point: start === null || due === null,
      leftPct: ((clampedFrom - win.fromMs) / span) * 100,
      widthPct: Math.max(((clampedTo - clampedFrom) / span) * 100, 0.6),
      clippedStart: fromMs < win.fromMs,
      clippedEnd: toMs > win.toMs,
      overdue: due !== null && due + DAY_MS <= now.getTime(),
    });
  }

  bars.sort((a, b) => {
    if (a.leftPct !== b.leftPct) return a.leftPct - b.leftPct;
    return a.key.localeCompare(b.key);
  });
  return { window: win, bars };
}
