import { localGet, localSet, runtimeUrl } from "../browser.js";
import { getAllBacklogIssues, getAllSprintIssues } from "../api.js";
import { assigneeLabel, boardColor, boardName, fmtDate, getStoryPoints } from "../utils.js";
import { CONFIG } from "../config.js";
import { hasRoster, isOutsideTeam, isTeamOnly, setTeamOnly } from "../team.js";
import { attachIssueOpener } from "../components/issue-detail.js";
import {
  runChecks,
  setBadgeCount,
  totalFindings,
  worstOffenders,
} from "../monitor.js";
import { updateMonitorBadge } from "../components/nav.js";

const SCOPE_KEY = "monitorScope";

async function loadScope() {
  const stored = await localGet(SCOPE_KEY);
  return stored[SCOPE_KEY] === "all" ? "all" : "sprint";
}

async function saveScope(scope) {
  await localSet({ [SCOPE_KEY]: scope });
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  let scope = await loadScope();
  const sprintIssues = await getAllSprintIssues(creds);
  // Only fetched when the wider scope is actually asked for.
  let backlogIssues = scope === "all" ? await getAllBacklogIssues(creds) : null;
  let teamOnly = hasRoster() ? isTeamOnly() : false;
  let collapsed = new Set();

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "monitor-wrap";

  const controls = document.createElement("div");
  controls.className = "monitor-controls";
  const controlsLeft = document.createElement("div");
  controlsLeft.className = "monitor-controls-left";
  const controlsCenter = document.createElement("div");
  controlsCenter.className = "monitor-controls-center";
  const controlsRight = document.createElement("div");
  controlsRight.className = "monitor-controls-right";
  controls.append(controlsLeft, controlsCenter, controlsRight);
  wrap.appendChild(controls);

  const summary = document.createElement("div");
  summary.className = "monitor-summary";
  wrap.appendChild(summary);

  const sectionsEl = document.createElement("div");
  sectionsEl.className = "monitor-sections";
  wrap.appendChild(sectionsEl);

  container.appendChild(wrap);

  // A switch rather than a button: with one label on each side it is obvious
  // which scope is in effect, where a single button only showed what a click
  // would do next.
  const scopeSwitch = document.createElement("div");
  scopeSwitch.className = "scope-switch";

  const sprintLabel = document.createElement("button");
  sprintLabel.className = "scope-switch-label mono";
  sprintLabel.textContent = "Current Sprint";
  sprintLabel.title = "Check the active sprint only";

  const scopeTrack = document.createElement("button");
  scopeTrack.className = "scope-switch-track";
  scopeTrack.setAttribute("role", "switch");
  scopeTrack.setAttribute("aria-label", "Include the backlog");
  scopeTrack.title = "Current Sprint checks the active sprint only. All Issues adds the backlog.";
  const scopeKnob = document.createElement("span");
  scopeKnob.className = "scope-switch-knob";
  scopeTrack.appendChild(scopeKnob);

  const allLabel = document.createElement("button");
  allLabel.className = "scope-switch-label mono";
  allLabel.textContent = "All Issues";
  allLabel.title = "Check the active sprint plus the backlog";

  scopeSwitch.append(sprintLabel, scopeTrack, allLabel);
  controlsCenter.appendChild(scopeSwitch);

  async function setScope(next) {
    if (next === scope) return;
    scope = next;
    await saveScope(scope);
    // The backlog is only fetched the first time the wider scope is asked for.
    if (scope === "all" && !backlogIssues) {
      scopeTrack.disabled = true;
      sectionsEl.innerHTML = '<div class="spinner" style="height:160px"></div>';
      try {
        backlogIssues = await getAllBacklogIssues(creds);
      } finally {
        scopeTrack.disabled = false;
      }
    }
    render();
  }

  scopeTrack.addEventListener("click", () =>
    setScope(scope === "sprint" ? "all" : "sprint")
  );
  sprintLabel.addEventListener("click", () => setScope("sprint"));
  allLabel.addEventListener("click", () => setScope("all"));

  if (hasRoster()) {
    const teamBtn = document.createElement("button");
    teamBtn.className = "filter-toggle mono";
    teamBtn.title = "Hide findings assigned outside the team roster. Unassigned issues stay visible.";
    teamBtn.addEventListener("click", async () => {
      teamOnly = !teamOnly;
      await setTeamOnly(teamOnly);
      render();
    });
    controlsLeft.appendChild(teamBtn);
    controls._teamBtn = teamBtn;
  }

  const settingsLink = document.createElement("button");
  settingsLink.className = "monitor-settings-link mono";
  settingsLink.textContent = "Configure checks";
  settingsLink.title = "Mute individual checks in Settings";
  settingsLink.addEventListener("click", () => {
    window.open(runtimeUrl("settings.html"));
  });
  controlsRight.appendChild(settingsLink);

  function scopedIssues() {
    const base =
      scope === "all" && backlogIssues
        ? (() => {
            const map = new Map();
            for (const i of sprintIssues) map.set(i.id, i);
            for (const i of backlogIssues) if (!map.has(i.id)) map.set(i.id, i);
            return [...map.values()];
          })()
        : sprintIssues;
    return teamOnly ? base.filter((i) => !isOutsideTeam(i)) : base;
  }

  function render() {
    scopeTrack.setAttribute("aria-checked", scope === "all" ? "true" : "false");
    sprintLabel.classList.toggle("on", scope === "sprint");
    allLabel.classList.toggle("on", scope === "all");
    if (controls._teamBtn) {
      controls._teamBtn.classList.toggle("active", teamOnly);
      controls._teamBtn.textContent = teamOnly ? "Team Only" : "Everyone";
    }

    const issues = scopedIssues();
    const sections = runChecks(issues, CONFIG.monitorChecks);
    const total = totalFindings(sections);
    setBadgeCount(total);
    updateMonitorBadge(total);

    renderSummary(sections, issues.length, total);

    sectionsEl.innerHTML = "";
    if (!sections.length) {
      const none = document.createElement("div");
      none.className = "empty-state";
      none.textContent = "Every check is muted — enable one in Settings.";
      sectionsEl.appendChild(none);
      return;
    }
    for (const section of sections) sectionsEl.appendChild(renderSection(section));
  }

  function renderSummary(sections, scanned, total) {
    summary.innerHTML = "";

    const headline = document.createElement("div");
    headline.className = "monitor-headline";
    if (!total) {
      headline.classList.add("clean");
      headline.textContent = `Nothing to fix — ${scanned} issue${scanned === 1 ? "" : "s"} checked.`;
    } else {
      headline.textContent = `${total} finding${total === 1 ? "" : "s"} across ${scanned} issue${scanned === 1 ? "" : "s"}`;
    }
    summary.appendChild(headline);

    const chips = document.createElement("div");
    chips.className = "monitor-chips";
    for (const section of sections) {
      const chip = document.createElement("button");
      chip.className =
        "monitor-chip mono" +
        (section.unavailable ? " unavailable" : section.count ? "" : " clean");
      chip.textContent = section.unavailable
        ? `${section.label} —`
        : `${section.label} ${section.count}`;
      chip.title = `Jump to ${section.label}`;
      chip.addEventListener("click", () => {
        collapsed.delete(section.id);
        render();
        document.getElementById(`monitor-section-${section.id}`)?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
      chips.appendChild(chip);
    }
    summary.appendChild(chips);

    // Issues tripping several checks at once: one edit clears more than one.
    const worst = worstOffenders(sections);
    if (worst.length) {
      const worstWrap = document.createElement("div");
      worstWrap.className = "monitor-worst";
      const title = document.createElement("span");
      title.className = "monitor-worst-title mono";
      title.textContent = "Fix these first";
      worstWrap.appendChild(title);
      for (const entry of worst) {
        const link = document.createElement("a");
        link.className = "monitor-worst-item mono";
        link.style.color = boardColor(entry.issue.boardId);
        link.textContent = `${entry.issue.key} (${entry.checks.length})`;
        attachIssueOpener(link, entry.issue.key, creds);
        link.title = `${entry.issue.fields.summary || ""}\n${entry.checks.join(", ")}`;
        worstWrap.appendChild(link);
      }
      summary.appendChild(worstWrap);
    }
  }

  function renderSection(section) {
    const el = document.createElement("div");
    el.className = "monitor-section";
    el.id = `monitor-section-${section.id}`;
    if (section.unavailable) el.classList.add("unavailable");
    else if (!section.count) el.classList.add("clean");

    const header = document.createElement("button");
    header.className = "monitor-section-header";
    const isCollapsed = collapsed.has(section.id) || section.count === 0;

    const arrow = document.createElement("span");
    arrow.className = "monitor-arrow";
    arrow.textContent = isCollapsed ? "▶" : "▼";
    header.appendChild(arrow);

    const label = document.createElement("span");
    label.className = "monitor-section-label mono";
    label.textContent = section.label;
    header.appendChild(label);

    const count = document.createElement("span");
    count.className =
      "monitor-count" +
      (section.unavailable ? " unavailable" : section.count ? "" : " clean");
    count.textContent = section.unavailable ? "—" : section.count;
    header.appendChild(count);

    const meta = document.createElement("span");
    meta.className = "monitor-section-meta";
    if (section.unavailable) {
      meta.textContent = `Can't run — ${section.unavailable}`;
      meta.classList.add("warn");
    } else {
      const parts = [
        section.count
          ? `${section.question} · of ${section.considered} checked`
          : `All ${section.considered} clear`,
        section.scopeNote,
      ];
      if (section.caveat) parts.push(section.caveat);
      meta.textContent = parts.join(" · ");
      if (section.caveat) meta.classList.add("warn");
    }
    meta.title = meta.textContent;
    header.appendChild(meta);

    header.addEventListener("click", () => {
      if (collapsed.has(section.id)) collapsed.delete(section.id);
      else collapsed.add(section.id);
      render();
    });
    el.appendChild(header);

    if (!isCollapsed && section.count) {
      el.appendChild(renderTable(section));
    }
    return el;
  }

  function renderTable(section) {
    const table = document.createElement("table");
    table.className = "monitor-table";

    const tbody = document.createElement("tbody");
    for (const issue of section.issues) {
      const tr = document.createElement("tr");

      const tdBoard = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "board-badge";
      badge.style.background = boardColor(issue.boardId) + "22";
      badge.style.color = boardColor(issue.boardId);
      badge.textContent = boardName(issue.boardId);
      tdBoard.appendChild(badge);
      tr.appendChild(tdBoard);

      const tdKey = document.createElement("td");
      const link = document.createElement("a");
      link.className = "issue-key";
      link.style.color = boardColor(issue.boardId);
      link.textContent = issue.key;
      attachIssueOpener(link, issue.key, creds);
      tdKey.appendChild(link);
      tr.appendChild(tdKey);

      const tdType = document.createElement("td");
      tdType.className = "monitor-cell-muted";
      tdType.textContent = issue.fields.issuetype?.name || "—";
      tr.appendChild(tdType);

      const tdSummary = document.createElement("td");
      tdSummary.className = "monitor-cell-summary";
      const text = issue.fields.summary || "";
      tdSummary.textContent = text.length > 70 ? `${text.slice(0, 70)}…` : text;
      tdSummary.title = text;
      tr.appendChild(tdSummary);

      const tdStatus = document.createElement("td");
      tdStatus.className = "monitor-cell-muted";
      tdStatus.textContent = issue.fields.status?.name || "—";
      tr.appendChild(tdStatus);

      // The column most relevant to the check that flagged this row.
      const tdContext = document.createElement("td");
      tdContext.className = "monitor-cell-muted";
      tdContext.textContent = contextFor(section.id, issue);
      tr.appendChild(tdContext);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function contextFor(checkId, issue) {
    switch (checkId) {
      case "unassigned":
        return issue.fields.duedate ? `due ${fmtDate(issue.fields.duedate)}` : "no due date";
      case "noEpic":
      case "noDueDate": {
        const points = getStoryPoints(issue);
        return points === null ? assigneeLabel(issue.fields.assignee) : `${assigneeLabel(issue.fields.assignee)} · ${points} pts`;
      }
      case "noPoints":
        return assigneeLabel(issue.fields.assignee);
      default:
        return "";
    }
  }

  render();
}
