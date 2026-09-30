// Launch → Sprint planner (M15).
//
// Two screens over one device-local draft (see js/planner.js):
//
//   1. **Setup** — which boards, which sprint on each to plan into (made in Jira
//      beforehand), which sprints to carry leftovers over from, who is being
//      planned for, the sprint's dates and working days, the buffer for
//      unplanned work, and each person's days where they differ.
//   2. **Plan** — everyone's face with their capacity, what is assigned to them
//      and the difference; the carryover and the backlog as cards; the plan
//      itself. Cards are dragged, or added with a button, into the plan or onto
//      a person. Nothing reaches Jira until Review & push, which re-reads Jira,
//      shows every write, and sends them as one confirmed batch.
//
// The one exception is Split, which writes at once from its own confirm — the
// new half has to exist in Jira before it can be planned.
//
// Prepared by one person the day before and reviewed in the meeting (settled
// 2026-09-30), so the draft survives a reload and a closed tab, and Refresh
// tasks re-reads Jira without touching it.

import {
  createIssue,
  createIssueLink,
  getActiveSprint,
  getBoardBacklog,
  getClosedSprints,
  getEpicNames,
  getFutureSprints,
  getIssueLinkTypes,
  getIssueTransitions,
  getIssuesByKeys,
  getSprintIssues,
  harvestTeamCandidates,
  moveIssuesToBacklog,
  moveIssuesToSprint,
  transitionIssue,
  updateIssueFields,
} from "../api.js";
import {
  BOARDS,
  boardColor,
  cache,
  fmtDate,
  getAvatarUrl,
  getEpicKey,
  hashColor,
  isOverdue,
  showToast,
} from "../utils.js";
import { activeMembers, avatarAssetUrl, memberFor, memberLabel, shortenName } from "../team.js";
import { viewHeader, viewTiles } from "../components/view-header.js";
import { attachIssueOpener } from "../components/issue-detail.js";
import { icon, priorityIcon } from "../components/icons.js";
import { statusTone } from "../backlog.js";
import { isSubtask } from "../monitor.js";
import { linkPayloadFor } from "../issue-link.js";
import {
  addToPlan,
  buildPushPlan,
  canCommit,
  clearDraft,
  defaultDateRange,
  doneTransition,
  effective,
  emptyDraft,
  epicRemaining,
  executePush,
  filterCandidates,
  filterOptions,
  fmtPoints,
  isPlanned,
  loadBand,
  loadDraft,
  missingForCommit,
  parseIssueRef,
  parsePoints,
  personCapacity,
  removeFromPlan,
  saveDraft,
  setEdit,
  settleDraft,
  splitCandidates,
  splitCreateFields,
  splitLinkType,
  splitSummary,
  sprintDateRange,
  tallies,
  targetFor,
  targetSprintIds,
  teamCapacity,
  workingDaysBetween,
} from "../planner.js";

const CLOSED_OFFERED = 3;

