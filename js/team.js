// Team roster: who is on the team, and what to call them.
//
// Stored in chrome.storage.local, not sync. A roster holds colleagues' names,
// emails and avatars — other people's personal data — so it stays on the device
// rather than replicating through the user's Google account. It is excluded
// from config exports unless explicitly opted in, and never belongs in
// config.local.json (which is a repo file).
//
// The shape carries a team list and an active id from day one, so a team
// switcher can be added later without a storage migration. For now there is
// exactly one team.

export const TEAMS_KEY = "teams";
export const TEAM_ONLY_KEY = "teamOnly";
export const DEFAULT_TEAM_ID = "default";
export const DEFAULT_TEAM_NAME = "My team";

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

function emptyStructure() {
  return {
    activeTeamId: DEFAULT_TEAM_ID,
    teams: [{ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, members: [] }],
  };
}

// Live structure, mutated in place so modules can hold a reference.
export const TEAMS = emptyStructure();

export function normalizeMember(raw = {}) {
  const accountId = typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId.trim() : null;
  return {
    accountId,
    email: typeof raw.email === "string" ? raw.email.trim() : "",
    // The name Jira reports, kept for reference so an override can be undone.
    jiraName: typeof raw.jiraName === "string" ? raw.jiraName : (typeof raw.displayName === "string" ? raw.displayName : ""),
    nameOverride: typeof raw.nameOverride === "string" ? raw.nameOverride.trim() : "",
    emoji: typeof raw.emoji === "string" ? raw.emoji.trim().slice(0, 4) : "",
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : "",
    active: raw.active !== false,
    // Reserved for the sprint planner (M8); carried through untouched.
    capacity: raw.capacity && typeof raw.capacity === "object" ? { ...raw.capacity } : {},
  };
}

export function normalizeStructure(raw) {
  if (!raw || typeof raw !== "object") return emptyStructure();

  const teams = Array.isArray(raw.teams) && raw.teams.length
    ? raw.teams
        .filter((t) => t && typeof t === "object")
        .map((t, i) => ({
          id: typeof t.id === "string" && t.id.trim() ? t.id.trim() : `team-${i + 1}`,
          name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : DEFAULT_TEAM_NAME,
          members: dedupeMembers((Array.isArray(t.members) ? t.members : []).map(normalizeMember)),
        }))
    : emptyStructure().teams;

  const activeTeamId = teams.some((t) => t.id === raw.activeTeamId)
    ? raw.activeTeamId
    : teams[0].id;

  return { activeTeamId, teams };
}

// One entry per person: accountId wins, else email, else Jira name. Later
// entries fill in blanks on earlier ones rather than duplicating the person.
function dedupeMembers(members) {
  const out = [];
  const index = new Map();
  const keysFor = (m) =>
    [m.accountId && `id:${m.accountId}`, m.email && `mail:${m.email.toLowerCase()}`]
      .filter(Boolean);

  for (const member of members) {
    const keys = keysFor(member);
    const hitKey = keys.find((k) => index.has(k));
    if (hitKey === undefined) {
      const position = out.push(member) - 1;
      const stored = keys.length ? keys : [`name:${member.jiraName.toLowerCase()}`];
      for (const key of stored) index.set(key, position);
      continue;
    }
    const existing = out[index.get(hitKey)];
    existing.accountId = existing.accountId || member.accountId;
    existing.email = existing.email || member.email;
    existing.jiraName = existing.jiraName || member.jiraName;
    existing.nameOverride = existing.nameOverride || member.nameOverride;
    existing.emoji = existing.emoji || member.emoji;
    existing.avatarUrl = existing.avatarUrl || member.avatarUrl;
    for (const key of keysFor(existing)) {
      if (!index.has(key)) index.set(key, index.get(hitKey));
    }
  }
  return out;
}

export async function loadTeam() {
  const stored = await localGet([TEAMS_KEY]);
  const next = normalizeStructure(stored[TEAMS_KEY]);
  TEAMS.activeTeamId = next.activeTeamId;
  TEAMS.teams = next.teams;
  return TEAMS;
}

