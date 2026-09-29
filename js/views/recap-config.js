// Launch → Recap config.
//
// Pick which boards, and which of their sprints, a sprint recap covers — active
// or closed, one or several, on one board or across several — then open it. The
// same board choice can open the quarterly overview for those boards only.
//
// One-off by design (settled 2026-09-29): the selection is carried in the
// document's URL (see js/recap-selection.js), so a recap can be reloaded and
// bookmarked, and nothing about it lives in settings. The screen only remembers
// the last choice on this device so the next visit starts where this one ended.
//
// Several sprints make one combined recap — totals summed, dates from the
// earliest start to the latest end — which is how the recap already treats a
// board running more than one active sprint.

import { getActiveSprint, getClosedSprints } from "../api.js";
import { localGet, localSet, runtimeUrl } from "../browser.js";
import { BOARDS, fmtDate } from "../utils.js";
import { viewHeader } from "../components/view-header.js";
import { quarterHref, recapHref, selectionHasGaps } from "../recap-selection.js";

const STORE_KEY = "recapConfig";
const CLOSED_SHOWN = 8;

export async function mount(container, creds) {
  const stored = (await localGet(STORE_KEY).catch(() => ({})))?.[STORE_KEY] || null;

  // { [boardId]: { on: boolean, sprints: Set<string> } }. A first visit has
  // every board on and nothing picked; the active sprint gets picked when its
  // list arrives, which is the recap people most often want.
  const state = new Map();
  for (const board of BOARDS) {
    const saved = stored?.boards?.[board.id];
    state.set(String(board.id), {
      on: saved ? Boolean(saved.on) : true,
      sprints: new Set((saved?.sprints || []).map(String)),
      fresh: !saved,
    });
  }
  // Sprint lists as they load: { [boardId]: { active: [], closed: [], error } }.
  const lists = new Map();
  const expanded = new Set();

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "rc-wrap";
  wrap.appendChild(
    viewHeader({
      iconName: "list",
      title: "Recap config",
      subtitle: "Choose boards and sprints for a recap, or boards for a quarterly overview",
    })
  );

  const boardsEl = document.createElement("div");
  boardsEl.className = "rc-boards";
  wrap.appendChild(boardsEl);

  const bar = document.createElement("div");
  bar.className = "rc-bar";
  const summaryEl = document.createElement("div");
  summaryEl.className = "rc-summary";
  const actions = document.createElement("div");
  actions.className = "rc-actions";
  const quarterBtn = button("Quarterly overview for these boards", "btn");
  const recapBtn = button("Generate recap", "btn primary");
  actions.append(quarterBtn, recapBtn);
  bar.append(summaryEl, actions);
  wrap.appendChild(bar);
  container.appendChild(wrap);

  quarterBtn.addEventListener("click", () => open(quarterHref(chosenBoards())));
  recapBtn.addEventListener("click", () => {
    const href = recapHref(selection());
    if (href) open(href);
  });

  paint();

  // Every board's lists at once; each board repaints when its own arrive.
  await Promise.all(
    BOARDS.map(async (board) => {
      const id = String(board.id);
      try {
        const [active, closed] = await Promise.all([
          getActiveSprint(board.id, creds).catch(() => []),
          getClosedSprints(board.id, creds),
        ]);
        lists.set(id, { active: active || [], closed: closed || [], error: "" });
        const entry = state.get(id);
        // Drop remembered picks that no longer exist on the board.
        const known = new Set([...(active || []), ...(closed || [])].map((s) => String(s.id)));
        for (const sprintId of [...entry.sprints]) if (!known.has(sprintId)) entry.sprints.delete(sprintId);
        if (entry.fresh && !entry.sprints.size) for (const s of active || []) entry.sprints.add(String(s.id));
      } catch (err) {
        lists.set(id, { active: [], closed: [], error: String(err?.message || err) });
      }
      paint();
    })
  );

  function open(href) {
    window.open(runtimeUrl(href), "_blank", "noopener");
  }

  function chosenBoards() {
    return BOARDS.filter((b) => state.get(String(b.id))?.on).map((b) => String(b.id));
  }

  function selection() {
    const byBoard = {};
    for (const id of chosenBoards()) {
      const picked = [...state.get(id).sprints];
      if (picked.length) byBoard[id] = picked;
    }
    return byBoard;
  }

  function sprintById(boardId, sprintId) {
    const l = lists.get(boardId);
    return [...(l?.active || []), ...(l?.closed || [])].find((s) => String(s.id) === sprintId) || null;
  }

  function save() {
    const boards = {};
    for (const [id, entry] of state) boards[id] = { on: entry.on, sprints: [...entry.sprints] };
    localSet({ [STORE_KEY]: { boards } }).catch(() => {});
  }

  function change(fn) {
    fn();
    for (const entry of state.values()) entry.fresh = false;
    save();
    paint();
  }

  function paint() {
    boardsEl.innerHTML = "";
    if (!BOARDS.length) {
      boardsEl.appendChild(note("No boards configured. Add one under Settings → Boards."));
    }
    for (const board of BOARDS) boardsEl.appendChild(boardCard(board));
    paintSummary();
  }

  function boardCard(board) {
    const id = String(board.id);
    const entry = state.get(id);
    const list = lists.get(id);

    const card = document.createElement("section");
    card.className = `rc-board${entry.on ? "" : " rc-board-off"}`;
    if (board.color) card.style.setProperty("--rc-board", board.color);

    const head = document.createElement("div");
    head.className = "rc-board-head";
    const label = document.createElement("label");
    label.className = "rc-board-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.on;
    box.addEventListener("change", () => change(() => { entry.on = box.checked; }));
    const name = document.createElement("span");
    name.className = "rc-board-name";
    name.textContent = board.name;
    label.append(box, name);
    head.appendChild(label);

    if (entry.on && list && !list.error) {
      const quick = document.createElement("div");
      quick.className = "rc-quick";
      const pick = (text, ids) => {
        const b = button(text, "btn small ghost");
        b.addEventListener("click", () => change(() => { entry.sprints = new Set(ids.map(String)); }));
        quick.appendChild(b);
      };
      if (list.active.length) pick("Active", list.active.map((s) => s.id));
      if (list.closed.length) pick("Last closed", list.closed.slice(0, 1).map((s) => s.id));
      if (list.closed.length > 1) pick("Last 3 closed", list.closed.slice(0, 3).map((s) => s.id));
      pick("None", []);
      head.appendChild(quick);
    }
    card.appendChild(head);

    if (!entry.on) return card;
    if (!list) {
      card.appendChild(note("Reading sprints…"));
      return card;
    }
    if (list.error) {
      card.appendChild(note(`Could not read this board's sprints — ${list.error}`));
      return card;
    }
    if (!list.active.length && !list.closed.length) {
      card.appendChild(note("This board has no active or closed sprints."));
      return card;
    }

    const rows = document.createElement("div");
    rows.className = "rc-sprints";
    const showAll = expanded.has(id);
    const closedShown = showAll ? list.closed : list.closed.slice(0, CLOSED_SHOWN);
    for (const sprint of list.active) rows.appendChild(sprintRow(entry, sprint, "active"));
    for (const sprint of closedShown) rows.appendChild(sprintRow(entry, sprint, "closed"));
    card.appendChild(rows);

    const hidden = list.closed.length - closedShown.length;
    if (hidden > 0 || showAll) {
      const more = button(showAll ? "Show fewer" : `Show ${hidden} older`, "btn small ghost rc-more");
      more.addEventListener("click", () => {
        if (showAll) expanded.delete(id);
        else expanded.add(id);
        paint();
      });
      card.appendChild(more);
    }
    return card;
  }

  function sprintRow(entry, sprint, kind) {
    const sprintId = String(sprint.id);
    const row = document.createElement("label");
    row.className = "rc-sprint";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.sprints.has(sprintId);
    box.addEventListener("change", () =>
      change(() => {
        if (box.checked) entry.sprints.add(sprintId);
        else entry.sprints.delete(sprintId);
      })
    );
    const name = document.createElement("span");
    name.className = "rc-sprint-name";
    name.textContent = sprint.name || `Sprint ${sprintId}`;
    const dates = document.createElement("span");
    dates.className = "rc-sprint-dates mono";
    const end = sprint.completeDate || sprint.endDate;
    dates.textContent = sprint.startDate ? `${fmtDate(sprint.startDate)} → ${end ? fmtDate(end) : "…"}` : "no dates";
    row.append(box, name, dates);
    if (kind === "active") {
      const tag = document.createElement("span");
      tag.className = "rc-tag mono";
      tag.textContent = "active";
      row.appendChild(tag);
    }
    return row;
  }

  function paintSummary() {
    const byBoard = selection();
    const picked = Object.entries(byBoard).flatMap(([boardId, ids]) =>
      ids.map((sprintId) => sprintById(boardId, sprintId)).filter(Boolean)
    );
    const boardCount = Object.keys(byBoard).length;
    const on = chosenBoards().length;

    summaryEl.innerHTML = "";
    const line = document.createElement("div");
    line.className = "rc-summary-line";
    if (picked.length) {
      const starts = picked.map((s) => Date.parse(s.startDate || "")).filter(Number.isFinite);
      const ends = picked.map((s) => Date.parse(s.completeDate || s.endDate || "")).filter(Number.isFinite);
      const span =
        starts.length && ends.length
          ? ` · ${fmtDate(new Date(Math.min(...starts)).toISOString())} → ${fmtDate(new Date(Math.max(...ends)).toISOString())}`
          : "";
      line.textContent =
        `${picked.length} sprint${picked.length === 1 ? "" : "s"} on ${boardCount} board${boardCount === 1 ? "" : "s"}${span}` +
        (picked.length > 1 ? " — one combined recap" : "");
    } else {
      line.textContent = "No sprints selected";
    }
    summaryEl.appendChild(line);
    if (selectionHasGaps(picked)) {
      summaryEl.appendChild(
        note("Not back to back: the recap's GitHub figures will also cover the time between these sprints.")
      );
    }
    recapBtn.disabled = !picked.length;
    quarterBtn.disabled = !on;
    quarterBtn.textContent = on === BOARDS.length
      ? "Quarterly overview, all boards"
      : `Quarterly overview for ${on} board${on === 1 ? "" : "s"}`;
  }
}

function button(text, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className} mono`;
  b.textContent = text;
  return b;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "rc-note";
  p.textContent = text;
  return p;
}

