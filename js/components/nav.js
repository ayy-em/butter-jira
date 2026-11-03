import { runtimeUrl } from "../browser.js";
import { loadTheme } from "../utils.js";
import { createThemeToggle } from "./theme-toggle.js";
import { icon } from "./icons.js";
import { closeQuickNote, toggleQuickNote } from "./quick-note.js";
import { CONFIG, jiraHomeUrl, siteHost, wikiUrl } from "../config.js";
import { getBadgeCount } from "../monitor.js";
import { prewarmGithub } from "../github.js";
import { activeMembers, activeTeam, avatarAssetUrl, memberLabel } from "../team.js";
import { burst } from "../confetti.js";

// The left sidebar, which replaced the top bar when the dashboard became the
// Team Overview. Same three groups the top bar's menus held, now always open:
// a sidebar has the height a header never had, so nothing needs to hide inside
// a dropdown, and a view you can see is a view you remember exists.
//
// SPRINT leads because the dashboard is where the day starts. LAUNCH is the
// rituals you *run* rather than read — standup, planning, the 1:1, the recap —
// and BACKLOG is the whole of the work beyond this sprint. Shortcut keys are
// handled in router.js; the letters here are display only.
//
// Standup keeps its animated ring (README → Design system, pinned item 1).
const TABS = [
  {
    id: "sprint",
    label: "SPRINT",
    items: [
      { hash: "#dashboard", label: "DASHBOARD", key: "D", icon: "dashboard" },
      { hash: "#kanban", label: "KANBAN", key: "K", icon: "columns" },
      { hash: "#monitor", label: "MONITOR", key: "M", icon: "pulse", badge: true },
    ],
  },
  {
    id: "launch",
    label: "LAUNCH",
    items: [
      { hash: "#standup", label: "STANDUP", key: "S", icon: "timer", flair: true, prewarm: prewarmGithub },
      // Sprint planning is the fourth ritual: prepared the day before, reviewed
      // in the meeting, pushed to Jira at the end of it (M15).
      { hash: "#planner", label: "SPRINT PLANNER", key: "P", icon: "calendar" },
      // M23's flow, beside the planner while the two are compared.
      { hash: "#planflow", label: "SPRINT PLANNING (NEW)", icon: "flag" },
      { hash: "#oneone", label: "1:1", key: "1", icon: "person" },
      { hash: "#todos", label: "MY TODOS", key: "T", icon: "check" },
      // The screen that builds any recap — active, closed, several sprints,
      // several boards — which is what the retrospective prints from.
      { hash: "#recap-config", label: "RECAP CONFIG", icon: "doc" },
    ],
  },
  {
    id: "backlog",
    label: "BACKLOG",
    items: [
      { hash: "#backlog", label: "ALL WORK", key: "B", icon: "backlog" },
      { hash: "#gantt", label: "ROADMAP", key: "R", icon: "roadmap" },
    ],
  },
];

// Where the app lands with no hash — the sprint Kanban, which opens filtered to
// the current sprint. Lives beside TABS rather than in the router so the tab
// highlight and the mounted view read the same constant; the router imports it.
export const HOME_HASH = "#kanban";

// External tools get their own marks rather than text labels — the icons carry
// their own background plate, so they read in both themes without inversion.
const SITE_LINKS = [
  { label: "Jira", icon: "assets/logos/jira.png", url: jiraHomeUrl },
  { label: "Confluence", icon: "assets/logos/confluence.png", url: wikiUrl },
];

let lastSync = null;
let currentTheme = "dark";
let clockInterval = null;

export function setLastSync(date) {
  lastSync = date;
  const el = document.getElementById("nav-sync");
  if (el) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    el.textContent = `Synced ${hh}:${mm}`;
  }
}

function isMac() {
  return /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
}

function getTimezoneShort() {
  try {
    const short = new Date().toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
    return short;
  } catch {
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const h = Math.floor(Math.abs(offset) / 60);
    return `GMT${sign}${h}`;
  }
}

function updateClock() {
  const el = document.getElementById("nav-clock");
  if (!el) return;
  const timeEl = el.querySelector(".nav-clock-time");
  const timezoneEl = el.querySelector(".nav-clock-timezone");
  if (!timeEl || !timezoneEl) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  timeEl.textContent = `${hh}:${mm}:${ss}`;
  timezoneEl.textContent = getTimezoneShort();
}

