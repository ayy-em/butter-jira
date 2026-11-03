// Local preview harness for the sprint dashboard.
//
// Mounts the real js/views/dashboard.js against the shared preview fixture, so
// the view can be looked at without a site, a token or a roster. Not shipped:
// scripts/build.mjs copies an explicit file list, and this is not on it. Open
// with:
//
//   open preview-dashboard.html          (or serve the folder over http)
//
// Fixture states: ?theme=light · ?github=off · ?stats=slow · ?stats=error ·
// ?sprint=undated · ?push=off · ?freeze=mid|none — the freeze the diff panel
// compares against, taken four days into the sprint (so the scope figure reads
// "approx.") or not seeded at all, in which case the view takes its own on load
// and the panel reads "nothing has moved", which is what a first-ever load looks
// like. This harness adds ?sort=<column> · ?flip=1 · ?tab=individual ·
// ?shell=off (no sidebar) · ?open=<check id> (opens that checklist row's list)
import { params } from "./preview-fixture.js";

if (params.get("shell") !== "off") {
  document.body.classList.add("shell");
  // The sidebar reads the theme from synced storage and would repaint the page
  // dark over ?theme=light.
  await chrome.storage.sync.set({ theme: params.get("theme") || "dark" });
  const { renderNav } = await import("../js/components/nav.js");
  await renderNav(() => location.reload());
}
if (!location.hash) history.replaceState(null, "", "#dashboard");

const { mount } = await import("../js/views/dashboard.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);

// ?sort=lines clicks that heading, ?flip=1 clicks it twice — the two things a
// screenshot cannot reach on its own.
if (params.get("tab") === "individual") document.getElementById("dash-tab-individual")?.click();

const wanted = (params.get("sort") || "").toLowerCase();
if (wanted) {
  const th = [...document.querySelectorAll(".dash-table-wide thead th")].find((h) =>
    h.textContent.toLowerCase().includes(wanted)
  );
  th?.click();
  if (params.get("flip") === "1") th?.click();
}

// ?open=blocked opens that checklist row's filtered list, once its source has
// landed — the drawer is the other half of every count on the screen.
const openId = params.get("open");
if (openId) {
  const labels = {
    overdue: "Overdue", blocked: "Blocked for", prs: "PRs awaiting", unestimated: "Unestimated",
    unassigned: "without an assignee", added: "Scope added", deps: "Dependencies",
  };
  const find = () =>
    [...document.querySelectorAll(".dash-attention .dash-check")].find((b) =>
      b.textContent.includes(labels[openId] || openId)
    );
  const tryOpen = () => {
    const btn = find();
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  };
  if (!tryOpen()) {
    const obs = new MutationObserver(() => { if (tryOpen()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }
}
