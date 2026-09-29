// Quarterly overview page — the printable quarter document, opened from the
// Sprint Dashboard's recap menu. The model is `js/quarter.js`; this file fetches
// and draws.
//
// Built on the recap's route and every lesson it paid for: a page of its own,
// `css/app.css` not loaded, the running header in a `thead`, the print button
// gated on the document existing, and each source's failure printed rather than
// degraded to a confident zero.
//
//   ?q=current    the quarter running now, to date (default)
//   ?q=previous   the last full quarter
//   ?q=2026-Q2    that quarter
//   ?boards=12,14 only those boards' projects (from the recap config screen).
//                 Jira only: GitHub is per repository, not per board.
//   ?print=1      open the print dialog once the document is ready
//
// Unlike the recap it does not open the print dialog by itself: the quarter is
// picked on this page, and a dialog over the picker would be in the way.
//
// The GitHub half is a dedicated fetch over the whole quarter rather than the
// shared 45-day window, which is why it is slow on first load and cached after.

import { getEpicsInProgress, getQuarterIssues } from "./api.js";
import { getCredentials } from "./credentials.js";
import { CONFIG, isConfigured } from "./config.js";
import { activeMembers, displayNameFor, hasRoster, loadTeam, memberLabel } from "./team.js";
import { BOARDS, compactNum, fmtDate, loadBoards, loadStatusGroups } from "./utils.js";
import { parseBoardList } from "./recap-selection.js";
import { getQuarterStats, isGithubConfigured } from "./github.js";
import {
  buildQuarter,
  JIRA_WEIGHTS,
  MIN_CHART_DAYS,
  quarterNamed,
  quarterOf,
  rankPeople,
  RANK_WEIGHTS,
  resolveQuarter,
} from "./quarter.js";
import { weeklyLines } from "./charts.js";

const JIRA_TIMEOUT_MS = 120000;
const GITHUB_TIMEOUT_MS = 300000;
const QUARTERS_OFFERED = 4;

const params = new URLSearchParams(location.search);
const now = new Date();
const quarter = resolveQuarter(params.get("q") || "current", now);

const root = document.getElementById("recap-root");
const printBtn = document.getElementById("recap-print");
const toolbarNote = document.getElementById("recap-toolbar-note");
const picker = document.getElementById("quarter-select");

let ready = false;
// The boards a filtered overview covers, for the title; null when unfiltered.
let scopedBoards = null;

function showStatus(text, { failed = false } = {}) {
  root.innerHTML = "";
  const p = document.createElement("p");
  p.className = failed ? "recap-note recap-status-failed" : "recap-note";
  p.textContent = text;
  root.appendChild(p);
  if (toolbarNote) toolbarNote.textContent = failed ? "Nothing to print." : text;
}

function markReady() {
  ready = true;
  if (!printBtn) return;
  printBtn.disabled = false;
  printBtn.textContent = "Print / Save as PDF";
  if (toolbarNote) {
    toolbarNote.textContent = "Pick Save as PDF as the destination. This bar is not printed.";
  }
}

