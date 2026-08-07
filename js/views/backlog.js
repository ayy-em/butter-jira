// Backlog: the spreadsheet view of everything open.
//
// Layout is header / toolbar / [filter sidebar | table] / pager. All the
// arithmetic — grouping, sorting, pagination, density, saved views, column
// visibility — lives in js/backlog.js so it can be tested without a browser;
// this file is the DOM.
//
// Filtering reuses `applyFilters` from the shared filter component rather than
// reimplementing it, so the sidebar and the other views' filter bar can never
// disagree about what a filter means. Only the chrome differs.

import {
  getAllBacklogIssues,
  getAllSprintIssues,
  getEpicNames,
} from "../api.js";
import {
  assigneeLabel,
  boardColor,
  boardName,
  debounce,
  fmtDate,
  getAvatarUrl,
  getEpicKey,
  getStoryPoints,
  hashColor,
  isOverdue,
  loadStatusGroups,
} from "../utils.js";
import { hasRoster, isOutsideTeam, isTeamOnly, setTeamOnly } from "../team.js";
import { attachIssueOpener } from "../components/issue-detail.js";
import { applyFilters, takePendingAssignees } from "../components/filters.js";
import {
  COLUMNS,
  DENSITIES,
  GROUPINGS,
  PAGE_SIZES,
  SORTS,
  groupIssues,
  loadPrefs,
  pageWindow,
  paginate,
  relativeTime,
  removeView,
  savePrefs,
  sortIssues,
  statusTone,
  summaryTiles,
  toggleColumn,
  upsertView,
} from "../backlog.js";

const TYPE_OPTIONS = ["Epic", "Story", "Task", "Bug", "Sub-task"];
const SP_MAX = 13;

