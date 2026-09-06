#!/usr/bin/env node
// Packages the extension for Chrome, Firefox and Edge.
//
// This is not a build step in the bundler sense — nothing is compiled,
// transpiled or minified, and the source that ships is the source in the repo.
// All it does is copy the runtime files into dist/<target>/ and write the one
// file that genuinely cannot be shared: the manifest. Chrome needs a `key` and
// a service-worker background; Firefox needs a gecko id and an event-page
// background; Edge needs the Chrome shape with the key removed. Those are
// mutually exclusive in one file, so they are three files.
//
// Loading the repo directory unpacked in Chrome still works and still needs no
// build — manifest.json at the root is the Chrome manifest. This script exists
// for the other two targets and for producing store uploads.
//
// Usage:
//   node scripts/build.mjs                 # all targets
//   node scripts/build.mjs firefox         # one target
//   node scripts/build.mjs --zip           # also produce dist/<target>.zip
//   node scripts/build.mjs --local-assets  # include assets/brand + assets/avatars

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
// The per-target manifest sources. Only the *generated* Chrome manifest lives
// at the repo root, because that is where a browser looks when the repo is
// loaded unpacked; the four files it is built from have no such requirement
// and sit together here instead of scattered across the root.
const MANIFESTS = path.join(ROOT, "manifests");

export const TARGETS = ["chrome", "firefox", "edge"];

// What actually ships. An allowlist rather than an ignore list: a deny list
// silently starts shipping whatever gets added next, and this package would
// otherwise be one careless commit away from containing config.local.json or
// somebody's avatars.
const INCLUDE_FILES = [
  "app.html",
  "issue.html",
  "recap.html",
  "settings.html",
  "settings.js",
  "background.js",
];
const INCLUDE_DIRS = ["js", "css", "libs", "assets"];

// Never ship, ever.
const EXCLUDE_PATTERNS = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.gitkeep$/,
  /^config\.local\.json$/,
];

// assets/brand and assets/avatars are gitignored working folders holding org
// marks and photographs of colleagues. They are excluded by default because
// personal data has no business in a store upload.
//
// But they are also what a roster's `avatarOverride` points at, so a build
// without them silently drops everyone's picture — which is exactly what
// happens when someone exports their config from Chrome (running unpacked from
// the repo, where the files exist) and imports it into a packaged Firefox
// build. --local-assets is for that case: a build for your own machine.
const LOCAL_ASSET_PATTERNS = [/^assets\/brand\//, /^assets\/avatars\//];

function isExcluded(relativePath, { localAssets = false } = {}) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(relativePath))) return true;
  if (!localAssets && LOCAL_ASSET_PATTERNS.some((re) => re.test(relativePath))) return true;
  return false;
}

// Deep merge, overlay wins. Objects merge key by key; anything else replaces,
// so an overlay's `background` fully replaces the base's rather than blending
// a service_worker and a scripts array into one invalid object.
export function mergeManifest(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = mergeManifest(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Keys starting with "_" are documentation for whoever edits the source
// manifests; they are not part of the format and do not ship.
export function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, value]) => [key, stripComments(value)])
    );
  }
  return obj;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function buildManifest(target) {
  const base = await readJson(path.join(MANIFESTS, "base.json"));
  const overlay = await readJson(path.join(MANIFESTS, `${target}.json`));
  return stripComments(mergeManifest(base, overlay));
}

async function copyInto(targetDir, { localAssets = false } = {}) {
  for (const file of INCLUDE_FILES) {
    await fs.copyFile(path.join(ROOT, file), path.join(targetDir, file));
  }
  for (const dir of INCLUDE_DIRS) {
    const entries = await fs.readdir(path.join(ROOT, dir), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const abs = path.join(entry.parentPath ?? entry.path, entry.name);
      const rel = path.relative(ROOT, abs);
      if (isExcluded(rel, { localAssets })) continue;
      const dest = path.join(targetDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(abs, dest);
    }
  }
}

export async function build(target, { zip = false, localAssets = false } = {}) {
  const targetDir = path.join(DIST, target);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  await copyInto(targetDir, { localAssets });
  const manifest = await buildManifest(target);
  await fs.writeFile(
    path.join(targetDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  let zipPath = null;
  if (zip) {
    if (localAssets) {
      // Refused rather than warned: a zip is a thing you upload, and a zip of
      // colleagues' photographs uploaded to a store is not recoverable.
      throw new Error("--zip and --local-assets are mutually exclusive: a store package must not carry personal assets");
    }
    zipPath = path.join(DIST, `${target}-${manifest.version}.zip`);
    await fs.rm(zipPath, { force: true });
    // Shelling out to zip rather than vendoring an archiver: it is present on
    // every machine this is built on, and a dependency to make a zip file
    // would be the first dependency this project has.
    await run("zip", ["-qr", zipPath, "."], { cwd: targetDir });
  }

  const files = await fs.readdir(targetDir, { recursive: true });
  return { target, dir: targetDir, zipPath, fileCount: files.length, version: manifest.version };
}

async function main() {
  const args = process.argv.slice(2);
  const zip = args.includes("--zip");
  const localAssets = args.includes("--local-assets");
  const named = args.filter((a) => !a.startsWith("-"));
  const targets = named.length ? named : TARGETS;

  for (const target of targets) {
    if (!TARGETS.includes(target)) {
      console.error(`Unknown target "${target}". Known: ${TARGETS.join(", ")}`);
      process.exit(1);
    }
  }

  for (const target of targets) {
    const result = await build(target, { zip, localAssets });
    console.log(
      `  ✓ ${result.target.padEnd(8)} v${result.version}  ${String(result.fileCount).padStart(3)} files  ${path.relative(ROOT, result.dir)}` +
        (result.zipPath ? `  +${path.relative(ROOT, result.zipPath)}` : "")
    );
  }
  if (localAssets) {
    console.log("  ! includes assets/brand and assets/avatars — local install only, do not upload");
  }

  // The root manifest.json is the Chrome one, regenerated here so that "load
  // the repo directory unpacked" keeps working with no build step *and* cannot
  // drift away from manifests/base.json. It is committed; a diff after a build
  // means someone edited the generated file instead of the sources.
  if (targets.includes("chrome")) {
    const chrome = await buildManifest("chrome");
    await fs.writeFile(
      path.join(ROOT, "manifest.json"),
      `${JSON.stringify(chrome, null, 2)}\n`
    );
    console.log("  ✓ manifest.json (repo root, Chrome — for unpacked loading)");
  }
}

// Importable for the test suite; only builds when run directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
