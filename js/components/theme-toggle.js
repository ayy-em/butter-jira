// The theme toggle: a small sky with a sun, a moon, stars, clouds and craters.
//
// One implementation, because there were two. The nav built the button in JS
// and settings.html hand-wrote the same twenty spans into its markup, and
// settings.js reimplemented loadTheme/saveTheme rather than importing them from
// js/utils.js — so the toggle had two copies of its structure and the theme had
// two copies of its storage key. The dimensions have always come from
// css/app.css, which is the half that never drifted; this is the other half.
//
// The sky itself is deliberate and pinned. A mechanical scan flags it as
// `pulsing-dot` and `dark-glow` on every run and both findings are declined.

import { applyTheme, loadTheme, saveTheme } from "../utils.js";

// Structure only. Everything visual is in css/app.css under .theme-toggle.
const SKY = `
  <span class="toggle-track">
    <span class="toggle-stars">
      <span class="toggle-star"></span><span class="toggle-star"></span>
      <span class="toggle-star"></span><span class="toggle-star"></span>
      <span class="toggle-star"></span>
    </span>
    <span class="toggle-cloud"></span><span class="toggle-cloud"></span>
  </span>
  <span class="toggle-rays">
    <span class="toggle-ray"></span><span class="toggle-ray"></span>
    <span class="toggle-ray"></span><span class="toggle-ray"></span>
    <span class="toggle-ray"></span><span class="toggle-ray"></span>
    <span class="toggle-ray"></span>
  </span>
  <span class="toggle-body">
    <span class="toggle-crater"></span><span class="toggle-crater"></span>
    <span class="toggle-crater"></span>
  </span>
`;

// `onChange` runs after the theme is applied and stored, for the one thing that
// cannot be done in CSS: the nav swaps its brand mark between a light and a dark
// file. `className` adds a page's own modifier — settings sizes it up.
//
// The caller passes the theme it already loaded, if it has one, so a page that
// reads the theme on boot does not read it twice.
export function createThemeToggle({ theme = "dark", className = "", onChange = null } = {}) {
  let current = theme;

  const button = document.createElement("button");
  button.className = `theme-toggle ${className}`.trim();
  button.type = "button";
  button.title = "Toggle theme";
  // The button carries no text, and a control with no accessible name is
  // announced as "button" and nothing else.
  button.setAttribute("aria-label", "Toggle light and dark theme");
  button.innerHTML = SKY;

  const sync = () => {
    button.setAttribute("aria-pressed", String(current === "light"));
  };
  sync();

  button.addEventListener("click", async () => {
    current = current === "dark" ? "light" : "dark";
    sync();
    // Applied first, stored second, and the store is allowed to fail. The theme
    // is a preference, not a document: a page whose click does nothing because
    // storage is unavailable is worse than one that forgets the choice on
    // reload.
    applyTheme(current);
    try {
      await saveTheme(current);
    } catch {
      /* not stored; still applied */
    }
    onChange?.(current);
  });

  return button;
}

// For a page that has nothing else to do on boot: read the stored theme, apply
// it, and hand back a wired button in place of `slot`.
//
// The read is allowed to fail. settings.html used to carry the toggle as static
// markup, so it was there whatever else went wrong; now that it is mounted, a
// storage error before this line would leave the page's header with a hole in
// it. Falling back to whatever the document already says keeps the sky.
export async function mountThemeToggle(slot, options = {}) {
  let theme;
  try {
    theme = await loadTheme();
  } catch {
    theme = document.documentElement.getAttribute("data-theme") || "dark";
  }
  const button = createThemeToggle({ ...options, theme });
  slot.replaceWith(button);
  return button;
}

export { applyTheme, loadTheme, saveTheme };
