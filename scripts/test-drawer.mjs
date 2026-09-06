#!/usr/bin/env node
// The drawer's focus layer, in the parts that can be checked without a browser:
// which elements a Tab may land on, where the wrap-around happens, and how a
// trigger is described so it can be found again after the view repaints.
//
// Written with the drawer's dialog behaviour, because the bug it replaces was
// invisible in every other kind of test: role="dialog" was set, aria-label was
// set, the panel looked right in a screenshot, and focus was still sitting on
// <body> behind the backdrop while the view underneath answered the keyboard.
//
// Usage: node scripts/test-drawer.mjs

const DRAWER_URL = new URL("../js/components/drawer.js", import.meta.url);

// CSS.escape is the only global the pure helpers touch. Not the spec algorithm
// — enough for the identifiers Jira keys and element ids actually contain.
globalThis.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, "\\$1") };
// focusableIn keeps the currently focused element even when it reads as hidden,
// so that a control being torn down under the cursor cannot empty the cycle.
globalThis.document = { activeElement: null };

const { focusableIn, tabTarget, triggerRecipe } = await import(DRAWER_URL);

let passed = 0;
let failed = 0;
const section = (name) => console.log(`\n── ${name} ──`);
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// ── A fake element, no more of one than these helpers look at ──────────────
class El {
  constructor(tag, attrs = {}, { tabIndex, visible = true, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.id = attrs.id || "";
    this.tabIndex = tabIndex ?? (["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(this.tagName) ? 0 : -1);
    if (attrs.tabindex !== undefined) this.tabIndex = Number(attrs.tabindex);
    this.offsetParent = visible ? {} : null;
    this.children = children;
    this.isConnected = true;
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value: String(value) }));
  }
  getAttribute(name) { return this.attrs.has(name) ? String(this.attrs.get(name)) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  // Selector-independent: the helper's list is a fixed set of tags plus
  // [tabindex], and every element these tests build is one or the other, so
  // "everything in the subtree" is the honest stand-in for a query engine.
  querySelectorAll() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

section("focusableIn");
{
  const btn = new El("button");
  const input = new El("input");
  const disabled = new El("button", { disabled: "" });
  const hiddenByAria = new El("button", { "aria-hidden": "true" });
  const displayNone = new El("button", {}, { visible: false });
  const negative = new El("div", { tabindex: "-1" });
  const explicit = new El("div", { tabindex: "0" });
  const panel = new El("div", {}, { children: [btn, disabled, hiddenByAria, displayNone, negative, input, explicit] });

  const got = focusableIn(panel);
  check("keeps a plain button", got.includes(btn));
  check("keeps an input", got.includes(input));
  check("keeps an explicit tabindex=0", got.includes(explicit));
  check("drops a disabled button", !got.includes(disabled));
  check("drops aria-hidden", !got.includes(hiddenByAria));
  check("drops display:none", !got.includes(displayNone));
  check("drops tabindex=-1 (script-only, like the panel itself)", !got.includes(negative));
  check("keeps document order", got[0] === btn && got[got.length - 1] === explicit);
}

section("tabTarget — the wrap-around");
{
  const panel = new El("div", {}, { tabIndex: -1 });
  const a = new El("button");
  const b = new El("button");
  const c = new El("button");
  const items = [a, b, c];

  check("Tab in the middle is left to the browser",
    tabTarget({ items, target: b, panel, shiftKey: false }) === null);
  check("Tab on the last wraps to the first",
    tabTarget({ items, target: c, panel, shiftKey: false }) === a);
  check("Shift+Tab on the first wraps to the last",
    tabTarget({ items, target: a, panel, shiftKey: true }) === c);
  check("Shift+Tab in the middle is left to the browser",
    tabTarget({ items, target: b, panel, shiftKey: true }) === null);
  check("Shift+Tab from the panel itself goes to the last",
    tabTarget({ items, target: panel, panel, shiftKey: true }) === c);
  check("Tab from the panel itself is left to the browser, which moves to the first",
    tabTarget({ items, target: panel, panel, shiftKey: false }) === null);
}
{
  const panel = new El("div", {}, { tabIndex: -1 });
  const only = new El("button");
  check("a single focusable cycles back to itself",
    tabTarget({ items: [only], target: only, panel, shiftKey: false }) === only);
  check("…in both directions",
    tabTarget({ items: [only], target: only, panel, shiftKey: true }) === only);
  // A panel that has not finished loading its content: the keyboard must not
  // walk out into the dimmed view behind it.
  check("an empty panel keeps focus on itself",
    tabTarget({ items: [], target: panel, panel, shiftKey: false }) === panel);
  check("…including on Shift+Tab",
    tabTarget({ items: [], target: panel, panel, shiftKey: true }) === panel);
}

section("triggerRecipe — finding the trigger again after a repaint");
{
  check("an id wins", triggerRecipe(new El("div", { id: "freeze-row" })) === "#freeze-row");
  check("a board card is found by its issue key",
    triggerRecipe(new El("div", { "data-issue-key": "ACME-101" })) === 'div[data-issue-key="ACME-101"]');
  check("several data attributes all narrow it",
    triggerRecipe(new El("div", { "data-issue-key": "ACME-101", "data-col-idx": "2" })) ===
      'div[data-issue-key="ACME-101"][data-col-idx="2"]');
  check("class-only elements have no recipe (fall back to the element, then the view)",
    triggerRecipe(new El("button", { class: "bl-row" })) === null);
  check("an empty data attribute is not an identity",
    triggerRecipe(new El("div", { "data-issue-key": "" })) === null);
  check("<body> has no recipe", triggerRecipe(null) === null);
}

console.log(`\n── ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
