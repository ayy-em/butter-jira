import {
  getAllSprintIssues,
  getAllBacklogIssues,
  getIssueTransitions,
  transitionIssue,
} from "../api.js";
import {
  cache,
  extractAssignees,
  BOARDS,
  loadStatusGroups,
  saveStatusGroups,
  showToast,
} from "../utils.js";
import { makePlaceholder, renderColumns } from "../components/board.js";

async function loadColumnOrder() {
  const result = await chrome.storage.sync.get("kanbanColumnOrder");
  return result.kanbanColumnOrder || null;
}

async function saveColumnOrder(order) {
  await chrome.storage.sync.set({ kanbanColumnOrder: order });
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

  const groupBtn = document.createElement("button");
  groupBtn.className = "kanban-group-btn mono";
  groupBtn.textContent = "Columns";
  groupBtn.title = "Configure status grouping";
  groupBtn.addEventListener("click", () => {
    showGroupEditor = !showGroupEditor;
    renderAll();
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

  function renderGroupEditor() {
    editorContainer.innerHTML = "";
    if (!showGroupEditor) return;

    const editor = document.createElement("div");
    editor.className = "kanban-group-editor-panel";

    const title = document.createElement("div");
    title.className = "mono";
    title.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px;";
    title.textContent = "Status Column Grouping";
    editor.appendChild(title);

    const desc = document.createElement("div");
    desc.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:10px;";
    desc.textContent = "Map Jira statuses to columns. Comma-separated.";
    editor.appendChild(desc);

    const rows = document.createElement("div");
    rows.style.cssText = "display:flex;flex-direction:column;gap:6px;";

    for (let i = 0; i < groups.length; i++) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;align-items:center;";

      const nameInput = document.createElement("input");
      nameInput.className = "setup-input mono";
      nameInput.style.cssText = "width:120px;margin:0;padding:6px 8px;font-size:11px;flex-shrink:0;";
      nameInput.value = groups[i].name;
      nameInput.addEventListener("input", () => { groups[i].name = nameInput.value; });

      const statusInput = document.createElement("input");
      statusInput.className = "setup-input mono";
      statusInput.style.cssText = "flex:1;margin:0;padding:6px 8px;font-size:11px;";
      statusInput.value = groups[i].statuses.join(", ");
      statusInput.placeholder = "Status 1, Status 2, ...";
      statusInput.addEventListener("input", () => {
        groups[i].statuses = statusInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      });

      const removeBtn = document.createElement("button");
      removeBtn.style.cssText = "background:none;border:none;color:#EF4444;cursor:pointer;font-size:16px;padding:2px 6px;";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        groups.splice(i, 1);
        renderGroupEditor();
      });

      row.appendChild(nameInput);
      row.appendChild(statusInput);
      row.appendChild(removeBtn);
      rows.appendChild(row);
    }
    editor.appendChild(rows);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:8px;";

    const addBtn = document.createElement("button");
    addBtn.className = "kanban-group-btn mono";
    addBtn.textContent = "+ Add group";
    addBtn.addEventListener("click", () => {
      groups.push({ name: "", statuses: [] });
      renderGroupEditor();
    });
    btnRow.appendChild(addBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "kanban-group-btn mono";
    saveBtn.style.cssText = "background:var(--accent-primary);color:#fff;border-color:var(--accent-primary);";
    saveBtn.textContent = "Save & Apply";
    saveBtn.addEventListener("click", async () => {
      const valid = groups.filter((g) => g.name.trim() && g.statuses.length);
      groups = valid;
      await saveStatusGroups(valid);
      showGroupEditor = false;
      renderAll();
    });
    btnRow.appendChild(saveBtn);

    editor.appendChild(btnRow);
    editorContainer.appendChild(editor);
  }

  let columnOrder = savedColumnOrder;

  // Cards show no status text, so which column a card sits in *is* its status
  // and dragging it between columns is the whole edit. Jira won't take a status
  // write directly though — it needs a workflow transition, and a column is a
  // group of statuses rather than one, so the transition is matched against the
  // group's statuses at drop time.
  const inFlight = new Set();

  async function moveIssue(issue, toColumnName) {
    if (inFlight.has(issue.key)) return;

    const group = groups.find((g) => g.name === toColumnName);
    // Columns that aren't a configured group are named after the status itself.
    const wanted = group?.statuses?.length ? group.statuses : [toColumnName];
    const prevStatus = issue.fields.status;

    inFlight.add(issue.key);
    // Optimistic: the card lands in the new column straight away and goes back
    // if Jira refuses. statusCategory is carried over as a placeholder — it is
    // replaced with the real target status a moment later, and nothing on a card
    // reads it.
    issue.fields.status = { ...prevStatus, name: wanted[0] };
    renderBoard();

    try {
      const transitions = await getIssueTransitions(issue.key, creds);
      // Prefer the group's first listed status; fall back through the rest.
      const match =
        wanted
          .map((name) =>
            transitions.find((t) => t.toStatus.toLowerCase() === name.toLowerCase())
          )
          .find(Boolean) || null;

      if (!match) {
        issue.fields.status = prevStatus;
        renderBoard();
        const reachable = transitions.map((t) => t.toStatus).filter(Boolean);
        showToast(
          reachable.length
            ? `${issue.key}: the workflow allows no move from ${prevStatus?.name || "?"} to ${toColumnName} — only ${reachable.join(", ")}`
            : `${issue.key}: your account has no available transitions on this issue`,
          true
        );
        return;
      }

      await transitionIssue(issue.key, match.id, creds);
      issue.fields.status = match.to || { ...prevStatus, name: match.toStatus };
      // Only this issue's board is stale; everything else stays cached.
      await cache.dropBoard(issue.boardId);
      renderBoard();
      showToast(`${issue.key} → ${match.toStatus}`);
    } catch (err) {
      issue.fields.status = prevStatus;
      renderBoard();
      const msg = String(err.message || err);
      if (msg.includes("401")) return; // the router's reauth flow owns this
      showToast(`${issue.key} could not be moved — ${msg}`, true);
    } finally {
      inFlight.delete(issue.key);
    }
  }

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

  function renderAll() {
    renderBoardSelector();
    renderPersonSelector();
    renderGroupEditor();
    renderBoard();
  }

  renderAll();
}