// Green through amber to red. A 13-pointer should look like a warning.
function spTone(sp) {
  const t = Math.min(Math.max(sp, 0) / SP_MAX, 1);
  if (t <= 0.34) return "low";
  if (t <= 0.67) return "mid";
  return "high";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Inline SVG rather than an asset: two paths, no extra file to ship, and it
// inherits currentColor so it works in both themes without a second copy.
function icon(name, size = 16) {
  const paths = {
    backlog: "M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm1.5-4h15L21 7H3l1.5-4ZM9 12h6",
    search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35",
    chevron: "m6 9 6 6 6-6",
    columns: "M4 4h16v16H4zM10 4v16M16 4v16",
    check: "m5 13 4 4L19 7",
    inbox: "M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6l2-8Z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || "");
  svg.appendChild(path);
  return svg;
}

export async function mount(container, creds) {
  container.innerHTML = "";
  const wrap = el("div", "bl-wrap");
  container.appendChild(wrap);

  const prefs = await loadPrefs();
  const state = {
    ...prefs,
    page: 1,
    selected: new Set(),
    collapsed: new Set(),
    filters: {
      boards: [], types: [],
      // The command palette's "jump to this person" lands here, and this view
      // is its destination — so this is where the one-shot selection is
      // consumed. Not sticky: jumping to someone once must not filter the
      // backlog forever.
      assigneeIds: takePendingAssignees() || [],
      statuses: [],
      search: "", teamOnly: isTeamOnly(),
    },
  };

  // Skeleton first, so the layout is the layout from the first frame rather
  // than a spinner that gets replaced by something a different size.
  renderShell();
  paintSkeleton();

  const [backlog, sprint, epicNames, statusGroups] = await Promise.all([
    getAllBacklogIssues(creds),
    getAllSprintIssues(creds),
    getEpicNames(creds).catch(() => ({})),
    loadStatusGroups(),
  ]);

  const deduped = new Map();
  for (const issue of [...sprint, ...backlog]) {
    if (!deduped.has(issue.id)) deduped.set(issue.id, issue);
  }
  const allIssues = [...deduped.values()];

  const epicLabel = (issue) => {
    const key = getEpicKey(issue);
    if (!key) return "";
    return epicNames[key] || key;
  };
  const epicRef = (issue) => {
    const key = getEpicKey(issue);
    return key ? { key, label: epicNames[key] || key } : null;
  };

  const statuses = [...new Set(allIssues.map((i) => i.fields.status?.name).filter(Boolean))].sort();
  const assignees = collectAssignees(allIssues);
  const boards = [...new Set(allIssues.map((i) => i.boardId).filter((b) => b !== undefined))];

  // Done and Rejected are hidden on arrival — this is a backlog, not an archive
  // — but they stay available in the Status filter rather than being dropped.
  const doneish = statuses.filter((s) => /^(done|closed|resolved|rejected)$/i.test(s));
  state.filters.statuses = statuses.filter((s) => !doneish.includes(s));

  let visible = [];
  renderAll();

  // ── Shell ──────────────────────────────────────────────────────────────────

  function renderShell() {
    wrap.innerHTML = "";
    wrap.append(headerEl(), toolbarEl(), bodyEl(), pagerEl());
  }

  function headerEl() {
    const header = el("header", "bl-header");

    const left = el("div", "bl-header-left");
    const mark = el("span", "bl-header-icon");
    mark.appendChild(icon("backlog", 22));
    left.appendChild(mark);
    const titles = el("div");
    titles.append(
      el("h1", "bl-title", "Backlog"),
      el("p", "bl-subtitle", "All open issues across projects and boards")
    );
    left.appendChild(titles);
    header.appendChild(left);

    const tiles = el("div", "bl-tiles");
    tiles.id = "bl-tiles";
    header.appendChild(tiles);
    return header;
  }

  function toolbarEl() {
    const bar = el("div", "bl-toolbar");

    const density = el("div", "bl-segmented");
    for (const d of DENSITIES) {
      const btn = el("button", "bl-seg" + (state.density === d.id ? " on" : ""), d.label);
      btn.title = d.hint;
      btn.addEventListener("click", () => {
        state.density = d.id;
        persist();
        renderAll();
      });
      density.appendChild(btn);
    }
    bar.appendChild(density);

    const search = el("label", "bl-search");
    search.appendChild(icon("search", 15));
    const input = el("input", "bl-search-input");
    input.type = "search";
    input.id = "bl-search";
    input.placeholder = "Search issues...";
    input.value = state.filters.search;
    input.addEventListener("input", debounce(() => {
      state.filters.search = input.value.trim();
      state.page = 1;
      renderAll({ keepFocus: "bl-search" });
    }, 160));
    search.append(input, el("kbd", "bl-kbd", "/"));
    bar.appendChild(search);

    bar.appendChild(selectControl("Group", GROUPINGS, state.groupBy, (id) => {
      state.groupBy = id;
      state.page = 1;
      persist();
      renderAll();
    }));

    bar.appendChild(selectControl("Sort", SORTS, state.sortCol, (id) => {
      state.sortCol = id;
      persist();
      renderAll();
    }));

    const dir = el("button", "bl-icon-btn", state.sortDir === "asc" ? "↑" : "↓");
    dir.title = state.sortDir === "asc" ? "Ascending" : "Descending";
    dir.addEventListener("click", () => {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      persist();
      renderAll();
    });
    bar.appendChild(dir);

    const counts = el("span", "bl-counts");
    counts.id = "bl-counts";
    bar.appendChild(counts);

    const save = el("button", "bl-btn", "Save view");
    save.addEventListener("click", saveCurrentView);
    bar.appendChild(save);

    bar.appendChild(columnsMenu());
    return bar;
  }

  function selectControl(label, options, value, onChange) {
    const holder = el("label", "bl-select");
    holder.append(el("span", "bl-select-label", label));
    const select = el("select");
    for (const o of options) {
      const opt = el("option", null, o.label);
      opt.value = o.id;
      if (o.id === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    holder.appendChild(select);
    return holder;
  }

  // Column visibility. A <details> rather than a hand-rolled popover: it closes
  // on Escape and on outside click for free, and it is keyboard reachable.
  function columnsMenu() {
    const menu = el("details", "bl-menu");
    const summary = el("summary", "bl-icon-btn");
    summary.appendChild(icon("columns", 15));
    summary.title = "Columns";
    menu.appendChild(summary);

    const list = el("div", "bl-menu-body");
    list.append(el("div", "bl-menu-title", "Columns"));
    for (const column of COLUMNS.filter((c) => c.optional)) {
      const row = el("label", "bl-menu-row");
      const box = el("input");
      box.type = "checkbox";
      box.checked = state.columns.includes(column.id);
      box.addEventListener("change", () => {
        state.columns = toggleColumn(state.columns, column.id);
        persist();
        renderAll();
      });
      row.append(box, el("span", null, column.title || column.label));
      list.appendChild(row);
    }
    menu.appendChild(list);
    return menu;
  }

  function bodyEl() {
    const body = el("div", "bl-body" + (state.sidebarOpen ? "" : " collapsed"));
    body.id = "bl-body";

    const side = el("aside", "bl-sidebar");
    side.id = "bl-sidebar";
    body.appendChild(side);

    const main = el("div", "bl-main");
    const tableWrap = el("div", "bl-table-wrap");
    tableWrap.id = "bl-table-wrap";
    main.appendChild(tableWrap);
    body.appendChild(main);
    return body;
  }

  function pagerEl() {
    const pager = el("div", "bl-pager");
    pager.id = "bl-pager";
    return pager;
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  function renderSidebar() {
    const side = document.getElementById("bl-sidebar");
    side.innerHTML = "";

    const head = el("div", "bl-side-head");
    head.append(el("span", "bl-side-title", "Filters"));
    const clear = el("button", "bl-link", "Clear all");
    clear.addEventListener("click", () => {
      state.filters = {
        boards: [], types: [], assigneeIds: [], statuses: [],
        search: "", teamOnly: false,
      };
      setTeamOnly(false);
      state.page = 1;
      renderAll();
    });
    head.appendChild(clear);
    side.appendChild(head);

    if (hasRoster()) {
      const row = el("label", "bl-side-toggle");
      const box = el("input");
      box.type = "checkbox";
      box.checked = state.filters.teamOnly;
      box.addEventListener("change", async () => {
        state.filters.teamOnly = box.checked;
        await setTeamOnly(box.checked);
        state.page = 1;
        renderAll();
      });
      row.append(box, el("span", null, "Team only"));
      side.appendChild(row);
    }

    side.appendChild(filterGroup("Boards", boards.map((id) => ({
      value: id, label: boardName(id), color: boardColor(id),
    })), state.filters.boards, (next) => { state.filters.boards = next; }));

    side.appendChild(filterGroup("Issue type",
      TYPE_OPTIONS.filter((t) => allIssues.some((i) => i.fields.issuetype?.name === t))
        .map((t) => ({ value: t, label: t })),
      state.filters.types, (next) => { state.filters.types = next; }));

    side.appendChild(filterGroup("Status",
      statuses.map((s) => ({ value: s, label: s, tone: statusTone({ name: s }) })),
      state.filters.statuses, (next) => { state.filters.statuses = next; }));

    side.appendChild(filterGroup("Assignee",
      assignees.map((a) => ({ value: a.accountId, label: a.label, avatar: a.avatarUrl })),
      state.filters.assigneeIds, (next) => { state.filters.assigneeIds = next; },
      { searchable: true }));

    side.appendChild(savedViewsBlock());
    return side;
  }

  // Multi-select as a checkbox list inside a <details>: dropdowns that hold a
  // multi-selection have to invent a way to show "3 of 12", and a list just
  // shows it. Collapsed by default so the sidebar stays scannable.
  function filterGroup(label, options, selected, onChange, { searchable = false } = {}) {
    const group = el("details", "bl-filter");
    group.open = selected.length > 0 && selected.length < options.length;

    const summary = el("summary", "bl-filter-head");
    summary.append(el("span", null, label));
    const badge = el("span", "bl-filter-count");
    badge.textContent = selected.length && selected.length < options.length
      ? `${selected.length}` : "All";
    summary.appendChild(badge);
    group.appendChild(summary);

    const list = el("div", "bl-filter-body");

    if (searchable && options.length > 8) {
      const find = el("input", "bl-filter-search");
      find.type = "search";
      find.placeholder = `Find ${label.toLowerCase()}…`;
      find.addEventListener("input", () => {
        const q = find.value.toLowerCase();
        for (const row of list.querySelectorAll(".bl-opt")) {
          row.hidden = !row.dataset.label.toLowerCase().includes(q);
        }
      });
      list.appendChild(find);
    }

    for (const option of options) {
      const row = el("label", "bl-opt");
      row.dataset.label = option.label;
      const box = el("input");
      box.type = "checkbox";
      box.checked = selected.includes(option.value);
      box.addEventListener("change", () => {
        const next = box.checked
          ? [...selected, option.value]
          : selected.filter((v) => v !== option.value);
        onChange(next);
        state.page = 1;
        renderAll();
      });
      row.appendChild(box);
      if (option.color) {
        const dot = el("span", "bl-dot");
        dot.style.background = option.color;
        row.appendChild(dot);
      }
      if (option.avatar) {
        const img = el("img", "bl-opt-avatar");
        img.src = option.avatar;
        img.alt = "";
        img.addEventListener("error", () => img.remove());
        row.appendChild(img);
      }
      row.append(el("span", "bl-opt-label", option.label));
      list.appendChild(row);
    }

    group.appendChild(list);
    return group;
  }

  function savedViewsBlock() {
    const block = el("div", "bl-views");
    block.append(el("div", "bl-side-title", "Saved views"));
    if (!state.views.length) {
      block.appendChild(el("div", "bl-side-empty", "None yet — set up a filter and press Save view."));
      return block;
    }
    for (const view of state.views) {
      const row = el("div", "bl-view-row");
      const open = el("button", "bl-link", view.name);
      open.addEventListener("click", () => applyView(view));
      const drop = el("button", "bl-view-remove", "×");
      drop.title = `Delete "${view.name}"`;
      drop.addEventListener("click", () => {
        state.views = removeView(state.views, view.id);
        persist();
        renderAll();
      });
      row.append(open, drop);
      block.appendChild(row);
    }
    return block;
  }

  function applyView(view) {
    state.filters = { ...state.filters, ...view.filters };
    state.groupBy = view.groupBy;
    state.sortCol = view.sortCol;
    state.sortDir = view.sortDir;
    state.columns = view.columns;
    state.density = view.density;
    state.page = 1;
    renderAll();
  }

  function saveCurrentView() {
    const name = prompt("Name this view:");
    if (!name) return;
    state.views = upsertView(state.views, {
      name,
      filters: { ...state.filters },
      groupBy: state.groupBy,
      sortCol: state.sortCol,
      sortDir: state.sortDir,
      columns: state.columns,
      density: state.density,
    });
    persist();
    renderAll();
  }

  // ── Table ──────────────────────────────────────────────────────────────────

  function activeColumns() {
    return COLUMNS.filter((c) => state.columns.includes(c.id));
  }

  function paintSkeleton() {
    const target = document.getElementById("bl-table-wrap");
    if (!target) return;
    target.innerHTML = "";
    const skeleton = el("div", "bl-skeleton");
    for (let i = 0; i < 12; i++) skeleton.appendChild(el("div", "bl-skeleton-row"));
    target.appendChild(skeleton);
  }

  function renderAll({ keepFocus = null } = {}) {
    visible = applyFilters(allIssues, state.filters);

    renderShellState();
    renderSidebar();
    renderTiles();
    renderTable();
    renderPager();

    if (keepFocus) {
      const node = document.getElementById(keepFocus);
      if (node && document.activeElement !== node) {
        const end = node.value.length;
        node.focus();
        node.setSelectionRange?.(end, end);
      }
    }
  }

  function renderShellState() {
    wrap.dataset.density = state.density;
    const counts = document.getElementById("bl-counts");
    if (counts) {
      counts.innerHTML = "";
      counts.append(
        el("strong", null, String(allIssues.length)),
        el("span", null, " total"),
        el("span", "bl-counts-sep", "·"),
        el("strong", null, String(visible.length)),
        el("span", null, " visible")
      );
    }
  }

  function renderTiles() {
    const target = document.getElementById("bl-tiles");
    if (!target) return;
    target.innerHTML = "";
    for (const tile of summaryTiles(visible, statusGroups)) {
      const card = el("div", `bl-tile tone-${tile.tone}`);
      card.append(
        el("span", "bl-tile-dot"),
        el("span", "bl-tile-num", String(tile.count)),
        el("span", "bl-tile-label", tile.label)
      );
      target.appendChild(card);
    }
  }

  function renderTable() {
    const target = document.getElementById("bl-table-wrap");
    if (!target) return;
    target.innerHTML = "";

    if (!visible.length) {
      target.appendChild(emptyState());
      return;
    }

    const sorted = sortIssues(visible, state.sortCol, state.sortDir, { epicLabel });
    const grouped = state.groupBy !== "none";
    // Pagination only when ungrouped: a group split across a page boundary
    // reads as missing data, and the whole point of grouping is seeing a group.
    const paged = grouped ? null : paginate(sorted, state.page, state.perPage);
    const rows = grouped ? sorted : paged.slice;
    if (paged) state.page = paged.page;

    const table = el("table", "bl-table");
    table.appendChild(headRow());

    if (grouped) {
      for (const group of groupIssues(rows, state.groupBy, { epicLabel })) {
        table.appendChild(groupBody(group));
      }
    } else {
      const tbody = el("tbody");
      for (const issue of rows) tbody.appendChild(issueRow(issue));
      table.appendChild(tbody);
    }
    target.appendChild(table);
  }

  function headRow() {
    const thead = el("thead");
    const tr = el("tr");
    for (const column of activeColumns()) {
      const th = el("th", `bl-col-${column.id}`);
      if (column.id === "select") {
        const box = el("input", "bl-check");
        box.type = "checkbox";
        box.title = "Select all on this page";
        const pageIds = currentPageIds();
        box.checked = pageIds.length > 0 && pageIds.every((id) => state.selected.has(id));
        box.indeterminate = !box.checked && pageIds.some((id) => state.selected.has(id));
        box.addEventListener("change", () => {
          for (const id of pageIds) {
            if (box.checked) state.selected.add(id);
            else state.selected.delete(id);
          }
          renderTable();
          renderPager();
        });
        th.appendChild(box);
      } else {
        th.textContent = column.label;
        if (column.title) th.title = column.title;
        th.classList.add("sortable");
        if (state.sortCol === column.id) {
          th.appendChild(el("span", "bl-sort", state.sortDir === "asc" ? "▲" : "▼"));
        }
        th.addEventListener("click", () => {
          if (state.sortCol === column.id) {
            state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          } else {
            state.sortCol = column.id;
            state.sortDir = "asc";
          }
          persist();
          renderAll();
        });
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function currentPageIds() {
    if (state.groupBy !== "none") return visible.map((i) => i.id);
    const sorted = sortIssues(visible, state.sortCol, state.sortDir, { epicLabel });
    return paginate(sorted, state.page, state.perPage).slice.map((i) => i.id);
  }

  function groupBody(group) {
    const tbody = el("tbody", "bl-group");
    const headTr = el("tr", "bl-group-row");
    const th = el("th", "bl-group-head");
    th.colSpan = activeColumns().length;
    const collapsed = state.collapsed.has(group.key);
    const toggle = el("button", "bl-group-toggle");
    toggle.append(
      el("span", "bl-group-caret" + (collapsed ? " closed" : "")),
      el("span", "bl-group-label", group.label),
      el("span", "bl-group-count", String(group.issues.length))
    );
    toggle.addEventListener("click", () => {
      if (collapsed) state.collapsed.delete(group.key);
      else state.collapsed.add(group.key);
      renderTable();
    });
    th.appendChild(toggle);
    headTr.appendChild(th);
    tbody.appendChild(headTr);

    if (!collapsed) {
      for (const issue of group.issues) tbody.appendChild(issueRow(issue));
    }
    return tbody;
  }

  function issueRow(issue) {
    const f = issue.fields || {};
    const tr = el("tr", "bl-row");
    // Board identity moved from a badge to this bar (task item 9): colour in
    // the margin scans without spending a column on it.
    tr.style.setProperty("--row-accent", boardColor(issue.boardId) || hashColor(issue.key));
    if (state.selected.has(issue.id)) tr.classList.add("selected");

    for (const column of activeColumns()) {
      tr.appendChild(cellFor(column.id, issue, f));
    }
    return tr;
  }

  function cellFor(id, issue, f) {
    const td = el("td", `bl-col-${id}`);
    switch (id) {
      case "select": {
        const box = el("input", "bl-check");
        box.type = "checkbox";
        box.checked = state.selected.has(issue.id);
        box.addEventListener("change", () => {
          if (box.checked) state.selected.add(issue.id);
          else state.selected.delete(issue.id);
          box.closest("tr")?.classList.toggle("selected", box.checked);
          renderPager();
        });
        box.addEventListener("click", (e) => e.stopPropagation());
        td.appendChild(box);
        break;
      }
      case "key": {
        const link = el("a", "bl-key");
        link.style.color = boardColor(issue.boardId);
        link.textContent = issue.key;
        attachIssueOpener(link, issue.key, creds);
        td.appendChild(link);
        break;
      }
      case "summary": {
        // Clickable, same as the key (task item 21) — the summary is the bigger
        // target and the one people reach for.
        const link = el("a", "bl-summary");
        link.textContent = f.summary || "";
        link.title = f.summary || "";
        attachIssueOpener(link, issue.key, creds);
        td.appendChild(link);
        break;
      }
      case "type": {
        const name = f.issuetype?.name || "";
        const chip = el("span", "bl-type", name);
        chip.title = name;
        td.appendChild(name ? chip : dash());
        break;
      }
      case "epic": {
        const epic = epicRef(issue);
        if (!epic) { td.appendChild(dash()); break; }
        const link = el("a", "bl-epic", epic.label);
        link.title = epic.label === epic.key ? epic.key : `${epic.label} · ${epic.key}`;
        attachIssueOpener(link, epic.key, creds);
        td.appendChild(link);
        break;
      }
      case "status": {
        const name = f.status?.name || "Unknown";
        td.appendChild(el("span", `bl-status tone-${statusTone(f.status)}`, name));
        break;
      }
      case "assignee": {
        if (!f.assignee) { td.appendChild(dash()); break; }
        const cell = el("span", "bl-assignee");
        const url = getAvatarUrl(issue);
        const label = assigneeLabel(f.assignee);
        if (url) {
          const img = el("img", "bl-avatar");
          img.src = url;
          img.alt = "";
          img.addEventListener("error", () => img.replaceWith(initials(label)));
          cell.appendChild(img);
        } else {
          cell.appendChild(initials(label));
        }
        cell.appendChild(el("span", "bl-assignee-name", label));
        cell.title = hasRoster() && isOutsideTeam(issue) ? `${label} · outside team` : label;
        td.appendChild(cell);
        break;
      }
      case "sp": {
        const sp = getStoryPoints(issue);
        if (sp === null) { td.appendChild(dash()); break; }
        td.appendChild(el("span", `bl-sp tone-${spTone(sp)}`, String(sp)));
        break;
      }
      case "due": {
        if (!f.duedate) { td.appendChild(dash()); break; }
        const due = el("span", "bl-due", fmtDate(f.duedate));
        if (isOverdue(issue)) due.classList.add("overdue");
        due.title = f.duedate;
        td.appendChild(due);
        break;
      }
      case "updated": {
        const rel = relativeTime(f.updated);
        if (!rel) { td.appendChild(dash()); break; }
        const node = el("span", "bl-updated", rel);
        node.title = f.updated;
        td.appendChild(node);
        break;
      }
      case "board": {
        const chip = el("span", "bl-board", boardName(issue.boardId));
        chip.style.color = boardColor(issue.boardId);
        td.appendChild(chip);
        break;
      }
      default:
        break;
    }
    return td;
  }

  function dash() {
    return el("span", "bl-dash", "—");
  }

  function initials(label) {
    const span = el("span", "bl-avatar bl-avatar-fallback");
    span.style.background = hashColor(label);
    span.textContent = (label.replace(/[^\p{L}\p{N}]/gu, "")[0] || "?").toUpperCase();
    return span;
  }

  function emptyState() {
    const box = el("div", "bl-empty");
    const mark = el("div", "bl-empty-icon");
    mark.appendChild(icon("inbox", 40));
    box.append(mark, el("p", "bl-empty-text", "No issues match these filters."));
    const clear = el("button", "bl-btn primary", "Clear filters");
    clear.addEventListener("click", () => {
      state.filters = {
        boards: [], types: [], assigneeIds: [], statuses: [],
        search: "", teamOnly: false,
      };
      setTeamOnly(false);
      state.page = 1;
      renderAll();
    });
    box.appendChild(clear);
    return box;
  }

  // ── Pager ──────────────────────────────────────────────────────────────────

  function renderPager() {
    const bar = document.getElementById("bl-pager");
    if (!bar) return;
    bar.innerHTML = "";

    if (state.selected.size) {
      bar.appendChild(el("span", "bl-selected",
        `${state.selected.size} selected`));
    }

    if (state.groupBy !== "none") {
      bar.appendChild(el("span", "bl-pager-note",
        `${visible.length} issues in ${groupIssues(visible, state.groupBy, { epicLabel }).length} groups · grouped views are not paginated`));
      return;
    }

    const sorted = sortIssues(visible, state.sortCol, state.sortDir, { epicLabel });
    const page = paginate(sorted, state.page, state.perPage);

    bar.appendChild(el("span", "bl-pager-note",
      page.total ? `${page.from}–${page.to} of ${page.total} issues` : "No issues"));

    if (page.totalPages > 1) {
      const nav = el("nav", "bl-pages");
      nav.appendChild(pageBtn("‹", page.page - 1, page.page === 1));
      for (const entry of pageWindow(page.page, page.totalPages)) {
        if (entry === "…") { nav.appendChild(el("span", "bl-page-gap", "…")); continue; }
        const btn = pageBtn(String(entry), entry, false);
        if (entry === page.page) btn.classList.add("on");
        nav.appendChild(btn);
      }
      nav.appendChild(pageBtn("›", page.page + 1, page.page === page.totalPages));
      bar.appendChild(nav);
    }

    const size = el("label", "bl-perpage");
    size.append(el("span", null, "Show"));
    const select = el("select");
    for (const n of PAGE_SIZES) {
      const opt = el("option", null, String(n));
      opt.value = String(n);
      if (n === state.perPage) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      state.perPage = Number(select.value);
      state.page = 1;
      persist();
      renderAll();
    });
    size.append(select, el("span", null, "per page"));
    bar.appendChild(size);
  }

  function pageBtn(label, target, disabled) {
    const btn = el("button", "bl-page", label);
    btn.disabled = disabled;
    btn.addEventListener("click", () => {
      state.page = target;
      renderTable();
      renderPager();
      document.getElementById("bl-table-wrap")?.scrollTo({ top: 0 });
    });
    return btn;
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  function collectAssignees(issues) {
    const map = new Map();
    for (const issue of issues) {
      const a = issue.fields.assignee;
      if (!a?.accountId || map.has(a.accountId)) continue;
      map.set(a.accountId, {
        accountId: a.accountId,
        label: assigneeLabel(a),
        avatarUrl: getAvatarUrl(issue),
      });
    }
    return [...map.values()].sort((x, y) => x.label.localeCompare(y.label));
  }

  function persist() {
    savePrefs({
      density: state.density,
      groupBy: state.groupBy,
      sortCol: state.sortCol,
      sortDir: state.sortDir,
      columns: state.columns,
      perPage: state.perPage,
      sidebarOpen: state.sidebarOpen,
      views: state.views,
    }).catch(() => {});
  }

  // "/" focuses search, the way every list app worth using does. Guarded so it
  // does not steal the key from a field someone is already typing in.
  function onKeydown(e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    e.preventDefault();
    document.getElementById("bl-search")?.focus();
  }
  document.addEventListener("keydown", onKeydown);

  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      document.removeEventListener("keydown", onKeydown);
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });
}
