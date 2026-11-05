import {
  getActiveSprint,
  getAllSprintIssues,
  getClosedSprints,
  getIssueLinks,
  getIssuesByKeys,
  getIssuesForSprints,
  getMyself,
} from "../api.js";
import { runtimeUrl } from "../browser.js";
import { BOARDS, compactNum, fmtDate, loadStatusGroups, relDate, showToast } from "../utils.js";
import { CONFIG, siteHost } from "../config.js";
import { buildBurndown, isBlocked, isoDay, reviewOrDone, summarize } from "../dashboard.js";
import { isSubtask } from "../monitor.js";
import { loadAllSnapshots, loadSnapshots, recordSnapshot, snapshotFrom, sprintKey } from "../snapshots.js";
import {
  completionRate,
  draftRow,
  loadSprintHistory,
  meanCompleted,
  planUpdate,
  recordSprintHistory,
  shortSprintName,
  sprintHistoryRows,
  trendRows,
} from "../history.js";
import {
  departedKeys,
  diffFreeze,
  freezeFrom,
  loadAllFreezes,
  loadFreeze,
  recordFreeze,
  scopeBasis,
} from "../freeze.js";
import {
  attentionChecks,
  carryOverRisk,
  closedBy,
  endOfWorkingDay,
  previousReading,
  previousSprintFor,
  quietMembers,
  reviewTurnaround,
  scopeChange,
  sinceLastStandup,
  sprintDay,
  statusDistribution,
  workload,
} from "../overview.js";
import { activityFrom } from "../activity.js";
import { loadHistory } from "../standup.js";
import { openDrawerPanel } from "../components/drawer.js";
import { attachIssueOpener } from "../components/issue-detail.js";
import { icon } from "../components/icons.js";
import { activeMembers, avatarAssetUrl, displayNameFor, memberFor, memberLabel, teamScope } from "../team.js";
import {
  FALLBACK_SPRINT_DAYS,
  activityFor as githubActivityFor,
  getTeamActivity,
  getTeamStats,
  getWindowStats,
  isGithubConfigured,
  mergedSince,
  needsWindowFetch,
  prewarmGithub,
  statsFor,
} from "../github.js";
import { burndownChart, comboChart, donutChart, emptyState, legend, weeklyLines } from "../charts.js";

// The sprint dashboard, as a Team Overview.
//
// Header → tabs → five KPIs → three charts → team health beside the checklist
// of things to check by hand → standup prep, and the freeze diff at the foot.
// The Individual View tab holds the per-person cards and the delivery table,
// which used to sit at the bottom of this screen: figures per colleague belong
// on the tab that is about colleagues, not beside the team's numbers.
//
// The derivations live in js/overview.js and js/dashboard.js, both DOM-free.
// This file draws, and owns the order in which the sources land:
//
//   first paint  the sprint's issues and the local stores (snapshots, freeze,
//                standup history) — all already cached by the other views
//   then         GitHub's two documents, the issue-link lookup for the
//                dependencies check, the closed-sprint list and the previous
//                sprint's issues for the like-for-like comparisons, and the
//                signed-in user for the avatar
//
// Each later source repaints only the cards that read it, and every card says
// "still looking" rather than printing a zero while it waits.

// Ordinal ramp for the status split: To Do → Done is a sequence, so those four
// take one hue in monotone lightness steps and the reader sees the order in the
// colour. Each mode's steps were selected for that mode's surface and
// validated (monotone lightness, adjacent ΔL ≥ 0.06, light-end contrast ≥ 2:1,
// single hue), not flipped from one another. Blocked is the one slice that is a
// state rather than a step, so it wears the danger tone — always with its name
// and count beside it in the legend, never colour alone.
const PROGRESS_RAMP_LIGHT = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"];
const PROGRESS_RAMP_DARK = ["#184f95", "#2a78d6", "#5598e7", "#86b6ef"];

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") !== "light";
}

function sliceFill(label) {
  if (label === "Blocked") return "var(--tone-red)";
  const ramp = isDarkTheme() ? PROGRESS_RAMP_DARK : PROGRESS_RAMP_LIGHT;
  return ramp[["To Do", "In Progress", "In Review", "Done"].indexOf(label)] || ramp[0];
}

// Which tab is open survives a refresh and a sprint switch; it is a reading
// preference for this session, not a route.
let activeTab = "team";

// `#dashboard` is the running sprint; `#dashboard/<boardId>:<sprintId>` a closed
// one, which is what the sprint selector navigates to — so a past sprint is a
// link that can be reloaded and kept.
function selectedSprintRef(hash = location.hash) {
  const rest = String(hash || "").split("/")[1] || "";
  const match = /^(\d+):(\d+)$/.exec(rest);
  return match ? { boardId: match[1], sprintId: match[2] } : null;
}

