import { BOARDS, cache } from "./utils.js";
import { FIELD_ROLES, issueFields, jiraUrl } from "./config.js";

function authHeader(email, token) {
  return "Basic " + btoa(`${email}:${token}`);
}

async function jiraFetch(path, creds, params = {}) {
  const url = new URL(jiraUrl(path));
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: authHeader(creds.email, creds.token),
      Accept: "application/json",
    },
  });
  if (resp.status === 401) {
    document.dispatchEvent(new CustomEvent("jira-auth-error"));
    throw new Error("401 Unauthorized");
  }
  if (!resp.ok) throw new Error(`Jira API ${resp.status}: ${url.pathname}`);
  return resp.json();
}

async function jiraPost(path, creds, body = {}) {
  const url = new URL(jiraUrl(path));
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: authHeader(creds.email, creds.token),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) {
    document.dispatchEvent(new CustomEvent("jira-auth-error"));
    throw new Error("401 Unauthorized");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Jira API ${resp.status}: ${url.pathname} — ${text.slice(0, 120)}`);
  }
  return resp.json();
}

async function searchAllPages(creds, jql, fields) {
  const all = [];
  let nextPageToken;
  while (true) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraPost("/rest/api/3/search/jql", creds, body);
    const items = data.issues || [];
    all.push(...items);
    nextPageToken = data.nextPageToken;
    if (data.isLast || !nextPageToken || items.length === 0) break;
  }
  return all;
}

async function fetchAllPages(path, creds, params = {}, listKey = "issues") {
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(path, creds, {
      ...params,
      startAt,
      maxResults: 100,
    });
    const items = data[listKey] || data.values || [];
    all.push(...items);
    const total = data.total ?? all.length;
    startAt += items.length;
    if (startAt >= total || items.length === 0) break;
  }
  return all;
}

function tagged(issues, boardId) {
  const name = BOARDS.find((b) => b.id === boardId)?.name ?? "?";
  for (const issue of issues) {
    issue.boardId = boardId;
    issue.boardName = name;
  }
  return issues;
}

async function cached(key, fn) {
  const hit = await cache.get(key);
  if (hit) return hit;
  const result = await fn();
  cache.set(key, result).catch(() => {}); // storage quota errors must not crash callers
  return result;
}

export async function getActiveSprint(boardId, creds) {
  return cached(`cache_activeSprint_${boardId}`, async () => {
    const data = await jiraFetch(
      `/rest/agile/1.0/board/${boardId}/sprint`,
      creds,
      { state: "active" }
    );
    return data.values || [];
  });
}

export async function getEpicChildren(epicKey, creds) {
  return cached(`cache_epicChildren_${epicKey}`, async () => {
    const jql = `"Epic Link" = ${epicKey} OR parent = ${epicKey}`;
    return searchAllPages(creds, jql, issueFields());
  });
}

export async function getSprintIssues(boardId, sprintId, creds) {
  return cached(`cache_sprintIssues_${boardId}_${sprintId}`, async () => {
    const issues = await fetchAllPages(
      `/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue`,
      creds,
      { fields: issueFields().join(",") }
    );
    return tagged(issues, boardId);
  });
}

export async function getBoardBacklog(boardId, creds) {
  return cached(`cache_backlog_${boardId}`, async () => {
    const issues = await fetchAllPages(
      `/rest/agile/1.0/board/${boardId}/backlog`,
      creds,
      { fields: issueFields().join(",") }
    );
    return tagged(issues, boardId);
  });
}

export async function getAllEpics(creds) {
  cache.clear().catch(() => {});

  const projectKeys = BOARDS.map((b) => b.projectKey || b.name).filter(Boolean);
  if (!projectKeys.length) return {};

  const all = await searchAllPages(
    creds,
    `issuetype = Epic AND project in (${projectKeys.join(",")})`,
    issueFields()
  );

  const map = {};
  for (const board of BOARDS) map[board.id] = [];
  for (const issue of all) {
    const pk = issue.key.split("-")[0];
    const board = BOARDS.find((b) => (b.projectKey || b.name) === pk);
    if (board) {
      issue.boardId = board.id;
      issue.boardName = board.name;
      map[board.id].push(issue);
    }
  }
  return map;
}

export async function getAllSprintIssues(creds) {
  const all = [];
  await Promise.all(
    BOARDS.map(async (b) => {
      const sprints = await getActiveSprint(b.id, creds);
      const results = await Promise.all(
        sprints.map((s) => getSprintIssues(b.id, s.id, creds))
      );
      for (const issues of results) all.push(...issues);
    })
  );
  return all;
}

export async function getAllBacklogIssues(creds) {
  const results = await Promise.all(
    BOARDS.map((b) => getBoardBacklog(b.id, creds))
  );
  return results.flat();
}

// ── Setup helpers ───────────────────────────────────────────────────────────

export async function verifyCredentials(creds) {
  return jiraFetch("/rest/api/3/myself", creds);
}

// Every board the account can see, so nobody has to look up numeric board IDs.
export async function listBoards(creds) {
  const values = await fetchAllPages("/rest/agile/1.0/board", creds, {}, "values");
  return values.map((b) => ({
    id: b.id,
    name: b.name,
    projectKey: b.location?.projectKey || "",
    projectName: b.location?.projectName || "",
    type: b.type || "",
  }));
}

// Resolves the field-role -> customfield_NNNNN mapping for this Jira site by
// matching on field name. Instance-specific IDs must never be hardcoded.
export async function discoverFieldMappings(creds) {
  const fields = await jiraFetch("/rest/api/3/field", creds);
  const byName = new Map();
  for (const field of fields) {
    const name = (field.name || "").trim().toLowerCase();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(field.id);
  }

  const mapping = {};
  for (const [role, spec] of Object.entries(FIELD_ROLES)) {
    const ids = [];
    for (const candidate of spec.names) {
      for (const id of byName.get(candidate.toLowerCase()) || []) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    mapping[role] = ids;
  }
  return mapping;
}

// ── People ──────────────────────────────────────────────────────────────────

function toPerson(user) {
  return {
    accountId: user.accountId,
    displayName: user.displayName || "",
    // Jira only returns this when the caller may view email addresses.
    email: user.emailAddress || "",
    avatarUrl: user.avatarUrls?.["24x24"] || user.avatarUrls?.["16x16"] || "",
    active: user.active !== false,
    accountType: user.accountType || "",
  };
}

// Directory search. Requires the "Browse users and groups" global permission —
// plenty of Jira sites restrict it to admins, so callers must handle a 403 by
// falling back to harvest or manual entry.
export async function searchUsers(query, creds) {
  const users = await jiraFetch("/rest/api/3/user/search", creds, {
    query,
    maxResults: 50,
  });
  return users
    .map(toPerson)
    // Drop app/bot/customer accounts — a team roster wants humans.
    .filter((u) => !u.accountType || u.accountType === "atlassian")
    .filter((u) => u.active);
}

// Everyone currently carrying work on the configured boards. Needs no extra
// permission, which is why it is the default way to build a roster — but it
// only finds people with an assigned issue right now.
export async function harvestTeamCandidates(creds) {
  const [sprintIssues, backlogIssues] = await Promise.all([
    getAllSprintIssues(creds),
    getAllBacklogIssues(creds),
  ]);

  const byAccount = new Map();
  for (const issue of [...sprintIssues, ...backlogIssues]) {
    const assignee = issue.fields?.assignee;
    if (!assignee?.accountId) continue;
    const existing = byAccount.get(assignee.accountId);
    if (existing) {
      existing.issueCount++;
      continue;
    }
    byAccount.set(assignee.accountId, { ...toPerson(assignee), issueCount: 1 });
  }

  return [...byAccount.values()].sort(
    (a, b) => b.issueCount - a.issueCount || a.displayName.localeCompare(b.displayName)
  );
}

// All fields on the site, for the manual override dropdowns in Settings.
export async function listFields(creds) {
  const fields = await jiraFetch("/rest/api/3/field", creds);
  return fields
    .map((f) => ({ id: f.id, name: f.name || f.id, custom: Boolean(f.custom) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Credential storage moved to js/credentials.js (device-local). Re-exported so
// existing callers keep working through one import.
export { getCredentials } from "./credentials.js";
