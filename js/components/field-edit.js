// Click-to-edit cells for the fields M8a can write: assignee, story points and
// due date.
//
// The shape is the same for all three, and it is the drag path's shape rather
// than a form's: the value on screen is the thing you click, editing happens in
// place, and the write is optimistic — `js/issue-edit.js` paints, sends, and
// puts the old value back if Jira refuses. So these widgets carry no error
// handling of their own. They collect a value, hand it over, and close.
//
// Escape cancels, Enter commits, and clicking away commits too — a cell that
// discarded an edit on blur would lose typing to a stray click, which is worse
// than the occasional unintended save an undo can reverse.

import { activeMembers, avatarOverrideFor, memberLabel } from "../team.js";
import { assigneeLabel, fmtDate, relDate } from "../utils.js";

// A number field that is allowed to be empty, because "no estimate" is a real
// and common state and has to be distinguishable from zero points.
//
// Returns `undefined` for input that is not a number at all, which the caller
// treats as "leave it alone" — the alternative is writing NaN to Jira, or worse,
// silently clearing an estimate because someone typed a letter.
export function parsePointsInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

// Jira stores a due date as a plain ISO day with no time or zone, which is also
// exactly what `<input type="date">` produces. Anything else is rejected here
// rather than sent for Jira to reject.
export function parseDateInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

// True when the two values mean the same thing, so clicking into a cell and
// clicking out again does not fire a write. Compared loosely on purpose: an
// estimate read back as "5" and typed as 5 is not a change.
export function unchanged(before, after) {
  if (before === after) return true;
  if (before === null || before === undefined) return after === null || after === undefined;
  return String(before) === String(after);
}

// ── The cells ───────────────────────────────────────────────────────────────

// `commit(value)` resolves to whether Jira took it. The cell closes either way:
// a refusal has already been rolled back and toasted by the editor, and holding
// an input open over a value that no longer exists would be a second lie.
function editableCell({ className = "", display, editor, onEdit }) {
  const cell = document.createElement("div");
  cell.className = `issue-meta-value editable-cell ${className}`.trim();
  cell.tabIndex = 0;
  cell.title = "Click to edit";

  let editing = false;

  function paint() {
    cell.textContent = "";
    cell.classList.remove("editing");
    cell.appendChild(display());
  }

  function open() {
    if (editing) return;
    editing = true;
    cell.textContent = "";
    cell.classList.add("editing");
    cell.appendChild(editor(close));
    onEdit?.(cell);
  }

  function close() {
    editing = false;
    paint();
  }

  cell.addEventListener("click", (e) => {
    if (editing) return;
    e.stopPropagation();
    open();
  });
  cell.addEventListener("keydown", (e) => {
    if (!editing && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open();
    }
  });

  paint();
  return cell;
}

// Text-ish cells (points, date) share their whole interaction; only the input
// type, the parser and the display differ.
function inputCell({
  type, value, format, parse, commit, placeholder = "", className = "", mark = null,
}) {
  return editableCell({
    className,
    display: () => {
      const span = document.createElement("span");
      const shown = format(value);
      span.textContent = shown;
      if (shown === "—") span.className = "muted";
      mark?.(value, span);
      return span;
    },
    editor: (close) => {
      const input = document.createElement("input");
      input.className = "cell-input mono";
      input.type = type;
      input.value = value === null || value === undefined ? "" : String(value);
      if (placeholder) input.placeholder = placeholder;
      let settled = false;

      const settle = async (save) => {
        if (settled) return;
        settled = true;
        const parsed = save ? parse(input.value) : undefined;
        close();
        // `undefined` is "unusable input" from the parser and "cancelled" from
        // Escape — both mean leave Jira alone.
        if (parsed === undefined || unchanged(value, parsed)) return;
        const took = await commit(parsed);
        if (took) value = parsed;
      };

      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") settle(true);
        if (e.key === "Escape") settle(false);
      });
      input.addEventListener("blur", () => settle(true));
      // Focus after the caller has put the input in the document.
      setTimeout(() => {
        input.focus();
        input.select?.();
      }, 0);
      return input;
    },
  });
}

export function pointsCell({ value, commit }) {
  return inputCell({
    type: "text",
    value,
    format: (v) => (v === null || v === undefined ? "—" : String(v)),
    parse: parsePointsInput,
    commit,
    placeholder: "—",
  });
}

export function dateCell({ value, commit }) {
  return inputCell({
    type: "date",
    value,
    format: (v) => (v ? `${fmtDate(v)} · ${relDate(v)}` : "—"),
    parse: parseDateInput,
    commit,
    className: "date-cell",
    // A date in the past reads red, as it did before the cell became editable.
    // Kept with the formatting rather than with the caller so it survives the
    // repaint that follows a successful write.
    mark: (v, span) => {
      if (v && new Date(v).getTime() < Date.now()) span.classList.add("overdue");
    },
  });
}

// The assignee picker offers the roster, because the roster is the app's own
// answer to "who is on this team" and needs no permission to read. Directory
// search is deliberately not wired in here: `searchUsers` needs the "Browse
// users and groups" global permission, which plenty of sites keep to admins, so
// a picker built on it would be empty on exactly the sites where it looked like
// it should work. Someone outside the roster is assigned in Jira, or added to
// the roster first — where the app already has a search that degrades honestly.
export function assigneeCell({ person, commit }) {
  let current = person;
  return editableCell({
    className: "assignee-cell",
    display: () => renderPerson(current),
    editor: (close) => {
      const select = document.createElement("select");
      select.className = "cell-input mono";

      const unassigned = document.createElement("option");
      unassigned.value = "";
      unassigned.textContent = "Unassigned";
      select.appendChild(unassigned);

      const members = activeMembers();
      // The current assignee may not be on the roster — a colleague from
      // another team, or someone who left it. Keeping them as an option means
      // opening the picker and closing it cannot quietly reassign their work.
      const known = new Set(members.map((m) => m.accountId));
      const options = [...members];
      if (current?.accountId && !known.has(current.accountId)) {
        options.unshift({
          accountId: current.accountId,
          jiraName: current.displayName || current.accountId,
        });
      }
      for (const member of options) {
        const option = document.createElement("option");
        option.value = member.accountId;
        option.textContent = memberLabel(member) || member.jiraName || member.accountId;
        select.appendChild(option);
      }
      select.value = current?.accountId || "";

      let settled = false;
      const settle = async (save) => {
        if (settled) return;
        settled = true;
        const chosen = save ? select.value : null;
        close();
        if (!save || unchanged(current?.accountId || "", chosen || "")) return;
        const member = options.find((m) => m.accountId === chosen);
        const next = chosen
          ? {
              accountId: chosen,
              displayName: member?.jiraName || member?.name || chosen,
              avatarUrls: current?.accountId === chosen ? current.avatarUrls : undefined,
            }
          : null;
        const took = await commit(next);
        if (took) current = next;
      };

      select.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") settle(false);
        if (e.key === "Enter") settle(true);
      });
      select.addEventListener("change", () => settle(true));
      select.addEventListener("blur", () => settle(false));
      setTimeout(() => select.focus(), 0);
      return select;
    },
  });
}

function renderPerson(person) {
  const wrap = document.createElement("span");
  wrap.className = "issue-person";
  if (!person) {
    wrap.classList.add("muted");
    wrap.textContent = "Unassigned";
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
