// Sprint recap page — the printable end-of-sprint document, opened from the
// Sprint Dashboard's "Generate recap" button.
//
// A page of its own rather than an overlay on the dashboard, for the same reason
// issue.html is a page: print rules and an app shell fight each other, and this
// way the document is reloadable, linkable and inspectable on its own.
//
// It recomputes from the same cached calls the dashboard uses rather than being
// handed a payload. Nothing is re-fetched in practice — `getAllSprintIssues`,
// `getActiveSprint` and `getTeamStats` are all cached and de-duplicated — and it
// means the recap cannot be generated from a stale snapshot of a screen someone
// left open yesterday.
//
// The GitHub window *is* awaited here, unlike on the dashboard: a document is
// generated once and kept, so it is worth a second of waiting to have the pull
// request numbers in it rather than a row of dashes.

import { getActiveSprint, getAllSprintIssues } from "./api.js";
import { getCredentials } from "./credentials.js";
import { CONFIG, isConfigured } from "./config.js";
import { loadTeam } from "./team.js";
import { BOARDS, compactNum, fmtDate, loadBoards, loadStatusGroups } from "./utils.js";
import { summarize } from "./dashboard.js";
import { buildRecap } from "./recap.js";
import { FALLBACK_SPRINT_DAYS, getTeamStats, isGithubConfigured } from "./github.js";

// How long each source gets before the document gives up on it. Generous on
// purpose: this is a document, generated once and kept, and the GitHub window
// pages through 45 days of pull requests *and* 45 days of default-branch commits
// per repo — six plus four sequential requests each, and the commit query is the
// expensive one. The first version allowed 30s for that and routinely timed out
// while the dashboard, which sets no deadline at all, filled in a moment later.
// A deadline here exists to stop an indefinite wait, not to pick a target.
const JIRA_TIMEOUT_MS = 60000;
const GITHUB_TIMEOUT_MS = 180000;

const params = new URLSearchParams(location.search);
const root = document.getElementById("recap-root");
const printBtn = document.getElementById("recap-print");
const toolbarNote = document.getElementById("recap-toolbar-note");

// The document is not printable until it exists. Everything that could put a
// print dialog over an empty page is gated on this: the toolbar button starts
// disabled in the markup, the auto-print waits for it, and a manual Cmd-P during
// the build gets the build state on paper rather than a blank sheet — which is
// what an unguarded version produced.
let ready = false;

// Jira and GitHub are both network calls, and this page has nothing to show
// until the first of them returns. So it says what it is waiting for from the
// first frame rather than looking finished and empty.
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

