// The Firefox build, driven in a real Firefox. Not one of the `test-*.mjs`
// suites: it needs Firefox installed and one dev dependency, so CI does not run
// it. Run it before a release that touches the manifest, background.js,
// js/browser.js, js/jira-links.js or the backup path.
//
//   npm i --no-save puppeteer-core@24     # once; node_modules/ is gitignored
//   node scripts/build.mjs firefox
//   node scripts/firefox-smoke.mjs [--firefox <binary>] [--shots <dir>]
//
// What it proves, in a throwaway profile, offline (every Jira and GitHub request
// is stubbed; the site is a made-up acme-example.atlassian.net):
//
//   * the package installs, with its host permissions and declarativeNetRequest
//   * storage.sync round-trips (the gecko id is right)
//   * Settings → Restore a backup sets up a fresh install — the path a Chrome
//     install's settings take into Firefox
//   * the background event page installs the Jira-links rules, and wakes from
//     suspension to change them when the switch flips
//   * a /browse/ link redirects into issue.html; ?butterjira=skip does not
//   * every page renders
//
// Three Firefox automation quirks shape it. WebDriver BiDi refuses
// moz-extension:// pages without MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1; the page's
// load event is not reported for them, so navigation waits on a timer; and
// file inputs cannot be set there, so the backup goes in through a DataTransfer,
// which is what a file picker hands the page anyway. Page URLs are read from
// inside the page because the driver's own record goes stale.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "firefox");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const FIREFOX = arg("--firefox", "/Applications/Firefox.app/Contents/MacOS/firefox");
const SHOTS = arg("--shots", null);

let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.error("puppeteer-core is missing: npm i --no-save puppeteer-core@24");
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
  console.error("No Firefox build: node scripts/build.mjs firefox");
  process.exit(2);
}

const ID = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
const UUID = "6f1d2c3a-0b6e-4c43-9a1e-5a2b7c9d0e11";
const BASE = `moz-extension://${UUID}`;
const SITE = "https://acme-example.atlassian.net";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Invented throughout.
const BACKUP = {
  format: "butterjira-backup",
  version: 1,
  createdAt: "2026-11-12T10:00:00.000Z",
  schemaVersion: null,
  config: {
    site: { baseUrl: SITE, wikiPath: "/wiki" },
    boards: [
      { id: 1, name: "ABC", projectKey: "ABC", color: "#4F8EF7" },
      { id: 2, name: "DEF", projectKey: "DEF", color: "#F7914F" },
    ],
    statusGroups: [
      { name: "To Do", statuses: ["To Do"] },
      { name: "In Progress", statuses: ["In Progress"] },
      { name: "Done", statuses: ["Done"] },
    ],
  },
  stores: {
    snapshots: {},
    freezes: {},
    sprintHistory: { rows: {} },
    todos: [{ id: "t1", text: "Check the Firefox build", done: false, createdAt: "2026-11-12T09:00:00.000Z" }],
    standupHistory: [],
  },
  preferences: { openJiraLinksInApp: true },
};

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: FIREFOX,
  headless: true,
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({ [ID]: UUID }),
    // Suspend an idle event page after 2 s instead of 30 s, so waking is tested.
    "extensions.background.idle.timeout": 2000,
  },
});
process.on("unhandledRejection", () => {}); // interception replies racing a closed page

async function stubNetwork(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const u = req.url();
    if (u.startsWith(`${SITE}/`) || u.startsWith("https://api.github.com/")) {
      req.respond({ status: 401, contentType: "application/json", body: '{"errorMessages":["stubbed"]}' }).catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });
}

async function open(rel) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1512, height: 945 });
  await stubNetwork(page);
  await page.goto(`${BASE}/${rel}`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  await wait(1500);
  return page;
}

const hrefOf = (page) => page.evaluate(() => location.href).catch(() => page.url());
const rulesOf = (page) => page.evaluate(async () => (await browser.declarativeNetRequest.getDynamicRules()).map((r) => r.id));
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

