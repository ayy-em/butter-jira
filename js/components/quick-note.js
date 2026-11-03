// Quick note — the sidebar's "+", for writing something down from any screen.
//
// The thing to raise with somebody occurs to you on the Kanban, not on their
// 1:1 sheet, and the cost of opening the sheet to type it is exactly the cost
// that makes it not get written down. So the sidebar carries a small popover
// with three destinations:
//
//   * **A person** — an *action* (a TODO on their sheet, owner and optional
//     deadline as on the sheet itself) or an *agenda / FYI* item (the sheet's
//     notes block). Either one waits on the sheet for the next conversation.
//   * **Everyone** — the same agenda item on every active member's sheet, for
//     the announcement that has to reach each of them in turn. Agenda only: an
//     action copied seven times is seven actions, and ticking one would not
//     tick the others.
//   * **Me** — a manual item on My todos.
//
// Everything written here goes through the same stores the sheet and the todo
// list use, with the same device-local rules (see the notes at the top of
// `js/oneone.js` and `js/todos.js`). A view that holds one of those stores in
// memory listens for `NOTES_CHANGED` and reloads, so an open sheet neither
// misses the note nor writes over it on the next keystroke.

import { loadOneOnes, queueNote, saveOneOnes } from "../oneone.js";
import { addTodo, loadTodos, saveTodos } from "../todos.js";
import { activeMembers, memberFor, memberLabel } from "../team.js";
import { showToast } from "../utils.js";
import { icon } from "./icons.js";

export const NOTES_CHANGED = "notes-changed";

const ME = "me";
const EVERYONE = "everyone";

// Session-scoped, like the 1:1 picker's pending window: three notes in a row
// for the same person should not mean choosing them three times. Nothing here
// is worth storing — the next session starts from where you are.
let lastTarget = "";
let lastKind = "info";
let lastOwner = "them";

let panel = null;
let anchor = null;
let onOutside = null;

export function isQuickNoteOpen() {
  return Boolean(panel);
}

export function toggleQuickNote(anchorEl) {
  if (panel) closeQuickNote();
  else openQuickNote(anchorEl);
}

export function closeQuickNote({ restoreFocus = true } = {}) {
  if (!panel) return;
  panel.remove();
  panel = null;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("hashchange", closeOnNavigate);
  onOutside = null;
  anchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  anchor = null;
}

function closeOnNavigate() {
  closeQuickNote({ restoreFocus: false });
}

// On a person's sheet the note is almost certainly for them; anywhere else, the
// last person written to, and failing that yourself — misfiling into your own
// list is the cheapest mistake to undo.
function defaultTarget() {
  const [route, ...rest] = String(location.hash || "").split("/");
  const onSheet = route === "#oneone" && rest.length ? decodeURIComponent(rest.join("/")) : "";
  if (onSheet && memberFor(onSheet)) return onSheet;
  if (lastTarget === ME || (lastTarget === EVERYONE && activeMembers().length)) return lastTarget;
  if (lastTarget && memberFor(lastTarget)) return lastTarget;
  return ME;
}

