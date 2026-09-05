import { getAllEpics, getEpicChildren } from "../api.js";
import { boardColor, getStartDate, BOARDS } from "../utils.js";
import { boardSlug } from "../config.js";
import { attachIssueOpener, openIssueDrawer } from "../components/issue-detail.js";

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

  const epicsByBoard = await getAllEpics(creds);
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
  let currentMode = "Month";
  let tfType  = "all";
  let tfStart = null;
  let tfEnd   = null;
  const hiddenEpicKeys  = new Set();
  const hiddenBoards    = new Set();
  const hiddenComponents = new Set();
  const hiddenLabels    = new Set();
  const expandedEpics   = new Set();
  const childCache      = {};

  // ── Dropdown helper ────────────────────────────────────────────────────────
  const allPanels = [];
  function closeAllPanels() { allPanels.forEach(p => { p.hidden = true; }); }
  document.addEventListener("click", closeAllPanels);

  function makeDropdown(baseLabel, extraClass = "") {
    const wrapEl = document.createElement("div");
    wrapEl.className = "gantt-dropdown-wrap";
    const btn = document.createElement("button");
    btn.className = "gantt-dropdown-btn";
    btn.textContent = baseLabel + " ▾";
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
      cb.checked = true;
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
      btn.textContent = hiddenSet.size === 0
        ? baseLabel + " ▾"
        : `${vis} / ${items.length} ▾`;
    }

    return { wrapEl, btn, syncBtn };
  }

  // separator helper
  function sep() {
    const s = document.createElement("div");
    s.className = "gantt-controls-sep";
    return s;
  }

  // ── View mode buttons ──────────────────────────────────────────────────────
  for (let i = 0; i < VIEW_MODES.length; i++) {
    const btn = document.createElement("button");
    btn.className = "gantt-mode-btn" + (VIEW_MODES[i] === currentMode ? " active" : "");
    btn.textContent = VIEW_MODE_LABELS[i];
    btn.dataset.mode = VIEW_MODES[i];
    btn.addEventListener("click", () => {
      currentMode = VIEW_MODES[i];
      controls.querySelectorAll(".gantt-mode-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.mode === currentMode));
      // A new zoom level is a new axis: today sits somewhere else on it, so
      // the chart re-centres rather than keeping a scroll offset that meant
      // something on the old one.
      scrolledToToday = false;
      renderGantt();
    });
    controls.appendChild(btn);
  }

  controls.appendChild(sep());

  // ── Timeframe picker ───────────────────────────────────────────────────────
  const { wrapEl: tfWrapEl, btn: tfBtn, panel: tfPanel } = makeDropdown("All time");
  controls.appendChild(tfWrapEl);

  const TF_OPTIONS = [
    { value: "all",      label: "All time" },
    { value: "year",     label: `This year (${new Date().getFullYear()})` },
    { value: "12months", label: "Next 12 months" },
    { value: "custom",   label: "Custom range" },
  ];
  const customRow = document.createElement("div");
  customRow.className = "tf-custom-row";
  customRow.hidden = true;

  for (const opt of TF_OPTIONS) {
    const lbl = document.createElement("label");
    lbl.className = "gantt-dropdown-option";
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "gantt-tf"; radio.value = opt.value;
    radio.checked = opt.value === "all";
    lbl.appendChild(radio);
    lbl.append(" " + opt.label);
    tfPanel.appendChild(lbl);
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      tfType = opt.value;
      customRow.hidden = opt.value !== "custom";
      if (opt.value !== "custom") {
        tfBtn.textContent = opt.label + " ▾";
        rebuildAndRender();
      }
    });
  }

  const startInput = document.createElement("input");
  startInput.type = "date"; startInput.className = "tf-date-input";
  const endInput = document.createElement("input");
  endInput.type = "date"; endInput.className = "tf-date-input";
  const applyBtn = document.createElement("button");
  applyBtn.className = "tf-apply-btn"; applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", () => {
    if (!startInput.value || !endInput.value) return;
    tfStart = startInput.value; tfEnd = endInput.value;
    tfBtn.textContent = `${tfStart} → ${tfEnd} ▾`;
    rebuildAndRender();
  });
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
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true;
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
      btn.textContent = hiddenEpicKeys.size === 0
        ? "All epics ▾"
        : `${vis} / ${dated.length} epics ▾`;
    }

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
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true;
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
      btn.textContent = hiddenBoards.size === 0
        ? "All boards ▾"
        : `${vis} / ${BOARDS.length} boards ▾`;
    }

    return { wrapEl };
  })();
  controls.appendChild(boardDropdown.wrapEl);

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

  // ── Filtering logic ────────────────────────────────────────────────────────
  function getTimeframeBounds() {
    if (tfType === "year") {
      const y = new Date().getFullYear();
      return [new Date(y, 0, 1), new Date(y, 11, 31, 23, 59, 59)];
    }
    if (tfType === "12months") {
      const s = new Date(), e = new Date();
      e.setFullYear(e.getFullYear() + 1);
      return [s, e];
    }
    if (tfType === "custom" && tfStart && tfEnd)
      return [new Date(tfStart), new Date(tfEnd + "T23:59:59")];
    return [null, null];
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
      // timeframe
      if (tfS && tfE) {
        const es = new Date(getStartDate(epic));
        const ee = new Date(epic.fields.duedate);
        if (es > tfE || ee < tfS) return false;
      }
      // epic
      if (hiddenEpicKeys.has(epic.key)) return false;
      return true;
    });
  }

  function updateInfo() {
    const vis = getVisibleDated();
    info.textContent = `${vis.length} of ${dated.length} dated · ${undated.length} undated`;
  }

  // ── Task builders ──────────────────────────────────────────────────────────
  function epicToTask(epic) {
    return {
      id: epic.key,
      name: truncate(`${epic.key} — ${epic.fields.summary || ""}`, 60),
      start: getStartDate(epic),
      end: epic.fields.duedate,
      progress: 0,
      // Two classes, two signals: delivery state fills the bar, board identity
      // outlines it. They answer different questions and a bar has room for
      // both.
      custom_class:
        `board-color-bar-${boardSlug(epic.boardId)} delivery-${deliveryState(epic)}`,
      _epic: epic,
      _isChild: false,
    };
  }

  function childToTask(child, parentKey) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      id: child.key,
      name: `  ${child.key} — ${truncate(child.fields.summary, 50)}`,
      start: getStartDate(child) || child.fields.created?.slice(0, 10) || today,
      end:   child.fields.duedate           || child.fields.updated?.slice(0, 10) || today,
      progress: child.fields.status?.name === "Done" ? 100 : 0,
      custom_class: "child-task",
      dependencies: parentKey,
      _isChild: true,
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
    tasks = [];
    for (const epic of visible) {
      tasks.push(epicToTask(epic));
      if (expandedEpics.has(epic.key) && childCache[epic.key])
        for (const child of childCache[epic.key])
          tasks.push(childToTask(child, epic.key));
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
      updateInfo();
      return;
    }
    if (typeof Gantt === "undefined") {
      chartWrap.innerHTML = '<div class="empty-state">frappe-gantt library not loaded.</div>';
      return;
    }
    const el = document.createElement("div");
    el.id = "gantt-target";
    chartWrap.appendChild(el);
    const chart = new Gantt("#gantt-target", tasks, {
      view_mode: currentMode,
      date_format: "YYYY-MM-DD",
      language: "en",
      custom_popup_html: task => `
        <div class="gantt-popup" style="padding:8px 12px;font-family:'Ubuntu Sans Mono',ui-monospace,monospace;font-size:12px;">
          <div style="color:#E8EAF0;margin-bottom:4px;">${task.name}</div>
          <div style="color:#6B7280;font-size:11px;">${task._isChild ? "Click for issue details" : "Click for epic details · caret to expand"}</div>
        </div>`,
      // Clicking a bar opens the issue, epic or child alike — the same drawer
      // the Kanban cards and the standup board open, over the same chart, so
      // the roadmap stops being the one view where clicking a thing shows you
      // nothing about it. Expanding an epic's children moved to the caret
      // added beside each bar in decorateChart(): it is a different action and
      // it was the only one available.
      on_click: task => openIssueDrawer(task.id, creds),
      on_date_change: () => {},
      on_progress_change: () => {},
    });
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

  function decorateChart(chart) {
    const svg = chartWrap.querySelector("svg");
    const container = chartWrap.querySelector(".gantt-container") || chartWrap;
    if (!svg) return;

    const x = todayX(chart);
    const width = parseFloat(svg.getAttribute("width")) || 0;
    // Only when today is actually on the chart. A roadmap filtered to last
    // quarter should not grow a line pinned to its left edge.
    if (x !== null && x >= 0 && (!width || x <= width)) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "gantt-today-line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", 0);
      line.setAttribute("y2", svg.getAttribute("height") || "100%");
      svg.appendChild(line);

      // Open on today rather than on the earliest start date. A roadmap is read
      // forwards from now; scrolled hard left it opens on whatever started
      // longest ago, which is the part nobody is asking about. Latched, so
      // expanding an epic does not drag the chart back mid-read.
      if (!scrolledToToday) {
        container.scrollLeft = Math.max(0, x - container.clientWidth / 2);
        scrolledToToday = true;
      }
    }

    // A caret per epic bar, at the left edge of the bar, because clicking the
    // bar itself now opens the drawer.
    for (const wrapper of svg.querySelectorAll(".bar-wrapper")) {
      const id = wrapper.getAttribute("data-id");
      const task = tasks.find((t) => t.id === id);
      if (!task || task._isChild) continue;
      const bar = wrapper.querySelector(".bar");
      if (!bar) continue;

      const caret = document.createElementNS("http://www.w3.org/2000/svg", "text");
      caret.setAttribute("class", "gantt-caret");
      caret.setAttribute("x", parseFloat(bar.getAttribute("x")) - 6);
      caret.setAttribute(
        "y",
        parseFloat(bar.getAttribute("y")) + parseFloat(bar.getAttribute("height")) / 2 + 4
      );
      caret.setAttribute("text-anchor", "end");
      caret.textContent = expandedEpics.has(id) ? "▾" : "▸";
      caret.addEventListener("click", (e) => {
        // The bar's own handler opens the drawer; this one must not also fire.
        e.stopPropagation();
        toggleExpand(id);
      });
      wrapper.appendChild(caret);
    }
  }

  function rebuildAndRender() {
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
    const arrow = document.createElement("span");
    arrow.className = "arrow"; arrow.textContent = "▶";
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
