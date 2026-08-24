// Command palette overlay (Cmd/Ctrl+K).
//
// Three sources of things to jump to, in ascending cost:
//   - views and actions — static, always available
//   - people           — the roster, already in memory
//   - issues           — fetched on first open and reused from cache after
//
// The palette opens immediately on the cheap sources and re-renders when issues
// finish indexing, rather than making the user wait on a fetch to type.
//
// Scoring and ranking live in js/palette.js; this file is only presentation and
// wiring.

import { localGet, localSet, runtimeUrl } from "../browser.js";
import { getAllBacklogIssues, getAllSprintIssues, searchIssuesByJql } from "../api.js";
import { boardColor, cache, isOverdue, showToast } from "../utils.js";
import { allMembers, avatarOverrideFor, memberLabel } from "../team.js";
import { requestAssigneeFilter } from "./filters.js";
import { buildExport, downloadJson, exportFilename } from "../portable.js";
import { openIssueDrawer, issuePageUrl } from "./issue-detail.js";
import { openCreateIssue } from "./issue-create.js";
import {
  JQL_PREFIX,
  RECENTS_KEY,
  addRecent,
  groupByKind,
  normalizeRecents,
  parseQuery,
  rankItems,
  recentBoost,
} from "../palette.js";

const KIND_LABELS = {
  issue: "Issues",
  person: "People",
  view: "Views",
  action: "Actions",
  jql: "JQL results",
};

const VIEWS = [
  { hash: "#dashboard", label: "Sprint dashboard", keywords: ["overview", "burndown"] },
  { hash: "#backlog", label: "Backlog", keywords: ["list", "issues"] },
  { hash: "#gantt", label: "Roadmap", keywords: ["gantt", "timeline"] },
  { hash: "#kanban", label: "Kanban", keywords: ["board", "columns"] },
  { hash: "#monitor", label: "Monitor", keywords: ["hygiene", "checks", "findings"] },
  { hash: "#standup", label: "Standup", keywords: ["daily", "timer"] },
];

// Module-level so the issue index survives closing and reopening the palette
// within a session. Cleared when the cache is.
let issueIndex = null;
let indexing = null;
let recents = [];
let recentsLoaded = false;
let overlay = null;

export function isPaletteOpen() {
  return Boolean(overlay);
}

export function invalidatePaletteIndex() {
  issueIndex = null;
  indexing = null;
}

async function loadRecents() {
  if (recentsLoaded) return recents;
  const stored = await localGet(RECENTS_KEY);
  recents = normalizeRecents(stored[RECENTS_KEY]);
  recentsLoaded = true;
  return recents;
}

async function rememberRecent(entry) {
  recents = addRecent(recents, entry);
  await localSet({ [RECENTS_KEY]: recents });
}

