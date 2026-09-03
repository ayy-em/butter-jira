// Local preview harness for the issue detail — the full-page form of it, which
// is the same `renderIssueInto()` the drawer uses.
//
// Added when the meta grid became editable (M8a): the click-to-edit cells are
// the part of that milestone with no other way to be looked at, since a unit
// test can assert what a cell parses but not that it reads as a value rather
// than as a form. Not shipped: scripts/build.mjs copies an explicit file list,
// and this is not on it. Open with:
//
//   open preview-issue.html              (or serve the folder over http)
//
// Fixture states: ?theme=light · ?detail=bare (nothing set, so every editable
// cell shows an em dash) · ?roster=empty (an assignee picker with only the
// current assignee in it) · ?link=refuse (a refused link create and a refused
// unlink). This harness adds ?edit=<field> and ?link=open.
import { params } from "./preview-fixture.js";

const { renderIssueInto } = await import("./js/components/issue-detail.js");
await renderIssueInto(
  document.getElementById("view-container"),
  "ACME-101",
  { email: "preview@example.com", token: "preview" },
  { mode: "page" }
);

// ?edit=points | due | assignee opens that cell, which is the state a screenshot
// cannot reach on its own — and the one worth checking, since an input that
// overflows its cell or loses its value is invisible in the closed state.
const WANTED = { points: "Story points", due: "Due date", assignee: "Assignee" };
const label = WANTED[(params.get("edit") || "").toLowerCase()];
if (label) {
  const cell = [...document.querySelectorAll(".issue-meta-cell")].find((c) =>
    c.querySelector(".issue-meta-label")?.textContent === label
  );
  cell?.querySelector(".editable-cell")?.click();
}

// The link picker is the other state with no way in from a screenshot, and it
// has three worth looking at rather than one:
//
//   ?link=open    the relationship list as the site returned it, nothing typed
//   ?link=search  a query typed, results listed, one of them picked — which is
//                 also the only state that shows the sentence the link will
//                 make, the last chance to notice it reads backwards
//   ?link=refuse  the same, submitted, and refused by Jira
//
// The last two drive the real input handlers rather than setting state, because
// the debounce and the out-of-order guard are the parts worth exercising.
const linkMode = (params.get("link") || "").toLowerCase();
if (linkMode) {
  [...document.querySelectorAll(".issue-links-action")]
    .find((b) => b.textContent === "+ Link")
    ?.click();
}
if (linkMode === "search" || linkMode === "refuse") {
  const search = await waitFor(() => document.querySelector(".create-drawer input[type=text]"));
  search.value = "registry";
  search.dispatchEvent(new Event("input"));
  const first = await waitFor(() => document.querySelector(".link-result"));
  first.click();
  if (linkMode === "refuse") document.querySelector(".create-submit")?.click();
}

// The panel loads its link types and searches on a debounce, so the harness
// waits for what it wants rather than guessing at a delay.
async function waitFor(read, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = read();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("preview: the link picker never reached the expected state");
}