export async function renderNav(onRefresh) {
  const nav = document.getElementById("nav");
  // Its anchor is about to be thrown away.
  closeQuickNote({ restoreFocus: false });
  nav.innerHTML = "";
  nav.setAttribute("aria-label", "Main");

  if (clockInterval) clearInterval(clockInterval);

  currentTheme = await loadTheme();

  // ── Brand and clock ──────────────────────────────────────────────────────
  const logoArea = document.createElement("div");
  logoArea.className = "nav-logo-area";

  // Org branding is optional: point brand.orgLogo at an untracked file under
  // assets/brand/ to show a wordmark, or set brand.orgName for a text label.
  // With neither set, the product logo stands alone.
  const brandMark = document.createElement("img");
  const hasOrgLogo = Boolean(CONFIG.brand.orgLogo);
  brandMark.className = "nav-brand-mark";
  brandMark.src = hasOrgLogo ? CONFIG.brand.orgLogo : "assets/logo.png";
  brandMark.alt = CONFIG.brand.orgName || CONFIG.brand.productName;
  applyBrandMarkTheme(brandMark, hasOrgLogo);
  brandMark.addEventListener("click", (e) => {
    e.preventDefault();
    // One nozzle at the pointer, thrown in every direction. js/confetti.js is
    // the only confetti, and it does nothing under prefers-reduced-motion.
    burst({
      origin: [{
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
        angle: -90,
        spread: 360,
        power: 14,
      }],
      count: 60,
    });
  });
  brandMark.addEventListener("error", () => {
    // Configured logo missing (e.g. fresh clone without brand assets).
    brandMark.src = "assets/logo.png";
    applyBrandMarkTheme(brandMark, false);
  });
  logoArea.appendChild(brandMark);

  const names = document.createElement("div");
  names.className = "nav-brand-names";
  const product = document.createElement("span");
  product.className = "nav-brand-product mono";
  product.textContent = CONFIG.brand.productName;
  names.appendChild(product);
  if (CONFIG.brand.orgName) {
    const org = document.createElement("span");
    org.className = "nav-brand-org";
    org.textContent = CONFIG.brand.orgName;
    names.appendChild(org);
  }
  logoArea.appendChild(names);
  nav.appendChild(logoArea);

  const clock = document.createElement("div");
  clock.id = "nav-clock";
  clock.className = "mono";
  const clockTime = document.createElement("span");
  clockTime.className = "nav-clock-time";
  const clockTimezone = document.createElement("span");
  clockTimezone.className = "nav-clock-timezone";
  clock.append(clockTime, clockTimezone);
  nav.appendChild(clock);
  updateClock();
  clockInterval = setInterval(updateClock, 1000);

  // ── Views ────────────────────────────────────────────────────────────────
  // Scrolls on its own when the window is short, so the team summary and
  // Settings stay pinned to the bottom edge instead of being pushed off it.
  const views = document.createElement("div");
  views.className = "nav-views";
  for (const group of TABS) views.appendChild(createGroup(group));
  nav.appendChild(views);

  // Restore a count already computed earlier this session.
  updateMonitorBadge(getBadgeCount());

  // ── Team, tools, settings ────────────────────────────────────────────────
  const foot = document.createElement("div");
  foot.className = "nav-foot";
  foot.appendChild(teamSummary());

  const tools = document.createElement("div");
  tools.className = "nav-tools";

  // In the sidebar rather than on the 1:1 sheet, because the thing to raise with
  // somebody occurs to you on whatever screen you happen to be on.
  const quickBtn = document.createElement("button");
  quickBtn.id = "nav-quick-note";
  quickBtn.className = "nav-btn mono";
  quickBtn.appendChild(icon("plus", 16));
  quickBtn.title = "Quick note (N) — an agenda item or action for someone's 1:1, or a todo for yourself";
  quickBtn.setAttribute("aria-label", "Quick note");
  quickBtn.setAttribute("aria-haspopup", "dialog");
  quickBtn.setAttribute("aria-expanded", "false");
  quickBtn.addEventListener("click", () => toggleQuickNote(quickBtn));
  tools.appendChild(quickBtn);

  // Discoverability: the palette is a keyboard feature, and nobody finds a
  // keyboard feature without being told it exists.
  const paletteBtn = document.createElement("button");
  paletteBtn.className = "nav-btn nav-btn-wide mono";
  paletteBtn.textContent = isMac() ? "⌘K" : "^K";
  paletteBtn.title = `Command palette (${isMac() ? "⌘" : "Ctrl+"}K) — jump to an issue, person or view`;
  paletteBtn.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("palette-open"));
  });
  tools.appendChild(paletteBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "nav-btn mono";
  refreshBtn.appendChild(icon("refresh", 16));
  refreshBtn.title = "Refresh";
  refreshBtn.setAttribute("aria-label", "Refresh");
  refreshBtn.addEventListener("click", onRefresh);
  tools.appendChild(refreshBtn);

  // The sky itself lives in js/components/theme-toggle.js — settings.html used
  // to hand-write the same twenty spans into its own markup.
  const themeBtn = createThemeToggle({
    theme: currentTheme,
    onChange: (theme) => {
      currentTheme = theme;
      // The one thing CSS cannot do here: the brand mark is two files.
      applyBrandMarkTheme(brandMark, hasOrgLogo);
    },
  });
  tools.appendChild(themeBtn);
  foot.appendChild(tools);

  const sites = document.createElement("div");
  sites.className = "nav-sites";
  const host = siteHost();
  for (const site of SITE_LINKS) {
    sites.appendChild(
      createSiteLink(site, site.url(), host ? `Open ${site.label} on ${host}` : "")
    );
  }
  foot.appendChild(sites);

  // Settings last, at the bottom edge — it opens its own page, which is also
  // where the integrations (Jira, GitHub) are connected.
  const settings = document.createElement("a");
  settings.className = "nav-item nav-settings mono";
  settings.href = runtimeUrl("settings.html");
  settings.target = "_blank";
  settings.rel = "noopener";
  settings.title = "Settings — boards, fields, team roster, Jira and GitHub connections";
  settings.append(icon("gear", 16));
  const settingsLabel = document.createElement("span");
  settingsLabel.textContent = "SETTINGS";
  settings.appendChild(settingsLabel);
  foot.appendChild(settings);
  nav.appendChild(foot);

  updateActiveTab();
  renderFooter();
}

