#!/usr/bin/env node
// Unit checks for the command palette's pure layer: query parsing, fuzzy
// scoring, ranking, grouping and recents. No dependencies, no network, no
// browser.
//
// Usage: node scripts/test-palette.mjs

const PALETTE_URL = new URL("../js/palette.js", import.meta.url);

const p = await import(PALETTE_URL);

let passed = 0;
let failed = 0;

const section = (name) => console.log(`\n── ${name} ──`);
const check = (name, cond) => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
};

// Convenience: rank a list of plain labels and return the labels in order.
const order = (query, labels, kind = "issue") =>
  p
    .rankItems(
      query,
      labels.map((label, i) => ({ kind, id: `i${i}`, label }))
    )
    .map((r) => r.label);

section("query parsing");
check("plain text is a search", p.parseQuery("abc").mode === "search");
check("search value is trimmed", p.parseQuery("  abc  ").value === "abc");
check("prefix switches to jql", p.parseQuery(">assignee = x").mode === "jql");
check("jql value drops the prefix", p.parseQuery(">assignee = x").value === "assignee = x");
check("leading space before prefix still jql", p.parseQuery("  >project = AB").mode === "jql");
check("bare prefix is jql with empty value", p.parseQuery(">").value === "");
check("prefix mid-string is not jql", p.parseQuery("a > b").mode === "search");
check("empty input is a search", p.parseQuery("").mode === "search");
check("null tolerated", p.parseQuery(null).value === "");

section("fuzzy scoring");
check("empty query matches anything", p.fuzzyScore("", "whatever").score === 0);
check("no match returns null", p.fuzzyScore("zzz", "abc") === null);
check("empty text returns null", p.fuzzyScore("a", "") === null);
check("substring matches", p.fuzzyScore("auth", "Refactor auth guard") !== null);
check("subsequence matches", p.fuzzyScore("rag", "Refactor auth guard") !== null);
check("out-of-order does not match", p.fuzzyScore("gra", "Refactor auth guard") === null);
check("case insensitive", p.fuzzyScore("AUTH", "refactor auth guard") !== null);
check("positions point at the match",
  JSON.stringify(p.fuzzyScore("auth", "xx auth").positions) === "[3,4,5,6]");
check("substring beats subsequence",
  p.fuzzyScore("auth", "auth guard").score > p.fuzzyScore("auth", "a us t h").score);
check("earlier match scores higher",
  p.fuzzyScore("bug", "bug in the parser").score >
    p.fuzzyScore("bug", "the parser has a bug").score);
check("word-boundary start beats mid-word",
  p.fuzzyScore("cat", "the cat sat").score > p.fuzzyScore("cat", "concatenate").score);
check("shorter haystack wins on equal hits",
  p.fuzzyScore("ab", "a b").score > p.fuzzyScore("ab", "a very long b string here"). score);

section("ranking");
check("exact key first",
  order("abc-1", ["ABC-1", "ABC-12", "ABC-100"])[0] === "ABC-1");
check("non-matching entries are dropped",
  order("abc", ["ABC-1", "XYZ-9"]).length === 1);
check("limit is honoured",
  p.rankItems("a", Array.from({ length: 60 }, (_, i) => ({ kind: "issue", id: `${i}`, label: `a${i}` })), { limit: 10 })
    .length === 10);
check("empty query returns everything in input order",
  order("", ["one", "two", "three"]).join() === "one,two,three");

section("label beats sublabel");
const keyItem = { kind: "issue", id: "ABC-1", label: "ABC-1", sublabel: "unrelated" };
const summaryItem = { kind: "issue", id: "XYZ-2", label: "XYZ-2", sublabel: "the abc thing" };
check("match on the key outranks a match in the summary",
  p.rankItems("abc", [summaryItem, keyItem])[0].id === "ABC-1");
check("keywords are searchable",
  p.scoreItem("bug", { label: "ABC-9", keywords: ["Bug"] }) !== null);
check("nothing matching anywhere scores null",
  p.scoreItem("zzz", { label: "ABC-9", sublabel: "nope", keywords: ["Bug"] }) === null);
check("boost is applied with no query",
  p.scoreItem("", { label: "x", boost: 50 }).score === 50);
check("boost lifts a weak match",
  p.rankItems("a", [
    { kind: "issue", id: "plain", label: "banana" },
    { kind: "issue", id: "boosted", label: "banana", boost: 5000 },
  ])[0].id === "boosted");

section("grouping");
const grouped = p.groupByKind([
  { kind: "issue", id: "1" },
  { kind: "view", id: "2" },
  { kind: "issue", id: "3" },
]);
check("one group per kind", grouped.length === 2);
check("group order follows first appearance", grouped[0].kind === "issue");
check("members collected into their group", grouped[0].items.length === 2);
check("empty input -> no groups", p.groupByKind([]).length === 0);

section("recents");
let recents = [];
recents = p.addRecent(recents, { kind: "issue", id: "ABC-1" });
recents = p.addRecent(recents, { kind: "issue", id: "ABC-2" });
check("most recent first", recents[0].id === "ABC-2");
check("both kept", recents.length === 2);
recents = p.addRecent(recents, { kind: "issue", id: "ABC-1" });
check("re-selecting moves to front", recents[0].id === "ABC-1");
check("no duplicate created", recents.length === 2);
check("same id, different kind is a separate entry",
  p.addRecent(recents, { kind: "person", id: "ABC-1" }).length === 3);
check("entry without an id is ignored",
  p.addRecent(recents, { kind: "issue" }).length === 2);
const many = Array.from({ length: 30 }, (_, i) => ({ kind: "issue", id: `X-${i}` }));
check("capped at the maximum",
  many.reduce((acc, e) => p.addRecent(acc, e), []).length === p.RECENTS_MAX);
check("non-array input normalises to empty", p.normalizeRecents("nope").length === 0);
check("malformed entries dropped",
  p.normalizeRecents([{ kind: "issue", id: "ok" }, { kind: 5 }, null]).length === 1);
check("recent boost is positive",
  p.recentBoost([{ kind: "issue", id: "ABC-1" }], { kind: "issue", id: "ABC-1" }) > 0);
check("more recent means a bigger boost",
  p.recentBoost([{ kind: "issue", id: "a" }, { kind: "issue", id: "b" }], { kind: "issue", id: "a" }) >
    p.recentBoost([{ kind: "issue", id: "a" }, { kind: "issue", id: "b" }], { kind: "issue", id: "b" }));
check("unseen item gets no boost",
  p.recentBoost([{ kind: "issue", id: "a" }], { kind: "issue", id: "z" }) === 0);
check("a strong direct match still beats a recent",
  p.rankItems("xyz", [
    { kind: "issue", id: "ABC-1", label: "ABC-1", boost: p.recentBoost([{ kind: "issue", id: "ABC-1" }], { kind: "issue", id: "ABC-1" }) },
    { kind: "issue", id: "XYZ-9", label: "XYZ-9" },
  ])[0].id === "XYZ-9");

console.log(`\n── ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