function fail(message) {
  ready = false;
  if (printBtn) {
    printBtn.disabled = true;
    printBtn.textContent = "Nothing to print";
  }
  document.title = "Quarterly overview — could not be built";
  showStatus(message, { failed: true });
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s — reload this page to try again`)),
        ms
      )
    ),
  ]);
}

// This quarter and the few before it. Choosing one reloads the page on it, so
// the URL is always the document.
function fillPicker() {
  if (!picker) return;
  let q = quarterOf(now);
  for (let i = 0; i < QUARTERS_OFFERED; i++) {
    const option = document.createElement("option");
    option.value = q.key;
    option.textContent = i === 0 ? `${q.label} (to date)` : q.label;
    if (q.key === quarter.key) option.selected = true;
    picker.appendChild(option);
    q = q.q === 1 ? quarterNamed(q.year - 1, 4) : quarterNamed(q.year, q.q - 1);
  }
  // An explicit older quarter from the URL is still offered, not silently swapped.
  if (![...picker.options].some((o) => o.value === quarter.key)) {
    const option = document.createElement("option");
    option.value = quarter.key;
    option.textContent = quarter.label;
    option.selected = true;
    picker.appendChild(option);
  }
  picker.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("q", picker.value);
    location.href = url.toString();
  });
}

async function init() {
  fillPicker();
  document.title = `Quarterly overview — ${quarter.label}`;
  if (quarter.future) {
    fail(`${quarter.label} has not started yet, so there is nothing to count.`);
    return;
  }
  showStatus(`Building the overview — reading ${quarter.label} from Jira. A quarter of history takes a moment…`);

  await loadBoards();
  await loadTeam();
  const creds = await getCredentials();
  if (!creds || !isConfigured()) {
    fail("Not configured yet — open the app and connect to Jira first.");
    return;
  }

  // No upper bound on a running quarter, so the cache key is stable across
  // reloads rather than changing with the clock.
  // The board filter. Unknown ids are dropped; a filter that leaves nothing, or
  // leaves boards with no project key, refuses rather than silently widening to
  // every board (or, with no key at all, to the whole site).
  const wantedBoards = parseBoardList(params.get("boards"));
  const boards = wantedBoards.length ? BOARDS.filter((b) => wantedBoards.includes(String(b.id))) : BOARDS;
  if (wantedBoards.length && !boards.some((b) => b.projectKey)) {
    fail(
      boards.length
        ? "The chosen boards have no project key yet, so their issues cannot be searched. Open the Kanban once to let the app tag them, then try again."
        : "None of the chosen boards is configured any more. Pick again under Launch → Recap config."
    );
    return;
  }
  scopedBoards = wantedBoards.length ? boards : null;

  const since = quarter.start.toISOString();
  const until = quarter.running ? "" : quarter.end.toISOString();

  // GitHub starts now, alongside Jira: it is the slow half.
  const githubWanted = isGithubConfigured();
  const githubPromise = githubWanted
    ? withTimeout(getQuarterStats({ since, until, now }), GITHUB_TIMEOUT_MS, "GitHub")
    : null;
  githubPromise?.catch(() => {});

  const [issues, epicsInProgress, statusGroups] = await withTimeout(
    Promise.all([
      getQuarterIssues(creds, { since, until, boards }),
      getEpicsInProgress(creds, boards).catch(() => null),
      loadStatusGroups(),
    ]),
    JIRA_TIMEOUT_MS,
    "Jira"
  );

  // Names for people who are not on the roster, from the person records the
  // issues carry. Only used when there is no roster at all.
  const names = new Map();
  for (const issue of issues) {
    for (const person of [issue.fields?.assignee, issue.fields?.creator, issue.fields?.reporter]) {
      if (person?.accountId && !names.has(person.accountId)) names.set(person.accountId, displayNameFor(person));
    }
  }
  const members = hasRoster()
    ? activeMembers().map((m) => ({ accountId: m.accountId, label: memberLabel(m), githubLogin: m.githubLogin || "" }))
    : [];

  const build = (stats) =>
    buildQuarter({
      quarter, issues, epicsInProgress: epicsInProgress || [], stats, members, statusGroups,
      labelFor: (id) => names.get(id) || "", now,
    });

  const extras = { epicsFailed: epicsInProgress === null };
  render(build(null), { ...extras, statsPending: githubWanted, statsError: "" });
  if (!githubWanted) {
    markReady();
  } else if (toolbarNote) {
    toolbarNote.textContent =
      "Reading a quarter of pull requests and commits from GitHub — printing unlocks when they land.";
  }

  if (githubWanted) {
    let stats = null;
    let statsError = "";
    try {
      stats = await githubPromise;
    } catch (err) {
      statsError = String(err?.message || err);
    }
    render(build(stats), { ...extras, statsPending: false, statsError });
    markReady();
  }

  if (params.get("print") === "1") window.print();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const PENDING = "…";
const absent = (pending) => (pending ? PENDING : "—");
const one = (n) => (n === null || n === undefined ? "—" : String(Math.round(n * 10) / 10));

function render(model, opts) {
  root.innerHTML = "";
  const layout = el("table", "recap-layout");

  const thead = el("thead");
  const headRow = el("tr");
  const headCell = el("td");
  headCell.appendChild(renderHeader());
  headRow.appendChild(headCell);
  thead.appendChild(headRow);
  layout.appendChild(thead);

  const body = el("div", "recap-body");
  body.appendChild(renderTitle(model));
  body.appendChild(renderTeamCharts(model, opts));
  body.appendChild(renderSummary(model, opts));
  body.appendChild(renderMultiples(model, opts));
  body.appendChild(renderPeopleTable(model, opts));
  body.appendChild(renderEpicsClosed(model));
  body.appendChild(renderEpicsInProgress(model, opts));
  body.appendChild(renderNotes(model, opts));
  body.appendChild(renderFooter(model));

  const tbody = el("tbody");
  const bodyRow = el("tr");
  const bodyCell = el("td");
  bodyCell.appendChild(body);
  bodyRow.appendChild(bodyCell);
  tbody.appendChild(bodyRow);
  layout.appendChild(tbody);

  // The spacer that keeps each page's last line off the bottom edge — see the
  // recap page, which learned it.
  const tfoot = el("tfoot");
  const footRow = el("tr");
  footRow.appendChild(el("td"));
  tfoot.appendChild(footRow);
  layout.appendChild(tfoot);

  root.appendChild(layout);
}

const DARK_LOGO = "org-logo-dark.png";
function darkLogoFor(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? DARK_LOGO : `${path.slice(0, slash + 1)}${DARK_LOGO}`;
}

function renderHeader() {
  const header = el("header", "recap-header");
  const left = el("div", "recap-header-left");
  if (CONFIG.brand.orgLogo) {
    const logo = el("img", "recap-logo");
    logo.src = darkLogoFor(CONFIG.brand.orgLogo);
    logo.alt = CONFIG.brand.orgName || CONFIG.brand.productName;
    logo.addEventListener("error", () => { logo.src = CONFIG.brand.orgLogo; }, { once: true });
    left.appendChild(logo);
  } else {
    left.appendChild(el("span", "recap-logo-text", CONFIG.brand.orgName || CONFIG.brand.productName));
  }
  header.appendChild(left);
  header.appendChild(el("div", "recap-team", "Quarterly Overview"));
  return header;
}

function renderTitle(model) {
  const q = model.quarter;
  const wrap = el("div");
  wrap.appendChild(el("h1", "recap-title", `Quarterly Overview ${q.label}`));
  const last = new Date(q.until.getTime() - 1);
  const bits = [
    `${fmtDate(q.start.toISOString())} - ${fmtDate(last.toISOString())}`,
    `${model.weeks.length} ${model.weeks.length === 1 ? "week" : "weeks"}`,
  ];
  if (q.running) bits.push(`quarter to date — runs to ${fmtDate(new Date(q.end.getTime() - 1).toISOString())}`);
  wrap.appendChild(el("p", "recap-subtitle", bits.join("  ·  ")));
  if (scopedBoards) {
    wrap.appendChild(
      el(
        "p",
        "recap-asat",
        `Boards: ${scopedBoards.map((b) => b.name).join(", ")}. Jira figures cover these boards' projects only;` +
          " GitHub figures cover every configured repository."
      )
    );
  }
  return wrap;
}

