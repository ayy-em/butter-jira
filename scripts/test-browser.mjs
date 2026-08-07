#!/usr/bin/env node
// Unit checks for the cross-browser shim (M12).
//
// The point of this suite is the Firefox case, and it is the one thing no other
// suite covers: every other test installs a `chrome` global, because that is
// what Chrome and Edge provide. Here the modules are exercised against a
// `browser` global with no `chrome` at all — which is what a Gecko build sees
// once `chrome` is not being leaned on — and against both together.
//
// Usage: node scripts/test-browser.mjs

const BROWSER_URL = new URL("../js/browser.js", import.meta.url);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

// A namespace shaped like a real one: promises everywhere, no callbacks.
function makeNamespace(label) {
  const stores = { local: {}, sync: {} };
  const calls = [];
  const pick = (store, keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
  };
  const area = (name) => ({
    get: async (keys) => { calls.push(`${label}:${name}.get`); return pick(stores[name], keys); },
    set: async (obj) => { calls.push(`${label}:${name}.set`); Object.assign(stores[name], obj); },
    remove: async (keys) => {
      calls.push(`${label}:${name}.remove`);
      for (const k of [].concat(keys)) delete stores[name][k];
    },
  });
  return {
    label,
    stores,
    calls,
    runtime: {
      getURL: (p) => `${label}-extension://id/${p}`,
      onMessage: { addListener: (fn) => calls.push("onMessage") && fn },
      onInstalled: { addListener: () => calls.push("onInstalled") },
    },
    action: { onClicked: { addListener: () => calls.push("onActionClicked") } },
    storage: { local: area("local"), sync: area("sync") },
    tabs: {
      query: async () => [{ id: 7, windowId: 3 }],
      update: async (id, props) => { calls.push(`update:${id}`); return props; },
      create: async () => { calls.push("create"); },
      sendMessage: async () => { calls.push("sendMessage"); },
    },
    windows: { update: async () => { calls.push("windowUpdate"); } },
    permissions: {
      contains: async ({ origins }) => origins.includes("https://granted.example/*"),
      request: async ({ origins }) => origins.includes("https://grantable.example/*"),
    },
  };
}

const gecko = makeNamespace("moz");
const blink = makeNamespace("chrome");

// Firefox first: no `chrome` global at all, so anything still reaching for it
// would throw here rather than in front of a user.
globalThis.browser = gecko;
delete globalThis.chrome;

const ext = await import(BROWSER_URL);

section("Firefox: browser global only");
check("isGecko true", ext.isGecko() === true);
check("runtimeUrl uses the gecko namespace", ext.runtimeUrl("app.html") === "moz-extension://id/app.html");
await ext.localSet({ token: "t" });
check("local write landed", gecko.stores.local.token === "t");
check("local read returns the value", (await ext.localGet(["token"])).token === "t");
check("local read of a missing key yields {}", Object.keys(await ext.localGet(["nope"])).length === 0);
await ext.localRemove(["token"]);
check("local remove landed", !("token" in gecko.stores.local));
await ext.syncSet({ boards: [1] });
check("sync is a separate area", gecko.stores.sync.boards.length === 1 && !("boards" in gecko.stores.local));
check("null keys reads everything", Object.keys(await ext.syncGet(null)).includes("boards"));
check("tabs query resolves", (await ext.queryTabs({ url: "x" }))[0].id === 7);
check("permissions: already granted short-circuits", (await ext.hasOrigin("https://granted.example/*")) === true);
check("permissions: request path", (await ext.requestOrigin("https://grantable.example/*")) === true);
check("permissions: refusal is false, not a throw",
  (await ext.requestOrigin("https://denied.example/*")) === false);
check("requestOrigin skips the prompt when already held",
  (await ext.requestOrigin("https://granted.example/*")) === true);
check("empty origin refused without asking", (await ext.requestOrigin("")) === false);

section("modules downstream of the shim work on Firefox");
// The real proof: a module that never mentions `browser` or `chrome` itself.
const creds = await import(new URL("../js/credentials.js", import.meta.url));
await creds.saveCredentials({ email: "you@example.com", token: "jira-token" });
check("credentials stored through the gecko namespace", gecko.stores.local.token === "jira-token");
check("credentials read back", (await creds.getCredentials()).email === "you@example.com");
check("migrations stamped the schema version", gecko.stores.local.schemaVersion !== undefined);
check("nothing leaked into sync", !("token" in gecko.stores.sync));

