// The weekly 1:1 screen (M14).
//
// Two screens, one route. `#oneone` is the picker — the roster, with how long
// it has been since you last spoke to each person, modelled on the standup
// setup card. `#oneone/<accountId>` is the sheet for one of them.
//
// ── The layout, and why ──────────────────────────────────────────────────────
//
// Two panes: what you read on the left, what you write on the right, with a
// full-width mini-Gantt underneath. The notes column never scrolls away,
// because this screen is used *during* a conversation on a laptop, and a
// stacked layout means typing pushes the numbers you are talking about off the
// top. That is the whole argument for the split, and it is the reason to keep
// it if this screen is ever reworked.
//
// ── What this file does not do ───────────────────────────────────────────────
//
// No writes to Jira. An action item is local text; turning one into an issue is
// a named follow-on rather than scope here, so this view never imports the
// write layer. No comparison between colleagues: one person is on screen at a
// time, by construction — the picker navigates, it does not tile.

import { getActiveSprint, getAllSprintIssues, getAssignedOpenIssues, getIssuesInWindow } from "../api.js";
import { runtimeUrl } from "../browser.js";
import { CONFIG } from "../config.js";
import { sprintWindow } from "../dashboard.js";
import {
  BOARDS,
  boardColor,
  boardName,
  compactNum,
  fmtDate,
  getStartDate,
  getStoryPoints,
  isOverdue,
  showToast,
} from "../utils.js";
import { activeMembers, avatarOverrideFor, githubLoginFor, hasRoster, memberFor, memberLabel } from "../team.js";
import { activityFor as jiraActivityFor, activityFrom } from "../activity.js";
import {
  PR_STATE_LABELS,
  STATS_LOOKBACK_DAYS,
  activityFor as githubActivityFor,
  comparePrs,
  getTeamActivity,
  getTeamStats,
  isGithubConfigured,
  statsFor,
} from "../github.js";
import { isDone, isSubtask } from "../monitor.js";
import { loadAllSnapshots, personSeries } from "../snapshots.js";
import {
  WINDOW_OPTIONS,
  completeSession,
  draftFor,
  ganttBars,
  lastMetLabel,
  loadOneOnes,
  newId,
  normalizeDue,
  openTodoCount,
  personFor,
  saveOneOnes,
  slackText,
  windowFor,
} from "../oneone.js";
import { loadTodos, mergeFromOneOne, saveTodos } from "../todos.js";
import { attachIssueOpener } from "../components/issue-detail.js";
import { icon } from "../components/icons.js";
import { viewHeader } from "../components/view-header.js";

// The window the picker will hand to the sheet. Session-scoped rather than
// stored: the per-person clock is the durable default, and this is only for the
// case where you already know you want a different one before you open it.
let pendingWindowId = "";

export function accountFromHash(hash = location.hash) {
  const parts = String(hash || "").split("/");
  return parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : "";
}

export async function mount(container, creds) {
  const accountId = accountFromHash();
  if (accountId) return mountSheet(container, creds, accountId);
  return mountPicker(container);
}

// ── The picker ───────────────────────────────────────────────────────────────

