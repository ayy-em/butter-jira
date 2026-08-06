import {
  getAllSprintIssues,
  getAllBacklogIssues,
} from "../api.js";
import {
  hashColor,
  boardColor,
  getStoryPoints,
  getAvatarUrl,
  extractAssignees,
  fmtDate,
  assigneeLabel,
  BOARDS,
  loadStatusGroups,
  saveStatusGroups,
  resolveStatusGroup,
} from "../utils.js";
import { openIssueDrawer, issuePageUrl } from "../components/issue-detail.js";

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

  function renderBoard() {
    board.innerHTML = "";
    const issues = getFiltered();

    const groupOrderBase = groups.map((g) => g.name);
    const groupMap = new Map();
    for (const g of groups) groupMap.set(g.name, []);

    for (const issue of issues) {
      const rawStatus = issue.fields.status?.name || "To Do";
      const groupName = resolveStatusGroup(rawStatus, groups);
      if (!groupMap.has(groupName)) {
        groupMap.set(groupName, []);
        groupOrderBase.push(groupName);
      }
      groupMap.get(groupName).push(issue);
    }

    let groupOrder;
    if (columnOrder) {
      const ordered = columnOrder.filter((n) => groupOrderBase.includes(n));
      const remaining = groupOrderBase.filter((n) => !ordered.includes(n));
      groupOrder = [...ordered, ...remaining];
    } else {
      groupOrder = groupOrderBase;
    }

    let dragSrcIdx = null;

    for (let ci = 0; ci < groupOrder.length; ci++) {
      const groupName = groupOrder[ci];
      const cards = groupMap.get(groupName) || [];
      const col = document.createElement("div");
      col.className = "kanban-column";
      col.dataset.colIdx = ci;

      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        col.classList.add("kanban-col-drag-over");
      });
      col.addEventListener("dragleave", () => {
        col.classList.remove("kanban-col-drag-over");
      });
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("kanban-col-drag-over");
        if (dragSrcIdx === null || dragSrcIdx === ci) return;
        const newOrder = [...groupOrder];
        const [moved] = newOrder.splice(dragSrcIdx, 1);
        newOrder.splice(ci, 0, moved);
        columnOrder = newOrder;
        saveColumnOrder(newOrder);
        renderBoard();
      });

      const header = document.createElement("div");
      header.className = "kanban-col-header";
      header.style.cursor = "grab";
      header.draggable = true;
      header.addEventListener("dragstart", (e) => {
        dragSrcIdx = ci;
        col.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
      });
      header.addEventListener("dragend", () => {
        col.style.opacity = "";
        board.querySelectorAll(".kanban-column").forEach((c) => c.classList.remove("kanban-col-drag-over"));
      });
      const label = document.createElement("span");
      label.textContent = groupName;
      header.appendChild(label);
      const count = document.createElement("span");
      count.className = "kanban-col-count";
      count.textContent = cards.length;
      header.appendChild(count);
      col.appendChild(header);

      const cardContainer = document.createElement("div");
      cardContainer.className = "kanban-col-cards";

      if (cards.length === 0) {
        const empty = document.createElement("div");
        empty.className = "kanban-empty";
        empty.textContent = "—";
        cardContainer.appendChild(empty);
      }

      for (const issue of cards) {
        cardContainer.appendChild(renderCard(issue));
      }

      col.appendChild(cardContainer);
      board.appendChild(col);
    }
  }

  function renderCard(issue) {
    const f = issue.fields;
    const card = document.createElement("div");
    card.className = "kanban-card";
    card.style.borderTopColor = hashColor(issue.key);
    // Whole card is clickable: plain click opens the drawer, modified or
    // middle click opens the full page in a new tab.
    card.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        window.open(issuePageUrl(issue.key), "_blank", "noopener");
        return;
      }
      openIssueDrawer(issue.key, creds);
    });
    card.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.open(issuePageUrl(issue.key), "_blank", "noopener");
      }
    });

    const stripe = document.createElement("div");
    stripe.className = "kanban-card-board-stripe";
    stripe.style.background = boardColor(issue.boardId);
    card.appendChild(stripe);

    const header = document.createElement("div");
    header.className = "kanban-card-header";
    const key = document.createElement("span");
    key.className = "issue-key";
    key.style.color = boardColor(issue.boardId);
    key.textContent = issue.key;
    header.appendChild(key);

    const right = document.createElement("span");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";
    const pName = f.priority?.name || "";
    const pIcon = { Critical: "🔴", Highest: "🔴", High: "🟠", Medium: "🟡", Low: "🔵", Lowest: "🔵" }[pName] || "";
    if (pIcon) {
      const pi = document.createElement("span");
      pi.textContent = pIcon;
      pi.style.fontSize = "12px";
      right.appendChild(pi);
    }
    const typeBadge = document.createElement("span");
    typeBadge.className = "kanban-card-type";
    typeBadge.textContent = f.issuetype?.name || "—";
    right.appendChild(typeBadge);
    header.appendChild(right);
    card.appendChild(header);

    const summary = document.createElement("div");
    summary.className = "kanban-card-summary";
    summary.textContent = f.summary || "";
    card.appendChild(summary);

    const footer = document.createElement("div");
    footer.className = "kanban-card-footer";

    if (f.assignee) {
      const avatarUrl = getAvatarUrl(issue);
      if (avatarUrl) {
        const img = document.createElement("img");
        img.className = "avatar";
        img.src = avatarUrl;
        img.style.width = "18px";
        img.style.height = "18px";
        img.onerror = () => {
          const ph = makePlaceholder(f.assignee.displayName);
          ph.style.width = "18px";
          ph.style.height = "18px";
          ph.style.fontSize = "9px";
          img.replaceWith(ph);
        };
        footer.appendChild(img);
      } else {
        const ph = makePlaceholder(f.assignee.displayName);
        ph.style.width = "18px";
        ph.style.height = "18px";
        ph.style.fontSize = "9px";
        footer.appendChild(ph);
      }
      const nm = document.createElement("span");
      nm.textContent = assigneeLabel(f.assignee);
      footer.appendChild(nm);
    }

    const sp = getStoryPoints(issue);
    if (sp !== null) {
      const spEl = document.createElement("span");
      spEl.className = "sp";
      spEl.textContent = `${sp} SP`;
      footer.appendChild(spEl);
    }

    if (f.duedate) {
      const dueEl = document.createElement("span");
      dueEl.textContent = "📅";
      dueEl.title = fmtDate(f.duedate);
      dueEl.style.marginLeft = sp !== null ? "0" : "auto";
      const due = new Date(f.duedate);
      if (due < new Date()) dueEl.style.filter = "hue-rotate(-60deg) saturate(2)";
      footer.appendChild(dueEl);
    }

    card.appendChild(footer);
    return card;
  }

  function renderAll() {
    renderBoardSelector();
    renderPersonSelector();
    renderGroupEditor();
    renderBoard();
  }

  renderAll();
}

function makePlaceholder(name) {
  const el = document.createElement("span");
  el.className = "avatar-placeholder";
  el.style.background = hashColor(name);
  el.textContent = (name || "?")[0].toUpperCase();
  return el;
}
