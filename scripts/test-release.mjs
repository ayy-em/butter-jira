#!/usr/bin/env node
// Unit checks for the release path (M19).
//
// The release workflow is the one operation in this project with no undo: a
// published asset can be deleted from the page but not from the machines that
// already pulled it. Everything the workflow relies on that can be checked
// without a tag is checked here, so the first time a rule is exercised is not
// the run that publishes.
//
// Usage: node scripts/test-release.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setVersionIn, SEMVER } from "./set-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const throws = (name, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw);
};
const section = (t) => console.log(`\n── ${t} ──`);

section("version rewriting");
const base = read("manifest.base.json");
const bumped = setVersionIn(base, "9.8.7");
check("the version line is rewritten",
  JSON.parse(bumped).version === "9.8.7");
check("exactly one line changes",
  base.split("\n").filter((l, i) => l !== bumped.split("\n")[i]).length === 1);
check("the _comment block survives",
  JSON.parse(bumped)._comment?.length === JSON.parse(base)._comment?.length);
check("nothing else in the manifest moves",
  JSON.stringify({ ...JSON.parse(bumped), version: null }) ===
  JSON.stringify({ ...JSON.parse(base), version: null }));
check("the file still ends the way it started",
  bumped.endsWith("\n") === base.endsWith("\n"));
check("idempotent — setting the same version twice is a no-op",
  setVersionIn(bumped, "9.8.7") === bumped);
check("round-trips back to where it started",
  setVersionIn(bumped, JSON.parse(base).version) === base);

section("versions the workflow must refuse");
// The tag is stripped of its leading v before it gets here; anything that
// reaches this function with a v on it means that stripping broke.
throws("a tag name, v and all", () => setVersionIn(base, "v9.8.7"));
throws("two components", () => setVersionIn(base, "9.8"));
throws("four components", () => setVersionIn(base, "9.8.7.6"));
throws("a prerelease suffix", () => setVersionIn(base, "9.8.7-rc1"));
throws("empty", () => setVersionIn(base, ""));
throws("not a number in sight", () => setVersionIn(base, "latest"));
check("SEMVER is exported for the workflow's own check to match",
  SEMVER.test("0.6.0") && !SEMVER.test("v0.6.0"));

section("no generated-file drift, as committed");
// CI asserts this against a fresh build; asserting it here too means a stale
// root manifest is caught by the suite you run before pushing, not by the
// pipeline afterwards.
const rootManifest = JSON.parse(read("manifest.json"));
check("root manifest.json version matches manifest.base.json",
  rootManifest.version === JSON.parse(base).version);
check("root manifest.json carries no _comment keys",
  !Object.keys(rootManifest).some((k) => k.startsWith("_")));

section("the licence exists and says what the README says it says");
const licence = read("LICENSE");
check("LICENSE is present at the repo root", licence.length > 0);
check("it is PolyForm Noncommercial 1.0.0",
  licence.includes("PolyForm Noncommercial License 1.0.0"));
check("it carries a Required Notice line, which the licence's own Notices clause obliges",
  /^Required Notice: Copyright \S/m.test(licence));
check("it disclaims liability",
  licence.includes("without any warranty or condition"));
const readme = read("README.md");
check("the README's licence section names the licence rather than promising one",
  /## Licence[\s\S]{0,600}PolyForm Noncommercial/.test(readme));
check("the README no longer says a licence is unchosen",
  !/not yet chosen/i.test(readme));

section("workflows");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
check("release triggers on version tags", /tags:\s*\[\s*['"]v\*['"]\s*\]/.test(release));
check("release does not also trigger on a branch push",
  !/branches:/.test(release));
check("CI runs on pushes to main", /branches:\s*\[\s*main\s*\]/.test(ci));
check("CI runs on pull requests", /pull_request:/.test(ci));
// Both run every suite by glob rather than by list, so a new scripts/test-*.mjs
// is picked up by being written and not by also being remembered here.
check("CI runs the suites by glob", ci.includes("scripts/test-*.mjs"));
check("release runs the suites by glob", release.includes("scripts/test-*.mjs"));
check("release refuses to publish personal assets",
  /assets\/\(brand\|avatars\)/.test(release));
check("release asserts the archive's manifest version",
  release.includes("unzip -p"));
check("release publishes checksums", release.includes("SHA256SUMS"));
check("release needs write permission to publish and to push the bump",
  /permissions:\s*\n\s*contents:\s*write/.test(release));
// The notes a release page opens with. Install first, then what changed, and
// the changed half comes from a file rather than from commit subjects.
const changelog = read("CHANGELOG.md");
const manifestVersion = JSON.parse(read("manifest.base.json")).version;
check("CHANGELOG.md carries a section for the version in the manifests",
  new RegExp(`^## v${manifestVersion.replace(/\./g, "\\.")}\\s*$`, "m").test(changelog));
check("that section says something",
  (changelog.split(`## v${manifestVersion}`)[1] || "").split(/^## /m)[0].trim().length > 200);
check("release notes lead with how to install",
  /## Install/.test(release) && release.indexOf("## Install") < release.indexOf("What's new"));
check("release notes name a file per browser",
  release.includes("chrome-$version.zip") && release.includes("firefox-$version.zip") &&
  release.includes("edge-$version.zip"));
check("release notes say Firefox installs are temporary",
  /Firefox installs are temporary/.test(release));
check("what changed is lifted out of CHANGELOG.md rather than from commit subjects",
  release.includes("CHANGELOG.md") && /awk -v v="## v\$version"/.test(release));
check("a tag with no changelog section fails instead of publishing",
  /no '## v\$version' section/.test(release) && /exit 1/.test(release));
check("re-running a tag refreshes the notes, not only the assets",
  /gh release edit "\$GITHUB_REF_NAME" --notes-file/.test(release));

check("CI needs no write permission",
  /permissions:\s*\n\s*contents:\s*read/.test(ci));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
