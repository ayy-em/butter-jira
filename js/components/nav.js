import { runtimeUrl } from "../browser.js";
import { loadTheme, saveTheme } from "../utils.js";
import { CONFIG, jiraHomeUrl, siteHost, wikiUrl } from "../config.js";
import { getBadgeCount } from "../monitor.js";

// Six flat tabs outgrew the header, so the five board views collapse into two
// menus by what you're looking at — the whole backlog, or the sprint in flight.
// Standup stays top level: it's a daily ritual, not somewhere you browse to.
// The single-view labels inside a menu never repeat their parent ("ALL WORK",
// not "BACKLOG > BACKLOG"). Shortcut keys are handled in router.js; the letters
// here are display only.
const TABS = [
  {
    id: "backlog",
    label: "BACKLOG",
    items: [
      { hash: "#backlog", label: "ALL WORK", key: "B" },
      { hash: "#gantt", label: "ROADMAP", key: "R" },
    ],
  },
  {
    id: "sprint",
    label: "SPRINT",
    items: [
      { hash: "#dashboard", label: "DASHBOARD", key: "D" },
      { hash: "#kanban", label: "KANBAN", key: "K" },
      { hash: "#monitor", label: "MONITOR", key: "M", badge: true },
    ],
  },
  { hash: "#standup", label: "STANDUP", key: "S", flair: true },
];

// External tools get their own marks rather than text labels — the icons carry
// their own background plate, so they read in both themes without inversion.
const SITE_LINKS = [
  { label: "Jira", icon: "assets/logos/jira.png", url: jiraHomeUrl },
  { label: "Confluence", icon: "assets/logos/confluence.png", url: wikiUrl },
];

