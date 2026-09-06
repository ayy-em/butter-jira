#!/usr/bin/env node
// Contrast checks that can be made statically, over the CSS itself.
//
// Written after ten primary buttons shipped at 3.21:1 in dark theme — #fff on
// the dark accent — while the eleventh, `.create-submit`, was correct and got
// "fixed" into line with the other ten. A reviewer cannot hold eleven selectors
// and two palettes in their head; this file can.
//
// Two things are checked:
//
//   1. The theme token pairs themselves clear AA, computed from the hex values
//      declared in css/app.css rather than from numbers retyped here.
//   2. No rule paints var(--accent-primary) as a background and then names its
//      own label colour. The label belongs to --on-accent, which flips per
//      theme; a literal there is wrong in one theme by construction.
//
// Usage: node scripts/test-contrast.mjs

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

// ── WCAG 2.1 relative luminance and contrast ratio ────────────────────────
const luminance = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// ── The palette, read out of the stylesheet ───────────────────────────────
const appCss = await fs.readFile(path.join(ROOT, "css", "app.css"), "utf8");

// Token blocks are `:root,\n[data-theme="dark"] { … }` and `[data-theme="light"] { … }`.
// A token can be declared in more than one block per theme (the accents and the
// extended palette are separate blocks), so later declarations win, as in CSS.
const tokensFor = (theme) => {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(appCss))) {
    const selector = m[1];
    const matchesTheme =
      selector.includes(`[data-theme="${theme}"]`) ||
      (theme === "dark" && /(^|,)\s*:root\s*(,|$)/.test(selector));
    if (!matchesTheme) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      out[d[1]] = d[2];
    }
  }
  return out;
};

const dark = tokensFor("dark");
const light = tokensFor("light");

section("theme tokens are declared in both themes");
for (const token of ["--bg", "--surface", "--text", "--muted", "--accent-primary", "--on-accent"]) {
  check(`dark  ${token}`, Boolean(dark[token]), Object.keys(dark).join(", "));
  check(`light ${token}`, Boolean(light[token]), Object.keys(light).join(", "));
}

section("AA (4.5:1) on the pairs the app actually paints");
// Body copy and the primary button label. Muted text is 11-13px in places but
// is never the only carrier of a fact, so it is held to the same floor as the
// rest rather than to the large-text 3:1 exemption.
const pairs = [
  ["--text", "--bg"],
  ["--text", "--surface"],
  ["--muted", "--bg"],
  ["--muted", "--surface"],
  ["--on-accent", "--accent-primary"],
];
for (const [theme, tokens] of [["dark", dark], ["light", light]]) {
  for (const [fg, bg] of pairs) {
    const r = contrast(tokens[fg], tokens[bg]);
    check(
      `${theme}: ${fg} on ${bg} = ${r.toFixed(2)}:1`,
      r >= 4.5,
      `${tokens[fg]} on ${tokens[bg]} needs 4.5:1`
    );
  }
}

section("--on-accent is the only label colour used on the accent");
// Anything that sets `background: var(--accent-primary)` and also sets a colour
// in the same rule must take that colour from the token. A literal, or
// var(--bg)/var(--text) directly, is right in one theme and wrong in the other.
const styleFiles = [];
for (const f of await fs.readdir(path.join(ROOT, "css"))) {
  if (f.endsWith(".css")) styleFiles.push(path.join(ROOT, "css", f));
}
for (const f of ["settings.html", "app.html", "issue.html", "recap.html"]) {
  styleFiles.push(path.join(ROOT, f));
}

const offenders = [];
for (const file of styleFiles) {
  const src = await fs.readFile(file, "utf8");
  const rel = path.relative(ROOT, file);
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[2];
    // Solid accent only. A color-mix tint or a gradient stop is a different
    // question — those grounds are mostly the surface showing through, and the
    // rules that use them sit their text at accent-on-surface, not on the accent.
    if (!/background(-color)?\s*:\s*var\(--accent-primary\)\s*(!important)?\s*[;}]/.test(body)) continue;
    const colour = body.match(/(?:^|[;{\s])color\s*:\s*([^;]+)/);
    if (!colour) continue; // inherits; not this rule's problem
    const value = colour[1].trim();
    if (value === "var(--on-accent)") continue;
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`${rel}:${line}  ${m[1].trim().split("\n").pop()} → color: ${value}`);
  }
}
check(
  "no rule names its own label colour on an accent background",
  offenders.length === 0,
  offenders.join("\n      ")
);

// The same mistake, made inline from JS.
const inline = [];
async function walkJs(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walkJs(abs);
    else if (e.name.endsWith(".js")) {
      const src = await fs.readFile(abs, "utf8");
      for (const hit of src.matchAll(/background:\s*var\(--accent-primary\)\s*;\s*color:\s*([^;"']+)/g)) {
        if (hit[1].trim() === "var(--on-accent)") continue;
        inline.push(`${path.relative(ROOT, abs)}  color: ${hit[1].trim()}`);
      }
    }
  }
}
await walkJs(path.join(ROOT, "js"));
check("no inline style sets a literal label on an accent background", inline.length === 0, inline.join("\n      "));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
