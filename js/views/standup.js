import { runtimeUrl } from "../browser.js";
import { getActiveSprint, getAllSprintIssues } from "../api.js";
import { BOARDS, compactNum, fmtDate, isOverdue, loadStatusGroups } from "../utils.js";
import {
  activeMembers,
  activeTeam,
  avatarOverrideFor,
  memberLabel,
  memberFor,
  slackMentionFor,
} from "../team.js";
import {
  FALLBACK_SPRINT_DAYS,
  PR_STATE_LABELS,
  activityFor,
  getTeamActivity,
  getTeamStats,
  isGithubConfigured,
  statsFor,
} from "../github.js";
import {
  activityFor as jiraActivityFor,
  activityFrom as jiraActivityFrom,
} from "../activity.js";
import * as confetti from "../confetti.js";
import { renderColumns } from "../components/board.js";
import { openIssueDrawer } from "../components/issue-detail.js";
import { createIssueMover } from "../issue-move.js";
import * as sfx from "../sfx.js";
import {
  DEFAULT_DURATION_SEC,
  DIGEST_EMOJI,
  DIGEST_HEADING,
  DIGEST_SIGNOFF,
  PHASES,
  addTime,
  advance,
  clampDuration,
  clearSession,
  createSession,
  currentId,
  digestHtml,
  digestText,
  estimatedWallSec,
  finish,
  formatClock,
  handoffPhrase,
  isOverrun,
  isPaused,
  loadPrefs,
  loadSession,
  nextId,
  notesEntries,
  overrunScale,
  phaseElapsedMs,
  phaseRemainingMs,
  phaseTotalMs,
  plannedTotalSec,
  savePrefs,
  saveSession,
  shouldAutoAdvance,
  togglePause,
  trimSprintLabel,
} from "../standup.js";

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  // GitHub is a second, optional source and is never on the critical path. The
  // fetch is kicked off here, before the first `await` — the header prewarms it
  // on click too, and both land on the same in-flight promise — so the two
  // GraphQL queries run alongside the sprint issues rather than after them. The
  // standup starts whether or not they have landed, and any failure leaves the
  // panel absent rather than blocking a view. `github.state` is what the setup
  // chip reports.
  const github = { state: "off", activity: null, stats: null, error: "", statsError: "" };
  // A cached window resolves in a microtask, which can be before the rest of
  // mount has even declared `session`. Nothing repaints until the first render
  // has happened; whatever landed early is on screen by then anyway.
  let mounted = false;
  const githubFetch = startGithubFetch();

  const [sprintIssues, statusGroups, prefs, storedSession] = await Promise.all([
    getAllSprintIssues(creds),
    loadStatusGroups(),
    loadPrefs(),
    loadSession(),
  ]);
  await sfx.loadMuted();
  sfx.preload();

  // getAllSprintIssues has already asked for these, so every call here is a
  // cache hit rather than a second round trip, and a board that refuses one is
  // simply left out.
  const activeSprints = (
    await Promise.all(BOARDS.map((b) => getActiveSprint(b.id, creds).catch(() => [])))
  )
    .flat()
    .filter(Boolean);

  // Named for the header line.
  const sprintNames = [...new Set(activeSprints.map((s) => s?.name).filter(Boolean))];

  // The window every GitHub statistic is counted over. Earliest start among the
  // sprints in flight, because with two boards running staggered sprints a
  // per-board window would mean two different meanings of "this sprint" in one
  // table. Fourteen days is the fallback for a board whose sprint carries no
  // start date, which is the common sprint length here and states its guess
  // rather than counting from the beginning of time.
  const sprintStarts = activeSprints
    .map((s) => new Date(s?.startDate || 0).getTime())
    .filter((t) => Number.isFinite(t) && t > 0);
  const sprintStart = new Date(
    sprintStarts.length
      ? Math.min(...sprintStarts)
      : Date.now() - FALLBACK_SPRINT_DAYS * 86400000
  );
  const sprintStartIso = sprintStart.toISOString();
  const sprintDated = sprintStarts.length > 0;

  // Per-person Jira activity over the same window the GitHub numbers use, so
  // "this sprint" means one thing across the whole table. Derived from the
  // changelog that rode the `getAllSprintIssues` request above — no fetch of its
  // own, which is why this is computed eagerly rather than behind a flag.
  const jiraActivity = jiraActivityFrom(sprintIssues, {
    since: sprintStartIso,
    statusGroups,
  });

  const roster = activeMembers();
  // A discarded resume has to stick: the banner is hidden by this going null,
  // not by whichever notice happens to be on screen at the time.
  let resumable = storedSession;
  let session = null;
  let ticker = null;
  let countdownCuePlayed = false;

  // Two queries, two failure modes, one status line. The activity query is what
  // the panel lists; the window query is what the per-person numbers count. The
  // window one is slower — it pages — so they are awaited separately and the
  // screen repaints as each lands, rather than the fast one waiting on the slow.
  function startGithubFetch() {
    if (!isGithubConfigured()) {
      github.state = "off";
      return null;
    }
    github.state = "loading";

    const activity = getTeamActivity()
      .then((result) => {
        github.activity = result;
        return result;
      })
      .catch((err) => {
        github.error = String(err?.message || err);
        return null;
      });

    const stats = getTeamStats()
      .then((result) => {
        github.stats = result;
        return result;
      })
      .catch((err) => {
        // Losing the window costs the four numbers, not the panel: the lists
        // come from the other query and are still worth showing.
        github.statsError = String(err?.message || err);
        return null;
      });

    // Repaint as soon as either lands, so the panel is not held back by the
    // paged query and the numbers are not held back by anything.
    const repaintOn = (pending) => pending.then((result) => {
      settleGithubState();
      repaintGithub();
      return result;
    });
    return Promise.all([repaintOn(activity), repaintOn(stats)]);
  }

  // "loading" until both have answered; after that the worst news wins, because
  // the chip's job is to explain a panel that is thinner than expected.
  function settleGithubState() {
    if (github.state === "off") return;
    const activityDone = Boolean(github.activity) || Boolean(github.error);
    const statsDone = Boolean(github.stats) || Boolean(github.statsError);
    if (!activityDone || !statsDone) {
      github.state = "loading";
      return;
    }
    if (!github.activity && !github.stats) {
      github.state = "error";
      return;
    }
    const unreachable =
      (github.activity?.failures?.length || 0) +
      (github.stats?.failures?.length || 0) +
      (github.stats?.truncated?.length || 0);
    const partial = unreachable > 0 || !github.activity || !github.stats;
    github.state = partial ? "partial" : "ready";
  }

  function repaintGithub() {
    if (!mounted) return;
    // The setup screen reports GitHub in four places now — the Open PRs tile,
    // the per-person stat cluster, the Quick info card and its note — so it is
    // repainted wholesale rather than having one chip patched in place.
    if (!session) renderSetup(setupNotice);
    // A person already on screen when a fetch lands gets their numbers without
    // waiting for the next hand-off.
    else if (session.phase === PHASES.SPEAKING) renderRunning();
  }
  // The board element of the person currently speaking, so a card drop can
  // repaint just the columns. Re-rendering the whole stage would blow away the
  // parking-lot textarea mid-sentence.
  let speakingBoard = null;

  const wrap = document.createElement("div");
  wrap.className = "standup-wrap";
  container.innerHTML = "";
  container.appendChild(wrap);

  // Setup state, kept outside the session so it survives cancelling a run.
  let attending = new Set(
    prefs.attendance.length
      ? prefs.attendance.filter((id) => roster.some((m) => m.accountId === id))
      : roster.map((m) => m.accountId)
  );
  const durations = { ...prefs.durations };

  function issuesFor(accountId) {
    return sprintIssues.filter((i) => i.fields?.assignee?.accountId === accountId);
  }

  function labelFor(accountId) {
    const member = memberFor(accountId);
    if (member) return memberLabel(member);
    const issue = issuesFor(accountId)[0];
    return issue?.fields?.assignee?.displayName || accountId;
  }

  function avatarFor(accountId) {
    const member = memberFor(accountId);
    // A roster picture override wins; then Jira's, at the largest size standup
    // has (its avatars are rendered much bigger than a card's).
    const override = avatarOverrideFor(accountId);
    if (override) return override;
    if (member?.avatarUrl) return member.avatarUrl;
    const issue = issuesFor(accountId).find((i) => i.fields.assignee?.avatarUrls);
    const urls = issue?.fields.assignee?.avatarUrls;
    return urls?.["48x48"] || urls?.["32x32"] || urls?.["24x24"] || "";
  }

  // ── Setup screen ───────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Inline SVG rather than an icon font or a sprite file: a handful of paths
  // each, inheriting currentColor so one copy serves both themes. Same approach
  // as the backlog header.
  const ICON_PATHS = {
    calendar: ["M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z", "M3 10h18", "M8 3v4", "M16 3v4"],
    users: ["M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20", "M9 10.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z", "M22 20v-1.5a4 4 0 0 0-3-3.87", "M16 3.24a4 4 0 0 1 0 7.52"],
    mic: ["M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z", "M19 11a7 7 0 0 1-14 0", "M12 18v4", "M8 22h8"],
    clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7.5V12l3 2"],
    sprint: ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"],
    check: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m8.4 12.2 2.4 2.4 4.8-5.4"],
    alert: ["M10.3 4.4 2.7 17.5A2 2 0 0 0 4.4 20.5h15.2a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z", "M12 9.5v4", "M12 17h.01"],
    ban: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m5.9 5.9 12.2 12.2"],
    sound: ["M11 5 6.5 9H3v6h3.5L11 19V5Z", "M15.4 9.2a4 4 0 0 1 0 5.6", "M18.2 6.4a8 8 0 0 1 0 11.2"],
    play: ["m8 5.5 11 6.5-11 6.5v-13Z"],
    arrow: ["M4 12h15", "m13 6 6 6-6 6"],
  };

  // The octicon mark, on its own 16-unit grid and filled rather than stroked —
  // GitHub's logo is the one icon here that must not be redrawn by hand.
  const GITHUB_MARK =
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 " +
    "0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 " +
    "1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 " +
    "0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 " +
    "1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 " +
    "3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 " +
    "8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";

  function icon(name, size = 16) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    const path = (d) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    };

    if (name === "github") {
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "currentColor");
      path(GITHUB_MARK);
      return svg;
    }

    svg.setAttribute("viewBox", "0 0 24 24");
    // The play triangle is a solid shape; everything else is a line drawing.
    svg.setAttribute("fill", name === "play" ? "currentColor" : "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of ICON_PATHS[name] || []) path(d);
    return svg;
  }

  const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

  function attendingIds() {
    return roster.map((m) => m.accountId).filter((id) => attending.has(id));
  }

  // "Blocked" is not a field Jira gives every site, so it is read off the
  // status name — and only used as the row's flag when this sprint actually has
  // such a status. Otherwise the same slot shows overdue, which every site can
  // answer. The choice is made once for the whole table so the column means one
  // thing top to bottom.
  const BLOCKED_STATUS = /block|impediment|on hold/i;
  const flagsBlocked = sprintIssues.some((i) =>
    BLOCKED_STATUS.test(i.fields?.status?.name || "")
  );

  function flagFor(accountId) {
    const mine = issuesFor(accountId);
    const count = flagsBlocked
      ? mine.filter((i) => BLOCKED_STATUS.test(i.fields?.status?.name || "")).length
      : mine.filter((i) => isOverdue(i)).length;
    return { count, label: `${count} ${flagsBlocked ? "blocked" : "overdue"}` };
  }

  // The four numbers the standup asks about a person, or null when GitHub cannot
  // answer for them at all — an absent number and a zero are different facts.
  //
  // `open` is "right now" and comes from the activity query; the rest are
  // sprint-to-date and come from the paged window query. Either query can be
  // missing on its own, so each half is separately null-able and the row shows
  // whichever has arrived.
  function githubStatsFor(accountId) {
    const login = memberFor(accountId)?.githubLogin;
    if (!login) return null;
    const open = github.activity ? activityFor(github.activity, login).open.length : null;
    const window = github.stats
      ? statsFor(github.stats, login, { since: sprintStartIso })
      : null;
    if (open === null && !window) return null;
    return { login, open, window };
  }

  // One definition of the four statistics, rendered twice — compactly on the
  // setup row and as tiles on the speaker's panel. Sharing the list is what
  // stops the two from drifting into meaning different things.
  function statSpecs(stats) {
    const w = stats.window;
    let note;
    if (!w) {
      note = github.statsError
        ? ` Unavailable — ${github.statsError}`
        : " Still loading.";
    } else if (w.clamped) {
      note =
        ` Counted from ${fmtDate(w.from)}, which is as far back as GitHub was` +
        " queried — this sprint started before that.";
    } else if (sprintDated) {
      note = ` Sprint to date, from ${fmtDate(w.from)}.`;
    } else {
      note =
        ` Last ${FALLBACK_SPRINT_DAYS} days, from ${fmtDate(w.from)} — no start` +
        " date on the active sprint.";
    }

    return [
      {
        key: "open",
        label: "Open PRs",
        short: "open",
        value: stats.open,
        title:
          stats.open === null
            ? `Open pull requests they authored.${github.error ? ` Unavailable — ${github.error}` : " Still loading."}`
            : "Open pull requests they authored. Drafts excluded.",
      },
      {
        key: "opened",
        label: "PRs opened",
        short: "new",
        value: w ? w.prsOpened : null,
        title: `Pull requests they opened, drafts excluded.${note}`,
      },
      {
        key: "reviews",
        label: "Reviews & comments",
        short: "rev",
        value: w ? w.engagements : null,
        title: w
          ? `${w.reviews} ${plural(w.reviews, "review")} submitted and ${w.comments} ${plural(w.comments, "comment")} written on other people's pull requests.${note}`
          : `Reviews and comments on other people's pull requests.${note}`,
      },
      {
        key: "lines",
        label: "Lines to main",
        short: "lines",
        value: w ? w.lines : null,
        text: w ? `+${compactNum(w.additions)} −${compactNum(w.deletions)}` : null,
        title: w
          ? `${w.lines.toLocaleString()} ${plural(w.lines, "line")} into the default branch — ${w.additions.toLocaleString()} added, ${w.deletions.toLocaleString()} removed — across ${w.prsMerged} merged ${plural(w.prsMerged, "pull request")}${w.directCommits ? ` and ${w.directCommits} ${plural(w.directCommits, "commit")} pushed straight to it` : ""}.${note}`
          : `Lines that reached the repositories' default branches, whether through a pull request or pushed straight to it.${note}`,
      },
    ];
  }

  // One person's Jira activity this sprint, or null when there is nothing to
  // answer with. Unlike the GitHub half this needs no credential and no roster
  // entry — it is derived from the sprint issues already on screen — so the only
  // reason it is absent is a site that did not return issue history.
  function jiraStatsFor(accountId) {
    return jiraActivityFor(jiraActivity, accountId);
  }

  // One definition of the four Jira statistics, rendered twice — compactly on
  // the setup row and as tiles on the speaker's panel. Same reason `statSpecs`
  // is shared: it is what stops the two from drifting into meaning different
  // things.
  //
  // **These are activity, not performance.** A high count is not a good number
  // and a low one is not a bad one — ten transitions can be one ticket bouncing
  // between review and rework — so every tooltip says what the figure counts and
  // none of them implies it should be larger. The table is ordered by name, and
  // no sort-by-count is offered. See the note at the top of `js/activity.js`.
  function jiraStatSpecs(stats) {
    const known = stats.historyKnown;
    // The counts are a floor, not a total, when Jira truncated a history: the
    // expand is bounded per issue and does not paginate. Saying so beats
    // printing an undercount as though it were whole — the same answer
    // `js/github.js` gives for its own page caps.
    const floor = jiraActivity.truncated.length
      ? ` At least this many: Jira returned only the most recent history for ${jiraActivity.truncated.length} ${plural(jiraActivity.truncated.length, "issue")} in this sprint, so older changes are not counted.`
      : "";
    const note = known
      ? ` Sprint to date, from ${fmtDate(jiraActivity.window.from)}.${floor}`
      : " Unavailable — this site returned no issue history.";
    const val = (n) => (known ? n : null);

    return [
      {
        key: "moved",
        label: "Moved",
        short: "moved",
        value: val(stats.transitions),
        title:
          `Status changes they made, counting the same issue twice if they moved it twice.` +
          `${known && stats.reopened ? ` ${stats.reopened} of their moves took something back out of done.` : ""}` +
          ` Conversation fuel, not a score.${note}`,
      },
      {
        key: "closed",
        label: "Closed",
        short: "closed",
        value: val(stats.completed),
        title:
          `Transitions they made into a done status — ${known ? `${stats.completedIssues.length} distinct ${plural(stats.completedIssues.length, "issue")}` : "distinct issues"}, which differs from the count when something was reopened and closed again.${note}`,
      },
      {
        key: "took",
        label: "Picked up",
        short: "took",
        value: val(stats.pickedUp),
        title:
          `Issues that became theirs this sprint, whether they assigned it to themselves or someone else did.` +
          `${known && stats.assignedOut ? ` They also moved ${stats.assignedOut} off their own name.` : ""}${note}`,
      },
      {
        key: "made",
        label: "Created",
        short: "made",
        // The one figure that needs no changelog: `fields.creator` is fetched
        // with every issue, so this is a real number even where history is not.
        value: stats.created,
        title:
          `Issues they created this sprint — the work that appeared after it started.` +
          `${known && stats.edits ? ` They also made ${stats.edits} field ${plural(stats.edits, "edit")} — points, dates and the like.` : ""}` +
          ` Sprint to date, from ${fmtDate(jiraActivity.window.from)}.`,
      },
    ];
  }

  // Which of the four absent cases this is, because each has a different fix:
  // connect GitHub, wait, add a login to the roster, or nothing at all.
  function githubAbsentReason() {
    if (github.state === "off") return "GitHub is not connected.";
    if (github.state === "error") return `GitHub is unavailable — ${github.error}`;
    if (!github.activity && !github.stats) return "Still loading pull requests.";
    return "No GitHub login on the roster for this person.";
  }

  // The last notice passed to renderSetup, so a repaint triggered by the GitHub
  // fetch landing does not silently drop the line someone is still reading.
  let setupNotice = "";

  function renderSetup(notice = "") {
    setupNotice = notice;
    stopTicker();
    document.body.dataset.standupActive = "";
    wrap.className = "standup-wrap su-wrap";
    wrap.innerHTML = "";

    if (!roster.length) {
      wrap.appendChild(emptyRosterPanel());
      return;
    }

    wrap.appendChild(setupHeader());
    if (resumable) wrap.appendChild(resumeBanner());
    if (notice) wrap.appendChild(bannerEl("su-banner", notice));
    wrap.appendChild(participantsPanel());
    wrap.appendChild(infoRow());
    wrap.appendChild(startRow());
  }

  function emptyRosterPanel() {
    const panel = el("section", "su-panel su-panel-empty");
    const mark = el("span", "su-header-icon");
    mark.appendChild(icon("users", 22));
    panel.append(
      mark,
      el("h1", "su-title", "Daily Standup"),
      el(
        "p",
        "su-subtitle",
        "No team roster yet. Add people in Settings → Team roster, then come back."
      )
    );
    const openSettings = el("button", "su-btn primary", "Open Settings");
    openSettings.addEventListener("click", () => window.open(runtimeUrl("settings.html")));
    panel.appendChild(openSettings);
    return panel;
  }

  // ── Header ─────────────────────────────────────────────────────────────────

  function setupHeader() {
    const header = el("header", "su-header");

    const left = el("div", "su-header-left");
    const mark = el("span", "su-header-icon");
    mark.appendChild(icon("calendar", 22));
    left.appendChild(mark);

    const titles = el("div", "su-titles");
    titles.append(
      el("h1", "su-title", "Daily Standup"),
      el("p", "su-subtitle", "Let's keep it short and focused.")
    );
    left.appendChild(titles);

    const meta = el("div", "su-meta");
    const today = new Date();
    const weekday = today.toLocaleDateString(undefined, { weekday: "short" });
    metaItem(meta, "calendar", `${weekday}, ${fmtDate(today.toISOString())}`);
    const team = activeTeam()?.name;
    if (team) metaItem(meta, "users", team);
    // Identifiers only — the descriptive tail Jira carries on a sprint name is
    // what makes this line wrap. De-duplicated a second time because trimming
    // collapses "DP-82: Payments" and "DP-82 (carry-over)" onto the same
    // sprint, and "DP-82 · DP-82" would read as two.
    const sprintLabels = [...new Set(sprintNames.map(trimSprintLabel))];
    if (sprintLabels.length) metaItem(meta, "sprint", sprintLabels.join(" · "));
    meta.appendChild(el("span", "su-meta-sep", "·"));
    const available = el("span", "su-meta-item");
    available.append(
      el("i", "su-live-dot"),
      el("span", null, `${roster.length} ${plural(roster.length, "person", "people")} available`)
    );
    meta.appendChild(available);
    left.appendChild(meta);

    header.append(left, tilesEl());
    return header;
  }

  function metaItem(parent, name, text) {
    if (parent.childElementCount) parent.appendChild(el("span", "su-meta-sep", "·"));
    const item = el("span", "su-meta-item");
    item.append(icon(name, 14), el("span", null, text));
    parent.appendChild(item);
  }

  function tilesEl() {
    const ids = attendingIds();
    const speakMin = Math.round(plannedTotalSec(ids, durations) / 60);
    const wallMin = Math.ceil(estimatedWallSec(ids, durations) / 60);

    const specs = [
      { icon: "users", tone: "blue", num: String(ids.length), label: "Attendees" },
      { icon: "mic", tone: "purple", num: String(speakMin), unit: "min", label: "Speaking time" },
      { icon: "clock", tone: "green", num: `~${wallMin}`, unit: "min", label: "Total estimated" },
    ];
    const openPrs = github.activity?.pullRequests?.length;
    if (openPrs !== undefined) {
      specs.push({ icon: "github", tone: "orange", num: String(openPrs), label: "Open PRs" });
    }

    const tiles = el("div", "su-tiles");
    for (const spec of specs) {
      const tile = el("div", `su-tile tone-${spec.tone}`);
      const mark = el("span", "su-tile-icon");
      mark.appendChild(icon(spec.icon, 17));
      const num = el("span", "su-tile-num", spec.num);
      if (spec.unit) num.appendChild(el("em", "su-tile-unit", spec.unit));
      tile.append(mark, num, el("span", "su-tile-label", spec.label));
      tiles.appendChild(tile);
    }
    return tiles;
  }

  function bannerEl(className, text) {
    const banner = el("div", className);
    banner.appendChild(el("span", null, text));
    return banner;
  }

  function resumeBanner() {
    const banner = bannerEl(
      "su-banner warn",
      `Unfinished standup: ${resumable.index + 1} of ${resumable.order.length}. Same order as before.`
    );

    const resumeBtn = el("button", "su-btn small primary", "Resume");
    resumeBtn.addEventListener("click", async () => {
      await sfx.unlock();
      session = resumable;
      renderRunning();
      startTicker();
    });

    const discard = el("button", "su-btn small ghost", "Discard");
    discard.addEventListener("click", async () => {
      await clearSession();
      resumable = null;
      renderSetup("Previous session discarded.");
    });

    banner.append(resumeBtn, discard);
    return banner;
  }

  // ── 1. Participants ────────────────────────────────────────────────────────

  function panelHead(step, title, hint) {
    const head = el("div", "su-panel-head");
    head.append(
      el("span", "su-step", String(step)),
      el("h2", "su-panel-title", title),
      el("span", "su-panel-hint", hint)
    );
    return head;
  }

  function participantsPanel() {
    const panel = el("section", "su-panel");
    const head = panelHead(1, "Participants", "Who's in today?");

    const actions = el("div", "su-panel-actions");
    actions.append(el("span", "su-field-label", "Select:"));

    const segmented = el("div", "su-segmented");
    segmented.append(
      segBtn("Everyone", () => {
        attending = new Set(roster.map((m) => m.accountId));
        renderSetup(setupNotice);
      }),
      segBtn("Nobody", () => {
        attending = new Set();
        renderSetup(setupNotice);
      })
    );
    actions.append(segmented, el("span", "su-field-label", "Speaking time per person"), stepperEl());
    head.appendChild(actions);
    panel.appendChild(head);

    // The pip bar is relative to the busiest person on the roster, so it reads
    // as "who is carrying the most" rather than as progress towards a fixed
    // ceiling nobody agreed on.
    const busiest = Math.max(1, ...roster.map((m) => issuesFor(m.accountId).length));

    const list = el("div", "su-people");
    for (const member of roster) list.appendChild(personRow(member, busiest));
    panel.appendChild(list);
    return panel;
  }

  function segBtn(label, onClick) {
    const btn = el("button", "su-seg", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // One value when everyone attending is on the same clock, "Mixed" once a row
  // has been overridden — stating that plainly beats showing one person's
  // number as if it were everybody's.
  function commonDurationSec() {
    const values = attendingIds().map((id) => durations[id] ?? DEFAULT_DURATION_SEC);
    if (!values.length) return DEFAULT_DURATION_SEC;
    return values.every((v) => v === values[0]) ? values[0] : null;
  }

  function stepperEl() {
    const current = commonDurationSec();
    const stepper = el("div", "su-stepper");

    // Stepping from a mixed state flattens it, which is the point of a control
    // labelled "per person" — it is the way back to one number for everyone.
    const bump = (delta) => {
      const base = current ?? DEFAULT_DURATION_SEC;
      const next = clampDuration(base + delta * 60);
      for (const member of roster) durations[member.accountId] = next;
      renderSetup(setupNotice);
    };

    const minus = el("button", "su-step-btn", "−");
    minus.title = "One minute less for everyone";
    minus.addEventListener("click", () => bump(-1));

    const plus = el("button", "su-step-btn", "+");
    plus.title = "One minute more for everyone";
    plus.addEventListener("click", () => bump(1));

    const value = el(
      "span",
      "su-step-value",
      current === null ? "Mixed" : `${Math.round(current / 60)} min`
    );
    stepper.append(minus, value, plus);
    return stepper;
  }

  const MIN_OPTIONS = [1, 2, 3, 4, 5, 7, 10, 15, 20];

  function personRow(member, busiest) {
    const id = member.accountId;
    const row = el("div", "su-person" + (attending.has(id) ? " in" : ""));

    const box = el("input", "su-check");
    box.type = "checkbox";
    box.checked = attending.has(id);
    box.setAttribute("aria-label", `Include ${memberLabel(member)}`);
    const toggle = (on) => {
      if (on) attending.add(id);
      else attending.delete(id);
      renderSetup(setupNotice);
    };
    box.addEventListener("change", () => toggle(box.checked));
    // The whole row is the hit target, minus the two controls that own their
    // own clicks — a <label> wrapper cannot do that, because opening the select
    // would toggle attendance.
    row.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest(".su-mins")) return;
      toggle(!box.checked);
    });
    row.appendChild(box);

    row.appendChild(avatarEl(id, memberLabel(member)));
    row.appendChild(el("span", "su-person-name", memberLabel(member)));

    const n = issuesFor(id).length;
    const count = el("span", "su-person-items mono", `${n} sprint ${plural(n, "item")}`);
    if (!n) count.classList.add("none");
    row.append(count, pipsEl(n, busiest));

    row.appendChild(jiraCell(jiraStatsFor(id)));
    row.appendChild(githubCell(githubStatsFor(id)));

    const flag = flagFor(id);
    const tone = flag.count === 0 ? "ok" : flag.count === 1 ? "warn" : "bad";
    const flagCell = el("span", `su-person-flag ${tone}`);
    const flagIcon = { ok: "check", warn: "alert", bad: "ban" }[tone];
    flagCell.append(icon(flagIcon, 15), el("span", null, flag.label));
    row.appendChild(flagCell);

    row.appendChild(minsSelect(id, memberLabel(member)));
    return row;
  }

  // The Jira half of the same row: what this person did to tickets this sprint,
  // as against the GitHub cell's what they pushed. Built exactly like it so the
  // two read as one table rather than two bolted together.
  function jiraCell(stats) {
    const cell = el("span", "su-person-jira mono");
    if (!stats) {
      cell.classList.add("absent");
      cell.textContent = "—";
      cell.title = "No issue history for this sprint — this site did not return any.";
      return cell;
    }
    // No mark at all, unlike the GitHub cell's. That one names an external
    // source; these numbers come from the same Jira every other column on this
    // row already does, and a glyph at this size read as a stray bullet. The
    // GitHub mark to the right is what separates the two clusters.
    for (const spec of jiraStatSpecs(stats)) {
      const stat = el("span", `su-jira-stat ${spec.key}`);
      stat.title = spec.title;
      const shown = spec.value === null ? "—" : String(spec.value);
      const num = el("span", "su-jira-num" + (spec.value ? " on" : ""), shown);
      if (spec.value === null) num.classList.add("absent");
      stat.append(num, el("span", "su-jira-key", spec.short));
      cell.appendChild(stat);
    }
    return cell;
  }

  // Four numbers in one cell, each with the word it means underneath rather than
  // a legend somewhere else on the screen.
  function githubCell(stats) {
    const cell = el("span", "su-person-gh mono");
    if (!stats) {
      cell.classList.add("absent");
      cell.textContent = "—";
      cell.title = githubAbsentReason();
      return cell;
    }
    cell.appendChild(icon("github", 13));
    for (const spec of statSpecs(stats)) {
      const stat = el("span", `su-gh-stat ${spec.key}`);
      stat.title = spec.title;
      const shown = spec.text ?? (spec.value === null ? "—" : String(spec.value));
      const num = el("span", "su-gh-num" + (spec.value ? " on" : ""), shown);
      if (spec.value === null) num.classList.add("absent");
      stat.append(num, el("span", "su-gh-key", spec.short));
      cell.appendChild(stat);
    }
    return cell;
  }

  function avatarEl(accountId, label) {
    const url = avatarFor(accountId);
    if (url) {
      const img = document.createElement("img");
      img.className = "su-avatar";
      img.src = url;
      img.alt = "";
      // Swapped for initials rather than removed: dropping it would shift every
      // column on that one row.
      img.addEventListener("error", () => img.replaceWith(initialsEl(label)));
      return img;
    }
    return initialsEl(label);
  }

  function initialsEl(label) {
    const initials = String(label || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
    return el("span", "su-avatar su-avatar-fallback", initials || "?");
  }

  function pipsEl(count, busiest) {
    const total = 8;
    // Anyone with work gets at least one pip: a lone item on a busy team must
    // not render as an empty bar.
    const filled = count ? Math.max(1, Math.round((count / busiest) * total)) : 0;
    const bar = el("span", "su-pips");
    bar.title = `${count} of ${busiest} — busiest person on the roster`;
    for (let i = 0; i < total; i++) {
      bar.appendChild(el("i", "su-pip" + (i < filled ? " on" : "")));
    }
    return bar;
  }

  function minsSelect(accountId, label) {
    const select = el("select", "su-mins");
    select.title = `Minutes for ${label}`;
    const current = durations[accountId] ?? DEFAULT_DURATION_SEC;
    const minutes = Math.round(current / 60);
    // A duration set before these options existed still has to be selectable,
    // so the current value joins the list rather than being rounded away.
    const options = [...new Set([...MIN_OPTIONS, minutes])].sort((a, b) => a - b);
    for (const m of options) {
      const opt = el("option", null, `${m} min`);
      opt.value = String(m);
      if (m === minutes) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      durations[accountId] = clampDuration(Number(select.value) * 60);
      renderSetup(setupNotice);
    });
    return select;
  }

  // ── 2 & 3. Quick info and shortcuts ────────────────────────────────────────

  function infoRow() {
    const row = el("div", "su-info-row");
    row.append(quickInfoPanel(), shortcutsPanel());
    return row;
  }

  // Says which of the five things happened to the GitHub fetch, so an absent
  // panel or a row of dashes during the standup is explained here rather than
  // being a silent gap.
  function githubStatus() {
    const counts = github.activity;
    const open = counts
      ? `${counts.pullRequests.length} open ${plural(counts.pullRequests.length, "PR")} across ${counts.reached.length} ${plural(counts.reached.length, "repo")}`
      : "";
    switch (github.state) {
      case "loading":
        return {
          chip: "Loading…",
          tone: "",
          note: github.activity
            ? "Counting reviews and merges this sprint"
            : "Fetching pull requests",
        };
      case "ready":
        return { chip: "Connected", tone: "ok", note: open || "Ready" };
      case "partial": {
        // Every reason the numbers could be short, stated: an unreadable repo, a
        // repo too busy for the page cap, or the window query failing outright.
        const parts = [open].filter(Boolean);
        const unreachable =
          (counts?.failures?.length || 0) + (github.stats?.failures?.length || 0);
        if (unreachable) {
          parts.push(`${unreachable} ${plural(unreachable, "repo")} unreachable`);
        }
        if (github.stats?.truncated?.length) {
          parts.push(
            `sprint counts capped in ${github.stats.truncated.join(", ")}`
          );
        }
        if (github.statsError) parts.push(`no sprint counts (${github.statsError})`);
        if (!github.activity) parts.push("no pull-request list");
        return {
          chip: "Partial",
          tone: "warn",
          note: parts.join(" · ") || "Some repos unreachable",
        };
      }
      case "error":
        return {
          chip: "Unavailable",
          tone: "bad",
          note: `${github.error || github.statsError} — the standup runs without it`,
        };
      default:
        return { chip: "Off", tone: "", note: "Add repos in Settings → GitHub" };
    }
  }

  function quickInfoPanel() {
    const panel = el("section", "su-panel");
    panel.appendChild(panelHead(2, "Quick info", "Everything you need to know"));

    const cards = el("div", "su-cards");

    const status = githubStatus();
    const gh = el("div", "su-card");
    const ghHead = el("div", "su-card-head");
    const ghMark = el("span", "su-card-icon");
    ghMark.appendChild(icon("github", 20));
    ghHead.append(
      ghMark,
      el("span", "su-card-title", "GitHub"),
      el("span", `su-chip ${status.tone}`, status.chip)
    );
    gh.append(ghHead, el("div", "su-card-note", status.note));
    cards.appendChild(gh);

    // A label, so the click target is the whole card rather than a 14px box.
    const sound = el("label", "su-card");
    const soundHead = el("div", "su-card-head");
    const soundMark = el("span", "su-card-icon");
    soundMark.appendChild(icon("sound", 20));
    const soundBox = el("input", "su-switch");
    soundBox.type = "checkbox";
    soundBox.checked = !sfx.isMuted();
    const soundNote = el(
      "div",
      "su-card-note",
      soundBox.checked ? "You'll hear a chime on time up" : "Timers run silently"
    );
    soundBox.addEventListener("change", async () => {
      await sfx.setMuted(!soundBox.checked);
      soundNote.textContent = soundBox.checked
        ? "You'll hear a chime on time up"
        : "Timers run silently";
    });
    soundHead.append(soundMark, el("span", "su-card-title", "Sound cues"), soundBox);
    sound.append(soundHead, soundNote);
    cards.appendChild(sound);

    panel.appendChild(cards);
    return panel;
  }

  function shortcutsPanel() {
    const panel = el("section", "su-panel");
    panel.appendChild(panelHead(3, "Keyboard shortcuts", "During the standup"));

    const keys = el("div", "su-keys");
    for (const [key, what] of [["Space", "Pause / Resume"], ["→", "Next speaker"], ["Esc", "End session"]]) {
      const cell = el("div", "su-key-cell");
      cell.append(el("kbd", "su-kbd", key), el("span", "su-key-what", what));
      keys.appendChild(cell);
    }
    panel.appendChild(keys);
    return panel;
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  function startRow() {
    const row = el("div", "su-start-row");
    const start = el("button", "su-start");
    start.append(icon("play", 18), el("span", null, "Start Standup"));
    // Enter does the same thing. No caption for it: the disabled state says
    // "nobody selected" on its own, and a line of chrome under the one button
    // on the screen was earning nothing.
    start.disabled = attendingIds().length === 0;
    start.addEventListener("click", startNow);
    row.appendChild(start);
    return row;
  }

  async function startNow() {
    const ids = attendingIds();
    if (!ids.length) return;
    // Inside the gesture handler, so the audio policy is satisfied here.
    await sfx.unlock();
    await savePrefs({ attendance: ids, durations });
    beginSession(ids);
  }

  function bulkBtn(label, onClick) {
    const btn = document.createElement("button");
    btn.className = "standup-btn small ghost";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ── Running ────────────────────────────────────────────────────────────────

  function beginSession(ids) {
    const participants = ids.map((id) => ({ accountId: id }));
    // Date.now() is the seed source, so each standup gets a fresh order while
    // remaining reproducible for a resume.
    session = createSession({
      participants,
      durations,
      seed: Date.now() % 2147483647,
      now: Date.now(),
    });
    countdownCuePlayed = false;
    sfx.play("start");
    saveSession(session);
    requestFullscreen();
    renderRunning();
    startTicker();
  }

  function requestFullscreen() {
    if (document.fullscreenElement) return;
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  function startTicker() {
    stopTicker();
    // 200ms keeps the clock visually smooth; the value shown is always computed
    // from timestamps, so a throttled tab catches up rather than falling behind.
    ticker = setInterval(tick, 200);
    tick();
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function tick() {
    if (!session) return;
    const now = Date.now();

    if (shouldAutoAdvance(session, now)) {
      goNext();
      return;
    }

    // Countdown cue timed to finish exactly as the clock hits zero.
    if (session.phase === PHASES.SPEAKING && !isPaused(session) && !countdownCuePlayed) {
      const remaining = phaseRemainingMs(session, now);
      const lead = Math.min(sfx.countdownLeadMs(), phaseTotalMs(session));
      if (remaining > 0 && remaining <= lead) {
        countdownCuePlayed = true;
        sfx.play("countdown");
      }
    }

    paintClock(now);
  }

  function goNext() {
    if (!session) return;
    const now = Date.now();
    session = advance(session, now);
    countdownCuePlayed = false;
    sfx.stop("countdown");
    saveSession(session);

    if (session.phase === PHASES.DONE) {
      stopTicker();
      exitFullscreen();
      renderSummary();
      clearSession();
      return;
    }
    renderRunning();
  }

  function endEarly() {
    if (!session) return;
    session = finish(session, Date.now());
    stopTicker();
    sfx.stopAll();
    exitFullscreen();
    renderSummary();
    clearSession();
  }

  function renderRunning() {
    document.body.dataset.standupActive = "1";
    wrap.className = "standup-wrap standup-stage";
    wrap.innerHTML = "";

    if (session.phase === PHASES.COUNTDOWN) {
      wrap.appendChild(renderCountdown());
    } else if (session.phase === PHASES.HANDOFF) {
      wrap.appendChild(renderHandoff());
    } else {
      wrap.appendChild(renderSpeaking());
    }
    paintClock(Date.now());
  }

  function renderCountdown() {
    const el = document.createElement("div");
    el.className = "standup-interstitial";
    const label = document.createElement("div");
    label.className = "standup-interstitial-label mono";
    label.textContent = "STARTING IN";
    const clock = document.createElement("div");
    clock.className = "standup-bigcount";
    clock.id = "standup-clock";
    el.append(label, clock);

    const first = document.createElement("div");
    first.className = "standup-interstitial-name";
    first.textContent = `First up: ${labelFor(currentId(session))}`;
    el.appendChild(first);
    return el;
  }

  function renderHandoff() {
    const upcoming = session.order[session.index + 1];
    const el = document.createElement("div");
    el.className = "standup-interstitial standup-handoff";

    const label = document.createElement("div");
    label.className = "standup-interstitial-label mono handoff";
    label.textContent = handoffPhrase(session);
    el.appendChild(label);

    const avatarUrl = avatarFor(upcoming);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.className = "standup-handoff-avatar";
      img.src = avatarUrl;
      img.alt = "";
      img.addEventListener("error", () => img.remove());
      el.appendChild(img);
    }

    const name = document.createElement("div");
    name.className = "standup-handoff-name";
    name.textContent = labelFor(upcoming);
    el.appendChild(name);

    const clock = document.createElement("div");
    clock.className = "standup-handoff-clock mono";
    clock.id = "standup-clock";
    el.appendChild(clock);
    return el;
  }

  function renderSpeaking() {
    const id = currentId(session);
    const el = document.createElement("div");
    el.className = "standup-speaking";

    const bar = document.createElement("div");
    bar.className = "standup-bar";

    const who = document.createElement("div");
    who.className = "standup-who";
    const avatarUrl = avatarFor(id);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.className = "standup-avatar big";
      img.src = avatarUrl;
      img.alt = "";
      img.addEventListener("error", () => img.remove());
      who.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "standup-who-name";
    name.textContent = labelFor(id);
    who.appendChild(name);
    const position = document.createElement("span");
    position.className = "standup-position mono";
    position.textContent = `${session.index + 1} / ${session.order.length}`;
    who.appendChild(position);
    bar.appendChild(who);

    const clock = document.createElement("div");
    clock.className = "standup-clock mono";
    clock.id = "standup-clock";
    bar.appendChild(clock);

    // Facilitator controls, driven from across the room — deliberately larger
    // than the small buttons used on the setup card.
    const controls = document.createElement("div");
    controls.className = "standup-controls";
    controls.append(
      ctrlBtn("+1 min", () => {
        session = addTime(session, 60);
        saveSession(session);
        paintClock(Date.now());
      }),
      ctrlBtn(isPaused(session) ? "Resume" : "Pause", () => togglePauseNow(), "standup-pause"),
      ctrlBtn(nextId(session) ? "Next →" : "Finish", () => goNext(), "primary"),
      ctrlBtn("End", () => endEarly(), "ghost")
    );
    bar.appendChild(controls);
    el.appendChild(bar);

    const progress = document.createElement("div");
    progress.className = "standup-progress";
    // Bottom edge of the stage's top chrome: the issue drawer opens below it so
    // the speaker's name and clock stay on screen.
    progress.dataset.drawerTop = "";
    const fill = document.createElement("div");
    fill.className = "standup-progress-fill";
    fill.id = "standup-progress-fill";
    progress.appendChild(fill);
    el.appendChild(progress);

    // The board and the GitHub panel share the stage: tickets on the left,
    // "what have you got in review" on the right, which is the half of the
    // answer the board cannot give.
    const work = document.createElement("div");
    work.className = "standup-work";

    const mine = issuesFor(id);
    if (!mine.length) {
      speakingBoard = null;
      const empty = document.createElement("div");
      empty.className = "standup-empty";
      empty.textContent = "Nothing assigned in the current sprint.";
      work.appendChild(empty);
    } else {
      const boardWrap = document.createElement("div");
      boardWrap.className = "standup-board kanban-board";
      speakingBoard = boardWrap;
      paintSpeakingBoard(id);
      work.appendChild(boardWrap);
    }

    // Jira activity first, GitHub second: this one needs no credential and no
    // roster entry, so it is the panel that is there for everybody.
    const jiraPanel = renderJiraActivityPanel(id);
    if (jiraPanel) work.appendChild(jiraPanel);

    const panel = renderGithubPanel(id);
    if (panel) work.appendChild(panel);
    el.appendChild(work);

    // One parking lot per speaker: the box is theirs, so it comes up empty for
    // the next person and the end screen can address each note to someone.
    const notes = document.createElement("div");
    notes.className = "standup-parking";
    // …and its bottom chrome, so a note can still be typed with an issue open.
    notes.dataset.drawerBottom = "";
    const notesLabel = document.createElement("label");
    notesLabel.className = "standup-parking-label mono";
    notesLabel.textContent = `Parking lot — ${labelFor(id)}`;
    const notesInput = document.createElement("textarea");
    notesInput.className = "standup-parking-input";
    notesInput.rows = 4;
    notesInput.placeholder = `Anything to pick up with ${labelFor(id)} after standup…`;
    notesInput.value = session.notesByPerson?.[id] || "";
    notesInput.addEventListener("input", () => {
      session = {
        ...session,
        notesByPerson: { ...session.notesByPerson, [id]: notesInput.value },
      };
      saveSession(session);
    });
    notes.append(notesLabel, notesInput);
    el.appendChild(notes);

    return el;
  }

  // Standup is where a card's status is most often wrong — someone says "that's
  // actually done" while their board is on screen. The same drag-between-columns
  // the Kanban view has, so the fix happens in the meeting rather than after it.
  const moveIssue = createIssueMover({
    creds,
    getGroups: () => statusGroups,
    repaint: () => paintSpeakingBoard(),
  });

  // Called with an id from the initial render, and without one from a card drop
  // — where the session may already have moved on, or ended while the write was
  // in flight, so the current speaker is looked up rather than captured.
  function paintSpeakingBoard(id = session ? currentId(session) : null) {
    if (!speakingBoard || !id) return;
    renderColumns(speakingBoard, issuesFor(id), statusGroups, {
      creds,
      showAssignee: false,
      emptyLabel: "—",
      onIssueMove: moveIssue,
    });
  }

  // ── Jira activity panel ────────────────────────────────────────────────────

  // What this person did to tickets this sprint. Absent rather than apologetic
  // when the site returned no issue history, on the same principle the GitHub
  // panel follows — except this one is not gated on a credential, because the
  // data rode the request the standup already made.
  function renderJiraActivityPanel(accountId) {
    const stats = jiraStatsFor(accountId);
    if (!stats) return null;
    // Nothing to say is not worth a panel. Creations survive without history,
    // so check the figures rather than the flag.
    const anything =
      stats.created ||
      (stats.historyKnown &&
        (stats.transitions || stats.pickedUp || stats.assignedOut || stats.edits));
    if (!anything) return null;

    const panel = document.createElement("aside");
    panel.className = "standup-jira";

    const title = document.createElement("div");
    title.className = "standup-jira-title mono";
    title.textContent = "THIS SPRINT";
    panel.appendChild(title);

    panel.appendChild(jiraStatStrip(stats));

    // The tickets behind the numbers, so the panel prompts a sentence rather
    // than inviting a comparison. Capped, because this is read out loud.
    const touched = (stats.touchedIssues || []).slice(0, 8);
    if (touched.length) {
      const heading = document.createElement("div");
      heading.className = "standup-jira-heading mono";
      const total = stats.touchedIssues.length;
      heading.textContent =
        total > touched.length ? `Touched · ${touched.length} of ${total}` : `Touched · ${total}`;
      panel.appendChild(heading);

      const keys = document.createElement("div");
      keys.className = "standup-jira-keys";
      for (const key of touched) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "standup-jira-key mono";
        chip.textContent = key;
        if (stats.completedIssues.includes(key)) chip.classList.add("done");
        // The drawer, not a route: the board cards on this same screen open
        // issues that way, and a standup should not navigate away mid-turn.
        chip.addEventListener("click", () => openIssueDrawer(key, creds));
        keys.appendChild(chip);
      }
      panel.appendChild(keys);
    }

    return panel;
  }

  // Four tiles, sized to be read from across the room — the same statistics as
  // the setup row's cluster, from the same `jiraStatSpecs`.
  function jiraStatStrip(stats) {
    const strip = document.createElement("div");
    strip.className = "standup-jira-stats";
    for (const spec of jiraStatSpecs(stats)) {
      const tile = document.createElement("div");
      tile.className = `standup-jira-stat ${spec.key}`;
      tile.title = spec.title;

      const num = document.createElement("span");
      num.className = "standup-jira-stat-num mono";
      num.textContent = spec.value === null ? "—" : String(spec.value);
      if (spec.value === null) num.classList.add("absent");

      const key = document.createElement("span");
      key.className = "standup-jira-stat-key";
      key.textContent = spec.label;

      tile.append(num, key);
      strip.appendChild(tile);
    }
    return strip;
  }

  // ── GitHub panel ───────────────────────────────────────────────────────────

  // Absent rather than apologetic: with GitHub off, still loading, or failed,
  // this returns null and the stage is exactly what it was before M11.
  function renderGithubPanel(accountId) {
    if (github.state === "off" || github.state === "error") return null;

    const panel = document.createElement("aside");
    panel.className = "standup-github";

    const title = document.createElement("div");
    title.className = "standup-github-title mono";
    const mark = document.createElement("img");
    mark.className = "gh-mark";
    mark.src = "assets/logos/github.png";
    mark.alt = "";
    title.append(mark, document.createTextNode("GITHUB"));
    panel.appendChild(title);

    if (!github.activity && !github.stats) {
      const loading = document.createElement("div");
      loading.className = "standup-github-note";
      loading.textContent = "Loading…";
      panel.appendChild(loading);
      return panel;
    }

    const login = memberFor(accountId)?.githubLogin || "";
    if (!login) {
      // Sayable in one line, and fixable in Settings — better than a panel
      // that is silently empty for one person and full for everyone else.
      const note = document.createElement("div");
      note.className = "standup-github-note";
      note.textContent = "No GitHub login on the roster for this person.";
      panel.appendChild(note);
      return panel;
    }

    // The numbers first: they are the same four the setup screen showed, and
    // they are the part that answers "what have you been doing this sprint"
    // without anyone having to read a list of titles out loud.
    const stats = githubStatsFor(accountId);
    if (stats) panel.appendChild(githubStatStrip(stats));

    const mine = github.activity
      ? activityFor(github.activity, login)
      : { open: [], reviewRequests: [], merged: [], issues: [] };
    const sections = [
      ["Open PRs", mine.open, prRow],
      ["Waiting on you", mine.reviewRequests, prRow],
      ["Merged", mine.merged, mergedRow],
      ["Issues", mine.issues, issueRow],
    ].filter(([, items]) => items.length);

    if (!sections.length) {
      const note = document.createElement("div");
      note.className = "standup-github-note";
      note.textContent = github.activity
        ? "Nothing open on GitHub."
        : `Pull-request list unavailable — ${github.error}`;
      panel.appendChild(note);
      return panel;
    }

    for (const [label, items, rowFn] of sections) {
      const heading = document.createElement("div");
      heading.className = "standup-github-heading mono";
      heading.textContent = `${label} · ${items.length}`;
      panel.appendChild(heading);
      for (const item of items) panel.appendChild(rowFn(item));
    }
    return panel;
  }

  // Four tiles, sized to be read from across the room — the same statistics as
  // the setup row's cluster, from the same `statSpecs`.
  function githubStatStrip(stats) {
    const strip = document.createElement("div");
    strip.className = "standup-gh-stats";
    for (const spec of statSpecs(stats)) {
      const tile = document.createElement("div");
      tile.className = `standup-gh-stat ${spec.key}`;
      tile.title = spec.title;

      const num = document.createElement("span");
      num.className = "standup-gh-stat-num mono";
      num.textContent = spec.text ?? (spec.value === null ? "—" : String(spec.value));
      if (spec.value === null) num.classList.add("absent");

      const key = document.createElement("span");
      key.className = "standup-gh-stat-key";
      key.textContent = spec.label;

      tile.append(num, key);
      strip.appendChild(tile);
    }
    return strip;
  }

  function githubRow(item) {
    const row = document.createElement("a");
    row.className = "standup-github-row";
    row.href = item.url || "#";
    row.target = "_blank";
    row.rel = "noopener noreferrer";

    const summary = document.createElement("span");
    summary.className = "standup-github-summary";
    summary.textContent = item.title;
    row.appendChild(summary);

    const meta = document.createElement("span");
    meta.className = "standup-github-meta mono";
    row.appendChild(meta);
    return { row, meta };
  }

  function prRow(pr) {
    const { row, meta } = githubRow(pr);
    const state = document.createElement("span");
    state.className = `standup-github-state ${pr.state}`;
    state.textContent = PR_STATE_LABELS[pr.state] || pr.state;
    meta.append(
      state,
      document.createTextNode(` ${pr.repo.split("/")[1] || pr.repo} #${pr.number} · ${pr.ageDays}d`)
    );
    return row;
  }

  function mergedRow(pr) {
    const { row, meta } = githubRow(pr);
    meta.textContent = `${pr.repo.split("/")[1] || pr.repo} #${pr.number} · merged`;
    return row;
  }

  function issueRow(issue) {
    const { row, meta } = githubRow(issue);
    meta.textContent = `${issue.repo.split("/")[1] || issue.repo} #${issue.number} · ${issue.ageDays}d`;
    return row;
  }

  function ctrlBtn(label, onClick, extra = "") {
    const btn = document.createElement("button");
    btn.className = `standup-btn standup-ctrl ${extra}`.trim();
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function togglePauseNow() {
    if (!session) return;
    session = togglePause(session, Date.now());
    saveSession(session);
    renderRunning();
  }

  // Only the clock and progress bar change per tick — re-rendering the board
  // every 200ms would fight anyone trying to click a card.
  function paintClock(now) {
    const clock = document.getElementById("standup-clock");
    if (!clock || !session) return;

    if (session.phase === PHASES.COUNTDOWN || session.phase === PHASES.HANDOFF) {
      const secs = Math.max(0, Math.ceil(phaseRemainingMs(session, now) / 1000));
      clock.textContent = String(secs);
      clock.style.removeProperty("--overrun-scale");
      return;
    }

    const remaining = phaseRemainingMs(session, now);
    clock.textContent = formatClock(remaining);
    clock.classList.toggle("overrun", isOverrun(session, now));
    clock.classList.toggle("paused", isPaused(session));
    // Swells a step every five seconds of overrun. Set on every tick rather
    // than stepped up on a timer of its own, so it lands back at 1 as soon as
    // the phase does — no per-person reset to forget.
    clock.style.setProperty("--overrun-scale", overrunScale(session, now).toFixed(3));

    const fill = document.getElementById("standup-progress-fill");
    if (fill) {
      const total = phaseTotalMs(session) || 1;
      const used = Math.min(1, phaseElapsedMs(session, now) / total);
      fill.style.width = `${(used * 100).toFixed(1)}%`;
      fill.classList.toggle("overrun", isOverrun(session, now));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  function renderSummary() {
    document.body.dataset.standupActive = "";
    wrap.className = "standup-wrap";
    wrap.innerHTML = "";

    const card = document.createElement("div");
    card.className = "standup-setup";

    const title = document.createElement("h1");
    title.className = "standup-title mono done";
    title.textContent = "STANDUP = DONE";
    card.appendChild(title);

    const total = Object.values(session.actualMs || {}).reduce((a, b) => a + b, 0);
    const summary = document.createElement("p");
    summary.className = "standup-subtitle";
    summary.textContent = `${session.order.length} ${session.order.length === 1 ? "person" : "people"} · ${formatClock(total)} of speaking`;
    card.appendChild(summary);

    const list = document.createElement("div");
    list.className = "standup-people";
    for (const id of session.order) {
      const row = document.createElement("div");
      row.className = "standup-person";
      const name = document.createElement("span");
      name.className = "standup-person-name";
      name.textContent = labelFor(id);
      row.appendChild(name);

      const spent = session.actualMs?.[id];
      const planned = (session.durations[id] ?? DEFAULT_DURATION_SEC) * 1000;
      const time = document.createElement("span");
      time.className = "standup-person-count mono";
      if (spent === undefined) {
        time.textContent = "not reached";
        time.classList.add("none");
      } else {
        time.textContent = `${formatClock(spent)} of ${formatClock(planned)}`;
        if (spent > planned) time.classList.add("over");
      }
      row.appendChild(time);
      list.appendChild(row);
    }
    card.appendChild(list);

    const entries = notesEntries(session);
    if (entries.length) {
      const notesTitle = document.createElement("div");
      notesTitle.className = "standup-parking-label mono summary";
      notesTitle.textContent = "Parking lot — paste into Slack";
      card.appendChild(notesTitle);

      // A textarea rather than a <pre>: the point is to select and copy it, and
      // it stays editable so the facilitator can tidy wording before pasting.
      const digestBox = document.createElement("textarea");
      digestBox.className = "standup-digest";
      digestBox.value = slackDigest(session);
      // Sub-bullets make the line count unpredictable, so measure the text.
      digestBox.rows = Math.min(18, digestBox.value.split("\n").length + 1);
      digestBox.spellcheck = false;
      card.appendChild(digestBox);

      const missing = entries.filter((e) => !memberFor(e.id)?.slackHandle);
      if (missing.length) {
        const note = document.createElement("div");
        note.className = "standup-hint mono";
        note.textContent =
          `No Slack username for ${missing.map((e) => labelFor(e.id)).join(", ")}` +
          " — display names used instead. Add handles in Settings → Team roster.";
        card.appendChild(note);
      }

      const actions = document.createElement("div");
      actions.className = "standup-bulk";
      const copyBtn = bulkBtn("Copy message", async () => {
        if (await copyDigest(digestBox.value)) {
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy message"; }, 1500);
        } else {
          // Clipboard refused — select it instead so ctrl-C still works.
          digestBox.focus();
          digestBox.select();
        }
      });
      actions.append(copyBtn, bulkBtn("Download .txt", () => downloadNotes(session)));
      card.appendChild(actions);
    }

    const again = document.createElement("button");
    again.className = "standup-btn standup-start";
    again.textContent = "Back to setup";
    again.addEventListener("click", () => {
      session = null;
      renderSetup();
    });
    card.appendChild(again);

    wrap.appendChild(card);

    // After the card is in the DOM, so the bursts land on the finished screen
    // rather than on the one being torn down.
    confetti.celebrate();
  }

  // Dated heading for the pasted message, so a channel full of these is
  // scannable and nobody has to work out which day one refers to.
  function digestTitle(now = new Date()) {
    return `${DIGEST_EMOJI} ${DIGEST_HEADING} - ${fmtDate(now)}`;
  }

  function digestEntries(finished) {
    return notesEntries(finished).map(({ id, note }) => ({
      who: memberFor(id) ? slackMentionFor(id) : labelFor(id),
      note,
    }));
  }

  // The title is part of the digest rather than something added at copy time:
  // the textarea is editable, and what it shows has to be what lands on the
  // clipboard.
  function slackDigest(finished) {
    return digestText({
      title: digestTitle(),
      entries: digestEntries(finished),
      signoff: DIGEST_SIGNOFF,
    });
  }

  // Both flavours in one write: Slack takes the HTML and renders real bullets,
  // anything plainer takes the text. A browser without ClipboardItem still gets
  // the text, just without the formatting.
  async function copyDigest(text) {
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([digestHtml(text)], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        return true;
      }
    } catch {
      // Rich copy refused (permissions, unsupported flavour) — try plain.
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function downloadNotes(finished) {
    // No sign-off and no second date: the title is already the first line here,
    // and a file is not a Slack message.
    const lines = [
      digestTitle(),
      "",
      ...finished.order.map((id) => `- ${labelFor(id)}`),
      "",
      "Parking lot:",
      digestText({ entries: digestEntries(finished) }),
      "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `standup-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function onKeydown(e) {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) {
      return;
    }

    // On the setup screen Enter is the only key bound, and it does what the
    // button under the cursor does — the hint under it promises exactly that.
    if (!session) {
      if (e.key === "Enter") {
        e.preventDefault();
        startNow();
      }
      return;
    }
    if (session.phase === PHASES.DONE) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePauseNow();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      endEarly();
    }
  }
  document.addEventListener("keydown", onKeydown);

  // The router swaps views by replacing the container's contents, so clean up
  // the timer, the audio and the nav-key suppression when that happens.
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      stopTicker();
      sfx.stopAll();
      // The canvas is on document.body, not inside the view, so it does not go
      // with the container — it has to be torn down by hand.
      confetti.stop();
      document.body.dataset.standupActive = "";
      document.removeEventListener("keydown", onKeydown);
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });

  // The GitHub fetch was started at the top of mount, before the Jira awaits,
  // and is never awaited here. Whatever has landed by the time someone presses
  // Start is what the panel shows, and the rest fills in behind.
  mounted = true;
  renderSetup();
  githubFetch?.then(repaintGithub);
}