let lastSync = null;
let currentTheme = "dark";
let clockInterval = null;
let closeMenusHandler = null;

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
  nav.innerHTML = "";

  if (clockInterval) clearInterval(clockInterval);

  currentTheme = await loadTheme();

  const logoArea = document.createElement("div");
  logoArea.className = "nav-logo-area";
  logoArea.style.cssText = "display:flex;align-items:center;";

  // Org branding is optional: point brand.orgLogo at an untracked file under
  // assets/brand/ to show a wordmark, or set brand.orgName for a text label.
  // With neither set, the product logo stands alone.
  const brandMark = document.createElement("img");
  const hasOrgLogo = Boolean(CONFIG.brand.orgLogo);
  brandMark.src = hasOrgLogo ? CONFIG.brand.orgLogo : "assets/logo.png";
  brandMark.alt = CONFIG.brand.orgName || CONFIG.brand.productName;
  brandMark.style.height = "22px";
  brandMark.style.cursor = "pointer";
  applyBrandMarkTheme(brandMark, hasOrgLogo);
  brandMark.addEventListener("click", (e) => {
    e.preventDefault();
    fireConfetti(e.clientX, e.clientY);
  });
  brandMark.addEventListener("error", () => {
    // Configured logo missing (e.g. fresh clone without brand assets).
    brandMark.src = "assets/logo.png";
    applyBrandMarkTheme(brandMark, false);
  });
  logoArea.appendChild(brandMark);

  if (CONFIG.brand.orgName && !hasOrgLogo) {
    const orgLabel = document.createElement("span");
    orgLabel.className = "mono";
    orgLabel.style.cssText =
      "margin-left:8px;font-size:12px;font-weight:600;letter-spacing:1px;color:var(--muted);";
    orgLabel.textContent = CONFIG.brand.orgName;
    logoArea.appendChild(orgLabel);
  }

  const leftGroup = document.createElement("div");
  leftGroup.style.cssText = "display:flex;align-items:center;gap:4px;margin-left:1rem;margin-right:auto;";
  leftGroup.appendChild(logoArea);

  for (const tab of TABS) {
    leftGroup.appendChild(tab.items ? createTabMenu(tab) : createTabLink(tab));
  }
  nav.appendChild(leftGroup);

  // One document listener for every menu, re-bound on each nav render so a
  // re-render can't leave a stale closure holding on to detached nodes.
  if (closeMenusHandler) {
    document.removeEventListener("click", closeMenusHandler, true);
    document.removeEventListener("keydown", closeMenusHandler, true);
  }
  closeMenusHandler = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    if (e.type === "click" && e.target.closest(".nav-menu")) return;
    closeAllMenus();
  };
  document.addEventListener("click", closeMenusHandler, true);
  document.addEventListener("keydown", closeMenusHandler, true);

  // Restore a count already computed earlier this session.
  updateMonitorBadge(getBadgeCount());

  const centerGroup = document.createElement("div");
  centerGroup.style.cssText = "position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;";
  const clock = document.createElement("span");
  clock.id = "nav-clock";
  clock.className = "mono";
  clock.style.cssText = "display:flex;flex-direction:column;align-items:center;line-height:1.05;color:var(--text);letter-spacing:1px;white-space:nowrap;";
  const clockTime = document.createElement("span");
  clockTime.className = "nav-clock-time";
  clockTime.style.cssText = "font-size:16px;font-weight:500;";
  const clockTimezone = document.createElement("span");
  clockTimezone.className = "nav-clock-timezone";
  clockTimezone.style.cssText = "margin-top:2px;font-size:9px;font-weight:600;letter-spacing:0.8px;color:var(--muted);";
  clock.append(clockTime, clockTimezone);
  centerGroup.appendChild(clock);
  updateClock();
  clockInterval = setInterval(updateClock, 1000);
  nav.appendChild(centerGroup);

  const rightGroup = document.createElement("div");
  rightGroup.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto;margin-right:0.5rem;";

  const host = siteHost();
  for (const site of SITE_LINKS) {
    rightGroup.appendChild(
      createSiteLink(site, site.url(), host ? `Open ${site.label} on ${host}` : "")
    );
  }

  // Discoverability: the palette is a keyboard feature, and nobody finds a
  // keyboard feature without being told it exists.
  const paletteBtn = document.createElement("button");
  paletteBtn.className = "nav-btn nav-btn-wide mono";
  paletteBtn.textContent = isMac() ? "⌘K" : "^K";
  paletteBtn.title = `Command palette (${isMac() ? "⌘" : "Ctrl+"}K) — jump to an issue, person or view`;
  paletteBtn.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("palette-open"));
  });
  rightGroup.appendChild(paletteBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "nav-btn mono";
  refreshBtn.textContent = "⟳";
  refreshBtn.title = "Refresh";
  refreshBtn.addEventListener("click", onRefresh);
  rightGroup.appendChild(refreshBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "nav-btn mono";
  settingsBtn.textContent = "⚙";
  settingsBtn.title = "Settings";
  settingsBtn.addEventListener("click", () => {
    window.open(runtimeUrl("settings.html"));
  });
  rightGroup.appendChild(settingsBtn);

  const themeBtn = document.createElement("button");
  themeBtn.className = "theme-toggle";
  themeBtn.title = "Toggle theme";
  themeBtn.innerHTML = `
    <span class="toggle-track">
      <span class="toggle-stars">
        <span class="toggle-star"></span><span class="toggle-star"></span>
        <span class="toggle-star"></span><span class="toggle-star"></span>
        <span class="toggle-star"></span>
      </span>
      <span class="toggle-cloud"></span><span class="toggle-cloud"></span>
    </span>
    <span class="toggle-rays">
      <span class="toggle-ray"></span><span class="toggle-ray"></span>
      <span class="toggle-ray"></span><span class="toggle-ray"></span>
      <span class="toggle-ray"></span><span class="toggle-ray"></span>
      <span class="toggle-ray"></span>
    </span>
    <span class="toggle-body">
      <span class="toggle-crater"></span><span class="toggle-crater"></span>
      <span class="toggle-crater"></span>
    </span>
  `;
  themeBtn.addEventListener("click", async () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    await saveTheme(currentTheme);
    applyBrandMarkTheme(brandMark, hasOrgLogo);
  });
  rightGroup.appendChild(themeBtn);
  nav.appendChild(rightGroup);

  updateActiveTab();
  renderFooter();

  const style = document.createElement("style");
  style.textContent = `
    .nav-tab {
      text-decoration: none;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 1px;
      padding: 5px 14px;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s, box-shadow 0.2s;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active { color: var(--text); background: rgba(232,234,240,0.08); }

    /* ── Grouped views ─────────────────────────────────────────────────── */
    .nav-menu { position: relative; display: flex; align-items: center; }
    .nav-menu-trigger {
      display: flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      font-family: inherit;
      cursor: pointer;
    }
    .nav-menu-caret {
      font-size: 11px;
      line-height: 1;
      letter-spacing: 0;
      opacity: 0.7;
      transition: transform 0.15s;
    }
    .nav-menu.open .nav-menu-trigger { color: var(--text); background: rgba(232,234,240,0.08); }
    .nav-menu.open .nav-menu-caret { transform: rotate(180deg); }
    /* The rollup count is only useful while the menu hides the real badge. */
    .nav-menu.open .nav-tab-badge-rollup { visibility: hidden; }

    .nav-menu-panel {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 168px;
      padding: 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.28);
      display: flex;
      flex-direction: column;
      gap: 2px;
      z-index: 210;
      opacity: 0;
      visibility: hidden;
      transform: translateY(-4px);
      transition: opacity 0.12s, transform 0.12s, visibility 0.12s;
    }
    .nav-menu.open .nav-menu-panel {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
    .nav-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1px;
      padding: 7px 10px;
      border-radius: 4px;
      white-space: nowrap;
      transition: color 0.12s, background 0.12s;
    }
    .nav-menu-item:hover { color: var(--text); background: rgba(232,234,240,0.08); }
    .nav-menu-item.active { color: var(--text); background: rgba(79,142,247,0.16); }
    .nav-menu-key {
      margin-left: auto;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0;
      color: var(--muted);
      opacity: 0.7;
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
    }

    /* Standup is a timed, run-once-a-day ritual rather than a view you browse,
       so it gets an animated gradient ring instead of the flat tab treatment. */
    .nav-tab.flair {
      position: relative;
      color: var(--text);
      background: linear-gradient(135deg, rgba(79,142,247,0.14), rgba(168,85,247,0.14));
    }
    .nav-tab.flair::before {
      content: "";
      position: absolute;
      inset: -1px;
      border-radius: 5px;
      padding: 1px;
      background: linear-gradient(120deg, #4F8EF7, #A855F7, #F7914F, #4F8EF7);
      background-size: 300% 100%;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
      animation: nav-flair-sweep 6s linear infinite;
    }
    .nav-tab.flair:hover {
      background: linear-gradient(135deg, rgba(79,142,247,0.26), rgba(168,85,247,0.26));
      box-shadow: 0 0 14px rgba(79,142,247,0.35);
    }
    .nav-tab.flair:hover::before { animation-duration: 1.6s; }
    .nav-tab.flair.active {
      background: linear-gradient(135deg, rgba(79,142,247,0.34), rgba(168,85,247,0.34));
      box-shadow: 0 0 16px rgba(168,85,247,0.35);
    }
    @keyframes nav-flair-sweep { to { background-position: 300% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .nav-tab.flair::before,
      .nav-tab.flair:hover::before { animation: none; }
    }
    .nav-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 18px;
      width: 32px;
      height: 32px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-left: 4px;
      transition: color 0.15s, border-color 0.15s;
    }
    .nav-btn:hover { color: var(--text); border-color: var(--muted); }
    .nav-btn-wide {
      width: auto;
      padding: 0 9px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
  `;
  nav.appendChild(style);
}