function chartLegend(items) {
  const wrap = el("div", "chart-legend");
  for (const item of items) {
    const entry = el("span", "chart-legend-item");
    const swatch = el("span", `chart-swatch${item.dashed ? " dashed" : ""}`);
    if (item.dashed) swatch.style.borderColor = item.fill;
    else swatch.style.background = item.fill;
    entry.appendChild(swatch);
    entry.appendChild(el("span", null, item.label));
    wrap.appendChild(entry);
  }
  return wrap;
}

const JIRA_SERIES = { name: "Jira activity", stroke: "var(--series-jira)" };
const GITHUB_SERIES = { name: "Commits to main", stroke: "var(--series-github)", dashed: true };

function formulaText() {
  const w = JIRA_WEIGHTS;
  const term = (k, label) => (w[k] === 1 ? label : `${w[k]} × ${label}`);
  return [
    term("comments", "comments"),
    term("closed", "tickets closed"),
    term("opened", "tickets opened"),
    term("epicsClosed", "epics closed"),
  ].join(" + ");
}

function chartBlock(titleText, sub, svg) {
  const block = el("div", "quarter-chart");
  block.appendChild(el("div", "quarter-chart-title", titleText));
  if (sub) block.appendChild(el("p", "quarter-chart-sub", sub));
  block.appendChild(svg);
  return block;
}

