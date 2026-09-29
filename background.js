import {
  createTab,
  focusWindow,
  onActionClicked,
  onInstalled,
  onStartup,
  onStorageChanged,
  queryTabs,
  runtimeUrl,
  updateTab,
} from "./js/browser.js";
import { runMigrations } from "./js/migrations.js";
import { OPEN_IN_APP_KEY, syncJiraLinkRules } from "./js/jira-links.js";

// Bring storage up to date as soon as a new build lands, so the first page load
// already sees the current shape. loadConfig()/loadCredentials() call this too —
// it is memoised and idempotent, so double-running costs nothing.
onInstalled(async (details) => {
  try {
    const result = await runMigrations();
    if (result.applied.length) {
      console.log(
        `butter_jira: storage migrated v${result.from} -> v${result.to} (${details.reason})`
      );
    }
  } catch (err) {
    console.error("butter_jira: storage migration failed", err);
  }
});

// One app tab, reused. Clicking the toolbar icon with the app already open
// should raise it, not pile up duplicates.
onActionClicked(async () => {
  const appUrl = runtimeUrl("app.html");
  const [existing] = await queryTabs({ url: appUrl });
  if (existing) {
    await updateTab(existing.id, { active: true });
    await focusWindow(existing.windowId);
    return;
  }
  await createTab({ url: appUrl });
});

// The Jira-links redirect follows its switch and the configured site. Rules
// persist across restarts on their own; re-syncing on install and startup is
// what catches a site changed while the worker was asleep, or an extension
// update that changed the rules themselves.
const syncLinks = () => syncJiraLinkRules().catch((err) => console.error("butter_jira: link rules", err));
onInstalled(syncLinks);
onStartup(syncLinks);
onStorageChanged((changes, area) => {
  if ((area === "local" && OPEN_IN_APP_KEY in changes) || (area === "sync" && "site" in changes)) syncLinks();
});
