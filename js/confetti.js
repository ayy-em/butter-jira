// Confetti for the end of a standup.
//
// Hand-rolled rather than vendored: the extension's CSP forbids remote script,
// and a canvas full of falling rectangles is not worth a dependency. One
// canvas and one rAF loop are shared by every burst, so firing three in a row
// costs one loop rather than three — and the whole thing tears itself down as
// soon as the last piece is spent, leaving nothing behind.
//
// The canvas is pointer-events: none throughout, so the Copy button underneath
// stays clickable while it falls.
//
// Honours prefers-reduced-motion by doing nothing at all. Someone who has asked
// their OS not to animate things has not made an exception for celebrations.

import { BOARD_PALETTE } from "./config.js";

const GRAVITY = 0.14;
const DRAG = 0.995;
const MAX_MS = 8000;   // hard stop, so a backgrounded tab cannot leave it running

// Where a burst comes from and which way it throws, as fractions of the
// viewport. Three visibly different shapes so a sequence does not look like
// the same thing three times.
export const ORIGINS = {
  // Two cannons firing inwards from the lower corners.
  corners: [
    { x: 0, y: 0.9, angle: -60, spread: 45 },
    { x: 1, y: 0.9, angle: -120, spread: 45 },
  ],
  // One fountain straight up the middle.
  centre: [{ x: 0.5, y: 1, angle: -90, spread: 60, power: 21 }],
  // Two low, flat throws from the sides, meeting over the card.
  sides: [
    { x: 0, y: 0.55, angle: -35, spread: 30 },
    { x: 1, y: 0.55, angle: -145, spread: 30 },
  ],
};

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function makePiece(originX, originY, angleDeg, spread, power) {
  const angle = ((angleDeg + (Math.random() - 0.5) * spread) * Math.PI) / 180;
  const velocity = power * (0.6 + Math.random() * 0.7);
  return {
    x: originX,
    y: originY,
    vx: Math.cos(angle) * velocity,
    vy: Math.sin(angle) * velocity,
    // Rectangles rather than dots: a tumbling rectangle reads as paper, and the
    // width oscillation in the draw below is what sells the tumble.
    w: 6 + Math.random() * 5,
    h: 9 + Math.random() * 6,
    spin: (Math.random() - 0.5) * 0.35,
    tilt: Math.random() * Math.PI,
    wobble: 0.05 + Math.random() * 0.08,
    color: BOARD_PALETTE[Math.floor(Math.random() * BOARD_PALETTE.length)],
    life: 1,
    decay: 0.004 + Math.random() * 0.004,
  };
}

// Live state. One canvas, one loop, one growing pool of pieces.
let canvas = null;
let ctx = null;
let pieces = [];
let frame = 0;
let startedAt = 0;
let timers = [];

function ensureCanvas() {
  if (canvas) return true;
  canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas = null;
    return false;
  }
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);
  return true;
}

function teardown() {
  if (frame) cancelAnimationFrame(frame);
  for (const id of timers) clearTimeout(id);
  timers = [];
  frame = 0;
  pieces = [];
  canvas?.remove();
  canvas = null;
  ctx = null;
}

function tick(now) {
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (!pieces.length || now - startedAt > MAX_MS) {
    // Only pack up once nothing else is queued — a sequence has gaps between
    // its bursts where the screen is briefly empty.
    if (!timers.length) {
      teardown();
      return;
    }
  }

  ctx.clearRect(0, 0, width, height);
  for (const p of pieces) {
    p.vx *= DRAG;
    p.vy = p.vy * DRAG + GRAVITY;
    p.x += p.vx;
    p.y += p.vy;
    p.tilt += p.spin;
    p.life -= p.decay;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt);
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    // Squashing the width by the tilt fakes a third axis for free.
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.tilt * p.wobble * 10)), p.h);
    ctx.restore();
  }

  // Dropped once spent or below the fold, so an idle canvas never repaints
  // nothing.
  pieces = pieces.filter((p) => p.life > 0 && p.y < height + 40);
  frame = requestAnimationFrame(tick);
}

/**
 * Adds a burst to whatever is already in the air. `origin` is a key of ORIGINS
 * or an array of nozzle descriptors. Concurrent bursts share the canvas and the
 * loop, so calling this three times does not stack three overlays.
 */
export function burst({ origin = "corners", count = 150 } = {}) {
  if (prefersReducedMotion() || typeof document === "undefined") return;
  if (!ensureCanvas()) return;

  const nozzles = Array.isArray(origin) ? origin : ORIGINS[origin] || ORIGINS.corners;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const perNozzle = Math.max(1, Math.round(count / nozzles.length));

  for (const nozzle of nozzles) {
    for (let i = 0; i < perNozzle; i++) {
      pieces.push(
        makePiece(
          nozzle.x * width,
          nozzle.y * height,
          nozzle.angle,
          nozzle.spread ?? 45,
          nozzle.power ?? 17
        )
      );
    }
  }

  if (!frame) {
    startedAt = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

/**
 * Three bursts from three different positions, half a second apart. The
 * timeouts are tracked so stop() can cancel a sequence mid-flight — otherwise
 * leaving the view would fire the remaining bursts onto a torn-down screen.
 */
export function celebrate({ gapMs = 500 } = {}) {
  if (prefersReducedMotion()) return;
  const sequence = ["corners", "centre", "sides"];
  sequence.forEach((origin, i) => {
    if (i === 0) {
      burst({ origin });
      return;
    }
    const id = setTimeout(() => {
      // Drops itself from the list first, so the loop knows nothing more is
      // queued once the last burst has gone off.
      timers = timers.filter((t) => t !== id);
      burst({ origin });
    }, i * gapMs);
    timers.push(id);
  });
}

export function stop() {
  teardown();
}
