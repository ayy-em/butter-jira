// Full-page issue view: the target of a cmd/ctrl-click or middle-click on any
// issue key. Linkable and reloadable, unlike the drawer.

import { getCredentials } from "./credentials.js";
import { CONFIG, isConfigured, siteHost } from "./config.js";
import { loadTeam } from "./team.js";
import { loadBoards, loadTheme } from "./utils.js";
import { renderIssueInto } from "./components/issue-detail.js";

function issueKeyFromUrl() {
  const key = new URLSearchParams(location.search).get("key");
  if (!key) return null;
  // Jira keys are PROJECT-123; anything else came from a hand-edited URL.
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? key.toUpperCase() : null;
}

async function init() {
  const root = document.getElementById("issue-root");

  // Same config, roster and theme the app uses — display-name overrides and
  // field mappings have to resolve here too. loadBoards() loads config first.
  await loadBoards();
  await loadTheme();
  await loadTeam();

  const key = issueKeyFromUrl();
  document.title = key ? `${key} — ${CONFIG.brand.productName}` : CONFIG.brand.productName;
  document.getElementById("issue-page-site").textContent = siteHost();

  if (!key) {
    root.innerHTML =
      '<div class="issue-error">No issue key in the URL. Open this page from an issue link.</div>';
    return;
  }

  const creds = await getCredentials();
  if (!creds || !isConfigured()) {
    root.innerHTML =
      '<div class="issue-error">Not configured yet — open the app and connect to Jira first.</div>';
    return;
  }

  await renderIssueInto(root, key, creds, { mode: "page" });
}

init();