// A hung request must not leave the page waiting forever with a print button
// beside it. Whatever did not answer is named, because "Jira did not answer" and
// "GitHub did not answer" have different fixes.
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${what} did not answer within ${Math.round(ms / 1000)}s — reload this page to try again` +
                (what === "GitHub" ? ", or narrow the repository list in Settings" : "")
            )
          ),
        ms
      )
    ),
  ]);
}

async function init() {
  showStatus("Building the recap — reading the sprint from Jira…");

  // Same config, roster and boards the app uses: display-name overrides, avatar
  // overrides and field mappings all have to resolve here too.
  await loadBoards();
  await loadTeam();

  const creds = await getCredentials();
  if (!creds || !isConfigured()) {
    fail("Not configured yet — open the app and connect to Jira first.");
    return;
  }

  const [issues, statusGroups] = await withTimeout(
    Promise.all([getAllSprintIssues(creds), loadStatusGroups()]),
    JIRA_TIMEOUT_MS,
    "Jira"
  );

  // Kept paired with their board, unlike on the dashboard, because the recap
  // prints a block per board and needs to know whose sprint is whose.
  const boardSprints = await Promise.all(
    BOARDS.map(async (board) => ({
      board,
      sprints: await getActiveSprint(board.id, creds).catch(() => []),
    }))
  );
  const sprints = boardSprints.flatMap(({ sprints: list }) => list);

  const now = new Date();
  const summary = summarize({
    issues,
    sprints,
    statusGroups,
    monitorSettings: CONFIG.monitorChecks,
    boards: BOARDS,
    now,
  });

  const since = (
    summary.window.start || new Date(now.getTime() - FALLBACK_SPRINT_DAYS * 86400000)
  ).toISOString();

  const dated = Boolean(summary.window.start);
  const build = (stats) =>
    buildRecap({ summary, issues, boardSprints, statusGroups, stats, since, now });

  const firstPass = build(null);
  document.title = firstPass.sprintNames.length
    ? `Recap — ${firstPass.sprintNames.join(" · ")}`
    : "Sprint recap";

  // Nothing to recap is an answer, and it is printed as one. A document that
  // rendered its furniture around no content would look like a failure.
  if (!firstPass.combined.issues && !firstPass.sprintNames.length) {
    showStatus(
      "No active sprint on any configured board, so there is nothing to recap yet." +
        " Start a sprint in Jira, or check the boards under Settings.",
      { failed: true }
    );
    return;
  }

  const githubPending = isGithubConfigured();

  // The Jira half goes on screen straight away. Waiting for GitHub before drawing
  // anything meant staring at a status line for as long as the pull-request
  // window took to page, which on a busy month is a minute or more — and looked
  // indistinguishable from the page being broken. Printing stays disabled while
  // the GitHub figures are still dashes, so what goes to paper is never a
  // half-document.
  render(firstPass, { statsError: "", dated, statsPending: githubPending });
  if (!githubPending) {
    markReady();
  } else if (toolbarNote) {
    toolbarNote.textContent =
      "Reading pull requests and commits from GitHub — printing unlocks when they land.";
  }

  let stats = null;
  let statsError = "";
  if (githubPending) {
    try {
      // Bounded, and never fatal: a recap without the GitHub figures is still a
      // recap, and it says which are missing and why.
      stats = await withTimeout(getTeamStats({ now }), GITHUB_TIMEOUT_MS, "GitHub");
    } catch (err) {
      statsError = String(err?.message || err);
    }
    render(build(stats), { statsError, dated, statsPending: false });
    markReady();
  }

  // Print once the photos and the logo have actually decoded — printing over a
  // half-loaded image leaves holes in the PDF. `?print=0` renders without the
  // dialog, which is what the preview harness and anyone who wants a look first
  // both need.
  if (params.get("print") !== "0") {
    await imagesSettled();
    window.print();
  }
}

// Both routes to the dialog check readiness, so neither can print an empty page.
function printWhenReady() {
  if (!ready) return;
  window.print();
}

function fail(message) {
  ready = false;
  if (printBtn) {
    printBtn.disabled = true;
    printBtn.textContent = "Nothing to print";
  }
  // So a PDF saved anyway is not named as if it worked.
  document.title = "Sprint recap — could not be built";
  showStatus(message, { failed: true });
}

// Resolves when every image has loaded or failed, or after a second — a slow
// Jira avatar host must not hold the print dialog hostage.
function imagesSettled(timeoutMs = 1000) {
  const pending = [...document.images].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Points are often halves; integers shouldn't show a trailing ".0".
function num(n) {
  const value = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function pct(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

// The whole document is laid out as a one-column table whose `thead` holds the
// running header. That is not decoration: a `thead` is the only thing Blink both
// repeats on every printed page *and* reserves vertical space for. The first
// version used `position: fixed`, which repeats but reserves nothing — so from
// page two onwards the header painted straight over the top of whatever card had
// started there, slicing off its photo and name.
function render(recap, { statsError, dated, statsPending = false }) {
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
  body.appendChild(renderTitle(recap));
  body.appendChild(renderGlance(recap, { statsPending }));
  body.appendChild(renderPeopleSummary(recap, { statsPending }));
  body.appendChild(renderStatusSplit(recap));
  body.appendChild(renderPeople(recap, { statsError, dated, statsPending }));
  body.appendChild(renderBoards(recap));
  body.appendChild(renderTickets(recap));
  body.appendChild(renderFooter(recap));

  const tbody = el("tbody");
  const bodyRow = el("tr");
  const bodyCell = el("td");
  bodyCell.appendChild(body);
  bodyRow.appendChild(bodyCell);
  tbody.appendChild(bodyRow);
  layout.appendChild(tbody);

  // An empty spacer row, and the mirror of the `thead` above. A `tfoot` is the
  // only thing Blink repeats at the foot of every printed page *and* reserves
  // height for, which is what keeps the last line of each page off the bottom
  // edge of the background. Padding on a container cannot do this: it applies
  // once, at the end of the document, so every page but the last would run its
  // final row hard against the edge.
  const tfoot = el("tfoot");
  const footRow = el("tr");
  footRow.appendChild(el("td"));
  tfoot.appendChild(footRow);
  layout.appendChild(tfoot);

  root.appendChild(layout);
}

// The dark-ink sibling of the configured logo, from the same folder: this
// document always prints on white paper, so the light-background mark is the
// right one whatever the app's nav bar is showing. Falls back to the configured
// file if the sibling is not there — a preview, or a brand folder with only the
// one asset, must not print a broken image.
const DARK_LOGO = "org-logo-dark.png";
function darkLogoFor(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? DARK_LOGO : `${path.slice(0, slash + 1)}${DARK_LOGO}`;
}

// Logo left, document name right. The left mark comes from configuration —
// `brand.orgLogo` points at an untracked file under assets/brand/ — and the
// right-hand label names the document rather than the team, which the title
// block below already covers.
function renderHeader() {
  const header = el("header", "recap-header");

  const left = el("div", "recap-header-left");
  if (CONFIG.brand.orgLogo) {
    const logo = el("img", "recap-logo");
    logo.src = darkLogoFor(CONFIG.brand.orgLogo);
    logo.alt = CONFIG.brand.orgName || CONFIG.brand.productName;
    logo.addEventListener(
      "error",
      () => {
        logo.src = CONFIG.brand.orgLogo;
      },
      { once: true }
    );
    left.appendChild(logo);
  } else {
    left.appendChild(
      el("span", "recap-logo-text", CONFIG.brand.orgName || CONFIG.brand.productName)
    );
  }
  header.appendChild(left);

  header.appendChild(el("div", "recap-team", "Sprint Recap"));
  return header;
}

// The title says what the document is and which dates it covers, because a
// sprint name on its own ("Sprint 42") tells a reader outside the team nothing.
// The names are still printed, in the list below, against the board each belongs
// to — several boards run sprints of their own and a bare joined string lost
// which goal was whose.
function renderTitle(recap) {
  const wrap = el("div");

  const dates =
    recap.window.start && recap.window.end
      ? ` ${fmtDate(recap.window.start)} - ${fmtDate(recap.window.end)}`
      : "";
  wrap.appendChild(el("h1", "recap-title", `Sprint Recap${dates}`));

  const bits = [];
  if (recap.window.start && recap.window.end) {
    bits.push(
      `${recap.days.calendar} calendar days · ${recap.days.working} working ${recap.days.working === 1 ? "day" : "days"}`
    );
  } else {
    bits.push("No sprint dates in Jira");
  }
  if (recap.isOverdue) bits.push("past its end date");
  wrap.appendChild(el("p", "recap-subtitle", bits.join("  ·  ")));

  wrap.appendChild(renderSprintList(recap));
  return wrap;
}

// One bullet per sprint, named and described. A board with no active sprint is
// left out rather than printed as an empty bullet — "Board by board" below is
// where the absence is worth stating.
function renderSprintList(recap) {
  const list = el("ul", "recap-sprint-list");
  for (const board of recap.boards) {
    for (const sprint of board.sprints) {
      const item = el("li", "recap-sprint-item");
      // The bullet carries the board's own colour, so a reader can tell which
      // block below a sprint belongs to without the board name repeated here.
      if (board.color) item.style.setProperty("--sprint-dot", board.color);
      item.appendChild(el("span", "recap-sprint-name", sprint.name || "Unnamed sprint"));
      if (sprint.goal) item.appendChild(el("span", "recap-sprint-goal", sprint.goal));
      list.appendChild(item);
    }
  }
  // Falls back to whatever names the summary knows when no board reported a
  // sprint object — an undated or oddly-shaped sprint should not silently erase
  // the list.
  if (!list.childElementCount) {
    for (const name of recap.sprintNames) {
      const item = el("li", "recap-sprint-item");
      item.appendChild(el("span", "recap-sprint-name", name));
      list.appendChild(item);
    }
  }
  return list;
}

function tile(label, value, detail, { flag = false } = {}) {
  const node = el("div", `recap-tile${flag ? " recap-tile-flag" : ""}`);
  node.appendChild(el("div", "recap-tile-label", label));
  node.appendChild(el("div", "recap-tile-value", value));
  if (detail) node.appendChild(el("div", "recap-tile-detail", detail));
  return node;
}

// An absent figure, a pending one and a genuine zero are three different facts,
// so a figure still in flight prints as an ellipsis rather than a dash.
const PENDING = "…";
const absent = (statsPending) => (statsPending ? PENDING : "—");

function renderGlance(recap, { statsPending = false } = {}) {
  const c = recap.combined;
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "The sprint, combined"));

  // Four numbers, chosen to answer "what did we take on, what landed on us, how
  // much of it is off the team's plate, and how much code came out of it". Every
  // other figure is a supporting detail and reads as one, below.
  const tiles = el("div", "recap-tiles");
  tiles.appendChild(
    tile(
      "Issues started with",
      String(c.issuesStartedWith),
      `${c.issues} in the sprint now · ${num(c.pointsPlanned)} points`
    )
  );
  tiles.appendChild(
    tile(
      "Crept in",
      String(c.addedAfterStart),
      c.addedAfterStart
        ? `${num(c.addedAfterStartPoints)} points · ${pct(c.scopeCreepShare)} of the sprint`
        : "nothing added after the start",
      { flag: c.addedAfterStart > 0 }
    )
  );
  tiles.appendChild(
    tile(
      "In PR + ready",
      `${c.issuesWrappedUp}/${c.issues}`,
      `${num(c.pointsWrappedUp)} points · ${pct(c.wrappedUpByPoints)} by points`
    )
  );
  tiles.appendChild(
    tile(
      "LoC in main",
      c.github ? compactNum(c.github.lines) : absent(statsPending),
      c.github
        ? `${c.github.prsMerged} PRs merged · ${c.github.directCommits} pushed direct`
        : statsPending
          ? "still reading GitHub…"
          : "no GitHub figures for this sprint"
    )
  );
  section.appendChild(tiles);

  // The supporting figures, as a line rather than eight more cards.
  const more = el("div", "recap-inline-stats");
  more.appendChild(stat("Points done", num(c.pointsDone), `of ${num(c.pointsPlanned)}`));
  more.appendChild(stat("In review", num(c.pointsInReview), "pts"));
  more.appendChild(stat("Still open", num(c.pointsOpen), `${c.projectedCarryOut} issues`));
  more.appendChild(stat("Carried in", String(c.carriedIn), c.carriedIn ? `${num(c.carriedInPoints)} pts` : ""));
  if (c.github) {
    more.appendChild(stat("Reviews given", String(c.github.reviews)));
    more.appendChild(stat("Review comments", String(c.github.comments)));
  }
  section.appendChild(more);

  const notes = [];
  if (c.unestimated) {
    notes.push(
      `${c.unestimated} ${c.unestimated === 1 ? "issue is" : "issues are"} unestimated and count as zero points.`
    );
  }
  if (c.subtasksExcluded) {
    notes.push(
      `${c.subtasksExcluded} sub-${c.subtasksExcluded === 1 ? "task" : "tasks"} excluded — their points duplicate the parent story's.`
    );
  }
  notes.push(
    "\u201cIn PR + ready\u201d counts issues in a review column or already done." +
      " Issues started with, and what crept in, are counted from issue creation date," +
      " so an older issue dragged in mid-sprint is not caught."
  );
  section.appendChild(el("p", "recap-note", notes.join(" ")));
  return section;
}