async function mountPicker(container) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "oo-picker";

  wrap.appendChild(
    viewHeader({
      iconName: "person",
      title: "1:1",
      subtitle: "One person, one window — what they did, what is stuck, what is planned",
    })
  );

  if (!hasRoster()) {
    wrap.appendChild(
      emptyState(
        "No roster yet.",
        "The 1:1 sheet is per person, so it needs the team list. Add people in Settings → Team.",
        { label: "Open Settings", onClick: () => window.open(runtimeUrl("settings.html")) }
      )
    );
    container.appendChild(wrap);
    return;
  }

  const store = await loadOneOnes();
  const now = new Date();

  // The window selector sits here as well as on the sheet, so it can be set
  // before the data loads rather than causing a second fetch afterwards.
  const controls = document.createElement("div");
  controls.className = "oo-picker-controls";
  const hint = document.createElement("span");
  hint.className = "oo-hint mono";
  hint.textContent = "Opens on: since your last 1:1";
  controls.appendChild(hint);
  controls.appendChild(
    windowToggle(pendingWindowId, (id) => {
      pendingWindowId = id;
      hint.textContent = id
        ? `Opens on: ${WINDOW_OPTIONS.find((o) => o.id === id)?.label}`
        : "Opens on: since your last 1:1";
    })
  );
  wrap.appendChild(controls);

  const list = document.createElement("div");
  list.className = "oo-roster";

  // Ordered by how overdue you are, longest first, with people you have never
  // met at the top. This is the one place in the app where a list is sorted by
  // a number about people — and the number is about *the user's* neglect, not
  // about the colleague's output, which is the distinction that makes it fine.
  const members = [...activeMembers()].sort((a, b) => {
    const aLast = personFor(store, a.accountId).lastCompletedAt;
    const bLast = personFor(store, b.accountId).lastCompletedAt;
    if (!aLast !== !bLast) return aLast ? 1 : -1;
    if (!aLast && !bLast) return memberLabel(a).localeCompare(memberLabel(b));
    return String(aLast).localeCompare(String(bLast));
  });

  for (const member of members) {
    const person = personFor(store, member.accountId);
    const row = document.createElement("a");
    row.className = "oo-roster-row";
    row.href = `#oneone/${encodeURIComponent(member.accountId)}`;

    const avatar = document.createElement("span");
    avatar.className = "oo-avatar";
    const override = avatarOverrideFor(member.accountId);
    if (override) {
      const img = document.createElement("img");
      img.src = override;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = member.emoji || initials(memberLabel(member));
    }
    row.appendChild(avatar);

    const name = document.createElement("span");
    name.className = "oo-roster-name";
    name.textContent = memberLabel(member);
    row.appendChild(name);

    const last = document.createElement("span");
    const days = person.lastCompletedAt ? lastMetLabel(person.lastCompletedAt, now) : "never";
    last.className = "oo-roster-last mono" + (person.lastCompletedAt ? "" : " never");
    last.textContent = days;
    last.title = person.lastCompletedAt
      ? `Last completed 1:1: ${fmtDate(person.lastCompletedAt)}`
      : "No 1:1 has been completed with this person yet";
    row.appendChild(last);

    const go = icon("chevron", 12);
    go.classList.add("icon-rot-left");
    row.appendChild(go);

    list.appendChild(row);
  }

  wrap.appendChild(list);

  const footnote = document.createElement("p");
  footnote.className = "oo-footnote";
  footnote.textContent =
    "Notes stay on this device. They are never synced and never included in a config export. " +
    "Settings → Data has the one button that deletes them.";
  wrap.appendChild(footnote);

  container.appendChild(wrap);
}

function initials(label) {
  return String(label || "?")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("");
}

// ── The sheet ────────────────────────────────────────────────────────────────