// Both sprint and backlog: "jump to any issue" is the promise, and both calls
// are cached, so the cost is paid once per cache window rather than per open.
function startIndexing(creds) {
  if (issueIndex || indexing) return indexing;
  indexing = Promise.all([
    getAllSprintIssues(creds).catch(() => []),
    getAllBacklogIssues(creds).catch(() => []),
  ])
    .then(([sprint, backlog]) => {
      const byKey = new Map();
      for (const issue of [...sprint, ...backlog]) {
        if (issue?.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
      }
      issueIndex = [...byKey.values()];
      return issueIndex;
    })
    .finally(() => {
      indexing = null;
    });
  return indexing;
}

export async function openPalette(creds) {
  if (overlay) return;
  await loadRecents();

  overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });

  const panel = document.createElement("div");
  panel.className = "palette-panel";
  overlay.appendChild(panel);

  const inputRow = document.createElement("div");
  inputRow.className = "palette-input-row";
  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = `Jump to an issue, person or view — ${JQL_PREFIX} for raw JQL`;
  input.autocomplete = "off";
  input.spellcheck = false;
  inputRow.appendChild(input);
  const status = document.createElement("span");
  status.className = "palette-status mono";
  inputRow.appendChild(status);
  panel.appendChild(inputRow);

  const results = document.createElement("div");
  results.className = "palette-results";
  panel.appendChild(results);

  const footer = document.createElement("div");
  footer.className = "palette-footer mono";
  footer.textContent = "↑↓ move · ↵ open · ⌘↵ new tab · esc close";
  panel.appendChild(footer);

  document.body.appendChild(overlay);
  input.focus();

  let flat = [];
  let active = 0;
  let jqlIssues = null;
  let jqlToken = 0;

  if (!issueIndex) {
    status.textContent = "indexing…";
    startIndexing(creds)?.then(() => {
      if (!overlay) return;
      status.textContent = "";
      render();
    });
  }

  function actions() {
    return [
      {
        kind: "action",
        id: "create",
        label: "Create issue",
        keywords: ["new", "add", "ticket", "story", "bug", "task"],
        // The palette is the cheap way in; the Backlog toolbar is the
        // discoverable one. Same panel, and the form in it comes from the
        // project's own createmeta either way.
        run: () => openCreateIssue(creds),
      },
      {
        kind: "action",
        id: "settings",
        label: "Open Settings",
        keywords: ["config", "roster", "boards", "fields"],
        run: () => window.open(runtimeUrl("settings.html")),
      },
      {
        kind: "action",
        id: "refresh",
        label: "Clear cache and reload the view",
        keywords: ["refetch", "stale", "sync"],
        run: async () => {
          await cache.clear();
          invalidatePaletteIndex();
          window.dispatchEvent(new HashChangeEvent("hashchange"));
          showToast("Cache cleared — reloading");
        },
      },
      {
        kind: "action",
        id: "export",
        label: "Export configuration",
        keywords: ["backup", "json", "download"],
        // Config only — no token, no roster. Both of those are opt-in ticks on
        // the Settings page, and a palette action is no place to leak them.
        run: () => {
          downloadJson(exportFilename(), buildExport({}));
          showToast("Configuration exported — no token, no roster");
        },
      },
    ];
  }

  function candidates(query) {
    const items = [];

    for (const view of VIEWS) {
      items.push({
        kind: "view",
        id: view.hash,
        label: view.label,
        sublabel: view.hash,
        keywords: view.keywords,
        run: () => {
          location.hash = view.hash;
        },
      });
    }

    for (const member of allMembers()) {
      if (!member.accountId) continue;
      items.push({
        kind: "person",
        id: member.accountId,
        label: memberLabel(member),
        sublabel: member.email || member.jiraName,
        keywords: [member.slackHandle, member.jiraName].filter(Boolean),
        avatar: avatarOverrideFor(member.accountId) || member.avatarUrl || "",
        // Hands the backlog a one-shot assignee filter, then navigates. If the
        // backlog is already showing, the hash won't change, so remount by hand.
        run: () => {
          requestAssigneeFilter([member.accountId]);
          if (location.hash === "#backlog") {
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          } else {
            location.hash = "#backlog";
          }
        },
      });
    }

    for (const issue of issueIndex || []) {
      items.push({
        kind: "issue",
        id: issue.key,
        label: issue.key,
        sublabel: issue.fields?.summary || "",
        keywords: [issue.fields?.status?.name, issue.fields?.issuetype?.name].filter(Boolean),
        issue,
        // An exact key match should never sit below a summary match.
        boost: query && issue.key.toLowerCase() === query.toLowerCase() ? 900 : 0,
        run: () => openIssueDrawer(issue.key, creds),
        runAlt: () => window.open(issuePageUrl(issue.key), "_blank", "noopener"),
      });
    }

    items.push(...actions());

    // Recents float up without overriding a strong direct match.
    return items.map((item) => ({
      ...item,
      boost: (item.boost || 0) + recentBoost(recents, item),
    }));
  }

  function jqlCandidates() {
    return (jqlIssues || []).map((issue) => ({
      kind: "jql",
      id: issue.key,
      label: issue.key,
      sublabel: issue.fields?.summary || "",
      issue,
      run: () => openIssueDrawer(issue.key, creds),
      runAlt: () => window.open(issuePageUrl(issue.key), "_blank", "noopener"),
    }));
  }

  async function runJql(jql) {
    const token = ++jqlToken;
    if (!jql) {
      jqlIssues = null;
      status.textContent = "";
      render();
      return;
    }
    status.textContent = "running…";
    try {
      const found = await searchIssuesByJql(jql, creds);
      if (token !== jqlToken || !overlay) return;
      jqlIssues = found;
      status.textContent = `${found.length} match${found.length === 1 ? "" : "es"}`;
    } catch (err) {
      if (token !== jqlToken || !overlay) return;
      jqlIssues = [];
      // Jira's JQL errors are specific and worth showing verbatim.
      status.textContent = String(err.message || err).slice(0, 90);
    }
    render();
  }

  const debouncedJql = debounceLocal((jql) => runJql(jql), 350);

  function render() {
    const { mode, value } = parseQuery(input.value);
    // JQL results keep Jira's own ordering — the query already expressed intent,
    // so re-ranking them locally would only obscure it.
    flat =
      mode === "jql"
        ? jqlCandidates().slice(0, 50)
        : rankItems(value, candidates(value), { limit: 40 });
    if (active >= flat.length) active = Math.max(0, flat.length - 1);

    results.innerHTML = "";

    if (mode === "jql" && !value) {
      results.appendChild(hint("Type a JQL query, e.g. assignee = currentUser() AND statusCategory != Done"));
      return;
    }
    if (!flat.length) {
      results.appendChild(
        hint(indexing ? "Still indexing issues…" : "Nothing matches that.")
      );
      return;
    }

    let i = 0;
    for (const group of groupByKind(flat)) {
      const heading = document.createElement("div");
      heading.className = "palette-group mono";
      heading.textContent = KIND_LABELS[group.kind] || group.kind;
      results.appendChild(heading);
      for (const item of group.items) {
        results.appendChild(renderRow(item, i === active, i));
        i++;
      }
    }
    scrollActiveIntoView();
  }

  function hint(text) {
    const el = document.createElement("div");
    el.className = "palette-hint";
    el.textContent = text;
    return el;
  }

  function renderRow(item, isActive, index) {
    const row = document.createElement("div");
    row.className = "palette-row" + (isActive ? " active" : "");
    row.dataset.index = index;

    if (item.kind === "issue" || item.kind === "jql") {
      const key = document.createElement("span");
      key.className = "palette-key mono";
      key.textContent = item.label;
      if (item.issue?.boardId !== undefined) {
        key.style.color = boardColor(item.issue.boardId);
      }
      row.appendChild(key);
    } else if (item.kind === "person" && item.avatar) {
      const img = document.createElement("img");
      img.className = "palette-avatar";
      img.src = item.avatar;
      img.alt = "";
      img.addEventListener("error", () => img.remove());
      row.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "palette-icon mono";
      icon.textContent = item.kind === "view" ? "→" : "•";
      row.appendChild(icon);
    }

    const label = document.createElement("span");
    label.className = "palette-label";
    label.textContent =
      item.kind === "issue" || item.kind === "jql" ? item.sublabel || "—" : item.label;
    row.appendChild(label);

    if (item.issue && isOverdue(item.issue)) {
      const badge = document.createElement("span");
      badge.className = "palette-badge overdue mono";
      badge.textContent = "overdue";
      row.appendChild(badge);
    }

    const meta = document.createElement("span");
    meta.className = "palette-meta mono";
    if (item.kind === "issue" || item.kind === "jql") {
      meta.textContent = item.issue?.fields?.status?.name || "";
    } else if (item.kind === "person") {
      meta.textContent = item.sublabel || "";
    } else if (item.kind === "view") {
      meta.textContent = item.sublabel || "";
    }
    row.appendChild(meta);

    row.addEventListener("mousemove", () => {
      if (active === index) return;
      active = index;
      paintActive();
    });
    row.addEventListener("click", (e) => choose(item, e.metaKey || e.ctrlKey));
    return row;
  }

  function paintActive() {
    results.querySelectorAll(".palette-row").forEach((row) => {
      row.classList.toggle("active", Number(row.dataset.index) === active);
    });
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const row = results.querySelector(".palette-row.active");
    row?.scrollIntoView({ block: "nearest" });
  }

  async function choose(item, alt = false) {
    if (!item) return;
    await rememberRecent({ kind: item.kind === "jql" ? "issue" : item.kind, id: item.id });
    closePalette();
    if (alt && item.runAlt) item.runAlt();
    else item.run();
  }

  input.addEventListener("input", () => {
    const { mode, value } = parseQuery(input.value);
    active = 0;
    if (mode === "jql") {
      debouncedJql(value);
      render();
      return;
    }
    jqlIssues = null;
    jqlToken++; // abandon any in-flight JQL result
    status.textContent = indexing ? "indexing…" : "";
    render();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = flat.length ? (active + 1) % flat.length : 0;
      paintActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = flat.length ? (active - 1 + flat.length) % flat.length : 0;
      paintActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active], e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });

  render();
}

export function closePalette() {
  overlay?.remove();
  overlay = null;
}

// Local to avoid importing the shared debounce, which drops the return value —
// this one only needs the trailing call.
function debounceLocal(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