// The per-person summary, up front and readable across: the figures that answer
// "who moved what" without the reader having to compare eleven cards. The cards
// further down carry the detail this leaves out, so nothing is printed twice.
//
// Ordered by story-point completion, highest first — a retro reads this table
// looking for where the points went, and alphabetical order buried that. The
// cards below stay in name order; see the framing note at the top of recap.js.
function renderPeopleSummary(recap, { statsPending = false } = {}) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "Per person, at a glance"));

  if (!recap.people.length) {
    section.appendChild(el("p", "recap-note", "Nothing was assigned in this sprint."));
    return section;
  }

  const table = el("table", "recap-table recap-summary-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [label, cls] of [
    ["Person", ""],
    ["Issues", "recap-num"],
    ["PRs & Done", "recap-num"],
    ["Completion %", "recap-num"],
    ["SP assigned", "recap-num"],
    ["SP done & in PRs", "recap-num"],
    ["SPs complete %", "recap-num"],
    ["PRs opened", "recap-num"],
    ["Reviews", "recap-num"],
  ]) {
    headRow.appendChild(el("th", cls, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const person of byPointCompletion(recap.people)) {
    const tr = el("tr");
    tr.appendChild(el("td", null, person.label));
    tr.appendChild(el("td", "recap-num mono", String(person.tickets)));
    tr.appendChild(el("td", "recap-num mono", String(person.reviewOrDoneIssues)));
    tr.appendChild(el("td", "recap-num mono", pct(person.issueShare)));
    tr.appendChild(el("td", "recap-num mono", num(person.points)));
    tr.appendChild(el("td", "recap-num mono", num(person.reviewOrDonePoints)));
    tr.appendChild(el("td", "recap-num mono", pct(person.share)));
    tr.appendChild(
      el("td", "recap-num mono", person.github ? String(person.github.prsOpened) : absent(statsPending))
    );
    tr.appendChild(
      el("td", "recap-num mono", person.github ? String(person.github.reviews) : absent(statsPending))
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // Totals, from the combined figures rather than re-added, so the line cannot
  // disagree with the cards at the top of the page.
  const c = recap.combined;
  const tfoot = el("tfoot");
  const totalRow = el("tr");
  totalRow.appendChild(el("td", null, "All"));
  for (const value of [
    String(c.issues),
    String(c.issuesWrappedUp),
    pct(c.wrappedUpByIssues),
    num(c.pointsPlanned),
    num(c.pointsWrappedUp),
    pct(c.wrappedUpByPoints),
    c.github ? String(c.github.prsOpened) : absent(statsPending),
    c.github ? String(c.github.reviews) : absent(statsPending),
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
      "Sorted by story-point completion. \u201cPRs & Done\u201d and \u201cSP done & in PRs\u201d" +
        " count issues, and the points on them, that are in a review column or already done." +
        " Completion % is those by issue, which exists for everyone including anyone whose" +
        " tickets carry no estimate; SPs complete % is the same by points, and is a dash when" +
        " nothing that person holds is estimated. Reviews counts reviews submitted on other" +
        " people's pull requests."
    )
  );
  return section;
}

// Highest point completion first. Nobody with an unestimated workload — a null
// share, not a zero — is ranked as if they had finished nothing, so those sort
// after everyone with a real figure; the unassigned bucket sorts last of all,
// not being a person.
function byPointCompletion(people) {
  const rank = (p) => (p.accountId === "__unassigned__" ? 2 : p.share === null || p.share === undefined ? 1 : 0);
  return [...people].sort(
    (a, b) => rank(a) - rank(b) || (b.share ?? 0) - (a.share ?? 0) || a.label.localeCompare(b.label)
  );
}

function renderStatusSplit(recap) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "Where the points ended up"));

  const buckets = recap.byStatus;
  const usePoints = recap.combined.pointsPlanned > 0;
  const total = buckets.reduce((n, b) => n + (usePoints ? b.points : b.issues), 0);
  if (!total) {
    section.appendChild(el("p", "recap-note", "Nothing in the sprint to split."));
    return section;
  }

  const RAMP = ["--step-1", "--step-2", "--step-3", "--step-4"];
  const fillOf = (i) => `var(${RAMP[Math.min(i, RAMP.length - 1)]})`;
  // Ink picked per step so an inline number stays legible on its own fill.
  const inkOf = (i) => (i >= 2 ? "#ffffff" : "#16181d");

  const bar = el("div", "recap-bar");
  buckets.forEach((bucket, i) => {
    const value = usePoints ? bucket.points : bucket.issues;
    if (value <= 0) return;
    const seg = el("div", "recap-bar-seg");
    seg.style.flex = String(value);
    seg.style.background = fillOf(i);
    seg.style.color = inkOf(i);
    // Only label a segment wide enough to hold the number.
    if (value / total > 0.07) seg.textContent = num(value);
    bar.appendChild(seg);
  });
  section.appendChild(bar);

  const legend = el("div", "recap-legend");
  buckets.forEach((bucket, i) => {
    const item = el("span", "recap-legend-item");
    const dot = el("span", "recap-dot");
    dot.style.background = fillOf(i);
    item.appendChild(dot);
    item.appendChild(
      el(
        "span",
        null,
        `${bucket.key} · ${num(usePoints ? bucket.points : bucket.issues)}${usePoints ? " pts" : ""} · ${bucket.issues} ${bucket.issues === 1 ? "issue" : "issues"}`
      )
    );
    legend.appendChild(item);
  });
  section.appendChild(legend);
  section.appendChild(
    el(
      "p",
      "recap-note",
      usePoints
        ? "Story points by status group, in the order the board reads."
        : "Issue counts — no story points are set on this sprint."
    )
  );
  return section;
}

