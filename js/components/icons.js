// The app's icons, drawn here.
//
// There were four vocabularies before this file: authored SVG paths in the
// Backlog (the good one), emoji on board cards, loose Unicode glyphs everywhere
// else — two different close crosses and four different carets — and PNG logos
// in the nav. Three of those are gone; the logos stay, because a logo is a
// picture rather than an icon.
//
// Inline SVG rather than an icon package, per PRODUCT.md: no build step, no
// runtime dependency. A path or two each, nothing to ship, and they inherit
// currentColor so one drawing works in both themes.
//
// Emoji were the specific problem. On a card the priority dot was 🔴🟠🟡🔵 with
// no title and no text — the only element on a card with no accessible name at
// all, and the only encoding of priority anywhere on the board. It also carried
// its whole meaning in hue, so anyone who cannot separate red from orange got
// nothing from it. The replacements below say the same thing by *shape*, and
// carry a name.

const NS = "http://www.w3.org/2000/svg";

// Kept as bare path data so an icon is one line and the set can be read at a
// glance. All on a 24×24 grid, stroked rather than filled.
export const ICON_PATHS = {
  // ── Chrome ────────────────────────────────────────────────────────────────
  backlog: "M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm1.5-4h15L21 7H3l1.5-4ZM9 12h6",
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35",
  // One caret. Everything that used to point right, up or left is this one
  // rotated in CSS — see .icon-rot-* below — so there is a single arrowhead in
  // the app rather than ▾ ▸ ▶ ▼ ▲ picked per file from whatever was to hand.
  chevron: "m6 9 6 6 6-6",
  columns: "M4 4h16v16H4zM10 4v16M16 4v16",
  check: "m5 13 4 4L19 7",
  inbox: "M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6l2-8Z",
  // One cross. Two were in use — ✕ (U+2715) in the drawer and the issue detail,
  // × (U+00D7, the multiplication sign) in the Kanban editor, the roster and
  // settings — which are different widths and different weights.
  close: "M6 6l12 12M18 6 6 18",
  calendar: "M4 6.5h16v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-13ZM4 10.5h16M8 3v4M16 3v4",
  // One person, because the 1:1 screen is about exactly one. Drawn as a head
  // and shoulders rather than two figures: a pair of silhouettes is the mark
  // for a team, and this screen is deliberately not that.
  person: "M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM4.5 20.5a7.5 7.5 0 0 1 15 0",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",

  // ── Priority, by shape ────────────────────────────────────────────────────
  // Jira's own convention, which is the one people arriving here already know:
  // arrows up for the urgent end, a bar for the middle, arrows down for the
  // quiet end. Two chevrons for the extremes, so highest and high differ in
  // silhouette and not only in colour.
  priorityHighest: "m5 13 7-7 7 7M5 19l7-7 7 7",
  priorityHigh: "m5 16 7-7 7 7",
  priorityMedium: "M5 12h14",
  priorityLow: "m5 8 7 7 7-7",
  priorityLowest: "m5 5 7 7 7-7M5 11l7 7 7-7",
};

// The type marks are drawn heavier: they render at 13px inside a pill, where a
// 1.8 stroke goes muddy.
Object.assign(ICON_PATHS, {
  epic: "M13.5 2 5 13.5h5.5L10 22l8.5-11.5H13L13.5 2Z",
  story: "M6.5 3h11v18l-5.5-4.2L6.5 21V3Z",
  task: "M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Zm3 8.7 2.6 2.6 5.4-6",
  bug: "M12 20.5a5.5 5.5 0 0 0 5.5-5.5v-3a5.5 5.5 0 0 0-11 0v3a5.5 5.5 0 0 0 5.5 5.5ZM3.5 13H6m12 0h2.5M4.5 7.5 7 9m12.5-1.5L17 9M4.5 19 7 17.5m12.5 1.5L17 17.5M9 5.5 7.5 3M15 5.5 16.5 3",
  subtask: "M3.5 3.5h9v9h-9zM11.5 11.5h9v9h-9z",
  generic: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z",
});

const HEAVY = new Set(["epic", "story", "task", "bug", "subtask", "generic"]);

// `label` is the whole point of this signature. An icon carrying meaning no
// text repeats — priority, overdue — must be announced; an icon sitting beside
// its own label must not be, or the label is read twice. So the default is
// aria-hidden and a name has to be asked for, which is the way round that makes
// the decorative case the quiet one.
export function icon(name, size = 16, { label = "", strokeWidth = null } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", strokeWidth ?? (HEAVY.has(name) ? "2.2" : "1.8"));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("icon");
  if (label) {
    svg.setAttribute("role", "img");
    const title = document.createElementNS(NS, "title");
    title.textContent = label;
    svg.appendChild(title);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICON_PATHS[name] || "");
  svg.appendChild(path);
  return svg;
}

// The same drawing, for use *inside* an existing SVG rather than as one — the
// roadmap's expand caret lives among frappe-gantt's own elements, where an
// <svg> child is not what the chart's layout expects. Positioned by its centre,
// because that is what the caller has: the middle of a bar.
export function svgIconPath(name, { x, y, size = 12, rotate = 0 } = {}) {
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICON_PATHS[name] || "");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", String(24 / size * 1.8));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  // Scale last so the stroke width above is in the icon's own 24-unit grid.
  path.setAttribute(
    "transform",
    `translate(${x} ${y}) scale(${size / 24}) rotate(${rotate} 12 12) translate(-12 -12)`
  );
  return path;
}

// Jira ships five priorities and sites rename them; anything unrecognised gets
// the middle of the scale rather than nothing, because a card with no priority
// mark reads as "not set" and that is a different fact.
const PRIORITY_ICONS = {
  blocker: "priorityHighest",
  critical: "priorityHighest",
  highest: "priorityHighest",
  high: "priorityHigh",
  major: "priorityHigh",
  medium: "priorityMedium",
  normal: "priorityMedium",
  minor: "priorityLow",
  low: "priorityLow",
  lowest: "priorityLowest",
  trivial: "priorityLowest",
};

// The tone each level is drawn in. Same four colours the emoji carried, now as
// tokens and no longer the only thing separating one level from another.
const PRIORITY_TONES = {
  priorityHighest: "var(--accent-danger)",
  priorityHigh: "var(--accent-warning)",
  priorityMedium: "var(--accent-yellow)",
  priorityLow: "var(--accent-primary)",
  priorityLowest: "var(--accent-primary)",
};

// Returns null for an issue with no priority set — which is a fact worth
// showing as nothing rather than as a middling mark.
export function priorityIcon(priorityName, size = 13) {
  const raw = String(priorityName || "").trim();
  if (!raw) return null;
  const key = PRIORITY_ICONS[raw.toLowerCase()] || "priorityMedium";
  const svg = icon(key, size, { label: `Priority: ${raw}`, strokeWidth: "2.4" });
  svg.style.color = PRIORITY_TONES[key];
  svg.classList.add("icon-priority");
  return svg;
}
