import { BOARDS, debounce } from "../utils.js";
import { hasRoster, isOutsideTeam, isTeamOnly, setTeamOnly } from "../team.js";

const TYPE_OPTIONS = ["Epic", "Story", "Task", "Bug", "Sub-task"];

const STATUS_COLORS = {
  "to do": "#6B7280",
  "in progress": "#4F8EF7",
  "in review": "#EAB308",
  done: "#4FCF8E",
  blocked: "#EF4444",
};

function statusColor(name) {
  return STATUS_COLORS[name.toLowerCase()] || "#6B7280";
}

// Outsiders are marked, not hidden — a filter list that silently omits people
// makes issue counts look wrong.
function assigneeOptionLabel(assignee) {
  if (!hasRoster() || assignee.onTeam) return assignee.displayName;
  return `${assignee.displayName} · outside team`;
}

export function applyFilters(issues, state) {
  return issues.filter((issue) => {
    // Roster filter: hides work assigned outside the team, keeps unassigned.
    if (state.teamOnly && isOutsideTeam(issue)) return false;
    if (state.boards.length && !state.boards.includes(issue.boardId))
      return false;
    const typeName = issue.fields.issuetype?.name || "";
    if (state.types.length && !state.types.includes(typeName)) return false;
    if (state.assigneeIds.length) {
      const aid = issue.fields.assignee?.accountId || null;
      if (!state.assigneeIds.includes(aid)) return false;
    }
    if (state.statuses.length) {
      const sn = issue.fields.status?.name || "";
      if (!state.statuses.includes(sn)) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      const key = (issue.key || "").toLowerCase();
      const sum = (issue.fields.summary || "").toLowerCase();
      if (!key.includes(q) && !sum.includes(q)) return false;
    }
    return true;
  });
}

// One-shot filter intent: the command palette sets this just before navigating
// to a view, and the next renderFilters() consumes it. Deliberately not sticky —
// jumping to a person once should not silently filter the view forever.
let pendingAssigneeIds = null;

export function requestAssigneeFilter(accountIds) {
  pendingAssigneeIds = Array.isArray(accountIds) ? accountIds.filter(Boolean) : null;
}

function takePendingAssignees() {
  const pending = pendingAssigneeIds;
  pendingAssigneeIds = null;
  return pending && pending.length ? pending : null;
}

export function renderFilters(container, config, onChange) {
  container.innerHTML = "";
  container.className = "filter-bar";

  const state = {
    boards: BOARDS.map((b) => b.id),
    types: [...TYPE_OPTIONS],
    assigneeIds: takePendingAssignees() || [],
    statuses: [],
    search: "",
    currentSprintOnly: config.sprints ? true : false,
    teamOnly: hasRoster() ? isTeamOnly() : false,
  };

  function emit() {
    onChange({ ...state });
  }

  if (config.search !== false) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search...";
    input.className = "filter-search mono";
    const debouncedSearch = debounce((val) => {
      state.search = val;
      emit();
    }, 200);
    input.addEventListener("input", () => debouncedSearch(input.value));
    container.appendChild(input);
  }

  if (config.boards) {
    const wrap = makeMultiSelect(
      "Board",
      BOARDS.map((b) => ({ value: b.id, label: b.name, color: b.color })),
      state.boards,
      (sel) => {
        state.boards = sel;
        emit();
      }
    );
    container.appendChild(wrap);
  }

  if (config.types) {
    const wrap = makeMultiSelect(
      "Type",
      TYPE_OPTIONS.map((t) => ({ value: t, label: t })),
      state.types,
      (sel) => {
        state.types = sel;
        emit();
      }
    );
    container.appendChild(wrap);
  }

  if (config.assignees && config.assignees.length) {
    if (config.singleAssignee) {
      const wrap = makeSingleSelect(
        "Assignee",
        [
          { value: "__all__", label: "All" },
          ...config.assignees.map((a) => ({
            value: a.accountId,
            label: a.displayName,
          })),
        ],
        state.assigneeIds[0] || "__all__",
        (val) => {
          state.assigneeIds = val === "__all__" ? [] : [val];
          emit();
        }
      );
      container.appendChild(wrap);
    } else {
      const wrap = makeMultiSelect(
        "Assignee",
        config.assignees.map((a) => ({
          value: a.accountId,
          label: assigneeOptionLabel(a),
        })),
        state.assigneeIds,
        (sel) => {
          state.assigneeIds = sel;
          emit();
        }
      );
      container.appendChild(wrap);
    }
  }

  // Only offered once there is a roster to filter against.
  if (hasRoster()) {
    const btn = document.createElement("button");
    btn.className = "filter-toggle mono";
    btn.title = "Hide issues assigned outside the team roster. Unassigned issues stay visible.";
    const paint = () => {
      btn.classList.toggle("active", state.teamOnly);
      btn.textContent = state.teamOnly ? "Team Only" : "Everyone";
    };
    paint();
    btn.addEventListener("click", async () => {
      state.teamOnly = !state.teamOnly;
      await setTeamOnly(state.teamOnly);
      paint();
      emit();
    });
    container.appendChild(btn);
  }

  if (config.statuses && config.statuses.length) {
    const preselected = config.defaultStatuses || [];
    state.statuses = preselected.length ? [...preselected] : [];
    const wrap = makeMultiSelect(
      "Status",
      config.statuses.map((s) => ({
        value: s,
        label: s,
        color: statusColor(s),
      })),
      preselected.length ? [...preselected] : [],
      (sel) => {
        state.statuses = sel;
        emit();
      },
      preselected.length > 0
    );
    container.appendChild(wrap);
  }

  if (config.sprints) {
    const btn = document.createElement("button");
    btn.className = "filter-toggle mono active";
    btn.textContent = "Current Sprint";
    btn.addEventListener("click", () => {
      state.currentSprintOnly = !state.currentSprintOnly;
      btn.classList.toggle("active", state.currentSprintOnly);
      btn.textContent = state.currentSprintOnly
        ? "Current Sprint"
        : "All Issues";
      emit();
    });
    container.appendChild(btn);
  }

  setTimeout(emit, 0);
  return state;
}

