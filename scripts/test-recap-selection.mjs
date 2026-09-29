#!/usr/bin/env node
// Unit checks for the recap selection carried in recap.html / quarter.html URLs:
// board-qualified sprint ids, older bare-id links, the board list, and the gap
// test the document uses to explain its GitHub window. Pure, no shims needed.
//
// Usage: node scripts/test-recap-selection.mjs

const sel = await import(new URL("../js/recap-selection.js", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};

const parsed = sel.parseSprintSelection("12:7938,12:7735, 14:801,555,junk,12:x");
check("pairs grouped by board", [...parsed.pairs.get("12")].join(",") === "7938,7735" && parsed.pairs.get("14").has("801"));
check("bare ids kept for older links", parsed.bare.has("555") && parsed.bare.size === 1);
check("junk ignored", !parsed.pairs.has("x"));
check("explicit when anything parsed", sel.isExplicitSelection(parsed) && !sel.isExplicitSelection(sel.parseSprintSelection("previous")));
check("wanted for a board = its pairs plus bare ids", [...sel.wantedFor(parsed, 12)].sort().join(",") === "555,7735,7938");
check("a board not named still gets bare ids only", [...sel.wantedFor(parsed, 99)].join(",") === "555");
check("board-qualified ids never leak across boards", !sel.wantedFor(sel.parseSprintSelection("12:1"), 14).size);

check("param round-trips", sel.sprintSelectionParam({ 12: ["7938", "7735", "7938"], 14: [801] }) === "12:7938,12:7735,14:801");
check("empty selection has no link", sel.recapHref({}) === "" && sel.recapHref({ 12: [] }) === "");
check("recap link", sel.recapHref({ 3: [9] }) === "recap.html?sprint=3:9");
check("quarter link with boards", sel.quarterHref(["1", "3", "3", "x"]) === "quarter.html?boards=1,3");
check("quarter link without boards", sel.quarterHref([]) === "quarter.html");
check("board list parses", sel.parseBoardList("1, 3,,x,3").join(",") === "1,3");

const s = (start, end) => ({ startDate: `2026-${start}T09:00:00Z`, endDate: `2026-${end}T17:00:00Z` });
check("back-to-back sprints have no gap", !sel.selectionHasGaps([s("09-01", "09-12"), s("09-15", "09-26")]));
check("a skipped sprint is a gap", sel.selectionHasGaps([s("08-01", "08-14"), s("09-15", "09-26")]));
check("overlapping sprints on two boards are not a gap", !sel.selectionHasGaps([s("09-01", "09-20"), s("09-10", "09-26")]));
check("undated sprints are ignored", !sel.selectionHasGaps([{ name: "x" }, s("09-01", "09-12")]));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
