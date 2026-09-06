#!/usr/bin/env node
// Unit checks for the per-target manifests (M12).
//
// These encode the store rules that only bite at submission time — the ones you
// find out about by having an upload rejected, weeks after the code was
// written. A `key` left in a Firefox package, a service-worker background on
// Gecko, a missing gecko id quietly breaking storage.sync: all of them load
// fine in the browser you happened to test in.
//
// Usage: node scripts/test-manifests.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, buildManifest, mergeManifest, stripComments } from "./build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

section("merge semantics");
check("overlay wins on a scalar",
  mergeManifest({ a: 1 }, { a: 2 }).a === 2);
check("objects merge key by key",
  JSON.stringify(mergeManifest({ o: { a: 1, b: 2 } }, { o: { b: 3 } }).o) === '{"a":1,"b":3}');
check("arrays replace rather than concatenate",
  JSON.stringify(mergeManifest({ a: [1, 2] }, { a: [3] }).a) === "[3]");
check("base-only keys survive",
  mergeManifest({ keep: true }, {}).keep === true);
check("_comment keys are stripped",
  !("_comment" in stripComments({ _comment: "x", real: 1 })));
check("stripping reaches nested objects",
  !("_note" in stripComments({ o: { _note: "x", real: 1 } }).o));

const manifests = {};
for (const target of TARGETS) manifests[target] = await buildManifest(target);

section("shared invariants");
for (const [target, m] of Object.entries(manifests)) {
  check(`${target}: manifest v3`, m.manifest_version === 3);
  check(`${target}: has a name and version`, Boolean(m.name) && /^\d+\.\d+\.\d+$/.test(m.version));
  check(`${target}: storage permission`, m.permissions.includes("storage"));
  check(`${target}: no broad tabs permission`, !m.permissions.includes("tabs"));
  check(`${target}: Jira and GitHub origins granted up front`,
    m.host_permissions.includes("https://*.atlassian.net/*") &&
    m.host_permissions.includes("https://api.github.com/*"));
  check(`${target}: CSP forbids remote script`,
    /script-src 'self'/.test(m.content_security_policy.extension_pages) &&
    !/script-src[^;]*https:/.test(m.content_security_policy.extension_pages));
  check(`${target}: no documentation keys shipped`,
    !Object.keys(m).some((k) => k.startsWith("_")));
  check(`${target}: background is a module`, m.background.type === "module");
}

section("icon files exist");
// A manifest naming an icon that is not there loads with a blank toolbar slot
// in Chrome and is rejected outright by a store review. The paths are strings
// in a JSON file, so nothing else notices when one is renamed.
for (const [target, m] of Object.entries(manifests)) {
  const declared = [
    ...Object.values(m.icons),
    ...Object.values(m.action.default_icon),
  ];
  check(`${target}: declares the mark at 16, 32, 48 and 128`,
    ["16", "32", "48", "128"].every((s) => s in m.icons && s in m.action.default_icon));
  check(`${target}: every declared icon file is on disk`,
    declared.every((rel) => fs.existsSync(path.join(ROOT, rel))));
}

section("versions are in lockstep");
check("every target ships the same version",
  new Set(Object.values(manifests).map((m) => m.version)).size === 1);

section("chrome");
const chrome = manifests.chrome;
check("keeps the pinned key so unpacked storage survives a re-add",
  typeof chrome.key === "string" && chrome.key.length > 100);
check("service-worker background", chrome.background.service_worker === "background.js");
check("no event-page scripts array", chrome.background.scripts === undefined);
check("no gecko settings", chrome.browser_specific_settings === undefined);

section("firefox");
const firefox = manifests.firefox;
// The three that would each be found only at submission or first sync.
check("NO key — it is a Chrome mechanism and Firefox rejects the package",
  firefox.key === undefined);
check("event-page background, not a service worker",
  Array.isArray(firefox.background.scripts) && firefox.background.scripts[0] === "background.js");
check("no service_worker key at all", firefox.background.service_worker === undefined);
check("gecko id present — storage.sync silently does nothing without one",
  typeof firefox.browser_specific_settings?.gecko?.id === "string" &&
  firefox.browser_specific_settings.gecko.id.includes("@"));
check("a minimum version is declared",
  /^\d+\.\d+$/.test(firefox.browser_specific_settings.gecko.strict_min_version || ""));
check("minimum is at least 115 (MV3 + optional_host_permissions)",
  parseInt(firefox.browser_specific_settings.gecko.strict_min_version, 10) >= 115);
check("no minimum_chrome_version", firefox.minimum_chrome_version === undefined);

section("edge");
const edge = manifests.edge;
check("NO key — Edge Add-ons assigns its own identity",
  edge.key === undefined);
check("service-worker background, same as Chrome",
  edge.background.service_worker === "background.js");
check("no gecko settings", edge.browser_specific_settings === undefined);
check("otherwise identical to Chrome",
  JSON.stringify({ ...chrome, key: undefined }) === JSON.stringify({ ...edge, key: undefined }));

section("no target leaks another's background shape");
for (const [target, m] of Object.entries(manifests)) {
  const hasBoth = Boolean(m.background.service_worker) && Boolean(m.background.scripts);
  check(`${target}: exactly one background form`, !hasBoth);
}

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