export function openQuickNote(anchorEl) {
  if (panel) return;
  anchor = anchorEl || null;
  anchor?.setAttribute("aria-expanded", "true");

  const members = [...activeMembers()].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b)));
  let target = defaultTarget();
  let kind = lastKind;
  let owner = lastOwner;

  panel = document.createElement("div");
  panel.className = "qn-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Quick note");
  // The issue drawer closes on Escape in the capture phase; this tells it the
  // key belongs to the layer on top.
  panel.dataset.keepsEscape = "";

  const head = document.createElement("div");
  head.className = "qn-head";
  const title = document.createElement("span");
  title.className = "qn-title mono";
  title.textContent = "Quick note";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "oo-remove";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close");
  close.appendChild(icon("close", 12));
  close.addEventListener("click", () => closeQuickNote());
  head.append(title, close);

  const form = document.createElement("form");
  form.className = "qn-form";

  const forRow = document.createElement("label");
  forRow.className = "qn-row";
  const forLabel = document.createElement("span");
  forLabel.className = "qn-label mono";
  forLabel.textContent = "For";
  const select = document.createElement("select");
  select.className = "qn-select";
  select.appendChild(option(ME, "Me — My todos"));
  if (members.length) {
    const team = document.createElement("optgroup");
    team.label = "1:1 sheet";
    team.appendChild(option(EVERYONE, `Everyone (${members.length})`));
    for (const m of members) team.appendChild(option(m.accountId, memberLabel(m)));
    select.appendChild(team);
  }
  select.value = target;
  forRow.append(forLabel, select);

  // Two kinds, one control — a segmented pair, like the owner toggle on the
  // sheet, because a dropdown costs a second interaction for a binary choice.
  const kinds = document.createElement("div");
  kinds.className = "qn-kinds";
  kinds.setAttribute("role", "group");
  kinds.setAttribute("aria-label", "Kind of note");
  const kindBtns = {
    info: kindButton("info", "Agenda · FYI", "Something to raise, or worth them knowing"),
    todo: kindButton("todo", "Action", "Something one of you will do — lands in their TODO"),
  };
  kinds.append(kindBtns.info, kindBtns.todo);

  const textArea = document.createElement("textarea");
  textArea.className = "qn-text";
  textArea.rows = 3;

  const opts = document.createElement("div");
  opts.className = "qn-opts";
  const ownerBtn = document.createElement("button");
  ownerBtn.type = "button";
  ownerBtn.className = "oo-owner mono";
  ownerBtn.title = "Whose action is this? Click to switch between you and them.";
  ownerBtn.addEventListener("click", () => {
    owner = owner === "me" ? "them" : "me";
    sync();
  });
  const dueWrap = document.createElement("label");
  dueWrap.className = "qn-due-wrap";
  const dueLabel = document.createElement("span");
  dueLabel.className = "qn-label mono";
  dueLabel.textContent = "Due";
  const due = document.createElement("input");
  due.type = "date";
  due.className = "qn-due mono";
  due.title = "Optional deadline";
  dueWrap.append(dueLabel, due);
  opts.append(ownerBtn, dueWrap);

  const foot = document.createElement("div");
  foot.className = "qn-foot";
  const hint = document.createElement("span");
  hint.className = "qn-hint mono";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn primary small mono";
  submit.textContent = "Add";
  foot.append(hint, submit);

  form.append(forRow, kinds, textArea, opts, foot);
  panel.append(head, form);
  document.body.appendChild(panel);
  place();

  function kindButton(id, label, help) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qn-kind mono";
    btn.textContent = label;
    btn.title = help;
    btn.addEventListener("click", () => {
      kind = id;
      sync();
      textArea.focus();
    });
    return btn;
  }

  // One function decides what is visible for the current target and kind, so
  // the controls cannot drift into a combination the submit does not handle.
  function sync() {
    const toMe = target === ME;
    const toAll = target === EVERYONE;
    const effective = toMe ? "todo" : toAll ? "info" : kind;

    kinds.hidden = toMe;
    for (const [id, btn] of Object.entries(kindBtns)) {
      btn.classList.toggle("active", id === effective);
      btn.setAttribute("aria-pressed", String(id === effective));
      btn.disabled = toAll && id === "todo";
    }
    kindBtns.todo.title = toAll
      ? "An action belongs to one person — copied to everyone, ticking one would not tick the rest"
      : "Something one of you will do — lands in their TODO";

    ownerBtn.hidden = toMe || effective !== "todo";
    ownerBtn.classList.toggle("me", owner === "me");
    ownerBtn.classList.toggle("them", owner === "them");
    ownerBtn.textContent = owner;
    dueWrap.hidden = effective !== "todo";
    opts.hidden = ownerBtn.hidden && dueWrap.hidden;

    textArea.maxLength = effective === "info" ? 1000 : 500;
    textArea.placeholder = toMe
      ? "What do you owe?"
      : effective === "todo"
        ? "What was agreed, or needs doing"
        : toAll
          ? "Something to raise with each of them"
          : "Something to raise, or worth them knowing";
    hint.textContent = toAll
      ? `Goes on all ${members.length} agendas · ↵ add`
      : "↵ add · ⇧↵ new line";
  }

  select.addEventListener("change", () => {
    target = select.value;
    sync();
    textArea.focus();
  });

  textArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Consumed here: the standup ends the meeting on a document-level Escape,
    // and closing a note must not do that.
    e.stopPropagation();
    e.preventDefault();
    closeQuickNote();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = textArea.value.trim();
    if (!body) {
      textArea.focus();
      return;
    }
    submit.disabled = true;
    try {
      await save({ target, kind, owner, due: due.value, body, members });
      lastTarget = target;
      if (target !== ME && target !== EVERYONE) lastKind = kind;
      lastOwner = owner;
      closeQuickNote();
    } catch (err) {
      // Kept open with the text in it: a refused write is not a lost note.
      console.error("Quick note failed:", err);
      showToast(`Could not save the note: ${err.message}`, true);
      submit.disabled = false;
    }
  });

  // Capture phase, so a click that something underneath swallows still closes
  // the popover. The anchor is left to its own click handler, which toggles.
  onOutside = (e) => {
    if (panel?.contains(e.target) || anchor?.contains(e.target)) return;
    closeQuickNote({ restoreFocus: false });
  };
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("hashchange", closeOnNavigate);

  sync();
  textArea.focus();
}

async function save({ target, kind, owner, due, body, members }) {
  const now = new Date();

  if (target === ME) {
    const list = await loadTodos(now);
    await saveTodos(addTodo(list, { text: body, due }), now);
    announce({ store: "todos" });
    showToast("Added to My todos", false, { label: "Open", run: () => { location.hash = "#todos"; } });
    return;
  }

  const toAll = target === EVERYONE;
  const ids = toAll ? members.map((m) => m.accountId) : [target];
  const effective = toAll ? "info" : kind;
  const store = await loadOneOnes(now);
  await saveOneOnes(queueNote(store, ids, { kind: effective, text: body, owner, due, now }), now);
  announce({ store: "oneone", accountIds: ids });

  if (toAll) {
    showToast(`Added to the agenda for all ${ids.length}`, false, {
      label: "Open 1:1",
      run: () => { location.hash = "#oneone"; },
    });
    return;
  }
  const name = memberLabel(memberFor(target));
  showToast(
    effective === "todo" ? `Action added to ${name}'s 1:1` : `Added to ${name}'s agenda`,
    false,
    { label: "Open", run: () => { location.hash = `#oneone/${encodeURIComponent(target)}`; } }
  );
}

function announce(detail) {
  document.dispatchEvent(new CustomEvent(NOTES_CHANGED, { detail }));
}

function option(value, label) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

// Beside the anchor when it sits in the sidebar — bottom edges aligned, opening
// rightwards into the page — and under it, right edges aligned, anywhere else.
// The fallback with no anchor at all is the top-right corner of the page.
function place() {
  const rect = anchor?.getBoundingClientRect();
  panel.style.top = panel.style.right = panel.style.bottom = panel.style.left = "";
  if (!rect || !rect.width) {
    panel.style.top = "16px";
    panel.style.right = "16px";
    return;
  }
  if (rect.right < window.innerWidth / 2) {
    panel.style.left = `${Math.round(rect.right + 10)}px`;
    panel.style.bottom = `${Math.max(8, Math.round(window.innerHeight - rect.bottom))}px`;
    return;
  }
  panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  panel.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
}