try {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  check("installs as a temporary add-on", (await browser.installExtension(DIST)) === ID, ID);

  const app = await open("app.html");
  check("app.html opens", (await hrefOf(app)).startsWith(BASE));
  check("a fresh install shows setup", await app.evaluate(() => Boolean(document.querySelector(".setup-overlay"))));
  await shot(app, "ff-fresh");

  const env = await app.evaluate(async () => ({
    atlassian: await browser.permissions.contains({ origins: ["https://*.atlassian.net/*"] }),
    github: await browser.permissions.contains({ origins: ["https://api.github.com/*"] }),
    dnr: Boolean(browser.declarativeNetRequest?.updateDynamicRules),
  }));
  check("host permission for *.atlassian.net granted at install", env.atlassian);
  check("host permission for api.github.com granted at install", env.github);
  check("declarativeNetRequest is available", env.dnr);

  const probe = await app.evaluate(async () => {
    await browser.storage.sync.set({ __probe: 42 });
    const v = (await browser.storage.sync.get("__probe")).__probe;
    await browser.storage.sync.remove("__probe");
    return v;
  });
  check("storage.sync writes and reads back", probe === 42);

  // Restore, the way Settings does it from a picked file.
  const settings = await open("settings.html");
  await settings.evaluate((body) => {
    window.confirm = () => true;
    const dt = new DataTransfer();
    dt.items.add(new File([body], "butterjira-backup.json", { type: "application/json" }));
    const input = document.getElementById("restoreFile");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, JSON.stringify(BACKUP));
  await wait(2000);
  const note = await settings.evaluate(() => document.getElementById("backupNote")?.textContent || "");
  check("Settings → Restore a backup sets up a fresh install", /the config/.test(note), note);
  const stored = await settings.evaluate(async () => ({
    sync: await browser.storage.sync.get(["site", "boards"]),
    local: await browser.storage.local.get(["myTodos", "openJiraLinksInApp"]),
  }));
  check("config lands in storage.sync", stored.sync.site?.baseUrl === SITE && stored.sync.boards?.length === 2);
  check("todos and preferences land in storage.local", stored.local.myTodos?.length === 1 && stored.local.openJiraLinksInApp === true);

  await wait(1500);
  check("the background installs the five Jira-links rules", (await rulesOf(settings)).length === 5);

  await wait(6000); // the event page is suspended by now
  await settings.evaluate(() => browser.storage.local.set({ openJiraLinksInApp: false }));
  await wait(2500);
  check("a suspended background wakes on the switch and removes the rules", (await rulesOf(settings)).length === 0);
  await wait(6000);
  await settings.evaluate(() => browser.storage.local.set({ openJiraLinksInApp: true }));
  await wait(2500);
  check("…and puts them back when it is switched on again", (await rulesOf(settings)).length === 5);

  const link = await browser.newPage();
  await stubNetwork(link);
  await link.goto(`${SITE}/browse/ABC-123`, { waitUntil: "load", timeout: 15000 }).catch(() => {});
  await wait(1500);
  const landed = await hrefOf(link);
  check("a /browse/ link opens the issue page", landed === `${BASE}/issue.html?key=ABC-123`, landed);
  await link.goto(`${SITE}/browse/ABC-123?butterjira=skip`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  const skipped = await hrefOf(link);
  check("?butterjira=skip goes to Jira", skipped.startsWith(SITE), skipped);

  const configured = await open("app.html#dashboard");
  const prefilled = await configured.evaluate(() => document.getElementById("setup-site")?.value || "");
  check("after a restore, setup asks only for the credentials", prefilled === SITE, prefilled);
  await shot(configured, "ff-restored");

  for (const rel of ["recap.html", "quarter.html", "issue.html?key=ABC-1"]) {
    const page = await open(rel);
    check(`${rel} renders`, (await page.evaluate(() => document.body.innerText.length)) > 0);
    await page.close();
  }
} catch (err) {
  check("ran to the end", false, String(err?.message || err).split("\n")[0]);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
