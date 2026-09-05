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

let current = null;

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
  current?.close();

  const overlay = document.createElement("div");
  overlay.className = "issue-drawer-overlay";
  const panel = document.createElement("div");
  panel.className = `issue-drawer ${className}`.trim();
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label || "Panel");

  const closeBtn = document.createElement("button");
  closeBtn.className = "issue-drawer-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (Esc)";
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
    onClose?.();
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    // Capture phase, and the key is consumed here. The standup binds Escape on
    // document too, to end the meeting; without this, opening a card mid-turn
    // and pressing Escape to close it also ended the standup and cleared the
    // session. The topmost layer owns the key.
    e.stopPropagation();
    close();
  }
  document.addEventListener("keydown", onKey, true);
  // The nav stays clickable behind the drawer, so a view change has to take the
  // drawer with it rather than leaving it floating over the new view.
  window.addEventListener("hashchange", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);

  const handle = { body, panel, close };
  current = handle;
  return handle;
}

export function closeDrawerPanel() {
  current?.close();
}
