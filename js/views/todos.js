// Launch → My todos (M14).
//
// The manager's own list. Actions owned by *me* in a 1:1 land here when the
// meeting is completed, so a commitment made in a conversation is in one place
// rather than buried in one of a dozen sheets — and anything else can be typed
// straight in.
//
// A table with four columns and three verbs: add, tick, remove. That is the
// whole feature, on purpose. Jira is one tab away and anything that deserves
// tracking properly belongs there; this is the scrap of paper that used to be
// beside the laptop.

import { runtimeUrl } from "../browser.js";
import { fmtDate, showToast } from "../utils.js";
import {
  addTodo,
  clearDone,
  countOpen,
  isOverdueTodo,
  loadTodos,
  removeTodo,
  saveTodos,
  sortTodos,
  toggleTodo,
  updateTodo,
} from "../todos.js";
import { icon } from "../components/icons.js";
import { viewHeader, viewTiles } from "../components/view-header.js";

export async function mount(container) {
  let list = await loadTodos();

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "todo-wrap";

  const tiles = document.createElement("div");
  wrap.appendChild(
    viewHeader({
      iconName: "list",
      title: "My todos",
      subtitle: "What you owe people, from your 1:1s and from anywhere else",
      right: tiles,
    })
  );

  const form = document.createElement("form");
  form.className = "todo-add";
  const textInput = field("text", "What do you owe?", "text");
  const dueInput = field("due", "", "date");
  dueInput.title = "Optional deadline";
  const linkInput = field("link", "https://… (optional)", "url");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn primary mono";
  submit.textContent = "Add";
  form.append(textInput, dueInput, linkInput, submit);
  wrap.appendChild(form);

  const table = document.createElement("div");
  table.className = "todo-table";
  wrap.appendChild(table);

  const foot = document.createElement("div");
  foot.className = "todo-foot";
  wrap.appendChild(foot);

  container.appendChild(wrap);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) {
      textInput.focus();
      return;
    }
    const before = list.length;
    list = addTodo(list, { text, due: dueInput.value, link: linkInput.value });
    if (linkInput.value.trim() && list[list.length - 1]?.link === "") {
      // Said rather than swallowed: a dropped link is the kind of thing people
      // discover a week later when they go looking for it.
      showToast("That link was not an http(s) address, so it was not saved.", true);
    }
    if (list.length > before) {
      await saveTodos(list);
      textInput.value = "";
      dueInput.value = "";
      linkInput.value = "";
      render();
      textInput.focus();
    }
  });

  async function mutate(fn) {
    list = fn(list);
    await saveTodos(list);
    render();
  }

  function render() {
    const open = countOpen(list);
    const overdue = list.filter((item) => isOverdueTodo(item)).length;
    tiles.innerHTML = "";
    tiles.appendChild(
      viewTiles([
        { num: open, label: "open", tone: "total" },
        { num: overdue, label: "overdue", tone: overdue ? "red" : "gray" },
        { num: list.length - open, label: "done", tone: "green" },
      ])
    );

    table.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "Nothing here. Actions you take on in a 1:1 arrive automatically when you complete it.";
      table.appendChild(empty);
      renderFoot();
      return;
    }

    table.appendChild(headerRow());
    for (const item of sortTodos(list)) table.appendChild(row(item));
    renderFoot();
  }

  function renderFoot() {
    foot.innerHTML = "";
    const note = document.createElement("span");
    note.className = "todo-note";
    note.textContent =
      "Stored on this device only. Items from a 1:1 carry a colleague's name, so this list " +
      "is never synced and never leaves in a config export.";
    foot.appendChild(note);

    if (list.some((item) => item.done)) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "oo-link-btn mono";
      clear.textContent = "Clear finished";
      clear.addEventListener("click", () => mutate((l) => clearDone(l)));
      foot.appendChild(clear);
    }

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "oo-link-btn mono";
    settings.textContent = "Delete everything (Settings)";
    settings.addEventListener("click", () => window.open(runtimeUrl("settings.html")));
    foot.appendChild(settings);
  }

  function headerRow() {
    const head = document.createElement("div");
    head.className = "todo-row todo-head mono";
    for (const label of ["", "Source", "Item", "Due", "Link", ""]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      head.appendChild(cell);
    }
    return head;
  }

  function row(item) {
    const el = document.createElement("div");
    el.className = "todo-row enter" + (item.done ? " done" : "");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.done;
    box.setAttribute("aria-label", item.done ? "Mark as not done" : "Mark as done");
    box.addEventListener("change", () => mutate((l) => toggleTodo(l, item.id)));
    el.appendChild(box);

    const source = document.createElement("span");
    source.className = "todo-source mono" + (item.source === "1on1" ? " from-oneone" : "");
    source.textContent = item.source === "1on1" ? item.sourceLabel || "1:1" : "manual";
    source.title = item.source === "1on1"
      ? `Agreed in a 1:1 with ${item.sourceLabel || "someone"}`
      : "Added by hand";
    el.appendChild(source);

    const text = document.createElement("input");
    text.type = "text";
    text.className = "todo-text";
    text.value = item.text;
    text.addEventListener("change", () => mutate((l) => updateTodo(l, item.id, { text: text.value })));
    el.appendChild(text);

    const due = document.createElement("input");
    due.type = "date";
    due.className = "todo-due mono" + (isOverdueTodo(item) ? " overdue" : "");
    due.value = item.due;
    due.title = isOverdueTodo(item) ? `Overdue — was due ${fmtDate(item.due)}` : "Deadline";
    due.addEventListener("change", () => mutate((l) => updateTodo(l, item.id, { due: due.value })));
    el.appendChild(due);

    const link = document.createElement("span");
    link.className = "todo-link";
    if (item.link) {
      const a = document.createElement("a");
      a.href = item.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = hostOf(item.link);
      a.title = item.link;
      link.appendChild(a);
    }
    el.appendChild(link);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "oo-remove";
    remove.setAttribute("aria-label", "Remove this item");
    remove.title = "Remove this item";
    remove.appendChild(icon("close", 12));
    remove.addEventListener("click", () => mutate((l) => removeTodo(l, item.id)));
    el.appendChild(remove);

    return el;
  }

  render();
}

function field(name, placeholder, type) {
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.className = `todo-input todo-input-${name}`;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

// The host is enough to recognise a link at a glance, and a full URL in a
// narrow column pushes everything else off the row.
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "link";
  }
}
