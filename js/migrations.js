// Numbered, one-way storage migrations.
//
// Anything that changes the *shape* of stored data gets a migration here rather
// than a "clear your settings and set up again" note. Migrations run once per
// device, are idempotent, and run before any config or credential read (both
// loadConfig() and loadCredentials() await runMigrations()).
//
// The version marker lives in chrome.storage.local because migrations act on
// per-device storage and must not be replayed on, or skipped because of, a
// sibling device's state.

export const SCHEMA_VERSION = 2;

const VERSION_KEY = "schemaVersion";

const MIGRATIONS = {
  // v1 -> v2: move credentials off chrome.storage.sync. `sync` replicates in
  // plaintext through the user's Google account; the token belongs on the
  // device. Non-secret config stays on `sync`.
  2: async () => {
    const legacy = await syncGet(["email", "token"]);
    if (legacy.email || legacy.token) {
      const patch = {};
      if (legacy.email) patch.email = legacy.email;
      if (legacy.token) {
        patch.token = legacy.token;
        // Unknown real creation date — assume now so the expiry warning has
        // something to work from. The user can correct it in Settings.
        patch.tokenCreatedAt = new Date().toISOString();
      }
      await localSet(patch);
      await syncRemove(["email", "token"]);
    }
  },
};

function syncGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

function syncRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.remove(keys, () => resolve());
  });
}

function localGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function localSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

// Memoised: concurrent callers share one run, and repeat calls are free.
let inFlight = null;

export function runMigrations() {
  if (!inFlight) inFlight = migrate();
  return inFlight;
}

// Test hook — lets a suite reset the memo between scenarios.
export function resetMigrationState() {
  inFlight = null;
}

async function migrate() {
  const stored = await localGet([VERSION_KEY]);
  let from = Number(stored[VERSION_KEY]);

  if (!Number.isFinite(from) || from < 1) {
    // No marker: either a fresh install or a pre-versioning one. Both are
    // treated as v1 — every migration is written to be safe on empty storage.
    from = 1;
  }

  if (from > SCHEMA_VERSION) {
    // Storage written by a newer build (e.g. after a downgrade). Leave it
    // alone rather than mangling data this version does not understand.
    console.warn(
      `Storage schema v${from} is newer than this build (v${SCHEMA_VERSION}); skipping migrations.`
    );
    return { from, to: from, applied: [] };
  }

  const applied = [];
  for (let version = from + 1; version <= SCHEMA_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (!step) continue;
    await step();
    applied.push(version);
  }

  await localSet({ [VERSION_KEY]: SCHEMA_VERSION });
  return { from, to: SCHEMA_VERSION, applied };
}
