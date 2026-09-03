import { BOARDS, cache } from "./utils.js";
import { compactChangelogs } from "./activity.js";
import {
  FIELD_ROLES,
  detailIssueFields,
  fieldIds,
  fieldLabel,
  fieldValue,
  issueFields,
  jiraUrl,
  writeFieldId,
} from "./config.js";

function authHeader(email, token) {
  return "Basic " + btoa(`${email}:${token}`);
}

async function jiraFetch(path, creds, params = {}) {
  const url = new URL(jiraUrl(path));
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return jiraFetchUrl(url, creds);
}

async function jiraFetchUrl(url, creds) {
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

// Every mutating request goes through here, so there is exactly one place that
// knows how Jira reports a refused write.
//
// Which matters because Jira refuses writes in a specific and useful way: a 400
// carries `errors`, a map of field id -> what is wrong with that field, and
// `errorMessages` for anything not attributable to one field. Printing the raw
// body loses that structure, and a write layer that says "Jira API 400" when
// Jira said "customfield_10016: Story Points must be a number" has thrown away
// the only sentence worth showing anyone.
//
// `body` is optional rather than defaulted, because DELETE has none: Jira's
// issue-link removal carries the id in the path, and sending a JSON body with a
// Content-Type on a DELETE is the kind of request intermediaries are entitled to
// reject. A missing body means no body and no content type, not an empty object.
async function jiraWrite(method, path, creds, body) {
  const url = new URL(jiraUrl(path));
  const headers = {
    Authorization: authHeader(creds.email, creds.token),
    Accept: "application/json",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url.toString(), init);
  if (resp.status === 401) {
    document.dispatchEvent(new CustomEvent("jira-auth-error"));
    throw new Error("401 Unauthorized");
  }
  const text = resp.ok ? await resp.text() : await resp.text().catch(() => "");
  if (!resp.ok) throw writeFailure(resp.status, text, url.pathname);
  // Transitions and field updates answer 204 with no body; comments and issue
  // creation answer 201 with one.
  return text ? JSON.parse(text) : null;
}

async function jiraPost(path, creds, body = {}) {
  return jiraWrite("POST", path, creds, body);
}

async function jiraPut(path, creds, body = {}) {
  return jiraWrite("PUT", path, creds, body);
}

async function jiraDelete(path, creds) {
  return jiraWrite("DELETE", path, creds);
}

// A refused write, with the attribution kept rather than flattened into a
// string. `fieldErrors` is field id -> message straight from Jira; `message` is
// the sentence to show, with ids translated to the names the site uses for them.
export class JiraWriteError extends Error {
  constructor({ status, path, messages = [], fieldErrors = {} }) {
    const named = Object.entries(fieldErrors).map(
      ([id, msg]) => `${fieldLabel(id)}: ${msg}`
    );
    const parts = [...named, ...messages];
    super(parts.length ? parts.join("; ") : `Jira API ${status}: ${path}`);
    this.name = "JiraWriteError";
    this.status = status;
    this.path = path;
    this.messages = messages;
    this.fieldErrors = fieldErrors;
  }

  // The field ids Jira objected to, for a form that wants to mark its rows.
  get fields() {
    return Object.keys(this.fieldErrors);
  }

  // 403 is the one a caller may want to act on differently: the write was
  // understood and refused, which on a write endpoint usually means a missing
  // token scope or Jira permission rather than anything about the values sent.
  get isPermission() {
    return this.status === 403 || this.status === 404;
  }
}

function writeFailure(status, text, path) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const messages = Array.isArray(payload?.errorMessages)
    ? payload.errorMessages.filter(Boolean).map(String)
    : [];
  const fieldErrors =
    payload?.errors && typeof payload.errors === "object"
      ? Object.fromEntries(
          Object.entries(payload.errors).map(([k, v]) => [k, String(v)])
        )
      : {};

  // Nothing parseable, so fall back to the body itself — truncated, because a
  // Jira error page can be a whole HTML document.
  if (!messages.length && !Object.keys(fieldErrors).length && text) {
    messages.push(text.slice(0, 200));
  }
  // The one status Jira reliably sends with an empty body. Say what it means
  // for a write rather than leaving a bare number.
  if (!messages.length && !Object.keys(fieldErrors).length && status === 403) {
    messages.push(
      "Jira refused the write — the account lacks permission on this issue, " +
        "or the API token is scoped without write:jira-work"
    );
  }
  return new JiraWriteError({ status, path, messages, fieldErrors });
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

// `expand=changelog` rides the request rather than adding one. Per-person Jira
// activity — who moved which ticket, who picked work up — is derived from issue
// history, and this is the call that already fetches these issues, so the
// feature costs no extra round trip.
//
// `compactChangelogs` runs before `cached()` stores anything, which is the part
// that matters: sprint issues go into device-local storage on a 5-minute TTL,
// and Jira's raw history is a nested record per entry with author objects and
// avatar URL sets. Reduced to five fields per event it is a fraction of the
// payload, and nothing downstream ever sees the wide shape.
const HISTORY_EXPAND = "changelog";

export async function getSprintIssues(boardId, sprintId, creds) {
  return cached(`cache_sprintIssues_${boardId}_${sprintId}`, async () => {
    const issues = await fetchAllPages(
      `/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue`,
      creds,
      { fields: issueFields().join(","), expand: HISTORY_EXPAND }
    );
    return tagged(compactChangelogs(issues), boardId);
  });
}

// Deliberately *without* the history expand, unlike the sprint call above. The
// backlog is what has not been started, and every consumer of per-person
// activity asks about a sprint — so an expand here would add a compacted history
// to every backlog issue in the 5-minute cache for nothing to read. Cheap to
// turn on the day a screen wants it.
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

// Epic key -> the label to show for it: Jira's own "Epic Name" where the site
// has one, else the epic's summary.
//
// Deliberately not getAllEpics(): that clears the entire response cache as its
// first act, which is the Gantt view's refresh gesture and has no business
// firing because the Backlog wants to print a name. This asks for two fields
// and caches like everything else, so the column costs one request every five
// minutes.
export async function getEpicNames(creds) {
  return cached("cache_epicNames", async () => {
    const projectKeys = BOARDS.map((b) => b.projectKey || b.name).filter(Boolean);
    if (!projectKeys.length) return {};

    const epics = await searchAllPages(
      creds,
      `issuetype = Epic AND project in (${projectKeys.join(",")})`,
      ["summary", ...fieldIds("epicName")]
    );

    const names = {};
    for (const epic of epics) {
      // Trimmed before the fallback decision: a whitespace-only Epic Name is a
      // real thing on old boards, and it should read as absent, not as blank.
      const short = String(fieldValue(epic, "epicName") || "").trim();
      names[epic.key] = short || String(epic.fields?.summary || "").trim();
    }
    return names;
  });
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

// Raw JQL, for the command palette's escape hatch. Capped rather than paged:
// this backs a type-as-you-go list, and nobody reads past the first screenful.
export async function searchIssuesByJql(jql, creds, maxResults = 50) {
  const data = await jiraPost("/rest/api/3/search/jql", creds, {
    jql,
    fields: issueFields(),
    maxResults,
  });
  return tagByProject(data?.issues || []);
}

// The current state of a named set of issues, in as few requests as possible.
//
// Written for the sprint freeze's "pulled out — and where to": an issue that
// left the sprint is by definition not in any list this app already fetched, so
// its whereabouts have to be asked for. One JQL over up to fifty keys rather
// than a request per issue, which is the cost the whole freeze design exists to
// avoid — a diff that needed sixty requests to render would never be opened
// twice.
//
// Keys Jira does not answer for are simply absent from the result, which is the
// useful answer: the issue was deleted, or the account can no longer see it.
const KEY_LOOKUP_LIMIT = 50;

export async function getIssuesByKeys(issueKeys, creds) {
  const keys = [...new Set((issueKeys || []).map(String).filter(Boolean))];
  const found = [];
  for (let i = 0; i < keys.length; i += KEY_LOOKUP_LIMIT) {
    const batch = keys.slice(i, i + KEY_LOOKUP_LIMIT);
    const jql = `key in (${batch.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(",")})`;
    const data = await jiraPost("/rest/api/3/search/jql", creds, {
      jql,
      fields: issueFields(),
      maxResults: KEY_LOOKUP_LIMIT,
    });
    found.push(...tagByProject(data?.issues || []));
  }
  return found;
}

// JQL results aren't scoped to a board, so board colour and name are resolved
// from the project key the same way getAllEpics does it.
function tagByProject(issues) {
  for (const issue of issues) {
    const projectKey = String(issue.key || "").split("-")[0];
    const board = BOARDS.find((b) => (b.projectKey || b.name) === projectKey);
    if (board) {
      issue.boardId = board.id;
      issue.boardName = board.name;
    }
  }
  return issues;
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

// ── Single issue ─────────────────────────────────────────────────────────────

// Deliberately uncached: the detail view is opened on demand and must reflect
// what Jira has now, especially right after posting a comment.
export async function getIssue(issueKey, creds) {
  const url = new URL(jiraUrl(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`));
  url.searchParams.set("fields", detailIssueFields().join(","));
  // renderedFields gives description as HTML, so we don't hand-render Atlassian
  // Document Format. It still goes through the sanitiser before insertion.
  url.searchParams.set("expand", "renderedFields");
  return jiraFetchUrl(url, creds);
}

export async function getIssueComments(issueKey, creds) {
  const all = [];
  let startAt = 0;
  while (true) {
    const url = new URL(
      jiraUrl(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`)
    );
    url.searchParams.set("startAt", startAt);
    url.searchParams.set("maxResults", 100);
    url.searchParams.set("orderBy", "created");
    url.searchParams.set("expand", "renderedBody");
    const data = await jiraFetchUrl(url, creds);
    const items = data.comments || [];
    all.push(...items);
    const total = data.total ?? all.length;
    startAt += items.length;
    if (startAt >= total || items.length === 0) break;
  }
  return all;
}

// First write path in the app. Jira's v3 API takes Atlassian Document Format
// rather than plain text, so the caller passes text and adf.js converts it.
export async function addIssueComment(issueKey, adfBody, creds) {
  return jiraPost(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    creds,
    { body: adfBody }
  );
}

// ── Transitions ─────────────────────────────────────────────────────────────

// Jira does not let you write `status` directly: an issue moves through named
// workflow transitions, and which ones exist depends on the issue's current
// status, its project's workflow, and the caller's permissions. So the list has
// to be read per issue at the moment of the move — it is never cached.
export async function getIssueTransitions(issueKey, creds) {
  const data = await jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    creds
  );
  return (data.transitions || []).map((t) => ({
    id: t.id,
    name: t.name || "",
    // The full status object, so callers can drop it straight into the issue
    // and keep statusCategory (which drives badge colour) intact.
    to: t.to || null,
    toStatus: t.to?.name || "",
  }));
}

export async function transitionIssue(issueKey, transitionId, creds) {
  await jiraPost(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    creds,
    { transition: { id: String(transitionId) } }
  );
}

// ── Field writes ────────────────────────────────────────────────────────────

// Everything above this line reads Jira; from here down the app changes it.
//
// One request per edit, carrying every changed field together, because Jira
// validates the whole `fields` object before applying any of it: a rejected
// edit leaves the issue exactly as it was, so the optimistic paint has one
// outcome to roll back rather than a half-applied set. That is worth more than
// saving a round trip.
//
// Two consequences of Jira's own rules, both of which surface as attributed
// errors rather than as surprises:
//
//   - A field has to be on the project's Edit screen to be writable. When it is
//     not, Jira says so per field ("cannot be set… not on the appropriate
//     screen"), and that message reaches the user unchanged, because the fix is
//     in Jira's project config and naming the field is the whole of the help we
//     can give.
//   - A scoped API token needs `write:jira-work` (or granular `write:issue:jira`)
//     on top of the read scopes. An unscoped token inherits the account's own
//     Jira permissions and needs nothing added. Both refusals arrive as a 403,
//     which `JiraWriteError.isPermission` marks.

// The domain names this layer accepts, mapped onto whatever field ids the site
// turned out to use. Kept pure and exported so the mapping is tested without a
// network: a story-points write going to the wrong custom field is exactly the
// bug that would be invisible until someone noticed their estimates vanishing.
//
// `null` is a value here, not an absence — it is how a field is cleared — so
// the caller's key set decides what gets written, never the values.
// `issue` is optional and only affects which candidate field a role writes to —
// see `writeFieldId`. Passing it is what keeps the write and the optimistic
// paint pointed at the same field.
export function fieldWritePayload(changes = {}, { issue = null } = {}) {
  const fields = {};
  const unmapped = [];

  for (const [name, value] of Object.entries(changes)) {
    switch (name) {
      case "summary":
        fields.summary = String(value ?? "");
        break;
      // Jira's own id for the due date is lowercase and one word; it is not a
      // custom field on any site, so it needs no discovery.
      case "dueDate":
        fields.duedate = emptyish(value) ? null : String(value);
        break;
      // Tolerant of a whole person object as well as a bare id: the callers that
      // paint an avatar hold the object, and `String({})` would put
      // "[object Object]" in an accountId, which Jira accepts the shape of and
      // then quietly fails to match to anyone.
      case "assignee": {
        const accountId =
          value && typeof value === "object" ? value.accountId ?? null : value;
        fields.assignee = emptyish(accountId) ? null : { accountId: String(accountId) };
        break;
      }
      case "storyPoints": {
        const id = writeFieldId("storyPoints", issue);
        if (!id) {
          unmapped.push("storyPoints");
          break;
        }
        fields[id] = emptyish(value) ? null : Number(value);
        break;
      }
      default:
        unmapped.push(name);
    }
  }

  return { fields, unmapped };
}

function emptyish(value) {
  return value === null || value === undefined || value === "";
}

// Writes the given fields and nothing else. Resolves to the set of Jira field
// ids that were sent, so a caller can say what it changed.
export async function updateIssueFields(issueKey, changes, creds, { issue = null } = {}) {
  const { fields, unmapped } = fieldWritePayload(changes, { issue });

  // Refusing here rather than sending a partial edit: a site where story points
  // were never discovered would otherwise take the rest of the change and drop
  // the estimate silently, which is the failure mode this milestone exists to
  // avoid.
  if (unmapped.length) {
    throw new JiraWriteError({
      status: 0,
      path: `/rest/api/3/issue/${issueKey}`,
      messages: [
        `This Jira site has no field configured for ${unmapped
          .map((name) => FIELD_ROLES[name]?.label || name)
          .join(", ")} — set it in Settings → Fields before editing it here`,
      ],
    });
  }
  if (!Object.keys(fields).length) return [];

  await jiraPut(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, creds, {
    fields,
  });
  return Object.keys(fields);
}

// ── Creating issues ─────────────────────────────────────────────────────────

// The form is generated from these two calls rather than written, because which
// fields a new issue *must* have is a per-project, per-issue-type question with
// a different answer on every Jira site. A hand-written form is a guaranteed 400
// on somebody else's instance — the class of assumption M1 spent a milestone
// removing — so the app asks Jira what the form is.
//
// Cached like any other read: opening the create modal twice in five minutes
// should not re-read a project's field layout, which changes about as often as
// the project does.

export async function getCreateIssueTypes(projectKey, creds) {
  return cached(`cache_createTypes_${projectKey}`, async () => {
    const types = await fetchAllPages(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      creds,
      {},
      "issueTypes"
    );
    return types.map((t) => ({
      id: String(t.id),
      name: t.name || "",
      description: t.description || "",
      iconUrl: t.iconUrl || "",
      // The flag that identifies a sub-task type. Never the name: "Sub-task",
      // "Subtask" and its translations are all in the field, and matching on
      // the string would break the same promise a hardcoded field id does.
      subtask: t.subtask === true,
      hierarchyLevel: Number.isFinite(t.hierarchyLevel) ? t.hierarchyLevel : null,
    }));
  });
}

// The field layout for one issue type in one project.
//
// Two response shapes are accepted deliberately. Current Jira Cloud answers
// with `fields` as an array of descriptors; the older createmeta (and Data
// Center) answers with a map keyed by field id. Normalising both here means the
// form builder sees one shape and the difference never reaches it.
export async function getCreateFields(projectKey, issueTypeId, creds) {
  return cached(`cache_createFields_${projectKey}_${issueTypeId}`, async () => {
    const path = `/rest/api/3/issue/createmeta/${encodeURIComponent(
      projectKey
    )}/issuetypes/${encodeURIComponent(issueTypeId)}`;
    const first = await jiraFetch(path, creds, { startAt: 0, maxResults: 100 });
    const collected = normalizeCreateFields(first);

    // Only the array shape pages; the map shape arrives whole.
    if (Array.isArray(first?.fields)) {
      const total = first.total ?? collected.length;
      let startAt = collected.length;
      while (startAt < total) {
        const page = await jiraFetch(path, creds, { startAt, maxResults: 100 });
        const more = normalizeCreateFields(page);
        if (!more.length) break;
        collected.push(...more);
        startAt += more.length;
      }
    }
    return collected;
  });
}

function normalizeCreateFields(payload) {
  const fields = payload?.fields;
  if (Array.isArray(fields)) {
    return fields.map((f) => ({ ...f, fieldId: f.fieldId || f.key || f.id }));
  }
  if (fields && typeof fields === "object") {
    return Object.entries(fields).map(([id, f]) => ({ ...f, fieldId: f.fieldId || f.key || id }));
  }
  return [];
}

// Answers 201 with the new issue's id, key and self link. The caller re-reads
// the issue rather than trusting the form's own values, the same way a posted
// comment is rendered from Jira's response.
export async function createIssue(fields, creds) {
  return jiraPost("/rest/api/3/issue", creds, { fields });
}

// ── Issue links ─────────────────────────────────────────────────────────────

// Which relationships this site actually has, read rather than assumed.
//
// Link types are instance configuration: a site can rename "Blocks", add its
// own, or delete the ones a hardcoded list would have offered — and a picker
// built on names this file invented would offer relationships that 400 on
// creation. Same discipline as `customfield_*` discovery and as reading the
// sub-task type off `subtask: true` rather than matching "Sub-task", both of
// which exist because a hardcoded assumption broke on a real site.
//
// Cached like createmeta, and for the same reason: the set changes about as
// often as a project does, and opening the picker twice in five minutes should
// not re-read it.
export async function getIssueLinkTypes(creds) {
  return cached("cache_issueLinkTypes", async () => {
    const data = await jiraFetch("/rest/api/3/issueLinkType", creds);
    return (data?.issueLinkTypes || [])
      .map((t) => ({
        id: String(t.id ?? ""),
        name: t.name || "",
        inward: t.inward || "",
        outward: t.outward || "",
      }))
      // A type with no name cannot be posted — the create endpoint takes the
      // name, not the id — so it is not offered.
      .filter((t) => t.name);
  });
}

// `link` is the whole body: `{ type: { name }, inwardIssue, outwardIssue }`.
// Which key goes on which side is the direction, and getting it backwards is
// silent — see `linkPayloadFor` in js/issue-link.js, where that decision lives
// and is tested.
//
// Answers 201 with an empty body, so there is nothing to render from: the
// caller re-reads the issue instead. That is stricter than the comment path
// rather than looser — a link involves a second issue whose state this app does
// not own, and Jira is the only thing that knows the new link's id.
export async function createIssueLink(link, creds) {
  return jiraPost("/rest/api/3/issueLink", creds, link);
}

// The app's first DELETE. The helper is not new — every mutating request has
// gone through `jiraWrite` since M8, so a refusal here is attributed the same
// way a refused field edit is — but the method is, which is why `jiraWrite`
// learned to send no body at all.
//
// Jira offers no undo for this, so the confirm is not optional: see
// `js/components/issue-detail.js`, which names both issues and the relationship
// before calling it.
export async function deleteIssueLink(linkId, creds) {
  return jiraDelete(`/rest/api/3/issueLink/${encodeURIComponent(linkId)}`, creds);
}

// ── Sprint membership ───────────────────────────────────────────────────────

// Sprint is the one field on the M8 list that does not go through the issue PUT.
//
// The Sprint custom field is read-only through `PUT /rest/api/3/issue/{key}` on
// team-managed projects and needs to be on the Edit screen on company-managed
// ones, so writing it that way works on some sites and fails on others — the
// class of difference M1 spent a milestone removing. The agile endpoint is the
// documented move, works on both project types, and takes up to 50 issues per
// call, which is also what a planner's batch push wants.
const SPRINT_MOVE_LIMIT = 50;

export async function moveIssuesToSprint(sprintId, issueKeys, creds) {
  await inBatches(issueKeys, (batch) =>
    jiraPost(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, creds, {
      issues: batch,
    })
  );
}

// The other direction: out of every sprint, back to the backlog. Jira has no
// "clear the sprint field" write, so this is how an issue leaves one.
export async function moveIssuesToBacklog(issueKeys, creds) {
  await inBatches(issueKeys, (batch) =>
    jiraPost("/rest/agile/1.0/backlog/issue", creds, { issues: batch })
  );
}

// Sequential rather than parallel, deliberately. These are writes: a partial
// failure should stop at the first refusal with the earlier batches applied and
// the rest untouched, instead of firing every batch and leaving the caller to
// work out which ones landed.
async function inBatches(issueKeys, run) {
  const keys = [...new Set((issueKeys || []).map(String).filter(Boolean))];
  for (let i = 0; i < keys.length; i += SPRINT_MOVE_LIMIT) {
    await run(keys.slice(i, i + SPRINT_MOVE_LIMIT));
  }
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

// Everyone currently carrying work on the given boards. Needs no extra
// permission, which is why it is the default way to build a roster — but it
// only finds people with an assigned issue right now.
//
// The board list is a parameter rather than the module-level BOARDS because the
// Settings page never populates that array, and because boards staged there but
// not yet saved should still be harvested.
export async function harvestTeamCandidates(creds, boards = BOARDS) {
  const perBoard = await Promise.all(
    boards.map(async (board) => {
      const sprints = await getActiveSprint(board.id, creds);
      const [sprintIssues, backlog] = await Promise.all([
        Promise.all(sprints.map((s) => getSprintIssues(board.id, s.id, creds))),
        getBoardBacklog(board.id, creds),
      ]);
      return [...sprintIssues.flat(), ...backlog];
    })
  );

  const byAccount = new Map();
  for (const issue of perBoard.flat()) {
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