function createGroup(group) {
  const section = document.createElement("div");
  section.className = "nav-group";
  section.dataset.menu = group.id;
  const heading = document.createElement("div");
  heading.className = "nav-group-label mono";
  heading.textContent = group.label;
  section.appendChild(heading);
  for (const item of group.items) section.appendChild(createTabLink(item));
  return section;
}

function createTabLink(tab) {
  const link = document.createElement("a");
  // A `url` item points at another extension page rather than at a view in this
  // one, so it opens in its own tab and never lights up as the active view —
  // there is no hash for it to match.
  if (tab.url) {
    link.href = runtimeUrl(tab.url);
    link.target = "_blank";
    link.rel = "noopener";
  } else {
    link.href = tab.hash;
    link.dataset.hash = tab.hash;
  }
  link.className = "nav-item mono";
  if (tab.flair) link.classList.add("flair");
  if (tab.icon) link.appendChild(icon(tab.icon, 16));

  const label = document.createElement("span");
  label.className = "nav-item-label";
  label.textContent = tab.label;
  link.appendChild(label);

  // On pointerdown, not click: it fires a frame or two earlier, and a fetch
  // whose result nobody ends up needing costs one cached GraphQL round trip.
  // Standup's GitHub window is the only thing slow enough to be worth it.
  if (tab.prewarm) {
    link.addEventListener("pointerdown", () => tab.prewarm(), { passive: true });
  }

  if (tab.badge) link.appendChild(createMonitorBadge());
  if (tab.key) {
    const hint = document.createElement("span");
    hint.className = "nav-menu-key";
    hint.textContent = tab.key;
    link.appendChild(hint);
  }
  return link;
}

// Who the sprint belongs to: the roster's team name, a head count by role
// ("6 Data Engineers · 1 Data Analyst"), and the faces. Roles are free text on
// each roster entry; anyone without one is counted as a person. Opens the 1:1
// picker, which is the one screen organised by person.
function teamSummary() {
  const members = activeMembers();
  const link = document.createElement("a");
  link.className = "nav-team";
  link.href = "#oneone";

  const label = document.createElement("div");
  label.className = "nav-group-label mono";
  label.textContent = "TEAM";
  link.appendChild(label);

  const name = document.createElement("div");
  name.className = "nav-team-name";
  name.textContent = activeTeam()?.name || "My team";
  link.appendChild(name);

  const counts = document.createElement("div");
  counts.className = "nav-team-counts";
  counts.textContent = members.length
    ? roleSummary(members)
    : "No roster yet — add people in Settings → Team";
  link.appendChild(counts);

  if (members.length) {
    const faces = document.createElement("div");
    faces.className = "nav-team-faces";
    for (const member of members.slice(0, 8)) faces.appendChild(face(member));
    if (members.length > 8) {
      const more = document.createElement("span");
      more.className = "nav-face nav-face-more mono";
      more.textContent = `+${members.length - 8}`;
      faces.appendChild(more);
    }
    link.appendChild(faces);
  }
  link.title = members.length
    ? `${members.map(memberLabel).join(", ")} — open the 1:1 picker`
    : "Open Settings to add the team roster";
  return link;
}

