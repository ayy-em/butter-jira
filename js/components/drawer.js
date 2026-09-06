// The sliding panel the app opens things in.
//
// Extracted when the create-issue modal needed it: the issue detail had all of
// this inline, and a second panel that merely looked similar would drift — the
// part worth sharing is not the animation but the measuring. The drawer occupies
// the band between whatever the current view has pinned to the top and bottom of
// the window, so a view's own chrome stays visible and usable while a panel is
// open over it.
//
// One at a time, deliberately: opening a panel closes whatever was already
// there. Stacked drawers would each need their own escape key and their own
// answer to what a click on the backdrop means.
//
// It is a real dialog, not a div that says role="dialog": focus moves in on
// open, Tab cycles inside it, and focus goes back to whatever opened it on
// close. That is not only an accessibility nicety — it is the fix for the class
// of bug that produced Shift+Esc. While focus sat on <body> behind a dimmed
// backdrop, every document-level key handler in the app still believed it was
// the frontmost thing, and standup's INPUT/TEXTAREA guard could not tell a card
// being open from nothing being open. With focus inside the panel, a handler
// that asks where the focus is gets a truthful answer.

import { icon } from "./icons.js";

let current = null;

// Things a Tab can land on. `[tabindex]` last so an explicit order still works;
// negative tabindex is filtered out below because it is reachable by script
// only, which is exactly what the panel itself uses.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]",
].join(",");

export function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      // offsetParent is null for display:none and for anything inside it. The
      // panel is never position:fixed, so the usual caveat does not apply here.
      (el.offsetParent !== null || el === document.activeElement)
  );
}

// Where to put focus back when the panel closes.
//
// The obvious answer — hold the element — is not enough here. The drawer is
// opened from board cards, and a board repaints while it is open: dragging a
// card, a poll landing, a standup advancing a turn all replace the very node
// that was clicked. So remember a way to *find* the trigger again as well, and
// re-query on close. Cards carry data-issue-key, rows carry ids; anything with
// neither falls back to the element itself, and then to the view container, so
// that Tab resumes somewhere in the view rather than at the top of the document.
export function triggerRecipe(el) {
  if (!el || el === document.body || !el.getAttribute) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attributes]
    .filter((a) => a.name.startsWith("data-") && a.value)
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
    .join("");
  return attrs ? `${tag}${attrs}` : null;
}

// Which element a Tab inside the panel should land on, or null to let the
// browser do what it would have done. Split out from the handler because the
// wrap-around is the part with edges worth testing: first/last, the panel
// itself as the shift-Tab origin, a single focusable, and none at all.
export function tabTarget({ items, target, panel, shiftKey }) {
  if (!items.length) return panel;
  const first = items[0];
  const last = items[items.length - 1];
  if (shiftKey) return target === first || target === panel ? last : null;
  return target === last ? first : null;
}

function restoreFocus(trigger, recipe) {
  const candidates = [
    trigger?.isConnected ? trigger : null,
    recipe ? document.querySelector(recipe) : null,
    document.getElementById("view-container"),
  ];
  for (const el of candidates) {
    if (!el || !el.isConnected) continue;
    if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return;
  }
}

// Views with their own frame opt in with data-drawer-top / data-drawer-bottom —
// standup does, so its clock and parking lot survive a card being opened
// mid-turn.
const TOP_CHROME = ["[data-drawer-top]", "#nav"];
const BOTTOM_CHROME = ["[data-drawer-bottom]", "#app-footer", ".expiry-banner"];

// Largest inset from `edge` across the visible chrome. Height rather than
// offsetParent as the visibility test: offsetParent is null for position:fixed
// elements, which is exactly what the nav and footer are.
function chromeInset(selectors, edge) {
  let inset = 0;
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      inset = Math.max(inset, edge === "top" ? rect.bottom : window.innerHeight - rect.top);
    }
  }
  // A view whose chrome fills the window would otherwise collapse the drawer to
  // nothing; leave it at least half the height to land in.
  return Math.min(Math.max(0, Math.round(inset)), Math.round(window.innerHeight / 4));
}

// `label` names the dialog for screen readers. `onClose` fires however the panel
// was dismissed — escape, backdrop, close button, or a view change underneath —
// so a caller with unsaved state has exactly one place to notice.
export function openDrawerPanel({ label, className = "", onClose = null } = {}) {
  // Read before the old panel closes: closing one restores focus to *its*
  // trigger, and that would otherwise become the trigger this panel remembers.
  const trigger = document.activeElement;
  const recipe = triggerRecipe(trigger);
  current?.close();

  const overlay = document.createElement("div");
  overlay.className = "issue-drawer-overlay";
  const panel = document.createElement("div");
  panel.className = `issue-drawer ${className}`.trim();
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", label || "Panel");
  // Focusable by script, not by Tab: the dialog itself is what takes focus on
  // open, which is what makes a screen reader announce the role and the label.
  // Focusing the close button instead would announce "Close, button" and never
  // mention that a dialog opened.
  panel.tabIndex = -1;

  const closeBtn = document.createElement("button");
  closeBtn.className = "issue-drawer-close icon-btn";
  closeBtn.type = "button";
  closeBtn.appendChild(icon("close", 13));
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close this panel");
  panel.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "issue-detail-scroll";
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Re-measured on resize because standup's top bar wraps its controls onto a
  // second row at narrow widths, which moves the band.
  function applyBounds() {
    overlay.style.setProperty("--drawer-top", `${chromeInset(TOP_CHROME, "top")}px`);
    overlay.style.setProperty("--drawer-bottom", `${chromeInset(BOTTOM_CHROME, "bottom")}px`);
  }
  applyBounds();
  window.addEventListener("resize", applyBounds);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", applyBounds);
    window.removeEventListener("hashchange", close);
    if (current?.close === close) current = null;
    // Before onClose, so a caller that repaints the view underneath does not
    // then have focus yanked out from under whatever it just rendered.
    restoreFocus(trigger, recipe);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Tab") return trapTab(e);
    if (e.key !== "Escape") return;
    // Capture phase, and the key is consumed here. The standup binds Escape on
    // document too, to end the meeting; without this, opening a card mid-turn
    // and pressing Escape to close it also ended the standup and cleared the
    // session. The topmost layer owns the key.
    e.stopPropagation();
    close();
  }

  // Only while focus is actually inside this panel.
  //
  // The alternative — a document-level focusin that drags focus back whenever
  // it leaves — is the usual way to write a trap and would be wrong here. The
  // re-auth prompt and the command palette are appended to <body>, outside this
  // overlay, and can open over an open drawer; a greedy trap would make the one
  // input on an expired-token prompt impossible to type in. Focus starts inside
  // the panel, so the cycle holds for the keyboard, and anything that
  // deliberately takes focus away is allowed to keep it.
  function trapTab(e) {
    if (!panel.contains(e.target)) return;
    e.stopPropagation();
    const next = tabTarget({
      items: focusableIn(panel),
      target: e.target,
      panel,
      shiftKey: e.shiftKey,
    });
    if (!next) return;
    e.preventDefault();
    next.focus({ preventScroll: true });
  }
  document.addEventListener("keydown", onKey, true);
  // The nav stays clickable behind the drawer, so a view change has to take the
  // drawer with it rather than leaving it floating over the new view.
  window.addEventListener("hashchange", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);

  // Focus moves in on open. preventScroll because the panel slides in from the
  // right and the browser would otherwise scroll the view behind it to chase
  // the element it thinks is now current.
  panel.focus({ preventScroll: true });

  const handle = { body, panel, close };
  current = handle;
  return handle;
}

export function closeDrawerPanel() {
  current?.close();
}