function createTabLink(tab, { inMenu = false } = {}) {
  const link = document.createElement("a");
  link.href = tab.hash;
  link.className = inMenu ? "nav-menu-item mono" : "nav-tab mono";
  link.dataset.hash = tab.hash;
  if (tab.flair) link.classList.add("flair");

  const label = document.createElement("span");
  label.textContent = tab.label;
  link.appendChild(label);

  if (tab.badge) link.appendChild(createMonitorBadge());
  if (inMenu && tab.key) {
    const hint = document.createElement("span");
    hint.className = "nav-menu-key";
    hint.textContent = tab.key;
    link.appendChild(hint);
  }
  return link;
}

function createTabMenu(group) {
  const wrap = document.createElement("div");
  wrap.className = "nav-menu";
  wrap.dataset.menu = group.id;

  const trigger = document.createElement("button");
  trigger.className = "nav-tab nav-menu-trigger mono";
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.dataset.group = group.items.map((i) => i.hash).join(" ");

  const label = document.createElement("span");
  label.textContent = group.label;
  trigger.appendChild(label);

  // A count hidden inside a closed menu is a count nobody sees, so the badge
  // also rides on the trigger and only shows while the menu is shut.
  if (group.items.some((i) => i.badge)) {
    const badge = createMonitorBadge();
    badge.classList.add("nav-tab-badge-rollup");
    trigger.appendChild(badge);
  }

  const caret = document.createElement("span");
  caret.className = "nav-menu-caret";
  caret.textContent = "▾";
  trigger.appendChild(caret);

  const panel = document.createElement("div");
  panel.className = "nav-menu-panel";
  for (const item of group.items) panel.appendChild(createTabLink(item, { inMenu: true }));

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = wrap.classList.contains("open");
    closeAllMenus();
    if (!open) {
      wrap.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }
  });
  panel.addEventListener("click", (e) => {
    // Navigation happens through the href; the menu just gets out of the way.
    if (e.target.closest(".nav-menu-item")) closeAllMenus();
  });

  wrap.append(trigger, panel);
  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll(".nav-menu.open").forEach((el) => {
    el.classList.remove("open");
    el.querySelector(".nav-menu-trigger")?.setAttribute("aria-expanded", "false");
  });
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

  const icon = document.createElement("img");
  icon.src = site.icon;
  icon.alt = site.label;
  link.appendChild(icon);

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
    footer.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; height: 24px;
      background: var(--surface); border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 0 16px; gap: 16px;
    `;
    document.body.appendChild(footer);
  }
  footer.innerHTML = "";

  const syncLabel = document.createElement("span");
  syncLabel.id = "nav-sync";
  syncLabel.className = "mono";
  syncLabel.style.cssText = "font-size:11px;color:var(--muted);position:absolute;left:16px;";
  syncLabel.textContent = "";
  footer.appendChild(syncLabel);

  const productLogo = document.createElement("img");
  productLogo.src = "assets/logo.png";
  productLogo.alt = CONFIG.brand.productName;
  productLogo.title = CONFIG.brand.productName;
  productLogo.style.cssText = "height:14px;opacity:0.3;";
  footer.appendChild(productLogo);

  footer.appendChild(sourceLink());
}

// The project's own source, not the user's org — so the label names the repo
// literally rather than following CONFIG.brand.productName, which a whitelabel
// install will have changed. Absolutely positioned like the sync label on the
// left, so neither pushes the centred logo off centre.
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
  link.style.cssText =
    "display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);" +
    "position:absolute;right:16px;text-decoration:none;";

  link.appendChild(document.createTextNode("butter_jira @"));
  const mark = document.createElement("img");
  mark.className = "gh-mark";
  mark.src = "assets/logos/github.png";
  mark.alt = "GitHub";
  mark.style.cssText = "height:13px;width:13px;display:block;";
  link.appendChild(mark);

  link.addEventListener("mouseenter", () => { link.style.color = "var(--text)"; });
  link.addEventListener("mouseleave", () => { link.style.color = "var(--muted)"; });
  return link;
}

function fireConfetti(cx, cy) {
  const colors = ["#4F8EF7", "#F7914F", "#4FCF8E", "#EAB308", "#EF4444", "#A855F7"];
  const count = 60;
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;";
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    const size = 4 + Math.random() * 6;
    const color = colors[Math.floor(Math.random() * colors.length)];
    const angle = Math.random() * Math.PI * 2;
    const velocity = 120 + Math.random() * 280;
    const dx = Math.cos(angle) * velocity;
    const dy = Math.sin(angle) * velocity - 100;
    const rot = Math.random() * 720 - 360;
    p.style.cssText = `
      position:absolute; left:${cx}px; top:${cy}px;
      width:${size}px; height:${size * (0.4 + Math.random() * 0.6)}px;
      background:${color}; border-radius:${Math.random() > 0.5 ? "50%" : "1px"};
      opacity:1;
    `;
    p.animate([
      { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
      { transform: `translate(${dx}px,${dy + 400}px) rotate(${rot}deg)`, opacity: 0 },
    ], { duration: 800 + Math.random() * 600, easing: "cubic-bezier(0.25,0.46,0.45,0.94)", fill: "forwards" });
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 1600);
}

// The count comes from the Monitor view's last run — no extra Jira requests
// are made just to keep this badge fresh.
export function updateMonitorBadge(count) {
  // Two badges now: the menu item and the rollup on its closed trigger.
  const badges = document.querySelectorAll('.nav-tab-badge[data-badge="monitor"]');
  const empty = typeof count !== "number" || count <= 0;
  badges.forEach((badge) => {
    badge.hidden = empty;
    badge.textContent = empty ? "" : count > 99 ? "99+" : String(count);
  });
}

export function updateActiveTab() {
  const hash = location.hash || "#backlog";
  document.querySelectorAll(".nav-tab, .nav-menu-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.hash === hash);
  });
  // A menu trigger lights up for whichever of its children you're on.
  document.querySelectorAll(".nav-menu-trigger").forEach((el) => {
    el.classList.toggle("active", (el.dataset.group || "").split(" ").includes(hash));
  });
}
