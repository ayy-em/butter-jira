// Daily standup session: order, timing, and phase transitions.
//
// Kept free of DOM and audio so the awkward parts — pause arithmetic, overrun,
// resuming an interrupted session — are unit-testable.
//
// Timing is always derived from timestamps, never accumulated from interval
// ticks: a background tab throttles setInterval to once a second or worse, and
// a counter built from ticks would drift behind the wall clock exactly when
// someone tabs away mid-standup.

import { localGet, localRemove, localSet } from "./browser.js";

export const PHASES = {
  SETUP: "setup",
  COUNTDOWN: "countdown",
  SPEAKING: "speaking",
  HANDOFF: "handoff",
  DONE: "done",
};

export const DEFAULT_DURATION_SEC = 120;
export const LEAD_IN_SEC = 5;   // "5 seconds countdown" before the first person
export const HANDOFF_SEC = 3;   // "get ready" card between people
export const MIN_DURATION_SEC = 15;
export const MAX_DURATION_SEC = 3600;

// Deterministic PRNG (mulberry32) so a given seed always produces the same
// order — that is what lets an interrupted session resume identically.
export function makeRandom(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWithSeed(items, seed) {
  const random = makeRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// What the hand-off card says above the next person's name. Some are complete
// sentences, some are lead-ins that the name underneath finishes ("Time for…"
// / "Alex Rivera") — both read correctly because the name is always the line
// below.
export const HANDOFF_PHRASES = [
  "Get ready!",
  "Time for…",
  "Your time has come!",
  "Next up",
  "You're on",
  "The stage is yours",
  "Over to you",
  "Take it away",
  "All eyes on",
  "Warm up the mic",
  "Deep breath…",
];

// Deterministic, not random-per-render. renderRunning() fires again on pause,
// on resume, and when the GitHub fetch lands — a phrase that changed under
// someone mid-hand-off would read as a glitch rather than as variety. Derived
// from the session seed and position, so it also survives a resume unchanged.
export function handoffPhrase(session, phrases = HANDOFF_PHRASES) {
  if (!phrases.length) return "";
  if (phrases.length === 1) return phrases[0];

  const seed = Number(session?.seed) || 0;
  // Capped so a corrupt index cannot spin here; no standup has 500 hand-offs.
  const index = Math.min(500, Math.max(0, Math.floor(session?.index ?? 0)));

  // Resolved forward from the first hand-off rather than computed for this one
  // alone. The no-repeat rule has to compare against what the previous position
  // actually *showed*, and that may itself have been bumped — comparing raw
  // draws lets a bumped value collide with the next raw one.
  let previous = -1;
  let chosen = 0;
  for (let position = 0; position <= index; position++) {
    chosen = Math.floor(makeRandom(seed + position * 7919)() * phrases.length);
    if (chosen === previous) chosen = (chosen + 1) % phrases.length;
    previous = chosen;
  }
  return phrases[chosen];
}

export function clampDuration(seconds) {
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n)) return DEFAULT_DURATION_SEC;
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, n));
}

// `participants` are roster members; only their accountId is carried in the
// session, so a rename between sessions doesn't matter.
export function createSession({ participants, durations = {}, seed, now = 0 }) {
  const ids = participants.map((p) => p.accountId).filter(Boolean);
  const resolvedSeed = Number.isFinite(seed) ? seed : 1;
  const order = shuffleWithSeed(ids, resolvedSeed);

  const resolvedDurations = {};
  for (const id of order) {
    resolvedDurations[id] = clampDuration(durations[id] ?? DEFAULT_DURATION_SEC);
  }

  return {
    seed: resolvedSeed,
    order,
    durations: resolvedDurations,
    index: 0,
    phase: order.length ? PHASES.COUNTDOWN : PHASES.DONE,
    phaseStartedAt: now,
    pausedAt: null,
    pauseAccumMs: 0,
    // Parking-lot notes are per speaker, keyed by accountId: the box belongs to
    // whoever is on screen, so it empties as the standup moves on and the end
    // screen can attribute every note to a person.
    notesByPerson: {},
    startedAt: now,
    // Actual speaking time per person, filled in as the session progresses.
    actualMs: {},
  };
}

export function currentId(session) {
  return session.order[session.index] ?? null;
}

export function nextId(session) {
  return session.order[session.index + 1] ?? null;
}

export function isPaused(session) {
  return session.pausedAt !== null;
}

export function isRunning(session) {
  return session.phase !== PHASES.DONE && session.phase !== PHASES.SETUP;
}