async function mountSheet(container, creds, accountId) {
  const member = memberFor(accountId);
  if (!member) {
    container.innerHTML = "";
    container.appendChild(
      emptyState("Not on the roster.", "That person is no longer in the team list.", {
        label: "Back to the list",
        onClick: () => { location.hash = "#oneone"; },
      })
    );
    return;
  }

  const now = new Date();
  const name = memberLabel(member);
  let store = await loadOneOnes(now);
  let person = personFor(store, accountId);
  let draft = draftFor(store, accountId, now);
  let windowId = pendingWindowId;
  pendingWindowId = "";

  // The sprint is needed before the window can be resolved, because "this
  // sprint" is where a first-ever sheet opens.
  const sprintLists = await Promise.all(BOARDS.map((b) => getActiveSprint(b.id, creds)));
  const sprints = sprintLists.flat();
  const sprintStart = sprintWindow(sprints).start?.toISOString() || "";

  let win = windowFor({ windowId, lastCompletedAt: person.lastCompletedAt, sprintStart, now });

  // Everything the left pane draws, refilled whenever the window moves.
  const data = { windowIssues: null, assigned: null, sprintIssues: null, series: [], error: "" };
  const github = { state: "idle", activity: null, stats: null, error: "", statsError: "" };

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "oo-sheet";

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement("header");
  header.className = "oo-sheet-header";

  const back = document.createElement("a");
  back.className = "oo-back";
  back.href = "#oneone";
  back.title = "Back to the list";
  const backIcon = icon("chevron", 14);
  backIcon.classList.add("icon-rot-right");
  back.append(backIcon, document.createTextNode("All"));
  header.appendChild(back);

  const who = document.createElement("div");
  who.className = "oo-who";
  const whoName = document.createElement("h1");
  whoName.className = "oo-who-name";
  whoName.textContent = name;
  who.appendChild(whoName);
  const whoMeta = document.createElement("span");
  whoMeta.className = "oo-who-meta mono";
  whoMeta.textContent = person.lastCompletedAt
    ? `Last 1:1 ${lastMetLabel(person.lastCompletedAt, now)}`
    : "First 1:1";
  who.appendChild(whoMeta);
  header.appendChild(who);

  const windowLabel = document.createElement("span");
  windowLabel.className = "oo-window-label mono";
  header.appendChild(windowLabel);

  header.appendChild(
    windowToggle(windowId, async (id) => {
      windowId = id;
      win = windowFor({ windowId, lastCompletedAt: person.lastCompletedAt, sprintStart, now });
      renderWindowLabel();
      await loadData();
      renderLeft();
      renderGantt();
    })
  );
  wrap.appendChild(header);

  function renderWindowLabel() {
    windowLabel.textContent = win.label;
    windowLabel.title = `${fmtDate(win.from)} → ${fmtDate(win.to)}${win.note ? `\n${win.note}` : ""}`;
    windowLabel.classList.toggle("warn", Boolean(win.note));
  }
  renderWindowLabel();

  // ── Panes ─────────────────────────────────────────────────────────────────
  const panes = document.createElement("div");
  panes.className = "oo-panes";
  const left = document.createElement("div");
  left.className = "oo-left";
  const right = document.createElement("div");
  right.className = "oo-right";
  panes.append(left, right);
  wrap.appendChild(panes);

  const ganttWrap = document.createElement("div");
  ganttWrap.className = "oo-gantt";
  wrap.appendChild(ganttWrap);

  container.appendChild(wrap);

  renderRight();
  left.innerHTML = '<div class="spinner" style="height:200px"></div>';
  startGithub();
  await loadData();
  renderLeft();
  renderGantt();

  // ── Loading ───────────────────────────────────────────────────────────────

  async function loadData() {
    left.innerHTML = '<div class="spinner" style="height:200px"></div>';
    data.error = "";
    try {
      const [windowIssues, assigned, sprintIssues, snapshots] = await Promise.all([
        getIssuesInWindow(creds, { since: win.from, until: win.to }),
        getAssignedOpenIssues(accountId, creds),
        getAllSprintIssues(creds),
        loadAllSnapshots(),
      ]);
      data.windowIssues = windowIssues;
      data.assigned = assigned;
      data.sprintIssues = sprintIssues;
      data.series = personSeries(snapshots, accountId);
    } catch (err) {
      data.error = String(err?.message || err);
    }
  }

  function startGithub() {
    if (!isGithubConfigured()) {
      github.state = "off";
      return;
    }
    github.state = "loading";
    // Two queries, two failure modes, exactly as the standup does it: the panel
    // lists come from one and the counted numbers from the other, and neither
    // waits on the other to repaint.
    getTeamActivity()
      .then((result) => { github.activity = result; })
      .catch((err) => { github.error = String(err?.message || err); })
      .finally(() => { github.state = "ready"; renderLeft(); });
    getTeamStats()
      .then((result) => { github.stats = result; })
      .catch((err) => { github.statsError = String(err?.message || err); })
      .finally(() => { renderLeft(); });
  }

  // ── Left pane ─────────────────────────────────────────────────────────────

  function renderLeft() {
    if (!data.windowIssues && !data.error) return; // still loading
    left.innerHTML = "";
    if (data.error) {
      left.appendChild(
        emptyState("Jira did not answer.", data.error, {
          label: "Try again",
          onClick: async () => { await loadData(); renderLeft(); renderGantt(); },
        })
      );
      return;
    }

    left.appendChild(sectionPlate());
    left.appendChild(sectionDid());
    left.appendChild(sectionStuck());
    left.appendChild(sectionPlanned());
    left.appendChild(sectionLoad());
  }

  function mine(issues) {
    return (issues || []).filter(
      (i) => i?.fields?.assignee?.accountId === accountId && !isSubtask(i)
    );
  }

  function sectionPlate() {
    const open = mine(data.sprintIssues).filter((i) => !isDone(i));
    const points = open.reduce((n, i) => n + (getStoryPoints(i) || 0), 0);
    const box = section("On their plate", open.length
      ? `${open.length} open in the active sprint · ${round1(points)} pts`
      : "Nothing open in the active sprint");
    if (open.length) box.appendChild(issueList(open, (i) => i.fields.status?.name || ""));
    return box;
  }

  function sectionDid() {
    const activity = activityFrom(data.windowIssues || [], {
      since: win.from,
      until: win.to,
      statusGroups: CONFIG.statusGroups,
    });
    const theirs = jiraActivityFor(activity, accountId);
    const box = section("What they did", win.label);

    const tiles = document.createElement("div");
    tiles.className = "oo-tiles";
    const known = theirs?.historyKnown;
    tiles.append(
      tile(known ? theirs.completed : null, "closed"),
      tile(known ? theirs.transitions : null, "moved"),
      tile(theirs ? theirs.created : null, "created")
    );

    const login = githubLoginFor(accountId);
    const stats = login && github.stats ? statsFor(github.stats, login, { since: win.from }) : null;
    if (stats) {
      tiles.append(
        tile(stats.prsOpened, "PRs opened"),
        tile(stats.prsMerged, "merged"),
        tile(stats.reviews, "reviewed"),
        linesTile(stats)
      );
    }
    box.appendChild(tiles);

    // Say what cannot be answered, where the number would have been. Three
    // different absences, three different sentences — a zero would be a lie in
    // all three.
    if (!known) {
      box.appendChild(note("Jira returned no change history for this window, so closed and moved are unknown."));
    }
    if (activity.truncated?.length) {
      box.appendChild(note(
        `Jira truncated the history of ${activity.truncated.length} issue${activity.truncated.length === 1 ? "" : "s"} — these counts are a floor.`
      ));
    }
    if (!login) {
      box.appendChild(note("No GitHub login mapped for this person — Settings → Team adds one."));
    } else if (github.state === "off") {
      box.appendChild(note("GitHub sync is off, so there are no pull-request figures."));
    } else if (github.state === "loading" && !github.stats) {
      box.appendChild(note("Fetching GitHub…"));
    } else if (github.statsError) {
      box.appendChild(note(`GitHub window failed: ${github.statsError}`));
    } else if (stats?.clamped) {
      box.appendChild(note(
        `GitHub reaches back ${STATS_LOOKBACK_DAYS} days and this window starts earlier — the GitHub figures cover the shorter period.`
      ));
    }

    box.appendChild(note(
      "Activity, not performance. A high count is not a good number and a low one is not a bad one — this is what to talk about, not a score."
    ));

    if (theirs?.completedIssues?.length) {
      box.appendChild(keyRow("Closed", theirs.completedIssues));
    }
    return box;
  }

  function sectionStuck() {
    const open = mine(data.assigned);
    const overdue = open.filter((i) => isOverdue(i));
    const blocked = open.filter((i) => /block|hold|waiting/i.test(i.fields.status?.name || ""));
    const jira = [...new Set([...overdue, ...blocked])];

    const login = githubLoginFor(accountId);
    const gh = login && github.activity ? githubActivityFor(github.activity, login) : null;
    const stuckPrs = gh ? [...gh.open].sort(comparePrs) : [];
    const waitingOnThem = gh ? gh.reviewRequests : [];

    const box = section(
      "What is stuck",
      jira.length || stuckPrs.length || waitingOnThem.length
        ? "Blocked, overdue, and the pull requests in the way"
        : "Nothing overdue, blocked, or waiting"
    );

    if (jira.length) {
      box.appendChild(
        issueList(jira, (i) =>
          isOverdue(i) ? `overdue — due ${fmtDate(i.fields.duedate)}` : i.fields.status?.name || ""
        )
      );
    }

    if (stuckPrs.length) {
      box.appendChild(subheading("Their pull requests"));
      box.appendChild(prList(stuckPrs));
    }
    if (waitingOnThem.length) {
      box.appendChild(subheading("Waiting on their review"));
      box.appendChild(prList(waitingOnThem));
    }
    return box;
  }

  function sectionPlanned() {
    const open = mine(data.assigned);
    const sprintIds = new Set(
      (data.sprintIssues || [])
        .filter((i) => i?.fields?.assignee?.accountId === accountId)
        .map((i) => i.id)
    );
    const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    // Three sources, together, because "what's next" is asked three ways: the
    // rest of this sprint, whatever is already queued beyond it, and anything
    // with a date coming up regardless of sprint.
    const beyond = open.filter((i) => !sprintIds.has(i.id));
    const dueSoon = open.filter(
      (i) => i.fields.duedate && i.fields.duedate <= horizon && !isOverdue(i)
    );
    const planned = [...new Set([...beyond, ...dueSoon])];

    const box = section(
      "What is planned",
      planned.length ? "Queued beyond this sprint, and anything due in the next fortnight" : "Nothing queued beyond the active sprint"
    );
    if (planned.length) {
      box.appendChild(
        issueList(planned, (i) => (i.fields.duedate ? `due ${fmtDate(i.fields.duedate)}` : i.fields.status?.name || ""))
      );
    }
    return box;
  }

  function sectionLoad() {
    const box = section("Load over time", "Points assigned and shipped, per sprint");
    if (!data.series.length) {
      box.appendChild(note(
        "No stored sprint history for this person yet. This builds forward from the day the extension started recording, so it is empty rather than zero."
      ));
      return box;
    }
    const max = Math.max(...data.series.map((r) => Math.max(r.points, r.donePoints)), 1);
    const chart = document.createElement("div");
    chart.className = "oo-load";
    for (const row of data.series) {
      const col = document.createElement("div");
      col.className = "oo-load-col";
      col.title =
        `${row.date}\n${row.points} pts assigned, ${row.donePoints} shipped ` +
        `(${row.issues} issues, ${row.doneIssues} done)`;
      const bar = document.createElement("div");
      bar.className = "oo-load-bar";
      bar.style.height = `${(row.points / max) * 100}%`;
      const doneBar = document.createElement("div");
      doneBar.className = "oo-load-done";
      doneBar.style.height = `${row.points ? (row.donePoints / row.points) * 100 : 0}%`;
      bar.appendChild(doneBar);
      col.appendChild(bar);
      const label = document.createElement("span");
      label.className = "oo-load-label mono";
      label.textContent = String(row.date || "").slice(5);
      col.appendChild(label);
      chart.appendChild(col);
    }
    box.appendChild(chart);
    box.appendChild(note(
      `${data.series.length} sprint${data.series.length === 1 ? "" : "s"} of stored history — bounded by when this device started recording, not by how long they have been here.`
    ));
    return box;
  }

  // ── The mini-Gantt ────────────────────────────────────────────────────────

  function renderGantt() {
    ganttWrap.innerHTML = "";
    if (!data.assigned) return;
    const open = mine(data.assigned);
    const { window: gwin, bars } = ganttBars(open, { now: new Date(), startOf: getStartDate });

    const head = document.createElement("div");
    head.className = "oo-gantt-head";
    const title = document.createElement("span");
    title.className = "oo-gantt-title mono";
    title.textContent = "Scheduled";
    head.appendChild(title);
    const range = document.createElement("span");
    range.className = "oo-gantt-range mono";
    range.textContent = `${gwin.from} → ${gwin.to}`;
    head.appendChild(range);
    ganttWrap.appendChild(head);

    if (!bars.length) {
      ganttWrap.appendChild(note("None of their open work carries a start or due date."));
      return;
    }

    const track = document.createElement("div");
    track.className = "oo-gantt-track";
    track.style.setProperty("--today", `${gwin.todayPct}%`);

    for (const bar of bars) {
      const row = document.createElement("div");
      row.className = "oo-gantt-row";
      const el = document.createElement("a");
      el.className = "oo-gantt-bar" + (bar.point ? " point" : "") + (bar.overdue ? " overdue" : "");
      el.style.left = `${bar.leftPct}%`;
      el.style.width = `${bar.widthPct}%`;
      el.style.setProperty("--bar-color", boardColor(bar.boardId));
      if (bar.clippedStart) el.classList.add("clip-start");
      if (bar.clippedEnd) el.classList.add("clip-end");
      el.textContent = bar.key;
      attachIssueOpener(el, bar.key, creds);
      // After the opener, not before: it writes a title of its own, and on a bar
      // labelled with nothing but an issue key the dates are the whole point of
      // hovering.
      el.title =
        `${bar.key} — ${bar.summary}\n${boardName(bar.boardId)} · ${bar.type} · ${bar.status}\n` +
        `${bar.start || "no start"} → ${bar.end || "no due date"}` +
        (bar.clippedStart || bar.clippedEnd ? "\nRuns outside the nine-week window shown." : "");
      row.appendChild(el);
      track.appendChild(row);
    }
    ganttWrap.appendChild(track);
  }

  // ── Right pane: the notes ─────────────────────────────────────────────────

  function renderRight() {
    right.innerHTML = "";
    right.appendChild(todoBlock());
    right.appendChild(infoBlock());
    right.appendChild(actionsBlock());
    right.appendChild(archiveBlock());
  }

  // Saved as you type, debounced by nothing: these are a handful of short
  // strings, the store is device-local, and a note lost to a closed tab is the
  // failure this is here to prevent.
  async function persistDraft() {
    draft = { ...draft, updatedAt: new Date().toISOString() };
    const next = { people: { ...store.people } };
    next.people[accountId] = { ...personFor(store, accountId), draft };
    store = await saveOneOnes(next);
    person = personFor(store, accountId);
  }

  function todoBlock() {
    const box = document.createElement("section");
    box.className = "oo-block";
    box.appendChild(blockHeading("TODO", `${openTodoCount(store, accountId)} open`));

    const list = document.createElement("div");
    list.className = "oo-todos";
    box.appendChild(list);

    const carried = draft.todos.filter((t) => t.carriedFrom);
    const fresh = draft.todos.filter((t) => !t.carriedFrom);

    if (carried.length) {
      const rule = document.createElement("div");
      rule.className = "oo-carried-rule mono";
      rule.textContent = `carried from ${fmtDate(carried[0].carriedFrom)}`;
      list.appendChild(rule);
      for (const todo of carried) list.appendChild(todoRow(todo));
    }
    for (const todo of fresh) list.appendChild(todoRow(todo));

    const add = document.createElement("button");
    add.className = "oo-add mono";
    add.type = "button";
    add.textContent = "+ action";
    add.addEventListener("click", async () => {
      const todo = { id: newId("t"), text: "", owner: "them", due: "", done: false, carriedFrom: "" };
      draft = { ...draft, todos: [...draft.todos, todo] };
      await persistDraft();
      renderRight();
      // Focus the row that just appeared: this is used mid-sentence, and a
      // click that does not put the caret somewhere costs a second click.
      right.querySelector(`[data-todo="${todo.id}"] .oo-todo-text`)?.focus();
    });
    box.appendChild(add);
    return box;
  }

  function todoRow(todo) {
    const row = document.createElement("div");
    row.className = "oo-todo enter" + (todo.done ? " done" : "");
    row.dataset.todo = todo.id;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "oo-todo-box";
    box.checked = todo.done;
    box.setAttribute("aria-label", "Done");
    box.addEventListener("change", async () => {
      draft = { ...draft, todos: draft.todos.map((t) => (t.id === todo.id ? { ...t, done: box.checked } : t)) };
      await persistDraft();
      renderRight();
    });
    row.appendChild(box);

    // Two owners, one control. A segmented pair rather than a dropdown: it is
    // set while somebody is talking, and a menu costs a second interaction.
    const owner = document.createElement("button");
    owner.type = "button";
    owner.className = "oo-owner mono " + todo.owner;
    owner.textContent = todo.owner === "me" ? "me" : "them";
    owner.title = "Whose action is this? Click to switch between you and them.";
    owner.addEventListener("click", async () => {
      const next = todo.owner === "me" ? "them" : "me";
      draft = { ...draft, todos: draft.todos.map((t) => (t.id === todo.id ? { ...t, owner: next } : t)) };
      await persistDraft();
      renderRight();
    });
    row.appendChild(owner);

    const text = document.createElement("input");
    text.type = "text";
    text.className = "oo-todo-text";
    text.value = todo.text;
    text.placeholder = "what was agreed";
    text.addEventListener("input", async () => {
      draft = { ...draft, todos: draft.todos.map((t) => (t.id === todo.id ? { ...t, text: text.value } : t)) };
      await persistDraft();
    });
    row.appendChild(text);

    const due = document.createElement("input");
    due.type = "date";
    due.className = "oo-todo-due mono";
    due.value = todo.due;
    due.title = "Optional deadline";
    due.addEventListener("change", async () => {
      draft = {
        ...draft,
        todos: draft.todos.map((t) => (t.id === todo.id ? { ...t, due: normalizeDue(due.value) } : t)),
      };
      await persistDraft();
    });
    row.appendChild(due);

    row.appendChild(
      removeButton(`Remove this action`, async () => {
        draft = { ...draft, todos: draft.todos.filter((t) => t.id !== todo.id) };
        await persistDraft();
        renderRight();
      })
    );
    return row;
  }

  function infoBlock() {
    const box = document.createElement("section");
    box.className = "oo-block";
    box.appendChild(blockHeading("Important info", ""));

    const list = document.createElement("div");
    list.className = "oo-infos";
    for (const item of draft.info) list.appendChild(infoRow(item));
    box.appendChild(list);

    const add = document.createElement("button");
    add.className = "oo-add mono";
    add.type = "button";
    add.textContent = "+ note";
    add.addEventListener("click", async () => {
      const item = { id: newId("n"), text: "" };
      draft = { ...draft, info: [...draft.info, item] };
      await persistDraft();
      renderRight();
      right.querySelector(`[data-info="${item.id}"] textarea`)?.focus();
    });
    box.appendChild(add);
    return box;
  }

  function infoRow(item) {
    const row = document.createElement("div");
    row.className = "oo-info enter";
    row.dataset.info = item.id;

    const field = document.createElement("textarea");
    field.className = "oo-info-text";
    field.rows = 2;
    field.value = item.text;
    field.placeholder = "context worth remembering";
    field.addEventListener("input", async () => {
      draft = { ...draft, info: draft.info.map((i) => (i.id === item.id ? { ...i, text: field.value } : i)) };
      await persistDraft();
    });
    row.appendChild(field);

    row.appendChild(
      removeButton("Remove this note", async () => {
        draft = { ...draft, info: draft.info.filter((i) => i.id !== item.id) };
        await persistDraft();
        renderRight();
      })
    );
    return row;
  }

  function actionsBlock() {
    const box = document.createElement("div");
    box.className = "oo-actions";

    const copy = document.createElement("button");
    copy.className = "btn mono";
    copy.type = "button";
    copy.textContent = "Copy for Slack";
    copy.title = "Copies the actions and the notes to your clipboard. Nothing is sent anywhere.";
    copy.addEventListener("click", () => copyForSlack());
    box.appendChild(copy);

    const complete = document.createElement("button");
    complete.className = "btn primary mono";
    complete.type = "button";
    complete.textContent = "Complete 1:1";
    complete.title =
      "Archives these notes as a dated entry, carries the open actions into next time, " +
      "and sets the window for your next 1:1 with this person.";
    complete.addEventListener("click", () => onComplete());
    box.appendChild(complete);

    return box;
  }

  async function copyForSlack(session = null) {
    const text = slackText({ name, session: session || draft, when: new Date() });
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied — paste it into Slack.");
    } catch {
      // A denied clipboard is not a lost note: put it somewhere it can be
      // selected by hand rather than telling somebody their notes are gone.
      showToast("Clipboard was refused — the text is in the browser console.", true);
      console.info(text);
    }
  }

  async function onComplete() {
    const openActions = draft.todos.filter((t) => !t.done && t.text.trim()).length;
    const ok = window.confirm(
      `Complete this 1:1 with ${name}?\n\n` +
        `These notes are archived as a dated, read-only entry. ` +
        `${openActions} open action${openActions === 1 ? "" : "s"} carry into next time, ` +
        `and the next sheet will open on everything since now.`
    );
    if (!ok) return;

    const at = new Date();
    const result = completeSession(store, accountId, { draft, window: win, now: at });
    store = await saveOneOnes(result.store, at);
    person = personFor(store, accountId);
    draft = draftFor(store, accountId, at);

    // My own actions go to the personal list, where they are one list rather
    // than scattered across a dozen sheets.
    const todos = await loadTodos(at);
    const merged = mergeFromOneOne(todos, {
      todos: result.session.todos,
      personLabel: name,
      now: at,
    });
    if (merged.length !== todos.length) await saveTodos(merged, at);

    // The copy is offered here rather than left to a button somebody has to
    // remember: the end of the meeting is when the summary gets sent.
    await copyForSlack(result.session);

    // The window deliberately does not move. Completing sets the boundary for
    // *next* time; re-resolving it here would relabel the header "since a moment
    // ago" over a fortnight of data still on screen, which is a lie about the
    // numbers you were discussing thirty seconds earlier. The header saying
    // "Last 1:1 today" is the signal that it landed.
    whoMeta.textContent = `Last 1:1 ${lastMetLabel(person.lastCompletedAt, new Date())}`;
    renderRight();
  }

  function archiveBlock() {
    const box = document.createElement("section");
    box.className = "oo-block oo-archive";
    const sessions = [...person.sessions].reverse();
    box.appendChild(blockHeading("Past 1:1s", `${sessions.length}`));

    if (!sessions.length) {
      box.appendChild(note("No completed 1:1s with this person yet."));
      return box;
    }

    for (const session of sessions) {
      const entry = document.createElement("details");
      entry.className = "oo-session";
      const summary = document.createElement("summary");
      summary.className = "mono";
      const openCount = session.todos.filter((t) => !t.done).length;
      summary.textContent =
        `${fmtDate(session.completedAt)} · ${session.todos.length} action${session.todos.length === 1 ? "" : "s"}` +
        (openCount ? ` (${openCount} left open)` : "");
      entry.appendChild(summary);

      const body = document.createElement("div");
      body.className = "oo-session-body";
      for (const todo of session.todos) {
        const line = document.createElement("div");
        line.className = "oo-session-line" + (todo.done ? " done" : "");
        line.textContent = `${todo.done ? "☑" : "☐"} [${todo.owner === "me" ? "me" : "them"}] ${todo.text}` +
          (todo.due ? ` — due ${todo.due}` : "");
        body.appendChild(line);
      }
      for (const item of session.info) {
        const line = document.createElement("div");
        line.className = "oo-session-line info";
        line.textContent = item.text;
        body.appendChild(line);
      }
      const foot = document.createElement("div");
      foot.className = "oo-session-foot mono";
      foot.textContent = "Archived — read only.";
      body.appendChild(foot);

      const copyOne = document.createElement("button");
      copyOne.className = "oo-link-btn mono";
      copyOne.type = "button";
      copyOne.textContent = "Copy for Slack";
      copyOne.addEventListener("click", () => copyForSlack(session));
      body.appendChild(copyOne);

      entry.appendChild(body);
      box.appendChild(entry);
    }
    return box;
  }

  // ── Shared bits ───────────────────────────────────────────────────────────

  function issueList(issues, contextOf) {
    const list = document.createElement("ul");
    list.className = "oo-issues";
    for (const issue of issues.slice(0, 40)) {
      const li = document.createElement("li");
      const key = document.createElement("a");
      key.className = "issue-key";
      key.style.color = boardColor(issue.boardId);
      key.textContent = issue.key;
      attachIssueOpener(key, issue.key, creds);
      li.appendChild(key);

      const summary = document.createElement("span");
      summary.className = "oo-issue-summary";
      summary.textContent = issue.fields.summary || "";
      summary.title = issue.fields.summary || "";
      li.appendChild(summary);

      const context = document.createElement("span");
      context.className = "oo-issue-context mono";
      context.textContent = contextOf ? contextOf(issue) : "";
      li.appendChild(context);

      list.appendChild(li);
    }
    if (issues.length > 40) {
      const more = document.createElement("li");
      more.className = "oo-issue-more mono";
      more.textContent = `+${issues.length - 40} more`;
      list.appendChild(more);
    }
    return list;
  }

  function prList(prs) {
    const list = document.createElement("ul");
    list.className = "oo-issues";
    for (const pr of prs.slice(0, 12)) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.className = "issue-key";
      link.href = pr.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `#${pr.number}`;
      link.title = `${pr.repo} — ${pr.title}`;
      li.appendChild(link);

      const summary = document.createElement("span");
      summary.className = "oo-issue-summary";
      summary.textContent = pr.title || "";
      li.appendChild(summary);

      const state = document.createElement("span");
      state.className = "oo-issue-context mono";
      state.textContent = `${PR_STATE_LABELS[pr.state] || pr.state} · ${pr.ageDays}d`;
      li.appendChild(state);

      list.appendChild(li);
    }
    return list;
  }
}

