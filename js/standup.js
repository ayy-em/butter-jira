// Daily standup session: order, timing, and phase transitions.
//
// Kept free of DOM and audio so the awkward parts — pause arithmetic, overrun,
// resuming an interrupted session — are unit-testable.
//
// Timing is always derived from timestamps, never accumulated from interval
// ticks: a background tab throttles setInterval to once a second or worse, and
// a counter built from ticks would drift behind the wall clock exactly when
// someone tabs away mid-standup.

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

// ── Persistence ──────────────────────────────────────────────────────────────
// Device-local: attendance and durations are about people, and a half-finished
// session is only meaningful on the machine running the standup.

export const SESSION_KEY = "standupSession";
export const PREFS_KEY = "standupPrefs";

function localGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function localSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function localRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

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