function make(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';
  const now = new Date();
  const ref = selectedSprintRef();

  // GitHub is a second, optional source and never on the critical path — the
  // same rule standup mode follows. Both documents start before the first await
  // so they overlap the Jira calls; the cards that read them repaint when each
  // lands.
  const github = {
    state: "off",
    stats: null,
    error: "",
    activityState: "off",
    activity: null,
    since: "",
    dated: false,
  };
  const onGithub = [];
  const githubChanged = () => onGithub.forEach((fn) => fn());
  if (isGithubConfigured()) {
    github.state = "loading";
    github.activityState = "loading";
    getTeamStats()
      .then((stats) => {
        github.stats = stats;
        github.state = "ready";
      })
      .catch((err) => {
        github.error = String(err?.message || err);
        github.state = "error";
      })
      .then(githubChanged);
    getTeamActivity()
      .then((activity) => {
        github.activity = activity;
        github.activityState = "ready";
      })
      .catch(() => {
        github.activityState = "error";
      })
      .then(githubChanged);
  }

  // Every board's closed sprints: the selector's history, and the previous
  // sprint the like-for-like comparisons read. One cached request a board.
  const closedPromise = Promise.all(
    BOARDS.map((board) =>
      getClosedSprints(board.id, creds)
        .then((closed) => ({ board, closed }))
        .catch(() => ({ board, closed: [] }))
    )
  );

  const statusGroups = await loadStatusGroups();

  let live = true;
  let allIssues = [];
  let boardSprints = [];
  if (ref) {
    const closed = await closedPromise;
    const entry = closed.find((c) => String(c.board.id) === ref.boardId);
    const sprint = entry?.closed.find((s) => String(s.id) === ref.sprintId);
    if (sprint) {
      live = false;
      boardSprints = [{ board: entry.board, sprints: [sprint] }];
      allIssues = await getIssuesForSprints(boardSprints, creds);
    } else {
      showToast("That sprint is not among the board's closed sprints — showing the current one.");
    }
  }
  if (live) {
    // Both already cached by the other views, so this normally costs nothing.
    const [issues, lists] = await Promise.all([
      getAllSprintIssues(creds),
      Promise.all(BOARDS.map((b) => getActiveSprint(b.id, creds))),
    ]);
    allIssues = issues;
    boardSprints = BOARDS.map((board, i) => ({ board, sprints: lists[i] || [] }));
  }
  const sprints = boardSprints.flatMap((b) => b.sprints);
  const key = sprintKey(sprints);

  // The freeze is read — and, for the running sprint, taken if this sprint has
  // none — *before* the summary, because it decides what "added after start"
  // means. Taken unasked on the first load of a sprint: history only accrues
  // forward, and a sprint boundary that passes unfrozen cannot be reconstructed
  // afterwards. A closed sprint is only ever read; freezing one now would record
  // its end as if it were its start.
  //
  // Stored over *every* issue in the sprint, whoever holds it, and scoped to
  // the team only on read — so a roster change later never rewrites a record
  // that cannot be re-taken.
  let storedFreeze = sprints.length ? await loadFreeze(key) : null;
  if (live && sprints.length && !storedFreeze) {
    storedFreeze = freezeFrom({ issues: allIssues, sprints, statusGroups });
    await recordFreeze(key, storedFreeze);
  }

  // The team's sprint: issues held by roster members, plus unassigned ones.
  const team = teamScope({ issues: allIssues, freeze: storedFreeze });
  const issues = team.issues;
  const freeze = team.freeze;

  const summary = summarize({
    issues,
    sprints,
    statusGroups,
    monitorSettings: CONFIG.monitorChecks,
    boards: BOARDS,
    freeze,
    now,
  });

  // The window the GitHub figures are counted over: the sprint's own start, or
  // a stated guess when the active sprint carries no start date.
  github.dated = Boolean(summary.window.start);
  github.since = (
    summary.window.start || new Date(Date.now() - FALLBACK_SPRINT_DAYS * 86400000)
  ).toISOString();

  // Record today's aggregate for the running sprint, then read the series back
  // including it. A closed sprint's history is whatever was recorded while it ran.
  if (live) await recordSnapshot(key, snapshotFrom(summary, isoDay(now)));
  const snapshots = await loadSnapshots(key);
  const burndown = buildBurndown({
    snapshots,
    window: summary.window,
    totalPoints: summary.totalPoints,
  });

  // The diff with nobody's whereabouts looked up yet: the scope card needs its
  // points, which do not depend on where a departed issue went.
  const scopeDiff = freeze
    ? diffFreeze({ freeze, issues, sprints, statusGroups, departed: [], handedOff: team.handedOff })
    : null;

  // Per-sprint history (M17). The running sprint's draft row is written from
  // the same summary as today's snapshot; any other unfinished row is a sprint
  // that has rolled over, and is sealed with its GitHub figures in the
  // background. The card paints from the planned rows straight away and again
  // once that lands.
  let sprintHistory = sprintHistoryRows(await loadSprintHistory());
  let historyPromise = null;
  if (live) {
    const draft = draftRow({ key, sprints, summary, scope: scopeChange({ summary, diff: scopeDiff }), now });
    const [allSnapshots, allFreezes] = await Promise.all([loadAllSnapshots(), loadAllFreezes()]);
    // Commitments are the team's, as the live sprint's is: each freeze scoped
    // to the roster the way this sprint's was.
    const freezes = Object.fromEntries(
      Object.entries(allFreezes).map(([k, f]) => [k, teamScope({ freeze: f }).freeze])
    );
    const logins = activeMembers().map((m) => m.githubLogin).filter(Boolean);
    const update = { liveKey: key, draft, snapshots: allSnapshots, freezes };
    sprintHistory = sprintHistoryRows(planUpdate(await loadSprintHistory(), update));
    historyPromise = recordSprintHistory({
      ...update,
      logins,
      loadStats: async ({ since, until }) => {
        if (!isGithubConfigured()) return null;
        return needsWindowFetch(since, now) ? getWindowStats({ since, until, now }) : getTeamStats();
      },
    });
  }

  // The last standup, for "since the previous standup". Device-local; without
  // one, the start of the previous working day — so a Monday still sees Friday.
  const history = await loadHistory().catch(() => []);
  const lastStandup = history
    .map((r) => r.startedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const standupSince = lastStandup || mergedSince(now).toISOString();

  const ctx = {
    creds,
    now,
    live,
    ref,
    key,
    summary,
    issues,
    allIssues,
    sprints,
    boardSprints,
    statusGroups,
    freeze,
    storedFreeze,
    scopeDiff,
    snapshots,
    burndown,
    sprintHistory,
    github,
    onGithub,
    closedPromise,
    team,
    members: activeMembers(),
    links: null,
    linksState: live ? "loading" : "ready",
    standupSince,
    lastStandup,
    afterAttach: [],
    repaint: [],
    refreeze,
  };

  container.innerHTML = "";
  const wrap = make("div", "dash-wrap");
  wrap.appendChild(renderToolbar(ctx));

  const tabs = renderTabs();
  wrap.appendChild(tabs.el);

  const teamPanel = tabs.panel("team");
  teamPanel.appendChild(renderKpis(ctx));
  teamPanel.appendChild(renderCharts(ctx));
  teamPanel.appendChild(renderHealth(ctx));
  if (live) teamPanel.appendChild(renderStandupPrep(ctx));

  // The diff sits at the foot of the overview: the scope card above answers
  // "how much moved", this answers "which issues moved it".
  const diff = freeze
    ? renderFreezeDiff({ freeze, issues, sprints, statusGroups, creds, refreeze, handedOff: team.handedOff })
    : null;
  if (diff) {
    diff.el.id = "dash-freeze";
    teamPanel.appendChild(diff.el);
  }

  const individualPanel = tabs.panel("individual");
  individualPanel.appendChild(renderPeople(ctx));
  // Held onto so the GitHub columns can fill in when the query lands.
  const delivery = renderDelivery(summary, github);
  onGithub.push(delivery.repaint);
  individualPanel.appendChild(delivery.el);

  wrap.append(teamPanel, individualPanel);
  tabs.select(activeTab);
  container.appendChild(wrap);
  for (const fn of ctx.afterAttach) fn();

  // ── Everything after the first paint ─────────────────────────────────────

  // Where the issues that left the sprint went — a single batched lookup the
  // view should not be held up by.
  if (diff) {
    const missing = departedKeys(freeze, issues, team.handedOff);
    if (!missing.length) diff.setDeparted([]);
    else {
      getIssuesByKeys(missing, creds)
        .then((found) => diff.setDeparted(found))
        .catch(() => diff.setDeparted([]));
    }
  }

  // Links are a detail-only field, so the dependencies check asks for them on
  // their own: one cached search over the open issues' keys.
  if (live) {
    const openKeys = issues.filter((i) => i.fields?.status?.statusCategory?.key !== "done").map((i) => i.key);
    getIssueLinks(openKeys, creds)
      .then((linked) => {
        ctx.links = linked;
        ctx.linksState = "ready";
      })
      .catch(() => {
        ctx.links = null;
        ctx.linksState = "error";
      })
      .then(() => ctx.repaint.forEach((fn) => fn()));
  }
  onGithub.push(() => ctx.repaint.forEach((fn) => fn()));

  if (historyPromise) {
    historyPromise
      .then((result) => {
        if (!result?.closed?.length) return;
        ctx.sprintHistory = sprintHistoryRows(result);
        ctx.repaint.forEach((fn) => fn());
      })
      .catch(() => {});
  }

  // A re-freeze discards a record that cannot be recovered, so it confirms with
  // what it is about to throw away — not "are you sure".
  async function refreeze() {
    const held =
      `Taken ${storedFreeze.takenOn}, holding ${storedFreeze.issueCount} ` +
      `issue${storedFreeze.issueCount === 1 ? "" : "s"} and ${trimNum(storedFreeze.totalPoints)} points.`;
    if (
      !confirm(
        `Re-freeze ${summary.sprintNames.join(" · ") || "this sprint"}?\n\n${held}\n\n` +
          "It will be replaced by the sprint as it stands now, and the diff will " +
          "start again from today. There is no way back to the old one."
      )
    ) {
      return;
    }
    await recordFreeze(key, freezeFrom({ issues: allIssues, sprints, statusGroups }));
    await mount(container, creds);
  }
}

// ── Row 1: the sprint header ────────────────────────────────────────────────

function renderToolbar(ctx) {
  const { summary, live, excluded = ctx.team.excluded } = ctx;
  const header = make("header", "dash-header");
  const bar = make("div", "dash-toolbar");

  bar.appendChild(sprintSelector(ctx));

  const dates = make("div", "dash-dates");
  if (summary.window.start && summary.window.end) {
    dates.appendChild(
      make("span", "dash-dates-range mono", `${fmtDate(summary.window.start)} → ${fmtDate(summary.window.end)}`)
    );
    const day = sprintDay(summary, ctx.now);
    const where = make("span", "dash-dates-day");
    if (!live) where.textContent = `closed · ${summary.daysTotal} working days`;
    else if (day?.ended) {
      where.textContent = `ended ${relDate(summary.window.end)}`;
      where.classList.add("dash-overdue");
    } else if (day?.notStarted) where.textContent = "not started yet";
    else if (day) where.textContent = `Day ${day.day} of ${day.of}`;
    dates.appendChild(where);
  } else {
    dates.appendChild(make("span", "dash-dates-day", "No sprint dates"));
  }
  bar.appendChild(dates);

  bar.appendChild(integrations(ctx));

  const spacer = make("div", "dash-toolbar-spacer");
  bar.appendChild(spacer);

  // The standup is the ritual this screen prepares for, so its button wears the
  // standup's own gradient — the one place outside the standup it appears.
  const run = make("a", "btn primary dash-run-standup");
  run.href = "#standup";
  run.append(icon("timer", 15), "Run standup");
  run.title = "Start today's standup (S)";
  run.addEventListener("pointerdown", () => prewarmGithub(), { passive: true });
  bar.appendChild(run);

  bar.appendChild(userMenu(ctx));
  header.appendChild(bar);

  const meta = make("div", "dash-header-meta");
  for (const goal of summary.goals) meta.appendChild(make("p", "dash-goal", goal));
  // Said once, quietly, so a total that looks short has its reason beside it.
  if (excluded.issues) {
    const scope = make(
      "span",
      "dash-scope-note mono",
      `team only — ${excluded.issues} issue${excluded.issues === 1 ? "" : "s"} held outside the roster left out`
    );
    scope.title = excluded.keys.join(", ");
    meta.appendChild(scope);
  }
  if (meta.childNodes.length) header.appendChild(meta);
  return header;
}

// A native select: it is keyboard- and screen-reader-complete for free, and the
// list is a handful of sprints, not something to search. Filled in two steps —
// the sprint on screen first, the closed history when its request lands.
function sprintSelector({ summary, live, ref, sprints, closedPromise }) {
  const wrap = make("label", "dash-sprint-select");
  wrap.appendChild(make("span", "dash-sprint-select-label mono", "Sprint"));
  const select = make("select", "dash-select");
  select.setAttribute("aria-label", "Sprint");

  const currentLabel = summary.sprintNames.length ? summary.sprintNames.join(" · ") : "No active sprint";
  const fill = (closedLists = []) => {
    select.innerHTML = "";
    const current = make("option", "", `Current — ${live ? currentLabel : "the running sprint"}`);
    current.value = "";
    select.appendChild(current);
    let found = false;
    for (const { board, closed } of closedLists) {
      if (!closed.length) continue;
      const group = document.createElement("optgroup");
      group.label = BOARDS.length > 1 ? `${board.name} — closed` : "Closed sprints";
      for (const sprint of closed.slice(0, 6)) {
        const value = `${board.id}:${sprint.id}`;
        const option = make("option", "", `${sprint.name} · closed ${fmtDate(sprint.completeDate || sprint.endDate)}`);
        option.value = value;
        if (ref && value === `${ref.boardId}:${ref.sprintId}`) {
          option.selected = true;
          found = true;
        }
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    // A sprint further back than the list reaches still shows as itself.
    if (!live && !found && sprints[0]) {
      const option = make("option", "", sprints[0].name);
      option.value = `${ref.boardId}:${ref.sprintId}`;
      option.selected = true;
      select.appendChild(option);
    }
    if (live) select.value = "";
  };
  fill();
  closedPromise.then(fill);

  select.addEventListener("change", () => {
    location.hash = select.value ? `#dashboard/${select.value}` : "#dashboard";
  });
  wrap.appendChild(select);
  return wrap;
}

// Jira and GitHub, each a mark, a name and a dot that says what state the
// connection is in — the dot never alone: the title spells it out.
function integrations(ctx) {
  const wrap = make("div", "dash-integrations");
  const chip = (name, src) => {
    const el = make("a", "dash-integration");
    el.href = runtimeUrl("settings.html");
    el.target = "_blank";
    el.rel = "noopener";
    const img = make("img", name === "GitHub" ? "gh-mark" : "");
    img.src = src;
    img.alt = "";
    el.append(img, make("span", "", name), make("span", "dash-dot"));
    wrap.appendChild(el);
    return el;
  };

  const jira = chip("Jira", "assets/logos/jira.png");
  jira.dataset.state = "ok";
  const host = siteHost();
  jira.title = `Jira: connected${host ? " to " + host : ""} — the sprint on this screen came from it`;

  const gh = chip("GitHub", "assets/logos/github.png");
  const paint = () => {
    const { state, error } = ctx.github;
    gh.dataset.state = { off: "off", loading: "loading", ready: "ok", error: "error" }[state] || "off";
    gh.title = {
      off: "GitHub: not connected — set a token and a repo allowlist in Settings",
      loading: "GitHub: fetching pull requests and commits…",
      ready: "GitHub: connected — pull request figures are live",
      error: `GitHub: unavailable — ${error}`,
    }[state];
  };
  paint();
  ctx.onGithub.push(paint);
  return wrap;
}

// The signed-in Jira user, and the documents and settings that used to be
// buttons in this header: the recaps print from here.
function userMenu(ctx) {
  const wrap = make("div", "dash-menu");
  const trigger = make("button", "dash-avatar-btn");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account and recaps");
  const face = make("span", "dash-avatar dash-avatar-lg mono", "·");
  trigger.append(face, icon("chevron", 11));
  wrap.appendChild(trigger);

  const panel = make("div", "dash-menu-panel");
  panel.setAttribute("role", "menu");
  const who = make("div", "dash-menu-who");
  const whoName = make("div", "dash-menu-name", "Signed in");
  const whoMail = make("div", "dash-menu-mail mono", siteHost());
  who.append(whoName, whoMail);
  panel.appendChild(who);

  const recapHref = ctx.live
    ? "recap.html"
    : `recap.html?sprint=${ctx.ref.boardId}:${ctx.ref.sprintId}`;
  const items = [
    ...(ctx.summary.issueCount || ctx.summary.sprintNames.length
      ? [{
          label: ctx.live ? "Generate recap" : "Recap this sprint",
          href: recapHref,
          tooltip: "Opens a printable end-of-sprint recap — pick Save as PDF in the print dialog",
        }]
      : []),
    {
      label: "Recap past sprint",
      href: "recap.html?sprint=previous",
      tooltip: "Recaps the last sprint each board closed, as it stood when it closed",
    },
    {
      label: "Prepare a quarterly overview",
      href: "quarter.html",
      tooltip: "Opens a printable overview of the quarter so far — pick another quarter on the page",
    },
    {
      label: "Configure a recap…",
      href: "#recap-config",
      tooltip: "Choose boards and sprints — active or closed, one or several — for a recap",
      sameTab: true,
    },
    { label: "Settings", href: "settings.html", tooltip: "Boards, fields, roster, Jira and GitHub" },
  ];
  for (const item of items) {
    const link = make("a", "dash-menu-item", item.label);
    link.setAttribute("role", "menuitem");
    if (item.sameTab) link.href = item.href;
    else {
      link.href = runtimeUrl(item.href);
      link.target = "_blank";
      link.rel = "noopener";
    }
    link.title = item.tooltip;
    panel.appendChild(link);
  }
  wrap.appendChild(panel);

  const setOpen = (open) => {
    wrap.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", String(open));
  };
  // The listeners go with the menu: the header is rebuilt on every refresh.
  const onOutside = (e) => {
    if (!wrap.isConnected) {
      document.removeEventListener("click", onOutside, true);
      document.removeEventListener("keydown", onOutside, true);
      return;
    }
    if (e.type === "keydown" ? e.key === "Escape" : !wrap.contains(e.target)) setOpen(false);
  };
  document.addEventListener("click", onOutside, true);
  document.addEventListener("keydown", onOutside, true);
  trigger.addEventListener("click", () => setOpen(!wrap.classList.contains("open")));
  panel.addEventListener("click", (e) => {
    if (e.target.closest(".dash-menu-item")) setOpen(false);
  });

  getMyself(ctx.creds)
    .then((me) => {
      if (!me) return;
      whoName.textContent = me.displayName || "Signed in";
      if (me.emailAddress) whoMail.textContent = me.emailAddress;
      face.replaceWith(avatarEl(me.displayName || "", avatarSrc(me.accountId, me), "dash-avatar-lg"));
      trigger.title = me.displayName || "";
    })
    .catch(() => {});
  return wrap;
}

// ── Row 2: tabs ─────────────────────────────────────────────────────────────

function renderTabs() {
  const el = make("div", "dash-tabs");
  el.setAttribute("role", "tablist");
  const buttons = new Map();
  const panels = new Map();
  for (const [id, label] of [["team", "Team overview"], ["individual", "Individual view"]]) {
    const tab = make("button", "dash-tab", label);
    tab.type = "button";
    tab.id = `dash-tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `dash-panel-${id}`);
    tab.addEventListener("click", () => select(id));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = id === "team" ? "individual" : "team";
      select(next);
      buttons.get(next).focus();
    });
    buttons.set(id, tab);
    el.appendChild(tab);
  }
  function panel(id) {
    if (!panels.has(id)) {
      const p = make("div", "dash-panel");
      p.id = `dash-panel-${id}`;
      p.setAttribute("role", "tabpanel");
      p.setAttribute("aria-labelledby", `dash-tab-${id}`);
      panels.set(id, p);
    }
    return panels.get(id);
  }
  function select(id) {
    activeTab = id;
    for (const [key, tab] of buttons) {
      const on = key === id;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panel(key).hidden = !on;
    }
  }
  return { el, panel, select };
}

// ── Row 3: KPIs ─────────────────────────────────────────────────────────────

// A stat tile with an optional meter and an optional change chip. Returns
// setters, because three of the five fill in after the first paint.
function kpiCard({ label, value = "", unit = "", detail = "", meter = null, hint = "", onClick = null }) {
  const tile = make(onClick ? "button" : "div", "dash-kpi");
  if (onClick) {
    tile.type = "button";
    tile.classList.add("dash-kpi-clickable");
    tile.addEventListener("click", onClick);
  }
  const labelEl = make("div", "dash-kpi-label mono", label);
  if (hint) {
    const mark = make("span", "dash-hint-mark", "?");
    mark.title = hint;
    labelEl.appendChild(mark);
  }
  const valueEl = make("div", "dash-kpi-value");
  const unitEl = make("span", "dash-kpi-unit");
  const meterEl = make("div", "dash-kpi-meter");
  const fillEl = make("span", "dash-kpi-meter-fill");
  meterEl.appendChild(fillEl);
  const detailEl = make("div", "dash-kpi-detail");
  const deltaEl = make("div", "dash-delta");
  tile.append(labelEl, valueEl, meterEl, detailEl, deltaEl);

  const api = {
    el: tile,
    setValue(v, u = "") {
      valueEl.textContent = v;
      unitEl.textContent = u;
      if (u) valueEl.appendChild(unitEl);
    },
    setMeter(share) {
      meterEl.hidden = share === null || share === undefined;
      fillEl.style.width = `${Math.max(0, Math.min(1, share || 0)) * 100}%`;
    },
    setDetail(text) {
      detailEl.textContent = text;
    },
    // `tone` is what the change means, not which way it points: fewer blockers
    // is good news on a number that went down.
    setDelta({ text = "", change = 0, tone = "neutral" } = {}) {
      deltaEl.innerHTML = "";
      deltaEl.className = `dash-delta tone-${tone}`;
      if (!text) return;
      if (change) {
        const caret = icon("chevron", 11);
        if (change > 0) caret.classList.add("icon-rot-180");
        deltaEl.appendChild(caret);
      }
      deltaEl.append(text);
    },
  };
  api.setValue(value, unit);
  api.setMeter(meter);
  api.setDetail(detail);
  return api;
}

function signed(n, digits = 0) {
  const value = digits ? Number(n).toFixed(digits) : String(Math.round(n));
  return n > 0 ? `+${value}` : n < 0 ? `−${value.replace("-", "")}` : "±0";
}

function renderKpis(ctx) {
  const { summary, live, now } = ctx;
  const row = make("div", "dash-kpis");

  // 1. Time. Kept apart from the work on purpose: day 8 of 14 says nothing
  //    about whether 57% of the work is done, and the next card says that.
  const day = sprintDay(summary, now);
  const progress = kpiCard({ label: "Sprint progress" });
  if (!day) {
    progress.setValue("—");
    progress.setMeter(null);
    progress.setDetail("No sprint dates — start the sprint in Jira to see a timeline");
  } else if (!live || day.ended) {
    progress.setValue(`${day.of} of ${day.of}`, "days");
    progress.setMeter(1);
    progress.setDetail(live ? `Ended ${relDate(summary.window.end)}` : `Closed ${fmtDate(summary.window.end)}`);
  } else {
    progress.setValue(day.notStarted ? `0 of ${day.of}` : `Day ${day.day} of ${day.of}`);
    progress.setMeter(day.share);
    progress.setDetail(
      `${Math.round(day.share * 100)}% of working days elapsed · ${summary.daysRemaining} left`
    );
  }
  row.appendChild(progress.el);

  // 2. Work. Points done over the sprint's points now; in review and the
  //    original commitment beside it, kept as separate figures.
  const scope = scopeChange({ summary, diff: ctx.scopeDiff });
  const completion = kpiCard({
    label: "Committed vs completed",
    hint: "Story points done, over the sprint's points as it stands now. Sub-tasks excluded; unestimated issues count as zero.",
  });
  if (summary.totalPoints > 0) {
    completion.setValue(`${trimNum(summary.donePoints)} / ${trimNum(summary.totalPoints)}`, "pts");
    completion.setMeter(summary.completionByPoints);
    completion.setDetail(
      `${Math.round(summary.completionByPoints * 100)}% complete · ${trimNum(summary.reviewPoints)} in review`
    );
    if (scope.basis === "freeze") {
      completion.setDelta({ text: `committed ${trimNum(scope.original)} at the freeze` });
    }
  } else {
    completion.setValue("—");
    completion.setMeter(null);
    completion.setDetail(
      summary.issueCount ? `No estimates · ${summary.doneIssues} of ${summary.issueCount} issues done` : "Nothing in the sprint"
    );
  }
  row.appendChild(completion.el);

  // 3. Tickets closed, against the previous sprint *at the same working day* —
  //    read off that sprint's own history once its issues have been fetched.
  const closed = kpiCard({
    label: "Tickets closed",
    hint: "Issues done in this sprint. Compared with the previous sprint at the same working day, from that sprint's issue history, so day 8 is never measured against a finished fortnight.",
  });
  closed.setValue(String(summary.doneIssues));
  closed.setMeter(null);
  closed.setDetail(`of ${summary.issueCount} issue${summary.issueCount === 1 ? "" : "s"} in the sprint`);
  closed.setDelta({ text: "comparing with the previous sprint…" });
  row.appendChild(closed.el);

  // 4. Blockers, against the last reading from an earlier day. Opens the list:
  //    a count you can see is a count you should be able to act on.
  const blockedRows = ctx.issues.filter((i) => isBlocked(i, ctx.statusGroups));
  const blockers = kpiCard({
    label: "Blockers",
    hint: "Open issues that are flagged in Jira, or sit in a status whose name says blocked or on hold. Click for the list.",
    onClick: () =>
      openList(ctx, {
        title: "Blocked issues",
        subtitle: "Flagged, or in a blocked or on-hold status.",
        rows: blockedRows.map((i) => listRow(i, i.fields?.status?.name || "")),
        kind: "issues",
      }),
  });
  blockers.setValue(String(summary.blocked), "open");
  blockers.setMeter(null);
  blockers.setDetail(
    summary.blocked
      ? `${trimNum(summary.blockedPoints)} point${summary.blockedPoints === 1 ? "" : "s"} waiting on something`
      : "Nothing blocked"
  );
  const before = live ? previousReading(ctx.snapshots, "blocked", now) : null;
  if (before) {
    const change = summary.blocked - before.value;
    blockers.setDelta({
      text: `${signed(change)} since ${fmtDate(before.date)}`,
      change,
      tone: change > 0 ? "bad" : change < 0 ? "good" : "neutral",
    });
  } else if (live) {
    blockers.setDelta({ text: "first reading — the change shows from tomorrow" });
  }
  row.appendChild(blockers.el);

  // 5. Review turnaround, GitHub's half of the row.
  const review = kpiCard({
    label: "PR review turnaround",
    hint: "Median time from a pull request being opened to its first review by someone else, over PRs opened in the sprint. Compared with the previous sprint's window.",
  });
  row.appendChild(review.el);
  const paintReview = () => {
    const { state, stats, since } = ctx.github;
    review.setMeter(null);
    if (state === "off") {
      review.setValue("—");
      review.setDetail("Connect GitHub in Settings to measure review time");
      review.setDelta({});
      return;
    }
    if (state === "loading") {
      review.setValue("…");
      review.setDetail("Fetching pull requests");
      return;
    }
    if (state === "error") {
      review.setValue("—");
      review.setDetail(`GitHub unavailable — ${ctx.github.error}`);
      return;
    }
    const until = live ? "" : summary.window.end ? new Date(summary.window.end.getTime() + 86399999).toISOString() : "";
    const t = reviewTurnaround(stats, { since, until });
    if (!t || t.median === null) {
      review.setValue("—");
      review.setDetail(t?.unreviewed ? `${t.unreviewed} PR${t.unreviewed === 1 ? "" : "s"} opened, none reviewed yet` : "No pull requests opened in the sprint yet");
      return;
    }
    const median = trimNum(t.median);
    review.setValue(median, median === "1" ? "day" : "days");
    review.setDetail(
      `median over ${t.reviewed} reviewed PR${t.reviewed === 1 ? "" : "s"}` +
        (t.unreviewed ? ` · ${t.unreviewed} awaiting a first review` : "") +
        (t.clamped ? " · window clamped to the GitHub lookback" : "")
    );
    paintComparisons();
  };

  // The previous sprint's window and issues, for cards 3 and 5.
  let previous = null; // { sprints, start, end, issues }
  const paintComparisons = () => {
    if (previous === null) return;
    if (previous === false) {
      closed.setDelta({ text: "no earlier sprint to compare with" });
      return;
    }
    // Card 3: the same point in the previous sprint.
    const n = !live || !day || day.ended ? null : day.day;
    const cutoff = n ? endOfWorkingDay(previous.start, n, previous.end) : previous.end;
    const then = closedBy(previous.issues, { from: previous.start, cutoff, statusGroups: ctx.statusGroups });
    const change = summary.doneIssues - then.count;
    const when = n ? `by day ${n}` : "in total";
    closed.setDelta({
      text: `${signed(change)} vs ${then.count}${then.partial ? "+" : ""} ${when} last sprint`,
      change,
      tone: change > 0 ? "good" : change < 0 ? "bad" : "neutral",
    });
    // Card 5: the previous sprint's own window.
    if (ctx.github.state === "ready") {
      const now5 = reviewTurnaround(ctx.github.stats, {
        since: ctx.github.since,
        until: live ? "" : summary.window.end?.toISOString() || "",
      });
      const prev5 = reviewTurnaround(ctx.github.stats, {
        since: previous.start.toISOString(),
        until: previous.end.toISOString(),
      });
      if (now5?.median !== null && prev5?.median !== null && now5 && prev5) {
        const change5 = now5.median - prev5.median;
        review.setDelta({
          text: `${signed(change5, 1)} days vs ${trimNum(prev5.median)} last sprint${prev5.clamped ? " (partial)" : ""}`,
          change: change5,
          tone: change5 < -0.05 ? "good" : change5 > 0.05 ? "bad" : "neutral",
        });
      } else {
        review.setDelta({ text: "no reviewed PRs last sprint to compare with" });
      }
    }
  };
  paintReview();
  ctx.onGithub.push(paintReview);

  ctx.closedPromise
    .then(async (lists) => {
      const pairs = [];
      for (const { board, sprints } of ctx.boardSprints) {
        const closedList = lists.find((l) => l.board.id === board.id)?.closed || [];
        for (const sprint of sprints) {
          const prev = previousSprintFor(sprint, closedList);
          if (prev) pairs.push({ board, sprints: [prev] });
        }
      }
      const dated = pairs.flatMap((p) => p.sprints).filter((s) => s.startDate);
      if (!dated.length) {
        previous = false;
        return;
      }
      const start = new Date(Math.min(...dated.map((s) => new Date(s.startDate).getTime())));
      const end = new Date(Math.max(...dated.map((s) => new Date(s.completeDate || s.endDate).getTime())));
      const prevIssues = await getIssuesForSprints(pairs, ctx.creds);
      previous = { start, end, issues: prevIssues.filter(isTeamIssue) };
    })
    .catch(() => {
      previous = false;
    })
    .then(paintComparisons);

  return row;
}

// The previous sprint is scoped to the team the same way this one is.
function isTeamIssue(issue) {
  const id = issue.fields?.assignee?.accountId;
  return !id || !activeMembers().length || Boolean(memberFor(id));
}

// ── Row 4: charts ───────────────────────────────────────────────────────────

function card(title, extraClass = "") {
  const el = make("section", `dash-card ${extraClass}`.trim());
  const head = make("div", "dash-card-head");
  head.appendChild(make("h2", "dash-card-title", title));
  el.appendChild(head);
  return { el, head };
}

function renderCharts(ctx) {
  const row = make("div", "dash-charts");
  row.appendChild(renderBurndown(ctx));
  row.appendChild(renderVelocity(ctx));
  row.appendChild(renderStatusSplit(ctx));
  return row;
}

function renderBurndown(ctx) {
  const { summary, burndown, snapshots } = ctx;
  const { el, head } = card("Sprint burndown");
  const readout = make("span", "dash-readout mono");
  head.appendChild(readout);

  if (!burndown) {
    el.appendChild(emptyState("No sprint dates, so there is no timeline to burn down against."));
    return el;
  }
  if (!burndown.ready) {
    el.appendChild(
      make(
        "div",
        "chart-empty dash-burndown-empty",
        !ctx.live
          ? "No daily history was recorded on this device while this sprint ran, so there is no line to draw."
          : snapshots.length <= 1
          ? `Collecting history. Jira has no public API for past sprint state, so ${CONFIG.brand.productName} records one snapshot a day from data it already has — the burndown appears tomorrow.`
          : `Collecting history — ${burndown.have} of ${burndown.need} days recorded so far.`
      )
    );
    return el;
  }

  const delta = burndown.deltaPoints;
  const restLine = () =>
    delta === null
      ? ""
      : Math.abs(delta) < 0.5
        ? "on the ideal line"
        : delta > 0
          ? `${trimNum(delta)} pts behind ideal`
          : `${trimNum(-delta)} pts ahead of ideal`;
  readout.textContent = restLine();
  readout.classList.toggle("behind", delta !== null && delta > 0.5);

  const slot = make("div", "dash-chart-slot");
  el.appendChild(slot);
  // Drawn once the card has a width, so the SVG's text is drawn at the size it
  // is read at rather than scaled from a guess.
  ctx.afterAttach.push(() => {
    const width = Math.max(280, Math.round(slot.clientWidth));
    slot.appendChild(
      burndownChart(burndown, {
        width,
        height: 210,
        padding: { top: 12, right: 14, bottom: 26, left: 34 },
        onHover: (point) => {
          if (!point) {
            readout.textContent = restLine();
            return;
          }
          const actual = point.actual ? `${trimNum(point.actual.points)} left` : "no snapshot";
          const ideal = point.ideal ? `${trimNum(point.ideal.points)} ideal` : "—";
          readout.textContent = `${point.date} · ${actual} · ${ideal}`;
        },
      })
    );
  });
  el.appendChild(
    legend([
      { label: "Points remaining", fill: "var(--chart-series-1)" },
      { label: "Ideal", fill: "var(--chart-muted-line)", dashed: true },
    ])
  );
  el.appendChild(
    make("p", "dash-note", `Remaining story points per working day, ${summary.daysTotal} days in all.`)
  );
  return el;
}

// Completed points for the last six sprints, from the per-sprint history
// (M17). The running sprint is drawn hollow beside the closed ones and
// labelled provisional, so a sprint in its second week never reads as a slump;
// a closed sprint whose last reading came before its last day is drawn lighter,
// because its figure is a floor. The rest of each row — commitment, issues,
// completion, pull requests, lines — is one click away in the drawer.
function renderVelocity(ctx) {
  const { summary, live, now } = ctx;
  const { el, head } = card("Velocity trend");
  el.classList.add("dash-velocity");
  const readout = make("span", "dash-readout mono");
  head.appendChild(readout);
  const slot = make("div", "dash-chart-slot");
  const foot = make("div", "dash-velocity-foot");
  el.append(slot, foot);

  const upTo = live ? null : isoDay(summary.window.start);
  const paint = () => {
    const rows = trendRows(ctx.sprintHistory, { liveKey: live ? ctx.key : "", upTo });
    slot.innerHTML = "";
    foot.innerHTML = "";
    const closed = rows.filter((r) => !r.running);
    const mean = meanCompleted(rows);
    readout.textContent = mean === null ? "" : `avg ${trimNum(mean)} pts`;
    readout.title = mean === null ? "" : "Mean completed points over the closed sprints shown whose last reading was on or after their last day.";

    if (!rows.length) {
      slot.appendChild(emptyState("No sprint has been recorded on this device yet."));
      return;
    }
    const day = sprintDay(summary, now);
    const width = Math.max(240, Math.round(slot.clientWidth || 320));
    slot.appendChild(
      comboChart(
        {
          labels: rows.map((r) => shortSprintName(r.name)),
          partial: rows.map((r) => Boolean(r.partial?.jira)),
          hollow: rows.map((r) => r.running),
          bars: [{ name: "Points completed", fill: "var(--chart-series-1)", values: rows.map((r) => r.pointsCompleted) }],
        },
        {
          width,
          height: 210,
          barMax: 28,
          format: (v) => trimNum(v),
          hollowLabel: day && !day.ended ? `provisional, day ${day.day} of ${day.of}` : "provisional",
          partialLabel: "incomplete: last read before its last day",
          weekTitle: (i) => {
            const r = rows[i];
            const committed = r.pointsCommitted === null ? "" : ` · committed ${trimNum(r.pointsCommitted)}`;
            return `${r.name || r.key} · ${r.start || "?"} → ${r.end || "?"}${committed}`;
          },
        }
      )
    );

    const running = rows.find((r) => r.running);
    foot.appendChild(
      make(
        "span",
        "dash-note",
        running
          ? closed.length
            ? `Hollow: this sprint so far, provisional${day && !day.ended ? ` — day ${day.day} of ${day.of}` : ""}.`
            : "Hollow: this sprint so far. Each sprint is added here as it closes."
          : `${closed.length} closed sprint${closed.length === 1 ? "" : "s"}.`
      )
    );
    if (rows.length) {
      const more = make("button", "btn small dash-velocity-more", "All figures");
      more.type = "button";
      more.addEventListener("click", () => openSprintHistory(ctx));
      foot.appendChild(more);
    }
  };
  ctx.afterAttach.push(paint);
  ctx.repaint.push(paint);
  return el;
}

// Every stored row, as small multiples on one shared set of sprints, then as a
// table. One measure a chart: points, issues, completion, pull requests and
// lines have three units and very different sizes, and a multi-axis chart
// would invent a relationship between them.
function openSprintHistory(ctx) {
  const rows = trendRows(ctx.sprintHistory, { liveKey: ctx.live ? ctx.key : "", limit: 26 });
  const { body } = openDrawerPanel({ label: "Sprint history", className: "dash-list-drawer dash-history-drawer" });
  const wrap = make("div", "dash-list");
  wrap.appendChild(make("h2", "dash-list-title", "Sprint history"));
  wrap.appendChild(
    make(
      "p",
      "dash-note",
      `${rows.filter((r) => !r.running).length} closed sprints recorded on this device. Solid is the outcome, dashed what it is measured against; hollow points are the running sprint.`
    )
  );

  const labels = rows.map((r) => shortSprintName(r.name));
  const partial = rows.map((r) => r.running);
  const gh = (f) => rows.map((r) => (r.github ? r.github[f] : null));
  const pct = (v) => `${Math.round(v)}%`;
  const OUT = "var(--chart-series-1)";
  const BASE = "var(--chart-muted-line)";
  const multiples = [
    {
      title: "Story points",
      series: [
        { name: "Completed", stroke: OUT, values: rows.map((r) => r.pointsCompleted) },
        { name: "Committed", stroke: BASE, dashed: true, values: rows.map((r) => r.pointsCommitted) },
      ],
    },
    {
      title: "Issues",
      series: [
        { name: "Closed", stroke: OUT, values: rows.map((r) => r.issuesClosed) },
        { name: "In the sprint", stroke: BASE, dashed: true, values: rows.map((r) => r.issues) },
      ],
    },
    {
      title: "Completion",
      format: pct,
      series: [{ name: "Of commitment", stroke: OUT, values: rows.map((r) => (completionRate(r) === null ? null : completionRate(r) * 100)) }],
    },
    {
      title: "Pull requests",
      series: [
        { name: "Merged", stroke: OUT, values: gh("prsMerged") },
        { name: "Opened", stroke: BASE, dashed: true, values: gh("prsOpened") },
      ],
    },
    {
      title: "Lines reaching the default branch",
      format: (v) => compactNum(v),
      series: [{ name: "Added + removed", stroke: OUT, values: rows.map((r) => (r.github ? r.github.additions + r.github.deletions : null)) }],
    },
  ];

  const grid = make("div", "dash-history-grid");
  for (const m of multiples) {
    const cell = make("div", "dash-history-cell");
    cell.appendChild(make("h3", "dash-history-title", m.title));
    const has = m.series.some((s) => s.values.some((v) => v !== null && v !== undefined));
    if (!has) {
      cell.appendChild(emptyState(m.title === "Pull requests" || m.title.startsWith("Lines") ? "No GitHub figures stored." : "Nothing stored."));
    } else {
      cell.appendChild(
        weeklyLines(
          { labels, partial, series: m.series },
          { width: 330, height: 130, compact: true, format: m.format, partialLabel: "provisional" }
        )
      );
      if (m.series.length > 1) {
        cell.appendChild(legend(m.series.map((s) => ({ label: s.name, fill: s.stroke, dashed: s.dashed }))));
      }
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  const table = make("table", "dash-history-table mono");
  const headRow = table.createTHead().insertRow();
  for (const h of ["Sprint", "Dates", "Committed", "Completed", "Rate", "Issues", "Closed", "PRs merged", "Reviewed", "Lines", ""]) {
    headRow.appendChild(make("th", "", h));
  }
  const tbody = table.createTBody();
  for (const r of [...rows].reverse()) {
    const tr = tbody.insertRow();
    const rate = completionRate(r);
    const notes = [
      r.running ? "provisional" : "",
      r.partial?.jira ? "Jira incomplete" : "",
      r.partial?.github ? "GitHub incomplete" : "",
    ].filter(Boolean).join(", ");
    const cells = [
      r.name || r.key,
      `${r.start || "?"} → ${r.end || "?"}`,
      r.pointsCommitted === null ? "—" : trimNum(r.pointsCommitted),
      trimNum(r.pointsCompleted),
      rate === null ? "—" : `${Math.round(rate * 100)}%`,
      String(r.issues),
      String(r.issuesClosed),
      r.github ? String(r.github.prsMerged) : "—",
      r.github ? String(r.github.prsReviewed) : "—",
      r.github ? compactNum(r.github.additions + r.github.deletions) : "—",
      notes,
    ];
    for (const c of cells) tr.insertCell().textContent = c;
    tr.cells[0].title = cells[0];
  }
  const scroll = make("div", "dash-history-scroll");
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  wrap.appendChild(
    make("p", "dash-note", "Stored on this device only. Settings → Backup & transfer deletes it, and backs it up.")
  );
  body.appendChild(wrap);
}

function renderStatusSplit(ctx) {
  const { el, head } = card("Issue status");
  const dist = statusDistribution(ctx.issues, ctx.statusGroups);
  const readout = make("span", "dash-readout mono");
  head.appendChild(readout);
  if (!dist.total) {
    el.appendChild(emptyState("Nothing in the sprint yet."));
    return el;
  }

  const body = make("div", "dash-status-body");
  const segments = dist.slices.map((s) => ({ label: s.label, value: s.count, fill: sliceFill(s.label) }));
  body.appendChild(
    donutChart(segments, {
      size: 156,
      thickness: 20,
      centerValue: String(dist.total),
      centerLabel: dist.total === 1 ? "issue" : "issues",
      onHover: (segment) => {
        readout.textContent = segment
          ? `${segment.label} · ${segment.value} · ${Math.round((segment.value / dist.total) * 100)}%`
          : "";
      },
    })
  );

  // The legend carries every figure, so the ring never has to. Each row opens
  // the issues behind it.
  const list = make("ul", "dash-status-legend");
  for (const slice of dist.slices) {
    const li = make("li");
    const btn = make("button", "dash-status-row");
    btn.type = "button";
    btn.disabled = !slice.count;
    const swatch = make("span", "chart-dot-key");
    swatch.style.background = sliceFill(slice.label);
    btn.append(
      swatch,
      make("span", "dash-status-name", slice.label),
      make("span", "dash-status-count mono", String(slice.count)),
      make("span", "dash-status-pct mono", `${Math.round(slice.share * 100)}%`)
    );
    btn.title = slice.count ? `Show the ${slice.count} ${slice.label.toLowerCase()} issue${slice.count === 1 ? "" : "s"}` : "";
    btn.addEventListener("click", () => {
      const keys = new Set(slice.keys);
      openList(ctx, {
        title: `${slice.label} — ${slice.count}`,
        subtitle: "Sub-tasks excluded, as everywhere on this screen.",
        rows: ctx.issues.filter((i) => keys.has(i.key)).map((i) => listRow(i, i.fields?.status?.name || "")),
        kind: "issues",
      });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  body.appendChild(list);
  el.appendChild(body);
  return el;
}

// ── Row 5: team health and the checklist ────────────────────────────────────

function renderHealth(ctx) {
  const row = make("div", "dash-health");
  const left = card("Team workload & health", "dash-health-main");
  const inner = make("div", "dash-health-inner");
  inner.appendChild(renderWorkload(ctx));
  const side = make("div", "dash-health-side");
  side.appendChild(renderScopeCard(ctx));
  side.appendChild(renderCarryOver(ctx));
  inner.appendChild(side);
  left.el.appendChild(inner);
  row.appendChild(left.el);
  row.appendChild(renderAttention(ctx));
  return row;
}

function renderWorkload(ctx) {
  const { summary, live } = ctx;
  const hoursPerPoint = CONFIG.planner?.hoursPerPoint || 8;
  const model = workload({
    summary,
    members: ctx.members,
    daysRemaining: live ? summary.daysRemaining : 0,
    hoursPerPoint,
    ended: !live || summary.isOverdue,
  });
  const wrap = make("div", "dash-workload");
  if (!model.rows.length) {
    wrap.appendChild(emptyState("Nobody holds sprint work, and there is no roster to list."));
    return wrap;
  }

  const list = make("ul", "dash-workload-list");
  for (const row of model.rows) {
    const li = make("li", `dash-workload-row state-${row.state}`);
    const who = make("a", "dash-workload-who");
    who.href = `#oneone/${encodeURIComponent(row.key)}`;
    who.title = `Open ${row.label || "their"} 1:1 sheet`;
    who.appendChild(avatarEl(row.label, avatarSrc(row.key, assigneeFor(ctx, row.key)), ""));
    const names = make("span", "dash-workload-names");
    names.append(
      make("span", "dash-workload-name", row.label || memberLabel(row.member || { email: row.key })),
      make("span", "dash-workload-role", row.role || (row.member ? "" : "not on the roster"))
    );
    who.appendChild(names);
    li.appendChild(who);

    // One bar per person on a shared scale: done, in review, still open, and
    // the capacity line for the days left drawn across it.
    const bar = make("div", "dash-load-bar");
    bar.setAttribute("role", "img");
    const scale = model.scale;
    const seg = (cls, points) => {
      if (!(points > 0)) return;
      const s = make("span", `dash-load-seg ${cls}`);
      s.style.width = `${(points / scale) * 100}%`;
      bar.appendChild(s);
    };
    seg("done", row.donePoints);
    seg("review", row.reviewPoints);
    seg("open", row.openPoints);
    if (model.capacity) {
      const cap = make("span", "dash-load-cap");
      cap.style.left = `${Math.min(100, (model.capacity / scale) * 100)}%`;
      cap.title = `Capacity for the ${summary.daysRemaining} working days left: ${trimNum(model.capacity)} points`;
      bar.appendChild(cap);
    }
    bar.setAttribute(
      "aria-label",
      `${trimNum(row.donePoints)} done, ${trimNum(row.reviewPoints)} in review, ${trimNum(row.openPoints)} open of ${trimNum(row.points)} points`
    );
    li.appendChild(bar);

    li.appendChild(
      make(
        "span",
        "dash-workload-figs mono",
        row.issues ? `${trimNum(row.donePoints + row.reviewPoints)} / ${trimNum(row.points)} pts` : "—"
      )
    );
    li.appendChild(loadChip(row));
    list.appendChild(li);
  }
  wrap.appendChild(list);

  wrap.appendChild(
    legend([
      { label: "Done", fill: "var(--chart-series-1)" },
      { label: "In review", fill: "var(--chart-series-review)" },
      { label: "Open", fill: "var(--chart-series-open)" },
      ...(model.capacity ? [{ label: "Capacity left", fill: "var(--text)", dashed: true }] : []),
    ])
  );
  const notes = [
    model.capacity
      ? `Capacity is the ${summary.daysRemaining} working days left at ${hoursPerPoint} hours a point (Settings → Planner), so over means more open points than days.`
      : "The sprint has no days left, so there is no capacity to measure against.",
    "Ordered by name: this is what people hold, not what they delivered.",
  ];
  if (model.unassigned?.issues) {
    notes.push(
      `${model.unassigned.issues} unassigned issue${model.unassigned.issues === 1 ? "" : "s"} (${trimNum(model.unassigned.points)} open points) not on anyone's bar.`
    );
  }
  wrap.appendChild(make("p", "dash-note", notes.join(" ")));
  return wrap;
}

// Status never by colour alone: an icon and a word.
function loadChip(row) {
  const chip = make("span", `dash-load-chip state-${row.state}`);
  if (row.state === "over") chip.append(icon("warning", 12), "Over capacity");
  else if (row.state === "near") chip.append(icon("warning", 12), "Near capacity");
  else if (row.state === "idle") chip.append("No sprint work");
  else if (row.state === "unestimated") chip.append("No estimates");
  // No capacity — the sprint is over — means nothing to call OK against.
  else if (row.capacity === null) chip.hidden = true;
  else chip.append(icon("check", 12), "OK");
  if (row.load !== null && row.state !== "idle") {
    chip.title = `${trimNum(row.openPoints)} open points against ${trimNum(row.capacity)} of capacity (${Math.round(row.load * 100)}%)`;
  }
  return chip;
}

function smallCard(title) {
  const el = make("div", "dash-mini");
  el.appendChild(make("div", "dash-kpi-label mono", title));
  return el;
}

function renderScopeCard(ctx) {
  const scope = scopeChange({ summary: ctx.summary, diff: ctx.scopeDiff });
  const el = smallCard("Scope change");
  const basis = scope.basis === "freeze" ? scopeBasis(ctx.freeze) : scopeBasis(null);
  el.querySelector(".dash-kpi-label").appendChild(
    Object.assign(make("span", "dash-hint-mark", "?"), { title: basis.note })
  );
  el.appendChild(make("div", "dash-mini-value", `${signed(scope.net, scope.net % 1 ? 1 : 0)} pts`));
  el.appendChild(
    make(
      "div",
      "dash-kpi-detail",
      scope.share === null
        ? "No original commitment to measure against"
        : `${signed(scope.share * 100)}% on ${trimNum(scope.original)} committed · ${scope.exact ? "exact" : "approx."}`
    )
  );
  const parts = [`${trimNum(scope.added)} added (${scope.addedCount})`];
  if (scope.removed !== null) parts.push(`${trimNum(scope.removed)} removed (${scope.removedCount})`);
  if (scope.reEstimated) parts.push(`re-estimates ${signed(scope.reEstimated, scope.reEstimated % 1 ? 1 : 0)}`);
  el.appendChild(make("div", "dash-mini-parts mono", parts.join(" · ")));
  if (ctx.freeze) {
    const link = make("a", "dash-mini-link", "What changed ↓");
    link.href = "#dash-freeze";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("dash-freeze")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.appendChild(link);
  }
  return el;
}

function renderCarryOver(ctx) {
  const el = smallCard(ctx.live && !ctx.summary.isOverdue ? "Carry-over risk" : "Carried over");
  const risk = carryOverRisk({ summary: ctx.summary, snapshots: ctx.snapshots, now: ctx.now });
  el.querySelector(".dash-kpi-label").appendChild(
    Object.assign(make("span", "dash-hint-mark", "?"), {
      title:
        "A projection: points done per working day so far, carried over the days left, against what is still open. The share of the sprint's points that pace leaves unfinished.",
    })
  );
  if (!risk || risk.risk === null) {
    el.appendChild(make("div", "dash-mini-value", "—"));
    el.appendChild(
      make("div", "dash-kpi-detail", ctx.summary.totalPoints ? "Needs one finished working day to set a pace" : "No estimated points")
    );
    return el;
  }
  el.appendChild(make("div", "dash-mini-value", `${Math.round(risk.risk * 100)}%`));
  el.appendChild(
    make(
      "div",
      "dash-kpi-detail",
      risk.ended
        ? `${trimNum(risk.spillPoints)} points were still open at the end`
        : `≈ ${trimNum(risk.spillPoints)} points likely to spill at the current pace`
    )
  );
  if (risk.delta !== null) {
    const change = Math.round(risk.delta * 100);
    const d = make("div", `dash-delta tone-${change > 0 ? "bad" : change < 0 ? "good" : "neutral"}`);
    if (change) {
      const caret = icon("chevron", 11);
      if (change > 0) caret.classList.add("icon-rot-180");
      d.appendChild(caret);
    }
    d.append(`${signed(change)} pts since ${fmtDate(risk.previousDate)}`);
    el.appendChild(d);
  }
  return el;
}

// The checklist the spec calls the highest-value part of the screen, so it
// sticks: it stays in view while the workload beside it scrolls. Every row
// opens the issues or pull requests behind its count.
function renderAttention(ctx) {
  const { el } = card("Items to check manually", "dash-attention");
  if (!ctx.live) {
    el.appendChild(
      emptyState("These checks are about the running sprint. Switch the selector back to Current to see them.")
    );
    return el;
  }
  const list = make("ul", "dash-check-list");
  el.appendChild(list);
  const foot = make("a", "dash-mini-link", "Hygiene checks on Monitor →");
  foot.href = "#monitor";
  el.appendChild(foot);

  const paint = () => {
    list.innerHTML = "";
    for (const check of attention(ctx)) {
      const li = make("li");
      const btn = make("button", "dash-check");
      btn.type = "button";
      btn.append(make("span", "dash-check-label", check.label));
      const count = make("span", "dash-check-count mono");
      if (check.state === "loading") count.textContent = "…";
      else if (check.state === "off") count.textContent = "off";
      else if (check.state === "error") count.textContent = "n/a";
      else count.textContent = String(check.count);
      count.classList.toggle("has", check.state === "ready" && check.count > 0);
      btn.append(count);
      const caret = icon("chevron", 11);
      caret.classList.add("icon-rot-90");
      btn.appendChild(caret);
      btn.disabled = check.state !== "ready" || !check.count;
      btn.title = {
        loading: "Still looking",
        off: "Connect GitHub in Settings for this check",
        error: "The lookup failed — refresh to try again",
      }[check.state] || (check.count ? `Show the ${check.count}` : "Nothing to check");
      btn.addEventListener("click", () =>
        openList(ctx, { title: check.label, subtitle: "", rows: check.rows, kind: check.kind })
      );
      li.appendChild(btn);
      list.appendChild(li);
    }
  };
  paint();
  ctx.repaint.push(paint);
  return el;
}

function attention(ctx) {
  return attentionChecks({
    issues: ctx.issues,
    statusGroups: ctx.statusGroups,
    freeze: ctx.freeze,
    windowStart: ctx.summary.window.start,
    pullRequests: ctx.github.activity ? ctx.github.activity.pullRequests || [] : null,
    githubState: ctx.github.activityState,
    links: ctx.links,
    linksState: ctx.linksState,
    now: ctx.now,
  });
}

// ── Row 6: standup prep ─────────────────────────────────────────────────────

function renderStandupPrep(ctx) {
  const section = make("section", "dash-card dash-prep");
  const head = make("div", "dash-card-head");
  head.appendChild(make("h2", "dash-card-title", "Today's standup prep"));
  const since = make(
    "span",
    "dash-readout mono",
    ctx.lastStandup ? `since the last standup, ${stamp(ctx.lastStandup)}` : `since ${stamp(ctx.standupSince)}, the previous working day`
  );
  head.appendChild(since);
  section.appendChild(head);

  const grid = make("div", "dash-prep-grid");

  const prompts = make("div", "dash-prep-col");
  prompts.appendChild(make("h3", "dash-prep-title", "Key prompts"));
  const ol = make("ol", "dash-prompts");
  for (const q of ["What did you work on yesterday?", "What will you work on today?", "Any blockers or risks?"]) {
    ol.appendChild(make("li", "", q));
  }
  prompts.appendChild(ol);
  grid.appendChild(prompts);

  const missing = make("div", "dash-prep-col");
  grid.appendChild(missing);
  const context = make("div", "dash-prep-col");
  grid.appendChild(context);
  section.appendChild(grid);

  const jira = activityFrom(ctx.issues, { since: ctx.standupSince, statusGroups: ctx.statusGroups });

  const paintMissing = () => {
    missing.innerHTML = "";
    missing.appendChild(make("h3", "dash-prep-title", "No recent activity"));
    if (!ctx.members.length) {
      missing.appendChild(make("p", "dash-note", "Add the team roster in Settings → Team to see who has not moved anything."));
      return;
    }
    const result = quietMembers({
      members: ctx.members,
      jira,
      github: ctx.github.state === "ready" ? ctx.github.stats : null,
      statsFor,
      since: ctx.standupSince,
    });
    if (result.unknown) {
      missing.appendChild(make("p", "dash-note", "No issue history or GitHub data to read, so this cannot tell."));
      return;
    }
    const count = make("div", "dash-prep-count");
    count.append(
      make("span", "dash-mini-value", String(result.quiet.length)),
      make("span", "dash-kpi-detail", `of ${ctx.members.length} with nothing moved in Jira${ctx.github.state === "ready" ? " or GitHub" : ""}`)
    );
    missing.appendChild(count);
    if (!result.quiet.length) {
      missing.appendChild(make("p", "dash-note", "Everyone has moved something since then."));
    } else {
      const ul = make("ul", "dash-quiet-list");
      for (const member of result.quiet) {
        const li = make("li");
        const a = make("a", "dash-quiet");
        a.href = `#oneone/${encodeURIComponent(member.accountId)}`;
        a.title = "Open their 1:1 sheet — what they hold and what moved";
        a.append(
          avatarEl(memberLabel(member), avatarSrc(member.accountId, assigneeFor(ctx, member.accountId)), ""),
          make("span", "", memberLabel(member))
        );
        li.appendChild(a);
        ul.appendChild(li);
      }
      missing.appendChild(ul);
    }
    missing.appendChild(
      make(
        "p",
        "dash-note",
        ctx.github.state === "loading"
          ? "GitHub still loading — someone listed here may have pushed code."
          : "Status changes, edits and pick-ups on this sprint's issues" +
              (ctx.github.state === "ready" ? ", plus PRs, commits and reviews." : ".") +
              " Work happens off both, so this is a prompt, not a verdict."
      )
    );
  };

  const paintContext = () => {
    context.innerHTML = "";
    context.appendChild(make("h3", "dash-prep-title", "Quick context"));
    const checks = attention(ctx);
    const by = (id) => checks.find((c) => c.id === id);
    const blockedAll = ctx.issues.filter((i) => isBlocked(i, ctx.statusGroups));
    const moved = sinceLastStandup({
      issues: ctx.issues,
      since: ctx.standupSince,
      statusGroups: ctx.statusGroups,
      freeze: ctx.freeze,
    });

    const ul = make("ul", "dash-context-list");
    const line = (label, count, state, open) => {
      const li = make("li");
      const btn = make("button", "dash-check");
      btn.type = "button";
      btn.append(make("span", "dash-check-label", label));
      const n = make("span", "dash-check-count mono", state === "ready" ? String(count) : state === "off" ? "off" : "…");
      n.classList.toggle("has", state === "ready" && count > 0);
      btn.appendChild(n);
      btn.disabled = state !== "ready" || !count;
      btn.addEventListener("click", open);
      li.appendChild(btn);
      ul.appendChild(li);
    };
    line("Blocked issues", blockedAll.length, "ready", () =>
      openList(ctx, {
        title: "Blocked issues",
        subtitle: "",
        rows: blockedAll.map((i) => listRow(i, i.fields?.status?.name || "")),
        kind: "issues",
      })
    );
    const prs = (ctx.github.activity?.pullRequests || []).filter((pr) => pr.state === "waiting-review");
    line("PRs waiting for review", prs.length, ctx.github.activityState === "ready" ? "ready" : ctx.github.activityState, () =>
      openList(ctx, {
        title: "PRs waiting for review",
        subtitle: "Open, not a draft, no decision yet.",
        rows: prs.map((pr) => ({ pr, key: `${pr.repo}#${pr.number}`, summary: pr.title, detail: `open ${pr.ageDays} days` })),
        kind: "prs",
      })
    );
    const deps = by("deps");
    line("Outstanding dependencies", deps.count, deps.state, () =>
      openList(ctx, { title: deps.label, subtitle: "", rows: deps.rows, kind: "issues" })
    );
    context.appendChild(ul);

    if (moved) {
      const keys = new Set([...moved.closed, ...moved.created]);
      const parts = [
        `${moved.closed.length} closed`,
        `${moved.created.length} new in the sprint`,
        moved.historyKnown ? `${moved.moves} status change${moved.moves === 1 ? "" : "s"}` : "no history to count moves",
      ];
      const changes = make("button", "dash-changes");
      changes.type = "button";
      changes.disabled = !keys.size;
      changes.append(make("span", "dash-check-label", "Since then"), make("span", "dash-changes-parts mono", parts.join(" · ")));
      changes.addEventListener("click", () =>
        openList(ctx, {
          title: "Closed or new since the last standup",
          subtitle: "",
          rows: ctx.issues
            .filter((i) => keys.has(i.key))
            .map((i) => listRow(i, moved.closed.includes(i.key) ? "closed" : "new")),
          kind: "issues",
        })
      );
      context.appendChild(changes);
    }
  };

  paintMissing();
  paintContext();
  ctx.onGithub.push(paintMissing);
  ctx.repaint.push(paintContext);
  return section;
}

// ── Individual view ─────────────────────────────────────────────────────────

// One card per person: what they hold now, what is stuck, and what GitHub has
// waiting on them. In name order, like everything per-person on this screen.
function renderPeople(ctx) {
  const section = make("section", "dash-people");
  const model = workload({
    summary: ctx.summary,
    members: ctx.members,
    daysRemaining: ctx.live ? ctx.summary.daysRemaining : 0,
    hoursPerPoint: CONFIG.planner?.hoursPerPoint || 8,
    ended: !ctx.live || ctx.summary.isOverdue,
  });
  if (!model.rows.length) {
    section.appendChild(emptyState("Nobody holds sprint work, and there is no roster to list."));
    return section;
  }
  const grid = make("div", "dash-people-grid");
  const prSlots = [];
  for (const row of model.rows) {
    const el = make("article", "dash-person");
    const top = make("div", "dash-person-top");
    top.appendChild(avatarEl(row.label, avatarSrc(row.key, assigneeFor(ctx, row.key)), "dash-avatar-lg"));
    const names = make("div", "dash-workload-names");
    names.append(make("span", "dash-workload-name", row.label), make("span", "dash-workload-role", row.role));
    top.appendChild(names);
    top.appendChild(loadChip(row));
    el.appendChild(top);

    const held = ctx.issues
      .filter((i) => !isSubtask(i))
      .filter((i) => i.fields?.assignee?.accountId === row.key && i.fields?.status?.statusCategory?.key !== "done")
      .slice(0, 6);
    el.appendChild(
      make(
        "div",
        "dash-person-figs mono",
        `${row.issues} issue${row.issues === 1 ? "" : "s"} · points: ${trimNum(row.donePoints)} done, ${trimNum(row.reviewPoints)} in review, ${trimNum(row.openPoints)} open`
      )
    );
    const ul = make("ul", "dash-person-issues");
    if (!held.length) ul.appendChild(make("li", "dash-note", "Nothing open."));
    for (const issue of held) {
      const li = make("li");
      const key = make("a", "issue-key mono", issue.key);
      attachIssueOpener(key, issue.key, ctx.creds);
      const s = make("span", "dash-person-summary", issue.fields?.summary || "");
      s.title = issue.fields?.summary || "";
      const st = make("span", `dash-person-status mono${isBlocked(issue, ctx.statusGroups) ? " blocked" : ""}`, issue.fields?.status?.name || "");
      li.append(key, s, st);
      ul.appendChild(li);
    }
    el.appendChild(ul);

    const prLine = make("div", "dash-person-prs mono");
    el.appendChild(prLine);
    prSlots.push({ row, prLine });

    const link = make("a", "dash-mini-link", "Open 1:1 sheet →");
    link.href = `#oneone/${encodeURIComponent(row.key)}`;
    el.appendChild(link);
    grid.appendChild(el);
  }
  section.appendChild(grid);

  const paintPrs = () => {
    for (const { row, prLine } of prSlots) {
      const login = row.member?.githubLogin;
      if (ctx.github.activityState === "off") prLine.textContent = "";
      else if (!login) prLine.textContent = "No GitHub login on the roster";
      else if (ctx.github.activityState !== "ready") prLine.textContent = "GitHub: …";
      else {
        const mine = githubActivityFor(ctx.github.activity, login, { now: ctx.now });
        prLine.textContent = `${mine.open.length} open PR${mine.open.length === 1 ? "" : "s"} · ${mine.reviewRequests.length} review request${mine.reviewRequests.length === 1 ? "" : "s"} waiting on them`;
      }
    }
  };
  paintPrs();
  ctx.onGithub.push(paintPrs);
  return section;
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function listRow(issue, detail) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || "",
    assignee: issue.fields?.assignee || null,
    detail,
  };
}

// A filtered list in the drawer: every row opens its issue (or its pull
// request on GitHub), and the whole set opens in Jira's own search with one
// click — so a count on this screen is always one step from the work.
function openList(ctx, { title, subtitle = "", rows = [], kind = "issues" }) {
  const { body } = openDrawerPanel({ label: title, className: "dash-list-drawer" });
  const wrap = make("div", "dash-list");
  wrap.appendChild(make("h2", "dash-list-title", title));
  if (subtitle) wrap.appendChild(make("p", "dash-note", subtitle));
  const ul = make("ul", "dash-list-rows");
  for (const row of rows) {
    const li = make("li", "dash-list-row");
    if (kind === "prs") {
      const a = make("a", "issue-key mono", row.key);
      a.href = row.pr?.url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      const by = row.pr?.author ? `@${row.pr.author} · ` : "";
      li.append(a, make("span", "dash-list-summary", row.summary), make("span", "dash-list-detail mono", by + row.detail));
    } else {
      const a = make("a", "issue-key mono", row.key);
      attachIssueOpener(a, row.key, ctx.creds);
      const who = row.assignee ? displayNameFor(row.assignee) : "Unassigned";
      li.append(a, make("span", "dash-list-summary", row.summary), make("span", "dash-list-detail mono", `${who} · ${row.detail}`));
    }
    ul.appendChild(li);
  }
  if (!rows.length) ul.appendChild(make("li", "dash-note", "Nothing here."));
  wrap.appendChild(ul);

  if (kind === "issues" && rows.length && CONFIG.site.baseUrl) {
    const jql = `key in (${rows.map((r) => r.key).join(",")}) ORDER BY updated DESC`;
    const a = make("a", "btn small dash-list-jira", "Open these in Jira");
    a.href = `${CONFIG.site.baseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
    a.target = "_blank";
    a.rel = "noopener";
    wrap.appendChild(a);
  }
  body.appendChild(wrap);
}

// The assignee record the issues carry for someone, which is where Jira's
// avatar URL comes from when the roster has none of its own.
function assigneeFor(ctx, accountId) {
  return ctx.issues.find((i) => i.fields?.assignee?.accountId === accountId)?.fields?.assignee || null;
}

function avatarSrc(accountId, person) {
  const member = memberFor(accountId);
  if (member?.avatarOverride) return avatarAssetUrl(member.avatarOverride);
  const urls = person?.avatarUrls;
  return (urls && (urls["48x48"] || urls["32x32"] || urls["24x24"])) || member?.avatarUrl || "";
}

function avatarEl(label, src, extra = "") {
  const initials = String(label || "")
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const el = make("span", `dash-avatar mono ${extra}`.trim());
  if (src) {
    const img = make("img");
    img.src = src;
    img.alt = "";
    img.addEventListener("error", () => {
      img.remove();
      el.textContent = initials || "?";
    });
    el.appendChild(img);
  } else {
    el.textContent = initials || "?";
  }
  return el;
}

// Day and time, local, in the app's date format: "02.11.2026 09:30".
function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── The freeze diff ─────────────────────────────────────────────────────────

// What changed underneath the plan, in six buckets, plus the arithmetic that
// ties them back to the sprint total.
//
// The reconciliation line is not decoration. Six buckets of issues invite
// exactly one question — "so what about the rest?" — and a panel that cannot
// answer it reads as a panel that is hiding something. Frozen, minus pulled
// out, plus crept in, is the sprint now; and of what carried through, this many
// changed and this many did not.
//
// `departed` is three-valued on purpose: null while the lookup is in flight,
// then whatever came back. Rendering "deleted" for an issue nobody has looked
// for yet would be a confident wrong answer to the one question this panel
// cannot answer from local state.
function renderFreezeDiff({ freeze, issues, sprints, statusGroups, creds, refreeze, handedOff = [] }) {
  const card = document.createElement("section");
  card.className = "dash-card dash-freeze";
  let departed = null;
  let bodyEl = null;

  const head = document.createElement("div");
  head.className = "dash-card-head";
  const title = document.createElement("h2");
  title.className = "dash-card-title";
  title.textContent = "Since the freeze";
  head.appendChild(title);

  const readout = document.createElement("span");
  readout.className = "dash-readout mono";
  readout.textContent = freeze.atStart
    ? `frozen ${freeze.takenOn}, at the sprint start`
    : `frozen ${freeze.takenOn}, on day ${freeze.dayOfSprint} of the sprint`;
  head.appendChild(readout);

  const button = document.createElement("button");
  button.className = "dash-freeze-btn mono";
  button.type = "button";
  button.textContent = "Freeze now";
  button.title =
    "Replace the frozen state with the sprint as it stands now — for a sprint " +
    "that was re-planned, or one frozen before the planning finished";
  button.addEventListener("click", () => refreeze());
  head.appendChild(button);
  card.appendChild(head);

  paint();
  return { el: card, setDeparted };

  function setDeparted(found) {
    departed = found || [];
    paint();
  }

  function paint() {
    if (bodyEl) bodyEl.remove();
    bodyEl = document.createElement("div");
    bodyEl.className = "dash-freeze-body";

    const diff = diffFreeze({
      freeze,
      issues,
      sprints,
      statusGroups,
      departed: departed || [],
      handedOff,
    });
    const c = diff.counts;

    const sums = document.createElement("p");
    sums.className = "dash-freeze-sums mono";
    sums.textContent =
      `${c.frozen} frozen − ${c.pulledOut} pulled out + ${c.creptIn} crept in ` +
      `= ${c.now} now · ${c.changed} of the ${c.carriedThrough} that carried ` +
      `through changed, ${c.unchanged} did not`;
    bodyEl.appendChild(sums);

    const buckets = [
      creptBucket(diff),
      bucket("Pulled out", diff.pulledOut, {
        points: diff.points.pulledOut,
        row: (r) => issueRow(r.key, r.summary, departureLabel(r), creds),
      }),
      bucket("Re-estimated", diff.reEstimated, {
        points: diff.points.reEstimated,
        signed: true,
        row: (r) =>
          issueRow(r.key, r.summary, `${fmtPoints(r.from)} → ${fmtPoints(r.to)}`, creds),
      }),
      bucket("Due date moved", diff.reDated, {
        row: (r) => issueRow(r.key, r.summary, dateMoveLabel(r), creds),
      }),
      bucket("Re-assigned", diff.reassigned, {
        row: (r) => issueRow(r.key, r.summary, `${r.fromName} → ${r.toName}`, creds),
      }),
      bucket("Went backwards", diff.regressed, {
        row: (r) => issueRow(r.key, r.summary, `${r.from} → ${r.to}`, creds),
      }),
    ].filter(Boolean);

    if (!buckets.length) {
      bodyEl.appendChild(
        emptyState(
          `Nothing has moved since the freeze — all ${c.frozen} issues are as they were.`
        )
      );
    }
    for (const el of buckets) bodyEl.appendChild(el);

    const notes = [diff.scope.note];
    if (departed === null && c.pulledOut) {
      notes.push("Still checking where the issues that left the sprint went.");
    }
    // The blind spot, named rather than left for someone to discover. A freeze
    // compares two points in time, not the path between them.
    notes.push(
      "An issue that left the sprint and came back reads here as unchanged: " +
        "a freeze compares two points in time, not the route between them."
    );
    const note = document.createElement("p");
    note.className = "dash-freeze-note";
    note.textContent = notes.join(" ");
    bodyEl.appendChild(note);

    card.appendChild(bodyEl);
  }
}

// Crept in is one bucket with two halves, because the split is the whole reason
// a freeze beats a creation date: work that did not exist when the sprint
// started is a different fact from work that existed and was pulled in.
function creptBucket(diff) {
  const rows = [...diff.createdAfter, ...diff.draggedIn];
  if (!rows.length) return null;
  const el = bucketShell("Crept in", rows.length, diff.points.creptIn, false);
  for (const [label, list] of [
    ["created after the freeze", diff.createdAfter],
    ["already existed, pulled in later", diff.draggedIn],
  ]) {
    if (!list.length) continue;
    const sub = document.createElement("div");
    sub.className = "dash-freeze-sub mono";
    sub.textContent = `${label} (${list.length})`;
    el.appendChild(sub);
    for (const row of list) {
      el.appendChild(issueRow(row.key, row.summary, fmtPoints(row.points), null));
    }
  }
  return el;
}

function bucket(label, rows, { points = null, signed = false, row } = {}) {
  if (!rows.length) return null;
  const el = bucketShell(label, rows.length, points, signed);
  for (const entry of rows) el.appendChild(row(entry));
  return el;
}

function bucketShell(label, count, points, signed) {
  const el = document.createElement("div");
  el.className = "dash-freeze-bucket";
  const head = document.createElement("div");
  head.className = "dash-freeze-bucket-head mono";
  head.textContent = `${label} (${count})`;
  if (points !== null && points !== 0) {
    const pts = document.createElement("span");
    pts.className = "dash-freeze-points";
    pts.textContent = signed
      ? `${points > 0 ? "+" : "−"}${trimNum(Math.abs(points))} points`
      : `${trimNum(points)} points`;
    head.appendChild(pts);
  }
  el.appendChild(head);
  return el;
}

// `creds` may be null: the crept-in rows are issues the view already holds, and
// wiring an opener needs credentials the sub-renderer is not always given.
function issueRow(key, summary, detail, creds) {
  const row = document.createElement("div");
  row.className = "dash-freeze-row";

  const link = document.createElement(creds ? "a" : "span");
  link.className = "issue-key mono";
  link.textContent = key;
  if (creds) attachIssueOpener(link, key, creds);
  row.appendChild(link);

  const text = document.createElement("span");
  text.className = "dash-freeze-summary";
  text.textContent = summary || "";
  text.title = summary || "";
  row.appendChild(text);

  const value = document.createElement("span");
  value.className = "dash-freeze-detail mono";
  value.textContent = detail;
  row.appendChild(value);
  return row;
}

function departureLabel(row) {
  return row.where === "gone" ? row.whereLabel : `→ ${row.whereLabel}`;
}

function dateMoveLabel(row) {
  if (row.direction === "set") return `set to ${fmtDate(row.to)}`;
  if (row.direction === "cleared") return `cleared, was ${fmtDate(row.from)}`;
  const days = Math.abs(row.days ?? 0);
  const word = row.direction === "later" ? "later" : "earlier";
  return `${fmtDate(row.from)} → ${fmtDate(row.to)} · ${days} day${days === 1 ? "" : "s"} ${word}`;
}

function fmtPoints(value) {
  return value === null || value === undefined ? "—" : trimNum(value);
}

// Per-person delivery table: planned against what has left the assignee's
// hands. Full width and at the foot of the view because it is the read-across
// artefact — eight figures a row, which no chart carries and a reader scans by
// column. The share column gets a meter rather than a second chart: one row is
// one ratio, and the number beside it is the value, so nothing is colour-only.
//
// Returns its repaint so the caller can call it again when the GitHub window
// query lands. Sort state lives in this closure, which is what makes a repaint
// keep whatever ordering the reader chose.
function renderDelivery(summary, github) {
  const card = document.createElement("section");
  card.className = "dash-card";

  const title = document.createElement("h2");
  title.className = "dash-card-title";
  title.textContent = "Delivery by person";
  card.appendChild(title);

  if (!summary.byPerson.length) {
    card.appendChild(emptyState("Nothing assigned in the sprint."));
    return { el: card, repaint: () => {} };
  }

  // With GitHub off the two columns are absent rather than apologetic — the
  // table is exactly what it was before, not a pair of empty columns.
  const githubOn = github.state !== "off";

  const COLUMNS = [
    {
      id: "person",
      label: "Person",
      dir: "asc",                       // names read A–Z; numbers read best-first
      value: (row) => row.label,
      cell: nameCell,
    },
    {
      id: "tickets",
      label: "Tickets",
      hint: "Issues assigned in the sprint, sub-tasks excluded.",
      value: (row) => row.tickets,
      cell: (row) => numCell(row.tickets, trimNum),
    },
    {
      id: "reviewDone",
      label: "In review + done",
      hint: "Tickets in a review column or already done.",
      value: (row) => row.reviewDone,
      cell: (row) => numCell(row.reviewDone, trimNum),
    },
    {
      id: "points",
      label: "Points planned",
      value: (row) => row.points,
      cell: (row) => numCell(row.points, trimNum),
    },
    {
      id: "reviewDonePoints",
      label: "Points in review + done",
      value: (row) => row.reviewDonePoints,
      cell: (row) => numCell(row.reviewDonePoints, trimNum),
    },
    {
      id: "share",
      label: "% in review + done",
      hint:
        "Story points in review or done, over points planned. Unestimated issues" +
        " count as zero, so a person with no estimates shows a dash.",
      value: (row) => row.share,
      cell: shareCell,
    },
    ...(githubOn
      ? [
          {
            id: "prsOpened",
            label: "PRs opened",
            hint: "Pull requests they opened during the sprint window, drafts excluded.",
            value: (row) => row.prsOpened,
            cell: (row) => numCell(row.prsOpened, trimNum),
          },
          {
            id: "lines",
            label: "Lines to main",
            hint:
              "Additions plus deletions that reached the default branch during the" +
              " sprint window: pull requests merged into it, plus commits pushed" +
              " straight to it with no pull request at all.",
            value: (row) => row.lines,
            cell: (row) => numCell(row.lines, compactNum),
          },
        ]
      : []),
  ];

  // The column the table exists for, best first. Everything else is the working
  // shown, so it opens on the answer rather than on a name.
  const sort = { id: "share", dir: "desc" };

  const scroll = document.createElement("div");
  scroll.className = "dash-table-scroll";
  const table = document.createElement("table");
  table.className = "dash-table dash-table-wide";
  scroll.appendChild(table);
  card.appendChild(scroll);

  const note = document.createElement("p");
  note.className = "dash-note";
  card.appendChild(note);

  paint();
  return { el: card, repaint: paint };

  function paint() {
    const rows = summary.byPerson.map((person) =>
      rowFor(person.label, person, {
        onTeam: person.onTeam,
        stats: statsForPerson(person.key),
      })
    );
    rows.sort(compareRows);

    // Totals over the rows above, so the line always adds up to what is on
    // screen. The GitHub halves are summed rather than re-derived: a pull
    // request has one author, so no row double-counts another's.
    const totals = rowFor("All", summary.totals, {
      stats: sumStats(rows),
    });

    table.innerHTML = "";
    table.appendChild(renderHead());
    const tbody = document.createElement("tbody");
    for (const row of rows) tbody.appendChild(renderRow(row));
    table.appendChild(tbody);
    const tfoot = document.createElement("tfoot");
    tfoot.appendChild(renderRow(totals));
    table.appendChild(tfoot);

    note.textContent = noteText();
  }

  function renderHead() {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    COLUMNS.forEach((column, i) => {
      const th = document.createElement("th");
      if (i > 0) th.className = "dash-num";
      th.classList.add("sortable");
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.setAttribute(
        "aria-sort",
        sort.id === column.id ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      );

      const label = document.createElement("span");
      label.textContent = column.label;
      th.appendChild(label);

      // Caret beside the label, help mark last: the sort state belongs to the
      // heading, the "?" is an affordance sitting after it.
      if (sort.id === column.id) {
        const caret = icon("chevron", 11);
        caret.classList.add("dash-sort");
        if (sort.dir === "asc") caret.classList.add("icon-rot-180");
        th.appendChild(caret);
      }
      if (column.hint) {
        const mark = document.createElement("span");
        mark.className = "dash-hint-mark";
        mark.textContent = "?";
        mark.title = column.hint;
        th.appendChild(mark);
      }

      const toggle = () => {
        // Re-clicking a column flips it; a new column opens the way that column
        // reads first — names ascending, figures largest first.
        if (sort.id === column.id) sort.dir = sort.dir === "asc" ? "desc" : "asc";
        else Object.assign(sort, { id: column.id, dir: column.dir || "desc" });
        paint();
      };
      th.addEventListener("click", toggle);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    return thead;
  }

  function renderRow(row) {
    const tr = document.createElement("tr");
    for (const column of COLUMNS) tr.appendChild(column.cell(row));
    return tr;
  }

  function compareRows(a, b) {
    const column = COLUMNS.find((c) => c.id === sort.id) || COLUMNS[0];
    const av = column.value(a);
    const bv = column.value(b);
    let cmp;
    // Absent sorts last whichever way the column points: a dash is not a small
    // number, and burying the people GitHub cannot answer for at the top of a
    // descending sort would read as zero output.
    if (av === null && bv === null) cmp = 0;
    else if (av === null) return 1;
    else if (bv === null) return -1;
    else cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    if (sort.dir === "desc") cmp = -cmp;
    // Ties settle by name, so a repaint never reshuffles equal rows.
    return cmp || a.label.localeCompare(b.label);
  }

  // Per-person GitHub numbers, or null when GitHub cannot answer for them at
  // all: query still in flight or failed, nobody on the roster for that Jira
  // account, or no login on their roster entry. A missing number and a zero are
  // different facts, so this never stands in a nought for one.
  function statsForPerson(accountId) {
    if (!github.stats) return null;
    const login = memberFor(accountId)?.githubLogin;
    if (!login) return null;
    return statsFor(github.stats, login, { since: github.since });
  }

  function sumStats(rows) {
    const counted = rows.filter((row) => row.prsOpened !== null);
    if (!counted.length) return null;
    return {
      prsOpened: counted.reduce((n, row) => n + row.prsOpened, 0),
      lines: counted.reduce((n, row) => n + row.lines, 0),
    };
  }

  function rowFor(label, bucket, { onTeam = null, stats = null } = {}) {
    const progress = reviewOrDone(bucket);
    return {
      label,
      onTeam,
      tickets: bucket.issues,
      reviewDone: progress.issues,
      points: bucket.points,
      reviewDonePoints: progress.points,
      share: progress.share,
      prsOpened: stats ? stats.prsOpened : null,
      lines: stats ? stats.lines : null,
      clamped: Boolean(stats?.clamped),
      from: stats?.from || "",
    };
  }

  function numCell(value, format) {
    const td = document.createElement("td");
    td.className = "dash-num mono";
    td.textContent =
      value === null ? (github.state === "loading" ? "…" : "—") : format(value);
    return td;
  }

  function nameCell(row) {
    const td = document.createElement("td");
    td.className = "dash-person-name";
    td.textContent = row.label;
    if (row.onTeam === false) {
      const outside = document.createElement("span");
      outside.className = "dash-outside";
      outside.textContent = "outside team";
      td.appendChild(outside);
    }
    return td;
  }

  // The meter lives in an inner span rather than on the cell itself: a `td` set
  // to `display: flex` stops drawing the row rule underneath it, which reads as
  // a broken table.
  function shareCell(row) {
    const td = document.createElement("td");
    td.className = "dash-num dash-share-cell";
    const inner = document.createElement("span");
    inner.className = "dash-share";
    td.appendChild(inner);

    if (row.share === null) {
      // An empty track would read as 0%; nothing estimated is not zero progress.
      const dash = document.createElement("span");
      dash.className = "dash-meter-value mono";
      dash.textContent = "—";
      inner.appendChild(dash);
      return td;
    }
    const meter = document.createElement("span");
    meter.className = "dash-meter";
    const fill = document.createElement("span");
    fill.className = "dash-meter-fill";
    fill.style.width = `${Math.min(100, Math.round(row.share * 100))}%`;
    meter.appendChild(fill);
    const value = document.createElement("span");
    value.className = "dash-meter-value mono";
    value.textContent = `${Math.round(row.share * 100)}%`;
    inner.append(meter, value);
    return td;
  }

  function noteText() {
    const parts = [
      "A ticket counts as in review when its status group reads as a review" +
        " state — set the grouping in Settings to track a dedicated code review" +
        " column.",
      `Sub-tasks are excluded${summary.unestimated ? `, and ${summary.unestimated} issue${summary.unestimated === 1 ? " is" : "s are"} unestimated` : ""}.`,
    ];
    if (githubOn) parts.push(githubNote());
    return parts.join(" ");
  }

  function githubNote() {
    if (github.state === "loading") return "Pull request figures still loading.";
    if (github.state === "error") {
      return `PRs and lines to main unavailable — ${github.error}.`;
    }
    // Every row shares one window, so the first that has one speaks for all.
    const sample = summary.byPerson.map((p) => statsForPerson(p.key)).find(Boolean);
    if (!sample) {
      return (
        "No PR figures: nobody in the sprint has a GitHub login on the roster." +
        " Map logins in Settings → Team."
      );
    }
    const window = sample.clamped
      ? `from ${fmtDate(sample.from)}, which is as far back as GitHub was queried — this sprint started before that`
      : github.dated
        ? `from ${fmtDate(sample.from)}`
        : `over the last ${FALLBACK_SPRINT_DAYS} days, there being no start date on the active sprint`;
    return (
      `PRs opened and lines to main are counted ${window}, and only for people` +
      " with a GitHub login on the roster."
    );
  }
}

// Points are often halves; integers shouldn't show a trailing ".0".
function trimNum(n) {
  const value = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
