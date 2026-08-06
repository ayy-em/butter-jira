import { getAllSprintIssues } from "../api.js";
import { loadStatusGroups } from "../utils.js";
import { activeMembers, memberLabel, memberFor } from "../team.js";
import { renderColumns } from "../components/board.js";
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
  isOverrun,
  isPaused,
  loadPrefs,
  loadSession,
  nextId,
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
        window.open(chrome.runtime.getURL("settings.html"))
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

    card.appendChild(muteToggle());
    wrap.appendChild(card);
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
    label.className = "standup-interstitial-label mono";
    label.textContent = "GET READY";
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

    const controls = document.createElement("div");
    controls.className = "standup-controls";
    controls.append(
      ctrlBtn("+1 min", () => {
        session = addTime(session, 60);
        saveSession(session);
        paintClock(Date.now());
      }),
      ctrlBtn(isPaused(session) ? "Resume" : "Pause", () => togglePauseNow(), "standup-pause"),
      ctrlBtn(nextId(session) ? "Next →" : "Finish", () => goNext()),
      ctrlBtn("End", () => endEarly(), "ghost")
    );
    bar.appendChild(controls);
    el.appendChild(bar);

    const progress = document.createElement("div");
    progress.className = "standup-progress";
    const fill = document.createElement("div");
    fill.className = "standup-progress-fill";
    fill.id = "standup-progress-fill";
    progress.appendChild(fill);
    el.appendChild(progress);

    const boardWrap = document.createElement("div");
    boardWrap.className = "standup-board kanban-board";
    const mine = issuesFor(id);
    if (!mine.length) {
      const empty = document.createElement("div");
      empty.className = "standup-empty";
      empty.textContent = "Nothing assigned in the current sprint.";
      el.appendChild(empty);
    } else {
      renderColumns(boardWrap, mine, statusGroups, {
        creds,
        showAssignee: false,
        emptyLabel: "—",
      });
      el.appendChild(boardWrap);
    }

    const notes = document.createElement("div");
    notes.className = "standup-parking";
    const notesLabel = document.createElement("label");
    notesLabel.className = "standup-parking-label mono";
    notesLabel.textContent = "Parking lot";
    const notesInput = document.createElement("textarea");
    notesInput.className = "standup-parking-input";
    notesInput.rows = 2;
    notesInput.placeholder = "Anything to pick up after standup…";
    notesInput.value = session.notes || "";
    notesInput.addEventListener("input", () => {
      session = { ...session, notes: notesInput.value };
      saveSession(session);
    });
    notes.append(notesLabel, notesInput);
    el.appendChild(notes);

    return el;
  }

  function ctrlBtn(label, onClick, extra = "") {
    const btn = document.createElement("button");
    btn.className = `standup-btn small ${extra}`.trim();
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
    title.className = "standup-title mono";
    title.textContent = "STANDUP DONE";
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

    if ((session.notes || "").trim()) {
      const notesTitle = document.createElement("div");
      notesTitle.className = "standup-parking-label mono";
      notesTitle.textContent = "Parking lot";
      const notes = document.createElement("pre");
      notes.className = "standup-notes-out";
      notes.textContent = session.notes.trim();
      card.append(notesTitle, notes);

      const actions = document.createElement("div");
      actions.className = "standup-bulk";
      actions.append(
        bulkBtn("Copy notes", async () => {
          try {
            await navigator.clipboard.writeText(session.notes.trim());
          } catch {
            /* clipboard refused — the text is on screen to copy by hand */
          }
        }),
        bulkBtn("Download .txt", () => downloadNotes(session))
      );
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
  }

  function downloadNotes(finished) {
    const lines = [
      `Standup notes — ${new Date().toISOString().slice(0, 10)}`,
      "",
      ...finished.order.map((id) => `- ${labelFor(id)}`),
      "",
      "Parking lot:",
      finished.notes.trim(),
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
      document.body.dataset.standupActive = "";
      document.removeEventListener("keydown", onKeydown);
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });

  renderSetup();
}