function stat(label, value, of) {
  const node = el("div", "recap-stat");
  node.appendChild(el("span", "recap-stat-label", label));
  const val = el("span", "recap-stat-value", value);
  if (of) val.appendChild(el("span", "recap-stat-of", ` ${of}`));
  node.appendChild(val);
  return node;
}

function renderPeople(recap, { statsError, dated, statsPending = false }) {
  const section = el("section", "recap-section recap-section-break");
  section.appendChild(el("h2", "recap-section-title", "Contribution by person"));

  if (!recap.people.length) {
    section.appendChild(el("p", "recap-note", "Nothing was assigned in this sprint."));
    return section;
  }

  const grid = el("div", "recap-people");
  for (const person of recap.people) {
    const card = el("div", "recap-person");

    const head = el("div", "recap-person-head");
    if (person.avatar) {
      const img = el("img", "recap-avatar");
      img.src = person.avatar;
      img.alt = "";
      head.appendChild(img);
    } else {
      // Initials rather than a hole: not everyone has a photo on the roster, and
      // a missing one should not look like a rendering fault.
      const fallback = el(
        "div",
        "recap-avatar recap-avatar-fallback",
        (person.label || "?").trim()[0].toUpperCase()
      );
      head.appendChild(fallback);
    }

    const names = el("div");
    const name = el("div", "recap-person-name");
    name.append(person.label);
    if (person.onTeam === false) name.appendChild(el("span", "recap-outside", "outside team"));
    names.appendChild(name);
    // Three different facts, and the card says which: a mapped login, a person
    // with none, and the unassigned bucket, which is not a person at all.
    const sub =
      person.accountId === "__unassigned__"
        ? "tickets with no assignee"
        : person.githubLogin
          ? `@${person.githubLogin}`
          : "no GitHub login on the roster";
    names.appendChild(el("div", "recap-person-sub", sub));
    head.appendChild(names);
    card.appendChild(head);

    // Five, not twelve. Issue completion, PRs opened and reviews are in the
    // summary table above; a card that repeated them would make the reader check
    // whether the two agreed instead of reading either.
    //
    // "Commits to main" is merged pull requests plus commits pushed straight to
    // the default branch — everything that reached main, however it got there.
    // The two were printed separately and the split read as a judgement on how
    // people work rather than a count of what shipped.
    const gh = person.github;
    const stats = el("div", "recap-person-stats");
    stats.appendChild(stat("Points planned", num(person.points)));
    stats.appendChild(stat("Points wrapped", num(person.reviewOrDonePoints), `${pct(person.share)}`));
    stats.appendChild(stat("Crept in", String(person.addedAfterStart)));
    stats.appendChild(
      stat("Commits to main", gh ? String(gh.prsMerged + gh.directCommits) : absent(statsPending))
    );
    stats.appendChild(stat("Lines to main", gh ? compactNum(gh.lines) : absent(statsPending)));
    card.appendChild(stats);
    grid.appendChild(card);
  }
  section.appendChild(grid);

  section.appendChild(el("p", "recap-note", peopleNote(recap, { statsError, dated, statsPending })));
  return section;
}

