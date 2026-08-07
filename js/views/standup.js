import { runtimeUrl } from "../browser.js";
import { getAllSprintIssues } from "../api.js";
import { fmtDate, loadStatusGroups } from "../utils.js";
import {
  activeMembers,
  avatarOverrideFor,
  memberLabel,
  memberFor,
  slackMentionFor,
} from "../team.js";
import {
  PR_STATE_LABELS,
  activityFor,
  getTeamActivity,
  isGithubConfigured,
} from "../github.js";
import * as confetti from "../confetti.js";
import { renderColumns } from "../components/board.js";
import { createIssueMover } from "../issue-move.js";
import * as sfx from "../sfx.js";
import {
  DEFAULT_DURATION_SEC,
  PHASES,
  addTime,
  advance,
  clampDuration,
  clearSession,
  createSession,
  currentId,
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
  phaseElapsedMs,
  phaseRemainingMs,
  phaseTotalMs,
  plannedTotalSec,
  savePrefs,
  saveSession,
  shouldAutoAdvance,
  togglePause,
} from "../standup.js";

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  const [sprintIssues, statusGroups, prefs, resumable] = await Promise.all([
    getAllSprintIssues(creds),
    loadStatusGroups(),
    loadPrefs(),
    loadSession(),
  ]);
  await sfx.loadMuted();
  sfx.preload();

  const roster = activeMembers();
  let session = null;
  let ticker = null;
  let countdownCuePlayed = false;

  // GitHub is a second, optional source and is never on the critical path: the
  // fetch is kicked off when the setup screen appears, the standup starts
  // whether or not it has landed, and any failure leaves the panel absent
  // rather than blocking a view. `github.state` is what the setup chip reports.
  const github = { state: "off", activity: null, error: "" };
  let githubPending = null;

  function startGithubFetch() {
    if (!isGithubConfigured()) {
      github.state = "off";
      return null;
    }
    github.state = "loading";
    githubPending = getTeamActivity()
      .then((activity) => {
        github.activity = activity;
        github.state = activity.failures.length ? "partial" : "ready";
        return activity;
      })
      .catch((err) => {
        github.state = "error";
        github.error = String(err?.message || err);
        return null;
      });
    return githubPending;
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

  function renderSetup(notice = "") {
    stopTicker();
    document.body.dataset.standupActive = "";
    wrap.className = "standup-wrap";
    wrap.innerHTML = "";

    const card = document.createElement("div");
    card.className = "standup-setup";

    const title = document.createElement("h1");
    title.className = "standup-title mono";
    title.textContent = "DAILY STANDUP";
    card.appendChild(title);

    if (!roster.length) {
      const empty = document.createElement("p");
      empty.className = "standup-note";
      empty.textContent =
        "No team roster yet. Add people in Settings → Team roster, then come back.";
      card.appendChild(empty);
      const openSettings = document.createElement("button");
      openSettings.className = "standup-btn";
      openSettings.textContent = "Open Settings";
      openSettings.addEventListener("click", () =>
        window.open(runtimeUrl("settings.html"))
      );
      card.appendChild(openSettings);
      wrap.appendChild(card);
      return;
    }

    if (resumable && !notice) {
      card.appendChild(renderResumeBanner());
    }
    if (notice) {
      const note = document.createElement("div");
      note.className = "standup-note";
      note.textContent = notice;
      card.appendChild(note);
    }

    const subtitle = document.createElement("p");
    subtitle.className = "standup-subtitle";
    subtitle.textContent = "Who's in today?";
    card.appendChild(subtitle);

    const bulk = document.createElement("div");
    bulk.className = "standup-bulk";
    bulk.append(
      bulkBtn("All in", () => {
        attending = new Set(roster.map((m) => m.accountId));
        renderSetup();
      }),
      bulkBtn("None", () => {
        attending = new Set();
        renderSetup();
      })
    );
    const setAllWrap = document.createElement("label");
    setAllWrap.className = "standup-setall";
    setAllWrap.append("Set all to ");
    const setAllInput = document.createElement("input");
    setAllInput.type = "number";
    setAllInput.min = "1";
    setAllInput.value = "2";
    setAllInput.className = "standup-mins-input";
    setAllWrap.appendChild(setAllInput);
    setAllWrap.append(" min");
    const setAllBtn = bulkBtn("Apply", () => {
      const secs = clampDuration(Number(setAllInput.value) * 60);
      for (const id of attending) durations[id] = secs;
      renderSetup();
    });
    bulk.append(setAllWrap, setAllBtn);
    card.appendChild(bulk);

    const list = document.createElement("div");
    list.className = "standup-people";
    for (const member of roster) {
      list.appendChild(personRow(member));
    }
    card.appendChild(list);

    const attendingIds = roster
      .map((m) => m.accountId)
      .filter((id) => attending.has(id));

    const totals = document.createElement("div");
    totals.className = "standup-totals";
    if (attendingIds.length) {
      const speakSec = plannedTotalSec(attendingIds, durations);
      const wallSec = estimatedWallSec(attendingIds, durations);
      totals.textContent =
        `${attendingIds.length} ${attendingIds.length === 1 ? "person" : "people"} · ` +
        `${Math.round(speakSec / 60)} min speaking · ~${Math.ceil(wallSec / 60)} min total`;
    } else {
      totals.textContent = "Nobody selected yet.";
    }
    card.appendChild(totals);

    const start = document.createElement("button");
    start.className = "standup-btn standup-start";
    start.textContent = "Start standup";
    start.disabled = attendingIds.length === 0;
    start.addEventListener("click", async () => {
      // Inside the gesture handler, so the audio policy is satisfied here.
      await sfx.unlock();
      await savePrefs({ attendance: attendingIds, durations });
      beginSession(attendingIds);
    });
    card.appendChild(start);

    const hint = document.createElement("div");
    hint.className = "standup-hint mono";
    hint.textContent = "Space pauses · → next person · Esc ends";
    card.appendChild(hint);

    if (github.state !== "off") card.appendChild(githubChip());
    card.appendChild(muteToggle());
    wrap.appendChild(card);
  }

  // Says which of the four things happened to the GitHub fetch, so a missing
  // panel is explained on the setup card rather than being a silent absence.
  function githubChip() {
    const chip = document.createElement("div");
    chip.className = "standup-github-chip mono";
    chip.id = "standup-github-chip";
    paintGithubChip(chip);
    return chip;
  }

  function paintGithubChip(target = document.getElementById("standup-github-chip")) {
    if (!target) return;
    const counts = github.activity;
    const text = {
      off: "",
      loading: "GitHub — loading pull requests…",
      ready: counts
        ? `GitHub — ${counts.pullRequests.length} open PR${counts.pullRequests.length === 1 ? "" : "s"} across ${counts.reached.length} repo${counts.reached.length === 1 ? "" : "s"}`
        : "GitHub — ready",
      partial: counts
        ? `GitHub — ${counts.pullRequests.length} open PRs, ${counts.failures.length} repo${counts.failures.length === 1 ? "" : "s"} unreachable`
        : "GitHub — partial",
      error: `GitHub unavailable — ${github.error}. Standup runs without it.`,
    }[github.state];
    target.textContent = text || "";
    target.classList.toggle("warn", github.state === "partial");
    target.classList.toggle("bad", github.state === "error");
  }

  function renderResumeBanner() {
    const banner = document.createElement("div");
    banner.className = "standup-resume";
    const text = document.createElement("span");
    const done = resumable.index;
    text.textContent = `Unfinished standup: ${done + 1} of ${resumable.order.length}. Same order as before.`;
    banner.appendChild(text);

    const resumeBtn = document.createElement("button");
    resumeBtn.className = "standup-btn small";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", async () => {
      await sfx.unlock();
      session = resumable;
      renderRunning();
      startTicker();
    });
    banner.appendChild(resumeBtn);

    const discard = document.createElement("button");
    discard.className = "standup-btn small ghost";
    discard.textContent = "Discard";
    discard.addEventListener("click", async () => {
      await clearSession();
      renderSetup("Previous session discarded.");
    });
    banner.appendChild(discard);
    return banner;
  }

  function bulkBtn(label, onClick) {
    const btn = document.createElement("button");
    btn.className = "standup-btn small ghost";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function personRow(member) {
    const id = member.accountId;
    const row = document.createElement("label");
    row.className = "standup-person" + (attending.has(id) ? " in" : "");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = attending.has(id);
    box.addEventListener("change", () => {
      if (box.checked) attending.add(id);
      else attending.delete(id);
      renderSetup();
    });
    row.appendChild(box);

    const avatarUrl = avatarFor(id);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.className = "standup-avatar";
      img.src = avatarUrl;
      img.alt = "";
      img.addEventListener("error", () => img.remove());
      row.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "standup-person-name";
    name.textContent = memberLabel(member);
    row.appendChild(name);

    const count = document.createElement("span");
    count.className = "standup-person-count mono";
    const n = issuesFor(id).length;
    count.textContent = `${n} in sprint`;
    if (!n) count.classList.add("none");
    row.appendChild(count);

    const mins = document.createElement("input");
    mins.type = "number";
    mins.min = "1";
    mins.className = "standup-mins-input";
    mins.value = Math.round((durations[id] ?? DEFAULT_DURATION_SEC) / 60);
    mins.title = "Minutes for this person";
    mins.addEventListener("change", () => {
      durations[id] = clampDuration(Number(mins.value) * 60);
      renderSetup();
    });
    mins.addEventListener("click", (e) => e.preventDefault());
    row.appendChild(mins);

    return row;
  }

  function muteToggle() {
    const label = document.createElement("label");
    label.className = "standup-mute";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !sfx.isMuted();
    box.addEventListener("change", async () => {
      await sfx.setMuted(!box.checked);
    });
    label.append(box, document.createTextNode(" Sound cues"));
    return label;
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

  // ── GitHub panel ───────────────────────────────────────────────────────────

  // Absent rather than apologetic: with GitHub off, still loading, or failed,
  // this returns null and the stage is exactly what it was before M11.
  function renderGithubPanel(accountId) {
    if (github.state === "off" || github.state === "error") return null;

    const panel = document.createElement("aside");
    panel.className = "standup-github";

    const title = document.createElement("div");
    title.className = "standup-github-title mono";
    title.textContent = "GITHUB";
    panel.appendChild(title);

    if (github.state === "loading" || !github.activity) {
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

    const mine = activityFor(github.activity, login);
    const sections = [
      ["Open PRs", mine.open, prRow],
      ["Waiting on you", mine.reviewRequests, prRow],
      ["Merged", mine.merged, mergedRow],
      ["Issues", mine.issues, issueRow],
    ].filter(([, items]) => items.length);

    if (!sections.length) {
      const note = document.createElement("div");
      note.className = "standup-github-note";
      note.textContent = "Nothing open on GitHub.";
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
      return;
    }

    const remaining = phaseRemainingMs(session, now);
    clock.textContent = formatClock(remaining);
    clock.classList.toggle("overrun", isOverrun(session, now));
    clock.classList.toggle("paused", isPaused(session));

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
      // +3 for the dated title and the blank line under it.
      digestBox.rows = Math.min(14, entries.length + 3);
      digestBox.value = slackDigest(session);
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
        try {
          await navigator.clipboard.writeText(digestBox.value);
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy message"; }, 1500);
        } catch {
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
    return `Daily Standup Action Points - ${fmtDate(now)}`;
  }

  // "@handle - note" per person, one line each, ready to paste into Slack.
  // Multi-line notes are joined with "; " so one person is always one line.
  function digestBody(finished) {
    return notesEntries(finished)
      .map(({ id, note }) => {
        const who = memberFor(id) ? slackMentionFor(id) : labelFor(id);
        return `${who} - ${note.replace(/\s*\n+\s*/g, "; ")}`;
      })
      .join("\n");
  }

  // The title is part of the digest rather than something added at copy time:
  // the textarea is editable, and what it shows has to be what lands on the
  // clipboard.
  function slackDigest(finished) {
    return `${digestTitle()}\n\n${digestBody(finished)}`;
  }

  function downloadNotes(finished) {
    // digestBody, not slackDigest: the title is already the first line here, and
    // printing the date twice in one file reads as a bug.
    const lines = [
      digestTitle(),
      "",
      ...finished.order.map((id) => `- ${labelFor(id)}`),
      "",
      "Parking lot:",
      digestBody(finished),
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
    if (!session || session.phase === PHASES.DONE) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

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

  // Kicked off before the first paint — the state flips to "loading"
  // synchronously, so the setup card renders with its status line already
  // there — but never awaited. Whatever has landed by the time someone presses
  // Start is what the panel shows, and the rest fills in behind.
  const githubFetch = startGithubFetch();
  renderSetup();
  githubFetch?.then(() => {
    paintGithubChip();
    // A person already on screen when the fetch lands gets their panel without
    // waiting for the next hand-off.
    if (session?.phase === PHASES.SPEAKING) renderRunning();
  });
}
