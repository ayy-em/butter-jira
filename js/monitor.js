// Sprint hygiene checks.
//
// Pure derivation over issues the views already fetch — no new endpoints, no
// extra requests. Each check answers one question a lead would otherwise ask by
// eye at planning time.
//
// Type exclusions are deliberate and stated in the UI, because a check that
// silently flags every sub-task is a check people learn to ignore:
//   - sub-tasks hang off a story, so they have no epic of their own and
//     inherit their parent's dates and estimate;
//   - epics are the parent, so "no epic parent" is meaningless for them, and
//     undated epics are already called out in the Roadmap view.

import { getEpicKey, getStoryPoints } from "./utils.js";
import { fieldIds } from "./config.js";

// Jira marks sub-tasks with a boolean on the issue type, and (on newer
// instances) a hierarchy level: 1 = epic, 0 = standard, -1 = sub-task.
export function isSubtask(issue) {
  const type = issue?.fields?.issuetype;
  if (!type) return false;
  if (type.subtask === true) return true;
  if (typeof type.hierarchyLevel === "number") return type.hierarchyLevel < 0;
  return /^sub-?task$/i.test(type.name || "");
}

export function isEpic(issue) {
  const type = issue?.fields?.issuetype;
  if (!type) return false;
  if (typeof type.hierarchyLevel === "number") return type.hierarchyLevel >= 1;
  return /^epic$/i.test(type.name || "");
}

function isDone(issue) {
  const category = issue?.fields?.status?.statusCategory?.key;
  if (category) return category === "done";
  return /^(done|closed|resolved|rejected)$/i.test(issue?.fields?.status?.name || "");
}

export const MONITOR_CHECKS = [
  {
    id: "unassigned",
    label: "Unassigned",
    question: "Who is picking this up?",
    scopeNote: "excludes epics and anything already done",
    detect: (issue) => !issue.fields?.assignee,
    applies: (issue) => !isEpic(issue) && !isDone(issue),
  },
  {
    id: "noEpic",
    label: "No epic parent",
    question: "Which piece of work does this belong to?",
    scopeNote: "excludes epics, sub-tasks and anything already done",
    detect: (issue) => !getEpicKey(issue),
    applies: (issue) => !isEpic(issue) && !isSubtask(issue) && !isDone(issue),
    // Team-managed projects link epics through `parent`, which getEpicKey also
    // reads — so this still works unmapped, just less reliably on
    // company-managed projects that use the Epic Link custom field.
    caveat: () =>
      fieldIds("epicLink").length
        ? null
        : "epic link field not mapped — relying on the parent field only",
  },
  {
    id: "noDueDate",
    label: "No due date",
    question: "When is this expected to land?",
    scopeNote: "excludes epics, sub-tasks and anything already done",
    detect: (issue) => !issue.fields?.duedate,
    applies: (issue) => !isEpic(issue) && !isSubtask(issue) && !isDone(issue),
  },
  {
    id: "noPoints",
    label: "No story points",
    question: "How big is this?",
    scopeNote: "excludes epics, sub-tasks and anything already done",
    detect: (issue) => getStoryPoints(issue) === null,
    applies: (issue) => !isEpic(issue) && !isSubtask(issue) && !isDone(issue),
    // Without a mapped field there is nothing to read, and every issue would
    // look unestimated. A check that flags everything teaches people to ignore
    // it, so report it as unavailable instead.
    unavailable: () =>
      fieldIds("storyPoints").length
        ? null
        : "no story points field mapped — set one in Settings > Field mapping",
  },
];

export function checkById(id) {
  return MONITOR_CHECKS.find((c) => c.id === id) || null;
}

// Every check on unless explicitly muted, so a Jira site that starts using a
// field later doesn't need a settings change to be watched.
export function isCheckEnabled(settings, id) {
  return settings?.[id] !== false;
}

// Returns one section per enabled check, in declaration order.
// `issues` is already scope- and roster-filtered by the caller.
export function runChecks(issues, settings = {}) {
  const list = Array.isArray(issues) ? issues : [];
  return MONITOR_CHECKS.filter((check) => isCheckEnabled(settings, check.id)).map((check) => {
    const base = {
      id: check.id,
      label: check.label,
      question: check.question,
      scopeNote: check.scopeNote,
      caveat: check.caveat?.() || null,
    };

    // A check that cannot read its field reports nothing rather than flagging
    // every issue on the board.
    const unavailable = check.unavailable?.() || null;
    if (unavailable) {
      return { ...base, unavailable, considered: 0, issues: [], count: 0 };
    }

    const considered = list.filter((issue) => check.applies(issue));
    const findings = considered.filter((issue) => check.detect(issue));
    return {
      ...base,
      unavailable: null,
      considered: considered.length,
      issues: findings,
      count: findings.length,
    };
  });
}

export function totalFindings(sections) {
  return sections.reduce((sum, section) => sum + section.count, 0);
}

// Cross-section view: issues that trip more than one check are the ones worth
// fixing first, since one edit clears several findings.
export function worstOffenders(sections, limit = 5) {
  const byKey = new Map();
  for (const section of sections) {
    for (const issue of section.issues) {
      const entry = byKey.get(issue.key) || { issue, checks: [] };
      entry.checks.push(section.label);
      byKey.set(issue.key, entry);
    }
  }
  return [...byKey.values()]
    .filter((entry) => entry.checks.length > 1)
    .sort((a, b) => b.checks.length - a.checks.length || a.issue.key.localeCompare(b.issue.key))
    .slice(0, limit);
}

// ── Nav badge ────────────────────────────────────────────────────────────────
// Computed when the Monitor view mounts and remembered for the session, so the
// other tabs can show a count without triggering any extra Jira requests.

let lastCount = null;

export function setBadgeCount(count) {
  lastCount = count;
}

export function getBadgeCount() {
  return lastCount;
}
