// The header a view puts at the top of itself: an icon tile, a title, a line
// saying what you are looking at, and a slot on the right for whatever that
// view counts.
//
// Written when Kanban and Monitor were being brought up to the rest of the app.
// Backlog, the dashboard and the standup setup all had one; those two started
// straight in on controls, which is most of what made them read as the previous
// generation — the newer screens say what they are, and the older ones assumed
// you knew because you had clicked the tab.
//
// One implementation rather than a fourth copy: the Backlog's .bl-header class
// names are aliases on the same rules in css/app.css, so its markup did not have
// to change to stop being a second definition of this.

import { icon } from "./icons.js";

export function viewHeader({ iconName, title, subtitle, right = null }) {
  const header = document.createElement("header");
  header.className = "view-header";

  const left = document.createElement("div");
  left.className = "view-header-left";

  const mark = document.createElement("span");
  mark.className = "view-header-icon";
  mark.appendChild(icon(iconName, 22));
  left.appendChild(mark);

  const titles = document.createElement("div");
  titles.className = "view-header-titles";
  const h1 = document.createElement("h1");
  h1.className = "view-title";
  h1.textContent = title;
  titles.appendChild(h1);
  if (subtitle) {
    const p = document.createElement("p");
    p.className = "view-subtitle";
    p.textContent = subtitle;
    titles.appendChild(p);
  }
  left.appendChild(titles);
  header.appendChild(left);

  if (right) header.appendChild(right);
  return header;
}

// The strip of counts on the right of a header. `tiles` is
// [{ num, label, tone }] — tone names a --tone-* colour for the dot, or
// "total" for the headline figure, which loses its dot and gains an underline
// because a colour there would make it look like just another status.
export function viewTiles(tiles) {
  const strip = document.createElement("div");
  strip.className = "view-tiles";
  for (const tile of tiles) {
    const el = document.createElement("div");
    el.className = `view-tile tone-${tile.tone || "gray"}`;
    const dot = document.createElement("span");
    dot.className = "view-tile-dot";
    el.appendChild(dot);
    const num = document.createElement("span");
    num.className = "view-tile-num";
    num.textContent = String(tile.num);
    el.appendChild(num);
    const label = document.createElement("span");
    label.className = "view-tile-label";
    label.textContent = tile.label;
    el.appendChild(label);
    strip.appendChild(el);
  }
  return strip;
}