function renderTeamCharts(model, { statsPending, statsError }) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "Team velocity, week by week"));
  const { labels, partial, pick } = chartWeeks(model);

  section.appendChild(
    chartBlock(
      "Jira activity",
      `Weekly score: ${formulaText()}.`,
      weeklyLines({ labels, partial, series: [{ ...JIRA_SERIES, values: pick(model.weeks.map((w) => w.jira)) }] })
    )
  );

  const gh = model.team.github;
  section.appendChild(
    gh
      ? chartBlock(
          "GitHub commits to main",
          "Every commit in the default branch's history, pushed directly or merged in through a pull request.",
          weeklyLines({ labels, partial, series: [{ ...GITHUB_SERIES, dashed: false, values: pick(model.weeks.map((w) => w.github)) }] })
        )
      : chartBlock(
          "GitHub commits to main",
          statsPending
            ? "Still reading GitHub…"
            : statsError
              ? `GitHub figures unavailable — ${statsError}.`
              : "GitHub sync is off, so there is no commit series.",
          el("div")
        )
  );
  section.appendChild(el("p", "recap-note", chartWeeksNote(model)));
  return section;
}

// The weeks drawn on every chart: those with at least MIN_CHART_DAYS whole days
// inside the quarter so far. `pick` narrows any per-week series to the same.
function chartWeeks(model) {
  const keep = model.weeks.map((w, i) => (w.charted ? i : -1)).filter((i) => i >= 0);
  return {
    labels: keep.map((i) => model.weeks[i].key),
    partial: keep.map((i) => model.weeks[i].partial),
    pick: (values) => keep.map((i) => values[i]),
  };
}

function chartWeeksNote(model) {
  const left = model.weeks.filter((w) => !w.charted).map((w) => w.key);
  const parts = ["Hollow markers are part weeks, clipped by the start or end of the quarter."];
  if (left.length) {
    parts.push(
      `${left.join(" and ")} ${left.length === 1 ? "has" : "have"} fewer than ${MIN_CHART_DAYS} full days in the quarter` +
        `${model.quarter.running ? " so far" : ""}, so ${left.length === 1 ? "it is" : "they are"} left off the charts —` +
        " but counted in every figure."
    );
  }
  return parts.join(" ");
}

function renderSummary(model, { statsPending }) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "The quarter in figures"));
  const t = model.team;
  const gh = t.github;
  const ghv = (fn) => (gh ? fn(gh) : absent(statsPending));

  // Two short tables side by side rather than one long one: the whole summary
  // has to fit under the two team charts on the first page.
  const groups = [
    [
      "Jira",
      [
        ["Tickets opened", String(t.opened)],
        ["Tickets closed", String(t.closed)],
        ["Comments posted", String(t.comments)],
        // Every epic in the list below, so the two cannot disagree. The score
        // counts only the ones credited to someone on the team.
        ["Epics closed", String(model.epicsClosed.length)],
        ["Epics in progress now", String(model.epicsInProgress.length)],
        ["Activity score, quarter", String(t.jiraScore)],
        ["Activity score, per full week", one(t.jiraPerWeek)],
      ],
    ],
    [
      "GitHub",
      [
        ["Commits to main", ghv((g) => String(g.commits))],
        ["Commits to main, per full week", ghv((g) => one(g.commitsPerWeek))],
        ["Pull requests opened", ghv((g) => String(g.prsOpened))],
        ["Pull request reviews submitted", ghv((g) => String(g.reviews))],
        ["Lines added to main", ghv((g) => `+${compactNum(g.additions)}`)],
        ["Lines removed from main", ghv((g) => `\u2212${compactNum(g.deletions)}`)],
      ],
    ],
  ];

  const grid = el("div", "quarter-summary");
  for (const [name, rows] of groups) {
    const table = el("table", "recap-table quarter-summary-table");
    const thead = el("thead");
    const head = el("tr");
    const th = el("th", null, name);
    th.colSpan = 2;
    head.appendChild(th);
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const [label, value] of rows) {
      const tr = el("tr");
      tr.appendChild(el("td", null, label));
      tr.appendChild(el("td", "recap-num mono", value));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    grid.appendChild(table);
  }
  section.appendChild(grid);
  return section;
}