export async function mount(container, creds) {
  let draft = await loadDraft();

  // Sprint lists per board: { active, future, closed, error }.
  const sprintLists = new Map();
  // Everything read for the plan screen.
  const data = {
    loaded: false,
    loading: false,
    error: "",
    issues: new Map(), // key -> issue
    inTarget: new Map(), // sprintId -> Set<key>
    carryover: [],
    backlog: [],
    extra: [],
    epicNames: {},
    readAt: null,
  };
  const ui = {
    filters: { epic: "", label: "", priority: "", text: "" },
    person: "", // plan list narrowed to one person
    harvested: [], // people found on the boards when there is no roster
  };

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      // Keep the same object: the rows on screen hold references into it, and
      // swapping in the saved copy sent every later edit to an orphan — the
      // second person's override in a row was silently never saved.
      const saved = await saveDraft(draft).catch(() => null);
      if (saved) draft.updatedAt = saved.updatedAt;
      const label = container.querySelector(".pl-saved");
      if (label) label.textContent = savedLabel();
    }, 150);
  }

  // Repaint after the event that caused it has finished moving focus, so the
  // control the keyboard landed on can be found again in the new DOM.
  let paintTimer = null;
  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(() => {
      const active = document.activeElement;
      const focusId = container.contains(active) ? active?.dataset?.focusId || "" : "";
      let caret = null;
      try {
        caret = focusId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
      } catch {
        caret = null; // number and date inputs refuse selection access
      }
      const scrolls = [...container.querySelectorAll("[data-scroll-id]")].map((el) => [el.dataset.scrollId, el.scrollTop]);
      const pageTop = container.scrollTop;
      paint();
      container.scrollTop = pageTop;
      for (const [id, top] of scrolls) {
        const el = container.querySelector(`[data-scroll-id="${id}"]`);
        if (el) el.scrollTop = top;
      }
      const next = focusId ? container.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`) : null;
      if (next) {
        next.focus({ preventScroll: true });
        if (caret) try { next.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      }
    }, 0);
  }

  function change(fn) {
    fn();
    persist();
    schedulePaint();
  }

  function paint() {
    container.innerHTML = "";
    if (draft.stage === "plan" && readyToPlan()) paintPlan();
    else paintSetup();
  }

  function boardEntry(id) {
    return BOARDS.find((b) => String(b.id) === String(id)) || null;
  }

  function sprintName(sprintId) {
    for (const list of sprintLists.values()) {
      const s = [...(list.active || []), ...(list.future || []), ...(list.closed || [])].find(
        (x) => String(x.id) === String(sprintId)
      );
      if (s) return s.name || `Sprint ${sprintId}`;
    }
    return `Sprint ${sprintId}`;
  }

  function sprintById(sprintId) {
    for (const list of sprintLists.values()) {
      const s = [...(list.active || []), ...(list.future || []), ...(list.closed || [])].find(
        (x) => String(x.id) === String(sprintId)
      );
      if (s) return s;
    }
    return null;
  }

  function readyToPlan() {
    return draft.boards.some((b) => b.target) && draft.people.length > 0;
  }

  function savedLabel() {
    const at = Date.parse(draft.updatedAt || "");
    if (!Number.isFinite(at)) return "";
    const d = new Date(at);
    return `Draft saved on this device ${fmtDate(d.toISOString())} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function loadSprintLists() {
    await Promise.all(
      BOARDS.map(async (board) => {
        const id = String(board.id);
        if (sprintLists.has(id) && !sprintLists.get(id).error) return;
        try {
          const [active, future, closed] = await Promise.all([
            getActiveSprint(board.id, creds).catch(() => []),
            getFutureSprints(board.id, creds),
            getClosedSprints(board.id, creds).catch(() => []),
          ]);
          sprintLists.set(id, { active: active || [], future: future || [], closed: closed || [], error: "" });
        } catch (err) {
          sprintLists.set(id, { active: [], future: [], closed: [], error: String(err?.message || err) });
        }
      })
    );
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  function paintSetup() {
    const wrap = document.createElement("div");
    wrap.className = "pl-wrap pl-setup";
    wrap.appendChild(
      viewHeader({
        iconName: "calendar",
        title: "Sprint planner",
        subtitle: "Set up the sprint: boards, people, dates and capacity. Nothing is written to Jira here.",
      })
    );

    wrap.appendChild(section("Boards and sprints", "The sprint to plan into is made in Jira first. Leftovers from the sprints ticked under Carry over are offered before the backlog.", boardsBlock()));
    wrap.appendChild(section("Dates", "Weekdays between the two dates are suggested as working days. Take public holidays off here, or per person below.", datesBlock()));
    wrap.appendChild(section("Buffer for unplanned work", "Held back from everyone's capacity for support and incidents. Override it per person below.", bufferBlock()));
    wrap.appendChild(section("People", "One working day is one story point. A person's days default to the sprint's working days; lower them for leave.", peopleBlock()));

    const bar = document.createElement("div");
    bar.className = "pl-bar";
    const summary = document.createElement("div");
    summary.className = "pl-bar-summary";
    const cap = teamCapacity(draft);
    const targets = targetSprintIds(draft);
    summary.textContent =
      `${draft.people.length} ${draft.people.length === 1 ? "person" : "people"} · ` +
      `${fmtPoints(cap.available)} points of capacity · ` +
      `${targets.length ? targets.map(sprintName).join(", ") : "no sprint chosen"}`;
    const actions = document.createElement("div");
    actions.className = "pl-bar-actions";
    const reset = button("Discard draft", "btn ghost");
    reset.addEventListener("click", async () => {
      if (!confirm("Discard the whole draft — setup, plan and every unpushed change? Nothing in Jira is touched.")) return;
      await clearDraft();
      draft = emptyDraft();
      data.loaded = false;
      paint();
    });
    const go = button("Go to planning screen", "btn primary");
    go.disabled = !readyToPlan();
    go.title = go.disabled ? "Choose at least one sprint to plan into and one person" : "";
    go.addEventListener("click", () => {
      draft.stage = "plan";
      persist();
      paint();
      // Always re-read: setup may have changed which boards and sprints the
      // plan is over since the last visit.
      loadPlanData();
    });
    actions.append(reset, go);
    bar.append(summary, actions);
    wrap.appendChild(bar);
    container.appendChild(wrap);
  }

  function section(title, hint, body) {
    const el = document.createElement("section");
    el.className = "pl-section";
    const h = document.createElement("h2");
    h.className = "pl-section-title";
    h.textContent = title;
    el.appendChild(h);
    if (hint) el.appendChild(note(hint));
    el.appendChild(body);
    return el;
  }

  function boardsBlock() {
    const el = document.createElement("div");
    el.className = "pl-boards";
    if (!BOARDS.length) {
      el.appendChild(note("No boards configured. Add one under Settings → Boards."));
      return el;
    }
    for (const board of BOARDS) {
      const id = String(board.id);
      const entry = draft.boards.find((b) => b.id === id);
      const list = sprintLists.get(id);

      const card = document.createElement("div");
      card.className = `pl-board${entry ? "" : " off"}`;
      card.style.setProperty("--pl-board", board.color || "var(--muted)");

      const head = document.createElement("label");
      head.className = "pl-board-head";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = Boolean(entry);
      box.dataset.focusId = `board-${id}`;
      box.addEventListener("change", () =>
        change(() => {
          if (box.checked) {
            draft.boards.push({ id, target: defaultTarget(list), sources: defaultSources(list) });
            fillDatesFromTargets();
          } else {
            draft.boards = draft.boards.filter((b) => b.id !== id);
          }
        })
      );
      const name = document.createElement("span");
      name.className = "pl-board-name";
      name.textContent = board.name;
      head.append(box, name);
      card.appendChild(head);

      if (entry) {
        if (!list) card.appendChild(note("Reading sprints…"));
        else if (list.error) card.appendChild(note(`Could not read this board's sprints — ${list.error}`));
        else card.appendChild(boardSprints(entry, list));
      }
      el.appendChild(card);
    }
    return el;
  }

  function defaultTarget(list) {
    return String(list?.future?.[0]?.id || "");
  }

  function defaultSources(list) {
    if (list?.active?.length) return list.active.map((s) => String(s.id));
    return (list?.closed || []).slice(0, 1).map((s) => String(s.id));
  }

  function boardSprints(entry, list) {
    const grid = document.createElement("div");
    grid.className = "pl-board-grid";

    const targetRow = document.createElement("label");
    targetRow.className = "pl-field";
    targetRow.appendChild(fieldLabel("Plan into"));
    const select = document.createElement("select");
    select.className = "pl-input";
    select.dataset.focusId = `target-${entry.id}`;
    const none = new Option(list.future.length ? "Choose a sprint…" : "No upcoming sprint — create one in Jira", "");
    select.appendChild(none);
    for (const s of list.future) select.appendChild(new Option(`${s.name}${sprintDates(s)}`, String(s.id)));
    for (const s of list.active) select.appendChild(new Option(`${s.name} (active)${sprintDates(s)}`, String(s.id)));
    select.value = entry.target;
    select.addEventListener("change", () =>
      change(() => {
        entry.target = select.value;
        entry.sources = entry.sources.filter((sid) => sid !== entry.target);
        fillDatesFromTargets(true);
      })
    );
    targetRow.appendChild(select);
    grid.appendChild(targetRow);

    const sources = document.createElement("div");
    sources.className = "pl-field";
    sources.appendChild(fieldLabel("Carry over from"));
    const seen = new Set([entry.target]);
    const offered = [...list.active, ...list.closed.slice(0, CLOSED_OFFERED)].filter((s) => {
      const id = String(s.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!offered.length) sources.appendChild(note("No active or closed sprint on this board."));
    const chips = document.createElement("div");
    chips.className = "pl-chips";
    for (const s of offered) {
      const id = String(s.id);
      const chip = document.createElement("label");
      chip.className = "pl-chip";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = entry.sources.includes(id);
      cb.dataset.focusId = `source-${entry.id}-${id}`;
      cb.addEventListener("change", () =>
        change(() => {
          entry.sources = cb.checked ? [...entry.sources, id] : entry.sources.filter((x) => x !== id);
        })
      );
      const text = document.createElement("span");
      text.textContent = `${s.name}${s.state === "active" ? " (active)" : ""}`;
      chip.append(cb, text);
      chips.appendChild(chip);
    }
    sources.appendChild(chips);
    grid.appendChild(sources);
    return grid;
  }

  function sprintDates(s) {
    return s.startDate ? ` · ${fmtDate(s.startDate)} → ${s.endDate ? fmtDate(s.endDate) : "…"}` : "";
  }

  // The first target sprint with dates sets the planning dates, unless dates
  // are already there — a person who typed dates keeps them.
  function fillDatesFromTargets(force = false) {
    if (draft.start && draft.end && !force) return;
    for (const b of draft.boards) {
      const range = b.target ? sprintDateRange(sprintById(b.target)) : null;
      if (range) {
        draft.start = range.start;
        draft.end = range.end;
        return;
      }
    }
    if (!draft.start || !draft.end) Object.assign(draft, defaultDateRange());
  }

  function datesBlock() {
    const el = document.createElement("div");
    el.className = "pl-row";
    const start = dateInput("Start", draft.start, "start", (v) => { draft.start = v; });
    const end = dateInput("End", draft.end, "end", (v) => { draft.end = v; });
    const suggested = workingDaysBetween(draft.start, draft.end);
    const days = document.createElement("label");
    days.className = "pl-field";
    days.appendChild(fieldLabel("Working days"));
    const input = numberInput(draft.workingDays, suggested, "working-days", (v) => { draft.workingDays = v; }, 1);
    days.appendChild(input);
    el.append(start, end, days);
    const hint = note(
      draft.workingDays === null
        ? `${suggested} weekday${suggested === 1 ? "" : "s"} from ${fmtDate(draft.start)} to ${fmtDate(draft.end)}, both included.`
        : `Set by hand — ${suggested} weekdays between the dates. Clear the field to use that.`
    );
    hint.classList.add("pl-row-note");
    el.appendChild(hint);
    return el;
  }

  function bufferBlock() {
    const el = document.createElement("div");
    el.className = "pl-row";
    const mode = document.createElement("label");
    mode.className = "pl-field";
    mode.appendChild(fieldLabel("Held back as"));
    const select = document.createElement("select");
    select.className = "pl-input";
    select.dataset.focusId = "buffer-mode";
    select.append(new Option("% of each person's days", "percent"), new Option("points per person", "points"));
    select.value = draft.buffer.mode;
    select.addEventListener("change", () => change(() => { draft.buffer.mode = select.value; }));
    mode.appendChild(select);
    const value = document.createElement("label");
    value.className = "pl-field";
    value.appendChild(fieldLabel(draft.buffer.mode === "percent" ? "Percent" : "Points"));
    value.appendChild(
      numberInput(draft.buffer.value, 0, "buffer-value", (v) => { draft.buffer.value = v ?? 0; }, draft.buffer.mode === "percent" ? 5 : 0.25)
    );
    el.append(mode, value);
    const example = personCapacity({ workingDays: teamCapacity(draft).workingDays, buffer: draft.buffer });
    const hint = note(`With ${fmtPoints(example.base)} working days that leaves ${fmtPoints(example.available)} points each.`);
    hint.classList.add("pl-row-note");
    el.appendChild(hint);
    return el;
  }

  // Everyone offered: the roster's active members, then anyone already in the
  // draft who has left it, then — with no roster — people found on the boards.
  function offeredPeople() {
    const out = new Map();
    for (const m of activeMembers()) {
      out.set(m.accountId, { accountId: m.accountId, name: memberLabel(m), avatar: memberAvatar(m.accountId) });
    }
    for (const p of draft.people) {
      if (!out.has(p.accountId)) out.set(p.accountId, { accountId: p.accountId, name: p.name || p.accountId, avatar: memberAvatar(p.accountId) });
    }
    for (const h of ui.harvested) {
      if (!out.has(h.accountId)) out.set(h.accountId, { accountId: h.accountId, name: shortenName(h.displayName), avatar: h.avatarUrl || "" });
    }
    return [...out.values()];
  }

  function peopleBlock() {
    const el = document.createElement("div");
    const offered = offeredPeople();
    const cap = teamCapacity(draft);

    if (!offered.length) {
      el.appendChild(note("There is no team roster to plan for. Add people under Settings → Team, or find everyone holding work on the chosen boards."));
      const find = button("Find people on these boards", "btn small");
      find.disabled = !draft.boards.length;
      find.addEventListener("click", async () => {
        find.disabled = true;
        find.textContent = "Looking…";
        try {
          const boards = draft.boards.map((b) => boardEntry(b.id)).filter(Boolean);
          ui.harvested = await harvestTeamCandidates(creds, boards);
        } catch (err) {
          showToast(`Could not read the boards' people — ${err.message || err}`, true);
        }
        paint();
      });
      el.appendChild(find);
      return el;
    }

    const table = document.createElement("div");
    table.className = "pl-people";
    const head = document.createElement("div");
    head.className = "pl-people-row pl-people-head";
    for (const t of ["", "Person", "Days", "Buffer", "Capacity"]) {
      const c = document.createElement("span");
      c.textContent = t;
      head.appendChild(c);
    }
    table.appendChild(head);

    const bufferUnit = draft.buffer.mode === "percent" ? "%" : "pt";
    for (const person of offered) {
      const planned = draft.people.find((p) => p.accountId === person.accountId);
      const row = document.createElement("div");
      row.className = `pl-people-row${planned ? "" : " off"}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(planned);
      cb.dataset.focusId = `person-${person.accountId}`;
      cb.setAttribute("aria-label", `Plan for ${person.name}`);
      cb.addEventListener("change", () =>
        change(() => {
          if (cb.checked) draft.people.push({ accountId: person.accountId, name: person.name, days: null, buffer: null });
          else draft.people = draft.people.filter((p) => p.accountId !== person.accountId);
        })
      );

      const who = document.createElement("span");
      who.className = "pl-person-name";
      who.append(avatar(person.accountId, person.name, 22, person.avatar), document.createTextNode(person.name));

      const days = planned
        ? numberInput(planned.days, cap.workingDays, `days-${person.accountId}`, (v) => { planned.days = v; }, 0.25)
        : document.createElement("span");
      const buf = planned
        ? numberInput(planned.buffer, draft.buffer.value, `buffer-${person.accountId}`, (v) => { planned.buffer = v; }, draft.buffer.mode === "percent" ? 5 : 0.25)
        : document.createElement("span");
      if (planned) {
        days.setAttribute("aria-label", `${person.name}: days available`);
        buf.setAttribute("aria-label", `${person.name}: buffer in ${bufferUnit}`);
      }
      const capEl = document.createElement("span");
      capEl.className = "pl-person-cap mono";
      if (planned) {
        const c = cap.byPerson.get(person.accountId);
        capEl.textContent = `${fmtPoints(c.available)} pt`;
        capEl.title = `${fmtPoints(c.base)} days − ${fmtPoints(c.buffer)} buffer`;
      }
      row.append(cb, who, days, buf, capEl);
      table.appendChild(row);
    }
    el.appendChild(table);
    el.appendChild(note(`Buffer is in ${draft.buffer.mode === "percent" ? "percent of a person's days" : "points"}; blank takes the team's.`));
    return el;
  }

  function dateInput(label, value, focusId, set) {
    const wrap = document.createElement("label");
    wrap.className = "pl-field";
    wrap.appendChild(fieldLabel(label));
    const input = document.createElement("input");
    input.type = "date";
    input.className = "pl-input";
    input.value = value || "";
    input.dataset.focusId = focusId;
    input.addEventListener("change", () => change(() => set(input.value)));
    wrap.appendChild(input);
    return wrap;
  }

  // Blank means "use the default", shown as the placeholder — so an override is
  // visibly an override and clearing it is how it is undone.
  function numberInput(value, placeholder, focusId, set, step = 1) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = String(step);
    input.inputMode = "decimal";
    input.className = "pl-input pl-num";
    input.value = value === null || value === undefined ? "" : String(value);
    input.placeholder = placeholder === null || placeholder === undefined ? "" : fmtPoints(placeholder);
    input.dataset.focusId = focusId;
    input.addEventListener("change", () => change(() => set(parsePoints(input.value))));
    return input;
  }

  // ── Plan ──────────────────────────────────────────────────────────────────

  // Reads are queued rather than dropped: the review has to see a read that
  // started after it was opened, not one that was already half done.
  let loadChain = Promise.resolve();
  function loadPlanData(opts = {}) {
    loadChain = loadChain.then(() => readPlanData(opts));
    return loadChain;
  }

  async function readPlanData({ fresh = false } = {}) {
    data.loading = true;
    data.error = "";
    schedulePaint();
    try {
      await loadSprintLists();
      const boards = draft.boards.map((b) => ({ entry: b, board: boardEntry(b.id) })).filter((x) => x.board);
      if (fresh) {
        for (const { board } of boards) await cache.dropBoard(board.id);
      }
      const issues = new Map();
      const keep = (list) => {
        for (const issue of list) if (issue?.key && !issues.has(issue.key)) issues.set(issue.key, issue);
      };

      const inTarget = new Map();
      const targetLists = await Promise.all(
        boards.filter((x) => x.entry.target).map(async ({ entry, board }) => {
          const list = await getSprintIssues(board.id, entry.target, creds);
          return { sprintId: entry.target, list };
        })
      );
      for (const { sprintId, list } of targetLists) {
        if (!inTarget.has(sprintId)) inTarget.set(sprintId, new Set());
        for (const issue of list) inTarget.get(sprintId).add(issue.key);
        keep(list);
      }

      const carry = (
        await Promise.all(
          boards.flatMap(({ entry, board }) =>
            entry.sources.map((sid) => getSprintIssues(board.id, sid, creds).catch(() => []))
          )
        )
      ).flat();
      keep(carry);

      const backlog = (await Promise.all(boards.map(({ board }) => getBoardBacklog(board.id, creds).catch(() => [])))).flat();
      keep(backlog);

      // Anything the draft names that none of the lists above held: issues added
      // by key, and planned issues that have since moved somewhere else.
      const named = new Set([...draft.extraKeys, ...Object.keys(draft.added), ...Object.keys(draft.edits), ...draft.removed]);
      const missing = [...named].filter((k) => !issues.has(k));
      const found = missing.length ? await getIssuesByKeys(missing, creds).catch(() => []) : [];
      keep(found);

      data.issues = issues;
      data.inTarget = inTarget;
      data.carryover = carry;
      data.backlog = backlog;
      data.extra = draft.extraKeys.map((k) => issues.get(k)).filter(Boolean);
      data.epicNames = await getEpicNames(creds).catch(() => ({}));
      data.readAt = new Date();
      data.loaded = true;
    } catch (err) {
      data.error = String(err?.message || err);
    } finally {
      data.loading = false;
      schedulePaint();
    }
  }

  function targetKeys() {
    const all = new Set();
    for (const set of data.inTarget.values()) for (const k of set) all.add(k);
    return all;
  }

  function plannedIssues() {
    const inT = targetKeys();
    const keys = new Set([...[...inT].filter((k) => !draft.removed.includes(k)), ...Object.keys(draft.added)]);
    // Sub-tasks come back with their sprint but move and are estimated with
    // their parent, so they are not rows of the plan.
    return [...keys].map((k) => data.issues.get(k)).filter((i) => i && !isSubtask(i));
  }

  function paintPlan() {
    const wrap = document.createElement("div");
    wrap.className = "pl-wrap pl-plan";

    const cap = teamCapacity(draft);
    const planned = plannedIssues();
    const tally = tallies(draft, planned);
    const left = round(cap.available - tally.points);
    const targets = targetSprintIds(draft);

    wrap.appendChild(
      viewHeader({
        iconName: "calendar",
        title: "Sprint planner",
        subtitle: [
          targets.map(sprintName).join(" · "),
          draft.start && draft.end ? `${fmtDate(draft.start)} → ${fmtDate(draft.end)}` : "",
          `${fmtPoints(cap.workingDays)} working days`,
        ].filter(Boolean).join(" · "),
        right: viewTiles([
          { num: fmtPoints(cap.available), label: "capacity", tone: "total" },
          { num: fmtPoints(tally.points), label: "planned", tone: "blue" },
          { num: fmtPoints(Math.abs(left)), label: left < 0 ? "over" : "free", tone: left < 0 ? "red" : "green" },
          { num: tally.issues, label: tally.issues === 1 ? "issue" : "issues", tone: "gray" },
        ]),
      })
    );

    const toolbar = document.createElement("div");
    toolbar.className = "pl-toolbar";
    const back = button("← Setup", "btn small ghost");
    back.addEventListener("click", () => change(() => { draft.stage = "config"; }));
    const refresh = button(data.loading ? "Refreshing…" : "Refresh tasks", "btn small");
    refresh.disabled = data.loading;
    refresh.title = "Re-read the sprints and backlogs from Jira. The draft is kept.";
    refresh.addEventListener("click", () => loadPlanData({ fresh: true }));
    const saved = document.createElement("span");
    saved.className = "pl-saved";
    saved.textContent = savedLabel();
    const read = document.createElement("span");
    read.className = "pl-saved";
    if (data.readAt) read.textContent = `· read from Jira ${String(data.readAt.getHours()).padStart(2, "0")}:${String(data.readAt.getMinutes()).padStart(2, "0")}`;
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    const pending = pendingCount();
    const push = button(pending ? `Review & push ${pending} change${pending === 1 ? "" : "s"}` : "Review & push", "btn primary");
    push.disabled = !data.loaded || data.loading;
    push.addEventListener("click", openReview);
    toolbar.append(back, refresh, saved, read, spacer, push);
    wrap.appendChild(toolbar);

    if (data.error) wrap.appendChild(note(`Could not read Jira — ${data.error}`, "pl-error"));

    wrap.appendChild(peopleStrip(cap, tally));

    if (!data.loaded) {
      const loading = document.createElement("div");
      loading.className = "pl-loading";
      loading.appendChild(document.createElement("div")).className = "spinner";
      wrap.appendChild(loading);
      container.appendChild(wrap);
      return;
    }

    const cols = document.createElement("div");
    cols.className = "pl-cols";
    cols.append(candidatesColumn(), planColumn(planned, tally));
    wrap.appendChild(cols);
    container.appendChild(wrap);
  }

  function pendingCount() {
    return Object.keys(draft.added).length + draft.removed.length + Object.keys(draft.edits).length;
  }

  function peopleStrip(cap, tally) {
    const strip = document.createElement("div");
    strip.className = "pl-strip";
    for (const p of draft.people) {
      const c = cap.byPerson.get(p.accountId) || { available: 0, base: 0, buffer: 0 };
      const t = tally.people.get(p.accountId) || { points: 0, issues: 0, missing: 0 };
      const { ratio, band } = loadBand(t.points, c.available);
      const diff = round(c.available - t.points);

      const card = document.createElement("button");
      card.type = "button";
      card.className = `pl-person band-${band}${ui.person === p.accountId ? " selected" : ""}`;
      card.dataset.focusId = `strip-${p.accountId}`;
      card.title = `${personName(p)} — ${fmtPoints(c.base)} days − ${fmtPoints(c.buffer)} buffer = ${fmtPoints(c.available)} points. Click to show only their plan; drop a card here to give it to them.`;
      card.addEventListener("click", () => change(() => { ui.person = ui.person === p.accountId ? "" : p.accountId; }));
      dropTarget(card, (key) => tryAdd(data.issues.get(key), { assignee: p.accountId }));

      const top = document.createElement("div");
      top.className = "pl-person-top";
      const nm = document.createElement("span");
      nm.className = "pl-person-label";
      nm.textContent = personName(p);
      top.append(avatar(p.accountId, personName(p), 34), nm);
      card.appendChild(top);

      const figures = document.createElement("div");
      figures.className = "pl-person-figures mono";
      const assigned = document.createElement("span");
      assigned.textContent = `${fmtPoints(t.points)} / ${fmtPoints(c.available)}`;
      const d = document.createElement("span");
      d.className = `pl-diff ${diff < 0 ? "neg" : "pos"}`;
      d.textContent = diff < 0 ? `${fmtPoints(-diff)} over` : `${fmtPoints(diff)} free`;
      figures.append(assigned, d);
      card.appendChild(figures);

      const bar = document.createElement("div");
      bar.className = "pl-meter";
      bar.setAttribute("role", "meter");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(c.available));
      bar.setAttribute("aria-valuenow", String(t.points));
      bar.setAttribute("aria-label", `${personName(p)}: ${fmtPoints(t.points)} of ${fmtPoints(c.available)} points`);
      const fill = document.createElement("span");
      fill.style.transform = `scaleX(${Math.min(1, Number.isFinite(ratio) ? ratio : 1)})`;
      bar.appendChild(fill);
      card.appendChild(bar);

      const foot = document.createElement("div");
      foot.className = "pl-person-foot";
      const pct = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "no capacity";
      foot.textContent = `${t.issues} issue${t.issues === 1 ? "" : "s"} · ${pct}${band === "over" ? " — over 120%" : band === "full" ? " — over 100%" : ""}`;
      card.appendChild(foot);
      strip.appendChild(card);
    }
    if (tally.others.issues) {
      const card = document.createElement("div");
      card.className = "pl-person pl-person-others";
      const nm = document.createElement("div");
      nm.className = "pl-person-label";
      nm.textContent = "Someone else or no one";
      const fig = document.createElement("div");
      fig.className = "pl-person-figures mono";
      fig.textContent = `${fmtPoints(tally.others.points)} pt`;
      const foot = document.createElement("div");
      foot.className = "pl-person-foot";
      foot.textContent = `${tally.others.issues} issue${tally.others.issues === 1 ? "" : "s"} unassigned or held by people outside this plan — counted in the total, not in anyone's capacity`;
      card.append(nm, fig, foot);
      strip.appendChild(card);
    }
    return strip;
  }

  function candidatesColumn() {
    const col = document.createElement("section");
    col.className = "pl-col pl-candidates";
    dropTarget(col, (key) => {
      const issue = data.issues.get(key);
      if (issue && isPlanned(draft, issue, targetKeys())) change(() => removeFromPlan(draft, issue, targetKeys()));
    });

    const head = document.createElement("div");
    head.className = "pl-col-head";
    const h = document.createElement("h2");
    h.textContent = "Candidates";
    head.appendChild(h);
    col.appendChild(head);

    const inT = targetKeys();
    const { carryover, backlog } = splitCandidates({
      carryover: data.carryover,
      backlog: data.backlog,
      extra: data.extra,
      isInPlan: (issue) => isPlanned(draft, issue, inT),
    });

    const all = [...carryover, ...backlog];
    col.appendChild(filtersBar(all));
    col.appendChild(addByKey());
    col.appendChild(epicsPanel());

    const list = document.createElement("div");
    list.className = "pl-list";
    list.dataset.scrollId = "candidates";

    const shownCarry = filterCandidates(carryover, ui.filters);
    const shownBacklog = filterCandidates(backlog, ui.filters);

    const carryBox = document.createElement("div");
    carryBox.className = "pl-carry";
    const carryHead = document.createElement("div");
    carryHead.className = "pl-group-head";
    carryHead.textContent = `Left over from ${sourceNames() || "the chosen sprints"} · ${shownCarry.length}${shownCarry.length !== carryover.length ? ` of ${carryover.length}` : ""}`;
    carryBox.appendChild(carryHead);
    if (!carryover.length) carryBox.appendChild(note(draft.boards.some((b) => b.sources.length) ? "Nothing open is left over." : "No sprint ticked under Carry over in setup."));
    for (const issue of shownCarry) carryBox.appendChild(candidateCard(issue, { carry: true }));
    list.appendChild(carryBox);

    const backHead = document.createElement("div");
    backHead.className = "pl-group-head";
    backHead.textContent = `Backlog · ${shownBacklog.length}${shownBacklog.length !== backlog.length ? ` of ${backlog.length}` : ""}`;
    list.appendChild(backHead);
    if (!shownBacklog.length) list.appendChild(note(backlog.length ? "Nothing matches the filters." : "The backlog is empty."));
    for (const issue of shownBacklog) list.appendChild(candidateCard(issue, { carry: false }));
    col.appendChild(list);
    return col;
  }

  function sourceNames() {
    return draft.boards.flatMap((b) => b.sources).map(sprintName).join(", ");
  }

  function filtersBar(issues) {
    const bar = document.createElement("div");
    bar.className = "pl-filters";
    const opts = filterOptions(issues);
    const remaining = epicRemaining([...data.issues.values()]);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "pl-input";
    search.placeholder = "Filter by key or summary";
    search.value = ui.filters.text;
    search.dataset.focusId = "filter-text";
    search.setAttribute("aria-label", "Filter candidates by key or summary");
    search.addEventListener("input", () => {
      ui.filters.text = search.value;
      schedulePaint();
    });

    const epic = select("Epic", [
      ["", "All epics"],
      ["__none__", "No epic"],
      ...opts.epics.map((k) => {
        const r = remaining.get(k);
        return [k, `${epicLabel(k)}${r ? ` — ${r.open} open, ${fmtPoints(r.points)} pt` : ""}`];
      }),
    ], ui.filters.epic, "filter-epic", (v) => { ui.filters.epic = v; });
    const label = select("Label", [["", "All labels"], ...opts.labels.map((l) => [l, l])], ui.filters.label, "filter-label", (v) => { ui.filters.label = v; });
    const priority = select("Priority", [["", "All priorities"], ...opts.priorities.map((p) => [p, p])], ui.filters.priority, "filter-priority", (v) => { ui.filters.priority = v; });
    bar.append(search, epic, label, priority);
    return bar;
  }

  function select(label, options, value, focusId, set) {
    const el = document.createElement("select");
    el.className = "pl-input";
    el.dataset.focusId = focusId;
    el.setAttribute("aria-label", label);
    for (const [v, text] of options) el.appendChild(new Option(text, v));
    el.value = value;
    el.addEventListener("change", () => {
      set(el.value);
      schedulePaint();
    });
    return el;
  }

  function epicLabel(key) {
    const name = data.epicNames?.[key];
    return name ? `${key} ${name}` : key;
  }

  function epicsPanel() {
    const remaining = epicRemaining([...data.issues.values()]);
    const details = document.createElement("details");
    details.className = "pl-epics";
    details.open = ui.epicsOpen === true;
    details.addEventListener("toggle", () => { ui.epicsOpen = details.open; });
    const summary = document.createElement("summary");
    summary.textContent = `Epics — remaining work on these boards · ${remaining.size}`;
    details.appendChild(summary);
    if (!remaining.size) details.appendChild(note("No open issue here belongs to an epic."));
    const rows = [...remaining.entries()].sort((a, b) => b[1].points - a[1].points);
    for (const [key, r] of rows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `pl-epic${ui.filters.epic === key ? " active" : ""}`;
      row.dataset.focusId = `epic-${key}`;
      const name = document.createElement("span");
      name.className = "pl-epic-name";
      name.textContent = epicLabel(key);
      const fig = document.createElement("span");
      fig.className = "mono";
      fig.textContent = `${r.open} open · ${fmtPoints(r.points)} pt${r.unestimated ? ` · ${r.unestimated} unestimated` : ""}`;
      row.append(name, fig);
      row.title = ui.filters.epic === key ? "Show every epic" : "Show only this epic's issues";
      row.addEventListener("click", () => {
        ui.filters.epic = ui.filters.epic === key ? "" : key;
        schedulePaint();
      });
      details.appendChild(row);
    }
    return details;
  }

  function addByKey() {
    const form = document.createElement("form");
    form.className = "pl-addkey";
    const input = document.createElement("input");
    input.className = "pl-input";
    input.placeholder = "Add an issue from any board — key or link";
    input.dataset.focusId = "add-key";
    input.setAttribute("aria-label", "Issue key or Jira link to add to the candidates");
    const go = button("Add", "btn small");
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = parseIssueRef(input.value);
      if (!key) {
        showToast("That is not an issue key or an issue link", true);
        return;
      }
      if (data.issues.has(key) && !draft.extraKeys.includes(key)) {
        showToast(`${key} is already on the list`);
        ui.filters = { epic: "", label: "", priority: "", text: key };
        schedulePaint();
        return;
      }
      go.disabled = true;
      try {
        const [issue] = await getIssuesByKeys([key], creds);
        if (!issue) {
          showToast(`${key} was not found, or this account cannot see it`, true);
          return;
        }
        // Jira answers an old key with the issue's current one when it has
        // moved project, so the key it sends back is the one kept.
        const real = issue.key;
        data.issues.set(real, issue);
        if (!data.extra.some((i) => i.key === real)) data.extra.push(issue);
        change(() => {
          if (!draft.extraKeys.includes(real)) draft.extraKeys.push(real);
        });
        showToast(real === key ? `${real} added to the candidates` : `${key} is now ${real} — added to the candidates`);
      } catch (err) {
        showToast(`Could not read ${key} — ${err.message || err}`, true);
      } finally {
        go.disabled = false;
      }
    });
    return form;
  }

  function candidateCard(issue, { carry }) {
    const card = issueCard(issue);
    card.classList.add("pl-candidate");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", issue.key);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    const actions = document.createElement("div");
    actions.className = "pl-card-actions";
    if (draft.extraKeys.includes(issue.key)) {
      const tag = document.createElement("span");
      tag.className = "pl-tag mono";
      tag.textContent = "added by key";
      actions.appendChild(tag);
      const drop = iconButton("close", `Take ${issue.key} off the candidates`, () =>
        change(() => {
          draft.extraKeys = draft.extraKeys.filter((k) => k !== issue.key);
          data.extra = data.extra.filter((i) => i.key !== issue.key);
        })
      );
      actions.appendChild(drop);
    }
    if (carry) {
      const split = button("Split", "btn small ghost");
      split.title = `Close ${issue.key} as done and continue it in a new issue`;
      split.addEventListener("click", () => openSplit(issue));
      actions.appendChild(split);
    }
    const add = button("Add →", "btn small");
    add.dataset.focusId = `add-${issue.key}`;
    add.title = "Add to the sprint plan";
    add.addEventListener("click", () => tryAdd(issue));
    actions.appendChild(add);
    card.appendChild(actions);
    return card;
  }

  // The card both lists share. Unestimated cards are marked red all over, as
  // the author asked — an estimate is the thing that has to happen before a
  // card can move.
  function issueCard(issue) {
    const f = issue.fields || {};
    const eff = effective(draft, issue);
    const card = document.createElement("article");
    card.className = "pl-card";
    card.dataset.issueKey = issue.key;
    if (!(Number(eff.points) > 0)) card.classList.add("unestimated");

    const top = document.createElement("div");
    top.className = "pl-card-top";
    const key = document.createElement("a");
    key.className = "issue-key";
    key.style.color = boardColor(issue.boardId);
    key.textContent = issue.key;
    attachIssueOpener(key, issue.key, creds);
    top.appendChild(key);
    const pIcon = priorityIcon(f.priority?.name);
    if (pIcon) top.appendChild(pIcon);
    const status = document.createElement("span");
    status.className = `pl-status tone-${statusTone(f.status)}`;
    status.textContent = f.status?.name || "—";
    top.appendChild(status);
    const epicKey = getEpicKey(issue);
    if (epicKey) {
      const epic = document.createElement("span");
      epic.className = "pl-epic-tag";
      epic.textContent = data.epicNames?.[epicKey] || epicKey;
      epic.title = `Epic ${epicLabel(epicKey)}`;
      top.appendChild(epic);
    }
    card.appendChild(top);

    const summary = document.createElement("div");
    summary.className = "pl-card-summary";
    summary.textContent = f.summary || "";
    card.appendChild(summary);

    const foot = document.createElement("div");
    foot.className = "pl-card-foot";
    if (eff.assignee) {
      foot.appendChild(avatar(eff.assignee, nameFor(eff.assignee, issue), 18));
      const nm = document.createElement("span");
      nm.className = "pl-card-who";
      nm.textContent = nameFor(eff.assignee, issue);
      foot.appendChild(nm);
    } else {
      const nm = document.createElement("span");
      nm.className = "pl-card-who muted";
      nm.textContent = "Unassigned";
      foot.appendChild(nm);
    }
    if (f.duedate) {
      const due = document.createElement("span");
      due.className = `pl-due mono${isOverdue(issue) ? " overdue" : ""}`;
      due.textContent = `${isOverdue(issue) ? "overdue " : "due "}${fmtDate(f.duedate)}`;
      foot.appendChild(due);
    }
    foot.appendChild(pointsField(issue));
    card.appendChild(foot);
    return card;
  }

  // Estimating in line. Kept in the draft and written with the push, like
  // everything else on this screen.
  function pointsField(issue) {
    const eff = effective(draft, issue);
    const wrap = document.createElement("label");
    wrap.className = "pl-points";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.25";
    input.inputMode = "decimal";
    input.className = "pl-input pl-num";
    input.value = eff.points === null || eff.points === undefined ? "" : String(eff.points);
    input.placeholder = "SP";
    input.dataset.focusId = `points-${issue.key}`;
    input.setAttribute("aria-label", `${issue.key} story points`);
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", () => change(() => setEdit(draft, issue, { points: parsePoints(input.value) })));
    const unit = document.createElement("span");
    unit.className = "mono";
    unit.textContent = "SP";
    wrap.append(input, unit);
    if (draft.edits[issue.key] && "points" in draft.edits[issue.key]) wrap.classList.add("edited");
    return wrap;
  }

  function planColumn(planned, tally) {
    const col = document.createElement("section");
    col.className = "pl-col pl-sprint";
    dropTarget(col, (key) => tryAdd(data.issues.get(key)));

    const head = document.createElement("div");
    head.className = "pl-col-head";
    const h = document.createElement("h2");
    h.textContent = "Sprint plan";
    head.appendChild(h);
    const fig = document.createElement("span");
    fig.className = "pl-col-fig mono";
    fig.textContent = `${fmtPoints(tally.points)} pt · ${tally.issues} issue${tally.issues === 1 ? "" : "s"}`;
    head.appendChild(fig);
    if (ui.person) {
      const clear = button(`Showing ${personName(draft.people.find((p) => p.accountId === ui.person) || {})} — show everyone`, "btn small ghost");
      clear.addEventListener("click", () => change(() => { ui.person = ""; }));
      head.appendChild(clear);
    }
    col.appendChild(head);

    const list = document.createElement("div");
    list.className = "pl-list";
    list.dataset.scrollId = "plan";
    if (!planned.length) {
      const empty = document.createElement("div");
      empty.className = "pl-empty";
      empty.textContent = "Drag cards here, onto a person above, or use Add →.";
      list.appendChild(empty);
    }

    // Grouped by person, in the plan's order, then anyone else.
    const groups = new Map(draft.people.map((p) => [p.accountId, []]));
    const others = [];
    for (const issue of planned) {
      const who = effective(draft, issue).assignee;
      (who && groups.has(who) ? groups.get(who) : others).push(issue);
    }
    for (const p of draft.people) {
      if (ui.person && ui.person !== p.accountId) continue;
      const issues = groups.get(p.accountId);
      if (!issues.length) continue;
      const t = tally.people.get(p.accountId);
      list.appendChild(groupHead(`${personName(p)} · ${fmtPoints(t.points)} pt · ${issues.length}`));
      for (const issue of issues) list.appendChild(planRow(issue));
    }
    if (others.length && !ui.person) {
      list.appendChild(groupHead(`Someone else or no one · ${others.length}`));
      for (const issue of others) list.appendChild(planRow(issue));
    }

    const removed = draft.removed.map((k) => data.issues.get(k)).filter(Boolean);
    if (removed.length && !ui.person) {
      list.appendChild(groupHead(`Taken out — back to the backlog on push · ${removed.length}`));
      for (const issue of removed) {
        const row = document.createElement("div");
        row.className = "pl-removed";
        const key = document.createElement("span");
        key.className = "mono";
        key.textContent = issue.key;
        const s = document.createElement("span");
        s.className = "pl-card-summary";
        s.textContent = issue.fields?.summary || "";
        const undo = button("Keep", "btn small ghost");
        undo.addEventListener("click", () => change(() => addToPlan(draft, issue, targetKeys())));
        row.append(key, s, undo);
        list.appendChild(row);
      }
    }
    col.appendChild(list);
    return col;
  }

  function groupHead(text) {
    const el = document.createElement("div");
    el.className = "pl-group-head";
    el.textContent = text;
    return el;
  }

  function planRow(issue) {
    const card = issueCard(issue);
    card.classList.add("pl-planned");
    const missing = missingForCommit(draft, issue);
    if (missing.includes("assignee")) card.classList.add("unassigned");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", issue.key);
      e.dataTransfer.effectAllowed = "move";
    });

    const actions = document.createElement("div");
    actions.className = "pl-card-actions";
    if (draft.added[issue.key]) {
      const tag = document.createElement("span");
      tag.className = "pl-tag mono";
      tag.textContent = "moving in";
      actions.appendChild(tag);
    }

    const who = document.createElement("select");
    who.className = "pl-input";
    who.dataset.focusId = `who-${issue.key}`;
    who.setAttribute("aria-label", `${issue.key} assignee`);
    const eff = effective(draft, issue);
    if (!eff.assignee) who.appendChild(new Option("Choose someone…", ""));
    for (const p of draft.people) who.appendChild(new Option(personName(p), p.accountId));
    if (eff.assignee && !draft.people.some((p) => p.accountId === eff.assignee)) {
      who.appendChild(new Option(nameFor(eff.assignee, issue), eff.assignee));
    }
    who.value = eff.assignee || "";
    who.addEventListener("change", () => change(() => setEdit(draft, issue, { assignee: who.value || null })));
    actions.appendChild(who);

    const targets = targetSprintIds(draft);
    if (draft.added[issue.key] && targets.length > 1) {
      const sprintSel = document.createElement("select");
      sprintSel.className = "pl-input";
      sprintSel.dataset.focusId = `sprint-${issue.key}`;
      sprintSel.setAttribute("aria-label", `${issue.key} target sprint`);
      for (const id of targets) sprintSel.appendChild(new Option(sprintName(id), id));
      sprintSel.value = draft.added[issue.key];
      sprintSel.addEventListener("change", () => change(() => { draft.added[issue.key] = sprintSel.value; }));
      actions.appendChild(sprintSel);
    }

    actions.appendChild(
      iconButton("close", `Take ${issue.key} out of the plan`, () => change(() => removeFromPlan(draft, issue, targetKeys())))
    );
    card.appendChild(actions);
    return card;
  }

  // ── Adding: the one gate every route into the plan goes through ───────────

  function tryAdd(issue, { assignee = undefined } = {}) {
    if (!issue) return;
    const inT = targetKeys();
    const preset = assignee !== undefined && assignee !== effective(draft, issue).assignee ? { assignee } : {};
    const probe = structuredClone({ edits: draft.edits, baseline: draft.baseline });
    const scratch = { ...draft, edits: probe.edits, baseline: probe.baseline };
    if (Object.keys(preset).length) setEdit(scratch, issue, preset);
    const missing = missingForCommit(scratch, issue);
    if (!missing.length) {
      change(() => {
        if (Object.keys(preset).length) setEdit(draft, issue, preset);
        addToPlan(draft, issue, inT);
      });
      if (preset.assignee) showToast(`${issue.key} → ${nameFor(preset.assignee, issue)} (on push)`);
      return;
    }
    openAddDialog(issue, { preset, missing });
  }

  function openAddDialog(issue, { preset, missing }) {
    const eff = effective(draft, issue);
    const { dialog, body, actions, close } = openDialog(`Add ${issue.key} to the sprint`);
    const intro = document.createElement("p");
    intro.className = "pl-dialog-text";
    intro.textContent = issue.fields?.summary || "";
    body.appendChild(intro);
    body.appendChild(note("Nothing joins the plan without an assignee and an estimate."));

    const who = document.createElement("select");
    who.className = "pl-input";
    who.required = true;
    who.appendChild(new Option("Choose someone…", ""));
    for (const p of draft.people) who.appendChild(new Option(personName(p), p.accountId));
    who.value = preset.assignee ?? (draft.people.some((p) => p.accountId === eff.assignee) ? eff.assignee : "");
    const whoRow = document.createElement("label");
    whoRow.className = "pl-field";
    whoRow.append(fieldLabel("Assignee"), who);

    const points = document.createElement("input");
    points.type = "number";
    points.min = "0.25";
    points.step = "0.25";
    points.inputMode = "decimal";
    points.required = true;
    points.className = "pl-input pl-num";
    points.value = Number(eff.points) > 0 ? String(eff.points) : "";
    points.placeholder = "2";
    const pointsRow = document.createElement("label");
    pointsRow.className = "pl-field";
    pointsRow.append(fieldLabel("Story points (1 = one day)"), points);
    body.append(whoRow, pointsRow);

    const ok = button("Add to plan", "btn primary");
    ok.type = "submit";
    const cancel = button("Cancel", "btn ghost");
    cancel.addEventListener("click", close);
    actions.append(cancel, ok);

    const validate = () => {
      ok.disabled = !who.value || !(parsePoints(points.value) > 0);
    };
    who.addEventListener("change", validate);
    points.addEventListener("input", validate);
    validate();
    (missing.includes("assignee") && !who.value ? who : points).focus();

    dialog.addEventListener("submit", (e) => {
      e.preventDefault();
      const p = parsePoints(points.value);
      if (!who.value || !(p > 0)) return;
      change(() => {
        setEdit(draft, issue, { assignee: who.value, points: p });
        addToPlan(draft, issue, targetKeys());
      });
      close();
    });
  }

  // ── Split ─────────────────────────────────────────────────────────────────

  function openSplit(issue) {
    const eff = effective(draft, issue);
    const { dialog, body, actions, close } = openDialog(`Split ${issue.key}`);
    const newSummary = splitSummary(issue.fields?.summary);
    const list = document.createElement("ol");
    list.className = "pl-dialog-list";
    for (const line of [
      `Create “${newSummary}” in ${String(issue.key).split("-")[0]}, as a new ${issue.fields?.issuetype?.name || "issue"} in its first status`,
      `Link it to ${issue.key}`,
      `Move ${issue.key} to Done`,
    ]) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    body.appendChild(note("These three writes happen as soon as you confirm — not with the push — so the new issue exists to be planned."));
    body.appendChild(list);

    const who = document.createElement("select");
    who.className = "pl-input";
    who.appendChild(new Option("Choose someone…", ""));
    for (const p of draft.people) who.appendChild(new Option(personName(p), p.accountId));
    who.value = draft.people.some((p) => p.accountId === eff.assignee) ? eff.assignee : "";
    const whoRow = document.createElement("label");
    whoRow.className = "pl-field";
    whoRow.append(fieldLabel("pt.2 assignee"), who);
    const points = document.createElement("input");
    points.type = "number";
    points.min = "0";
    points.step = "0.25";
    points.inputMode = "decimal";
    points.className = "pl-input pl-num";
    points.placeholder = "remaining";
    const pointsRow = document.createElement("label");
    pointsRow.className = "pl-field";
    pointsRow.append(fieldLabel("pt.2 story points"), points);
    const planIt = document.createElement("label");
    planIt.className = "pl-check";
    const planBox = document.createElement("input");
    planBox.type = "checkbox";
    planBox.checked = true;
    planIt.append(planBox, document.createTextNode(" Put pt.2 in this sprint's plan"));
    body.append(whoRow, pointsRow, planIt);
    body.appendChild(note("The assignee and estimate are set on pt.2 with the push, like every other change here."));

    const status = document.createElement("div");
    status.className = "pl-dialog-status";
    body.appendChild(status);

    const ok = button("Split in Jira", "btn primary");
    ok.type = "submit";
    const cancel = button("Cancel", "btn ghost");
    cancel.addEventListener("click", close);
    actions.append(cancel, ok);

    dialog.addEventListener("submit", async (e) => {
      e.preventDefault();
      ok.disabled = true;
      cancel.disabled = true;
      const say = (text, bad = false) => {
        status.textContent = text;
        status.classList.toggle("bad", bad);
      };
      let created = null;
      try {
        say("Creating pt.2…");
        created = await createWithParentFallback(issue);
        say(`Created ${created.key}. Linking…`);
        let linkNote = "";
        try {
          const type = splitLinkType(await getIssueLinkTypes(creds));
          const payload = type
            ? linkPayloadFor({ typeName: type.name, direction: "outward" }, { issueKey: created.key, otherKey: issue.key })
            : null;
          if (payload) await createIssueLink(payload, creds);
          else linkNote = " — this site has no link type, so it was not linked";
        } catch (err) {
          linkNote = ` — the link failed: ${err.message || err}`;
        }
        say(`Created ${created.key}${linkNote}. Moving ${issue.key} to Done…`);
        let doneNote = "";
        try {
          const t = doneTransition(await getIssueTransitions(issue.key, creds));
          if (t) await transitionIssue(issue.key, t.id, creds);
          else doneNote = ` The workflow offers ${issue.key} no move to a done status from ${issue.fields?.status?.name || "here"} — close it in Jira.`;
        } catch (err) {
          doneNote = ` ${issue.key} could not be moved to Done — ${err.message || err}`;
        }
        await cache.dropBoard(issue.boardId);

        const [fresh] = await getIssuesByKeys([created.key], creds).catch(() => []);
        const pt2 = fresh || { key: created.key, boardId: issue.boardId, fields: { summary: newSummary, status: { name: "To Do", statusCategory: { key: "new" } }, issuetype: issue.fields?.issuetype } };
        data.issues.set(pt2.key, pt2);
        if (!doneNote) issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
        change(() => {
          if (!draft.extraKeys.includes(pt2.key)) draft.extraKeys.push(pt2.key);
          data.extra.push(pt2);
          const changes = {};
          if (who.value) changes.assignee = who.value;
          const p = parsePoints(points.value);
          if (p !== null) changes.points = p;
          if (Object.keys(changes).length) setEdit(draft, pt2, changes);
          if (planBox.checked && canCommit(draft, pt2)) addToPlan(draft, pt2, targetKeys(), targetFor(draft, issue));
        });
        if (doneNote) {
          say(`Created and linked ${pt2.key}.${doneNote}`, true);
          cancel.disabled = false;
          cancel.textContent = "Close";
        } else {
          close();
          showToast(
            `${issue.key} → Done, continued as ${pt2.key}` +
              (planBox.checked && !canCommit(draft, pt2) ? " — give it an assignee and an estimate to plan it" : "")
          );
        }
      } catch (err) {
        if (String(err?.message).includes("401")) return close();
        say(`${created ? `Created ${created.key}, then stopped` : "Nothing was created"} — ${err.message || err}`, true);
        ok.disabled = false;
        cancel.disabled = false;
      }
    });
  }

  // A parent is carried where the issue has one; a company-managed project
  // files epics under Epic Link and refuses `parent` on a story, so a refusal
  // naming the parent is retried without it rather than failing the split.
  async function createWithParentFallback(issue) {
    try {
      return await createIssue(splitCreateFields(issue), creds);
    } catch (err) {
      if (issue.fields?.parent?.key && err?.fieldErrors && "parent" in err.fieldErrors) {
        return createIssue(splitCreateFields(issue, { withParent: false }), creds);
      }
      throw err;
    }
  }

  // ── Review and push ───────────────────────────────────────────────────────

  async function openReview() {
    const { dialog, body, actions, close } = openDialog("Review & push", { wide: true });
    body.appendChild(note("Re-reading Jira so the plan is checked against what is there now…"));
    const cancel = button("Close", "btn ghost");
    cancel.addEventListener("click", close);
    actions.appendChild(cancel);

    await loadPlanData({ fresh: true });
    if (!dialog.open) return;
    body.innerHTML = "";
    if (data.error) {
      body.appendChild(note(`Could not read Jira — ${data.error}. Nothing was written.`, "pl-error"));
      return;
    }

    const plan = buildPushPlan({ draft, issues: data.issues, inTarget: data.inTarget, sprintEnd: draft.end });
    renderReview(body, plan);

    if (plan.blocked.length) {
      body.appendChild(note("Every issue in the sprint needs an assignee and an estimate. Fix the ones above, or take them out, then review again.", "pl-error"));
    }
    if (!plan.writeCount) {
      body.appendChild(note("Nothing to write — Jira already matches the plan."));
      return;
    }
    const go = button(`Push ${plan.writeCount} change${plan.writeCount === 1 ? "" : "s"} to Jira`, "btn primary");
    go.disabled = plan.blocked.length > 0;
    actions.appendChild(go);
    dialog.addEventListener("submit", (e) => e.preventDefault());
    go.addEventListener("click", async () => {
      go.disabled = true;
      cancel.disabled = true;
      const progress = document.createElement("div");
      progress.className = "pl-dialog-status";
      progress.textContent = "Writing…";
      body.appendChild(progress);
      const result = await executePush(
        plan,
        {
          updateFields: (issue, changes) => updateIssueFields(issue.key, changes, creds, { issue }),
          moveToSprint: (sprintId, keys) => moveIssuesToSprint(sprintId, keys, creds),
          moveToBacklog: (keys) => moveIssuesToBacklog(keys, creds),
        },
        { onProgress: ({ settled, total }) => { progress.textContent = `Writing… ${settled} of ${total}`; } }
      );
      settleDraft(draft, result);
      persist();
      go.remove();
      cancel.disabled = false;
      progress.remove();
      renderResult(body, result);
      loadPlanData({ fresh: true });
    });
  }

  function renderReview(body, plan) {
    const block = (title, rows, tone = "") => {
      if (!rows.length) return;
      const h = document.createElement("h3");
      h.className = `pl-review-head ${tone}`;
      h.textContent = `${title} · ${rows.length}`;
      body.appendChild(h);
      const ul = document.createElement("ul");
      ul.className = "pl-review-list";
      for (const text of rows) {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    };
    const label = (key) => `${key} ${data.issues.get(key)?.fields?.summary || ""}`.trim();
    block("Blocked", plan.blocked.map((b) => `${label(b.key)} ${b.message}`), "bad");
    block("Changed in Jira since planning", plan.conflicts.map((c) => `${c.key}: ${c.message}`), "warn");
    block("Due dates", plan.warnings.map((w) => `${w.key} ${w.message}`), "warn");
    block("Left alone", plan.skipped.map((s) => `${s.key} ${s.message}`));
    block(
      "Field changes",
      plan.fieldWrites.map((w) => `${w.key}: ${describeWrite(w)}`)
    );
    for (const m of plan.moves) block(`Into ${sprintName(m.sprintId)}`, m.keys.map(label));
    block("Out of the sprint, to the backlog", plan.removals.map(label));
  }

  // "Assignee unassigned → Devi Okonjo, Story points none → 2". Written here
  // rather than through the single-edit toast's wording, which says "cleared"
  // for an empty value — right for an edit, wrong for a first estimate.
  function describeWrite(w) {
    const parts = [];
    if ("assignee" in w.changes) {
      const who = (id) => (id ? nameFor(id) : "unassigned");
      parts.push(`Assignee ${who(w.from.assignee)} → ${who(w.changes.assignee)}`);
    }
    if ("storyPoints" in w.changes) {
      const pts = (v) => (v === null || v === undefined ? "none" : fmtPoints(v));
      parts.push(`Story points ${pts(w.from.storyPoints)} → ${pts(w.changes.storyPoints)}`);
    }
    return parts.join(", ");
  }

  function renderResult(body, result) {
    body.innerHTML = "";
    const ok = new Set(result.done.map((d) => d.key)).size;
    const head = document.createElement("h3");
    head.className = `pl-review-head ${result.failed.length ? "bad" : "good"}`;
    head.textContent = result.failed.length
      ? `${result.failed.length} write${result.failed.length === 1 ? "" : "s"} failed after retrying — ${ok} issue${ok === 1 ? "" : "s"} written`
      : `Done — ${ok} issue${ok === 1 ? "" : "s"} written to Jira`;
    body.appendChild(head);
    if (result.authStopped) body.appendChild(note("Jira rejected the token, so the push stopped. Replace the token and push again — what landed is kept.", "pl-error"));
    if (result.failed.length) {
      const ul = document.createElement("ul");
      ul.className = "pl-review-list";
      for (const f of result.failed) {
        const li = document.createElement("li");
        li.textContent = `${f.key} (${f.kind === "fields" ? "fields" : f.kind === "move" ? "sprint move" : "back to backlog"}, tried ${f.tries}×): ${f.message}`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
      body.appendChild(note("The failed changes stay in the draft. Push again once the cause is fixed."));
    }
    showToast(result.failed.length ? `Push finished with ${result.failed.length} failure${result.failed.length === 1 ? "" : "s"}` : "Plan pushed to Jira", Boolean(result.failed.length));
  }

  // ── Small parts ───────────────────────────────────────────────────────────

  function personName(p) {
    const member = memberFor(p.accountId);
    return member ? memberLabel(member) : p.name || p.accountId || "—";
  }

  function nameFor(accountId, issue = null) {
    const p = draft.people.find((x) => x.accountId === accountId);
    if (p) return personName(p);
    const member = memberFor(accountId);
    if (member) return memberLabel(member);
    if (issue?.fields?.assignee?.accountId === accountId) return shortenName(issue.fields.assignee.displayName);
    for (const i of data.issues.values()) {
      if (i.fields?.assignee?.accountId === accountId) return shortenName(i.fields.assignee.displayName);
    }
    return accountId;
  }

  function memberAvatar(accountId) {
    const m = memberFor(accountId);
    if (m?.avatarOverride) return avatarAssetUrl(m.avatarOverride);
    if (m?.avatarUrl) return m.avatarUrl;
    for (const i of data.issues.values()) {
      if (i.fields?.assignee?.accountId === accountId) return getAvatarUrl(i) || "";
    }
    return "";
  }

  function avatar(accountId, name, size, src = null) {
    const url = src ?? memberAvatar(accountId);
    const placeholder = () => {
      const ph = document.createElement("span");
      ph.className = "pl-avatar pl-avatar-ph";
      ph.style.width = ph.style.height = `${size}px`;
      ph.style.fontSize = `${Math.round(size * 0.45)}px`;
      ph.style.background = hashColor(name || accountId || "?");
      ph.textContent = String(name || "?").replace(/^\W+/, "")[0]?.toUpperCase() || "?";
      ph.setAttribute("aria-hidden", "true");
      return ph;
    };
    if (!url) return placeholder();
    const img = document.createElement("img");
    img.className = "pl-avatar";
    img.src = url;
    img.alt = "";
    img.width = img.height = size;
    img.onerror = () => img.replaceWith(placeholder());
    return img;
  }

  // A drop zone that takes an issue key. The zone lights while something is
  // held over it; nothing is written on the drop, only the draft changes.
  function dropTarget(el, onDrop) {
    let depth = 0;
    el.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types?.includes("text/plain")) return;
      depth++;
      el.classList.add("drop-over");
    });
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("text/plain")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) el.classList.remove("drop-over");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.classList.remove("drop-over");
      const key = e.dataTransfer.getData("text/plain");
      if (key) onDrop(key);
    });
  }

  // ── First paint ───────────────────────────────────────────────────────────

  paint();
  await loadSprintLists();
  // A new draft starts with every board that has an upcoming sprint and
  // everyone on the roster, which is the common case.
  if (!draft.boards.length && draft.stage === "config" && !draft.people.length) {
    for (const board of BOARDS) {
      const list = sprintLists.get(String(board.id));
      if (list?.future?.length) {
        draft.boards.push({ id: String(board.id), target: defaultTarget(list), sources: defaultSources(list) });
      }
    }
    draft.people = activeMembers().map((m) => ({ accountId: m.accountId, name: memberLabel(m), days: null, buffer: null }));
    fillDatesFromTargets();
    if (draft.boards.length || draft.people.length) persist();
  }
  paint();
  if (draft.stage === "plan" && readyToPlan()) loadPlanData();
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

function button(text, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className} mono`;
  b.textContent = text;
  return b;
}

function iconButton(name, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn pl-icon-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.appendChild(icon(name, 14));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function fieldLabel(text) {
  const s = document.createElement("span");
  s.className = "pl-label";
  s.textContent = text;
  return s;
}

function note(text, className = "") {
  const p = document.createElement("p");
  p.className = `pl-note${className ? ` ${className}` : ""}`;
  p.textContent = text;
  return p;
}

// A native <dialog>: focus moves in and is trapped, Escape closes it, and the
// page behind is inert — the three things a hand-rolled overlay gets wrong.
function openDialog(title, { wide = false } = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = `pl-dialog${wide ? " wide" : ""}`;
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h2");
  h.className = "pl-dialog-title";
  h.textContent = title;
  const body = document.createElement("div");
  body.className = "pl-dialog-body";
  const actions = document.createElement("div");
  actions.className = "pl-dialog-actions";
  form.append(h, body, actions);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener("close", () => dialog.remove());
  // A submit bubbles from the form to the dialog, so callers listen there. It
  // never closes the dialog by itself: the caller decides when the work is done.
  form.addEventListener("submit", (e) => e.preventDefault());
  dialog.showModal();
  return { dialog, body, actions, close };
}
