// Local preview harness for Launch → My todos (M14).
//
// Small on purpose: this screen has no network at all. Everything it draws
// comes out of one device-local key, so the harness is that key plus the
// stubbed storage to hold it. Open with:
//
//   open preview-todos.html              (or serve the folder over http)
//
// Fixture states:
//   ?theme=light     the theme most bugs hide in
//   ?list=empty      nothing stored — the empty state, and what a new user sees
//   ?list=done       every item finished, so the "clear finished" action shows
//   ?list=long       thirty items, for row density and the overdue tone at scale

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";

const local = {};
const sync = {};
const pick = (store, keys) =>
  keys == null
    ? { ...store }
    : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
      );
const area = (store) => ({
  get: (keys) => Promise.resolve(pick(store, keys)),
  set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
  remove: (keys) => { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
});
globalThis.chrome = {
  runtime: { getURL: (p) => `../${p}` },
  storage: { local: area(local), sync: area(sync) },
};

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const dayOf = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// Invented names, as everywhere else in preview/: an item sourced from a 1:1
// carries a colleague's name, which is exactly what must never be a real one in
// a public file.
const NAMES = ["Avery Quinn", "Bo Ferreira", "Cy Nakamura", "Devi Okonjo"];

const mode = params.get("list") || "";

function item(n) {
  const fromOneOne = n % 3 !== 0;
  return {
    id: `t-${n}`,
    text: fromOneOne
      ? `Follow up on the thing we agreed (${n})`
      : `Something I wrote down myself (${n})`,
    source: fromOneOne ? "1on1" : "manual",
    sourceLabel: fromOneOne ? NAMES[n % NAMES.length] : "",
    // A spread of deadlines: overdue, today, soon, and none — the four states
    // the due column has to look right in.
    due: n % 4 === 0 ? "" : dayOf((n % 7) - 3),
    link: n % 5 === 0 ? "https://example.atlassian.net/browse/ACME-1" + n : "",
    done: mode === "done" ? true : n % 6 === 0,
    createdAt: daysAgo(n),
    doneAt: mode === "done" || n % 6 === 0 ? daysAgo(n % 5) : "",
    originId: fromOneOne ? `o-${n}` : "",
  };
}

const count = mode === "long" ? 30 : 8;
if (mode !== "empty") {
  local.myTodos = Array.from({ length: count }, (_, i) => item(i + 1));
}

const view = await import("../js/views/todos.js");
await view.mount(document.getElementById("view-container"));