export async function saveTeam(structure = TEAMS) {
  const next = normalizeStructure(structure);
  TEAMS.activeTeamId = next.activeTeamId;
  TEAMS.teams = next.teams;
  await localSet({ [TEAMS_KEY]: next });
  return TEAMS;
}

export function activeTeam() {
  return TEAMS.teams.find((t) => t.id === TEAMS.activeTeamId) || TEAMS.teams[0];
}

// Everyone on the roster, including inactive and unlinked entries.
export function allMembers() {
  return activeTeam()?.members || [];
}

// Members who can actually be matched against issues and counted for standup.
export function activeMembers() {
  return allMembers().filter((m) => m.active && m.accountId);
}

// Added by email on a site whose directory this account cannot search: real
// people, but not yet tied to a Jira account, so they cannot match issues.
export function pendingMembers() {
  return allMembers().filter((m) => !m.accountId);
}

export function hasRoster() {
  return allMembers().length > 0;
}

export function memberFor(accountId) {
  if (!accountId) return null;
  return allMembers().find((m) => m.accountId === accountId) || null;
}

export function isOnTeam(accountId) {
  const member = memberFor(accountId);
  return Boolean(member && member.active);
}

export async function saveMembers(members) {
  const team = activeTeam();
  team.members = dedupeMembers(members.map(normalizeMember));
  return saveTeam(TEAMS);
}

export function upsertMember(members, incoming) {
  return dedupeMembers([...members, normalizeMember(incoming)].map(normalizeMember));
}

export function removeMember(members, member) {
  return members.filter((m) =>
    member.accountId ? m.accountId !== member.accountId : m.email !== member.email
  );
}

// A harvest can supply the accountId a manually-added email was missing.
export function linkPendingMembers(members, harvested) {
  const byEmail = new Map(
    harvested
      .filter((h) => h.email && h.accountId)
      .map((h) => [h.email.toLowerCase(), h])
  );
  let linked = 0;
  const next = members.map((member) => {
    if (member.accountId || !member.email) return member;
    const match = byEmail.get(member.email.toLowerCase());
    if (!match) return member;
    linked++;
    return {
      ...member,
      accountId: match.accountId,
      jiraName: member.jiraName || match.displayName || "",
      avatarUrl: member.avatarUrl || match.avatarUrl || "",
    };
  });
  return { members: next, linked };
}

// "Firstname Lastname" from whatever Jira reports, dropping middle names.
export function shortenName(name) {
  if (!name) return "—";
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0];
}

// What to show for a person: roster override first, then the Jira name.
export function displayNameFor(assignee) {
  if (!assignee) return "Unassigned";
  const member = memberFor(assignee.accountId);
  const base = member?.nameOverride || shortenName(assignee.displayName || member?.jiraName);
  return member?.emoji ? `${member.emoji} ${base}` : base;
}

export function memberLabel(member) {
  // shortenName() returns an em dash for empty input, which would swallow the
  // email fallback — so only consult it when there is a name to shorten.
  const base =
    member.nameOverride ||
    (member.jiraName ? shortenName(member.jiraName) : "") ||
    member.email ||
    "Unnamed";
  return member.emoji ? `${member.emoji} ${base}` : base;
}

export function avatarOverrideFor(accountId) {
  return memberFor(accountId)?.avatarUrl || null;
}

// ── "Team only" view preference ──────────────────────────────────────────────

let teamOnly = false;

export function isTeamOnly() {
  return teamOnly;
}

export async function loadTeamOnly() {
  const stored = await localGet([TEAM_ONLY_KEY]);
  teamOnly = Boolean(stored[TEAM_ONLY_KEY]);
  return teamOnly;
}

export async function setTeamOnly(value) {
  teamOnly = Boolean(value);
  await localSet({ [TEAM_ONLY_KEY]: teamOnly });
  return teamOnly;
}

// Hides work assigned to people outside the roster. Unassigned issues stay
// visible on purpose: they are usually the team's problem too, and hiding them
// would make the monitoring checks lie.
export function isOutsideTeam(issue) {
  const accountId = issue?.fields?.assignee?.accountId;
  if (!accountId) return false;
  return !isOnTeam(accountId);
}
