import { getActiveSprint, getAllSprintIssues } from "../api.js";
import { BOARDS, fmtDate, loadStatusGroups, relDate } from "../utils.js";
import { CONFIG } from "../config.js";
import {
  buildBurndown,
  hygieneLabel,
  hygieneScore,
  isoDay,
  summarize,
} from "../dashboard.js";
import { loadSnapshots, recordSnapshot, snapshotFrom, sprintKey } from "../snapshots.js";
import {
  burndownChart,
  emptyState,
  horizontalBars,
  legend,
  stackedBar,
} from "../charts.js";

// Ordinal ramp for sprint progression: To Do → Done is a sequence, so it takes
// one hue in monotone lightness steps rather than four unrelated colours — the
// reader sees the order in the colour. Each mode's steps were selected for that
// mode's surface and validated (monotone lightness, adjacent ΔL ≥ 0.06,
// light-end contrast ≥ 2:1, single hue), not flipped from one another.
//
// Deliberately NOT the app's status badge colours: those are reserved status
// tokens (green = done, red = blocked), and reusing them here would have a
// status colour impersonating a series.
const PROGRESS_RAMP_LIGHT = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"];
const PROGRESS_RAMP_DARK = ["#184f95", "#2a78d6", "#5598e7", "#86b6ef"];

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") !== "light";
}

// Segment ink is picked by the fill's luminance so an inline label always
// clears contrast against the segment it sits in.
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#0b0b0b" : "#ffffff";
}

function rampFor(count) {
  const ramp = isDarkTheme() ? PROGRESS_RAMP_DARK : PROGRESS_RAMP_LIGHT;
  if (count <= ramp.length) return ramp.slice(0, count);
  // More status groups than ramp steps: repeat the darkest end rather than
  // inventing hues, which would break the ordinal reading.
  return Array.from({ length: count }, (_, i) => ramp[Math.min(i, ramp.length - 1)]);
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  // Both of these are already cached by the other views, so opening this tab
  // normally costs nothing in requests.
  const [issues, statusGroups] = await Promise.all([
    getAllSprintIssues(creds),
    loadStatusGroups(),
  ]);
  const sprintLists = await Promise.all(BOARDS.map((b) => getActiveSprint(b.id, creds)));
  const sprints = sprintLists.flat();

  const summary = summarize({
    issues,
    sprints,
    statusGroups,
    monitorSettings: CONFIG.monitorChecks,
    boards: BOARDS,
    now: new Date(),
  });

  // Record today's aggregate, then read the series back including it.
  const key = sprintKey(sprints);
  const today = isoDay(new Date());
  await recordSnapshot(key, snapshotFrom(summary, today));
  const snapshots = await loadSnapshots(key);
  const burndown = buildBurndown({
    snapshots,
    window: summary.window,
    totalPoints: summary.totalPoints,
  });

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "dash-wrap";
  wrap.appendChild(renderHeader(summary));
  wrap.appendChild(renderKpis(summary));
  wrap.appendChild(renderBurndown(summary, burndown, snapshots));
  wrap.appendChild(renderProgress(summary));
  wrap.appendChild(renderBreakdowns(summary));
  container.appendChild(wrap);
}

function renderHeader(summary) {
  const header = document.createElement("header");
  header.className = "dash-header";

  const title = document.createElement("h1");
  title.className = "dash-title";
  title.textContent = summary.sprintNames.length
    ? summary.sprintNames.join(" · ")
    : "No active sprint";
  header.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dash-header-meta";
  if (summary.window.start && summary.window.end) {
    const dates = document.createElement("span");
    dates.textContent = `${fmtDate(summary.window.start)} → ${fmtDate(summary.window.end)}`;
    meta.appendChild(dates);

    const days = document.createElement("span");
    days.className = summary.isOverdue ? "dash-overdue" : "";
    days.textContent = summary.isOverdue
      ? `ended ${relDate(summary.window.end)}`
      : `${summary.daysRemaining} working day${summary.daysRemaining === 1 ? "" : "s"} left of ${summary.daysTotal}`;
    meta.appendChild(days);
  } else {
    const none = document.createElement("span");
    none.textContent = "No sprint dates — start a sprint in Jira to see a timeline.";
    meta.appendChild(none);
  }
  header.appendChild(meta);

  for (const goal of summary.goals) {
    const goalEl = document.createElement("p");
    goalEl.className = "dash-goal";
    goalEl.textContent = goal;
    header.appendChild(goalEl);
  }
  return header;
}

