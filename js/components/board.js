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
    // By name as well as position, so a snapshot taken before a repaint can
    // tell which column a card was in — see animateBoardChanges below.
    col.dataset.column = column.name;

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

// ── What a re-fetch changed ─────────────────────────────────────────────────
//
// The board is rebuilt from scratch on every repaint, so a card that changed
// column between two fetches simply appears somewhere else — invisible on a
// projected screen unless someone remembers where it was. Snapshot the board
// before the repaint, then show the difference after it: a moved card flies
// from its old place to its new one, a new card drops in, and a card that left
// the board stays behind long enough to be seen going.
//
// Moves and departures fly on fixed-position copies rather than on the cards
// themselves. Every column scrolls on its own, and a card translated out of its
// column is clipped by that column's overflow — it would vanish at the border
// halfway through the trip.

// key -> { column, rect, el } for every card, plus each column's count element
// text. The elements are kept on purpose: a card that is gone after the repaint
// is animated out using its own, now detached, node.
export function boardSnapshot(board) {
  const cards = new Map();
  const counts = new Map();
  if (!board) return { cards, counts };
  for (const card of board.querySelectorAll(".kanban-column .kanban-card[data-issue-key]")) {
    cards.set(card.dataset.issueKey, {
      column: card.closest(".kanban-column")?.dataset.column ?? "",
      rect: card.getBoundingClientRect(),
      el: card,
    });
  }
  for (const col of board.querySelectorAll(".kanban-column[data-column]")) {
    counts.set(col.dataset.column, col.querySelector(".kanban-col-count")?.textContent ?? "");
  }
  return { cards, counts };
}

// Pure: two maps of issue key -> column name in, what happened between them
// out. Order follows the board — `after`'s order for moves and arrivals,
// `before`'s for departures — so a staggered animation runs left to right.
export function diffPlacements(before, after) {
  const moved = [];
  const added = [];
  const removed = [];
  for (const [key, column] of after) {
    if (!before.has(key)) added.push(key);
    else if (before.get(key) !== column) moved.push({ key, from: before.get(key), to: column });
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return { moved, added, removed };
}

const columnsOf = (cards) => new Map([...cards].map(([key, c]) => [key, c.column]));

const FX_STAGGER_MS = 90;
const FX_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// Call straight after renderColumns() with the snapshot taken before it.
// `board` may be null when the repaint left nothing to draw; the diff is still
// returned so the caller can say what happened. Returns { moved, added, removed }.
export function animateBoardChanges(board, before) {
  const after = boardSnapshot(board);
  const diff = diffPlacements(columnsOf(before.cards), columnsOf(after.cards));
  if (!board) return diff;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Cards that stayed in their column but shifted because something above
  // them arrived or left. Plain FLIP, in place: within one column the clip is
  // the right behaviour.
  if (!reduce) {
    for (const [key, now] of after.cards) {
      const was = before.cards.get(key);
      if (!was || was.column !== now.column) continue;
      const dx = was.rect.left - now.rect.left;
      const dy = was.rect.top - now.rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      now.el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 450, easing: FX_EASE }
      );
    }
  }

  // Departures first and arrivals last. A card that leaves and one that
  // arrives often share a slot — the board closes up behind the one going —
  // and the new card landing on the ghost before it has started to fall reads
  // as one muddle rather than one out, one in.
  diff.removed.forEach((key, i) => {
    dropOutCard(board, before.cards.get(key), i * FX_STAGGER_MS, reduce);
  });
  diff.moved.forEach(({ key, from }, i) => {
    flyCard(board, before.cards.get(key), after.cards.get(key), from, 250 + i * FX_STAGGER_MS, reduce);
  });
  const arrivalsFrom = diff.removed.length ? 900 : 250;
  diff.added.forEach((key, i) => {
    dropInCard(after.cards.get(key).el, arrivalsFrom + i * FX_STAGGER_MS, reduce);
  });

  if (!reduce) {
    for (const col of board.querySelectorAll(".kanban-column[data-column]")) {
      const count = col.querySelector(".kanban-col-count");
      const was = before.counts.get(col.dataset.column);
      if (!count || was === undefined || was === count.textContent) continue;
      // A class rather than element.animate(): the flash is in theme tokens,
      // and var() inside script-built keyframes is not resolved everywhere.
      count.classList.add("kanban-col-count-bump");
    }
  }

  return diff;
}

