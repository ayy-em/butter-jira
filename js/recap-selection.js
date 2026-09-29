// Which boards and sprints a recap covers, as it travels in a URL.
//
// The recap config screen builds the selection and the recap page reads it, so
// both ends share this one pure module and cannot drift apart.
//
//   recap.html?sprint=12:7938,12:7735,14:801   board 12's sprints 7938 and 7735, board 14's 801
//   recap.html?sprint=7938,7735                those sprint ids on whichever board has them (older links)
//   quarter.html?boards=12,14                  the quarterly overview, those boards only
//
// Board-qualified because a sprint id can be shared by boards on one project:
// an unqualified id matched on two boards would read that sprint's issues
// twice and double every figure in the document.

const ID = /^\d+$/;

// → { pairs: Map<boardId, Set<sprintId>>, bare: Set<sprintId> }
export function parseSprintSelection(param = "") {
  const pairs = new Map();
  const bare = new Set();
  for (const part of String(param || "").split(",")) {
    const text = part.trim();
    const pair = /^(\d+):(\d+)$/.exec(text);
    if (pair) {
      if (!pairs.has(pair[1])) pairs.set(pair[1], new Set());
      pairs.get(pair[1]).add(pair[2]);
    } else if (ID.test(text)) {
      bare.add(text);
    }
  }
  return { pairs, bare };
}

export function isExplicitSelection(selection) {
  return Boolean(selection && (selection.pairs.size || selection.bare.size));
}

// The sprint ids a given board is asked for; empty when none.
export function wantedFor(selection, boardId) {
  const ids = new Set(selection?.bare || []);
  for (const id of selection?.pairs.get(String(boardId)) || []) ids.add(id);
  return ids;
}

// `{ [boardId]: [sprintId, ...] }` → the `sprint` parameter, boards in the
// given order and sprints deduplicated.
export function sprintSelectionParam(byBoard = {}) {
  const parts = [];
  for (const [boardId, sprintIds] of Object.entries(byBoard)) {
    if (!ID.test(String(boardId))) continue;
    for (const id of new Set((sprintIds || []).map(String))) {
      if (ID.test(id)) parts.push(`${boardId}:${id}`);
    }
  }
  return parts.join(",");
}

export function recapHref(byBoard) {
  const param = sprintSelectionParam(byBoard);
  return param ? `recap.html?sprint=${param}` : "";
}

export function parseBoardList(param = "") {
  return [...new Set(String(param || "").split(",").map((p) => p.trim()).filter((p) => ID.test(p)))];
}

export function quarterHref(boardIds = []) {
  const ids = parseBoardList(boardIds.join(","));
  return ids.length ? `quarter.html?boards=${ids.join(",")}` : "quarter.html";
}

// Whether the selected sprints leave calendar gaps between them — sprint 3 and
// sprint 7 of one board, say. The Jira half of a recap counts only the selected
// sprints' issues, but its GitHub half is a date window from the first start to
// the last end, so a gap is time GitHub counts and Jira does not. The document
// says so. A day of slack absorbs a sprint ending Friday and the next starting
// Monday.
const GAP_SLACK_MS = 3 * 86400000;
export function selectionHasGaps(sprints = []) {
  const spans = sprints
    .map((s) => ({
      start: Date.parse(s?.startDate || ""),
      end: Date.parse(s?.completeDate || s?.endDate || ""),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
  let reach = -Infinity;
  for (const span of spans) {
    if (reach !== -Infinity && span.start > reach + GAP_SLACK_MS) return true;
    reach = Math.max(reach, span.end);
  }
  return false;
}