// KPI row of stat tiles — headline numbers are figures, not a bar chart. The
// completion figure is the one hero number on the view.
function renderKpis(summary) {
  const row = document.createElement("div");
  row.className = "dash-kpis";

  const pct =
    summary.completionByPoints === null
      ? null
      : Math.round(summary.completionByPoints * 100);

  row.appendChild(
    heroTile({
      label: "Points complete",
      value: pct === null ? "—" : `${pct}%`,
      detail:
        summary.totalPoints > 0
          ? `${trimNum(summary.donePoints)} of ${trimNum(summary.totalPoints)} points`
          : "No estimates on this sprint",
    })
  );

  row.appendChild(
    statTile({
      label: "Issues done",
      value: `${summary.doneIssues}/${summary.issueCount}`,
      detail:
        summary.completionByIssues === null
          ? "Nothing in the sprint"
          : `${Math.round(summary.completionByIssues * 100)}% of issues`,
    })
  );

  row.appendChild(
    statTile({
      label: "Carried in",
      value: String(summary.carriedIn),
      detail: summary.carriedIn
        ? `${trimNum(summary.carriedInPoints)} points from a previous sprint`
        : "Nothing carried over",
    })
  );

  row.appendChild(
    statTile({
      label: "Added after start",
      value: String(summary.addedAfterStart),
      detail: summary.addedAfterStart
        ? `${trimNum(summary.addedAfterStartPoints)} points of scope change`
        : "Scope held",
      hint:
        "Counted from issue creation date, so an older issue dragged in mid-sprint isn't caught.",
    })
  );

  row.appendChild(
    statTile({
      label: "Projected carry-out",
      value: String(summary.projectedCarryOut),
      detail: summary.projectedCarryOut
        ? `${trimNum(summary.projectedCarryOutPoints)} points still open`
        : "Everything closed",
      state: summary.projectedCarryOut === 0 ? "good" : null,
    })
  );

  // Hygiene wears status tokens, and status never carries meaning by colour
  // alone — the tile always shows the word and an icon.
  const score = hygieneScore(summary);
  const hygiene = hygieneLabel(score);
  row.appendChild(
    statTile({
      label: "Sprint hygiene",
      value: score === null ? "—" : `${Math.round(score * 100)}%`,
      detail: `${summary.hygieneFindings} finding${summary.hygieneFindings === 1 ? "" : "s"} · ${hygiene.text}`,
      state: hygiene.state,
      icon: { good: "✓", warning: "!", critical: "✕", unknown: "–" }[hygiene.state],
      onClick: () => {
        location.hash = "#monitor";
      },
    })
  );

  return row;
}

function heroTile({ label, value, detail }) {
  const tile = statTile({ label, value, detail });
  tile.classList.add("dash-tile-hero");
  return tile;
}

function statTile({ label, value, detail, state = null, icon = null, hint = null, onClick = null }) {
  const tile = document.createElement(onClick ? "button" : "div");
  tile.className = "dash-tile" + (state ? ` state-${state}` : "");
  if (onClick) {
    tile.addEventListener("click", onClick);
    tile.classList.add("dash-tile-clickable");
  }

  const labelEl = document.createElement("div");
  labelEl.className = "dash-tile-label";
  labelEl.textContent = label;
  if (hint) {
    const mark = document.createElement("span");
    mark.className = "dash-hint-mark";
    mark.textContent = "?";
    mark.title = hint;
    labelEl.appendChild(mark);
  }
  tile.appendChild(labelEl);

  const valueEl = document.createElement("div");
  valueEl.className = "dash-tile-value";
  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "dash-tile-icon";
    iconEl.textContent = icon;
    valueEl.appendChild(iconEl);
  }
  valueEl.append(value);
  tile.appendChild(valueEl);

  const detailEl = document.createElement("div");
  detailEl.className = "dash-tile-detail";
  detailEl.textContent = detail;
  tile.appendChild(detailEl);

  return tile;
}

