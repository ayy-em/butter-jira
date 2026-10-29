import { getAllEpics, getEpicChildren } from "../api.js";
import { boardColor, getStartDate, todayIso, showToast, BOARDS } from "../utils.js";
import { boardSlug } from "../config.js";
import { attachIssueOpener, openIssueDrawer } from "../components/issue-detail.js";
import { icon, svgIconPath } from "../components/icons.js";
import { localGet, localSet } from "../browser.js";

// The Display dropdown: whether a title leads with its issue key, whether it
// is drawn inside its bar (wrapped to at most TITLE_LINES lines) or beside it
// as the library does, and whether finished work is shown at all.
// Device-local, like the backlog's density — reading preferences, not team
// settings.
export const DISPLAY_KEY = "roadmapDisplay";
export const DEFAULT_DISPLAY = { showKeys: true, titlesInside: false, hideCompleted: false };
const TITLE_LINES = 3;

// The filters, zoom and timeframe, remembered between visits on this device
// so the roadmap opens the way it was left. The default timeframe is stored
// as "default", not as dates, so it still means last week to four weeks out
// whenever the roadmap is opened.
export const FILTERS_KEY = "roadmapFilters";
const TF_TYPES = ["default", "all", "year", "12months", "custom"];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Whatever was stored, as a complete and valid filter state. A custom range
// without both of its dates is the default timeframe; anything unrecognised
// is dropped rather than trusted.
export function normalizeFilters(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const list = (v) => Array.isArray(v)
    ? v.filter((x) => typeof x === "string" || typeof x === "number") : [];
  let tfType = TF_TYPES.includes(s.tfType) ? s.tfType : "default";
  const tfStart = ISO_DAY.test(s.tfStart) ? s.tfStart : null;
  const tfEnd = ISO_DAY.test(s.tfEnd) ? s.tfEnd : null;
  if (tfType === "custom" && !(tfStart && tfEnd)) tfType = "default";
  return {
    mode: VIEW_MODES.includes(s.mode) ? s.mode : null,
    tfType,
    tfStart: tfType === "custom" ? [tfStart, tfEnd].sort()[0] : null,
    tfEnd: tfType === "custom" ? [tfStart, tfEnd].sort()[1] : null,
    hiddenEpics: list(s.hiddenEpics),
    hiddenBoards: list(s.hiddenBoards),
    hiddenStatuses: list(s.hiddenStatuses),
    hiddenComponents: list(s.hiddenComponents),
    hiddenLabels: list(s.hiddenLabels),
  };
}

// Whether a bar's real due date is after the last day on screen, so the bar
// was cut at the chart's right edge and the work does not end there.
export function runsPastRange(task, range) {
  return Boolean(range && task?._to && task._to > range[1]);
}

// The same at the other end: started before the first day on screen.
export function startsBeforeRange(task, range) {
  return Boolean(range && task?._from && task._from < range[0]);
}

// A YYYY-MM-DD day as DD.MM, the way the app writes a date (see fmtDate in
// js/utils.js) without the year a roadmap's few months do not need.
export function dayMonth(iso) {
  return ISO_DAY.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "";
}

// Whatever was stored, as a complete set of booleans: a missing or mistyped
// field falls back to its default rather than to `undefined`.
export function normalizeDisplay(stored) {
  const out = { ...DEFAULT_DISPLAY };
  if (stored && typeof stored === "object")
    for (const k of Object.keys(DEFAULT_DISPLAY))
      if (typeof stored[k] === "boolean") out[k] = stored[k];
  return out;
}

// Finished, by Jira's status category rather than a status name, so a site
// that calls it "Closed" or "Released" still counts.
export function isCompleted(issue) {
  const status = issue?.fields?.status;
  return status?.statusCategory?.key === "done" || status?.name === "Done";
}

export function issueTitle(key, summary, showKey = true) {
  const text = String(summary || "");
  return showKey ? `${key} — ${text}` : text || key;
}
// Narrower than this — about nine characters, an issue key and its dash — and
// a title inside would break the key itself across lines; such a bar keeps
// its title beside it, whichever mode is on.
const MIN_INSIDE_TITLE_PX = 72;
// The type of a title inside its bar, before --font-scale; css/gantt.css sets
// the same size on `.gantt-bar-title-text`.
const TITLE_PX = 13;

// The presentation export: a 1080p slide's width, drawn at twice that for a
// sharp projector, with type sized to be read from the back of the room.
const EXPORT_WIDTH = 1920;
const EXPORT_SCALE = 2;
const EXPORT_MARGIN = 32;
const EXPORT_TITLE_PX = 17;
// The chart's two typefaces: mono for the bars, sans for the axis.
const EXPORT_FONTS = [
  ["Ubuntu Sans Mono", "200 700", new URL("../../assets/fonts/UbuntuSansMono-Variable.woff2", import.meta.url)],
  ["Ubuntu Sans", "100 800", new URL("../../assets/fonts/UbuntuSans-Variable.woff2", import.meta.url)],
];

// Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`,
// the last one cut with an ellipsis when the text runs on; `measure` returns
// a string's width. A word longer than a whole line is broken where it must
// be. For the export, where a title inside its bar is SVG text, and SVG text
// does not wrap.
export function wrapTitle(text, maxWidth, measure, maxLines = TITLE_LINES) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const push = (l) => { lines.push(l); return lines.length >= maxLines; };
  let i = 0;
  for (; i < words.length; i++) {
    let word = words[i];
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) { line = candidate; continue; }
    if (line && push(line)) break;
    line = "";
    // Longer than a line on its own: as much as fits, then the rest.
    while (measure(word) > maxWidth && word.length > 1) {
      let n = word.length - 1;
      while (n > 1 && measure(word.slice(0, n)) > maxWidth) n--;
      if (push(word.slice(0, n))) { word = ""; break; }
      word = word.slice(n);
    }
    if (lines.length >= maxLines) break;
    line = word;
  }
  if (line && lines.length < maxLines) { lines.push(line); line = ""; i = words.length; }
  const ranOn = i < words.length || line !== "";
  if (ranOn && lines.length) {
    let last = lines[lines.length - 1];
    while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

// Epic names were cut mid-word with a bare slice and no mark, so a truncated
// title was indistinguishable from a genuinely short one. The monitor already
// appends an ellipsis and the backlog does it in CSS; this is the third
// convention in the app agreeing with the first two.
function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// How close an epic is to its own due date, which is the one question a
// roadmap is read to answer and the one thing the bars did not say. Board
// colour is still on the bar — as its outline — because that answers a
// different question and both fit on one shape.
//
// Deliberately four states rather than three. "Done" is not "on track": a
// finished epic has stopped being a thing to watch, and colouring it the same
// green as work that is merely not-yet-late means a board of mostly-finished
// epics reads as uniformly healthy.
export const DUE_SOON_DAYS = 7;

export function deliveryState(epic, today = new Date()) {
  const done = epic?.fields?.status?.statusCategory?.key === "done";
  if (done) return "done";
  const due = epic?.fields?.duedate;
  if (!due) return "untracked";
  // Date-only arithmetic: a due date is a calendar day, and comparing it
  // against a timestamp makes "due today" overdue from 00:01.
  const dueDay = new Date(`${due}T00:00:00`);
  const nowDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((dueDay - nowDay) / 86400000);
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_DAYS) return "due-soon";
  return "on-track";
}


const VIEW_MODES      = ["Day", "Week", "Month", "Quarter Year"];
const VIEW_MODE_LABELS = ["Day", "Week", "Month", "Quarter"];
const QUARTER = "Quarter Year";
// An average quarter, in hours. frappe-gantt places bars by hours / step, and
// the columns below are real calendar quarters, so this is what keeps the two
// within a day of each other over a multi-year chart.
const QUARTER_HOURS = 24 * 365.25 / 4;