function peopleNote(recap, { statsError, dated, statsPending = false }) {
  const parts = [
    "Ordered by name. Points wrapped counts points on issues in a review column or" +
      " already done, and the figure beside it is that as a share of points planned." +
      " Commits to main counts merged pull requests together with commits pushed" +
      " straight to the default branch. Issue counts, PRs opened and reviews are in" +
      " the table above.",
  ];
  if (statsPending) {
    parts.push(
      "GitHub figures are still being read and will fill in on this page — the" +
        " print button unlocks when they land."
    );
  } else if (!recap.github.queried) {
    parts.push(
      statsError
        ? `GitHub figures unavailable — ${statsError}.`
        : "GitHub sync is off, so the pull request figures are absent rather than zero."
    );
  } else if (!recap.github.available) {
    parts.push(
      "No GitHub figures: nobody in this sprint has a GitHub login on the roster. Map logins in Settings → Team."
    );
  } else {
    const window = recap.github.clamped
      ? `from ${fmtDate(recap.github.from)}, which is as far back as GitHub was queried — this sprint started before that`
      : dated
        ? `from ${fmtDate(recap.github.from)}`
        : `over the last ${FALLBACK_SPRINT_DAYS} days, there being no start date on the active sprint`;
    parts.push(`GitHub figures are counted ${window}.`);

    // A partial answer must not print as a whole one.
    if (recap.github.failures.length) {
      const listed = recap.github.failures
        .map((f) => `${f.repo} (${f.message})`)
        .join("; ");
      parts.push(`Incomplete for ${listed} — the figures below undercount by whatever those hold.`);
    }
    if (recap.github.truncated.length) {
      parts.push(
        `${recap.github.truncated.join(", ")} had more history than the query reads in one go,` +
          " so anything older than that is not counted."
      );
    }
    if (recap.github.unmapped) {
      parts.push(
        `${recap.github.unmapped} ${recap.github.unmapped === 1 ? "person has" : "people have"} no GitHub login on the roster, so those figures are dashes rather than zeroes.`
      );
    }
  }
  return parts.join(" ");
}

