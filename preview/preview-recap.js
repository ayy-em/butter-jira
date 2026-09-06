// Local preview harness for the printable sprint recap.
//
// Runs the real js/recap-page.js against the shared preview fixture, so the
// document can be read — and printed to PDF — without a site, a token or a
// roster. Not shipped: scripts/build.mjs copies an explicit file list, and this
// is not on it. Open with:
//
//   open preview-recap.html              (or serve the folder over http)
//
// Fixture states: ?theme=light · ?github=off · ?stats=error · ?sprint=undated ·
// ?push=off · ?avatars=off · ?roster=empty · ?freeze=mid|none — the last of
// which is the one to check before changing the scope wording: with no freeze
// the document prints the creation-date approximation and the "what changed"
// section says there is nothing to compare against.
import { params } from "./preview-fixture.js";

// The print dialog is opt-in here. Previewing is reading, and a dialog opening
// over the document every reload makes that impossible — ?print=1 asks for it.
if (params.get("print") !== "1") {
  const url = new URL(location.href);
  url.searchParams.set("print", "0");
  history.replaceState(null, "", url);
}

await import("../js/recap-page.js");