// Calendar days in an inclusive YYYY-MM-DD range.
export function rangeDays(from, to) {
  const ms = new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`);
  return Math.round(ms / 86400000) + 1;
}

// The zoom a timeframe reads best at. Picking a two-month range used to leave
// the chart on Month, which pads the axis out to a year either side of the
// data: two columns that mattered among a dozen that did not. Roughly, the
// range should land somewhere between eight and twenty-five columns.
export function modeForRange(days) {
  if (days <= 21) return "Day";
  if (days <= 120) return "Week";
  if (days <= 731) return "Month";
  return QUARTER;
}

// The start of the column a date falls in, so a zoomed axis opens on a column
// boundary rather than mid-week or mid-month. Weeks start on Monday.
export function columnStart(date, mode) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (mode === "Week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (mode === "Month") return new Date(d.getFullYear(), d.getMonth(), 1);
  if (mode === QUARTER) return new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % 3), 1);
  return d;
}

// The timeframe the roadmap opens on: from the Monday of last week to the
// Friday four weeks after this one. What a roadmap is opened to answer is
// what just happened and what is coming up, not the whole history of the
// project.
export function defaultRange(today = new Date()) {
  const monday = columnStart(today, "Week");
  const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
  const to = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4 + 28);
  return [todayIso(from), todayIso(to)];
}

// Where a title drawn inside its bar goes, given the part of the chart on
// screen, so a bar that runs off either edge still shows its title. It sits
// against the left edge of the screen while the bar's start is off it, and is
// no wider than the part of the bar that is on screen, so it wraps rather
// than running off the right. Near the bar's end it stops, at `min` wide,
// rather than shrinking to nothing. Null when the bar is too narrow to hold a
// title at all.
export function stickyTitleBox(barStart, barEnd, viewStart, viewEnd,
                               { lead = 6, pad = 6, min = MIN_INSIDE_TITLE_PX } = {}) {
  const left = barStart + lead;
  const right = barEnd - pad;
  if (right - left < min) return null;
  const x = Math.min(Math.max(viewStart + pad, left), right - min);
  const end = Math.min(Math.max(viewEnd - pad, x + min), right);
  return { x, width: end - x };
}

// The same for the library's one-line label when it fits inside its bar,
// which it centres on the whole bar — off screen, on a long one. Centred on
// the part of the bar that is on screen instead, and never past its ends;
// `lead` keeps it clear of a caret drawn inside the bar's start. Null when it
// does not fit inside at all, and belongs beside the bar.
export function stickyLabelX(barStart, barEnd, viewStart, viewEnd, labelWidth,
                             { lead = 4, pad = 4 } = {}) {
  const lo = barStart + lead + labelWidth / 2;
  const hi = barEnd - labelWidth / 2 - pad;
  if (hi < lo) return null;
  const centre = (Math.max(barStart, viewStart) + Math.min(barEnd, viewEnd)) / 2;
  return Math.min(Math.max(centre, lo), hi);
}

// A bar's dates cut to the visible range. A zoomed chart has no room either
// side of the range, so an epic that started last year starts at the left edge
// instead of off it. The popup still shows the real dates. ISO dates compare
// as strings.
export function clipToRange(start, end, range) {
  const [from, to] = range || [];
  if (!from || !to) return { start, end };
  return { start: start < from ? from : start, end: end > to ? to : end };
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// frappe-gantt, taught three things it does not do on its own: an axis fixed
// to a chosen range instead of padded around the data, columns stretched to
// fill the width when that range is short, and a Quarter scale. "Quarter Year"
// was never one of the library's modes — it fell through every branch, kept
// whatever scale the last mode had left behind and drew no header at all.
//
// Built on first use: `Gantt` is a global from libs/, and this module is also
// imported by the Node test suite, where it does not exist.
let RoadmapGantt = null;
function roadmapGantt() {
  if (RoadmapGantt) return RoadmapGantt;
  RoadmapGantt = class extends Gantt {
    update_view_scale(mode) {
      super.update_view_scale(mode);
      if (mode === QUARTER) {
        this.options.step = QUARTER_HOURS;
        this.options.column_width = 120;
      }
    }

    setup_gantt_dates() {
      super.setup_gantt_dates();
      const mode = this.options.view_mode;
      const [from, to] = this.options.range || [];
      if (from && to) {
        this.gantt_start = columnStart(new Date(`${from}T00:00:00`), mode);
        const end = new Date(`${to}T00:00:00`);
        end.setDate(end.getDate() + 1);
        this.gantt_end = end;
      } else if (mode === QUARTER) {
        this.gantt_start = columnStart(this.gantt_start, mode);
      }
    }

    setup_date_values() {
      if (this.view_is(QUARTER)) {
        this.dates = [];
        for (let d = new Date(this.gantt_start); d < this.gantt_end;
             d = new Date(d.getFullYear(), d.getMonth() + 3, 1))
          this.dates.push(d);
      } else {
        super.setup_date_values();
      }
      // The library always draws one column past the end; on a fixed range
      // that column is outside it.
      if (this.options.range)
        while (this.dates.length > 1 && this.dates[this.dates.length - 1] >= this.gantt_end)
          this.dates.pop();
      // A chart narrower than its box stretches to fill it, rather than
      // drawing in the left third and leaving the rest empty.
      const fit = Math.floor((this.options.fit_width || 0) / this.dates.length);
      if (fit > this.options.column_width) this.options.column_width = fit;
    }

    get_date_info(date, last, i) {
      if (this.view_is("Week")) {
        // Centred in its column like every other mode's, rather than on the
        // column's left edge — where the first week's date was cut in half by
        // the edge of a chart that starts on a range boundary.
        const info = super.get_date_info(date, last, i);
        return { ...info, lower_x: info.lower_x + this.options.column_width / 2 };
      }
      if (!this.view_is(QUARTER)) return super.get_date_info(date, last, i);
      const x = i * this.options.column_width + this.options.column_width / 2;
      return {
        lower_text: `Q${Math.floor(date.getMonth() / 3) + 1}`,
        upper_text: !last || last.getFullYear() !== date.getFullYear()
          ? String(date.getFullYear()) : "",
        lower_x: x,
        lower_y: this.options.header_height,
        upper_x: x,
        upper_y: this.options.header_height - 25,
      };
    }
  };
  return RoadmapGantt;
}

// Gantt bar colours are per-configured-board, so the rules are generated at
// mount time rather than written into gantt.css against fixed board names.
function injectBoardBarStyles() {
  const style = document.getElementById("gantt-board-bar-styles")
    || Object.assign(document.createElement("style"), { id: "gantt-board-bar-styles" });
  // The board's colour moved from the bar's fill to its outline when delivery
  // state took the fill. Both signals, one shape — and a roadmap filtered to a
  // single board loses nothing it was using, because the fill is now the part
  // that varies.
  style.textContent = BOARDS.map((board) => {
    const cls = `board-color-bar-${boardSlug(board.id)}`;
    return `.${cls} .bar { stroke: ${board.color}; stroke-width: 1.5px; }\n` +
           `.${cls} .bar-progress { fill: ${board.color}; }`;
  }).join("\n");
  if (!style.isConnected) document.head.appendChild(style);
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  const [epicsByBoard, storedDisplay, storedFilters] = await Promise.all([
    getAllEpics(creds),
    localGet(DISPLAY_KEY).then((r) => r[DISPLAY_KEY]).catch(() => null),
    localGet(FILTERS_KEY).then((r) => r[FILTERS_KEY]).catch(() => null),
  ]);
  const allEpics = [];
  for (const board of BOARDS)
    for (const e of (epicsByBoard[board.id] || [])) allEpics.push(e);

  injectBoardBarStyles();

  const dated   = allEpics.filter(e =>  getStartDate(e) && e.fields?.duedate);
  const undated = allEpics.filter(e => !getStartDate(e) || !e.fields?.duedate);

  // collect unique components + labels from dated epics
  const allComponents = [...new Set(
    dated.flatMap(e => (e.fields?.components || []).map(c => c.name))
  )].sort();
  const allLabels = [...new Set(
    dated.flatMap(e => e.fields?.labels || [])
  )].sort();
  // Statuses in workflow order — to do, in progress, done — then by name,
  // because that is the order a board reads them in and alphabetical is not.
  const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 };
  const statusCategory = new Map();
  for (const e of dated) {
    const name = e.fields?.status?.name;
    if (name && !statusCategory.has(name))
      statusCategory.set(name, e.fields.status.statusCategory?.key);
  }
  const allStatuses = [...statusCategory.keys()].sort((a, b) =>
    (CATEGORY_ORDER[statusCategory.get(a)] ?? 1) - (CATEGORY_ORDER[statusCategory.get(b)] ?? 1)
    || a.localeCompare(b));

  // ── DOM shell ──────────────────────────────────────────────────────────────
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "gantt-wrap";
  const controls = document.createElement("div");
  controls.className = "gantt-controls";
  const chartWrap = document.createElement("div");
  chartWrap.className = "gantt-chart-wrap";
  wrap.appendChild(controls);
  wrap.appendChild(chartWrap);
  container.appendChild(wrap);

  // ── State ──────────────────────────────────────────────────────────────────
  const saved = normalizeFilters(storedFilters);
  const display = normalizeDisplay(storedDisplay);
  let tfType  = saved.tfType;
  let tfStart = saved.tfStart;
  let tfEnd   = saved.tfEnd;
  // The zoom it was left at, or else the one that fits the timeframe — the
  // default timeframe is a range like any other.
  let currentMode = saved.mode || (() => {
    const [from, to] = tfType === "default" ? defaultRange()
      : tfType === "custom" ? [tfStart, tfEnd] : [null, null];
    return from ? modeForRange(rangeDays(from, to)) : "Month";
  })();
  // Only what still exists: an epic since deleted or a status nobody is in
  // any more would otherwise count as hidden, and "7 / 8 epics" would be
  // wrong in a way nothing on screen explains.
  const keep = (values, present) => new Set(values.filter((v) => present.includes(v)));
  const hiddenEpicKeys  = keep(saved.hiddenEpics, dated.map(e => e.key));
  const hiddenBoards    = keep(saved.hiddenBoards, BOARDS.map(b => b.id));
  const hiddenComponents = keep(saved.hiddenComponents, allComponents);
  const hiddenLabels    = keep(saved.hiddenLabels, allLabels);
  const hiddenStatuses  = keep(saved.hiddenStatuses, allStatuses);

  function saveFilters() {
    localSet({ [FILTERS_KEY]: {
      mode: currentMode, tfType, tfStart, tfEnd,
      hiddenEpics: [...hiddenEpicKeys],
      hiddenBoards: [...hiddenBoards],
      hiddenStatuses: [...hiddenStatuses],
      hiddenComponents: [...hiddenComponents],
      hiddenLabels: [...hiddenLabels],
    } }).catch(() => {});
  }
  const expandedEpics   = new Set();
  const childCache      = {};

  // ── Dropdown helper ────────────────────────────────────────────────────────
  const allPanels = [];
  // The buttons lose their open state too: closing a panel by clicking
  // elsewhere used to leave its button drawn as open.
  function closeAllPanels() {
    allPanels.forEach(p => { p.hidden = true; });
    controls.querySelectorAll(".gantt-dropdown-btn.active")
      .forEach(b => b.classList.remove("active"));
  }
  document.addEventListener("click", closeAllPanels);

  // Every dropdown button is "<label> ⌄". Set the label; the caret is the
  // button's own furniture and is drawn once.
  function setDropdownLabel(btn, text) {
    btn.textContent = "";
    const label = document.createElement("span");
    label.textContent = text;
    btn.appendChild(label);
    btn.appendChild(icon("chevron", 11));
  }

  function makeDropdown(baseLabel, extraClass = "") {
    const wrapEl = document.createElement("div");
    wrapEl.className = "gantt-dropdown-wrap";
    const btn = document.createElement("button");
    btn.className = "gantt-dropdown-btn";
    // A label span and one drawn caret, rather than " ▾" glued onto the end of
    // the text. Six places set this button's label; each of them used to have
    // to remember the glyph, and one that forgot would simply lose its caret.
    setDropdownLabel(btn, baseLabel);
    const panel = document.createElement("div");
    panel.className = "gantt-dropdown-panel" + (extraClass ? " " + extraClass : "");
    panel.hidden = true;
    allPanels.push(panel);
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const was = panel.hidden;
      closeAllPanels();
      panel.hidden = !was;
      btn.classList.toggle("active", !panel.hidden);
    });
    panel.addEventListener("click", e => e.stopPropagation());
    wrapEl.appendChild(btn);
    wrapEl.appendChild(panel);
    return { wrapEl, btn, panel };
  }

  // Generic checkbox-list dropdown (checked = visible)
  function makeCheckboxDropdown(baseLabel, items, hiddenSet, colorFn) {
    const { wrapEl, btn, panel } = makeDropdown(baseLabel, "gantt-filter-panel");

    // All / None
    const actRow = document.createElement("div");
    actRow.className = "gantt-filter-actions";
    ["All", "None"].forEach(txt => {
      const b = document.createElement("button");
      b.className = "gantt-filter-action-btn";
      b.textContent = txt;
      b.addEventListener("click", () => {
        const show = txt === "All";
        panel.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = show; });
        if (show) hiddenSet.clear(); else items.forEach(v => hiddenSet.add(v));
        syncBtn();
        rebuildAndRender();
      });
      actRow.appendChild(b);
    });
    panel.appendChild(actRow);

    for (const item of items) {
      const row = document.createElement("label");
      row.className = "gantt-filter-epic-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !hiddenSet.has(item);
      cb.addEventListener("change", () => {
        if (cb.checked) hiddenSet.delete(item); else hiddenSet.add(item);
        syncBtn();
        rebuildAndRender();
      });
      const span = document.createElement("span");
      span.className = "gantt-filter-epic-name";
      span.textContent = item;
      if (colorFn) span.style.color = colorFn(item);
      row.appendChild(cb);
      row.appendChild(span);
      panel.appendChild(row);
    }

    function syncBtn() {
      const vis = items.length - hiddenSet.size;
      setDropdownLabel(btn, hiddenSet.size === 0 ? baseLabel : `${vis} / ${items.length}`);
    }

    syncBtn();
    return { wrapEl, btn, syncBtn };
  }

  // separator helper
  function sep() {
    const s = document.createElement("div");
    s.className = "gantt-controls-sep";
    return s;
  }

  // ── View mode buttons ──────────────────────────────────────────────────────
  function setMode(mode) {
    currentMode = mode;
    controls.querySelectorAll(".gantt-mode-btn[data-mode]").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === currentMode));
  }

  for (let i = 0; i < VIEW_MODES.length; i++) {
    const btn = document.createElement("button");
    btn.className = "gantt-mode-btn" + (VIEW_MODES[i] === currentMode ? " active" : "");
    btn.textContent = VIEW_MODE_LABELS[i];
    btn.dataset.mode = VIEW_MODES[i];
    btn.addEventListener("click", () => {
      setMode(VIEW_MODES[i]);
      // A new zoom level is a new axis: today sits somewhere else on it, so
      // the chart re-centres rather than keeping a scroll offset that meant
      // something on the old one.
      scrolledToToday = false;
      saveFilters();
      renderGantt();
    });
    controls.appendChild(btn);
  }

  // ── Display ────────────────────────────────────────────────────────────────
  // Three reading preferences in one dropdown, where the "Titles inside" chip
  // used to stand alone — the toolbar had no room for three more chips.
  const displayDropdown = (() => {
    const { wrapEl, btn, panel } = makeDropdown("Display");
    for (const [key, label, title] of [
      ["showKeys", "Show issue key", "Start each title with its issue key"],
      ["titlesInside", "Titles inside", `Draw each title inside its bar, up to ${TITLE_LINES} lines, instead of beside it`],
      ["hideCompleted", "Hide completed", "Leave out epics and issues that are done"],
    ]) {
      const row = document.createElement("label");
      row.className = "gantt-filter-epic-row";
      row.title = title;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = display[key];
      cb.addEventListener("change", () => {
        display[key] = cb.checked;
        syncDisplayBtn();
        localSet({ [DISPLAY_KEY]: { ...display } }).catch(() => {});
        if (key === "hideCompleted") {
          // A different set of rows, possibly a different span of dates.
          rebuildAndRender();
          return;
        }
        // Same axis, same rows, different titles: the reader's scroll
        // position still means something, so it is kept.
        const left = chartWrap.querySelector(".gantt-container")?.scrollLeft || 0;
        rebuildTasks();
        renderGantt();
        const next = chartWrap.querySelector(".gantt-container");
        if (next) next.scrollLeft = left;
      });
      const span = document.createElement("span");
      span.className = "gantt-filter-epic-name";
      span.textContent = label;
      row.appendChild(cb);
      row.appendChild(span);
      panel.appendChild(row);
    }
    // Says how many settings differ from the defaults, the way the filters
    // say how many items they hide — so a roadmap missing its done epics does
    // not look like the whole roadmap.
    function syncDisplayBtn() {
      const changed = Object.keys(DEFAULT_DISPLAY)
        .filter((k) => display[k] !== DEFAULT_DISPLAY[k]).length;
      setDropdownLabel(btn, changed ? `Display · ${changed}` : "Display");
    }
    syncDisplayBtn();
    return { wrapEl };
  })();
  controls.appendChild(displayDropdown.wrapEl);

  // Choosing a timeframe zooms to it: the mode that fits the range is picked
  // for you, and a mode button afterwards still overrides it within the same
  // range. Back to all time is back to the default Month.
  function zoomToTimeframe() {
    const [from, to] = getTimeframeBounds();
    setMode(from ? modeForRange(rangeDays(from, to)) : "Month");
    rebuildAndRender();
  }

  controls.appendChild(sep());

  // ── Timeframe picker ───────────────────────────────────────────────────────
  const DEFAULT_TF_LABEL = "Last week → 4 weeks out";
  const { wrapEl: tfWrapEl, btn: tfBtn, panel: tfPanel } = makeDropdown(DEFAULT_TF_LABEL);
  // Labelled for the timeframe it was left on.
  controls.appendChild(tfWrapEl);

  const TF_OPTIONS = [
    { value: "default",  label: DEFAULT_TF_LABEL },
    { value: "all",      label: "All time" },
    { value: "year",     label: `This year (${new Date().getFullYear()})` },
    { value: "12months", label: "Next 12 months" },
    { value: "custom",   label: "Custom range" },
  ];
  // The date fields are always shown, and Apply is what selects "Custom
  // range". They were meant to appear only once Custom was picked, but the
  // row's `display: flex` beat the `hidden` attribute, so they were always on
  // screen — and Apply with "All time" still selected changed the button's
  // label and nothing else. People go straight for the dates; the dates now
  // do what they say.
  const customRow = document.createElement("div");
  customRow.className = "tf-custom-row";
  let customRadio = null;

  for (const opt of TF_OPTIONS) {
    const lbl = document.createElement("label");
    lbl.className = "gantt-dropdown-option";
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "gantt-tf"; radio.value = opt.value;
    radio.checked = opt.value === tfType;
    if (radio.checked)
      setDropdownLabel(tfBtn, tfType === "custom" ? `${tfStart} → ${tfEnd}` : opt.label);
    lbl.appendChild(radio);
    lbl.append(" " + opt.label);
    tfPanel.appendChild(lbl);
    if (opt.value === "custom") customRadio = radio;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      if (opt.value === "custom") {
        // Picking Custom with dates already filled in applies them; without
        // them it waits for Apply.
        applyCustomRange();
        return;
      }
      tfType = opt.value;
      setDropdownLabel(tfBtn, opt.label);
      zoomToTimeframe();
    });
  }

  const startInput = document.createElement("input");
  startInput.type = "date"; startInput.className = "tf-date-input";
  const endInput = document.createElement("input");
  endInput.type = "date"; endInput.className = "tf-date-input";
  // A custom range starts from the default one rather than from two blank
  // fields: usually it is that, nudged.
  // A saved custom range comes back as it was.
  [startInput.value, endInput.value] = tfType === "custom" ? [tfStart, tfEnd] : defaultRange();
  const applyBtn = document.createElement("button");
  applyBtn.className = "tf-apply-btn"; applyBtn.textContent = "Apply";
  function applyCustomRange() {
    if (!startInput.value || !endInput.value) return;
    tfType = "custom";
    customRadio.checked = true;
    // Entered backwards is still a range; it used to match nothing at all.
    [tfStart, tfEnd] = [startInput.value, endInput.value].sort();
    setDropdownLabel(tfBtn, `${tfStart} → ${tfEnd}`);
    closeAllPanels();
    zoomToTimeframe();
  }
  applyBtn.addEventListener("click", applyCustomRange);
  for (const input of [startInput, endInput])
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustomRange(); });
  customRow.appendChild(startInput);
  customRow.append(" to ");
  customRow.appendChild(endInput);
  customRow.appendChild(applyBtn);
  tfPanel.appendChild(customRow);

  controls.appendChild(sep());

  // ── Epic filter ────────────────────────────────────────────────────────────
  const { wrapEl: epicFilterWrap, btn: epicFilterBtn } = (() => {
    const { wrapEl, btn, panel } = makeDropdown("All epics", "gantt-filter-panel");

    const actRow = document.createElement("div");
    actRow.className = "gantt-filter-actions";
    ["All", "None"].forEach(txt => {
      const b = document.createElement("button");
      b.className = "gantt-filter-action-btn"; b.textContent = txt;
      b.addEventListener("click", () => {
        const show = txt === "All";
        panel.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = show; });
        if (show) hiddenEpicKeys.clear(); else dated.forEach(e => hiddenEpicKeys.add(e.key));
        syncEpicBtn();
        rebuildAndRender();
      });
      actRow.appendChild(b);
    });
    panel.appendChild(actRow);

    for (const board of BOARDS) {
      const boardEpics = dated.filter(e => e.boardId === board.id);
      if (!boardEpics.length) continue;
      const grp = document.createElement("div");
      grp.className = "gantt-filter-group";
      grp.style.color = boardColor(board.id);
      grp.textContent = board.name;
      panel.appendChild(grp);
      for (const epic of boardEpics) {
        const row = document.createElement("label");
        row.className = "gantt-filter-epic-row";
        const cb = document.createElement("input"); cb.type = "checkbox";
        cb.checked = !hiddenEpicKeys.has(epic.key);
        cb.addEventListener("change", () => {
          if (cb.checked) hiddenEpicKeys.delete(epic.key); else hiddenEpicKeys.add(epic.key);
          syncEpicBtn(); rebuildAndRender();
        });
        const keySpan = document.createElement("span");
        keySpan.className = "epic-key mono"; keySpan.style.color = boardColor(board.id);
        keySpan.textContent = epic.key;
        const nameSpan = document.createElement("span");
        nameSpan.className = "gantt-filter-epic-name";
        nameSpan.textContent = truncate(epic.fields?.summary, 38);
        row.appendChild(cb); row.appendChild(keySpan); row.appendChild(nameSpan);
        panel.appendChild(row);
      }
    }

    function syncEpicBtn() {
      const vis = dated.length - hiddenEpicKeys.size;
      setDropdownLabel(btn, hiddenEpicKeys.size === 0 ? "All epics" : `${vis} / ${dated.length} epics`);
    }

    syncEpicBtn();
    return { wrapEl, btn };
  })();
  controls.appendChild(epicFilterWrap);

  // ── Board filter ───────────────────────────────────────────────────────────
  const boardDropdown = (() => {
    const { wrapEl, btn, panel } = makeDropdown("All boards", "gantt-filter-panel");

    const actRow = document.createElement("div");
    actRow.className = "gantt-filter-actions";
    ["All", "None"].forEach(txt => {
      const b = document.createElement("button");
      b.className = "gantt-filter-action-btn"; b.textContent = txt;
      b.addEventListener("click", () => {
        const show = txt === "All";
        panel.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = show; });
        if (show) hiddenBoards.clear(); else BOARDS.forEach(bd => hiddenBoards.add(bd.id));
        syncBoardBtn();
        rebuildAndRender();
      });
      actRow.appendChild(b);
    });
    panel.appendChild(actRow);

    for (const board of BOARDS) {
      const row = document.createElement("label");
      row.className = "gantt-filter-epic-row";
      const cb = document.createElement("input"); cb.type = "checkbox";
      cb.checked = !hiddenBoards.has(board.id);
      cb.addEventListener("change", () => {
        if (cb.checked) hiddenBoards.delete(board.id); else hiddenBoards.add(board.id);
        syncBoardBtn(); rebuildAndRender();
      });
      const dot = document.createElement("span");
      dot.className = "board-dot";
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${boardColor(board.id)};flex-shrink:0;display:inline-block;`;
      const nameSpan = document.createElement("span");
      nameSpan.className = "gantt-filter-epic-name";
      nameSpan.style.color = boardColor(board.id);
      nameSpan.textContent = board.name;
      row.appendChild(cb); row.appendChild(dot); row.appendChild(nameSpan);
      panel.appendChild(row);
    }

    function syncBoardBtn() {
      const vis = BOARDS.length - hiddenBoards.size;
      setDropdownLabel(btn, hiddenBoards.size === 0 ? "All boards" : `${vis} / ${BOARDS.length} boards`);
    }

    syncBoardBtn();
    return { wrapEl };
  })();
  controls.appendChild(boardDropdown.wrapEl);

  // ── Status filter ──────────────────────────────────────────────────────────
  if (allStatuses.length) {
    const { wrapEl } = makeCheckboxDropdown("Statuses", allStatuses, hiddenStatuses, null);
    controls.appendChild(wrapEl);
  }

  // ── Component filter ───────────────────────────────────────────────────────
  if (allComponents.length) {
    const { wrapEl } = makeCheckboxDropdown("Components", allComponents, hiddenComponents, null);
    controls.appendChild(wrapEl);
  }

  // ── Label filter ───────────────────────────────────────────────────────────
  if (allLabels.length) {
    const { wrapEl } = makeCheckboxDropdown("Labels", allLabels, hiddenLabels, null);
    controls.appendChild(wrapEl);
  }

  controls.appendChild(sep());

  // ── Legend ─────────────────────────────────────────────────────────────────
  // Four colours doing semantic work need saying once. Small, in the toolbar,
  // and not repeated per bar.
  const legend = document.createElement("div");
  legend.className = "gantt-legend";
  for (const [state, label, title] of [
    ["on-track", "On track", "Due more than a week out"],
    ["due-soon", "Due soon", `Due within ${DUE_SOON_DAYS} days`],
    ["overdue", "Overdue", "Past its due date and not done"],
    ["done", "Done", "Finished — no longer tracking against a date"],
  ]) {
    const item = document.createElement("span");
    item.className = "gantt-legend-item";
    item.title = title;
    const dot = document.createElement("span");
    dot.className = `gantt-legend-dot delivery-${state}`;
    item.append(dot, document.createTextNode(label));
    legend.appendChild(item);
  }
  controls.appendChild(legend);

  // ── Info ───────────────────────────────────────────────────────────────────
  const info = document.createElement("span");
  info.className = "gantt-info";
  controls.appendChild(info);

  // ── Presentation export ────────────────────────────────────────────────────
  const exportBtn = document.createElement("button");
  exportBtn.className = "gantt-mode-btn gantt-export-btn";
  exportBtn.title = "Download the roadmap as it is filtered now, as a PNG for slides";
  exportBtn.append(icon("download", 13), document.createTextNode("Export"));
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    try {
      await exportPresentation();
    } catch (err) {
      console.error("Roadmap export failed:", err);
      showToast(`Export failed: ${err.message}`, true);
    } finally {
      exportBtn.disabled = false;
    }
  });
  controls.appendChild(exportBtn);

  // ── Filtering logic ────────────────────────────────────────────────────────
  // Inclusive YYYY-MM-DD bounds, compared as strings against Jira's date-only
  // fields. They were Date objects, and `new Date("2026-03-01")` is UTC
  // midnight while the end bound was local — a range edge moved by the
  // timezone.
  function getTimeframeBounds() {
    if (tfType === "default") return defaultRange();
    if (tfType === "year") {
      const y = new Date().getFullYear();
      return [`${y}-01-01`, `${y}-12-31`];
    }
    if (tfType === "12months") {
      const e = new Date();
      e.setFullYear(e.getFullYear() + 1);
      return [todayIso(), todayIso(e)];
    }
    if (tfType === "custom" && tfStart && tfEnd) return [tfStart, tfEnd];
    return [null, null];
  }

  function currentRange() {
    const [from, to] = getTimeframeBounds();
    return from ? [from, to] : null;
  }

  function getVisibleDated() {
    const [tfS, tfE] = getTimeframeBounds();
    return dated.filter(epic => {
      // board
      if (hiddenBoards.has(epic.boardId)) return false;
      // component — hide only if all components are unchecked
      const comps = (epic.fields?.components || []).map(c => c.name);
      if (comps.length && hiddenComponents.size)
        if (comps.every(c => hiddenComponents.has(c))) return false;
      // label — hide only if all labels are unchecked
      const lbls = epic.fields?.labels || [];
      if (lbls.length && hiddenLabels.size)
        if (lbls.every(l => hiddenLabels.has(l))) return false;
      // status
      const status = epic.fields?.status?.name;
      if (status && hiddenStatuses.has(status)) return false;
      // timeframe
      if (tfS && tfE)
        if (getStartDate(epic) > tfE || epic.fields.duedate < tfS) return false;
      // epic
      if (hiddenEpicKeys.has(epic.key)) return false;
      if (display.hideCompleted && isCompleted(epic)) return false;
      return true;
    });
  }

  function updateInfo() {
    const vis = getVisibleDated();
    info.textContent = `${vis.length} of ${dated.length} dated · ${undated.length} undated`;
  }

  // ── Task builders ──────────────────────────────────────────────────────────
  function epicToTask(epic, range) {
    const from = getStartDate(epic), to = epic.fields.duedate;
    return {
      id: epic.key,
      name: truncate(issueTitle(epic.key, epic.fields.summary, display.showKeys), 60),
      // Untruncated, for titles drawn inside the bar: the line clamp there
      // does the cutting, at whatever the bar's width allows.
      _title: issueTitle(epic.key, epic.fields.summary, display.showKeys),
      ...clipToRange(from, to, range),
      progress: 0,
      // Two classes, two signals: delivery state fills the bar, board identity
      // outlines it. They answer different questions and a bar has room for
      // both.
      custom_class:
        `board-color-bar-${boardSlug(epic.boardId)} delivery-${deliveryState(epic)}`,
      _epic: epic,
      _isChild: false,
      // The real dates, for the popup: start/end above may be clipped.
      _from: from,
      _to: to,
      _status: epic.fields.status?.name,
    };
  }

  // Null when the child falls entirely outside the range.
  function childToTask(child, parentKey, range) {
    const today = todayIso();
    const from = getStartDate(child) || child.fields.created?.slice(0, 10) || today;
    const to   = child.fields.duedate || child.fields.updated?.slice(0, 10) || today;
    if (range && (from > range[1] || to < range[0])) return null;
    return {
      id: child.key,
      name: `  ${truncate(issueTitle(child.key, child.fields.summary, display.showKeys), 60)}`,
      _title: issueTitle(child.key, child.fields.summary, display.showKeys),
      ...clipToRange(from, to, range),
      progress: 0,
      // Quieter than an epic, and grey like a done epic once it is done.
      custom_class: isCompleted(child) ? "child-task delivery-done" : "child-task",
      dependencies: parentKey,
      _isChild: true,
      _from: from,
      _to: to,
      _status: child.fields.status?.name,
    };
  }

  // ── Task list ──────────────────────────────────────────────────────────────
  let tasks = [];
  // Latches once today has been scrolled to, so expanding an epic does not
  // drag the chart back under the reader. Cleared whenever the axis itself
  // changes — a new view mode or timeframe is a new chart.
  let scrolledToToday = false;

  function rebuildTasks() {
    const visible = getVisibleDated();
    const range = currentRange();
    tasks = [];
    for (const epic of visible) {
      tasks.push(epicToTask(epic, range));
      if (expandedEpics.has(epic.key) && childCache[epic.key])
        for (const child of childCache[epic.key]) {
          if (display.hideCompleted && isCompleted(child)) continue;
          const task = childToTask(child, epic.key, range);
          if (task) tasks.push(task);
        }
    }
  }

  async function toggleExpand(epicKey) {
    if (expandedEpics.has(epicKey)) expandedEpics.delete(epicKey);
    else {
      expandedEpics.add(epicKey);
      if (!childCache[epicKey]) childCache[epicKey] = await getEpicChildren(epicKey, creds);
    }
    rebuildTasks();
    renderGantt();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderGantt() {
    chartWrap.innerHTML = "";
    if (!getVisibleDated().length) {
      chartWrap.innerHTML = '<div class="empty-state">No epics visible — adjust timeframe or filters.</div>';
      exportBtn.disabled = true;
      updateInfo();
      return;
    }
    exportBtn.disabled = false;
    if (typeof Gantt === "undefined") {
      chartWrap.innerHTML = '<div class="empty-state">frappe-gantt library not loaded.</div>';
      return;
    }
    const el = document.createElement("div");
    el.id = "gantt-target";
    chartWrap.appendChild(el);
    chartWrap.classList.toggle("titles-inside", display.titlesInside);
    const Chart = roadmapGantt();
    const chart = new Chart("#gantt-target", tasks, {
      view_mode: currentMode,
      date_format: "YYYY-MM-DD",
      language: "en",
      // A chosen timeframe is the axis, and a short one stretches to fill the
      // chart rather than sitting in its left third. See roadmapGantt().
      range: currentRange(),
      fit_width: chartWrap.clientWidth - 2,
      bar_height: display.titlesInside ? insideBarHeight() : 20,
      // The popup is a hover tooltip now. On "click" it took the click that
      // should have opened the issue — the library only reports a click on a
      // double-click — and then stayed up over the next bar's label.
      popup_trigger: "mouseover",
      custom_popup_html: task => `
        <div class="gantt-popup" style="padding:8px 12px;font-family:'Ubuntu Sans Mono',ui-monospace,monospace;font-size:12px;">
          <div style="color:#E8EAF0;margin-bottom:4px;">${escapeHtml(task.name)}</div>
          <div style="color:#E8EAF0;font-size:11px;margin-bottom:4px;">${escapeHtml(task._from)} → ${escapeHtml(task._to)}${task._status ? ` · ${escapeHtml(task._status)}` : ""}</div>
          ${startsBeforeRange(task, currentRange()) ? `<div style="color:#E8EAF0;font-size:11px;margin-bottom:4px;">« Started before the start of this view</div>` : ""}
          ${runsPastRange(task, currentRange()) ? `<div style="color:#E8EAF0;font-size:11px;margin-bottom:4px;">» Due after the end of this view</div>` : ""}
          <div style="color:#6B7280;font-size:11px;">${task._isChild ? "Click for issue details" : "Click for epic details · caret to expand"}</div>
        </div>`,
      on_date_change: () => {},
      on_progress_change: () => {},
    });
    // Off the chart is off every bar; the library only hides its popup on
    // entering the grid, so leaving sideways left it up.
    chartWrap.querySelector(".gantt-container")
      ?.addEventListener("mouseleave", () => chart.hide_popup());
    decorateChart(chart);
    updateInfo();
  }

  // ── Chart decoration ───────────────────────────────────────────────────────

  // frappe-gantt draws the grid, the bars and a pale band for today, and stops
  // there. Three things are added on top of its SVG after each render, rather
  // than forked into the vendored library: a today line, an expand caret per
  // epic, and an opening scroll position that puts today on screen.
  // Where today sits in chart coordinates. frappe-gantt draws a today band of
  // its own but only in Day view (`make_grid_highlights` is guarded on it), so
  // in Month, Week and Quarter — which is where a roadmap is actually read —
  // there was nothing marking now at all.
  //
  // This is the library's own `compute_x`, applied to today instead of to a
  // task's start. Copied rather than derived so the line lands on exactly the
  // same scale the bars do, including the Month special case, where columns are
  // a nominal thirtieth of a month rather than a fixed step.
  function todayX(chart) {
    const { step, column_width } = chart.options;
    const start = chart.gantt_start;
    if (!start || !column_width) return null;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ms = midnight - start;
    if (currentMode === "Month") return (ms / 86400000) * column_width / 30;
    return (ms / 3600000) / step * column_width;
  }

  // Tall enough for TITLE_LINES lines of the bar label's own type, which is
  // set in css/gantt.css against --font-scale and so is read from it here.
  function insideBarHeight(px = TITLE_PX * fontScale()) {
    return Math.ceil(px * 1.2 * TITLE_LINES + 10);
  }

  // Text widths in the chart's typeface, for deciding whether a title fits.
  let measureCtx = null;
  function textWidth(text, px, weight = 600) {
    measureCtx ||= document.createElement("canvas").getContext("2d");
    measureCtx.font = `${weight} ${px}px 'Ubuntu Sans Mono'`;
    return measureCtx.measureText(text).width;
  }
  // Whether a title can go inside a bar with this much room: the bar's
  // minimum, and its first word — the issue key, usually — whole on one line.
  // Narrower and the key itself was broken across lines ("ACME-21 / 0").
  function titleFits(title, room, px) {
    const first = String(title || "").split(/\s+/)[0] || "";
    return room >= MIN_INSIDE_TITLE_PX && room >= textWidth(first, px) + 2;
  }

  function fontScale() {
    return parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--font-scale")) || 1;
  }

  // SVG text does not wrap, so a title inside its bar is HTML in a
  // foreignObject the size of the bar, clamped to TITLE_LINES lines. It takes
  // no pointer events: clicks and the hover popup still belong to the bar.
  function drawTitleInside(wrapper, bar, task) {
    const x = parseFloat(bar.getAttribute("x"));
    const y = parseFloat(bar.getAttribute("y"));
    const w = parseFloat(bar.getAttribute("width"));
    const h = parseFloat(bar.getAttribute("height"));
    // Clear of whatever markEdges() put at either end: a caret inside the
    // bar's start, and the edge marks.
    const left = edgeRoom(wrapper, "lead");
    const tail = edgeRoom(wrapper, "tail");
    if (!titleFits(task._title, w - left - tail, TITLE_PX * fontScale())) return;

    const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute("class", "gantt-bar-title");
    fo.setAttribute("y", y);
    fo.setAttribute("height", h);
    // x and width come from placeStickyTitles(), and change as the chart
    // scrolls.
    fo._place = (viewStart, viewEnd) => {
      const box = stickyTitleBox(x, x + w - tail + 6, viewStart, viewEnd, { lead: left });
      fo.setAttribute("x", box.x);
      fo.setAttribute("width", box.width);
    };
    const box = document.createElement("div");
    box.className = "gantt-bar-title-box";
    const text = document.createElement("div");
    text.className = "gantt-bar-title-text";
    text.style.setProperty("--title-lines", TITLE_LINES);
    text.textContent = task._title;
    box.appendChild(text);
    fo.appendChild(box);
    wrapper.querySelector(".bar-group")?.appendChild(fo);
    wrapper.classList.add("title-inside");
    return fo;
  }

  // The library's one-line labels, settled: which fit inside their bar (clear
  // of a caret inside its start and of a runs-on mark at its end) and which go
  // beside it. Beside is after the bar, as the library does — unless that is
  // off the right edge of the chart, which is where every bar that runs past
  // the view ends, so those go before the bar instead. Returns the labels
  // inside bars, for placing as the chart scrolls.
  function layoutLabels(svg) {
    const chartWidth = parseFloat(svg.querySelector(".grid-background")?.getAttribute("width")) || Infinity;
    return [...svg.querySelectorAll(".bar-wrapper:not(.title-inside) .bar-label")]
      .map((label) => {
        const wrapper = label.closest(".bar-wrapper");
        const bar = wrapper?.querySelector(".bar");
        if (!bar) return null;
        const start = parseFloat(bar.getAttribute("x"));
        const caret = wrapper.querySelector(".gantt-caret");
        // Clear of a caret inside the bar and of the edge marks, the way the
        // inside titles are (see markEdges).
        const end = start + parseFloat(bar.getAttribute("width")) - edgeRoom(wrapper, "tail") + 4;
        const lead = edgeRoom(wrapper, "lead") - 2;
        const width = label.getBBox().width;
        if (stickyLabelX(start, end, 0, Infinity, width, { lead }) !== null) {
          label.classList.remove("big");
          return { label, start, end, width, lead };
        }
        // Too long for the bar: beside it, the library's own arrangement.
        label.classList.add("big");
        const barEnd = start + parseFloat(bar.getAttribute("width"));
        if (barEnd + 5 + width <= chartWidth) {
          label.setAttribute("x", barEnd + 5);
          label.style.textAnchor = "";
        } else {
          // Before the bar, and before a caret outside it.
          label.setAttribute("x", start - (caret && start >= 16 ? 22 : 5));
          label.style.textAnchor = "end";
        }
        return null;
      })
      .filter(Boolean);
  }

  // The mark on a bar cut at an edge of the chart because the work runs past
  // it: a bold double chevron pointing off the chart — » at the right for a
  // due date after the last day shown, « at the left for a start before the
  // first — with that date under it as DD.MM. White with a black outline in
  // dark theme, the reverse in light, so it reads over any bar colour and
  // over the grid alike. Sized from the bar: bigger on the taller bars of
  // titles inside and of the export. Returns the width it takes up.
  function drawEdgeMark(wrapper, bar, side, iso, inset) {
    const x = parseFloat(bar.getAttribute("x"));
    const y = parseFloat(bar.getAttribute("y"));
    const w = parseFloat(bar.getAttribute("width"));
    const h = parseFloat(bar.getAttribute("height"));
    const arrowH = Math.max(14, Math.min(24, Math.round(h * 0.7)));
    const depth = arrowH * 0.4;
    const gap = arrowH * 0.38;
    const stroke = Math.max(2.5, arrowH * 0.13);
    const datePx = Math.max(10, Math.min(13, Math.round(arrowH * 0.55)));
    const date = dayMonth(iso);
    const blockW = Math.max(depth + gap + stroke, textWidth(date, datePx, 700) + 4);
    // The date under the arrows inside a bar tall enough for both; otherwise
    // the arrows take the bar and the date sits just under it, in the gap
    // between rows.
    const inside = h >= arrowH + datePx + 10;
    const arrowCy = inside ? y + h / 2 - (datePx + 4) / 2 : y + h / 2;
    const dateY = inside ? arrowCy + arrowH / 2 + 3 + datePx / 2 : y + h + 3 + datePx / 2;
    const cx = side === "right" ? x + w - inset - blockW / 2 : x + inset + blockW / 2;

    const dir = side === "right" ? 1 : -1;
    const tip = cx + dir * (depth + gap) / 2;
    const d = [tip, tip - dir * gap].map((t) =>
      `M ${t - dir * depth} ${arrowCy - arrowH / 2} L ${t} ${arrowCy} L ${t - dir * depth} ${arrowCy + arrowH / 2}`
    ).join(" ");
    const NS = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", `gantt-edge-mark gantt-edge-${side}`);
    for (const [cls, width] of [["gantt-edge-outline", stroke + 6], ["gantt-edge-arrow", stroke]]) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", cls);
      path.setAttribute("d", d);
      path.setAttribute("stroke-width", width);
      g.appendChild(path);
    }
    if (date) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("class", "gantt-edge-date");
      text.setAttribute("x", cx);
      text.setAttribute("y", dateY);
      text.setAttribute("font-size", datePx);
      text.textContent = date;
      g.appendChild(text);
    }
    wrapper.appendChild(g);
    return blockW;
  }

  // Marks the bars cut at either edge, and records on each bar how much room
  // its ends need — a caret inside its start, the edge marks — so titles and
  // labels are laid out around them. `carets` is false for the export, which
  // has none.
  function markEdges(svg, carets = true) {
    const range = currentRange();
    for (const wrapper of svg.querySelectorAll(".bar-wrapper")) {
      const task = tasks.find((t) => t.id === wrapper.getAttribute("data-id"));
      const bar = wrapper.querySelector(".bar");
      if (!task || !bar) continue;
      const barX = parseFloat(bar.getAttribute("x"));
      // The caret sits inside a bar that starts at the chart's edge (see
      // decorateChart); the « mark goes after it.
      const caretRoom = carets && !task._isChild && barX < 16 ? 18 : 0;
      let lead = caretRoom ? 20 : 6;
      let tail = 6;
      if (startsBeforeRange(task, range)) {
        wrapper.classList.add("starts-before");
        lead = caretRoom + 4 + drawEdgeMark(wrapper, bar, "left", task._from, caretRoom + 4) + 8;
      }
      if (runsPastRange(task, range)) {
        wrapper.classList.add("runs-on");
        tail = 6 + drawEdgeMark(wrapper, bar, "right", task._to, 6) + 8;
      }
      wrapper.dataset.lead = lead;
      wrapper.dataset.tail = tail;
    }
  }

  function edgeRoom(wrapper, end) {
    return parseFloat(wrapper.dataset[end]) || 6;
  }

  // Titles stay on screen while the chart scrolls sideways: a bar that starts
  // off the left edge, which a long epic in Day or Week view always does,
  // used to show no title at all.
  function makeTitlesSticky(svg, container) {
    const titles = [...svg.querySelectorAll(".gantt-bar-title")];
    // The library's own labels, where they sit inside the bar. One beside the
    // bar (`.big`) follows the bar's end and needs nothing.
    const labels = layoutLabels(svg);
    const place = () => {
      const viewStart = container.scrollLeft;
      const viewEnd = viewStart + container.clientWidth;
      for (const fo of titles) fo._place(viewStart, viewEnd);
      for (const l of labels)
        l.label.setAttribute("x",
          stickyLabelX(l.start, l.end, viewStart, viewEnd, l.width, { lead: l.lead }));
    };
    let queued = false;
    container.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(); });
    }, { passive: true });
    place();
  }

  // Returns where the line went, or null when today is not on the chart.
  function drawTodayLine(chart, svg) {
    const x = todayX(chart);
    // The grid's width, not the svg's: the library leaves the svg at "100%"
    // unless the chart overflows its box, which parsed as 100 and hid the
    // today line on every chart that fits — and a zoomed range always does.
    const grid = svg.querySelector(".grid-background");
    const width = parseFloat(grid?.getAttribute("width")) || 0;
    // Only when today is actually on the chart. A roadmap filtered to last
    // quarter should not grow a line pinned to its left edge.
    if (x === null || x < 0 || (width && x > width)) return null;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "gantt-today-line");
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    line.setAttribute("y1", 0);
    line.setAttribute("y2", svg.getAttribute("height") || "100%");
    svg.appendChild(line);
    return x;
  }

  function decorateChart(chart) {
    const svg = chartWrap.querySelector("svg");
    const container = chartWrap.querySelector(".gantt-container") || chartWrap;
    if (!svg) return;
    markEdges(svg);

    const x = drawTodayLine(chart, svg);
    if (x !== null) {
      // Open on today rather than on the earliest start date. A roadmap is read
      // forwards from now; scrolled hard left it opens on whatever started
      // longest ago, which is the part nobody is asking about. Latched, so
      // expanding an epic does not drag the chart back mid-read.
      if (!scrolledToToday) {
        container.scrollLeft = Math.max(0, x - container.clientWidth / 2);
        scrolledToToday = true;
      }
    }

    for (const wrapper of svg.querySelectorAll(".bar-wrapper")) {
      const id = wrapper.getAttribute("data-id");
      const task = tasks.find((t) => t.id === id);
      if (!task) continue;

      // Clicking a bar opens the issue, epic or child alike — the same drawer
      // the Kanban cards and the standup board open, over the same chart, so
      // the roadmap stops being the one view where clicking a thing shows you
      // nothing about it. Bound here because the library's own `on_click`
      // only fires on a double-click.
      wrapper.addEventListener("click", () => openIssueDrawer(id, creds));
      // The library starts a drag on mousedown anywhere on a bar. Nothing is
      // saved, so a drag only moved the bar on screen — and a click with a
      // pixel of movement in it was swallowed as the end of one, for a second
      // afterwards. The roadmap is read-only; the drag is stopped here.
      wrapper.addEventListener("mousedown", (e) => e.stopPropagation());

      const bar = wrapper.querySelector(".bar");
      if (!bar) continue;
      if (display.titlesInside) drawTitleInside(wrapper, bar, task);

      if (task._isChild) continue;

      // A caret per epic bar, at its left edge, for the other action:
      // expanding its children. Inside the bar when the bar starts at the
      // chart's edge — on a zoomed range a clipped bar does — where outside
      // would be off the chart.
      const barX = parseFloat(bar.getAttribute("x"));
      const cx = barX >= 16 ? barX - 10 : barX + 9;
      const cy = parseFloat(bar.getAttribute("y")) + parseFloat(bar.getAttribute("height")) / 2;

      // Drawn, not typed. It was ▾ / ▸ — two glyphs of different weights, in a
      // font the chart does not otherwise use, swapping rather than turning.
      // svgIconPath because this lives among frappe-gantt's own elements, where
      // a nested <svg> is not what the chart's layout expects.
      const open = expandedEpics.has(id);
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("class", "gantt-caret");
      // A stroked chevron with no fill is hit only on its 2px of stroke, which
      // is most of why it felt unclickable. The square behind it is the target.
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hit.setAttribute("class", "gantt-caret-hit");
      hit.setAttribute("x", cx - 9);
      hit.setAttribute("y", cy - 9);
      hit.setAttribute("width", 18);
      hit.setAttribute("height", 18);
      hit.setAttribute("rx", 3);
      group.appendChild(hit);
      group.appendChild(svgIconPath("chevron", { x: cx, y: cy, size: 11, rotate: open ? 0 : -90 }));
      group.addEventListener("click", (e) => {
        // The bar's own handler opens the drawer; this one must not also fire.
        e.stopPropagation();
        toggleExpand(id);
      });
      wrapper.appendChild(group);
    }
    // A frame later: the library places its labels in a requestAnimationFrame
    // of its own, queued while the chart was drawn, and would otherwise put
    // them back over the top of these.
    requestAnimationFrame(() => makeTitlesSticky(svg, container));
  }

  // ── Presentation export ────────────────────────────────────────────────────

  // The chart as it is filtered and zoomed now, drawn again off screen at
  // slide width with presentation type (`.gantt-export` in css/gantt.css),
  // then rasterised to a PNG and downloaded. Just the chart: no toolbar, no
  // carets, no app chrome. A screenshot of the window could not give the
  // bigger type, and would crop a chart wider than the window.
  async function exportPresentation() {
    if (!tasks.length) return;
    const host = document.createElement("div");
    host.className = "gantt-chart-wrap gantt-export" + (display.titlesInside ? " titles-inside" : "");
    host.style.width = `${EXPORT_WIDTH}px`;
    document.body.appendChild(host);
    try {
      const target = document.createElement("div");
      host.appendChild(target);
      const Chart = roadmapGantt();
      // Copies, because the library writes its own fields onto the tasks it
      // is given and the live chart still holds these.
      const chart = new Chart(target, tasks.map((t) => ({ ...t })), {
        view_mode: currentMode,
        date_format: "YYYY-MM-DD",
        language: "en",
        range: currentRange(),
        fit_width: EXPORT_WIDTH,
        header_height: 80,
        padding: 20,
        bar_height: display.titlesInside ? insideBarHeight(EXPORT_TITLE_PX) : 32,
        popup_trigger: "none",
        on_date_change: () => {},
        on_progress_change: () => {},
      });
      // The library places its labels a frame after drawing them.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const svg = host.querySelector("svg");
      // Cropped to the grid: the library leaves a padding's worth of empty
      // chart under the last row, which on a slide is a band of nothing.
      const grid = svg.querySelector(".grid-background");
      const width = parseFloat(grid?.getAttribute("width")) || svg.getBoundingClientRect().width;
      const height = parseFloat(grid?.getAttribute("height")) || svg.getBoundingClientRect().height;
      svg.setAttribute("width", width);
      svg.setAttribute("height", height);
      drawTodayLine(chart, svg);
      markEdges(svg, false);
      if (display.titlesInside) drawExportTitles(svg);
      layoutLabels(svg);
      // A snapshot of the bars mid-way through growing in is not a roadmap.
      svg.querySelectorAll("animate").forEach((a) => a.remove());
      inlineComputedStyles(svg);

      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      // An SVG drawn as an image loads nothing from outside itself, so the
      // chart's typefaces go in with it or the slide is set in a fallback.
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = (await Promise.all(EXPORT_FONTS.map(async ([family, weight, url]) =>
        `@font-face { font-family: '${family}'; font-weight: ${weight};
          src: url(${await fontDataUrl(url)}) format('woff2'); }`))).join("\n");
      svg.insertBefore(style, svg.firstChild);

      const png = await rasterise(new XMLSerializer().serializeToString(svg), width, height);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(png);
      a.download = `roadmap-${todayIso()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } finally {
      host.remove();
    }
  }

  // Titles inside the bars as SVG text, centred and wrapped to TITLE_LINES
  // lines, in place of the live chart's HTML ones: a foreignObject in an
  // image drawn to a canvas taints the canvas, and a tainted canvas cannot be
  // saved.
  function drawExportTitles(svg) {
    const measure = (t) => textWidth(t, EXPORT_TITLE_PX);
    const lineHeight = EXPORT_TITLE_PX * 1.2;
    for (const wrapper of svg.querySelectorAll(".bar-wrapper")) {
      const task = tasks.find((t) => t.id === wrapper.getAttribute("data-id"));
      const bar = wrapper.querySelector(".bar");
      if (!task || !bar) continue;
      const x = parseFloat(bar.getAttribute("x"));
      const y = parseFloat(bar.getAttribute("y"));
      const w = parseFloat(bar.getAttribute("width"));
      const h = parseFloat(bar.getAttribute("height"));
      const lead = edgeRoom(wrapper, "lead") + 2;
      const room = w - lead - edgeRoom(wrapper, "tail") - 2;
      if (!titleFits(task._title, room, EXPORT_TITLE_PX)) continue;   // keeps its label beside the bar
      const lines = wrapTitle(task._title, room, measure);
      const centre = x + lead + room / 2;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("class", "gantt-bar-title-svg");
      text.setAttribute("x", centre);
      lines.forEach((line, i) => {
        const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        tspan.setAttribute("x", centre);
        tspan.setAttribute("y", y + h / 2 + (i - (lines.length - 1) / 2) * lineHeight);
        tspan.textContent = line;
        text.appendChild(tspan);
      });
      wrapper.querySelector(".bar-group")?.appendChild(text);
      wrapper.classList.add("title-inside");
    }
  }

  // Every element's computed paint and type, written onto it, because the
  // stylesheets — and the theme tokens they resolve — do not travel with an
  // SVG drawn as an image.
  const EXPORT_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
    "stroke-linejoin", "paint-order",
    "opacity", "display", "visibility", "rx", "ry", "shape-rendering",
    "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline",
  ];
  function inlineComputedStyles(svg) {
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      el.setAttribute("style",
        EXPORT_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
    }
  }

  const fontData = new Map();
  async function fontDataUrl(url) {
    if (fontData.has(url.href)) return fontData.get(url.href);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const data = `data:font/woff2;base64,${btoa(bin)}`;
    fontData.set(url.href, data);
    return data;
  }

  // The SVG onto a canvas at EXPORT_SCALE, on the chart's own background and
  // with a margin, so the PNG reads as a finished slide rather than a crop.
  async function rasterise(xml, width, height) {
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil((width + EXPORT_MARGIN * 2) * EXPORT_SCALE);
      canvas.height = Math.ceil((height + EXPORT_MARGIN * 2) * EXPORT_SCALE);
      const ctx = canvas.getContext("2d");
      ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
      ctx.fillStyle = getComputedStyle(chartWrap).backgroundColor || "#fff";
      ctx.fillRect(0, 0, width + EXPORT_MARGIN * 2, height + EXPORT_MARGIN * 2);
      ctx.drawImage(img, EXPORT_MARGIN, EXPORT_MARGIN, width, height);
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode PNG"))), "image/png"));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function rebuildAndRender() {
    saveFilters();
    // The axis is about to change, so today is somewhere else on it.
    scrolledToToday = false;
    rebuildTasks();
    renderGantt();
  }

  // ── Undated section ────────────────────────────────────────────────────────
  function renderUndated() {
    if (!undated.length) return;
    const section = document.createElement("div");
    section.className = "undated-epics";
    const header = document.createElement("div");
    header.className = "undated-epics-header";
    const arrow = icon("chevron", 11);
    arrow.classList.add("arrow", "icon-rot-90");
    header.appendChild(arrow);
    header.append(` Undated Epics (${undated.length})`);
    section.appendChild(header);
    const list = document.createElement("div");
    list.className = "undated-epics-list";
    list.style.display = "none";
    for (const epic of undated) {
      const row = document.createElement("div");
      row.className = "undated-epic-row";
      // Board identity as an inset rule rather than a 3px border, which is the
      // convention the backlog rows already use (`.bl-row td:first-child`).
      // Same signal, same width, and it stops the row's box from being a
      // different size to its neighbours.
      row.style.setProperty("--row-accent", boardColor(epic.boardId));
      const key = document.createElement("a");
      key.className = "issue-key mono";
      key.style.color = boardColor(epic.boardId);
      key.textContent = epic.key;
      attachIssueOpener(key, epic.key, creds);
      row.appendChild(key);
      const sum = document.createElement("span");
      sum.textContent = truncate(epic.fields?.summary, 60);
      row.appendChild(sum);
      list.appendChild(row);
    }
    section.appendChild(list);
    header.addEventListener("click", () => {
      const open = list.style.display !== "none";
      list.style.display = open ? "none" : "block";
      arrow.classList.toggle("open", !open);
    });
    wrap.appendChild(section);
  }

  // ── Initial render ─────────────────────────────────────────────────────────
  rebuildTasks();
  if (!dated.length) {
    chartWrap.innerHTML = '<div class="empty-state">No epics with dates found.</div>';
    updateInfo();
  } else {
    renderGantt();
  }
  renderUndated();
}
