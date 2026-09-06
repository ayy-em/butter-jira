// Kanban board rendering, shared by the Kanban view and standup mode.
//
// Extracted so standup shows the same cards people already recognise instead of
// a second, drifting implementation. Both drag behaviours are opt-in: standup
// takes card-drag (`onIssueMove`) so a status can be corrected while it is being
// discussed, but not column reorder (`onReorder`), which is a per-view layout
// preference rather than something to fiddle with mid-presentation.

import {
  assigneeLabel,
  boardColor,
  fmtDate,
  getAvatarUrl,
  getStoryPoints,
  hashColor,
  isOverdue,
  resolveStatusGroup,
} from "../utils.js";
import { openIssueDrawer, issuePageUrl } from "./issue-detail.js";
import { icon, priorityIcon } from "./icons.js";

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

// Which card the keyboard is on, by issue key, across repaints.
//
// The board is rebuilt from scratch on every repaint — a poll landing, a
// standup advancing, a move being written — so the focused element is destroyed
// several times a minute. Holding the key rather than the element means focus
// can be put back on the same card, which is the difference between a keyboard
// path and a keyboard path that works once.
let focusedKey = null;

export function renderIssueCard(issue, creds, { showAssignee = true } = {}) {
  const f = issue.fields;
  const card = document.createElement("div");
  card.className = "kanban-card";
  // The key is on the element so a write in flight can find its own card again
  // after the board has been repainted from scratch — see js/issue-move.js.
  card.dataset.issueKey = issue.key;
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
  // Was 🔴🟠🟡🔵 with no title and no text: the one element on a card with no
  // accessible name at all, the only encoding of priority anywhere on the
  // board, and a distinction carried entirely in hue. Now a shape, in a tone,
  // with a name — see js/components/icons.js.
  const pIcon = priorityIcon(f.priority?.name);
  if (pIcon) right.appendChild(pIcon);
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
        ph.style.fontSize = "calc(9px * var(--font-scale))";
        img.replaceWith(ph);
      };
      footer.appendChild(img);
    } else {
      const ph = makePlaceholder(f.assignee.displayName);
      ph.style.width = "18px";
      ph.style.height = "18px";
      ph.style.fontSize = "calc(9px * var(--font-scale))";
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
    // Was a 📅 emoji, hue-rotated -60° to say "overdue" — which renders as a
    // different picture on every platform, and turns a colour nobody chose into
    // a colour nobody can predict. The mark is drawn now, and overdue is the
    // token the rest of the app uses for the same idea.
    const overdue = isOverdue(issue);
    const dueEl = icon("calendar", 13, {
      label: overdue ? `Overdue: due ${fmtDate(f.duedate)}` : `Due ${fmtDate(f.duedate)}`,
    });
    dueEl.classList.add("kanban-card-due");
    if (overdue) dueEl.classList.add("overdue");
    dueEl.style.marginLeft = sp !== null ? "0" : "auto";
    footer.appendChild(dueEl);
  }

  card.appendChild(footer);
  return card;
}

