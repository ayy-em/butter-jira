#!/usr/bin/env node
// Unit checks for storage migrations, credential/token lifecycle, and config
// export/import. No dependencies, no network, no browser.
//
// Usage: node scripts/test-credentials.mjs

const MIGRATIONS_URL = new URL("../js/migrations.js", import.meta.url);
const CREDENTIALS_URL = new URL("../js/credentials.js", import.meta.url);
const CONFIG_URL = new URL("../js/config.js", import.meta.url);
const PORTABLE_URL = new URL("../js/portable.js", import.meta.url);

let sync = {};
let local = {};

const pick = (store, keys) =>
  Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  );

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: {
      get: (keys, cb) => cb(pick(sync, keys)),
      set: (obj, cb) => { Object.assign(sync, obj); cb?.(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete sync[k]; cb?.(); },
    },
    local: {
      get: (keys, cb) => {
        const out = keys == null ? { ...local } : pick(local, keys);
        return cb ? cb(out) : Promise.resolve(out);
      },
      set: (obj, cb) => { Object.assign(local, obj); cb?.(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete local[k]; cb?.(); return Promise.resolve(); },
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const migrations = await import(MIGRATIONS_URL);
const creds = await import(CREDENTIALS_URL);
const cfg = await import(CONFIG_URL);
const portable = await import(PORTABLE_URL);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);
const reset = (nextSync = {}, nextLocal = {}) => {
  sync = nextSync; local = nextLocal; migrations.resetMigrationState();
};

section("migration v1 -> v2: credentials off synced storage");
reset({ email: "user@example.com", token: "legacy-token", boards: [{ id: 1, name: "ABC" }] }, {});
let result = await migrations.runMigrations();
check("migration applied", result.applied.includes(2));
check("token moved to local", local.token === "legacy-token");
check("email moved to local", local.email === "user@example.com");
check("token removed from sync", !("token" in sync));
check("email removed from sync", !("email" in sync));
check("non-secret config untouched in sync", Array.isArray(sync.boards) && sync.boards[0].id === 1);
check("creation date backfilled", typeof local.tokenCreatedAt === "string");
check("version marker written to local", local.schemaVersion === migrations.SCHEMA_VERSION);
check("marker not written to sync", !("schemaVersion" in sync));

section("migration idempotence");
reset({}, { ...local });
const before = JSON.stringify(local);
result = await migrations.runMigrations();
check("second run applies nothing", result.applied.length === 0);
check("storage unchanged", JSON.stringify(local) === before);

section("migration on a fresh install");
reset({}, {});
result = await migrations.runMigrations();
check("no credentials invented", !("token" in local) && !("email" in local));
check("version stamped anyway", local.schemaVersion === migrations.SCHEMA_VERSION);

section("migration guards against newer storage");
reset({ email: "x@example.com", token: "t" }, { schemaVersion: 99 });
result = await migrations.runMigrations();
check("no migrations run", result.applied.length === 0);
check("version left alone", local.schemaVersion === 99);
check("sync credentials not touched", sync.token === "t");

section("credential round-trip");
reset({}, {});
check("no credentials -> null", (await creds.getCredentials()) === null);
await creds.saveCredentials({ email: "user@example.com", token: "tok-1" });
let loaded = await creds.getCredentials();
check("saved credentials load back", loaded.email === "user@example.com" && loaded.token === "tok-1");
check("stored device-local only", local.token === "tok-1" && !("token" in sync));
check("expiry defaulted", typeof local.tokenExpiresAt === "string" && local.tokenExpiresAt.length === 10);
check("creation recorded", typeof local.tokenCreatedAt === "string");

section("partial credentials are not usable");
reset({}, { email: "user@example.com", schemaVersion: 2 });
check("email without token -> null", (await creds.getCredentials()) === null);
reset({}, { token: "orphan", schemaVersion: 2 });
check("token without email -> null", (await creds.getCredentials()) === null);

section("token expiry arithmetic");
const at = (s) => new Date(`${s}T12:00:00`);
check("future date -> positive days", creds.daysUntil("2026-08-20", at("2026-08-05")) === 15);
check("today -> 0", creds.daysUntil("2026-08-05", at("2026-08-05")) === 0);
check("past date -> negative", creds.daysUntil("2026-07-29", at("2026-08-05")) === -7);
check("null expiry -> null", creds.daysUntil(null, at("2026-08-05")) === null);
check("garbage expiry -> null", creds.daysUntil("not-a-date", at("2026-08-05")) === null);
check("datetime input tolerated", creds.daysUntil("2026-08-10T00:00:00.000Z", at("2026-08-05")) === 5);
check("default lifetime is a year out",
  creds.defaultExpiry(at("2026-08-05")) === "2027-08-05");
check("month rollover handled", creds.defaultExpiry(at("2026-02-28")) === "2027-02-28");

section("token status + wording");
reset({}, { schemaVersion: 2, email: "u@example.com", token: "t", tokenExpiresAt: "2026-08-20" });
let status = await creds.tokenStatus(at("2026-08-05"));
check("not expired", status.expired === false);
check("not yet warning", status.expiringSoon === false);
check("days counted", status.daysLeft === 15);
status = await creds.tokenStatus(at("2026-08-12"));
check("within 14 days warns", status.expiringSoon === true && status.expired === false);
check("warning wording", creds.describeTokenStatus(status).includes("expires 2026-08-20"));
status = await creds.tokenStatus(at("2026-08-25"));
check("past expiry flagged", status.expired === true);
check("expired wording", creds.describeTokenStatus(status).includes("expired 2026-08-20"));
check("plural handled", creds.describeTokenStatus(status).includes("5 days ago"));
reset({}, { schemaVersion: 2, email: "u@example.com", token: "t" });
check("missing expiry wording", creds.describeTokenStatus(await creds.tokenStatus()) === "Expiry date not set");
reset({}, { schemaVersion: 2 });
check("no token wording", creds.describeTokenStatus(await creds.tokenStatus()) === "No token stored");

section("clearToken keeps email for one-field re-auth");
reset({}, {});
await creds.saveCredentials({ email: "user@example.com", token: "tok-2" });
await creds.clearToken();
check("token gone", !("token" in local));
check("email retained", local.email === "user@example.com");
check("expiry cleared", !("tokenExpiresAt" in local));

section("saveTokenExpiry does not disturb the token");
reset({}, {});
await creds.saveCredentials({ email: "user@example.com", token: "tok-3" });
await creds.saveTokenExpiry("2027-01-01");
check("expiry updated", local.tokenExpiresAt === "2027-01-01");
check("token intact", local.token === "tok-3");

section("export: token excluded by default");
reset({ site: { baseUrl: "https://x.atlassian.net" }, boards: [{ id: 4, name: "ABC", projectKey: "ABC" }] }, { schemaVersion: 2 });
await cfg.loadConfig();
const credentials = { email: "user@example.com", token: "secret-token", tokenExpiresAt: "2027-01-01" };
let payload = portable.buildExport({ now: at("2026-08-05"), credentials });
check("format tagged", payload.format === portable.EXPORT_FORMAT);
check("schema version recorded", payload.schemaVersion === migrations.SCHEMA_VERSION);
check("site exported", payload.config.site.baseUrl === "https://x.atlassian.net");
check("boards exported", payload.config.boards[0].id === 4);
check("email exported", payload.account.email === "user@example.com");
check("token withheld by default", !("token" in payload.account));
check("no secret flag", payload.containsSecret === undefined);
check("no token anywhere in the file", !JSON.stringify(payload).includes("secret-token"));
check("filename dated", portable.exportFilename(at("2026-08-05")) === "butterjira-config-2026-08-05.json");

section("export: token opt-in");
payload = portable.buildExport({ now: at("2026-08-05"), credentials, includeToken: true });
check("token present when asked", payload.account.token === "secret-token");
check("secret flagged", payload.containsSecret === true);
check("expiry carried", payload.account.tokenExpiresAt === "2027-01-01");

section("export is a snapshot, not a live reference");
payload = portable.buildExport({ now: at("2026-08-05") });
payload.config.boards.push({ id: 999 });
payload.config.statusGroups[0].statuses.push("Injected");
check("boards not mutated by reference", cfg.CONFIG.boards.length === 1);
check("status group statuses deep-copied", !cfg.CONFIG.statusGroups[0].statuses.includes("Injected"));

section("import: happy path");
let parsed = portable.parseImport(JSON.stringify(portable.buildExport({ credentials })));
check("round-trips", parsed.ok === true);
check("site imported", parsed.config.site.baseUrl === "https://x.atlassian.net");
check("email imported", parsed.account.email === "user@example.com");
check("no token warning when absent", !parsed.warnings.some((w) => w.includes("API token")));

section("import: rejects junk");
check("not JSON", portable.parseImport("{oh no").ok === false);
check("array rejected", portable.parseImport("[1,2]").ok === false);
check("foreign JSON rejected", portable.parseImport('{"hello":"world"}').ok === false);
check("wrong format tag rejected",
  portable.parseImport('{"format":"something-else","config":{}}').ok === false);
check("empty export rejected",
  portable.parseImport(`{"format":"${portable.EXPORT_FORMAT}","config":{}}`).ok === false);

section("import: sanitises and warns");
parsed = portable.parseImport(JSON.stringify({
  format: portable.EXPORT_FORMAT,
  formatVersion: 99,
  config: {
    site: { baseUrl: "::::" },
    boards: [{ id: 5, name: "OK", projectKey: "OK" }, { name: "no id" }, { id: 0 }],
    statusGroups: [{ name: "Real", statuses: ["To Do", "", 7] }, { name: "  ", statuses: [] }],
    fields: { storyPoints: ["cf_1", 42, ""], bogus: "not-an-array" },
    additionalFields: ["a", "a", "  b  ", 9],
    brand: { orgName: "ExampleCo", productName: 5 },
  },
  account: { email: "user@example.com", token: "imported-token" },
}));
check("parses despite bad parts", parsed.ok === true);
check("newer format warns", parsed.warnings.some((w) => w.includes("newer version")));
check("unreadable site dropped", parsed.config.site === undefined);
check("site warning raised", parsed.warnings.some((w) => w.includes("Site URL")));
check("invalid boards dropped", parsed.config.boards.length === 1 && parsed.config.boards[0].id === 5);
check("board warning raised", parsed.warnings.some((w) => w.includes("board entr")));
check("status statuses cleaned", JSON.stringify(parsed.config.statusGroups) === '[{"name":"Real","statuses":["To Do"]}]');
check("non-string field ids dropped", JSON.stringify(parsed.config.fields.storyPoints) === '["cf_1"]');
check("non-array field role dropped", !("bogus" in parsed.config.fields));
check("additionalFields deduped and trimmed", JSON.stringify(parsed.config.additionalFields) === '["a","b"]');
check("non-string brand value dropped", parsed.config.brand.productName === undefined);
check("brand string kept", parsed.config.brand.orgName === "ExampleCo");
check("token import warns loudly", parsed.warnings.some((w) => w.includes("API token")));

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