function renderMultiples(model, { statsPending }) {
  const section = el("section", "recap-section recap-section-break");
  section.appendChild(el("h2", "recap-section-title", "Per person, week by week"));
  if (!model.people.length) {
    section.appendChild(el("p", "recap-note", "Nobody to show — add people under Settings → Team."));
    return section;
  }
  section.appendChild(
    chartLegend([
      { label: "Jira activity score", fill: "var(--series-jira)" },
      { label: "Commits to main", fill: "var(--series-github)", dashed: true },
    ])
  );

  // Each panel has its own scale, labelled at every step, so a quiet quarter is
  // still readable rather than a flat line at the foot of a busy colleague's axis.
  const { labels, partial, pick } = chartWeeks(model);

  const grid = el("div", "quarter-multiples");
  for (const person of model.people) {
    const card = el("div", "quarter-multiple");
    const name = el("div", "quarter-multiple-name");
    name.appendChild(el("span", null, person.label));
    name.appendChild(
      el(
        "span",
        "quarter-multiple-figures",
        `${person.jira.score} · ${person.github ? person.github.commits : person.githubLogin ? absent(statsPending) : "no login"}`
      )
    );
    card.appendChild(name);
    const series = [{ ...JIRA_SERIES, values: pick(person.weekly.map((w) => w.jira)) }];
    if (person.github || person.weekly.some((w) => w.commits !== null)) {
      series.push({ ...GITHUB_SERIES, values: pick(person.weekly.map((w) => w.commits)) });
    }
    card.appendChild(weeklyLines({ labels, partial, series }, { width: 330, height: 130, compact: true }));
    grid.appendChild(card);
  }
  section.appendChild(grid);
  section.appendChild(
    el(
      "p",
      "recap-note",
      "Ordered by name. Each panel has its own scale — compare shapes across panels, not heights." +
        " The figures beside each name are the quarter's Jira activity score and commits to main."
    )
  );
  return section;
}

