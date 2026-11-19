#!/usr/bin/env node
// Standup recap files (js/recaps.js): the path, the Markdown and its
// metaheader, and the write/rewrite/remove rules against an in-memory folder
// shaped like the File System Access API. Invented names throughout.

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

const store = {};
globalThis.chrome = {
  runtime: { id: "test", getURL: (p) => p },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
    sync: { get: async () => ({}), set: async () => {} },
  },
};

const rc = await import(new URL("../js/recaps.js", import.meta.url));

// ── A fake folder ───────────────────────────────────────────────────────────
function notFound() {
  const err = new Error("not found");
  err.name = "NotFoundError";
  return err;
}
function fakeDir(name = "root") {
  const dirs = new Map();
  const files = new Map();
  return {
    name,
    dirs,
    files,
    async getDirectoryHandle(n, { create = false } = {}) {
      if (!dirs.has(n)) {
        if (!create) throw notFound();
        dirs.set(n, fakeDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, { create = false } = {}) {
      if (!files.has(n)) {
        if (!create) throw notFound();
        files.set(n, "");
      }
      return {
        getFile: async () => ({ text: async () => files.get(n) }),
        createWritable: async () => {
          let buf = "";
          return { write: async (t) => { buf += t; }, close: async () => { files.set(n, buf); } };
        },
      };
    },
    async removeEntry(n) {
      if (!files.delete(n)) throw notFound();
    },
  };
}
const at = (root, path) => {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = dir.dirs.get(p);
  return dir?.files.get(parts[parts.length - 1]);
};

// A finished standup: 09:30 local on Thursday 2026-11-19, three people, the
// third never reached.
const start = new Date(2026, 10, 19, 9, 30, 0).getTime();
const session = {
  seed: 7,
  order: ["acc-a", "acc-b", "acc-c"],
  durations: { "acc-a": 120, "acc-b": 90, "acc-c": 60 },
  startedAt: start,
  finishedAt: start + 6 * 60 * 1000 + 5000,
  actualMs: { "acc-a": 130000, "acc-b": 75000 },
  notesByPerson: {},
};
const names = { "acc-a": "Ada Example", "acc-b": 'Bo "Bee" Sample', "acc-c": "Cy Placeholder" };
const labelFor = (id) => names[id];
const digest = "📌 Daily Standup Action Points - 2026-11-19\n\n@ada\n- look at the deploy\n\nCheers 😎";

section("path");
{
  const p = rc.recapPath(new Date(start));
  check("folders are standup-recaps/<year>/<month>", p.dirs.join("/") === "standup-recaps/2026/11");
  check("file is standup_YYYY-MM-DD.md", p.file === "standup_2026-11-19.md");
  check("a second standup that day gets _2", rc.recapPath(new Date(start), 2).file === "standup_2026-11-19_2.md");
  check("single-digit months and days are padded",
    rc.recapPath(new Date(2027, 0, 5, 9)).dirs.join("/") === "standup-recaps/2027/01" &&
    rc.recapPath(new Date(2027, 0, 5, 9)).file === "standup_2027-01-05.md");
  check("the day is the local one, not UTC's",
    rc.recapPath(new Date(2026, 10, 19, 0, 30)).file === "standup_2026-11-19.md");
}

section("markdown");
const md = rc.recapMarkdown(session, { labelFor, digest });
{
  check("opens with a YAML metaheader", md.startsWith("---\n") && md.indexOf("\n---\n") > 0);
  check("date and weekday", md.includes("date: 2026-11-19\n") && md.includes("weekday: Thursday\n"));
  check("start time", md.includes('started: "09:30"'));
  check("total duration, wall clock", md.includes('duration: "6:05"'));
  check("total speaking time", md.includes('speaking_time: "3:25"'));
  check("each participant with their talk time",
    md.includes('  - name: "Ada Example"\n    talk_time: "2:10"\n    planned: "2:00"'));
  check("a name with quotes stays valid YAML", md.includes('name: "Bo \\"Bee\\" Sample"'));
  check("somebody never reached has null, not 0:00",
    md.includes('  - name: "Cy Placeholder"\n    talk_time: null'));
  check("ended early is recorded", md.includes("ended_early: true"));
  check("the recap text follows the header", md.endsWith(`---\n\n${digest}\n`));
  check("the id reads back", rc.recapIdOf(md) === "" + `${start}-7`);
  check("no notes still makes a file", rc.recapMarkdown(session, { labelFor }).includes("_No parking-lot notes._"));
  check("past the hour the clock shows hours", rc.clock(3723000) === "1:02:03");
}

section("writing");
{
  const root = fakeDir("Recaps");
  const path = await rc.writeRecap(root, session, { labelFor, digest });
  check("written under the dated folders", path === "standup-recaps/2026/11/standup_2026-11-19.md");
  check("with the markdown", at(root, path) === md);

  const edited = await rc.writeRecap(root, session, { labelFor, digest: `${digest}\nedited` });
  check("the same standup rewritten replaces its own file", edited === path && at(root, path).includes("edited"));

  const second = { ...session, seed: 8, startedAt: start + 3600000, finishedAt: start + 3900000 };
  const path2 = await rc.writeRecap(root, second, { labelFor, digest: "later" });
  check("a second standup that day does not overwrite the first",
    path2 === "standup-recaps/2026/11/standup_2026-11-19_2.md" && at(root, path).includes("edited"));

  check("remove takes out only this standup's file",
    (await rc.removeRecap(root, session)) === true && at(root, path) === undefined && at(root, path2) !== undefined);
  check("removing again finds nothing", (await rc.removeRecap(root, session)) === false);
  check("removing from a folder with no recaps is a no-op", (await rc.removeRecap(fakeDir(), session)) === false);
  check("the freed slot is reused by the next new standup",
    (await rc.writeRecap(root, { ...session, seed: 9 }, { labelFor, digest })) === path);
}

section("environment");
check("no File System Access API (Node, Firefox): unsupported", rc.recapFolderSupported() === false);
check("and no folder", (await rc.getRecapFolder()) === null);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
