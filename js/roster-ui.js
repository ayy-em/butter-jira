// Roster editor for the Settings page.
//
// Three ways onto the roster, in order of how widely they work:
//   1. Harvest from boards — needs no extra Jira permission, but only finds
//      people who currently have an assigned issue.
//   2. Directory search — finds anyone, but needs "Browse users and groups",
//      which many sites restrict to admins. A 403 is expected, not a bug.
//   3. Manual entry — account ID (reliable) or email (linked on a later
//      harvest, since an email alone cannot be matched against issues).
//
// Edits are staged in memory and written by the page's Save button, the same as
// boards and status groups.

import { harvestTeamCandidates, searchUsers } from "./api.js";
import { setBoardList } from "./utils.js";
import { icon } from "./components/icons.js";
import {
  avatarAssetUrl,
  linkPendingMembers,
  memberLabel,
  normalizeAvatarPath,
  normalizeGithubLogin,
  normalizeMember,
  normalizeSlackHandle,
  removeMember,
  shortenName,
  upsertMember,
} from "./team.js";

const el = (id) => document.getElementById(id);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function initRoster({ flash, requireLiveJira, getBoards }) {
  const rosterList = el("rosterList");
  const rosterNote = el("rosterNote");
  const harvestBtn = el("harvestRosterBtn");
  const toggleAddBtn = el("toggleAddPersonBtn");
  const addPanel = el("addPersonPanel");
  const searchInput = el("userSearchInput");
  const searchBtn = el("userSearchBtn");
  const searchResults = el("userSearchResults");
  const manualIdentifier = el("manualIdentifier");
  const manualName = el("manualName");
  const addManualBtn = el("addManualBtn");

  let members = [];

  function setMembers(next) {
    members = next.map(normalizeMember);
    render();
  }

  function knownIds() {
    return new Set(members.map((m) => m.accountId).filter(Boolean));
  }

  function render() {
    rosterList.innerHTML = "";
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent =
        "No one on the roster yet. Harvest from your boards to get started.";
      rosterList.appendChild(empty);
    }

    members.forEach((member, i) => {
      const row = document.createElement("div");
      row.className = "board-row roster-row";

      // The avatar lives in a slot so the preview can be swapped in place as the
      // override path is typed, without disturbing the rest of the row.
      const avatarSlot = document.createElement("span");
      avatarSlot.className = "roster-avatar-slot";
      row.appendChild(avatarSlot);

      const jiraName = document.createElement("span");
      jiraName.className = "roster-jira-name";
      jiraName.textContent = member.jiraName || member.email || "—";
      jiraName.title = [member.jiraName, member.email, member.accountId]
        .filter(Boolean)
        .join("\n");
      row.appendChild(jiraName);

      const override = document.createElement("input");
      override.type = "text";
      override.className = "roster-override";
      override.value = member.nameOverride;
      override.placeholder = shortenName(member.jiraName) || "Display name";
      override.title = "Overrides the name Jira reports, everywhere in the app";
      override.addEventListener("input", () => {
        members[i].nameOverride = override.value;
      });
      row.appendChild(override);

      const avatarPath = document.createElement("input");
      avatarPath.type = "text";
      avatarPath.className = "roster-avatar-path mono";
      avatarPath.value = member.avatarOverride;
      avatarPath.placeholder = "assets/avatars/…";
      avatarPath.title =
        "Optional: a picture file inside the extension folder, e.g. " +
        "assets/avatars/sam.png. Replaces the Jira profile picture everywhere " +
        "in the app. Leave empty to use Jira's.";
      row.appendChild(avatarPath);

      // Redraws the preview from whatever is currently in the path box, and
      // flags a path that resolves but has no file behind it.
      function refreshAvatar() {
        avatarSlot.replaceChildren(
          avatarFor(members[i], () => {
            if (members[i].avatarOverride) avatarPath.classList.add("missing");
          })
        );
      }

      avatarPath.addEventListener("input", () => {
        const typed = avatarPath.value.trim();
        const clean = normalizeAvatarPath(typed);
        members[i].avatarOverride = clean;
        // Typed something that isn't a package-relative path — a URL, or ../
        avatarPath.classList.toggle("invalid", Boolean(typed) && !clean);
        avatarPath.classList.remove("missing");
        refreshAvatar();
      });

      refreshAvatar();

      const slack = document.createElement("input");
      slack.type = "text";
      slack.className = "roster-slack mono";
      slack.value = member.slackHandle ? `@${member.slackHandle}` : "";
      slack.placeholder = "@slack";
      slack.title =
        "Slack display name, used to address this person in the standup " +
        "parking-lot digest. The @ is optional, and spaces are fine — type it " +
        "exactly as Slack's @-autocomplete shows it.";
      slack.addEventListener("input", () => {
        members[i].slackHandle = normalizeSlackHandle(slack.value);
      });
      // Reformatted on blur rather than per keystroke, so the caret doesn't jump.
      slack.addEventListener("blur", () => {
        slack.value = members[i].slackHandle ? `@${members[i].slackHandle}` : "";
      });
      row.appendChild(slack);

      const github = document.createElement("input");
      github.type = "text";
      github.className = "roster-github mono";
      github.value = member.githubLogin;
      github.placeholder = "gh-login";
      github.title =
        "GitHub login, used to attribute pull requests to this person during " +
        "standup. Leave empty and they simply get no GitHub panel. A profile " +
        "URL or a leading @ are both accepted.";
      github.addEventListener("input", () => {
        const typed = github.value.trim();
        const clean = normalizeGithubLogin(typed);
        members[i].githubLogin = clean;
        // Typed something that is not a GitHub login — an email, or a name
        // with spaces. Flagged rather than silently discarded on save.
        github.classList.toggle("invalid", Boolean(typed) && !clean);
      });
      github.addEventListener("blur", () => {
        github.value = members[i].githubLogin;
        github.classList.remove("invalid");
      });
      row.appendChild(github);

      const emoji = document.createElement("input");
      emoji.type = "text";
      emoji.className = "roster-emoji";
      emoji.value = member.emoji;
      emoji.placeholder = "🙂";
      emoji.maxLength = 4;
      emoji.title = "Optional emoji shown before the name";
      emoji.addEventListener("input", () => {
        members[i].emoji = emoji.value;
      });
      row.appendChild(emoji);

      if (!member.accountId) {
        const badge = document.createElement("span");
        badge.className = "roster-badge";
        badge.textContent = "unlinked";
        badge.title =
          "No Jira account ID yet, so this person cannot be matched to issues. " +
          "Linked automatically when they next appear in a harvest.";
        row.appendChild(badge);
      }

      const toggle = document.createElement("label");
      toggle.className = "roster-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = member.active;
      box.title = "Inactive members are kept but ignored by filters and standup";
      box.addEventListener("change", () => {
        members[i].active = box.checked;
        renderNote();
      });
      const toggleLabel = document.createElement("span");
      toggleLabel.textContent = "in";
      toggle.append(box, toggleLabel);
      row.appendChild(toggle);

      const remove = document.createElement("button");
      remove.className = "remove-board icon-btn";
      remove.type = "button";
      remove.appendChild(icon("close", 13));
      remove.title = "Remove from roster";
      remove.setAttribute("aria-label", `Remove ${memberLabel(member)} from the roster`);
      remove.addEventListener("click", () => {
        members = removeMember(members, member);
        render();
      });
      row.appendChild(remove);

      rosterList.appendChild(row);
    });

    renderNote();
  }

  function renderNote() {
    const total = members.length;
    if (!total) {
      rosterNote.textContent = "";
      return;
    }
    const inactive = members.filter((m) => !m.active).length;
    const unlinked = members.filter((m) => !m.accountId).length;
    const parts = [`${total} member${total === 1 ? "" : "s"}`];
    if (inactive) parts.push(`${inactive} inactive`);
    if (unlinked) parts.push(`${unlinked} unlinked`);
    parts.push("press Save to keep changes");
    rosterNote.textContent = parts.join(" · ");
  }

  // Local override first, then Jira's picture, then initials. `onError` fires
  // when the chosen source fails to load, so the caller can say so.
  function avatarFor(member, onError = null) {
    const label = memberLabel(member);
    const src = member.avatarOverride
      ? avatarAssetUrl(member.avatarOverride)
      : member.avatarUrl;
    if (src) {
      const img = document.createElement("img");
      img.className = "roster-avatar";
      img.src = src;
      img.alt = "";
      img.addEventListener("error", () => {
        onError?.();
        img.replaceWith(placeholderFor(label));
      });
      return img;
    }
    return placeholderFor(label);
  }

  function placeholderFor(label) {
    const span = document.createElement("span");
    span.className = "roster-avatar roster-avatar-placeholder";
    span.textContent = (label.replace(/[^\p{L}\p{N}]/gu, "")[0] || "?").toUpperCase();
    return span;
  }

  function addPerson(person) {
    members = upsertMember(members, {
      accountId: person.accountId || null,
      email: person.email || "",
      jiraName: person.displayName || "",
      nameOverride: person.nameOverride || "",
      avatarUrl: person.avatarUrl || "",
    });
    render();
  }

  toggleAddBtn.addEventListener("click", () => {
    addPanel.hidden = !addPanel.hidden;
    toggleAddBtn.textContent = addPanel.hidden ? "+ Add a person" : "− Hide add panel";
    if (!addPanel.hidden) searchInput.focus();
  });

  harvestBtn.addEventListener("click", () => {
    // Harvest reads the boards currently listed on this page, including ones
    // imported but not yet saved. With none there is nothing to scan.
    const boards = (getBoards?.() || []).filter((b) => b.id);
    if (!boards.length) {
      return flash("Add or import a board first — harvest scans board assignees", "warning");
    }

    // Issues get tagged with their board name from the live list and then
    // cached, so it has to know these boards before any fetch happens.
    setBoardList(boards);

    return requireLiveJira(async (creds) => {
      harvestBtn.disabled = true;
      harvestBtn.textContent = "Harvesting...";
      try {
        const found = await harvestTeamCandidates(creds, boards);
        if (!found.length) {
          flash(
            `No assignees found across ${boards.length} board${boards.length === 1 ? "" : "s"}`,
            "warning"
          );
          return;
        }

        // Fill in account IDs for anyone added by email earlier.
        const linkResult = linkPendingMembers(members, found);
        members = linkResult.members;

        const known = knownIds();
        const fresh = found.filter((p) => !known.has(p.accountId));
        for (const person of fresh) addPerson(person);
        render();

        const bits = [];
        if (fresh.length) bits.push(`added ${fresh.length}`);
        if (linkResult.linked) bits.push(`linked ${linkResult.linked}`);
        flash(
          bits.length
            ? `Harvested ${found.length} assignee${found.length === 1 ? "" : "s"} — ${bits.join(", ")}; press Save`
            : `Harvested ${found.length} — all already on the roster`,
          bits.length ? "success" : "warning"
        );
      } finally {
        harvestBtn.disabled = false;
        harvestBtn.textContent = "↓ Harvest from boards";
      }
    }, "Harvest");
  });

  searchBtn.addEventListener("click", () => runSearch());
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });

  function runSearch() {
    const query = searchInput.value.trim();
    if (!query) return flash("Type a name or email to search", "warning");

    return requireLiveJira(async (creds) => {
      searchBtn.disabled = true;
      searchBtn.textContent = "...";
      searchResults.innerHTML = "";
      try {
        const found = await searchUsers(query, creds);
        renderSearchResults(found);
        if (!found.length) flash("No matching users", "warning");
      } catch (err) {
        const msg = String(err.message || err);
        if (msg.includes("403")) {
          searchResults.innerHTML = "";
          const note = document.createElement("div");
          note.className = "hint";
          note.textContent =
            "Your Jira account cannot browse the user directory (403). Use harvest, " +
            "or add people by account ID or email below.";
          searchResults.appendChild(note);
        } else {
          throw err;
        }
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "Search";
      }
    }, "Directory search");
  }

  function renderSearchResults(found) {
    searchResults.innerHTML = "";
    const known = knownIds();
    for (const person of found) {
      const row = document.createElement("div");
      row.className = "board-row result-row";
      row.appendChild(avatarFor(normalizeMember({ jiraName: person.displayName, avatarUrl: person.avatarUrl })));

      const label = document.createElement("span");
      label.className = "roster-jira-name";
      label.textContent = person.displayName + (person.email ? ` · ${person.email}` : "");
      row.appendChild(label);

      const add = document.createElement("button");
      add.className = "result-add";
      const already = known.has(person.accountId);
      add.textContent = already ? "on roster" : "add";
      add.disabled = already;
      add.addEventListener("click", () => {
        addPerson(person);
        add.textContent = "added";
        add.disabled = true;
        flash(`${shortenName(person.displayName)} added — press Save`, "success");
      });
      row.appendChild(add);

      searchResults.appendChild(row);
    }
  }

  addManualBtn.addEventListener("click", () => {
    const identifier = manualIdentifier.value.trim();
    const name = manualName.value.trim();
    if (!identifier) return flash("Enter an account ID or email", "warning");

    const isEmail = EMAIL_RE.test(identifier);
    if (isEmail) {
      // Try to resolve to a real account first; fall back to unlinked.
      return requireLiveJira(async (creds) => {
        let resolved = null;
        try {
          const found = await searchUsers(identifier, creds);
          resolved = found.find((p) => p.email?.toLowerCase() === identifier.toLowerCase()) || found[0] || null;
        } catch {
          resolved = null; // 403 or anything else — store unlinked.
        }
        addPerson({
          accountId: resolved?.accountId || null,
          email: identifier,
          displayName: resolved?.displayName || name,
          nameOverride: name,
          avatarUrl: resolved?.avatarUrl || "",
        });
        manualIdentifier.value = "";
        manualName.value = "";
        flash(
          resolved
            ? `${shortenName(resolved.displayName)} added — press Save`
            : "Added as unlinked — will link on the next harvest; press Save",
          resolved ? "success" : "warning"
        );
      }, "Add by email");
    }

    addPerson({ accountId: identifier, email: "", displayName: name, nameOverride: name });
    manualIdentifier.value = "";
    manualName.value = "";
    flash("Added — press Save", "success");
  });

  // Fills in GitHub logins proposed by the org matcher. Only ever writes into
  // an empty field — a login someone typed by hand is never overwritten by a
  // guess — and the rows stay editable, so this is a starting point rather
  // than a decision.
  function applyGithubLogins(assignments) {
    let applied = 0;
    for (const { accountId, login } of assignments) {
      const member = members.find((m) => m.accountId === accountId);
      const clean = normalizeGithubLogin(login);
      if (!member || !clean || member.githubLogin) continue;
      member.githubLogin = clean;
      applied++;
    }
    if (applied) render();
    return applied;
  }

  return {
    setMembers,
    getMembers: () => members.map(normalizeMember),
    applyGithubLogins,
    countMissingGithubLogins: () =>
      members.filter((m) => m.accountId && m.active && !m.githubLogin).length,
  };
}
