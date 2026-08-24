// The create-issue panel: one form, three ways in.
//
//   - the command palette's "Create issue" action
//   - the Backlog toolbar's + button
//   - the issue detail's "Add sub-task", which opens the same panel with the
//     parent fixed and the issue type forced to the project's sub-task type
//
// Every row in it comes from `/rest/api/3/issue/createmeta` by way of
// `js/issue-create.js` — nothing about the form is written here, because which
// fields a new issue needs is a question only the site can answer. What this
// file owns is the chrome: the two pickers that decide *which* createmeta to
// read, the controls for the rows that come back, and what happens when Jira
// refuses.

import { BOARDS, cache, showToast } from "../utils.js";
import {
  createIssue,
  getActiveSprint,
  getCreateFields,
  getCreateIssueTypes,
  getEpicNames,
} from "../api.js";
import { activeMembers, memberLabel } from "../team.js";
import {
  CONTROLS,
  buildCreatePayload,
  creatableTypes,
  formSpecFrom,
  initialValues,
  missingRequired,
  subtaskTypeFrom,
} from "../issue-create.js";
import { openDrawerPanel } from "./drawer.js";

// Boards carry the project key; a project with no key configured cannot be
// posted to, so it is not offered.
function projectOptions() {
  const seen = new Map();
  for (const board of BOARDS) {
    const key = board.projectKey || board.name;
    if (!key || seen.has(key)) continue;
    seen.set(key, { key, label: board.name || key, boardId: board.id });
  }
  return [...seen.values()];
}

