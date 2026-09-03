// Issue links — the relationships between two issues, as opposed to the
// parent/child one a sub-task has.
//
// Everything here is pure, and it is pure for one reason: **direction is
// silent**. A link created the wrong way round does not fail, does not warn, and
// does not look wrong on the issue you created it from — it looks wrong on the
// other issue, which is the one you were not looking at. So the rule that
// decides which key goes on which side is a function with a test rather than a
// line inside a click handler.
//
// The rule, once, in the terms Jira uses:
//
//     inwardIssue  <type.outward>  outwardIssue
//
// A link type carries two phrasings of one relationship — Blocks has
// `outward: "blocks"` and `inward: "is blocked by"` — and a stored link has an
// inward side and an outward side. Reading it out along the arrow gives
// "inward blocks outward"; reading it back gives "outward is blocked by
// inward". That is also why `GET /issue/{key}` shows `outwardIssue` with the
// outward phrase and `inwardIssue` with the inward one: the issue you asked
// about is standing on the other side of whichever field came back.
//
// So the picker offers phrases, not types-plus-a-toggle: "blocks" and "is
// blocked by" are two choices over one type, because that is how someone says
// what they mean, and the direction falls out of the phrase they picked.

// A relationship phrase the user can choose, and enough to build the payload
// from. `id` is stable and inert — it goes in a <select> value and nowhere near
// a request.
//
// A symmetric type appears once. "Relates" has the same word on both sides, and
// offering "relates to" twice is a picker that looks broken while being
// correct; either choice builds the same link, so the outward one is kept.
export function linkChoices(types = []) {
  const choices = [];
  for (const type of types) {
    const name = String(type?.name || "").trim();
    if (!name) continue;
    const outward = String(type?.outward || "").trim();
    const inward = String(type?.inward || "").trim();
    // A type with neither phrasing is unusable in a picker: there is nothing to
    // put on the option. Jira always sends both, but a site's own type is a
    // site's own data.
    if (!outward && !inward) continue;

    const key = String(type?.id || name);
    if (outward) {
      choices.push({ id: `${key}:outward`, typeName: name, direction: "outward", phrase: outward });
    }
    if (inward && inward.toLowerCase() !== outward.toLowerCase()) {
      choices.push({ id: `${key}:inward`, typeName: name, direction: "inward", phrase: inward });
    }
  }
  return choices;
}

// The body for `POST /rest/api/3/issueLink`.
//
// `issueKey` is the issue being looked at, `otherKey` the one picked from the
// search. The chosen phrase reads left to right from `issueKey`, so an outward
// phrase puts it on the inward side of the stored link and an inward phrase
// puts it on the outward side — the inversion this module exists to get right.
export function linkPayloadFor(choice, { issueKey, otherKey } = {}) {
  const from = String(issueKey || "").trim();
  const to = String(otherKey || "").trim();
  if (!choice?.typeName || !from || !to) return null;
  // Jira accepts a link from an issue to itself and then renders it as a loop
  // nobody asked for.
  if (from.toUpperCase() === to.toUpperCase()) return null;

  const outward = choice.direction === "outward";
  return {
    type: { name: choice.typeName },
    inwardIssue: { key: outward ? from : to },
    outwardIssue: { key: outward ? to : from },
  };
}

// The sentence for the confirm, the toast and the picker's own preview —
// always in the direction the user chose, so what they read is what they get.
export function describeLink(choice, issueKey, otherKey) {
  const phrase = choice?.phrase || "relates to";
  return `${issueKey} ${phrase} ${otherKey}`;
}

// ── Reading the links back ──────────────────────────────────────────────────

// The issue's links, grouped by how they read from this issue, with the link id
// kept so a row can be removed.
//
// Sub-tasks join the same list because they render in the same section, but
// they are marked unremovable: a sub-task is a parent/child relationship, not an
// issue link, and there is no link id to DELETE. A ✕ on those rows would be a
// button that can only ever fail.
export function groupedLinks(issue) {
  const groups = [];
  const byLabel = new Map();

  function add(label, row) {
    let group = byLabel.get(label);
    if (!group) {
      group = { label, rows: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  for (const link of issue?.fields?.issuelinks || []) {
    const related = link?.outwardIssue || link?.inwardIssue;
    if (!related?.key) continue;
    const outward = Boolean(link.outwardIssue);
    const label =
      (outward ? link.type?.outward : link.type?.inward) || "relates to";
    add(label, {
      key: related.key,
      issue: related,
      relationship: label,
      linkId: link.id === undefined || link.id === null ? "" : String(link.id),
      // An old or partial response without an id still renders; it just cannot
      // offer a remove it has no way to make.
      removable: link.id !== undefined && link.id !== null && String(link.id) !== "",
    });
  }

  for (const subtask of issue?.fields?.subtasks || []) {
    if (!subtask?.key) continue;
    add("has sub-task", {
      key: subtask.key,
      issue: subtask,
      relationship: "has sub-task",
      linkId: "",
      removable: false,
    });
  }

  return groups;
}

// Keys already linked from this issue, plus the issue itself — what the picker
// filters out of its results, because offering a link that already exists is
// offering a 400.
export function alreadyLinked(issue) {
  const keys = new Set();
  if (issue?.key) keys.add(String(issue.key).toUpperCase());
  for (const group of groupedLinks(issue)) {
    for (const row of group.rows) keys.add(String(row.key).toUpperCase());
  }
  return keys;
}

// ── The search behind the picker ────────────────────────────────────────────

// A raw key field is a typo waiting to 400, so the picker searches instead —
// the same `searchIssuesByJql` the command palette's issue lookup runs on, with
// a different destination.
//
// Two shapes, because people type both: something that looks like an issue key
// is looked up as one, and everything else is a summary search. Not OR'd
// together — a key match is unambiguous, and diluting it with text hits would
// push the exact answer down the list.
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// Shorter than this and the wildcard matches most of the backlog, which is a
// long list arriving on every keystroke rather than an answer.
export const MIN_QUERY = 2;

export function pickerJql(query, { excludeKey = "" } = {}) {
  const text = String(query ?? "").trim();
  if (text.length < MIN_QUERY) return "";

  const clauses = [];
  if (KEY_RE.test(text)) {
    clauses.push(`key = "${escapeJql(text.toUpperCase())}"`);
  } else {
    // Trailing wildcard so the list narrows as you type rather than only
    // answering whole words.
    clauses.push(`summary ~ "${escapeJql(text)}*"`);
  }
  if (excludeKey) clauses.push(`key != "${escapeJql(excludeKey)}"`);
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

// JQL string literals escape a backslash and a quote with a backslash. Newlines
// are flattened rather than escaped: they cannot survive a single-line quoted
// value, and a pasted multi-line string is a paste accident, not a query.
export function escapeJql(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}
