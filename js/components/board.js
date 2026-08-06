// Kanban board rendering, shared by the Kanban view and standup mode.
//
// Extracted so standup shows the same cards people already recognise instead of
// a second, drifting implementation. Column drag-reorder is opt-in via
// `onReorder`, so the presentation view gets the board without the editing.

import {
  assigneeLabel,
  boardColor,
  fmtDate,
  getAvatarUrl,
  getStoryPoints,
  hashColor,
  resolveStatusGroup,
} from "../utils.js";
import { openIssueDrawer, issuePageUrl } from "./issue-detail.js";

const PRIORITY_ICONS = {
  Critical: "🔴", Highest: "🔴", High: "🟠",
  Medium: "🟡", Low: "🔵", Lowest: "🔵",
};

export function makePlaceholder(name) {
  const el = document.createElement("span");
  el.className = "avatar-placeholder";
  el.style.background = hashColor(name);
  el.textContent = (name || "?")[0].toUpperCase();
  return el;
}

// Buckets issues into status-group columns. Pure, so column ordering is
// testable without a DOM.
export function groupIssues(issues, groups, columnOrder = null) {
  const order = groups.map((g) => g.name);
  const map = new Map();
  for (const g of groups) map.set(g.name, []);

  for (const issue of issues) {
    const rawStatus = issue.fields?.status?.name || "To Do";
    const groupName = resolveStatusGroup(rawStatus, groups);
    if (!map.has(groupName)) {
      map.set(groupName, []);
      order.push(groupName);
    }
    map.get(groupName).push(issue);
  }

  let finalOrder = order;
  if (columnOrder) {
    const known = columnOrder.filter((n) => order.includes(n));
    const rest = order.filter((n) => !known.includes(n));
    finalOrder = [...known, ...rest];
  }

  return finalOrder.map((name) => ({ name, issues: map.get(name) || [] }));
}

export function renderIssueCard(issue, creds, { showAssignee = true } = {}) {
  const f = issue.fields;
  const card = document.createElement("div");
  card.className = "kanban-card";
  card.style.borderTopColor = hashColor(issue.key);

  // Whole card is clickable: plain click opens the drawer, modified or middle
  // click opens the full page in a new tab.
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
  const pIcon = PRIORITY_ICONS[f.priority?.name || ""] || "";
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

  // Standup already knows whose board it is, so the avatar is just noise there.
  if (showAssignee && f.assignee) {
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
    if (new Date(f.duedate) < new Date()) {
      dueEl.style.filter = "hue-rotate(-60deg) saturate(2)";
    }
    footer.appendChild(dueEl);
  }

  card.appendChild(footer);
  return card;
}

// Renders columns into `board`. Pass `onReorder` to enable drag-to-reorder;
// omit it for a read-only board.
export function renderColumns(board, issues, groups, options = {}) {
  const {
    columnOrder = null,
    onReorder = null,
    creds,
    showAssignee = true,
    emptyLabel = "—",
  } = options;

  board.innerHTML = "";
  const columns = groupIssues(issues, groups, columnOrder);
  let dragSrcIdx = null;

  columns.forEach((column, ci) => {
    const col = document.createElement("div");
    col.className = "kanban-column";
    col.dataset.colIdx = ci;

    if (onReorder) {
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
        const names = columns.map((c) => c.name);
        const [moved] = names.splice(dragSrcIdx, 1);
        names.splice(ci, 0, moved);
        onReorder(names);
      });
    }

    const header = document.createElement("div");
    header.className = "kanban-col-header";
    if (onReorder) {
      header.style.cursor = "grab";
      header.draggable = true;
      header.addEventListener("dragstart", (e) => {
        dragSrcIdx = ci;
        col.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
      });
      header.addEventListener("dragend", () => {
        col.style.opacity = "";
        board
          .querySelectorAll(".kanban-column")
          .forEach((c) => c.classList.remove("kanban-col-drag-over"));
      });
    }

    const label = document.createElement("span");
    label.textContent = column.name;
    header.appendChild(label);
    const count = document.createElement("span");
    count.className = "kanban-col-count";
    count.textContent = column.issues.length;
    header.appendChild(count);
    col.appendChild(header);

    const cards = document.createElement("div");
    cards.className = "kanban-col-cards";
    if (!column.issues.length) {
      const empty = document.createElement("div");
      empty.className = "kanban-empty";
      empty.textContent = emptyLabel;
      cards.appendChild(empty);
    }
    for (const issue of column.issues) {
      cards.appendChild(renderIssueCard(issue, creds, { showAssignee }));
    }
    col.appendChild(cards);
    board.appendChild(col);
  });

  return columns;
}