// Time spent in the current phase, excluding any paused stretches.
export function phaseElapsedMs(session, now) {
  const frozenAt = session.pausedAt ?? now;
  return Math.max(0, frozenAt - session.phaseStartedAt - session.pauseAccumMs);
}

export function phaseTotalMs(session) {
  switch (session.phase) {
    case PHASES.COUNTDOWN:
      return LEAD_IN_SEC * 1000;
    case PHASES.HANDOFF:
      return HANDOFF_SEC * 1000;
    case PHASES.SPEAKING: {
      const id = currentId(session);
      return (session.durations[id] ?? DEFAULT_DURATION_SEC) * 1000;
    }
    default:
      return 0;
  }
}

// Negative once someone runs over — the view counts up in red rather than
// cutting them off mid-sentence.
export function phaseRemainingMs(session, now) {
  return phaseTotalMs(session) - phaseElapsedMs(session, now);
}

export function isOverrun(session, now) {
  return session.phase === PHASES.SPEAKING && phaseRemainingMs(session, now) < 0;
}

// How much the clock swells while someone runs over: one step every five
// seconds of overrun, so the timer grows on its own until the room notices.
// Red alone stops being information once every second person ends up in it;
// size keeps climbing, so a ten-second overrun and a two-minute one no longer
// look the same from the back of the room.
//
// Capped because the clock shares a flex row with the facilitator's controls —
// past roughly double it wraps them onto a second line and the "Next" button
// starts moving around mid-standup, which is worse than a smaller number.
export const OVERRUN_STEP_SEC = 5;
export const OVERRUN_STEP_GROWTH = 0.12;
export const OVERRUN_MAX_SCALE = 2;

// Derived from the timestamps like everything else here, never accumulated:
// the multiplier is a function of how long this phase has been over, so it
// falls back to 1 by itself on the next person, on a rewind, and on the +1 min
// button — none of which need to know it exists.
export function overrunScale(session, now) {
  if (!isOverrun(session, now)) return 1;
  const overMs = -phaseRemainingMs(session, now);
  const steps = Math.floor(overMs / (OVERRUN_STEP_SEC * 1000));
  return Math.min(OVERRUN_MAX_SCALE, 1 + steps * OVERRUN_STEP_GROWTH);
}

// ── Pressure ─────────────────────────────────────────────────────────────────
//
// The swelling clock above only starts working once someone is *already* over,
// which is the moment it is least useful: the room has to interrupt rather than
// the speaker having felt it coming. These two numbers are the same idea moved
// earlier and spread wider — one continuous 0→1 ramp for the run-up to time-up,
// and a second for the overrun past it. Both are derived from the timestamps
// like everything else in this file, so they reset by themselves on the next
// person, on a rewind and on +1 min, and the view can render them however it
// likes without owning any state.

// Nothing happens for the first ~62% of a turn. A bar that starts reddening
// immediately is just a bar; one that stays quiet and then visibly closes in is
// a warning. 0.62 leaves roughly the last third of the slot as the ramp.
export const PRESSURE_FROM = 0.62;
// How long the overrun ramp takes to reach its maximum. Longer than the swell's
// five-second steps deliberately: this is the ambient channel, and it should
// arrive at "everyone has noticed" rather than start there.
export const OVERRUN_RAMP_SEC = 45;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

// 0 with time in hand, 1 exactly at time-up, and 1 from then on. Squared so the
// ramp starts gently and tightens — a linear approach reads as a steady state
// rather than as something closing.
export function pressure(session, now) {
  if (!session || session.phase !== PHASES.SPEAKING) return 0;
  const total = phaseTotalMs(session);
  if (!total) return 0;
  const used = clamp01(phaseElapsedMs(session, now) / total);
  if (used <= PRESSURE_FROM) return 0;
  const t = (used - PRESSURE_FROM) / (1 - PRESSURE_FROM);
  return clamp01(t) ** 2;
}

// 0 until the slot runs out, then 0→1 across OVERRUN_RAMP_SEC. Linear, because
// past time-up the question is no longer "how close" but "how long", and that
// is a quantity people read off directly.
export function overpressure(session, now) {
  if (!isOverrun(session, now)) return 0;
  return clamp01(-phaseRemainingMs(session, now) / (OVERRUN_RAMP_SEC * 1000));
}

// True when a timed phase has run out. Speaking never expires on its own: the
// facilitator decides when to move on.
export function shouldAutoAdvance(session, now) {
  if (session.phase === PHASES.COUNTDOWN || session.phase === PHASES.HANDOFF) {
    return phaseRemainingMs(session, now) <= 0;
  }
  return false;
}

