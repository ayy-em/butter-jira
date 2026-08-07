// Issue detail, rendered identically in two containers:
//   - drawer  — plain left-click on an issue key, slides over the current view
//   - page    — cmd/ctrl-click or middle-click, opens issue.html in a new tab
//
// The drawer is deliberately ephemeral and does not touch the URL: the router
// keys off the hash, and writing an issue key into it would remount the
// underlying view. The full page is the linkable, reloadable form.

import { runtimeUrl } from "../browser.js";
import { addIssueComment, getIssue, getIssueComments } from "../api.js";
import { CONFIG, browseUrl, fieldValue } from "../config.js";
import { assigneeLabel, fmtDate, getStartDate, getStoryPoints, relDate } from "../utils.js";
import { avatarOverrideFor } from "../team.js";
import { sanitizeToFragment } from "../sanitize.js";
import { adfToPlainText, isEmptyAdf, textToAdf } from "../adf.js";

const STATUS_CATEGORY_COLORS = {
  new: "var(--muted)",
  indeterminate: "var(--accent-primary)",
  done: "var(--accent-success)",
};

export function issuePageUrl(issueKey) {
  return runtimeUrl(`issue.html?key=${encodeURIComponent(issueKey)}`);
}

// Wires an anchor so the browser handles "open in new tab" natively (cmd/ctrl
// click, middle click, "Open link in new tab") and a plain click opens the
// drawer instead.
export function attachIssueOpener(anchor, issueKey, creds) {
  anchor.href = issuePageUrl(issueKey);
  anchor.title = `${issueKey} — click for details, ⌘/Ctrl-click for a new tab`;
  anchor.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openIssueDrawer(issueKey, creds);
  });
  return anchor;
}

let openDrawer = null;

// The drawer occupies the band between whatever the current view has pinned to
// the top and bottom of the window, so the chrome stays visible while an issue
// is open. Views with their own frame opt in with data-drawer-top /
// data-drawer-bottom — standup does, so its clock and parking lot survive a
// card being opened mid-turn.
const TOP_CHROME = ["[data-drawer-top]", "#nav"];
const BOTTOM_CHROME = ["[data-drawer-bottom]", "#app-footer", ".expiry-banner"];

// Largest inset from `edge` across the visible chrome. Height rather than
// offsetParent as the visibility test: offsetParent is null for position:fixed
// elements, which is exactly what the nav and footer are.
function chromeInset(selectors, edge) {
  let inset = 0;
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      inset = Math.max(inset, edge === "top" ? rect.bottom : window.innerHeight - rect.top);
    }
  }
  // A view whose chrome fills the window would otherwise collapse the drawer to
  // nothing; leave it at least half the height to land in.
  return Math.min(Math.max(0, Math.round(inset)), Math.round(window.innerHeight / 4));
}

export async function openIssueDrawer(issueKey, creds) {
  openDrawer?.close();

  const overlay = document.createElement("div");
  overlay.className = "issue-drawer-overlay";
  const panel = document.createElement("div");
  panel.className = "issue-drawer";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `Issue ${issueKey}`);

  const closeBtn = document.createElement("button");
  closeBtn.className = "issue-drawer-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (Esc)";
  panel.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "issue-detail-scroll";
  body.innerHTML = '<div class="spinner" style="height:180px"></div>';
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Re-measured on resize because standup's top bar wraps its controls onto a
  // second row at narrow widths, which moves the band.
  function applyBounds() {
    overlay.style.setProperty("--drawer-top", `${chromeInset(TOP_CHROME, "top")}px`);
    overlay.style.setProperty("--drawer-bottom", `${chromeInset(BOTTOM_CHROME, "bottom")}px`);
  }
  applyBounds();
  window.addEventListener("resize", applyBounds);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", applyBounds);
    window.removeEventListener("hashchange", close);
    openDrawer = null;
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  // The nav stays clickable behind the drawer now, so a view change has to take
  // the drawer with it rather than leaving it floating over the new view.
  window.addEventListener("hashchange", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);
  openDrawer = { close };

  await renderIssueInto(body, issueKey, creds, { mode: "drawer" });
  return { close };
}

