// Dragging a card between columns — the one Jira write the board itself makes.
//
// Shared by the Kanban view and the standup board so a card dragged during
// standup behaves exactly like the same card dragged on Kanban: same transition
// matching, same optimistic paint, same rollback and same wording when Jira
// refuses.
//
// Cards show no status text, so which column a card sits in *is* its status and
// dragging it between columns is the whole edit. Jira won't take a status write
// directly though — it needs a workflow transition, and a column is a group of
// statuses rather than one, so the transition is matched against the group's
// statuses at drop time.

import { getIssueTransitions, transitionIssue } from "./api.js";
import { cache, showToast } from "./utils.js";

// `getGroups` is a callback rather than an array because Kanban's group config
// is reassigned wholesale when the column editor saves; `repaint` re-renders
// whatever board the caller owns.
export function createIssueMover({ creds, getGroups, repaint }) {
  const inFlight = new Set();

  return async function moveIssue(issue, toColumnName) {
    if (inFlight.has(issue.key)) return;

    const groups = getGroups() || [];
    const group = groups.find((g) => g.name === toColumnName);
    // Columns that aren't a configured group are named after the status itself.
    const wanted = group?.statuses?.length ? group.statuses : [toColumnName];
    const prevStatus = issue.fields.status;

    inFlight.add(issue.key);
    // Optimistic: the card lands in the new column straight away and goes back
    // if Jira refuses. statusCategory is carried over as a placeholder — it is
    // replaced with the real target status a moment later, and nothing on a card
    // reads it.
    issue.fields.status = { ...prevStatus, name: wanted[0] };
    repaint();

    try {
      const transitions = await getIssueTransitions(issue.key, creds);
      // Prefer the group's first listed status; fall back through the rest.
      const match =
        wanted
          .map((name) =>
            transitions.find((t) => t.toStatus.toLowerCase() === name.toLowerCase())
          )
          .find(Boolean) || null;

      if (!match) {
        issue.fields.status = prevStatus;
        repaint();
        const reachable = transitions.map((t) => t.toStatus).filter(Boolean);
        showToast(
          reachable.length
            ? `${issue.key}: the workflow allows no move from ${prevStatus?.name || "?"} to ${toColumnName} — only ${reachable.join(", ")}`
            : `${issue.key}: your account has no available transitions on this issue`,
          true
        );
        return;
      }

      await transitionIssue(issue.key, match.id, creds);
      issue.fields.status = match.to || { ...prevStatus, name: match.toStatus };
      // Only this issue's board is stale; everything else stays cached.
      await cache.dropBoard(issue.boardId);
      repaint();
      showToast(`${issue.key} → ${match.toStatus}`);
    } catch (err) {
      issue.fields.status = prevStatus;
      repaint();
      const msg = String(err.message || err);
      if (msg.includes("401")) return; // the router's reauth flow owns this
      showToast(`${issue.key} could not be moved — ${msg}`, true);
    } finally {
      inFlight.delete(issue.key);
    }
  };
}