// The small label a changed card carries for a few seconds: where it came
// from, or that it is new or gone. The CSS fades it out by itself.
function fxTag(card, text) {
  card.querySelector(".kanban-card-fx-tag")?.remove();
  const tag = document.createElement("span");
  tag.className = "kanban-card-fx-tag mono";
  tag.textContent = text;
  card.appendChild(tag);
}

// A copy of `source`, pinned over the board at `rect`. Inside the board element
// rather than on <body> so the board's own card styles still apply to it.
function flyer(board, source, rect) {
  const copy = source.cloneNode(true);
  copy.classList.add("kanban-card-flyer");
  copy.removeAttribute("tabindex");
  // The source may be a card hidden while it waits for its own flight.
  copy.style.visibility = "";
  copy.setAttribute("aria-hidden", "true");
  Object.assign(copy.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  board.appendChild(copy);
  return copy;
}

function onSettled(animation, fn) {
  animation.onfinish = fn;
  animation.oncancel = fn;
}

function flyCard(board, was, now, fromColumn, delay, reduce) {
  const land = () => {
    now.el.style.visibility = "";
    now.el.classList.add("kanban-card-moved");
    fxTag(now.el, `from ${fromColumn}`);
  };
  if (reduce) return land();

  // The real card holds its new place, invisible, while a copy of it — new
  // content, already in its new column's styling — travels there from the old
  // one. Arcs up and tilts toward where it is going, so it reads as picked up
  // and put down rather than slid.
  now.el.style.visibility = "hidden";
  const copy = flyer(board, now.el, now.rect);
  const dx = was.rect.left - now.rect.left;
  const dy = was.rect.top - now.rect.top;
  const tilt = dx < 0 ? 3 : -3;
  const animation = copy.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)`, boxShadow: "0 0 0 transparent" },
      {
        transform: `translate(${dx * 0.75}px, ${dy * 0.75 - 36}px) scale(1.08) rotate(${tilt}deg)`,
        boxShadow: "0 22px 44px rgba(0, 0, 0, 0.35)",
        offset: 0.35,
      },
      { transform: "none", boxShadow: "0 0 0 transparent" },
    ],
    { duration: 950, delay, easing: FX_EASE, fill: "backwards" }
  );
  onSettled(animation, () => {
    copy.remove();
    land();
  });
}

function dropInCard(card, delay, reduce) {
  card.classList.add("kanban-card-added");
  fxTag(card, "new");
  if (reduce) return;
  // The ring starts when the card appears, not while it is still invisible.
  card.style.animationDelay = `${delay}ms`;
  card.animate(
    [
      { opacity: 0, transform: "translateY(-28px) scale(0.8)" },
      { opacity: 1, transform: "translateY(4px) scale(1.04)", offset: 0.6 },
      { opacity: 1, transform: "none" },
    ],
    { duration: 700, delay, easing: FX_EASE, fill: "backwards" }
  );
}

// The old card itself, detached by the repaint, put back over the board where
// it was: it lingers marked as gone, then falls away.
function dropOutCard(board, was, delay, reduce) {
  const ghost = flyer(board, was.el, was.rect);
  ghost.classList.add("kanban-card-removed");
  fxTag(ghost, "gone");
  const frames = reduce
    ? [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }]
    : [
        { opacity: 1, transform: "none" },
        { opacity: 1, transform: "scale(1.03)", offset: 0.5 },
        { opacity: 0, transform: "translateY(60px) scale(0.75) rotate(-6deg)" },
      ];
  const animation = ghost.animate(frames, {
    duration: 1600,
    delay,
    easing: "ease-in",
    fill: "both",
  });
  onSettled(animation, () => ghost.remove());
}
