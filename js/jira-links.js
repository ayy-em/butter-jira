// Jira links open in the extension (ROADMAP, deferred backlog, built 2026-09-29).
//
// Every Jira link elsewhere — Slack, a PR description, a calendar invite — lands
// on Jira Cloud, the product this app exists to avoid. With this switched on, the
// links that have an equivalent screen here open that screen instead:
//
//   /browse/ABC-123                                → issue.html?key=ABC-123
//   …/projects/ABC/boards/N?selectedIssue=ABC-123 → issue.html?key=ABC-123
//   …/projects/ABC/boards/N/backlog               → app.html#backlog
//   …/projects/ABC/boards/N                       → app.html#kanban
//
// Everything else — filters, dashboards, project and admin pages, Confluence
// under /wiki/ — passes through untouched: a screen that cannot answer the
// question is worse than Jira.
//
// ── Decisions, taken 2026-09-29 ──────────────────────────────────────────────
//
//   * **Redirect rules (declarativeNetRequest), not a content script.** They
//     fire before Jira loads — no flash — and run no code inside Jira's page. The
//     permission is `declarativeNetRequestWithHostAccess`, which acts only where
//     the extension already has host access and so adds no install warning: the
//     lean-permissions objection this was deferred on does not apply. Rules
//     cover top-level navigations only (`main_frame`), so the API calls the app
//     itself makes to Jira are never touched.
//   * **Off by default**, a switch in Settings. It changes what a link does
//     system-wide, including links in other people's messages.
//   * **The configured site only**, never *.atlassian.net at large.
//   * **The escape hatch is `butterjira=skip`** in the URL: an allow rule at a
//     higher priority lets it through. Every link this app renders to Jira
//     carries it (`browseUrl` in js/config.js), so "Open in Jira" still opens
//     Jira, and anyone can add it to a URL by hand.
//   * **Where it lands:** in the tab the link was clicked in. That differs from
//     the toolbar button's reuse-one-app-tab rule, knowingly — a link opens
//     where links open.
//   * **Atlassian Cloud hosts only.** Redirecting into an extension page needs
//     the page listed in `web_accessible_resources` for the site, which the
//     manifest declares for *.atlassian.net; a custom-domain Data Center site
//     would need every https site listed, and is not offered.

import { getRedirectRules, hasRedirectRules, localGet, runtimeUrl, setRedirectRules, syncGet } from "./browser.js";

export const OPEN_IN_APP_KEY = "openJiraLinksInApp";
export const SKIP_PARAM = "butterjira=skip";

// A private id range, so a sync only ever removes its own rules.
const RULE_IDS = { skip: 9100, browse: 9101, selected: 9102, backlog: 9103, board: 9104 };
const ALL_IDS = Object.values(RULE_IDS);

const KEY = "([A-Z][A-Z0-9_]+-[0-9]+)";

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function supportedHost(host) {
  return /^[a-z0-9-]+\.atlassian\.net$/i.test(String(host || ""));
}

// Pure: the rules for one site, given where the app's pages live.
export function buildRules(host, { issuePage, appPage }) {
  if (!supportedHost(host)) return [];
  const origin = `^https://${escapeRegex(host)}`;
  const board = `${origin}/jira/software/(?:c/)?projects/[^/?#]+/boards/[0-9]+`;
  const mainFrame = { resourceTypes: ["main_frame"] };
  const redirect = (id, priority, regexFilter, regexSubstitution) => ({
    id,
    priority,
    action: { type: "redirect", redirect: { regexSubstitution } },
    condition: { ...mainFrame, regexFilter },
  });
  return [
    {
      id: RULE_IDS.skip,
      priority: 10,
      action: { type: "allow" },
      condition: { ...mainFrame, requestDomains: [host], urlFilter: SKIP_PARAM },
    },
    redirect(RULE_IDS.browse, 3, `${origin}/browse/${KEY}(?:[?#].*)?$`, `${issuePage}?key=\\1`),
    redirect(RULE_IDS.selected, 3, `${board}[^?#]*\\?(?:.*&)?selectedIssue=${KEY}(?:[&#].*)?$`, `${issuePage}?key=\\1`),
    redirect(RULE_IDS.backlog, 2, `${board}/backlog/?(?:[?#].*)?$`, `${appPage}#backlog`),
    redirect(RULE_IDS.board, 1, `${board}/?(?:[?#].*)?$`, `${appPage}#kanban`),
  ];
}

// Appends the escape hatch to a Jira URL this app renders.
export function withSkip(url) {
  if (!url || url === "#") return url;
  const [base, hash = ""] = String(url).split("#");
  return `${base}${base.includes("?") ? "&" : "?"}${SKIP_PARAM}${hash ? `#${hash}` : ""}`;
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

// Bring the browser's rules in line with the setting and the configured site.
// Returns what is now in force, for Settings to report.
export async function syncJiraLinkRules() {
  if (!hasRedirectRules()) return { state: "unsupported" };
  const [{ [OPEN_IN_APP_KEY]: on }, { site }] = await Promise.all([
    localGet([OPEN_IN_APP_KEY]),
    syncGet(["site"]),
  ]);
  const host = hostOf(site?.baseUrl || "");
  const existing = (await getRedirectRules()).map((r) => r.id).filter((id) => ALL_IDS.includes(id));
  if (!on) {
    await setRedirectRules({ removeRuleIds: existing });
    return { state: "off", host };
  }
  if (!supportedHost(host)) {
    await setRedirectRules({ removeRuleIds: existing });
    return { state: host ? "unsupported-host" : "no-site", host };
  }
  const addRules = buildRules(host, {
    issuePage: runtimeUrl("issue.html"),
    appPage: runtimeUrl("app.html"),
  });
  await setRedirectRules({ removeRuleIds: [...new Set([...existing, ...ALL_IDS])], addRules });
  return { state: "on", host };
}