// ── Small shared builders ────────────────────────────────────────────────────

// Three buttons, and clicking the one already on turns it off — which is how
// you get *back* to "since your last 1:1" without a fourth button naming a
// state that is really the absence of a choice.
function windowToggle(initial, onChange) {
  let current = initial;
  const group = document.createElement("div");
  group.className = "oo-window-toggle";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Window");

  const paint = () => {
    for (const btn of group.querySelectorAll(".oo-window-btn")) {
      const on = btn.dataset.window === current;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };

  for (const option of WINDOW_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "oo-window-btn mono";
    btn.dataset.window = option.id;
    btn.textContent = option.label;
    btn.title = `Show ${option.label.toLowerCase()} — click again for since your last 1:1`;
    btn.addEventListener("click", () => {
      current = current === option.id ? "" : option.id;
      paint();
      onChange(current);
    });
    group.appendChild(btn);
  }
  paint();
  return group;
}

function section(title, subtitle) {
  const box = document.createElement("section");
  box.className = "oo-section";
  const head = document.createElement("div");
  head.className = "oo-section-head";
  const h = document.createElement("h2");
  h.className = "oo-section-title mono";
  h.textContent = title;
  head.appendChild(h);
  if (subtitle) {
    const sub = document.createElement("span");
    sub.className = "oo-section-sub";
    sub.textContent = subtitle;
    head.appendChild(sub);
  }
  box.appendChild(head);
  return box;
}

function subheading(text) {
  const el = document.createElement("h3");
  el.className = "oo-subheading mono";
  el.textContent = text;
  return el;
}

function blockHeading(title, meta) {
  const head = document.createElement("div");
  head.className = "oo-block-head";
  const h = document.createElement("h2");
  h.className = "oo-block-title mono";
  h.textContent = title;
  head.appendChild(h);
  if (meta) {
    const el = document.createElement("span");
    el.className = "oo-block-meta mono";
    el.textContent = meta;
    head.appendChild(el);
  }
  return head;
}

// A dash is not a small number. Null prints as one, with a title saying why,
// and never as a zero.
function tile(value, label) {
  const el = document.createElement("div");
  el.className = "oo-tile" + (value === null || value === undefined ? " unknown" : "");
  const num = document.createElement("span");
  num.className = "oo-tile-num";
  num.textContent = value === null || value === undefined ? "—" : compactNum(value);
  el.appendChild(num);
  const cap = document.createElement("span");
  cap.className = "oo-tile-label";
  cap.textContent = label;
  el.appendChild(cap);
  if (value === null || value === undefined) el.title = "Not available for this window";
  return el;
}

function linesTile(stats) {
  const el = document.createElement("div");
  el.className = "oo-tile oo-tile-lines";
  const num = document.createElement("span");
  num.className = "oo-tile-num";
  num.textContent = `+${compactNum(stats.additions)} −${compactNum(stats.deletions)}`;
  el.appendChild(num);
  const cap = document.createElement("span");
  cap.className = "oo-tile-label";
  cap.textContent = "lines";
  el.appendChild(cap);
  el.title =
    `${stats.additions} added, ${stats.deletions} removed on the default branch.\n` +
    `${stats.directCommits} commit${stats.directCommits === 1 ? "" : "s"} pushed straight to it.\n` +
    "Conversation fuel, not a score.";
  return el;
}

function keyRow(label, keys) {
  const row = document.createElement("div");
  row.className = "oo-keyrow mono";
  const title = document.createElement("span");
  title.className = "oo-keyrow-label";
  title.textContent = label;
  row.appendChild(title);
  row.appendChild(document.createTextNode(keys.slice(0, 12).join(" · ")));
  if (keys.length > 12) row.appendChild(document.createTextNode(` +${keys.length - 12}`));
  return row;
}

function note(text) {
  const el = document.createElement("p");
  el.className = "oo-note";
  el.textContent = text;
  return el;
}

function removeButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "oo-remove";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.appendChild(icon("close", 12));
  btn.addEventListener("click", onClick);
  return btn;
}

function emptyState(title, body, action = null) {
  const el = document.createElement("div");
  el.className = "empty-state oo-empty";
  const h = document.createElement("strong");
  h.textContent = title;
  el.appendChild(h);
  const p = document.createElement("p");
  p.textContent = body;
  el.appendChild(p);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn mono";
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    el.appendChild(btn);
  }
  return el;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
