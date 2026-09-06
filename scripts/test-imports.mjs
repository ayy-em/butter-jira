#!/usr/bin/env node
// Catches identifiers used in a module without being imported into it.
//
// Written after exactly that bug shipped: a mechanical migration swapped
// `chrome.storage.sync.get(...)` for `syncGet(...)` across twenty files and
// missed the import in two of them. Nothing caught it —
//
//   - `node --check` parses, it does not resolve identifiers;
//   - the unit suites never import the view modules, which are DOM-heavy;
//   - the one browser render exercised the Backlog, and the broken views were
//     Kanban and Monitor.
//
// …so the first report came from a person clicking a tab. This closes that gap
// statically: for every source module, any identifier that some *other* local
// module exports, and that this file calls without importing or declaring, is
// a failure.
//
// Deliberately not eslint: that is a dependency and a config file for one rule
// this project actually needs. If the rule set grows past a handful, revisit.
//
// Usage: node scripts/test-imports.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

async function sourceFiles() {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["libs", "node_modules", "dist", ".git", "assets"].includes(entry.name)) continue;
        await walk(abs);
      } else if (entry.name.endsWith(".js")) {
        out.push(abs);
      }
    }
  }
  await walk(path.join(ROOT, "js"));
  for (const f of ["settings.js", "background.js"]) out.push(path.join(ROOT, f));
  return out;
}

// Comments and strings are stripped first so a name mentioned in prose is not
// mistaken for a reference.
//
// A template literal keeps its ${…} bodies. It used to be flattened whole, on
// the grounds that a name inside one is usually prose — and then
// `aria-label = `Remove ${displayNameFor(id)}`` went in without its import and
// this file said nothing, which is precisely the bug it was written for.
// Interpolations are code; only the text between them is prose.
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, (literal) =>
      // Coarse: a ${} holding an object literal ends at its first }, which
      // costs a truncated expression rather than a false alarm.
      [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => `(${m[1]})`).join(" ") || '""'
    )
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  // `import * as sfx from …` and default imports.
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  return names;
}

// Anything bound inside this file: declarations, parameters, catch bindings,
// object destructuring. Coarse on purpose — over-collecting here only costs a
// missed warning, while under-collecting would cost a false alarm.
function localNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|[^.\w])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0]?.trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/function[^(]*\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0]?.trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// Called as a bare function: `foo(`, but not `x.foo(` or `function foo(`.
function calledNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[2]);
  return names;
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "await", "new", "do", "else", "throw", "super", "import", "yield", "void",
  "delete", "in", "of", "case", "with",
]);

const files = await sourceFiles();
const exportsByName = new Map();   // name -> Set(file)
const sources = new Map();

for (const file of files) {
  const src = stripNoise(await fs.readFile(file, "utf8"));
  sources.set(file, src);
  for (const name of exportedNames(src)) {
    if (!exportsByName.has(name)) exportsByName.set(name, new Set());
    exportsByName.get(name).add(file);
  }
}

section("every module imports what it uses");
check(`scanned ${files.length} source modules`, files.length > 20);
check(`found ${exportsByName.size} exported names across them`, exportsByName.size > 50);

const problems = [];
for (const [file, src] of sources) {
  const imported = importedNames(src);
  const local = localNames(src);
  const own = exportedNames(src);

  for (const name of calledNames(src)) {
    if (KEYWORDS.has(name)) continue;
    if (imported.has(name) || local.has(name) || own.has(name)) continue;
    const providers = exportsByName.get(name);
    if (!providers) continue;                       // not one of ours; a global
    if (providers.size === 1 && providers.has(file)) continue;
    problems.push({
      file: path.relative(ROOT, file),
      name,
      from: [...providers].map((f) => path.relative(ROOT, f)).join(", "),
    });
  }
}

check(
  "no module calls another module's export without importing it",
  problems.length === 0,
  problems.map((p) => `${p.file}: ${p.name}()  — exported by ${p.from}`).join("\n      ")
);

section("the shim is the only module naming a browser");
for (const [file, src] of sources) {
  const rel = path.relative(ROOT, file);
  if (rel === "js/browser.js") continue;
  const hits = [...src.matchAll(/\b(?:chrome|browser)\.[a-zA-Z]/g)].map((m) => m[0]);
  check(`${rel}: no direct chrome.*/browser.* use`, hits.length === 0, hits.slice(0, 3).join(", "));
}

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