export function roleSummary(members) {
  const byRole = new Map();
  for (const member of members) {
    const role = member.role || "";
    byRole.set(role, (byRole.get(role) || 0) + 1);
  }
  const parts = [...byRole.entries()]
    .filter(([role]) => role)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, n]) => `${n} ${n === 1 || /s$/i.test(role) ? role : role + "s"}`);
  if (!parts.length) return `${members.length} ${members.length === 1 ? "person" : "people"}`;
  const unroled = byRole.get("") || 0;
  if (unroled) parts.push(`${unroled} other`);
  return parts.join(" · ");
}

function face(member) {
  const src = member.avatarOverride ? avatarAssetUrl(member.avatarOverride) : member.avatarUrl;
  const label = memberLabel(member);
  const initials = label
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const el = document.createElement("span");
  el.className = "nav-face mono";
  el.title = label;
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.addEventListener("error", () => {
      img.remove();
      el.textContent = initials || "?";
    });
    el.appendChild(img);
  } else {
    el.textContent = initials || "?";
  }
  return el;
}

function createMonitorBadge() {
  const badge = document.createElement("span");
  badge.className = "nav-tab-badge";
  badge.dataset.badge = "monitor";
  badge.hidden = true;
  return badge;
}

// Every external site link goes through here so an unconfigured site URL can
// never render a link that goes nowhere: it points at Settings instead, which
// is where the missing URL is entered.
function createSiteLink(site, url, title) {
  const link = document.createElement("a");
  link.className = "nav-jira-link nav-icon-link";
  link.target = "_blank";
  link.rel = "noopener";

  const img = document.createElement("img");
  img.src = site.icon;
  img.alt = "";
  link.appendChild(img);
  const label = document.createElement("span");
  label.textContent = site.label;
  link.appendChild(label);

  if (url) {
    link.href = url;
    link.title = title || `Open ${site.label}`;
  } else {
    link.href = runtimeUrl("settings.html");
    link.classList.add("unset");
    link.title = `No Jira site URL configured — open Settings to set one (${site.label})`;
  }
  return link;
}

// Org wordmarks are usually single-colour and supplied light-on-dark, so they
// get inverted in light theme. The product logo is full-colour: leave it alone.
function applyBrandMarkTheme(img, isOrgLogo) {
  const light = currentTheme === "light";
  img.style.opacity = isOrgLogo && light ? "0.7" : "1";
  img.style.filter = isOrgLogo && light ? "invert(1)" : "none";
}

function renderFooter() {
  let footer = document.getElementById("app-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "app-footer";
    document.body.appendChild(footer);
  }
  footer.innerHTML = "";

  const syncLabel = document.createElement("span");
  syncLabel.id = "nav-sync";
  syncLabel.className = "mono";
  syncLabel.textContent = "";
  footer.appendChild(syncLabel);

  const productLogo = document.createElement("img");
  productLogo.className = "footer-logo";
  productLogo.src = "assets/logo.png";
  productLogo.alt = CONFIG.brand.productName;
  productLogo.title = CONFIG.brand.productName;
  footer.appendChild(productLogo);

  footer.appendChild(sourceLink());
}

// The project's own source, not the user's org — so the label names the repo
// literally rather than following CONFIG.brand.productName, which a whitelabel
// install will have changed.
// Hyphen, not underscore: the local directory is butter_jira but the repo —
// and this checkout's origin — is butter-jira. The underscore form 404s.
export const SOURCE_URL = "https://github.com/ayy-em/butter-jira";

function sourceLink() {
  const link = document.createElement("a");
  link.className = "mono footer-source";
  link.href = SOURCE_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = SOURCE_URL;

  link.appendChild(document.createTextNode("butter_jira @"));
  const mark = document.createElement("img");
  mark.className = "gh-mark";
  mark.src = "assets/logos/github.png";
  mark.alt = "GitHub";
  link.appendChild(mark);
  return link;
}

// The count comes from the Monitor view's last run — no extra Jira requests
// are made just to keep this badge fresh.
export function updateMonitorBadge(count) {
  const badges = document.querySelectorAll('.nav-tab-badge[data-badge="monitor"]');
  const empty = typeof count !== "number" || count <= 0;
  badges.forEach((badge) => {
    badge.hidden = empty;
    badge.textContent = empty ? "" : count > 99 ? "99+" : String(count);
  });
}

// A view may own a sub-route — the 1:1 sheet is `#oneone/<accountId>`, a past
// sprint on the dashboard `#dashboard/<board>:<sprint>` — and the item for it
// has to stay lit while you are inside one. Exported because the router routes
// on the same rule, and two places disagreeing about what counts as "the
// current view" is how a sidebar ends up highlighting nothing.
export function routeOf(hash = location.hash) {
  return String(hash || "").split("/")[0];
}

export function updateActiveTab() {
  const hash = routeOf(location.hash || HOME_HASH);
  document.querySelectorAll(".nav-item").forEach((el) => {
    const active = Boolean(el.dataset.hash) && el.dataset.hash === hash;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}
