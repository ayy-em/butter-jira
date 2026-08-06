// Inline SVG chart primitives. No libraries — the extension CSP forbids remote
// script, and these three forms don't justify vendoring a charting library.
//
// Mark specs are fixed, not per-chart taste:
//   bars      ≤24px thick, 4px rounded data-end, square at the baseline
//   lines     2px, round join/cap
//   markers   ≥8px diameter, with a 2px surface-coloured ring so they stay
//             legible where they cross a line
//   grid/axes hairline, solid, recessive — one step off the surface
//   stacks    a 2px surface-coloured gap separates touching segments; never a
//             stroke around a mark
//
// Colours come in as CSS custom properties resolved by the caller, so light and
// dark are each *selected* rather than one being an automatic flip of the other.

const SVG_NS = "http://www.w3.org/2000/svg";
const BAR_MAX_THICKNESS = 24;
const SEGMENT_GAP = 2;
const RADIUS = 4;

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
}

function svgRoot(width, height, extraClass = "") {
  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    class: `chart ${extraClass}`.trim(),
  });
  return svg;
}

function title(node, text) {
  const t = el("title");
  t.textContent = text;
  node.appendChild(t);
  return node;
}

// A rect rounded on the data end only, square at the baseline. Horizontal bars
// grow to the right, so the right edge is the rounded one.
function barPath(x, y, w, h, radius, side = "right") {
  const r = Math.max(0, Math.min(radius, h / 2, w));
  if (r === 0 || w <= 0) return `M${x},${y}h${Math.max(0, w)}v${h}h${-Math.max(0, w)}Z`;
  if (side === "right") {
    return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}Z`;
  }
  // Vertical column: rounded on top.
  return `M${x},${y + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}h${-w}Z`;
}

// ── Horizontal bar chart ─────────────────────────────────────────────────────
// One nominal category per row, magnitude in a single hue. Identity lives in the
// row label (plus an optional colour dot the caller supplies), never in the bar
// colour — colouring nominal bars by value spends the identity channel on
// something bar length already shows.

export function horizontalBars(rows, options = {}) {
  const {
    width = 520,
    rowHeight = 28,
    labelWidth = 130,
    valueWidth = 58,
    fill = "var(--chart-series-1)",
    trackFill = "var(--chart-track)",
    format = (v) => String(v),
    emptyLabel = "No data",
  } = options;

  if (!rows.length) return emptyState(emptyLabel);

  const height = rows.length * rowHeight + 8;
  const svg = svgRoot(width, height, "chart-bars");
  const plotX = labelWidth + 10;
  const plotWidth = Math.max(40, width - plotX - valueWidth);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const barThickness = Math.min(BAR_MAX_THICKNESS, rowHeight - 10);

  rows.forEach((row, i) => {
    const y = i * rowHeight + 4;
    const barY = y + (rowHeight - barThickness) / 2 - 2;

    const label = el("text", {
      x: labelWidth,
      y: barY + barThickness / 2 + 4,
      "text-anchor": "end",
      class: "chart-label",
    });
    label.textContent = row.label;
    svg.appendChild(title(label, row.label));

    // Recessive track, so a short bar still reads as "out of this much".
    svg.appendChild(
      el("path", {
        d: barPath(plotX, barY, plotWidth, barThickness, RADIUS),
        fill: trackFill,
      })
    );

    const barWidth = Math.max(row.value > 0 ? 3 : 0, (row.value / max) * plotWidth);
    if (barWidth > 0) {
      const bar = el("path", {
        d: barPath(plotX, barY, barWidth, barThickness, RADIUS),
        fill: row.fill || fill,
      });
      svg.appendChild(title(bar, `${row.label}: ${format(row.value)}${row.hint ? ` · ${row.hint}` : ""}`));
    }

    // Value at the tip, in text ink rather than the mark colour.
    const value = el("text", {
      x: plotX + plotWidth + 8,
      y: barY + barThickness / 2 + 4,
      class: "chart-value",
    });
    value.textContent = format(row.value);
    svg.appendChild(value);
  });

  return svg;
}

// ── Single stacked bar (part-to-whole) ───────────────────────────────────────
// Used for sprint progression, which is ORDINAL — To Do → Done is a sequence, so
// the segments take one hue in monotone lightness steps and the reader sees the
// order in the colour. A 2px surface gap separates segments; no strokes.

export function stackedBar(segments, options = {}) {
  const {
    width = 520,
    height = 30,
    format = (v) => String(v),
    emptyLabel = "Nothing to show",
    labelMinWidth = 44,
  } = options;

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) return emptyState(emptyLabel);

  const svg = svgRoot(width, height, "chart-stack");
  const gaps = SEGMENT_GAP * Math.max(0, segments.filter((s) => s.value > 0).length - 1);
  const usable = Math.max(10, width - gaps);

  let x = 0;
  const visible = segments.filter((s) => s.value > 0);
  visible.forEach((segment, i) => {
    const w = (segment.value / total) * usable;
    const first = i === 0;
    const last = i === visible.length - 1;
    // Round only the outer ends, so the bar reads as one object.
    const d = first && last
      ? barPath(x, 0, w, height, RADIUS)
      : first
        ? `M${x + RADIUS},0h${w - RADIUS}v${height}h${-(w - RADIUS)}a${RADIUS},${RADIUS} 0 0 1 ${-RADIUS},${-RADIUS}v${-(height - 2 * RADIUS)}a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},${-RADIUS}Z`
        : last
          ? barPath(x, 0, w, height, RADIUS)
          : `M${x},0h${w}v${height}h${-w}Z`;

    const rect = el("path", { d, fill: segment.fill });
    const pct = Math.round((segment.value / total) * 100);
    svg.appendChild(title(rect, `${segment.label}: ${format(segment.value)} (${pct}%)`));

    // Only label inside the segment when the text genuinely fits — a clipped
    // label is worse than none, and the legend plus tooltip carry the rest.
    if (w >= labelMinWidth) {
      const text = el("text", {
        x: x + w / 2,
        y: height / 2 + 4,
        "text-anchor": "middle",
        class: "chart-inline-label",
        fill: segment.labelInk || "#fff",
      });
      text.textContent = format(segment.value);
      svg.appendChild(text);
    }

    x += w + SEGMENT_GAP;
  });

  return svg;
}

// ── Burndown line ───────────────────────────────────────────────────────────
// Two series: actual (accent) and the ideal reference (muted). A legend is the
// caller's job — for two series it is mandatory.

export function burndownChart(series, options = {}) {
  const {
    width = 640,
    height = 220,
    padding = { top: 14, right: 20, bottom: 26, left: 40 },
    actualFill = "var(--chart-series-1)",
    idealStroke = "var(--chart-muted-line)",
    format = (v) => String(Math.round(v)),
    onHover = null,
  } = options;

  const { days, ideal, actual } = series;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxY = Math.max(...ideal.map((p) => p.points), ...actual.map((p) => p.points), 1);

  const xFor = (date) => {
    const i = days.indexOf(date);
    const span = Math.max(1, days.length - 1);
    return padding.left + (i / span) * plotWidth;
  };
  const yFor = (points) => padding.top + plotHeight - (points / maxY) * plotHeight;

  const svg = svgRoot(width, height, "chart-burndown");

  // Grid: hairline, solid, recessive. Three lines is enough to read against.
  for (const frac of [0, 0.5, 1]) {
    const y = padding.top + plotHeight * frac;
    svg.appendChild(
      el("line", {
        x1: padding.left, y1: y, x2: padding.left + plotWidth, y2: y,
        class: "chart-grid",
      })
    );
    const tick = el("text", {
      x: padding.left - 8, y: y + 4, "text-anchor": "end", class: "chart-tick",
    });
    tick.textContent = format(maxY * (1 - frac));
    svg.appendChild(tick);
  }

  // First and last day labels only — a tick per day is unreadable at this size.
  [0, days.length - 1].forEach((i) => {
    if (i < 0 || !days[i]) return;
    const label = el("text", {
      x: xFor(days[i]),
      y: height - 8,
      "text-anchor": i === 0 ? "start" : "end",
      class: "chart-tick",
    });
    label.textContent = days[i].slice(5);
    svg.appendChild(label);
  });

  const line = (pts) =>
    pts.map((p, i) => `${i ? "L" : "M"}${xFor(p.date).toFixed(1)},${yFor(p.points).toFixed(1)}`).join("");

  svg.appendChild(
    el("path", {
      d: line(ideal),
      fill: "none",
      stroke: idealStroke,
      "stroke-width": 2,
      "stroke-dasharray": "5 4",
      "stroke-linecap": "round",
      class: "chart-ideal",
    })
  );

  if (actual.length) {
    // Area wash under the actual line at ~10% — a wash, never a solid block.
    const areaD =
      line(actual) +
      `L${xFor(actual[actual.length - 1].date).toFixed(1)},${(padding.top + plotHeight).toFixed(1)}` +
      `L${xFor(actual[0].date).toFixed(1)},${(padding.top + plotHeight).toFixed(1)}Z`;
    svg.appendChild(el("path", { d: areaD, fill: actualFill, opacity: 0.1 }));

    svg.appendChild(
      el("path", {
        d: line(actual),
        fill: "none",
        stroke: actualFill,
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      })
    );

    // End marker: ≥8px, with a 2px surface ring so it survives crossing the
    // ideal line. The ring is part of the hover target too.
    const last = actual[actual.length - 1];
    svg.appendChild(
      el("circle", {
        cx: xFor(last.date), cy: yFor(last.points), r: 5,
        fill: actualFill, stroke: "var(--chart-surface)", "stroke-width": 2,
      })
    );

    for (const point of actual) {
      const dot = el("circle", {
        cx: xFor(point.date), cy: yFor(point.points), r: 4,
        fill: actualFill, stroke: "var(--chart-surface)", "stroke-width": 2,
        class: "chart-dot",
      });
      title(dot, `${point.date}: ${format(point.points)} points left`);
      svg.appendChild(dot);
    }
  }

  // Crosshair readout: an SVG chart is interactive by default.
  if (onHover) {
    const crosshair = el("line", {
      y1: padding.top, y2: padding.top + plotHeight,
      class: "chart-crosshair", visibility: "hidden",
    });
    svg.appendChild(crosshair);

    const hit = el("rect", {
      x: padding.left, y: padding.top, width: plotWidth, height: plotHeight,
      fill: "transparent",
    });
    hit.addEventListener("mousemove", (e) => {
      const box = svg.getBoundingClientRect();
      const scale = width / box.width;
      const x = (e.clientX - box.left) * scale;
      const span = Math.max(1, days.length - 1);
      const i = Math.round(((x - padding.left) / plotWidth) * span);
      const date = days[Math.max(0, Math.min(days.length - 1, i))];
      crosshair.setAttribute("x1", xFor(date));
      crosshair.setAttribute("x2", xFor(date));
      crosshair.setAttribute("visibility", "visible");
      onHover({
        date,
        actual: actual.find((p) => p.date === date) || null,
        ideal: ideal.find((p) => p.date === date) || null,
      });
    });
    hit.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      onHover(null);
    });
    svg.appendChild(hit);
  }

  return svg;
}

export function emptyState(text) {
  const el2 = document.createElement("div");
  el2.className = "chart-empty";
  el2.textContent = text;
  return el2;
}

// Legend: mandatory for two or more series. The swatch carries identity; the
// text stays in text ink.
export function legend(items) {
  const wrap = document.createElement("div");
  wrap.className = "chart-legend";
  for (const item of items) {
    const entry = document.createElement("span");
    entry.className = "chart-legend-item";
    const swatch = document.createElement("span");
    swatch.className = `chart-swatch${item.dashed ? " dashed" : ""}`;
    swatch.style.background = item.dashed ? "transparent" : item.fill;
    if (item.dashed) swatch.style.borderColor = item.fill;
    const label = document.createElement("span");
    label.textContent = item.label;
    entry.append(swatch, label);
    wrap.appendChild(entry);
  }
  return wrap;
}