// Shared entry point for both containers.
export async function renderIssueInto(container, issueKey, creds, { mode = "page" } = {}) {
  container.innerHTML = '<div class="spinner" style="height:180px"></div>';
  let issue;
  let comments = [];
  try {
    issue = await getIssue(issueKey, creds);
    comments = await getIssueComments(issueKey, creds).catch(() => []);
  } catch (err) {
    container.innerHTML = "";
    const error = document.createElement("div");
    error.className = "issue-error";
    error.textContent = String(err.message || err).includes("404")
      ? `${issueKey} not found, or your account cannot see it.`
      : `Could not load ${issueKey}: ${err.message || err}`;
    container.appendChild(error);
    return;
  }

  container.innerHTML = "";
  const root = document.createElement("article");
  root.className = `issue-detail issue-detail-${mode}`;
  root.appendChild(renderHeader(issue, creds, mode));
  root.appendChild(renderContent(issue));
  const links = renderLinkedIssues(issue, creds);
  if (links) root.appendChild(links);
  root.appendChild(renderComments(issue, comments, creds));
  container.appendChild(root);
}

// ── Header ───────────────────────────────────────────────────────────────────

function renderHeader(issue, creds, mode) {
  const f = issue.fields;
  const header = document.createElement("header");
  header.className = "issue-header";

  const topRow = document.createElement("div");
  topRow.className = "issue-header-top";

  const keyLink = document.createElement("a");
  keyLink.className = "issue-detail-key mono";
  keyLink.textContent = issue.key;
  keyLink.href = browseUrl(issue.key);
  keyLink.target = "_blank";
  keyLink.rel = "noopener";
  keyLink.title = "Open in Jira";
  topRow.appendChild(keyLink);

  topRow.appendChild(statusBadge(f.status));

  const type = document.createElement("span");
  type.className = "issue-type-chip mono";
  if (f.issuetype?.iconUrl) {
    const icon = document.createElement("img");
    icon.src = f.issuetype.iconUrl;
    icon.alt = "";
    icon.className = "issue-type-icon";
    icon.addEventListener("error", () => icon.remove());
    type.appendChild(icon);
  }
  type.append(f.issuetype?.name || "—");
  topRow.appendChild(type);

  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  topRow.appendChild(spacer);

  // Escape hatch from the drawer to the full page.
  if (mode === "drawer") {
    const expand = document.createElement("a");
    expand.className = "issue-header-link mono";
    expand.href = issuePageUrl(issue.key);
    expand.target = "_blank";
    expand.rel = "noopener";
    expand.textContent = "Full page ↗";
    topRow.appendChild(expand);
  }

  const jiraLink = document.createElement("a");
  jiraLink.className = "issue-header-link mono";
  jiraLink.href = browseUrl(issue.key);
  jiraLink.target = "_blank";
  jiraLink.rel = "noopener";
  jiraLink.textContent = "Open in Jira ↗";
  topRow.appendChild(jiraLink);

  header.appendChild(topRow);

  const summary = document.createElement("h1");
  summary.className = "issue-summary";
  summary.textContent = f.summary || "(no summary)";
  header.appendChild(summary);

  const parentRow = renderParentRow(issue, creds);
  if (parentRow) header.appendChild(parentRow);

  if (f.project) {
    const project = document.createElement("div");
    project.className = "issue-project";
    const link = document.createElement("a");
    link.className = "mono";
    link.href = browseUrl(f.project.key);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = f.project.key;
    link.title = `Open project ${f.project.name || f.project.key} in Jira`;
    project.append("Project: ", link);
    if (f.project.name) project.append(` · ${f.project.name}`);
    header.appendChild(project);
  }

  return header;
}

function renderParentRow(issue, creds) {
  const parent = issue.fields?.parent;
  if (!parent) return null;

  const row = document.createElement("div");
  row.className = "issue-parent";

  const label = document.createElement("span");
  label.className = "issue-parent-label mono";
  label.textContent = parent.fields?.issuetype?.name || "Parent";
  row.appendChild(label);

  const link = document.createElement("a");
  link.className = "issue-key mono";
  link.textContent = parent.key;
  attachIssueOpener(link, parent.key, creds);
  row.appendChild(link);

  const summary = parent.fields?.summary || "";
  if (summary) {
    const text = document.createElement("span");
    text.className = "issue-parent-summary";
    text.textContent = summary.length > 70 ? `${summary.slice(0, 70)}…` : summary;
    text.title = summary;
    row.appendChild(text);
  }
  return row;
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = "issue-status-badge";
  const name = status?.name || "Unknown";
  const color =
    STATUS_CATEGORY_COLORS[status?.statusCategory?.key] || "var(--muted)";
  badge.style.color = color;
  badge.style.borderColor = color;
  badge.textContent = name;
  return badge;
}

// ── Content ──────────────────────────────────────────────────────────────────

