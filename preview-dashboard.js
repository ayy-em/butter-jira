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
// like. This harness adds ?sort=<column> · ?flip=1
import { params } from "./preview-fixture.js";

const { mount } = await import("./js/views/dashboard.js");
await mount(
  document.getElementById("view-container"),
  { email: "preview@example.com", token: "preview" }
);

// ?sort=lines clicks that heading, ?flip=1 clicks it twice — the two things a
// screenshot cannot reach on its own.
const wanted = (params.get("sort") || "").toLowerCase();
if (wanted) {
  const th = [...document.querySelectorAll(".dash-table-wide thead th")].find((h) =>
    h.textContent.toLowerCase().includes(wanted)
  );
  th?.click();
  if (params.get("flip") === "1") th?.click();
}