function renderBurndown(summary, burndown, snapshots) {
  const card = document.createElement("section");
  card.className = "dash-card";

  const head = document.createElement("div");
  head.className = "dash-card-head";
  const title = document.createElement("h2");
  title.className = "dash-card-title";
  title.textContent = "Burndown";
  head.appendChild(title);

  const readout = document.createElement("span");
  readout.className = "dash-readout mono";
  head.appendChild(readout);
  card.appendChild(head);

  if (!burndown) {
    card.appendChild(
      emptyState("No sprint dates, so there is no timeline to burn down against.")
    );
    return card;
  }

  if (!burndown.ready) {
    const note = document.createElement("div");
    note.className = "chart-empty dash-burndown-empty";
    note.textContent =
      snapshots.length <= 1
        ? `Collecting history. Jira has no public API for past sprint state, so ${CONFIG.brand.productName} records one snapshot a day from data it already has — the burndown appears tomorrow.`
        : `Collecting history — ${burndown.have} of ${burndown.need} days recorded so far.`;
    card.appendChild(note);
    return card;
  }

  const delta = burndown.deltaPoints;
  if (delta !== null) {
    readout.textContent =
      Math.abs(delta) < 0.5
        ? "on the ideal line"
        : delta > 0
          ? `${trimNum(delta)} points behind the ideal line`
          : `${trimNum(-delta)} points ahead of the ideal line`;
    readout.classList.toggle("behind", delta > 0.5);
  }

  const chart = burndownChart(burndown, {
    onHover: (point) => {
      if (!point) {
        readout.textContent =
          delta === null
            ? ""
            : Math.abs(delta) < 0.5
              ? "on the ideal line"
              : delta > 0
                ? `${trimNum(delta)} points behind the ideal line`
                : `${trimNum(-delta)} points ahead of the ideal line`;
        return;
      }
      const actual = point.actual ? `${trimNum(point.actual.points)} left` : "no snapshot";
      const ideal = point.ideal ? `${trimNum(point.ideal.points)} ideal` : "—";
      readout.textContent = `${point.date} · ${actual} · ${ideal}`;
    },
  });
  card.appendChild(chart);

  // Two series, so a legend is mandatory rather than optional.
  card.appendChild(
    legend([
      { label: "Points remaining", fill: "var(--chart-series-1)" },
      { label: "Ideal", fill: "var(--chart-muted-line)", dashed: true },
    ])
  );
  return card;
}

function renderProgress(summary) {
  const card = document.createElement("section");
  card.className = "dash-card";

  const title = document.createElement("h2");
  title.className = "dash-card-title";
  title.textContent = "Progress by status";
  card.appendChild(title);

  const buckets = summary.byStatus.filter((b) => b.issues > 0);
  if (!buckets.length) {
    card.appendChild(emptyState("Nothing in the sprint yet."));
    return card;
  }

  const ramp = rampFor(buckets.length);
  const usePoints = summary.totalPoints > 0;
  const segments = buckets.map((bucket, i) => ({
    label: bucket.key,
    value: usePoints ? bucket.points : bucket.issues,
    fill: ramp[i],
    labelInk: inkFor(ramp[i]),
  }));

  card.appendChild(
    stackedBar(segments, {
      format: (v) => trimNum(v),
      emptyLabel: usePoints ? "No estimated points" : "No issues",
    })
  );
  card.appendChild(
    legend(segments.map((s) => ({ label: `${s.label} · ${trimNum(s.value)}`, fill: s.fill })))
  );

  const unit = document.createElement("p");
  unit.className = "dash-note";
  unit.textContent = usePoints
    ? `Story points. ${summary.unestimated} issue${summary.unestimated === 1 ? "" : "s"} unestimated${summary.subtaskCount ? `, ${summary.subtaskCount} sub-task${summary.subtaskCount === 1 ? "" : "s"} excluded` : ""}.`
    : "Issue counts — no story points are set on this sprint.";
  card.appendChild(unit);
  return card;
}

