import { syncGet, syncSet } from "../browser.js";
import { getAllSprintIssues, getAllBacklogIssues } from "../api.js";
import {
  extractAssignees,
  BOARDS,
  isOverdue,
  loadStatusGroups,
  saveStatusGroups,
  statusesInIssues,
  validateStatusGroups,
} from "../utils.js";
import { makePlaceholder, renderColumns } from "../components/board.js";
import { icon } from "../components/icons.js";
import { viewHeader, viewTiles } from "../components/view-header.js";
import { createIssueMover } from "../issue-move.js";

async function loadColumnOrder() {
  const result = await syncGet("kanbanColumnOrder");
  return result.kanbanColumnOrder || null;
}

async function saveColumnOrder(order) {
  await syncSet({ kanbanColumnOrder: order });
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  const [sprintIssues, statusGroups, savedColumnOrder] = await Promise.all([
    getAllSprintIssues(creds),
    loadStatusGroups(),
    loadColumnOrder(),
  ]);
  let backlogIssues = null;
  let currentSprintOnly = true;
  let selectedPerson = null;
  let activeBoards = new Set(BOARDS.map((b) => b.id));
  let groups = statusGroups;
  let showGroupEditor = false;

  function getAllIssues() {
    let base = currentSprintOnly ? [...sprintIssues] : (() => {
      if (!backlogIssues) return [...sprintIssues];
      const map = new Map();
      for (const i of sprintIssues) map.set(i.id, i);
      for (const i of backlogIssues) if (!map.has(i.id)) map.set(i.id, i);
      return [...map.values()];
    })();
    return base.filter((i) => activeBoards.has(i.boardId));
  }

  function getFiltered() {
    let issues = getAllIssues();
    if (selectedPerson) {
      issues = issues.filter(
        (i) => i.fields.assignee?.accountId === selectedPerson
      );
    }
    return issues;
  }

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "kanban-wrap";

  // This screen used to open straight onto its controls. Every other view says
  // what it is first — see js/components/view-header.js.
  const header = viewHeader({
    iconName: "columns",
    title: "Board",
    subtitle: "Where every issue in the sprint stands right now",
  });
  const headerTiles = document.createElement("div");
  header.appendChild(headerTiles);
  wrap.appendChild(header);

  const controls = document.createElement("div");
  controls.className = "kanban-controls";

  const boardSelector = document.createElement("div");
  boardSelector.className = "person-selector";
  controls.appendChild(boardSelector);

  const selectorSep = document.createElement("div");
  selectorSep.style.cssText = "width:1px;height:20px;background:var(--border);margin:0 8px;flex-shrink:0;";
  controls.appendChild(selectorSep);

  const personSelector = document.createElement("div");
  personSelector.className = "person-selector";
  controls.appendChild(personSelector);

  const rightControls = document.createElement("div");
  rightControls.style.cssText = "display:flex;align-items:center;gap:8px;margin-left:auto;";

  // The keyboard path exists (js/components/board.js) and would otherwise be
  // undiscoverable — a shortcut nobody knows about is not a path.
  const keyHint = document.createElement("div");
  keyHint.className = "kanban-keys mono";
  // Two facts, not four. Enter-to-open is what a focusable card is expected to
  // do anyway, and a hint long enough to wrap the controls onto a second row
  // costs more than the third fact is worth.
  keyHint.innerHTML = "<kbd>↑↓←→</kbd> move · <kbd>shift</kbd>+<kbd>←→</kbd> status";
  rightControls.appendChild(keyHint);

  const groupBtn = document.createElement("button");
  groupBtn.className = "kanban-group-btn mono";
  groupBtn.textContent = "Columns";
  groupBtn.title = "Configure status grouping";
  groupBtn.addEventListener("click", () => {
    if (showGroupEditor) closeGroupEditor();
    else openGroupEditor();
    renderAll();
    if (showGroupEditor) editorContainer.querySelector(".kge-name")?.focus();
  });
  rightControls.appendChild(groupBtn);

  const sprintToggle = document.createElement("div");
  sprintToggle.className = "sprint-toggle";
  const btnCurrent = document.createElement("button");
  btnCurrent.textContent = "Current Sprint";
  btnCurrent.className = "active";
  const btnAll = document.createElement("button");
  btnAll.textContent = "All";
  sprintToggle.appendChild(btnCurrent);
  sprintToggle.appendChild(btnAll);
  rightControls.appendChild(sprintToggle);

  controls.appendChild(rightControls);
  wrap.appendChild(controls);

  const editorContainer = document.createElement("div");
  editorContainer.id = "kanban-group-editor";
  wrap.appendChild(editorContainer);

  const board = document.createElement("div");
  board.className = "kanban-board";
  wrap.appendChild(board);

  container.appendChild(wrap);

  btnCurrent.addEventListener("click", async () => {
    currentSprintOnly = true;
    btnCurrent.classList.add("active");
    btnAll.classList.remove("active");
    renderAll();
  });

  btnAll.addEventListener("click", async () => {
    currentSprintOnly = false;
    btnAll.classList.add("active");
    btnCurrent.classList.remove("active");
    if (!backlogIssues) {
      board.innerHTML = '<div class="spinner" style="height:200px"></div>';
      backlogIssues = await getAllBacklogIssues(creds);
    }
    renderAll();
  });

  function renderBoardSelector() {
    boardSelector.innerHTML = "";
    for (const b of BOARDS) {
      const pill = document.createElement("button");
      pill.className = "person-pill" + (activeBoards.has(b.id) ? " active" : "");
      pill.style.borderColor = activeBoards.has(b.id) ? b.color : "";
      pill.style.color = activeBoards.has(b.id) ? b.color : "";
      const dot = document.createElement("span");
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${b.color};flex-shrink:0;`;
      pill.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = b.name;
      pill.appendChild(label);
      pill.addEventListener("click", () => {
        if (activeBoards.has(b.id)) {
          if (activeBoards.size > 1) activeBoards.delete(b.id);
        } else {
          activeBoards.add(b.id);
        }
        renderAll();
      });
      boardSelector.appendChild(pill);
    }
  }

  function renderPersonSelector() {
    personSelector.innerHTML = "";
    const issues = getAllIssues();
    const assignees = extractAssignees(issues);

    for (const a of assignees) {
      const pill = document.createElement("button");
      pill.className =
        "person-pill" + (selectedPerson === a.accountId ? " active" : "");
      if (a.avatarUrl) {
        const img = document.createElement("img");
        img.className = "avatar";
        img.src = a.avatarUrl;
        img.onerror = () => {
          const ph = makePlaceholder(a.displayName);
          img.replaceWith(ph);
        };
        pill.appendChild(img);
      } else {
        pill.appendChild(makePlaceholder(a.displayName));
      }
      const name = document.createElement("span");
      name.textContent = a.displayName;
      pill.appendChild(name);
      pill.addEventListener("click", () => {
        selectedPerson =
          selectedPerson === a.accountId ? null : a.accountId;
        renderAll();
      });
      personSelector.appendChild(pill);
    }
  }

  // ── The column editor ──────────────────────────────────────────────────────
  //
  // Configuring columns used to mean typing raw Jira status strings from
  // memory, comma-separated, into a bare input — and it is the first thing
  // anyone who clones this app has to do, because their statuses are not the
  // four it ships with. Everything the app needs to do better is already in
  // hand: it has fetched every status on every configured board by the time
  // this panel can be opened. So the statuses are what you click, and typing
  // one is the escape hatch for a status that exists in the workflow but is not
  // on any current issue.
  //
  // Edits go into `draft`, not into `groups`. The old panel mutated the live
  // groups on every keystroke, so closing it without saving left the board
  // grouped by a half-typed column name until the next reload.
  let draft = null;
  let selectedRow = 0;
  let editorProblems = [];

  function openGroupEditor() {
    draft = groups.map((g) => ({ name: g.name, statuses: [...g.statuses] }));
    if (!draft.length) draft.push({ name: "", statuses: [] });
    selectedRow = 0;
    editorProblems = [];
    showGroupEditor = true;
  }

  function closeGroupEditor() {
    draft = null;
    editorProblems = [];
    showGroupEditor = false;
  }

  // Every status the app has actually seen this session, plus every status the
  // draft mentions — a status can be real, configured and not currently held by
  // any issue, and dropping it off the shelf the moment its last issue moves
  // would be its own kind of surprise.
  function knownStatuses() {
    const seen = statusesInIssues([...sprintIssues, ...(backlogIssues || [])]);
    const byKey = new Map(seen.map((s) => [s.name.toLowerCase(), s]));
    for (const group of draft || []) {
      for (const status of group.statuses) {
        const key = status.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { name: status, count: 0 });
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const columnHolding = (status) =>
    (draft || []).find((g) =>
      g.statuses.some((s) => s.toLowerCase() === status.toLowerCase())
    ) || null;

  // Put a status in one column and only that column. Moving rather than copying
  // is deliberate: resolveStatusGroup takes the first match, so a status in two
  // columns quietly belongs to whichever is higher up, and the click that looks
  // like "put it here" would do nothing visible.
  function assignStatus(status, rowIndex) {
    const name = status.trim();
    if (!name) return;
    for (const group of draft) {
      group.statuses = group.statuses.filter((s) => s.toLowerCase() !== name.toLowerCase());
    }
    draft[rowIndex].statuses.push(name);
  }

  function renderGroupEditor() {
    editorContainer.innerHTML = "";
    if (!showGroupEditor || !draft) return;

    const editor = document.createElement("div");
    editor.className = "kanban-group-editor-panel";

    const title = document.createElement("div");
    title.className = "kge-title mono";
    title.textContent = "Status column grouping";
    editor.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "kge-desc";
    desc.textContent =
      "Each column collects the issues in the statuses you give it. Pick statuses from your boards below, or type one Jira has that no current issue is in.";
    editor.appendChild(desc);

    const known = knownStatuses();
    // How many issues are actually in each status. Not the same question as
    // "is this status known": a status the draft mentions is known *because*
    // the draft mentions it, including one just typed by hand, so keying the
    // dashed token off membership would mark nothing.
    const inUse = new Map(known.map((s) => [s.name.toLowerCase(), s.count]));

    const rows = document.createElement("div");
    rows.className = "kge-rows";
    draft.forEach((group, i) => rows.appendChild(renderRow(group, i, known, inUse)));
    editor.appendChild(rows);

    editor.appendChild(renderPalette(known));

    const error = document.createElement("div");
    error.className = "kge-error";
    error.setAttribute("role", "alert");
    // One line, the first problem, in the order the rows are in — a list of
    // five is a wall, and the rows themselves are already marked.
    error.textContent = editorProblems.length ? editorProblems[0].message : "";
    editor.appendChild(error);

    const actions = document.createElement("div");
    actions.className = "kge-actions";

    const addBtn = document.createElement("button");
    addBtn.className = "kanban-group-btn mono";
    addBtn.textContent = "+ Add column";
    addBtn.addEventListener("click", () => {
      draft.push({ name: "", statuses: [] });
      selectedRow = draft.length - 1;
      renderGroupEditor();
      editorContainer.querySelectorAll(".kge-name")[selectedRow]?.focus();
    });
    actions.appendChild(addBtn);

    const spacer = document.createElement("div");
    spacer.className = "kge-spacer";
    actions.appendChild(spacer);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-group-btn mono";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      closeGroupEditor();
      renderAll();
    });
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "kanban-group-btn kge-save mono";
    saveBtn.textContent = "Save & Apply";
    saveBtn.addEventListener("click", async () => {
      const result = validateStatusGroups(draft);
      editorProblems = result.problems;
      if (!result.ok) {
        renderGroupEditor();
        return;
      }
      groups = result.groups;
      await saveStatusGroups(result.groups);
      closeGroupEditor();
      renderAll();
    });
    actions.appendChild(saveBtn);

    editor.appendChild(actions);
    editorContainer.appendChild(editor);
  }

  function renderRow(group, i, known, inUse) {
    const row = document.createElement("div");
    row.className = "kge-row";
    if (i === selectedRow) row.classList.add("selected");
    if (editorProblems.some((p) => p.index === i)) row.classList.add("invalid");
    // Anywhere in the row, including the inputs, so that tabbing through the
    // rows keeps the shelf pointed at the row you are in.
    row.addEventListener("focusin", () => selectRow(i));
    row.addEventListener("mousedown", () => selectRow(i));

    const nameInput = document.createElement("input");
    nameInput.className = "setup-input kge-name mono";
    nameInput.value = group.name;
    nameInput.placeholder = "Column name";
    nameInput.setAttribute("aria-label", `Name of column ${i + 1}`);
    nameInput.addEventListener("input", () => { group.name = nameInput.value; });
    row.appendChild(nameInput);

    row.appendChild(renderTokenField(group, i, known, inUse));

    const removeBtn = document.createElement("button");
    removeBtn.className = "kge-remove icon-btn";
    removeBtn.appendChild(icon("close", 14));
    removeBtn.title = `Remove ${group.name || "this column"}`;
    removeBtn.setAttribute("aria-label", `Remove column ${group.name || i + 1}`);
    removeBtn.addEventListener("click", () => {
      draft.splice(i, 1);
      if (!draft.length) draft.push({ name: "", statuses: [] });
      selectedRow = Math.min(selectedRow, draft.length - 1);
      editorProblems = [];
      renderGroupEditor();
    });
    row.appendChild(removeBtn);
    return row;
  }

  function selectRow(i) {
    if (selectedRow === i) return;
    selectedRow = i;
    // Only the two things that depend on it, so that repainting the shelf does
    // not take the caret out of the input the click just landed in.
    editorContainer.querySelectorAll(".kge-row").forEach((el, idx) => {
      el.classList.toggle("selected", idx === i);
    });
    renderPaletteInto(editorContainer.querySelector(".kge-palette"), knownStatuses());
  }

  function renderTokenField(group, i, known, inUse) {
    const field = document.createElement("div");
    field.className = "kge-tokens";

    for (const status of group.statuses) {
      const token = document.createElement("span");
      token.className = "kge-token";
      if (!inUse.get(status.toLowerCase())) {
        token.classList.add("unseen");
        token.title = "No issue on your boards is in this status right now";
      }
      const label = document.createElement("span");
      label.textContent = status;
      token.appendChild(label);
      const x = document.createElement("button");
      x.className = "kge-token-x icon-btn";
      x.appendChild(icon("close", 10));
      x.setAttribute("aria-label", `Remove ${status} from ${group.name || "this column"}`);
      x.addEventListener("click", () => {
        group.statuses = group.statuses.filter((s) => s !== status);
        renderGroupEditor();
      });
      token.appendChild(x);
      field.appendChild(token);
    }

    const input = document.createElement("input");
    input.className = "kge-token-input mono";
    input.placeholder = group.statuses.length ? "Add a status" : "Pick or type a status";
    input.setAttribute("aria-label", `Statuses in column ${group.name || i + 1}`);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    field.appendChild(input);

    // Clicking the padding of the box types at the end, the way every tag input
    // anyone has used behaves.
    field.addEventListener("mousedown", (e) => {
      if (e.target === field) { e.preventDefault(); input.focus(); }
    });

    const menu = document.createElement("div");
    menu.className = "kge-suggest";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    field.appendChild(menu);

    let active = -1;

    const matches = () => {
      const query = input.value.trim().toLowerCase();
      const mine = new Set(group.statuses.map((s) => s.toLowerCase()));
      return known
        .filter((s) => !mine.has(s.name.toLowerCase()))
        .filter((s) => !query || s.name.toLowerCase().includes(query))
        .slice(0, 12);
    };

    function closeMenu() {
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      active = -1;
    }

    function openMenu() {
      const items = matches();
      menu.innerHTML = "";
      if (!items.length) return closeMenu();
      items.forEach((status, idx) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "kge-suggest-item" + (idx === active ? " active" : "");
        item.setAttribute("role", "option");
        const label = document.createElement("span");
        label.textContent = status.name;
        item.appendChild(label);
        const note = document.createElement("span");
        note.className = "kge-suggest-note";
        const holder = columnHolding(status.name);
        note.textContent = holder
          ? `in ${holder.name || "an unnamed column"}`
          : status.count
            ? `${status.count} issue${status.count === 1 ? "" : "s"}`
            : "not in use";
        item.appendChild(note);
        // mousedown, not click: the input's blur would close the menu first.
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          commit(status.name);
        });
        menu.appendChild(item);
      });
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function commit(status) {
      assignStatus(status, i);
      editorProblems = [];
      renderGroupEditor();
      // Back to the same field, so several statuses can go in without reaching
      // for the mouse between each.
      const fields = editorContainer.querySelectorAll(".kge-token-input");
      fields[i]?.focus();
    }

    input.addEventListener("input", () => { active = -1; openMenu(); });
    input.addEventListener("focus", openMenu);
    input.addEventListener("blur", () => setTimeout(closeMenu, 0));
    input.addEventListener("keydown", (e) => {
      const items = matches();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        active = e.key === "ArrowDown"
          ? Math.min(active + 1, items.length - 1)
          : Math.max(active - 1, 0);
        openMenu();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // The highlighted suggestion if there is one, otherwise whatever was
        // typed — a status that exists in the workflow but is not on any issue
        // right now has to be reachable, and the shelf cannot know about it.
        const chosen = active >= 0 && items[active] ? items[active].name : input.value.trim();
        if (chosen) commit(chosen);
        return;
      }
      if (e.key === "Escape" && !menu.hidden) {
        // Consumed, so a stray Escape closes the completion rather than
        // whatever else on the page is listening for one.
        e.stopPropagation();
        closeMenu();
        return;
      }
      if (e.key === "Backspace" && !input.value && group.statuses.length) {
        e.preventDefault();
        group.statuses.pop();
        renderGroupEditor();
        editorContainer.querySelectorAll(".kge-token-input")[i]?.focus();
      }
    });

    return field;
  }

  function renderPalette(known) {
    const palette = document.createElement("div");
    palette.className = "kge-palette";
    renderPaletteInto(palette, known);
    return palette;
  }

  function renderPaletteInto(palette, known) {
    if (!palette) return;
    palette.innerHTML = "";
    const unmapped = known.filter((s) => !columnHolding(s.name));
    const target = draft[selectedRow];

    const label = document.createElement("div");
    label.className = "kge-palette-label";
    label.append("Statuses on your boards — click to put one in ");
    const strong = document.createElement("b");
    strong.textContent = target?.name?.trim() || `column ${selectedRow + 1}`;
    label.appendChild(strong);
    if (unmapped.length) {
      const warn = document.createElement("span");
      warn.className = "kge-palette-warn";
      // Not "will disappear": groupIssues gives an unclaimed status a column of
      // its own on the end, which is the forgiving behaviour and also the one
      // that produces eleven columns on somebody's first run.
      warn.textContent = `  ·  ${unmapped.length} in no column, each of which becomes a column of its own`;
      label.appendChild(warn);
    }
    palette.appendChild(label);

    const chips = document.createElement("div");
    chips.className = "kge-chips";
    // Unclaimed first: those are the ones with a decision left in them.
    const ordered = [...unmapped, ...known.filter((s) => columnHolding(s.name))];
    for (const status of ordered) {
      const holder = columnHolding(status.name);
      const chip = document.createElement("button");
      chip.className = "kge-chip";
      if (!holder) chip.classList.add("unmapped");
      else if (holder === target) chip.classList.add("here");
      else chip.classList.add("assigned");
      chip.title = holder
        ? holder === target
          ? `Already in ${strong.textContent}`
          : `In ${holder.name || "an unnamed column"} — click to move it to ${strong.textContent}`
        : `In no column — click to put it in ${strong.textContent}`;
      const name = document.createElement("span");
      name.textContent = status.name;
      chip.appendChild(name);
      if (status.count) {
        const count = document.createElement("span");
        count.className = "kge-chip-count";
        count.textContent = String(status.count);
        chip.appendChild(count);
      }
      if (holder === target) {
        chip.disabled = true;
      } else {
        chip.addEventListener("click", () => {
          assignStatus(status.name, selectedRow);
          editorProblems = [];
          renderGroupEditor();
        });
      }
      chips.appendChild(chip);
    }
    palette.appendChild(chips);
  }

  let columnOrder = savedColumnOrder;

  // Drag-a-card-between-columns, shared with the standup board.
  const moveIssue = createIssueMover({
    creds,
    getGroups: () => groups,
    repaint: () => renderBoard(),
  });

  function renderBoard() {
    renderColumns(board, getFiltered(), groups, {
      columnOrder,
      creds,
      onReorder: (names) => {
        columnOrder = names;
        saveColumnOrder(names);
        renderBoard();
      },
      onIssueMove: moveIssue,
    });
  }

  // The three facts a board cannot show you by looking at it: how much is in
  // play, how much of it nobody has picked up, and how much is late. Overdue is
  // the one the room stops on, so it is the one in danger colours.
  function renderHeaderTiles() {
    const issues = getFiltered();
    const unassigned = issues.filter((i) => !i.fields.assignee).length;
    const late = issues.filter((i) => isOverdue(i)).length;
    headerTiles.replaceChildren(
      viewTiles([
        { num: issues.length, label: issues.length === 1 ? "Issue" : "Issues", tone: "total" },
        { num: unassigned, label: "Unassigned", tone: unassigned ? "orange" : "gray" },
        { num: late, label: "Overdue", tone: late ? "red" : "gray" },
      ])
    );
  }

  function renderAll() {
    renderHeaderTiles();
    renderBoardSelector();
    renderPersonSelector();
    renderGroupEditor();
    renderBoard();
  }

  renderAll();
}

