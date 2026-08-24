// Editing an issue's fields — assignee, estimate, due date, summary, sprint.
//
// The counterpart to `issue-move.js`, which owns the one write the board made
// before this milestone: dragging a card is a status change, and status is the
// field Jira will not let you write directly. Everything else is a field write,
// and it lives here so the Kanban, the Backlog, the issue detail and the
// palette all edit through the same optimistic paint, the same rollback and the
// same wording when Jira refuses.
//
// Three rules the milestone asked for, and where each one is:
//
//   - **Optimistic, with rollback.** The value changes on screen first, and the
//     exact previous value is kept to put back. Not a re-fetch: a refused write
//     leaves Jira untouched, so the truth to restore is the one already in hand.
//   - **An undo window on a single edit.** The success toast carries the undo,
//     so its lifetime *is* the window. Undo is a second write of the previous
//     values, not a local revert — the first one succeeded, and pretending
//     otherwise would leave the screen disagreeing with Jira.
//   - **A confirmation on a bulk edit, and no undo.** Ten issues changed at
//     once is not something to offer to reverse in a five-second toast; it is
//     something to ask about first. Each issue is written separately so a
//     refusal names the issue that caused it and the rest still stand.

import { fieldLabel, writeFieldId } from "./config.js";
import {
  moveIssuesToBacklog,
  moveIssuesToSprint,
  updateIssueFields,
} from "./api.js";
import { cache, showToast } from "./utils.js";

// Which field this issue keeps its estimate in, so the caller can paint and roll
// back without knowing what that site calls it. Resolved against the issue
// rather than against the config alone, and the write is given the same issue so
// both end up at the same field — see `writeFieldId` for why a site can have
// two.
export function pointsFieldFor(issue) {
  return writeFieldId("storyPoints", issue);
}

// Current values for the fields a change would touch, in the same shape as the
// change itself — so rollback and undo are both "write this back".
export function currentValues(issue, changes) {
  const previous = {};
  for (const name of Object.keys(changes || {})) {
    switch (name) {
      case "summary":
        previous.summary = issue?.fields?.summary ?? "";
        break;
      case "dueDate":
        previous.dueDate = issue?.fields?.duedate ?? null;
        break;
      case "assignee":
        previous.assignee = issue?.fields?.assignee ?? null;
        break;
      case "storyPoints": {
        const id = pointsFieldFor(issue);
        previous.storyPoints = id ? (issue?.fields?.[id] ?? null) : null;
        break;
      }
      default:
        break;
    }
  }
  return previous;
}

// Paints the change onto the local issue. Mutates, like the drag path does:
// every view holds the same issue objects, so one assignment repaints all of
// them and there is no second copy to fall out of step.
export function applyValues(issue, changes) {
  if (!issue?.fields) return issue;
  for (const [name, value] of Object.entries(changes || {})) {
    switch (name) {
      case "summary":
        issue.fields.summary = String(value ?? "");
        break;
      case "dueDate":
        issue.fields.duedate = value || null;
        break;
      // An assignee may arrive as a whole person (from a picker, with a name and
      // a photo to paint) or as a bare account id (from a keyboard action, where
      // that is all the caller has). Only the id is ever sent to Jira.
      case "assignee":
        issue.fields.assignee = value
          ? typeof value === "string"
            ? { accountId: value, displayName: "" }
            : value
          : null;
        break;
      case "storyPoints": {
        const id = pointsFieldFor(issue);
        if (id) issue.fields[id] = value === null || value === "" ? null : Number(value);
        break;
      }
      default:
        break;
    }
  }
  return issue;
}

// Wording for the toast: what changed, in the site's own names for the fields.
// Values rather than field names alone, because "Story points 3 → 5" is the
// sentence that lets someone spot a mistake in time to undo it.
export function describeChanges(changes, previous = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(changes || {})) {
    const label = LABELS[name] || fieldLabel(name);
    const to = displayValue(name, value);
    // A key missing from `previous` means the old value was never captured — a
    // bulk edit, where the issues disagree about it. That is not the same as an
    // old value of null, which is a real "cleared → something" and worth saying.
    const known = Object.prototype.hasOwnProperty.call(previous || {}, name);
    const from = known ? displayValue(name, previous[name]) : "";
    parts.push(from && from !== to ? `${label} ${from} → ${to}` : `${label} ${to}`);
  }
  return parts.join(", ");
}

const LABELS = {
  summary: "Summary",
  dueDate: "Due date",
  assignee: "Assignee",
  storyPoints: "Story points",
};

function displayValue(name, value) {
  if (value === null || value === undefined || value === "") return "cleared";
  if (name === "assignee") {
    if (typeof value === "string") return value;
    return value.displayName || value.accountId || "cleared";
  }
  return String(value);
}

