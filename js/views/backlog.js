import {
  getAllBacklogIssues,
  getAllSprintIssues,
} from "../api.js";
import {
  hashColor,
  boardColor,
  boardName,
  fmtDate,
  getStoryPoints,
  getAvatarUrl,
  getEpicKey,
  extractAssignees,
  assigneeLabel,
} from "../utils.js";
import { browseUrl } from "../config.js";
import { renderFilters, applyFilters } from "../components/filters.js";

const PRIORITY_ICONS = {
  Critical: "🔴",
  Highest: "🔴",
  High: "🟠",
  Medium: "🟡",
  Low: "🔵",
  Lowest: "🔵",
};

const STATUS_COLORS = {
  "to do": "#6B7280",
  "in progress": "#4F8EF7",
  "in review": "#EAB308",
  done: "#4FCF8E",
  blocked: "#EF4444",
};

const PRIORITY_ORDER = { Critical: 0, Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 };

const STATUS_ORDER = {
  "in review": 0,
  "in code review": 0,
  "code review": 0,
  "review": 0,
  "in progress": 1,
  "in development": 1,
  "on hold": 2,
  "done": 90,
  "closed": 90,
  "resolved": 90,
  "rejected": 91,
};

const SP_MAX = 13;

function spColor(sp) {
  const t = Math.min(sp / SP_MAX, 1);
  if (t <= 0.5) {
    const r = Math.round(76 + (234 - 76) * (t * 2));
    const g = Math.round(207 + (179 - 207) * (t * 2));
    const b = Math.round(142 + (8 - 142) * (t * 2));
    return `rgb(${r},${g},${b})`;
  }
  const r = Math.round(234 + (239 - 234) * ((t - 0.5) * 2));
  const g = Math.round(179 + (68 - 179) * ((t - 0.5) * 2));
  const b = Math.round(8 + (68 - 8) * ((t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

export async function mount(container, creds) {
  container.innerHTML = '<div class="spinner"></div>';

  const [backlog, sprint] = await Promise.all([
    getAllBacklogIssues(creds),
    getAllSprintIssues(creds),
  ]);

  const deduped = new Map();
  for (const issue of [...sprint, ...backlog]) {
    if (!deduped.has(issue.id)) deduped.set(issue.id, issue);
  }
  const allIssues = [...deduped.values()];
  const assignees = extractAssignees(allIssues);
  const statuses = [...new Set(allIssues.map((i) => i.fields.status?.name).filter(Boolean))];

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "backlog-wrap";

  const filterBar = document.createElement("div");
  wrap.appendChild(filterBar);

  const header = document.createElement("div");
  header.className = "backlog-header";
  const countEl = document.createElement("span");
  countEl.className = "backlog-count";
  header.appendChild(countEl);
  wrap.appendChild(header);

  const tableWrap = document.createElement("div");
  tableWrap.className = "backlog-table-wrap";
  wrap.appendChild(tableWrap);
  container.appendChild(wrap);

  let sortCol = "status";
  let sortDir = "asc";
  const excludedByDefault = ["Done", "Rejected"];
  const defaultStatuses = statuses.filter((s) => !excludedByDefault.includes(s));
  let filtered = allIssues.filter((i) => {
    const sn = i.fields.status?.name || "";
    return !excludedByDefault.includes(sn);
  });

  renderFilters(filterBar, {
    boards: true,
    types: true,
    assignees,
    statuses,
    search: true,
    defaultStatuses,
  }, (state) => {
    filtered = applyFilters(allIssues, state);
    renderTable();
  });

  function renderTable() {
    const sorted = sortIssues(filtered, sortCol, sortDir);
    countEl.textContent = `Showing ${sorted.length} of ${allIssues.length} issues`;

    tableWrap.innerHTML = "";
    const table = document.createElement("table");
    table.className = "backlog-table";

    const cols = [
      { key: "board", label: "Board" },
      { key: "key", label: "Key" },
      { key: "epic", label: "Epic" },
      { key: "summary", label: "Summary" },
      { key: "status", label: "Status" },
      { key: "assignee", label: "Assignee" },
      { key: "sp", label: "Story Points" },
      { key: "due", label: "Due" },
    ];

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (sortCol === col.key) {
        const arrow = document.createElement("span");
        arrow.className = "sort-arrow";
        arrow.textContent = sortDir === "asc" ? "▲" : "▼";
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (sortCol === col.key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortCol = col.key;
          sortDir = "asc";
        }
        renderTable();
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const issue of sorted) {
      tbody.appendChild(renderRow(issue));
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  function renderRow(issue) {
    const f = issue.fields;
    const tr = document.createElement("tr");
    tr.className = "backlog-row";
    tr.style.borderLeftColor = hashColor(issue.key);

    // Board
    const tdBoard = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "board-badge";
    badge.style.background = boardColor(issue.boardId) + "22";
    badge.style.color = boardColor(issue.boardId);
    badge.textContent = boardName(issue.boardId);
    tdBoard.appendChild(badge);
    tr.appendChild(tdBoard);

    // Key
    const tdKey = document.createElement("td");
    const keyLink = document.createElement("a");
    keyLink.className = "issue-key";
    keyLink.href = browseUrl(issue.key);
    keyLink.target = "_blank";
    keyLink.rel = "noopener";
    keyLink.style.color = boardColor(issue.boardId);
    keyLink.textContent = issue.key;
    tdKey.appendChild(keyLink);
    tr.appendChild(tdKey);

    // Epic
    const tdEpic = document.createElement("td");
    const epicKey = getEpicKey(issue);
    if (epicKey) {
      const epicLink = document.createElement("a");
      epicLink.className = "issue-key";
      epicLink.href = browseUrl(epicKey);
      epicLink.target = "_blank";
      epicLink.rel = "noopener";
      epicLink.style.color = "var(--muted)";
      epicLink.style.fontSize = "11px";
      epicLink.textContent = epicKey;
      tdEpic.appendChild(epicLink);
    } else {
      tdEpic.textContent = "—";
      tdEpic.style.color = "var(--muted)";
      tdEpic.style.fontFamily = "'IBM Plex Mono', monospace";
      tdEpic.style.fontSize = "12px";
    }
    tr.appendChild(tdEpic);

    // Summary
    const tdSummary = document.createElement("td");
    tdSummary.className = "summary-cell";
    const sum = f.summary || "";
    tdSummary.textContent = sum.length > 60 ? sum.slice(0, 60) + "…" : sum;
    tr.appendChild(tdSummary);

    // Status
    const tdStatus = document.createElement("td");
    const sBadge = document.createElement("span");
    sBadge.className = "status-badge";
    const sName = f.status?.name || "Unknown";
    const sColor = STATUS_COLORS[sName.toLowerCase()] || "#6B7280";
    sBadge.style.background = sColor + "22";
    sBadge.style.color = sColor;
    sBadge.textContent = sName;
    tdStatus.appendChild(sBadge);
    tr.appendChild(tdStatus);

    // Assignee
    const tdAssignee = document.createElement("td");
    const aWrap = document.createElement("div");
    aWrap.className = "assignee-cell";
    if (f.assignee) {
      const avatarUrl = getAvatarUrl(issue);
      if (avatarUrl) {
        const img = document.createElement("img");
        img.className = "avatar";
        img.src = avatarUrl;
        img.onerror = () => {
          const ph = makeAvatarPlaceholder(f.assignee.displayName);
          img.replaceWith(ph);
        };
        aWrap.appendChild(img);
      } else {
        aWrap.appendChild(makeAvatarPlaceholder(f.assignee.displayName));
      }
      const nameSpan = document.createElement("span");
      nameSpan.textContent = assigneeLabel(f.assignee);
      nameSpan.style.fontSize = "12px";
      aWrap.appendChild(nameSpan);
    } else {
      const dash = document.createElement("span");
      dash.textContent = "—";
      dash.style.color = "var(--muted)";
      aWrap.appendChild(dash);
    }
    tdAssignee.appendChild(aWrap);
    tr.appendChild(tdAssignee);

    // Story Points
    const tdSP = document.createElement("td");
    tdSP.style.fontFamily = "'IBM Plex Mono', monospace";
    tdSP.style.fontSize = "12px";
    const sp = getStoryPoints(issue);
    if (sp !== null) {
      tdSP.style.position = "relative";
      tdSP.style.overflow = "hidden";
      const bar = document.createElement("div");
      const pct = Math.min(sp / SP_MAX, 1) * 100;
      const color = spColor(sp);
      bar.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${color};opacity:0.13;border-radius:2px;`;
      tdSP.appendChild(bar);
      const val = document.createElement("span");
      val.style.cssText = `position:relative;z-index:1;color:${color};font-weight:500;`;
      val.textContent = sp;
      tdSP.appendChild(val);
    } else {
      tdSP.textContent = "—";
      tdSP.style.color = "var(--muted)";
    }
    tr.appendChild(tdSP);

    // Due
    const tdDue = document.createElement("td");
    tdDue.style.fontFamily = "'IBM Plex Mono', monospace";
    tdDue.style.fontSize = "12px";
    if (f.duedate) {
      tdDue.textContent = fmtDate(f.duedate);
      const due = new Date(f.duedate);
      const now = new Date();
      const diffMs = due - now;
      if (diffMs < 0) tdDue.className = "due-overdue";
      else if (diffMs < 7 * 86400000) tdDue.className = "due-7";
      else if (diffMs < 14 * 86400000) tdDue.className = "due-14";
      else tdDue.className = "due-normal";
    } else {
      tdDue.textContent = "—";
      tdDue.style.color = "var(--muted)";
    }
    tr.appendChild(tdDue);

    return tr;
  }
}

function makeAvatarPlaceholder(name) {
  const el = document.createElement("span");
  el.className = "avatar-placeholder";
  el.style.background = hashColor(name);
  el.textContent = (name || "?")[0].toUpperCase();
  return el;
}

function sortIssues(issues, col, dir) {
  const sorted = [...issues];
  const m = dir === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    const fa = a.fields;
    const fb = b.fields;
    let va, vb;

    switch (col) {
      case "board":
        va = a.boardName || "";
        vb = b.boardName || "";
        return va.localeCompare(vb) * m;
      case "key":
        return a.key.localeCompare(b.key) * m;
      case "type":
        va = fa.issuetype?.name || "";
        vb = fb.issuetype?.name || "";
        return va.localeCompare(vb) * m;
      case "summary":
        return (fa.summary || "").localeCompare(fb.summary || "") * m;
      case "status": {
        const sa = STATUS_ORDER[fa.status?.name?.toLowerCase()] ?? 50;
        const sb = STATUS_ORDER[fb.status?.name?.toLowerCase()] ?? 50;
        if (sa !== sb) return (sa - sb) * m;
        return (fa.status?.name || "").localeCompare(fb.status?.name || "") * m;
      }
      case "epic": {
        va = getEpicKey(a) || "zzz";
        vb = getEpicKey(b) || "zzz";
        return va.localeCompare(vb) * m;
      }
      case "priority": {
        const pa = PRIORITY_ORDER[fa.priority?.name] ?? 99;
        const pb = PRIORITY_ORDER[fb.priority?.name] ?? 99;
        return (pa - pb) * m;
      }
      case "assignee":
        va = fa.assignee?.displayName || "zzz";
        vb = fb.assignee?.displayName || "zzz";
        return va.localeCompare(vb) * m;
      case "sp":
        va = getStoryPoints(a) ?? -1;
        vb = getStoryPoints(b) ?? -1;
        return (va - vb) * m;
      case "due":
        va = fa.duedate ? new Date(fa.duedate).getTime() : Infinity;
        vb = fb.duedate ? new Date(fb.duedate).getTime() : Infinity;
        return (va - vb) * m;
      default:
        return 0;
    }
  });

  return sorted;
}