section("a Chrome export imports into Firefox");
// The migration path people actually take. Nothing in the payload should be
// browser-specific, so a file written under one namespace must apply cleanly
// under the other — including both credentials.
const portable = await import(new URL("../js/portable.js", import.meta.url));
const cfg = await import(new URL("../js/config.js", import.meta.url));

// Write a full setup into the *chrome* namespace and export it from there.
globalThis.chrome = blink;
delete globalThis.browser;
await cfg.loadConfig();
await cfg.saveConfig({
  site: { baseUrl: "https://acme.atlassian.net" },
  boards: [{ id: 9, name: "ABC", projectKey: "ABC", color: "#4F8EF7" }],
  github: { enabled: true, host: "github.com", org: "acme", repos: ["acme/api"] },
});
await creds.saveCredentials({ email: "you@example.com", token: "jira-token" });
await creds.saveGithubToken("gh-token");
const exported = portable.buildExport({
  credentials: await creds.loadCredentials(),
  includeToken: true,
  includeGithubToken: true,
  githubToken: await creds.getGithubToken(),
  includeRoster: true,
  members: [{ accountId: "a1", jiraName: "Sam Okafor", githubLogin: "sokafor" }],
});
const file = JSON.stringify(exported);
check("the file names no browser", !/\bchrome\b|\bmoz-extension\b|chrome-extension/i.test(file));

// Now switch to a clean Firefox namespace and import it.
const fresh = makeNamespace("moz2");
globalThis.browser = fresh;
delete globalThis.chrome;
const imported = portable.parseImport(file);
check("parses under Firefox", imported.ok === true);
await cfg.saveConfig(imported.config);
await creds.saveCredentials({
  email: imported.account.email,
  token: imported.account.token,
  tokenExpiresAt: imported.account.tokenExpiresAt,
});
await creds.saveGithubToken(imported.githubAccount.token);

check("site landed in the gecko sync store", fresh.stores.sync.site.baseUrl === "https://acme.atlassian.net");
check("boards landed", fresh.stores.sync.boards[0].projectKey === "ABC");
check("github config landed", fresh.stores.sync.github.repos[0] === "acme/api");
check("jira token landed device-local", fresh.stores.local.token === "jira-token");
check("github token landed device-local", fresh.stores.local.githubToken === "gh-token");
check("no credential leaked into sync",
  !("token" in fresh.stores.sync) && !("githubToken" in fresh.stores.sync));
check("roster came across", imported.members[0].githubLogin === "sokafor");
check("the roster is not put in sync either", !("teams" in fresh.stores.sync));

section("Chrome / Edge: chrome global only");
delete globalThis.browser;
globalThis.chrome = blink;
check("isGecko false", ext.isGecko() === false);
check("runtimeUrl uses the blink namespace", ext.runtimeUrl("app.html") === "chrome-extension://id/app.html");
await ext.localSet({ theme: "dark" });
check("writes land on the chrome namespace", blink.stores.local.theme === "dark");
check("gecko store untouched", !("theme" in gecko.stores.local));

section("both present: browser wins");
globalThis.browser = gecko;
globalThis.chrome = blink;
check("isGecko true when the two differ", ext.isGecko() === true);
await ext.localSet({ pickedBy: "browser" });
check("write went to browser, not chrome",
  gecko.stores.local.pickedBy === "browser" && !("pickedBy" in blink.stores.local));

section("aliased namespaces are not mistaken for Gecko");
// Some environments point `browser` at the very same object as `chrome`.
globalThis.browser = blink;
check("identical objects are not Gecko", ext.isGecko() === false);

section("no namespace at all");
delete globalThis.browser;
delete globalThis.chrome;
let threw = "";
try { ext.runtimeUrl("x"); } catch (err) { threw = err.message; }
check("fails loudly rather than silently", /No extension API available/.test(threw));
threw = "";
try { await ext.localGet(["x"]); } catch (err) { threw = err.message; }
check("storage says so too", /No extension API available/.test(threw));

section("failure tolerance");
globalThis.chrome = {
  ...blink,
  windows: undefined,
  permissions: { contains: async () => { throw new Error("nope"); }, request: async () => { throw new Error("nope"); } },
  tabs: { ...blink.tabs, sendMessage: () => { throw new Error("no receiver"); } },
};
delete globalThis.browser;
let ok = true;
try { await ext.focusWindow(1); } catch { ok = false; }
check("a browser without windows.update does not throw", ok);
check("a permissions API that throws reads as 'not granted'",
  (await ext.hasOrigin("https://x.example/*")) === false);
ok = true;
try { await ext.sendTabMessage(1, { type: "x" }); } catch { ok = false; }
check("a message to a tab with no listener is not an error", ok);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