function enterPhase(session, phase, now) {
  return {
    ...session,
    phase,
    phaseStartedAt: now,
    pausedAt: null,
    pauseAccumMs: 0,
  };
}

// countdown -> speaking -> handoff -> speaking -> ... -> done
export function advance(session, now) {
  if (session.phase === PHASES.COUNTDOWN) {
    return enterPhase(session, PHASES.SPEAKING, now);
  }

  if (session.phase === PHASES.SPEAKING) {
    const id = currentId(session);
    const spoken = phaseElapsedMs(session, now);
    const withActual = {
      ...session,
      actualMs: { ...session.actualMs, [id]: (session.actualMs[id] || 0) + spoken },
    };
    if (nextId(session) === null) {
      return { ...enterPhase(withActual, PHASES.DONE, now), finishedAt: now };
    }
    return enterPhase(withActual, PHASES.HANDOFF, now);
  }

  if (session.phase === PHASES.HANDOFF) {
    return enterPhase({ ...session, index: session.index + 1 }, PHASES.SPEAKING, now);
  }

  return session;
}

export function pause(session, now) {
  if (!isRunning(session) || isPaused(session)) return session;
  return { ...session, pausedAt: now };
}

export function resume(session, now) {
  if (!isPaused(session)) return session;
  return {
    ...session,
    pauseAccumMs: session.pauseAccumMs + (now - session.pausedAt),
    pausedAt: null,
  };
}

export function togglePause(session, now) {
  return isPaused(session) ? resume(session, now) : pause(session, now);
}

// Adds time to whoever is speaking without disturbing the elapsed clock.
export function addTime(session, seconds) {
  if (session.phase !== PHASES.SPEAKING) return session;
  const id = currentId(session);
  const next = clampDuration((session.durations[id] ?? DEFAULT_DURATION_SEC) + seconds);
  return { ...session, durations: { ...session.durations, [id]: next } };
}

export function finish(session, now) {
  if (session.phase === PHASES.DONE) return session;
  const id = currentId(session);
  const base =
    session.phase === PHASES.SPEAKING
      ? { ...session, actualMs: { ...session.actualMs, [id]: (session.actualMs[id] || 0) + phaseElapsedMs(session, now) } }
      : session;
  return { ...enterPhase(base, PHASES.DONE, now), finishedAt: now };
}

export function plannedTotalSec(order, durations) {
  return order.reduce(
    (sum, id) => sum + clampDuration(durations[id] ?? DEFAULT_DURATION_SEC),
    0
  );
}

// Wall-clock estimate the facilitator actually cares about: speaking time plus
// the lead-in and the hand-offs between people.
export function estimatedWallSec(order, durations) {
  if (!order.length) return 0;
  return plannedTotalSec(order, durations) + LEAD_IN_SEC + HANDOFF_SEC * (order.length - 1);
}

