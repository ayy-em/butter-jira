#!/usr/bin/env node
// Writes a version into manifest.base.json, and regenerates the root
// manifest.json that is derived from it (M19).
//
// Releases are tag-led: `git push origin v0.6.0` is the whole ritual, and this
// script is what turns the tag into the number the three packages carry. The
// alternative — manifest-led, CI checking the tag against a hand-bumped file
// and failing on a mismatch — keeps the repo self-consistent at every commit,
// but it makes releasing two steps, and the second step is the one that gets
// forgotten at the end of a Friday. The release workflow carries the bump back
// to main straight after publishing, so the repo catches up rather than
// leading.
//
// The edit is a targeted rewrite of the one line rather than a JSON
// round-trip. manifest.base.json opens with a `_comment` array written for
// whoever edits it by hand, and reserialising the file is one formatting
// decision away from churning every line of a file nobody asked to reformat.
//
// Usage:
//   node scripts/set-version.mjs 0.6.0

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SEMVER = /^\d+\.\d+\.\d+$/;

// Matches the one `"version": "…"` line at the top level of the manifest, and
// nothing nested: `[ \t]*` rather than `\s*` so the anchors cannot swallow a
// newline and reach a version inside some future nested object.
const VERSION_LINE = /^([ \t]*"version"[ \t]*:[ \t]*)"[^"]*"(,?)$/gm;

// Importable so the test suite can exercise the rewrite without a file.
export function setVersionIn(text, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`Not a version: "${version}". Expected X.Y.Z, with no leading "v"`);
  }
  const found = text.match(VERSION_LINE) ?? [];
  if (found.length !== 1) {
    throw new Error(`Expected exactly one "version" line, found ${found.length}`);
  }
  return text.replace(VERSION_LINE, `$1"${version}"$2`);
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/set-version.mjs X.Y.Z");
    process.exit(1);
  }

  const basePath = path.join(ROOT, "manifest.base.json");
  const before = await fs.readFile(basePath, "utf8");
  let after;
  try {
    after = setVersionIn(before, version);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    process.exit(1);
  }

  if (after === before) {
    console.log(`  = manifest.base.json is already v${version}`);
  } else {
    await fs.writeFile(basePath, after);
    console.log(`  ✓ manifest.base.json → v${version}`);
  }

  // The root manifest.json is generated from the base and committed, so it has
  // to follow in the same breath — leaving it behind is exactly the drift that
  // build.mjs's own comment warns about, and CI would fail the next push. This
  // is build.mjs's own function, not a copy of its logic.
  const chrome = await buildManifest("chrome");
  await fs.writeFile(
    path.join(ROOT, "manifest.json"),
    `${JSON.stringify(chrome, null, 2)}\n`
  );
  console.log(`  ✓ manifest.json (repo root, Chrome) → v${chrome.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