function makeMultiSelect(label, options, selected, onChange, exactSelection = false) {
  const wrap = document.createElement("div");
  wrap.className = "filter-dropdown";

  const trigger = document.createElement("button");
  trigger.className = "filter-trigger mono";
  trigger.textContent = label;
  wrap.appendChild(trigger);

  const menu = document.createElement("div");
  menu.className = "filter-menu";
  menu.style.display = "none";

  for (const opt of options) {
    const item = document.createElement("label");
    item.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = exactSelection ? selected.includes(opt.value) : (selected.length === 0 || selected.includes(opt.value));
    cb.addEventListener("change", () => {
      const checked = [...menu.querySelectorAll("input:checked")].map(
        (el) => options[Array.from(menu.children).indexOf(el.closest("label"))].value
      );
      selected.length = 0;
      selected.push(...checked);
      onChange(checked);
    });
    const span = document.createElement("span");
    span.textContent = opt.label;
    if (opt.color) span.style.color = opt.color;
    item.appendChild(cb);
    item.appendChild(span);
    menu.appendChild(item);
  }

  wrap.appendChild(menu);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.style.display !== "none";
    closeAllMenus();
    if (!open) menu.style.display = "block";
  });

  return wrap;
}

function makeSingleSelect(label, options, defaultVal, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "filter-dropdown";

  const trigger = document.createElement("button");
  trigger.className = "filter-trigger mono";
  trigger.textContent = label;
  wrap.appendChild(trigger);

  const menu = document.createElement("div");
  menu.className = "filter-menu";
  menu.style.display = "none";

  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "filter-item selectable";
    if (opt.value === defaultVal) item.classList.add("selected");
    item.textContent = opt.label;
    item.addEventListener("click", () => {
      menu.querySelectorAll(".selectable").forEach((el) =>
        el.classList.remove("selected")
      );
      item.classList.add("selected");
      trigger.textContent = opt.label === "All" ? label : opt.label;
      onChange(opt.value);
      menu.style.display = "none";
    });
    menu.appendChild(item);
  }

  wrap.appendChild(menu);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.style.display !== "none";
    closeAllMenus();
    if (!open) menu.style.display = "block";
  });

  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll(".filter-menu").forEach((m) => {
    m.style.display = "none";
  });
}

document.addEventListener("click", closeAllMenus);