function renderContent(issue) {
  const f = issue.fields;
  const section = document.createElement("section");
  section.className = "issue-content";

  const meta = document.createElement("div");
  meta.className = "issue-meta-grid";
  const points = getStoryPoints(issue);
  const rows = [
    ["Assignee", personCell(f.assignee)],
    ["Reporter", personCell(f.reporter)],
    ["Start date", textCell(getStartDate(issue) ? fmtDate(getStartDate(issue)) : "—")],
    ["Due date", dueDateCell(f.duedate)],
    ["Story points", textCell(points === null ? "—" : String(points))],
    ["Sprint", textCell(sprintLabel(issue))],
  ];
  for (const [label, valueEl] of rows) {
    const cell = document.createElement("div");
    cell.className = "issue-meta-cell";
    const key = document.createElement("div");
    key.className = "issue-meta-label mono";
    key.textContent = label;
    cell.append(key, valueEl);
    meta.appendChild(cell);
  }
  section.appendChild(meta);

  const descHeading = document.createElement("h2");
  descHeading.className = "issue-section-title mono";
  descHeading.textContent = "Description";
  section.appendChild(descHeading);

  const description = document.createElement("div");
  description.className = "issue-description rich-text";
  const html = issue.renderedFields?.description;
  if (html && String(html).trim()) {
    description.appendChild(sanitizeToFragment(html, { base: CONFIG.site.baseUrl }));
  } else if (f.description) {
    // No renderedFields (older instance, or expand refused): fall back to the
    // ADF's text so the description isn't simply missing.
    const pre = document.createElement("p");
    pre.className = "issue-description-plain";
    pre.textContent = adfToPlainText(f.description).trim() || "(no description)";
    description.appendChild(pre);
  } else {
    description.appendChild(emptyNote("No description."));
  }
  section.appendChild(description);

  return section;
}

function personCell(person) {
  const wrap = document.createElement("div");
  wrap.className = "issue-person";
  if (!person) {
    wrap.appendChild(document.createTextNode("Unassigned"));
    wrap.classList.add("muted");
    return wrap;
  }
  const avatarUrl =
    avatarOverrideFor(person.accountId) ||
    person.avatarUrls?.["24x24"] ||
    person.avatarUrls?.["16x16"];
  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "issue-avatar";
    img.src = avatarUrl;
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    wrap.appendChild(img);
  }
  wrap.append(assigneeLabel(person));
  return wrap;
}

function textCell(text) {
  const el = document.createElement("div");
  el.className = "issue-meta-value";
  el.textContent = text;
  if (text === "—") el.classList.add("muted");
  return el;
}

function dueDateCell(duedate) {
  const el = textCell(duedate ? `${fmtDate(duedate)} · ${relDate(duedate)}` : "—");
  if (duedate) {
    const overdue = new Date(duedate).getTime() < Date.now();
    if (overdue) el.classList.add("overdue");
  }
  return el;
}

// The sprint field is an array; the active one is what matters, but a carried
// issue also carries its closed sprints, which is useful context.
export function sprintLabel(issue) {
  const value = fieldValue(issue, "sprint");
  if (!value) return "—";
  const list = Array.isArray(value) ? value : [value];
  const names = list
    .map((entry) => {
      if (typeof entry === "string") {
        // Older Jira returns a serialised blob with name=... inside it.
        const match = /name=([^,\]]+)/.exec(entry);
        return match ? match[1] : null;
      }
      return entry?.name ? `${entry.name}${entry.state === "closed" ? " (closed)" : ""}` : null;
    })
    .filter(Boolean);
  return names.length ? names.join(" · ") : "—";
}

// ── Linked issues ────────────────────────────────────────────────────────────

function renderLinkedIssues(issue, creds) {
  const links = issue.fields?.issuelinks || [];
  const subtasks = issue.fields?.subtasks || [];
  if (!links.length && !subtasks.length) return null;

  const section = document.createElement("section");
  section.className = "issue-links";

  const heading = document.createElement("h2");
  heading.className = "issue-section-title mono";
  heading.textContent = "Linked issues";
  section.appendChild(heading);

  // Group by relationship so "blocks" and "is blocked by" read correctly.
  const groups = new Map();
  for (const link of links) {
    const related = link.outwardIssue || link.inwardIssue;
    if (!related) continue;
    const label = link.outwardIssue
      ? link.type?.outward || "relates to"
      : link.type?.inward || "relates to";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(related);
  }
  if (subtasks.length) groups.set("has sub-task", subtasks);

  for (const [label, related] of groups) {
    const group = document.createElement("div");
    group.className = "issue-link-group";

    const groupLabel = document.createElement("div");
    groupLabel.className = "issue-link-label mono";
    groupLabel.textContent = label;
    group.appendChild(groupLabel);

    for (const rel of related) {
      group.appendChild(linkedRow(rel, creds));
    }
    section.appendChild(group);
  }
  return section;
}

