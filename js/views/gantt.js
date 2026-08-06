import { getAllEpics, getEpicChildren } from "../api.js";
import { boardColor, getStartDate, BOARDS } from "../utils.js";
import { boardSlug } from "../config.js";
import { attachIssueOpener, openIssueDrawer } from "../components/issue-detail.js";

const VIEW_MODES      = ["Day", "Week", "Month", "Quarter Year"];
const VIEW_MODE_LABELS = ["Day", "Week", "Month", "Quarter"];

// Gantt bar colours are per-configured-board, so the rules are generated at
// mount time rather than written into gantt.css against fixed board names.
function injectBoardBarStyles() {
  const style = document.getElementById("gantt-board-bar-styles")
    || Object.assign(document.createElement("style"), { id: "gantt-board-bar-styles" });
  style.textContent = BOARDS.map((board) => {
    const cls = `board-color-bar-${boardSlug(board.id)}`;
    return `.${cls} .bar { fill: ${board.color}; opacity: 0.7; }\n` +
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
        nameSpan.textContent = (epic.fields?.summary || "").slice(0, 38);
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
      name: `${epic.key} — ${epic.fields.summary || ""}`.slice(0, 60),
      start: getStartDate(epic),
      end: epic.fields.duedate,
      progress: 0,
      custom_class: `board-color-bar-${boardSlug(epic.boardId)}`,
      _epic: epic,
      _isChild: false,
    };
  }

  function childToTask(child, parentKey) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      id: child.key,
      name: `  ${child.key} — ${(child.fields.summary || "").slice(0, 50)}`,
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
    new Gantt("#gantt-target", tasks, {
      view_mode: currentMode,
      date_format: "YYYY-MM-DD",
      language: "en",
      custom_popup_html: task => `
        <div class="gantt-popup" style="padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:12px;">
          <div style="color:#E8EAF0;margin-bottom:4px;">${task.name}</div>
          <div style="color:#6B7280;font-size:11px;">${task._isChild ? "Click for issue details" : "Click to expand children"}</div>
        </div>`,
      on_click: task => {
        if (task._isChild) openIssueDrawer(task.id, creds);
        else toggleExpand(task.id);
      },
      on_date_change: () => {},
      on_progress_change: () => {},
    });
    updateInfo();
  }

  function rebuildAndRender() { rebuildTasks(); renderGantt(); }

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
      row.style.borderLeft = `3px solid ${boardColor(epic.boardId)}`;
      row.style.paddingLeft = "10px";
      const key = document.createElement("a");
      key.className = "issue-key mono";
      key.style.color = boardColor(epic.boardId);
      key.textContent = epic.key;
      attachIssueOpener(key, epic.key, creds);
      row.appendChild(key);
      const sum = document.createElement("span");
      sum.textContent = (epic.fields?.summary || "").slice(0, 60);
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
