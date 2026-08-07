// The one place that knows which browser this is running in.
//
// Chrome and Edge expose `chrome.*`; Firefox exposes `browser.*` and also
// aliases `chrome.*` for compatibility. The two differ in more than the name:
// `browser.*` is promise-based throughout, while `chrome.*` historically took
// callbacks and only grew promises later, per-API. Writing to either one
// directly means every call site has to know which browser it is on.
//
// So everything goes through here, always promise-shaped. `browser` wins when
// present because on Firefox it is the native, fully-promisified surface;
// `chrome` is the fallback for Chrome and Edge, where MV3 returns promises for
// the APIs this app uses.
//
// This module also absorbs the localGet/localSet/localRemove trio that used to
// be copy-pasted into seven modules — same three functions, seven times, each
// wrapping the callback form by hand.

// Resolved per call rather than captured at import: the test suites install
// their stub on globalThis before importing the module under test, and a
// captured reference would freeze whichever object happened to exist first.
function api() {
  const ns = globalThis.browser ?? globalThis.chrome;
  if (!ns) throw new Error("No extension API available (browser/chrome namespace missing)");
  return ns;
}

// True on Firefox, which is the only engine shipping a native `browser`.
// Nothing branches on this today; it exists so that when something does, the
// check has one home rather than being re-derived at the call site.
export function isGecko() {
  return typeof globalThis.browser !== "undefined" && globalThis.browser !== globalThis.chrome;
}

// Every API used here returns a promise on every supported target: MV3 Chrome
// and Edge promisified storage/tabs/permissions/windows, and Firefox's
// `browser.*` has been promise-based from the start. There is deliberately no
// callback fallback — it would be machinery for a browser this does not
// support, and a retry-with-callback after a failed promise call would issue
// side-effecting writes twice.

// ── Storage ──────────────────────────────────────────────────────────────────
// `local` is the device: credentials, roster, view preferences, the response
// cache. `sync` is the account: non-secret configuration only. That split is
// load-bearing — see js/credentials.js.

function area(name) {
  return api().storage[name];
}

async function get(name, keys) {
  return (await area(name).get(keys)) || {};
}

async function set(name, items) {
  await area(name).set(items);
}

async function remove(name, keys) {
  await area(name).remove(keys);
}

export const localGet = (keys) => get("local", keys);
export const localSet = (items) => set("local", items);
export const localRemove = (keys) => remove("local", keys);

export const syncGet = (keys) => get("sync", keys);
export const syncSet = (items) => set("sync", items);
export const syncRemove = (keys) => remove("sync", keys);

// ── Runtime ──────────────────────────────────────────────────────────────────

export function runtimeUrl(path) {
  return api().runtime.getURL(path);
}

export function onMessage(handler) {
  api().runtime.onMessage?.addListener(handler);
}

export function onInstalled(handler) {
  api().runtime.onInstalled.addListener(handler);
}

// ── Action, tabs, windows ────────────────────────────────────────────────────

export function onActionClicked(handler) {
  api().action.onClicked.addListener(handler);
}

// Querying by URL normally needs the "tabs" permission, but an extension can
// always see its own pages, which is all this is ever used for.
export async function queryTabs(query) {
  return (await api().tabs.query(query)) || [];
}

export async function updateTab(tabId, props) {
  return api().tabs.update(tabId, props);
}

export async function createTab(props) {
  return api().tabs.create(props);
}

export function sendTabMessage(tabId, message) {
  // Deliberately not awaited anywhere: a tab with no listener rejects, and a
  // notification nobody is listening for is not an error.
  try {
    return Promise.resolve(api().tabs.sendMessage(tabId, message)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// Raising the window a tab lives in is a nicety; the tab is already activated
// by the time this runs, so a browser that refuses is not a failure.
export async function focusWindow(windowId) {
  try {
    const { windows } = api();
    if (!windows?.update) return;
    await windows.update(windowId, { focused: true });
  } catch {
    /* ignore */
  }
}

// ── Permissions ──────────────────────────────────────────────────────────────

export async function hasOrigin(origin) {
  try {
    return Boolean(await api().permissions.contains({ origins: [origin] }));
  } catch {
    return false;
  }
}

// Must be called from inside a user gesture — both engines require it, and
// both silently refuse otherwise.
export async function requestOrigin(origin) {
  if (!origin) return false;
  if (await hasOrigin(origin)) return true;
  try {
    return Boolean(await api().permissions.request({ origins: [origin] }));
  } catch {
    return false;
  }
}