// `parent` opens the sub-task form: the type is the project's discovered
// sub-task type and the project is the parent's own, so neither is a choice.
// `onCreated` receives Jira's response so a caller can re-render from it.
export async function openCreateIssue(creds, { parentKey = "", parentSummary = "", projectKey = "", onCreated = null } = {}) {
  const subtaskMode = Boolean(parentKey);
  const projects = projectOptions();
  const initialProject =
    (subtaskMode ? projectKeyOf(parentKey) : projectKey) || projects[0]?.key || "";

  const { body, close } = openDrawerPanel({
    label: subtaskMode ? `New sub-task of ${parentKey}` : "New issue",
    className: "create-drawer",
  });

  if (!projects.length) {
    body.appendChild(
      note(
        "No project to create in — the configured boards carry no project key. " +
          "Add one in Settings → Boards."
      )
    );
    return { close };
  }

  const state = {
    projectKey: initialProject,
    typeId: "",
    types: [],
    spec: { rows: [], unsupported: [], omitted: [] },
    values: {},
    boardOptions: { sprints: [], epics: [] },
    loading: false,
    fieldErrors: {},
  };

  const root = document.createElement("form");
  root.className = "create-form";
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  body.appendChild(root);

  await loadTypes();
  render();

  async function loadTypes() {
    state.loading = true;
    render();
    try {
      const types = await getCreateIssueTypes(state.projectKey, creds);
      state.types = subtaskMode
        ? [subtaskTypeFrom(types)].filter(Boolean)
        : creatableTypes(types);
      state.typeId = state.types[0]?.id || "";
      state.error = state.types.length
        ? null
        : subtaskMode
          ? `${state.projectKey} has no sub-task type — sub-tasks are switched off for this project in Jira.`
          : `Your account cannot create issues in ${state.projectKey}.`;
    } catch (err) {
      state.error = `Could not read the field layout for ${state.projectKey}: ${err.message || err}`;
      state.types = [];
    }
    state.loading = false;
    if (state.typeId) await loadFields();
    else render();
  }

  async function loadFields() {
    state.loading = true;
    state.fieldErrors = {};
    render();
    try {
      const descriptors = await getCreateFields(state.projectKey, state.typeId, creds);
      state.spec = formSpecFrom(descriptors);
      state.values = initialValues(state.spec.rows);
      if (state.spec.rows.some((r) => r.needsBoardOptions)) await loadBoardOptions();
    } catch (err) {
      state.error = `Could not read the fields for this issue type: ${err.message || err}`;
    }
    state.loading = false;
    render();
  }

  // Sprint and epic lists are not in createmeta — they belong to the board. Both
  // are optional extras on the form, so a failure here loses two dropdowns and
  // not the panel.
  async function loadBoardOptions() {
    const board = projects.find((p) => p.key === state.projectKey);
    if (!board) return;
    const [sprints, epics] = await Promise.all([
      getActiveSprint(board.boardId, creds).catch(() => []),
      getEpicNames(creds).catch(() => ({})),
    ]);
    state.boardOptions = {
      sprints: sprints.map((s) => ({ id: String(s.id), name: s.name || `Sprint ${s.id}` })),
      epics: Object.entries(epics)
        .filter(([key]) => key.startsWith(`${state.projectKey}-`))
        .map(([key, name]) => ({ id: key, name: `${key} — ${name}` })),
    };
  }

  function render() {
    root.textContent = "";

    const title = document.createElement("h1");
    title.className = "create-title mono";
    title.textContent = subtaskMode ? "NEW SUB-TASK" : "NEW ISSUE";
    root.appendChild(title);

    if (subtaskMode) {
      root.appendChild(
        note(`Parent: ${parentKey}${parentSummary ? ` — ${parentSummary}` : ""}`, "create-parent")
      );
    }

    root.appendChild(chromeRow());

    if (state.loading) {
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      spinner.style.margin = "28px auto";
      root.appendChild(spinner);
      return;
    }

    if (state.error) {
      root.appendChild(note(state.error, "create-error"));
      return;
    }

    // A required field with no control here is the one case where the form
    // refuses to be a form: posting without it would 400, and filling it would
    // mean guessing at a shape Jira has not described in a way this app
    // understands. Naming it is the useful thing to do.
    if (state.spec.unsupported.length) {
      root.appendChild(
        note(
          `This project requires ${state.spec.unsupported
            .map((r) => r.label)
            .join(", ")}, which this form cannot fill in. Create the issue in Jira, ` +
            "or ask an admin to make the field optional on the create screen.",
          "create-error"
        )
      );
      return;
    }

    for (const row of state.spec.rows) root.appendChild(fieldRow(row));

    if (state.spec.omitted.length) {
      root.appendChild(
        note(
          `Not shown, and left unset: ${state.spec.omitted
            .map((r) => r.label)
            .join(", ")}. Optional on this screen, and of a type this form does not render.`,
          "create-omitted"
        )
      );
    }

    const actions = document.createElement("div");
    actions.className = "create-actions";
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "create-submit";
    submitBtn.textContent = subtaskMode ? "Create sub-task" : "Create issue";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "create-cancel mono";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    actions.append(submitBtn, cancel);
    root.appendChild(actions);
  }

  // The two pickers that decide which createmeta to read. In sub-task mode both
  // are settled, so they render as text rather than as choices you cannot make.
  function chromeRow() {
    const wrap = document.createElement("div");
    wrap.className = "create-chrome";

    if (subtaskMode) {
      wrap.appendChild(
        labelled("Project", staticValue(state.projectKey))
      );
      wrap.appendChild(
        labelled("Type", staticValue(state.types[0]?.name || "sub-task"))
      );
      return wrap;
    }

    const project = document.createElement("select");
    project.className = "create-input mono";
    for (const option of projects) {
      const el = document.createElement("option");
      el.value = option.key;
      el.textContent = option.label === option.key ? option.key : `${option.key} — ${option.label}`;
      project.appendChild(el);
    }
    project.value = state.projectKey;
    project.addEventListener("change", async () => {
      state.projectKey = project.value;
      state.error = null;
      await loadTypes();
    });
    wrap.appendChild(labelled("Project", project));

    const type = document.createElement("select");
    type.className = "create-input mono";
    for (const option of state.types) {
      const el = document.createElement("option");
      el.value = option.id;
      el.textContent = option.name;
      type.appendChild(el);
    }
    type.value = state.typeId;
    type.disabled = !state.types.length;
    type.addEventListener("change", async () => {
      state.typeId = type.value;
      await loadFields();
    });
    wrap.appendChild(labelled("Type", type));

    return wrap;
  }

  function fieldRow(row) {
    const control = controlFor(row);
    const wrap = labelled(row.label + (row.required ? " *" : ""), control);
    const problem = state.fieldErrors[row.id];
    if (problem) {
      wrap.classList.add("has-error");
      wrap.appendChild(note(problem, "create-field-error"));
    }
    return wrap;
  }

  function controlFor(row) {
    const set = (value) => {
      state.values[row.id] = value;
    };

    switch (row.control) {
      case CONTROLS.TEXTAREA: {
        const el = document.createElement("textarea");
        el.className = "create-input";
        el.rows = row.id === "description" ? 6 : 3;
        el.value = state.values[row.id] ?? "";
        el.addEventListener("input", () => set(el.value));
        return el;
      }
      case CONTROLS.SELECT:
        return selectControl(row, row.options, set, { allowEmpty: !row.required });
      case CONTROLS.SPRINT:
        return selectControl(row, state.boardOptions.sprints, set, { allowEmpty: true });
      case CONTROLS.EPIC:
        return selectControl(row, state.boardOptions.epics, set, { allowEmpty: true });
      case CONTROLS.USER:
        return selectControl(
          row,
          rosterOptions(row),
          set,
          { allowEmpty: !row.required, emptyLabel: "Unassigned" }
        );
      case CONTROLS.MULTISELECT:
      case CONTROLS.USERS: {
        const el = document.createElement("select");
        el.className = "create-input mono";
        el.multiple = true;
        el.size = Math.min(5, Math.max(2, row.options.length || 2));
        const options = row.control === CONTROLS.USERS ? rosterOptions(row) : row.options;
        for (const option of options) {
          const opt = document.createElement("option");
          opt.value = option.id;
          opt.textContent = option.name;
          opt.selected = (state.values[row.id] || []).includes(option.id);
          el.appendChild(opt);
        }
        el.addEventListener("change", () =>
          set([...el.selectedOptions].map((o) => o.value))
        );
        return el;
      }
      default: {
        const el = document.createElement("input");
        el.className = "create-input";
        el.type =
          row.control === CONTROLS.NUMBER
            ? "text"
            : row.control === CONTROLS.DATE
              ? "date"
              : row.control === CONTROLS.DATETIME
                ? "datetime-local"
                : "text";
        if (row.control === CONTROLS.LABELS) el.placeholder = "comma separated";
        if (row.control === CONTROLS.ISSUE_KEY) el.placeholder = "ABC-123";
        el.value = state.values[row.id] ?? "";
        el.addEventListener("input", () => set(el.value));
        // Summary is the field everyone types first.
        if (row.id === "summary") setTimeout(() => el.focus(), 0);
        return el;
      }
    }
  }

  // A user field offers the roster, and whatever createmeta itself allowed —
  // some sites restrict assignable users per project, and that list is the
  // authoritative one when it is present.
  function rosterOptions(row) {
    if (row.options.length) return row.options;
    return activeMembers()
      .filter((m) => m.accountId)
      .map((m) => ({ id: m.accountId, name: memberLabel(m) || m.jiraName || m.accountId }));
  }

  function selectControl(row, options, set, { allowEmpty = true, emptyLabel = "—" } = {}) {
    const el = document.createElement("select");
    el.className = "create-input mono";
    if (allowEmpty) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = emptyLabel;
      el.appendChild(blank);
    }
    for (const option of options) {
      const opt = document.createElement("option");
      opt.value = option.id;
      opt.textContent = option.name;
      el.appendChild(opt);
    }
    el.value = state.values[row.id] ?? "";
    // A required select with no blank option is already showing its first
    // option, so the form state has to agree with the screen.
    if (!allowEmpty && !state.values[row.id] && options.length) set(options[0].id);
    el.addEventListener("change", () => set(el.value));
    return el;
  }

  async function submit() {
    if (state.loading) return;
    const missing = missingRequired(state.spec.rows, state.values);
    if (missing.length) {
      state.fieldErrors = Object.fromEntries(missing.map((r) => [r.id, "Required"]));
      render();
      return;
    }

    state.loading = true;
    render();
    try {
      const fields = buildCreatePayload({
        rows: state.spec.rows,
        values: state.values,
        projectKey: state.projectKey,
        issueTypeId: state.typeId,
        parentKey,
      });
      const created = await createIssue(fields, creds);
      // The new issue belongs to a board whose cached lists no longer include
      // it; the epic and sprint pickers are unaffected.
      const board = projects.find((p) => p.key === state.projectKey);
      if (board) await cache.dropBoard(board.boardId);

      close();
      showToast(`${created.key} created`, false, {
        label: "Open",
        // Imported at the click rather than at the top of the file: the issue
        // detail is what opens *this* panel for a sub-task, and a static import
        // both ways is a cycle for the sake of one optional button.
        run: async () => {
          const { openIssueDrawer } = await import("./issue-detail.js");
          openIssueDrawer(created.key, creds);
        },
      });
      onCreated?.(created);
    } catch (err) {
      state.loading = false;
      // Field-attributed refusals go on the rows they belong to; anything else
      // goes at the top, because it is about the issue and not about a field.
      state.fieldErrors = err?.fieldErrors
        ? Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v]))
        : {};
      const unattributed = (err?.messages || []).join("; ");
      state.error = null;
      render();
      if (unattributed || !Object.keys(state.fieldErrors).length) {
        showToast(`Not created — ${unattributed || err.message || err}`, true);
      }
    }
  }

  return { close };
}

function projectKeyOf(issueKey) {
  return String(issueKey || "").split("-")[0] || "";
}

function labelled(label, control) {
  const wrap = document.createElement("div");
  wrap.className = "create-row";
  const key = document.createElement("label");
  key.className = "create-label mono";
  key.textContent = label;
  wrap.append(key, control);
  return wrap;
}

function staticValue(text) {
  const el = document.createElement("div");
  el.className = "create-static";
  el.textContent = text;
  return el;
}

function note(text, className = "create-note") {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}
