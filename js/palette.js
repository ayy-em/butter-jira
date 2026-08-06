// Command palette: query parsing, fuzzy matching and ranking.
//
// Kept free of DOM so the scoring rules — the part that decides whether typing
// "abc12" finds ABC-123 before ABC-1234 — are unit-testable.
//
// Two matching passes, in order of how much the user probably meant it:
//   1. contiguous substring — "auth" in "Refactor auth guard"
//   2. subsequence         — "rag" in "Refactor auth guard"
// A substring hit always outranks a subsequence hit, because a scattered match
// across a long summary is usually a coincidence.

const BOUNDARY = /[\s\-_/.:]/;

// Prefix that switches the palette from fuzzy search to raw JQL.
export const JQL_PREFIX = ">";

export function parseQuery(raw) {
  const text = String(raw ?? "");
  if (text.trimStart().startsWith(JQL_PREFIX)) {
    return { mode: "jql", value: text.trimStart().slice(JQL_PREFIX.length).trim() };
  }
  return { mode: "search", value: text.trim() };
}

// Returns { score, positions } or null when the query doesn't match at all.
// `positions` are indexes into `text`, for highlighting.
export function fuzzyScore(query, text) {
  const t = String(text ?? "");
  const q = String(query ?? "").toLowerCase();
  if (!q) return { score: 0, positions: [] };
  if (!t) return null;

  const lower = t.toLowerCase();

  const direct = lower.indexOf(q);
  if (direct !== -1) {
    const positions = [];
    for (let i = 0; i < q.length; i++) positions.push(direct + i);
    // Earlier is better, longer matches are better, and starting on a word
    // boundary is a strong signal the user was typing that word.
    let score = 1000 - Math.min(direct, 100) * 2 + q.length * 4;
    if (direct === 0) score += 60;
    else if (BOUNDARY.test(t[direct - 1])) score += 30;
    return { score, positions };
  }

  const positions = [];
  let cursor = 0;
  let score = 0;
  let run = 0;

  for (const ch of q) {
    let found = -1;
    while (cursor < lower.length) {
      if (lower[cursor] === ch) {
        found = cursor;
        break;
      }
      cursor++;
    }
    if (found === -1) return null;

    const prev = positions.length ? positions[positions.length - 1] : -2;
    if (found === prev + 1) {
      run++;
      score += 8 + run * 4; // consecutive characters compound
    } else {
      run = 0;
      score += 2;
    }
    if (found === 0 || BOUNDARY.test(t[found - 1])) score += 12;
    positions.push(found);
    cursor++;
  }

  // Between two equally-hit strings, the shorter one is more likely the target.
  score += Math.max(0, 40 - t.length);
  return { score, positions };
}

// Best score across an item's label and its extra searchable text. Matches on
// the label are worth more than matches on a sublabel or keyword.
export function scoreItem(query, item) {
  if (!query) return { score: item.boost || 0, positions: [] };

  const onLabel = fuzzyScore(query, item.label);
  let best = onLabel ? { score: onLabel.score, positions: onLabel.positions } : null;

  for (const extra of [item.sublabel, ...(item.keywords || [])]) {
    if (!extra) continue;
    const hit = fuzzyScore(query, extra);
    // Halved: finding the query in a summary is weaker evidence than in a key.
    if (hit && (!best || hit.score / 2 > best.score)) {
      best = { score: hit.score / 2, positions: [] };
    }
  }

  if (!best) return null;
  return { score: best.score + (item.boost || 0), positions: best.positions };
}

// Ranked matches, highest first. Ties keep input order, so callers can put
// recents and cheap local items ahead of everything else.
export function rankItems(query, items, { limit = 40 } = {}) {
  const scored = [];
  items.forEach((item, index) => {
    const hit = scoreItem(query, item);
    if (!hit) return;
    scored.push({ ...item, score: hit.score, positions: hit.positions, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit);
}

// Groups ranked results under their kind for display, preserving rank order
// both within a group and across groups (a group appears where its best hit
// lands, so a strong issue match pulls Issues above Views).
export function groupByKind(ranked) {
  const groups = [];
  const byKind = new Map();
  for (const item of ranked) {
    if (!byKind.has(item.kind)) {
      const group = { kind: item.kind, items: [] };
      byKind.set(item.kind, group);
      groups.push(group);
    }
    byKind.get(item.kind).items.push(item);
  }
  return groups;
}

// ── Recents ─────────────────────────────────────────────────────────────────
// Device-local: which issues you keep coming back to is per-machine context,
// not something to replicate through a synced account.

export const RECENTS_KEY = "paletteRecents";
export const RECENTS_MAX = 12;

// Most recent first, deduplicated. Returns a new array — never mutates.
export function addRecent(recents, entry) {
  if (!entry?.kind || !entry?.id) return recents;
  const rest = (recents || []).filter((r) => !(r.kind === entry.kind && r.id === entry.id));
  return [{ kind: entry.kind, id: entry.id }, ...rest].slice(0, RECENTS_MAX);
}

export function normalizeRecents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.kind === "string" && typeof r.id === "string")
    .slice(0, RECENTS_MAX)
    .map((r) => ({ kind: r.kind, id: r.id }));
}

// Recents ordering, applied by boosting rather than reordering, so a strong
// match on something you've never opened still wins.
export function recentBoost(recents, item) {
  const at = (recents || []).findIndex((r) => r.kind === item.kind && r.id === item.id);
  if (at === -1) return 0;
  return (RECENTS_MAX - at) * 3;
}