function renderBoards(recap) {
  const section = el("section", "recap-section");
  section.appendChild(el("h2", "recap-section-title", "Board by board"));

  const list = el("div", "recap-boards");
  for (const board of recap.boards) {
    const block = el("div", "recap-board");
    if (board.color) block.style.borderLeftColor = board.color;

    const head = el("div", "recap-board-head");
    head.appendChild(el("span", "recap-board-name", board.name));
    head.appendChild(
      el(
        "span",
        "recap-board-sprint",
        board.sprints.length
          ? board.sprints.map((s) => s.name).filter(Boolean).join(" · ")
          : "no active sprint"
      )
    );
    const dates = board.sprints
      .filter((s) => s.start && s.end)
      .map((s) => `${fmtDate(s.start)} → ${fmtDate(s.end)}`);
    if (dates.length) head.appendChild(el("span", "recap-board-dates mono", dates.join("  ·  ")));
    block.appendChild(head);

    for (const sprint of board.sprints) {
      if (sprint.goal) block.appendChild(el("p", "recap-goal", sprint.goal));
    }

    const stats = el("div", "recap-board-stats");
    stats.appendChild(stat("Issues", String(board.issues)));
    stats.appendChild(stat("Done", String(board.doneIssues), `of ${board.issues}`));
    stats.appendChild(stat("Points planned", num(board.points)));
    stats.appendChild(stat("Points done", num(board.donePoints)));
    stats.appendChild(stat("% by points", pct(board.completion)));
    stats.appendChild(stat("Crept in", String(board.addedAfterStart)));
    stats.appendChild(stat("Carried in", String(board.carriedIn)));
    block.appendChild(stats);
    list.appendChild(block);
  }
  section.appendChild(list);
  return section;
}

