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
// current assignee in it). This harness adds ?edit=<field>.
import { params } from "./preview-fixture.js";

const { renderIssueInto } = await import("./js/components/issue-detail.js");
await renderIssueInto(
  document.getElementById("view-container"),
  "CTS-101",
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