function linkedRow(related, creds) {
  const row = document.createElement("div");
  row.className = "issue-link-row";

  const key = document.createElement("a");
  key.className = "issue-key mono";
  key.textContent = related.key;
  attachIssueOpener(key, related.key, creds);
  row.appendChild(key);

  row.appendChild(statusBadge(related.fields?.status));

  const summary = document.createElement("span");
  summary.className = "issue-link-summary";
  const text = related.fields?.summary || "";
  summary.textContent = text.length > 70 ? `${text.slice(0, 70)}…` : text;
  summary.title = text;
  row.appendChild(summary);

  return row;
}

// ── Comments ─────────────────────────────────────────────────────────────────

function renderComments(issue, comments, creds) {
  const section = document.createElement("section");
  section.className = "issue-comments";

  const heading = document.createElement("h2");
  heading.className = "issue-section-title mono";
  heading.textContent = `Comments (${comments.length})`;
  section.appendChild(heading);

  const list = document.createElement("div");
  list.className = "issue-comment-list";
  section.appendChild(list);

  if (!comments.length) list.appendChild(emptyNote("No comments yet."));
  for (const comment of comments) list.appendChild(renderComment(comment));

  section.appendChild(renderReplyBox(issue, list, heading, creds));
  return section;
}

function renderComment(comment) {
  const el = document.createElement("div");
  el.className = "issue-comment";

  const head = document.createElement("div");
  head.className = "issue-comment-head";
  head.appendChild(personCell(comment.author));

  const when = document.createElement("span");
  when.className = "issue-comment-when mono";
  when.textContent = comment.created ? relDate(comment.created) : "";
  when.title = comment.created ? new Date(comment.created).toLocaleString() : "";
  head.appendChild(when);

  if (comment.updated && comment.updated !== comment.created) {
    const edited = document.createElement("span");
    edited.className = "issue-comment-edited mono";
    edited.textContent = "edited";
    edited.title = new Date(comment.updated).toLocaleString();
    head.appendChild(edited);
  }
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "issue-comment-body rich-text";
  if (comment.renderedBody && String(comment.renderedBody).trim()) {
    body.appendChild(sanitizeToFragment(comment.renderedBody, { base: CONFIG.site.baseUrl }));
  } else {
    const text = document.createElement("p");
    text.textContent = adfToPlainText(comment.body).trim() || "(empty comment)";
    body.appendChild(text);
  }
  el.appendChild(body);
  return el;
}

function renderReplyBox(issue, list, heading, creds) {
  const wrap = document.createElement("div");
  wrap.className = "issue-reply";

  const textarea = document.createElement("textarea");
  textarea.className = "issue-reply-input";
  textarea.rows = 3;
  textarea.placeholder = "Write a comment… (⌘/Ctrl + Enter to post)";
  wrap.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "issue-reply-actions";

  const status = document.createElement("span");
  status.className = "issue-reply-status mono";
  actions.appendChild(status);

  const postBtn = document.createElement("button");
  postBtn.className = "issue-reply-post mono";
  postBtn.textContent = "Comment";
  postBtn.disabled = true;
  actions.appendChild(postBtn);

  wrap.appendChild(actions);

  textarea.addEventListener("input", () => {
    postBtn.disabled = !textarea.value.trim();
  });

  async function post() {
    const doc = textToAdf(textarea.value);
    if (isEmptyAdf(doc)) return;

    postBtn.disabled = true;
    const previousLabel = postBtn.textContent;
    postBtn.textContent = "Posting...";
    status.textContent = "";
    status.className = "issue-reply-status mono";

    try {
      const created = await addIssueComment(issue.key, doc, creds);
      // Render what Jira stored rather than the local draft, so the comment on
      // screen is the comment that exists.
      list.querySelector(".issue-empty-note")?.remove();
      list.appendChild(renderComment(created));
      const count = list.querySelectorAll(".issue-comment").length;
      heading.textContent = `Comments (${count})`;
      textarea.value = "";
      status.textContent = "Posted";
      status.classList.add("ok");
      postBtn.textContent = previousLabel;
    } catch (err) {
      const msg = String(err.message || err);
      postBtn.disabled = false;
      postBtn.textContent = previousLabel;
      status.classList.add("error");
      status.textContent = msg.includes("403")
        ? "Not allowed to comment on this issue"
        : `Failed: ${msg.slice(0, 80)}`;
    }
  }

  postBtn.addEventListener("click", post);
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (textarea.value.trim()) post();
    }
  });

  return wrap;
}

function emptyNote(text) {
  const el = document.createElement("div");
  el.className = "issue-empty-note";
  el.textContent = text;
  return el;
}