function renderPeopleTable(model, { statsPending }) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "Per person, whole quarter"));
  if (!model.people.length) {
    section.appendChild(el("p", "recap-note", "Nobody to show."));
    return section;
  }

  const table = el("table", "recap-table");
  const thead = el("thead");
  const groups = el("tr", "quarter-group-head");
  const lead = el("th");
  lead.colSpan = 2;
  groups.appendChild(lead);
  const jiraHead = el("th", null, "Jira");
  jiraHead.colSpan = 3;
  const ghHead = el("th", null, "GitHub");
  ghHead.colSpan = 4;
  groups.append(jiraHead, ghHead);
  thead.appendChild(groups);

  const headRow = el("tr");
  for (const [label, cls] of [
    ["#", "recap-num"],
    ["Person", ""],
    ["Tickets opened", "recap-num"],
    ["Tickets closed", "recap-num"],
    ["Comments", "recap-num"],
    ["PRs opened", "recap-num"],
    ["Commits to main", "recap-num"],
    ["PR reviews", "recap-num"],
    ["Lines to main", "recap-num"],
  ]) {
    headRow.appendChild(el("th", cls, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const ghCell = (person, fn) =>
    person.github ? fn(person.github) : person.githubLogin ? absent(statsPending) : "—";
  const tbody = el("tbody");
  rankPeople(model.people).forEach((person, i) => {
    const tr = el("tr");
    tr.appendChild(el("td", "recap-num mono", String(i + 1)));
    tr.appendChild(el("td", null, person.label));
    for (const value of [
      String(person.jira.opened),
      String(person.jira.closed),
      String(person.jira.comments),
      ghCell(person, (g) => String(g.prsOpened)),
      ghCell(person, (g) => String(g.commits)),
      ghCell(person, (g) => String(g.reviews)),
      ghCell(person, (g) => compactNum(g.lines)),
    ]) {
      tr.appendChild(el("td", "recap-num mono", value));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const t = model.team;
  const gh = t.github;
  const tfoot = el("tfoot");
  const totalRow = el("tr", "quarter-total");
  const totalLabel = el("td", null, "Team total");
  totalLabel.colSpan = 2;
  totalRow.appendChild(totalLabel);
  for (const value of [
    String(t.opened),
    String(t.closed),
    String(t.comments),
    gh ? String(gh.prsOpened) : absent(statsPending),
    gh ? String(gh.commits) : absent(statsPending),
    gh ? String(gh.reviews) : absent(statsPending),
    gh ? compactNum(gh.lines) : absent(statsPending),
  ]) {
    totalRow.appendChild(el("td", "recap-num mono", value));
  }
  tfoot.appendChild(totalRow);
  table.appendChild(tfoot);
  section.appendChild(table);

  section.appendChild(
    el(
      "p",
      "recap-note",
      rankingNote() +
        " Tickets closed are credited to whoever the ticket was assigned to when it" +
        " closed; epics are counted separately, below, and sub-tasks count for comments only." +
        " Lines to main are lines added plus removed in merged pull requests and direct pushes;" +
        " commits to main count every commit in the default branch's history." +
        " PR reviews count reviews submitted on other people's pull requests."
    )
  );
  return section;
}

function rankingNote() {
  const w = RANK_WEIGHTS;
  const term = (k, label) => (w[k] === 1 ? label : `${w[k]} × ${label}`);
  return (
    "Ordered by a combined ranking: each person is ranked on Jira activity score, commits to main" +
    " and lines to main, and the ranks are summed" +
    (w.jira === w.commits && w.commits === w.lines
      ? ", equally weighted"
      : ` (${term("jira", "Jira rank")} + ${term("commits", "commits rank")} + ${term("lines", "lines rank")})`) +
    " — lowest total first, ties by name."
  );
}

function epicTable(rows, columns) {
  const table = el("table", "recap-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [label] of columns) headRow.appendChild(el("th", null, label));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    columns.forEach(([, get, cls], i) => tr.appendChild(el("td", cls || (i === 0 ? "recap-key" : null), get(row))));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderEpicsClosed(model) {
  const section = el("section", "recap-section recap-section-break");
  section.appendChild(el("h2", "recap-section-title", `Epics closed (${model.epicsClosed.length})`));
  if (!model.epicsClosed.length) {
    section.appendChild(el("p", "recap-note", `No epic closed in ${model.quarter.label}.`));
    return section;
  }
  section.appendChild(
    epicTable(model.epicsClosed, [
      ["Key", (e) => e.key],
      ["Summary", (e) => e.summary],
      ["Closed", (e) => fmtDate(e.closedAt), "mono"],
      ["Assignee", (e) => e.assignee || "—"],
      ["Board", (e) => e.board || "—"],
    ])
  );
  return section;
}

function renderEpicsInProgress(model, { epicsFailed }) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", `Epics in progress (${model.epicsInProgress.length})`));
  if (epicsFailed) {
    section.appendChild(el("p", "recap-note", "Jira did not answer for epics in progress, so this list is missing rather than empty."));
    return section;
  }
  if (!model.epicsInProgress.length) {
    section.appendChild(el("p", "recap-note", "No epic is in progress on the configured boards."));
    return section;
  }
  section.appendChild(
    epicTable(model.epicsInProgress, [
      ["Key", (e) => e.key],
      ["Summary", (e) => e.summary],
      ["Status", (e) => e.status || "—"],
      ["Assignee", (e) => e.assignee || "—"],
      ["Board", (e) => e.board || "—"],
    ])
  );
  section.appendChild(
    el(
      "p",
      "recap-note",
      model.quarter.running
        ? "As they stand today."
        : `As they stand today, not as they stood at the end of ${model.quarter.label} — Jira keeps no record of an epic's past state that this list could read.`
    )
  );
  return section;
}

// Where every figure above is a floor, a subset or missing, said once.
function renderNotes(model, { statsPending, statsError }) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "How to read this"));
  const n = model.notes;
  const parts = [];
  parts.push(
    model.rosterMode
      ? "Team figures are the sum of the people on the roster's active team; activity by anyone else is left out."
      : "No roster is set up, so everyone who appears in the Jira data is a row. Add a team under Settings → Team to scope this."
  );
  const out = n.outside;
  const outBits = [
    out.comments && `${out.comments} comments`,
    out.opened && `${out.opened} tickets opened`,
    out.closed && `${out.closed} tickets closed`,
    out.epicsClosed && `${out.epicsClosed} epics closed`,
    out.commits && `${out.commits} commits`,
  ].filter(Boolean);
  if (model.rosterMode && outBits.length) parts.push(`Left out as outside the team: ${outBits.join(", ")}.`);
  if (n.unassignedClosures) {
    parts.push(`${n.unassignedClosures} closed ${n.unassignedClosures === 1 ? "ticket was" : "tickets were"} unassigned when closed and are credited to nobody.`);
  }
  if (!n.hasHistory) {
    parts.push("This site returned no issue history, so closes are read from resolution dates and credited to the current assignee.");
  } else if (n.historyTruncated.length) {
    parts.push(
      `${n.historyTruncated.length} ${n.historyTruncated.length === 1 ? "issue has" : "issues have"} more history than Jira returns in one read; where a close fell in the missing part it is read from the resolution date instead.`
    );
  }
  if (n.commentsTruncated.length) {
    parts.push(`Comments on ${n.commentsTruncated.length} ${n.commentsTruncated.length === 1 ? "issue" : "issues"} could not be read in full, so the comment count is a floor.`);
  }

  if (statsPending) {
    parts.push("GitHub figures are still being read and fill in on this page — the print button unlocks when they land.");
  } else if (!n.github) {
    parts.push(statsError ? `GitHub figures unavailable — ${statsError}.` : "GitHub sync is off, so the GitHub figures are absent rather than zero.");
  } else {
    if (n.github.failures.length) {
      parts.push(`Incomplete for ${n.github.failures.map((f) => `${f.repo} (${f.message})`).join("; ")} — the GitHub figures undercount by whatever those hold.`);
    }
    if (n.github.truncated.length) {
      parts.push(`${n.github.truncated.join(", ")} had more history than the query reads in one go, so the earliest part of the quarter is undercounted there.`);
    }
    if (n.github.unattributedCommits) {
      parts.push(`${n.github.unattributedCommits} ${n.github.unattributedCommits === 1 ? "commit has" : "commits have"} an author email linked to no GitHub account and cannot be credited to anyone.`);
    }
    if (n.unmapped) {
      parts.push(`${n.unmapped} ${n.unmapped === 1 ? "person has" : "people have"} no GitHub login on the roster, so their GitHub figures are dashes rather than zeroes.`);
    }
    parts.push("Draft pull requests are not counted; each pull request contributes at most its latest 30 reviews.");
  }
  section.appendChild(el("p", "recap-note", parts.join(" ")));
  return section;
}

function renderFooter(model) {
  const footer = el("footer", "recap-footer");
  footer.appendChild(
    el("span", null, `Generated ${fmtDate(model.generatedAt)} by ${CONFIG.brand.productName} from Jira and GitHub data.`)
  );
  footer.appendChild(
    el("span", null, "A record of what the quarter did, not an assessment of anyone in it. Activity counts are not a measure of performance.")
  );
  return footer;
}

printBtn?.addEventListener("click", () => {
  if (ready) window.print();
});

init().catch((err) => fail(`Could not build the overview — ${err?.message || err}`));