// Renders columns into `board`. Both drag behaviours are opt-in: pass
// `onReorder` for drag-to-reorder of columns, and `onIssueMove` for
// drag-a-card-between-columns.
// `onIssueMove(issue, toColumnName, fromColumnName)` owns the Jira write.
export function renderColumns(board, issues, groups, options = {}) {
  const {
    columnOrder = null,
    onReorder = null,
    onIssueMove = null,
    creds,
    showAssignee = true,
    emptyLabel = "—",
  } = options;

  // Whether the keyboard was on this board before it was thrown away. Only
  // then does the rebuild put focus back — a repaint that steals focus from the
  // filter box every time a poll lands would be its own bug.
  const hadFocus = board.contains(document.activeElement);

  board.innerHTML = "";
  const columns = groupIssues(issues, groups, columnOrder);
  // Card elements by column, filled in as they are rendered. The keyboard
  // handlers need the whole grid — the card to the right lives in a column that
  // has not been built yet at the moment this one is — so they are wired after
  // the loop rather than inside it.
  const grid = columns.map(() => []);
  // Two drags share the board, so each drop has to know which is in flight:
  // a column header being reordered, or a card changing status.
  let dragSrcIdx = null;
  let dragIssue = null;
  let dragFromColumn = null;

  function clearDropHighlights() {
    board.querySelectorAll(".kanban-column").forEach((c) => {
      c.classList.remove("kanban-col-drag-over", "kanban-col-drop-target");
    });
  }

  columns.forEach((column, ci) => {
    const col = document.createElement("div");
    col.className = "kanban-column";
    col.dataset.colIdx = ci;

    if (onReorder || onIssueMove) {
      col.addEventListener("dragover", (e) => {
        if (dragIssue) {
          // Dropping a card back where it started is a no-op — don't invite it.
          if (!onIssueMove || column.name === dragFromColumn) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          col.classList.add("kanban-col-drop-target");
          return;
        }
        if (!onReorder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        col.classList.add("kanban-col-drag-over");
      });
      col.addEventListener("dragleave", (e) => {
        // Moving between the column's own children fires dragleave on the way
        // through; only clear when the pointer has actually left the column.
        if (col.contains(e.relatedTarget)) return;
        col.classList.remove("kanban-col-drag-over", "kanban-col-drop-target");
      });
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        clearDropHighlights();
        if (dragIssue) {
          if (!onIssueMove || column.name === dragFromColumn) return;
          onIssueMove(dragIssue, column.name, dragFromColumn);
          return;
        }
        if (!onReorder || dragSrcIdx === null || dragSrcIdx === ci) return;
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
        dragSrcIdx = null;
        col.style.opacity = "";
        clearDropHighlights();
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
    // A column literally named "Done" is treated as finished even if its
    // statuses aren't in Jira's done category — the board is what people read.
    const columnIsDone = /^done$/i.test(column.name.trim());

    for (const issue of column.issues) {
      const card = renderIssueCard(issue, creds, { showAssignee });
      if (!columnIsDone && isOverdue(issue)) card.classList.add("kanban-card-overdue");
      if (onIssueMove) {
        card.draggable = true;
        card.addEventListener("dragstart", (e) => {
          dragIssue = issue;
          dragFromColumn = column.name;
          card.classList.add("kanban-card-dragging");
          e.dataTransfer.effectAllowed = "move";
          // Some drop targets refuse a drag with no payload attached.
          e.dataTransfer.setData("text/plain", issue.key);
        });
        card.addEventListener("dragend", () => {
          dragIssue = null;
          dragFromColumn = null;
          card.classList.remove("kanban-card-dragging");
          clearDropHighlights();
        });
      }
      grid[ci].push(card);
      cards.appendChild(card);
    }
    col.appendChild(cards);
    board.appendChild(col);
  });

  wireKeyboard(board, columns, grid, { onIssueMove, hadFocus });

  return columns;
}

// ── The keyboard path ───────────────────────────────────────────────────────
//
// Dragging was the only way to change an issue's status, and every other write
// in this app has a keyboard path. The board is also the surface most often
// corrected during a standup — on a shared screen, by someone driving from a
// laptop trackpad — which is the worst place to require a drag.
//
// Roving tabindex rather than a tab stop per card: a full board is forty cards,
// and forty tab stops between the controls and whatever is after the board is
// not a keyboard path either. One card holds the tab stop; the arrows move
// between them, the way a grid is expected to behave.
//
//   ← → ↑ ↓       move between cards
//   Home / End    first / last card in the column
//   Enter         open the card, same as a click
//   Shift + ← →   move the issue a column left or right — the same call the
//                 drop makes, so the same transition matching, the same
//                 optimistic paint, the same rollback and the same refusal
//                 wording come out of it
//
// Every key handled here is stopped, not just prevented. Standup binds
// ArrowRight on document to advance the turn, and a card that has been
// deliberately focused owns its own arrows; letting the key through would
// advance the meeting behind the card somebody is correcting.
// Where an arrow key goes, given the shape of the board and where the keyboard
// is now. Pure — it takes the number of cards in each column, not the cards —
// so the edges are testable without a board: the ends of a column, the ends of
// the board, and the empty column in the middle that has to be stepped over
// rather than landed in.
//
// Returns { col, row } or null for "this key does nothing here".
export function nextCardPosition(lengths, col, row, key) {
  switch (key) {
    case "ArrowRight":
    case "ArrowLeft": {
      const step = key === "ArrowRight" ? 1 : -1;
      for (let c = col + step; c >= 0 && c < lengths.length; c += step) {
        // Past an empty column rather than into it: there is nothing there to
        // focus, and stopping would look like the key had failed.
        if (!lengths[c]) continue;
        return { col: c, row: Math.min(row, lengths[c] - 1) };
      }
      return null;
    }
    case "ArrowDown":
    case "ArrowUp": {
      const next = row + (key === "ArrowDown" ? 1 : -1);
      // No wrap at the ends of a column: the card above the first one is in
      // another column, and jumping there is not what the key looks like.
      return next >= 0 && next < lengths[col] ? { col, row: next } : null;
    }
    case "Home":
      return lengths[col] ? { col, row: 0 } : null;
    case "End":
      return lengths[col] ? { col, row: lengths[col] - 1 } : null;
    default:
      return null;
  }
}

function wireKeyboard(board, columns, grid, { onIssueMove, hadFocus }) {
  const all = grid.flat();
  if (!all.length) return;
  const lengths = grid.map((cards) => cards.length);

  // Where the tab stop sits. The remembered card if it survived the repaint,
  // otherwise the first card on the board.
  let anchor = all.find((c) => c.dataset.issueKey === focusedKey) || all[0];
  for (const card of all) card.tabIndex = card === anchor ? 0 : -1;

  const focusCard = (card) => {
    if (!card) return;
    for (const other of all) other.tabIndex = other === card ? 0 : -1;
    focusedKey = card.dataset.issueKey;
    card.focus();
  };

  for (let ci = 0; ci < grid.length; ci++) {
    for (let ri = 0; ri < grid[ci].length; ri++) {
      const card = grid[ci][ri];
      card.addEventListener("focus", () => {
        focusedKey = card.dataset.issueKey;
        for (const other of all) other.tabIndex = other === card ? 0 : -1;
      });
      card.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        // Shift+arrow is the move. Nothing else on this board takes shift.
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          e.stopPropagation();
          if (!onIssueMove) return;
          const target = columns[ci + (e.key === "ArrowRight" ? 1 : -1)];
          // Off the end of the board. Silent: there is no move to describe, and
          // a toast for every arrow press at the edge is noise.
          if (!target || target.name === columns[ci].name) return;
          const issue = columns[ci].issues[ri];
          if (!issue) return;
          // focusedKey is already this card's, so the repaint the move triggers
          // puts the keyboard back on it — in its new column.
          onIssueMove(issue, target.name, columns[ci].name);
          return;
        }
        if (e.shiftKey) return;

        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          card.click();
          return;
        }
        const to = nextCardPosition(lengths, ci, ri, e.key);
        if (!to) return;
        e.preventDefault();
        e.stopPropagation();
        focusCard(grid[to.col][to.row]);
      });
    }
  }

  if (hadFocus) anchor.focus();
}