function renderTickets(recap) {
  const section = el("section", "recap-section recap-section-break");
  section.appendChild(
    el("h2", "recap-section-title", `Tickets in this sprint (${recap.tickets.length})`)
  );

  if (!recap.tickets.length) {
    section.appendChild(el("p", "recap-note", "No tickets in the sprint."));
    return section;
  }

  const table = el("table", "recap-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [label, cls] of [
    ["Key", ""],
    ["Summary", ""],
    ["Assignee", ""],
    ["Status", ""],
    ["Pts", "recap-num"],
    ["Flags", ""],
  ]) {
    headRow.appendChild(el("th", cls, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  let board = null;
  for (const ticket of recap.tickets) {
    if (ticket.board !== board) {
      board = ticket.board;
      const groupRow = el("tr", "recap-table-group");
      const cell = el("td", null, board || "No board");
      cell.colSpan = 6;
      groupRow.appendChild(cell);
      tbody.appendChild(groupRow);
    }

    const tr = el("tr");
    tr.appendChild(el("td", "recap-key", ticket.key));
    tr.appendChild(el("td", null, ticket.summary));
    tr.appendChild(el("td", null, ticket.assignee));

    const status = el("td");
    status.appendChild(
      el("span", `recap-status${ticket.done ? " recap-status-done" : ""}`, ticket.status || "—")
    );
    tr.appendChild(status);

    tr.appendChild(el("td", "recap-num mono", ticket.points === null ? "—" : num(ticket.points)));

    // Two flags, both spelled out: a symbol on its own would need a key nobody
    // reads, and colour on its own would not survive a mono printer.
    const flags = [];
    if (ticket.addedAfterStart) flags.push("↳ crept in");
    if (ticket.carriedIn) flags.push("↺ carried in");
    const flagCell = el("td");
    if (flags.length) {
      flagCell.appendChild(el("span", "recap-flag", flags.join("  ")));
    }
    tr.appendChild(flagCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function renderFooter(recap) {
  const footer = el("footer", "recap-footer");
  footer.appendChild(
    el(
      "span",
      null,
      `Generated ${fmtDate(recap.generatedAt)} by ${CONFIG.brand.productName} from Jira and GitHub data.`
    )
  );
  footer.appendChild(
    el("span", null, "Retro material — a record of what the sprint did, not an assessment of anyone in it.")
  );
  return footer;
}

printBtn?.addEventListener("click", printWhenReady);

init().catch((err) => fail(`Could not build the recap — ${err?.message || err}`));
