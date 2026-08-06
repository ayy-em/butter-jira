import { loadTheme, saveTheme } from "../utils.js";
import { CONFIG, siteHost, wikiUrl } from "../config.js";
import { getBadgeCount } from "../monitor.js";

const TABS = [
  { hash: "#backlog", label: "BACKLOG", key: "b" },
  { hash: "#gantt", label: "ROADMAP", key: "r" },
  { hash: "#kanban", label: "KANBAN", key: "k" },
  { hash: "#monitor", label: "MONITOR", key: "m" },
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
    const btn = document.createElement("a");
    btn.href = tab.hash;
    btn.className = "nav-tab mono";
    btn.textContent = tab.label;
    btn.dataset.hash = tab.hash;
    if (tab.hash === "#monitor") {
      const badge = document.createElement("span");
      badge.className = "nav-tab-badge";
      badge.id = "monitor-badge";
      badge.hidden = true;
      btn.appendChild(badge);
    }
    leftGroup.appendChild(btn);
  }
  nav.appendChild(leftGroup);

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

  const jiraLink = document.createElement("a");
  jiraLink.className = "nav-jira-link";
  jiraLink.href = CONFIG.site.baseUrl || "#";
  jiraLink.target = "_blank";
  jiraLink.rel = "noopener";
  jiraLink.textContent = "JIRA";
  jiraLink.title = siteHost() ? `Open ${siteHost()}` : "Open Jira";
  rightGroup.appendChild(jiraLink);

  const confluenceLink = document.createElement("a");
  confluenceLink.className = "nav-jira-link";
  confluenceLink.href = wikiUrl();
  confluenceLink.target = "_blank";
  confluenceLink.rel = "noopener";
  confluenceLink.textContent = "WIKI";
  confluenceLink.title = "Open Confluence";
  rightGroup.appendChild(confluenceLink);

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
    window.open(chrome.runtime.getURL("settings.html"));
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
      transition: color 0.15s, background 0.15s;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active { color: var(--text); background: rgba(232,234,240,0.08); }
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
  `;
  nav.appendChild(style);
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
  const badge = document.getElementById("monitor-badge");
  if (!badge) return;
  if (typeof count !== "number" || count <= 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 99 ? "99+" : String(count);
}

export function updateActiveTab() {
  const hash = location.hash || "#backlog";
  document.querySelectorAll(".nav-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.hash === hash);
  });
}