function renderBreakdowns(summary) {
  const grid = document.createElement("div");
  grid.className = "dash-grid";

  // By board: nominal categories, so bars share one hue and the board's own
  // colour rides beside the label as a dot. Colouring the bars by board would
  // spend the identity channel on what the label already says.
  const boardCard = document.createElement("section");
  boardCard.className = "dash-card";
  const boardTitle = document.createElement("h2");
  boardTitle.className = "dash-card-title";
  boardTitle.textContent = "By board";
  boardCard.appendChild(boardTitle);
  const boardRows = summary.byBoard.map((b) => ({
    label: b.label,
    value: summary.totalPoints > 0 ? b.points : b.issues,
    hint: `${b.doneIssues}/${b.issues} done`,
  }));
  boardCard.appendChild(
    horizontalBars(boardRows, { format: trimNum, emptyLabel: "No boards in scope" })
  );
  boardCard.appendChild(dotKey(summary.byBoard));
  grid.appendChild(boardCard);

  // By person doubles as the table view, so every value is readable as text —
  // which is what lets the chart lean on colour at all.
  const personCard = document.createElement("section");
  personCard.className = "dash-card";
  const personTitle = document.createElement("h2");
  personTitle.className = "dash-card-title";
  personTitle.textContent = "By person";
  personCard.appendChild(personTitle);

  if (!summary.byPerson.length) {
    personCard.appendChild(emptyState("Nothing assigned in the sprint."));
  } else {
    personCard.appendChild(renderPersonTable(summary));
  }
  grid.appendChild(personCard);

  return grid;
}

function dotKey(boards) {
  const wrap = document.createElement("div");
  wrap.className = "chart-legend";
  for (const board of boards) {
    const item = document.createElement("span");
    item.className = "chart-legend-item";
    const dot = document.createElement("span");
    dot.className = "chart-dot-key";
    dot.style.background = board.color;
    const label = document.createElement("span");
    label.textContent = board.label;
    item.append(dot, label);
    wrap.appendChild(item);
  }
  return wrap;
}

function renderPersonTable(summary) {
  const table = document.createElement("table");
  table.className = "dash-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Person", "Points", "Done", "Open"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const max = Math.max(...summary.byPerson.map((p) => p.points), 1);
  const tbody = document.createElement("tbody");
  for (const person of summary.byPerson) {
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "dash-person-name";
    name.textContent = person.label;
    if (person.onTeam === false) {
      const outside = document.createElement("span");
      outside.className = "dash-outside";
      outside.textContent = "outside team";
      name.appendChild(outside);
    }
    tr.appendChild(name);

    // A meter, not a second chart: the fill and its track are the same ramp so
    // the ratio reads across the whole bar.
    const points = document.createElement("td");
    points.className = "dash-meter-cell";
    const meter = document.createElement("span");
    meter.className = "dash-meter";
    const fill = document.createElement("span");
    fill.className = "dash-meter-fill";
    fill.style.width = `${(person.points / max) * 100}%`;
    meter.appendChild(fill);
    const value = document.createElement("span");
    value.className = "dash-meter-value mono";
    value.textContent = trimNum(person.points);
    points.append(meter, value);
    tr.appendChild(points);

    const done = document.createElement("td");
    done.className = "dash-num mono";
    done.textContent = `${person.doneIssues}/${person.issues}`;
    tr.appendChild(done);

    const open = document.createElement("td");
    open.className = "dash-num mono";
    open.textContent = trimNum(person.points - person.donePoints);
    tr.appendChild(open);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Points are often halves; integers shouldn't show a trailing ".0".
function trimNum(n) {
  const value = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