export function formatClock(ms) {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${sign}${mins}:${String(secs).padStart(2, "0")}`;
}

// Sprint names come out of Jira carrying whatever the board owner typed after
// the identifier — "DP-82: Payments hardening", "DP-82 (carry-over)". On the
// setup card they are a one-line "which sprints are we in" note, several of
// them joined by dots, so everything past the identifier is noise that pushes
// the line to wrap.
//
// The identifier is taken as everything up to and including the first run of
// digits: "DP-82: Blah" → "DP-82", "Sprint 12 — week 3" → "Sprint 12". A name
// with no digits at all has no identifier to find and is left alone rather
// than being emptied.
export function trimSprintLabel(name) {
  const match = /\d+/.exec(name || "");
  return match ? name.slice(0, match.index + match[0].length) : name;
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Device-local: attendance and durations are about people, and a half-finished
// session is only meaningful on the machine running the standup.

export const SESSION_KEY = "standupSession";
export const PREFS_KEY = "standupPrefs";

export async function saveSession(session) {
  await localSet({ [SESSION_KEY]: session });
}

export async function loadSession() {
  const stored = await localGet([SESSION_KEY]);
  const session = stored[SESSION_KEY];
  if (!session || !Array.isArray(session.order) || !session.order.length) return null;
  if (session.phase === PHASES.DONE) return null;
  return migrateSessionNotes(session);
}

// Parking-lot notes used to be one string for the whole standup. An interrupted
// session saved under that shape is attributed to whoever was on screen when it
// was interrupted — the only speaker it could plausibly belong to.
export function migrateSessionNotes(session) {
  if (session.notesByPerson && typeof session.notesByPerson === "object") return session;
  const legacy = typeof session.notes === "string" ? session.notes.trim() : "";
  const owner = session.order[session.index];
  return {
    ...session,
    notesByPerson: legacy && owner ? { [owner]: legacy } : {},
  };
}

// Notes in speaking order, skipping people nobody wrote anything for.
export function notesEntries(session) {
  const byPerson = session?.notesByPerson || {};
  return (session?.order || [])
    .map((id) => ({ id, note: String(byPerson[id] ?? "").trim() }))
    .filter((entry) => entry.note);
}

export async function clearSession() {
  await localRemove([SESSION_KEY]);
}

// ── Slack digest ─────────────────────────────────────────────────────────────
//
// One message in two representations: plain text, which is what the facilitator
// reads and edits in the box, and HTML, which is what Slack actually reads off
// the clipboard and turns into real bullets and bold. The HTML is derived from
// the text rather than built beside it, so edits made in the box survive the
// copy and the two can never drift apart.

export const DIGEST_HEADING = "Daily Standup Action Points";
export const DIGEST_EMOJI = "📌";
export const DIGEST_SIGNOFF = "Cheers 😎";

// Two spaces is enough to mark a sub-bullet for the parser; four reads better
// in the textarea.
const SUB_INDENT = "    ";
// Bullet glyphs people type into the notes box themselves. Stripped on the way
// in so they don't end up doubled under the bullet we add, and recognised on
// the way out so a hand-typed list still becomes a real list.
const BULLET_LINE = /^(\s*)[-*•◦–—]\s+(.*)$/;

// One bullet per person: a single-line note sits on the same line as the
// mention, a multi-line one becomes sub-bullets under it.
export function digestText({ title = "", entries = [], signoff = "" } = {}) {
  const blocks = entries.map(({ who, note }) => {
    const lines = noteLines(note);
    if (lines.length <= 1) return `- ${[who, lines[0]].filter(Boolean).join(" - ")}`;
    return [`- ${who}`, ...lines.map((line) => `${SUB_INDENT}- ${line}`)].join("\n");
  });
  const parts = [];
  if (title) parts.push(title, "");
  parts.push(...blocks);
  if (signoff) parts.push("", signoff);
  return parts.join("\n");
}

function noteLines(note) {
  return String(note ?? "")
    .split("\n")
    .map((line) => line.trim().replace(BULLET_LINE, "$2").trim())
    .filter(Boolean);
}

// Markdown-lite -> the small HTML subset Slack's composer honours on paste:
// bold first line, one <ul> of mentions, a nested <ul> per person's notes.
export function digestHtml(text) {
  const out = [];
  let list = null;
  let seenBlock = false;
  const flush = () => {
    if (list) out.push(renderList(list));
    list = null;
  };

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const bullet = line.match(BULLET_LINE);
    if (bullet) {
      const [, indent, body] = bullet;
      if (!list) list = [];
      // Anything indented under an existing bullet is that bullet's child.
      if (indent.length >= 2 && list.length) list[list.length - 1].children.push(body);
      else list.push({ text: body, children: [] });
      seenBlock = true;
      continue;
    }
    if (!line.trim()) continue;
    flush();
    // The first line carries the date, so it is the one that gets emphasis.
    const inner = inlineHtml(line.trim());
    out.push(`<p>${seenBlock ? inner : `<b>${inner}</b>`}</p>`);
    seenBlock = true;
  }
  flush();
  return out.join("\n");
}

function renderList(items) {
  const li = items.map(({ text, children }) => {
    const nested = children.length
      ? `<ul>${children.map((c) => `<li>${inlineHtml(c)}</li>`).join("")}</ul>`
      : "";
    return `<li>${inlineHtml(text)}${nested}</li>`;
  });
  return `<ul>${li.join("")}</ul>`;
}

// Trailing punctuation is excluded from the match so "see http://x/y." doesn't
// swallow the full stop into the link.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g;

function inlineHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(URL_RE, (url) => `<a href="${url}">${url}</a>`);
}

// Yesterday's attendance and per-person durations, so the picker isn't blank
// every morning.
export async function loadPrefs() {
  const stored = await localGet([PREFS_KEY]);
  const prefs = stored[PREFS_KEY] || {};
  return {
    attendance: Array.isArray(prefs.attendance) ? prefs.attendance : [],
    durations: prefs.durations && typeof prefs.durations === "object" ? prefs.durations : {},
  };
}

export async function savePrefs({ attendance, durations }) {
  await localSet({ [PREFS_KEY]: { attendance, durations } });
}
