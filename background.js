import { runMigrations } from "./js/migrations.js";

// Bring storage up to date as soon as a new build lands, so the first page load
// already sees the current shape. loadConfig()/loadCredentials() call this too —
// it is memoised and idempotent, so double-running costs nothing.
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const result = await runMigrations();
    if (result.applied.length) {
      console.log(
        `ButterJira: storage migrated v${result.from} -> v${result.to} (${details.reason})`
      );
    }
  } catch (err) {
    console.error("ButterJira: storage migration failed", err);
  }
});

chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url: appUrl });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: appUrl });
  }
});
