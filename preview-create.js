// Local preview harness for the create-issue panel.
//
// The form is generated from whatever `/rest/api/3/issue/createmeta` returns, so
// there is no way to know what it looks like by reading the code — which is the
// argument for a harness. Mounts the real panel against the shared fixture's
// createmeta, so every control can be looked at without a site or a token. Not
// shipped: scripts/build.mjs copies an explicit file list, and this is not on
// it. Open with:
//
//   open preview-create.html             (or serve the folder over http)
//
// Fixture states, all from preview-fixture.js:
//   ?theme=light          the light palette
//   ?createmeta=minimal   a project that requires nothing but a summary
//   ?createmeta=blocked   a required field the form cannot render — the refusal
//   ?create=refuse        Jira refusing the create, attributed to its field
//   ?roster=empty         a person picker with nobody in it
//   ?parent=ABC-1         the sub-task form: parent fixed, type discovered
import { params } from "./preview-fixture.js";

const { openCreateIssue } = await import("./js/components/issue-create.js");

// Something behind the panel, so the drawer's backdrop and its measuring have a
// page to sit over rather than a blank window.
const behind = document.getElementById("view-container");
behind.innerHTML =
  '<div style="padding:28px;font-family:\'Ubuntu Sans Mono\',ui-monospace,monospace;' +
  'font-size:12px;color:var(--muted);line-height:1.9">' +
  "preview-create.html — the panel opens over this.<br>" +
  "?createmeta=minimal · ?createmeta=blocked · ?create=refuse · ?parent=ABC-1 · ?theme=light" +
  "</div>";

const parentKey = params.get("parent") || "";
await openCreateIssue(
  { email: "preview@example.com", token: "preview" },
  parentKey
    ? { parentKey, parentSummary: "The parent issue this sub-task hangs off" }
    : {}
);