// `repaint` re-renders whatever the caller owns; `creds` is the same object
// every read uses. Both are the drag path's contract, kept identical so a view
// wires the two writers up the same way.
export function createFieldEditor({ creds, repaint = () => {} }) {
  const inFlight = new Set();

  // Sends the change and paints it, or puts the old values back and says why.
  // Returns whether Jira took it, so callers that need to know (a form staying
  // open on failure) can ask.
  async function write(issue, changes, { undo = true } = {}) {
    if (!issue?.key || !changes || !Object.keys(changes).length) return false;
    if (inFlight.has(issue.key)) return false;

    const previous = currentValues(issue, changes);
    inFlight.add(issue.key);
    applyValues(issue, changes);
    repaint();

    try {
      await updateIssueFields(issue.key, apiChanges(changes), creds, { issue });
      // Only this issue's board went stale.
      await cache.dropBoard(issue.boardId);
      repaint();
      showToast(
        `${issue.key}: ${describeChanges(changes, previous)}`,
        false,
        undo
          ? {
              label: "Undo",
              run: () => write(issue, previous, { undo: false }),
            }
          : null
      );
      return true;
    } catch (err) {
      applyValues(issue, previous);
      repaint();
      reportFailure(issue.key, err);
      return false;
    } finally {
      inFlight.delete(issue.key);
    }
  }

  // Bulk. Confirmed once, then written issue by issue: Jira has no batch field
  // write, and doing them in parallel would make a partial failure impossible
  // to describe. What the user gets instead is a count of what landed and the
  // first reason it stopped being all of them.
  async function writeMany(issues, changes, { confirmFirst = true } = {}) {
    const targets = (issues || []).filter((i) => i?.key);
    if (!targets.length || !changes || !Object.keys(changes).length) return false;
    if (targets.length === 1) return write(targets[0], changes);

    const summary = describeChanges(changes);
    if (
      confirmFirst &&
      !confirm(`Set ${summary} on ${targets.length} issues?\n\nThis cannot be undone from here.`)
    ) {
      return false;
    }

    const restore = new Map(targets.map((i) => [i.key, currentValues(i, changes)]));
    for (const issue of targets) applyValues(issue, changes);
    repaint();

    const failed = [];
    const boards = new Set();
    for (const issue of targets) {
      try {
        await updateIssueFields(issue.key, apiChanges(changes), creds, { issue });
        boards.add(issue.boardId);
      } catch (err) {
        applyValues(issue, restore.get(issue.key) || {});
        failed.push({ key: issue.key, err });
      }
    }
    for (const boardId of boards) await cache.dropBoard(boardId);
    repaint();

    const done = targets.length - failed.length;
    if (!failed.length) {
      showToast(`${summary} on ${done} issues`);
    } else if (authError(failed[0].err)) {
      return false; // the router's reauth flow owns this
    } else {
      showToast(
        `${summary} on ${done} of ${targets.length} — ${failed[0].key}: ${failed[0].err.message}` +
          (failed.length > 1 ? ` (and ${failed.length - 1} more)` : ""),
        true
      );
    }
    return !failed.length;
  }

  // Sprint membership goes through the agile endpoint rather than a field write
  // (see `moveIssuesToSprint`), so it gets its own path: no optimistic paint,
  // because the Sprint field's local shape varies by site and a wrong guess
  // would show a sprint the issue is not in. The caller refreshes instead.
  async function moveToSprint(issues, sprint) {
    const keys = (issues || []).map((i) => i?.key).filter(Boolean);
    if (!keys.length || !sprint?.id) return false;
    const name = sprint.name || `sprint ${sprint.id}`;
    if (keys.length > 1 && !confirm(`Move ${keys.length} issues into ${name}?`)) return false;

    try {
      await moveIssuesToSprint(sprint.id, keys, creds);
      for (const boardId of new Set((issues || []).map((i) => i.boardId))) {
        await cache.dropBoard(boardId);
      }
      showToast(`${keys.length === 1 ? keys[0] : `${keys.length} issues`} → ${name}`);
      return true;
    } catch (err) {
      reportFailure(keys.length === 1 ? keys[0] : `${keys.length} issues`, err);
      return false;
    }
  }

  async function moveToBacklog(issues) {
    const keys = (issues || []).map((i) => i?.key).filter(Boolean);
    if (!keys.length) return false;
    if (keys.length > 1 && !confirm(`Move ${keys.length} issues out of their sprint?`)) return false;

    try {
      await moveIssuesToBacklog(keys, creds);
      for (const boardId of new Set((issues || []).map((i) => i.boardId))) {
        await cache.dropBoard(boardId);
      }
      showToast(`${keys.length === 1 ? keys[0] : `${keys.length} issues`} → backlog`);
      return true;
    } catch (err) {
      reportFailure(keys.length === 1 ? keys[0] : `${keys.length} issues`, err);
      return false;
    }
  }

  return { write, writeMany, moveToSprint, moveToBacklog };
}

// Only the account id crosses the wire; the rest of a person object exists for
// the optimistic paint.
function apiChanges(changes) {
  const out = { ...changes };
  if ("assignee" in out) {
    const value = out.assignee;
    out.assignee = value && typeof value === "object" ? value.accountId ?? null : value ?? null;
  }
  return out;
}

function authError(err) {
  return String(err?.message || err).includes("401");
}

function reportFailure(subject, err) {
  if (authError(err)) return; // the router's reauth flow owns this
  const detail = err?.message || String(err);
  showToast(
    err?.isPermission
      ? `${subject}: ${detail}`
      : `${subject} could not be saved — ${detail}`,
    true
  );
}
