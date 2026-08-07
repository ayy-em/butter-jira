// Sound cues for standup mode.
//
// Files are bundled under assets/sfx/ rather than fetched: the extension CSP and
// host permissions rule out remote media, and a standup that silently loses its
// cues because a CDN is slow would be worse than no cues at all.
//
// Chrome blocks audio that hasn't been unlocked by a user gesture, and the first
// play() of a cold <audio> element also has to wait for the file to load — which
// would swallow exactly the cue you care about. unlock() is called from the
// Start button's click handler to get both out of the way up front.

import { localGet, localSet, runtimeUrl } from "./browser.js";

export const SOUNDS = {
  start: "assets/sfx/dun-dun-dun.mp3",
  countdown: "assets/sfx/countdown.mp3",
};

export const MUTE_KEY = "standupMuted";
const FALLBACK_LEAD_SEC = 3;

const elements = new Map();
let muted = false;
let unlocked = false;

function elementFor(name) {
  if (!elements.has(name)) {
    const path = SOUNDS[name];
    if (!path) return null;
    const audio = new Audio(runtimeUrl(path));
    audio.preload = "auto";
    elements.set(name, audio);
  }
  return elements.get(name);
}

export function preload() {
  for (const name of Object.keys(SOUNDS)) elementFor(name)?.load();
}

// Must be called from inside a user-gesture handler. Playing muted and
// immediately resetting satisfies the autoplay policy and warms the buffer
// without anyone hearing a thing.
export async function unlock() {
  if (unlocked) return true;
  const attempts = Object.keys(SOUNDS).map(async (name) => {
    const audio = elementFor(name);
    if (!audio) return;
    const wasMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Autoplay still blocked — cues will simply be silent, which is survivable.
    } finally {
      audio.muted = wasMuted;
    }
  });
  await Promise.all(attempts);
  unlocked = true;
  return true;
}

export function play(name) {
  if (muted) return;
  const audio = elementFor(name);
  if (!audio) return;
  try {
    audio.currentTime = 0;
    const attempt = audio.play();
    if (attempt?.catch) attempt.catch(() => {});
  } catch {
    /* nothing worth interrupting a standup over */
  }
}

export function stop(name) {
  const audio = elements.get(name);
  if (!audio) return;
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    /* ignore */
  }
}

export function stopAll() {
  for (const name of elements.keys()) stop(name);
}

// How long before zero the countdown cue must start so that it *finishes* as the
// timer hits zero. Falls back when metadata hasn't loaded yet.
export function countdownLeadMs() {
  const audio = elements.get("countdown");
  const duration = audio?.duration;
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : FALLBACK_LEAD_SEC;
  return Math.round(seconds * 1000);
}

export function isMuted() {
  return muted;
}

export async function loadMuted() {
  const stored = await localGet([MUTE_KEY]);
  muted = Boolean(stored[MUTE_KEY]);
  return muted;
}

export async function setMuted(value) {
  muted = Boolean(value);
  if (muted) stopAll();
  await localSet({ [MUTE_KEY]: muted });
  return muted;
}
