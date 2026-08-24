#!/usr/bin/env node
// Unit checks for issue creation (M8b/M8c): deriving a form from Jira's
// createmeta, shaping the filled form into a create payload, and the two
// response shapes createmeta comes in.
//
// This is the milestone's highest-risk code and none of it is visible until it
// fails: a field sent in the wrong shape is a 400 on somebody else's Jira, and
// a required field dropped from the form is a 400 on theirs and not on ours.
// So every control's payload shape is asserted here rather than discovered in
// the field.
//
// Usage: node scripts/test-create.mjs

let sync = {};
let local = {};
const pick = (store, keys) =>
  Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  );

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: {
    sync: {
      get: (keys) => Promise.resolve(keys == null ? { ...sync } : pick(sync, keys)),
      set: (obj) => { Object.assign(sync, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete sync[k]; return Promise.resolve(); },
    },
    local: {
      get: (keys) => Promise.resolve(keys == null ? { ...local } : pick(local, keys)),
      set: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
      remove: (keys) => { for (const k of [].concat(keys)) delete local[k]; return Promise.resolve(); },
    },
  },
};

let requests = [];
let responses = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({
    url: String(url),
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });
  const scripted = responses.length ? responses.shift() : { status: 200, body: {} };
  const text = typeof scripted.body === "string" ? scripted.body : JSON.stringify(scripted.body ?? "");
  return {
    ok: scripted.status >= 200 && scripted.status < 300,
    status: scripted.status,
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : null),
  };
};
globalThis.document = { dispatchEvent: () => true };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["customfield_10016"], sprint: ["customfield_10020"] },
  boards: [{ id: 1, name: "ABC", projectKey: "ABC", color: "#111111" }],
};
local = { schemaVersion: 2 };

const cfg = await import(new URL("../js/config.js", import.meta.url));
const api = await import(new URL("../js/api.js", import.meta.url));
const create = await import(new URL("../js/issue-create.js", import.meta.url));
await cfg.loadConfig();

const CREDS = { email: "someone@example.com", token: "test-token" };
const { CONTROLS } = create;
const reset = () => { requests = []; responses = []; local = { schemaVersion: 2 }; };

// A descriptor in the shape createmeta returns them.
const field = (fieldId, schema, extra = {}) => ({
  fieldId,
  name: extra.name || fieldId,
  required: extra.required === true,
  schema,
  ...(extra.allowedValues ? { allowedValues: extra.allowedValues } : {}),
  ...(extra.hasDefaultValue ? { hasDefaultValue: true, defaultValue: extra.defaultValue } : {}),
});
const controlOf = (fieldId, schema, extra = {}) => {
  const { rows, unsupported, omitted } = create.formSpecFrom([field(fieldId, schema, extra)]);
  return rows[0]?.control || (unsupported.length ? "required-unsupported" : omitted.length ? "omitted" : "none");
};

// ── Deriving the form ───────────────────────────────────────────────────────

section("a control per field type");
check("summary is a text field", controlOf("summary", { type: "string", system: "summary" }) === CONTROLS.TEXT);
check("description is rich text", controlOf("description", { type: "string", system: "description" }) === CONTROLS.TEXTAREA);
check("a custom textarea is rich text too",
  controlOf("customfield_1", { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" }) === CONTROLS.TEXTAREA);
check("a plain custom text field is not",
  controlOf("customfield_2", { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" }) === CONTROLS.TEXT);
check("a number field is a number", controlOf("customfield_10016", { type: "number" }) === CONTROLS.NUMBER);
check("a date field is a date", controlOf("duedate", { type: "date", system: "duedate" }) === CONTROLS.DATE);
check("a datetime field is a datetime", controlOf("customfield_3", { type: "datetime" }) === CONTROLS.DATETIME);
check("a user field is a person picker", controlOf("assignee", { type: "user", system: "assignee" }) === CONTROLS.USER);
check("priority with options is a select",
  controlOf("priority", { type: "priority", system: "priority" }, { allowedValues: [{ id: "3", name: "Medium" }] }) === CONTROLS.SELECT);
check("labels is its own control", controlOf("labels", { type: "array", items: "string", system: "labels" }) === CONTROLS.LABELS);
check("a multi-option field is a multi-select",
  controlOf("components", { type: "array", items: "component", system: "components" },
    { allowedValues: [{ id: "9", name: "api" }] }) === CONTROLS.MULTISELECT);
check("a multi-user field is a multi-select",
  controlOf("customfield_4", { type: "array", items: "user" }) === CONTROLS.USERS);
check("an issue link field takes a key",
  controlOf("parent", { type: "issuelink", system: "parent" }) === CONTROLS.ISSUE_KEY);
check("the agile sprint field is recognised by its custom type, not its name",
  controlOf("customfield_10020", { type: "array", items: "string", custom: "com.pyxis.greenhopper.jira:gh-sprint" }) === CONTROLS.SPRINT);
check("the epic link field likewise",
  controlOf("customfield_10014", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" }) === CONTROLS.EPIC);
check("a select with no options at all is not offered",
  controlOf("customfield_5", { type: "option" }, { required: true }) === "required-unsupported");

section("what the form refuses to guess at");
check("a required field of an unknown type stops the form",
  controlOf("customfield_6", { type: "sd-servicelevelagreement" }, { required: true }) === "required-unsupported");
check("the same field optional is quietly left out",
  controlOf("customfield_6", { type: "sd-servicelevelagreement" }) === "omitted");
check("a required free-for-all field is not guessed at",
  controlOf("customfield_7", { type: "any" }, { required: true }) === "required-unsupported");
check("an optional one is treated as text",
  controlOf("customfield_7", { type: "any" }) === CONTROLS.TEXT);

section("the form's shape");
let spec = create.formSpecFrom([
  field("project", { type: "project", system: "project" }, { required: true }),
  field("issuetype", { type: "issuetype", system: "issuetype" }, { required: true }),
  field("customfield_8", { type: "string" }, { name: "Team" }),
  field("summary", { type: "string", system: "summary" }, { required: true }),
  field("description", { type: "string", system: "description" }),
  field("customfield_9", { type: "string" }, { name: "Acceptance", required: true }),
]);
check("the two the modal owns are not rows",
  !spec.rows.some((r) => r.id === "project" || r.id === "issuetype"));
check("summary comes first whatever order Jira listed", spec.rows[0].id === "summary");
check("description follows it", spec.rows[1].id === "description");
check("a required custom field outranks an optional one",
  spec.rows.findIndex((r) => r.id === "customfield_9") <
  spec.rows.findIndex((r) => r.id === "customfield_8"));
check("required is carried through", spec.rows[0].required === true);
check("the site's own name for a field is the label",
  spec.rows.find((r) => r.id === "customfield_8").label === "Team");

section("option labels");
spec = create.formSpecFrom([
  field("priority", { type: "priority" }, { allowedValues: [
    { id: "1", name: "Highest" },
    { id: "2", value: "High" },
    { id: "3", label: "Medium" },
  ] }),
]);
check("Jira's three ways of labelling an option are all read",
  spec.rows[0].options.map((o) => o.name).join() === "Highest,High,Medium");
check("the id is what gets sent", spec.rows[0].options[0].id === "1");

section("Jira's own defaults prefill the form");
spec = create.formSpecFrom([
  field("priority", { type: "priority" }, { allowedValues: [{ id: "3", name: "Medium" }], hasDefaultValue: true, defaultValue: { id: "3" } }),
  field("customfield_11", { type: "number" }, { hasDefaultValue: true, defaultValue: 5 }),
  field("summary", { type: "string", system: "summary" }),
]);
let values = create.initialValues(spec.rows);
check("a default option is preselected by id", values.priority === "3");
check("a default number is prefilled", values.customfield_11 === 5);
check("a field with no default is left alone", !("summary" in values));

section("required fields are counted before posting");
spec = create.formSpecFrom([
  field("summary", { type: "string", system: "summary" }, { required: true }),
  field("components", { type: "array", items: "component" }, { required: true, allowedValues: [{ id: "9", name: "api" }] }),
]);
check("nothing filled in is two missing", create.missingRequired(spec.rows, {}).length === 2);
check("whitespace is not an answer",
  create.missingRequired(spec.rows, { summary: "   ", components: ["9"] }).length === 1);
check("an empty list is not an answer",
  create.missingRequired(spec.rows, { summary: "x", components: [] }).length === 1);
check("both filled in is none",
  create.missingRequired(spec.rows, { summary: "x", components: ["9"] }).length === 0);

// ── The payload ─────────────────────────────────────────────────────────────

section("the payload Jira receives");
spec = create.formSpecFrom([
  field("summary", { type: "string", system: "summary" }),
  field("description", { type: "string", system: "description" }),
  field("assignee", { type: "user", system: "assignee" }),
  field("priority", { type: "priority" }, { allowedValues: [{ id: "3", name: "Medium" }] }),
  field("duedate", { type: "date", system: "duedate" }),
  field("labels", { type: "array", items: "string", system: "labels" }),
  field("components", { type: "array", items: "component" }, { allowedValues: [{ id: "9", name: "api" }] }),
  field("customfield_10016", { type: "number" }, { name: "Story Points" }),
  field("customfield_10020", { type: "array", items: "string", custom: "com.pyxis.greenhopper.jira:gh-sprint" }),
  field("customfield_10014", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" }),
]);
let payload = create.buildCreatePayload({
  rows: spec.rows,
  projectKey: "ABC",
  issueTypeId: "10001",
  values: {
    summary: "Do the thing",
    description: "First line\n\nSecond paragraph",
    assignee: "acc-9",
    priority: "3",
    duedate: "2026-09-01",
    labels: "one, two three",
    components: ["9"],
    customfield_10016: "5",
    customfield_10020: "77",
    customfield_10014: "abc-4",
  },
});
check("the project is sent as a key", payload.project.key === "ABC");
check("the issue type is sent as an id", payload.issuetype.id === "10001");
check("a text field is sent as a string", payload.summary === "Do the thing");
check("rich text is sent as a document", payload.description.type === "doc");
check("its paragraphs survive the conversion", payload.description.content.length === 2);
check("a user is sent as an account id", payload.assignee.accountId === "acc-9");
check("an option is sent as an id, not its label", payload.priority.id === "3");
check("a date is sent as the ISO day", payload.duedate === "2026-09-01");
check("labels are split on commas", payload.labels.length === 2);
check("a label with a space in it is hyphenated, as Jira requires",
  payload.labels[1] === "two-three");
check("a multi-option field is a list of ids", payload.components[0].id === "9");
check("a number arrives as a number, not a string", payload.customfield_10016 === 5);
check("a sprint is its numeric id", payload.customfield_10020 === 77);
check("an epic link is its key, upper-cased", payload.customfield_10014 === "ABC-4");

payload = create.buildCreatePayload({
  rows: spec.rows,
  projectKey: "ABC",
  issueTypeId: "10001",
  values: { summary: "Only this", description: "", labels: [], customfield_10016: "" },
});
check("an unfilled field is left out entirely, not sent as null",
  !("description" in payload) && !("labels" in payload) && !("customfield_10016" in payload));
check("a field with no row at all cannot be smuggled in",
  !("customfield_99" in create.buildCreatePayload({
    rows: spec.rows, values: { customfield_99: "x" }, projectKey: "ABC", issueTypeId: "1",
  })));
check("a number that is not a number is dropped rather than sent as NaN",
  !("customfield_10016" in create.buildCreatePayload({
    rows: spec.rows, values: { customfield_10016: "five" }, projectKey: "ABC", issueTypeId: "1",
  })));

section("a sub-task's parent");
payload = create.buildCreatePayload({
  rows: [], values: {}, projectKey: "ABC", issueTypeId: "10003", parentKey: "ABC-1",
});
check("the parent is sent as a key", payload.parent.key === "ABC-1");
check("no parent means no parent field",
  !("parent" in create.buildCreatePayload({ rows: [], values: {}, projectKey: "ABC", issueTypeId: "1" })));

section("the sub-task type is discovered, never matched by name");
const types = [
  { id: "10001", name: "Story", subtask: false },
  { id: "10003", name: "Deeltaak", subtask: true },
];
check("the flag identifies it whatever it is called",
  create.subtaskTypeFrom(types).id === "10003");
check("a project without one says so", create.subtaskTypeFrom([types[0]]) === null);
check("sub-task types are not offered as top-level issues",
  create.creatableTypes(types).map((t) => t.id).join() === "10001");

// ── The two createmeta shapes ───────────────────────────────────────────────

section("issue types from createmeta");
reset();
responses = [{ status: 200, body: {
  maxResults: 50, startAt: 0, total: 2, isLast: true,
  issueTypes: [
    { id: 10001, name: "Story", subtask: false, hierarchyLevel: 0 },
    { id: 10003, name: "Sub-task", subtask: true, hierarchyLevel: -1 },
  ],
} }];
let readTypes = await api.getCreateIssueTypes("ABC", CREDS);
check("read from the project's own createmeta",
  requests[0].url.startsWith("https://x.atlassian.net/rest/api/3/issue/createmeta/ABC/issuetypes"));
check("ids are strings, as every other id in the app is", readTypes[0].id === "10001");
check("the sub-task flag survives", readTypes[1].subtask === true);
reset();
responses = [{ status: 200, body: { total: 1, isLast: true, issueTypes: [{ id: "1", name: "Task" }] } }];
check("a type with no subtask flag is not treated as one",
  (await api.getCreateIssueTypes("DEF", CREDS))[0].subtask === false);

section("field descriptors, in either shape Jira sends them");
reset();
responses = [{ status: 200, body: {
  total: 2, isLast: true,
  fields: [
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    { fieldId: "customfield_10016", name: "Story Points", required: false, schema: { type: "number" } },
  ],
} }];
let descriptors = await api.getCreateFields("ABC", "10001", CREDS);
check("the array shape is read", descriptors.length === 2 && descriptors[0].fieldId === "summary");

reset();
// The older shape: a map keyed by field id, with the id only in the key.
responses = [{ status: 200, body: {
  fields: {
    summary: { name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    customfield_10016: { name: "Story Points", required: false, schema: { type: "number" } },
  },
} }];
descriptors = await api.getCreateFields("DEF", "10001", CREDS);
check("the map shape is read too", descriptors.length === 2);
check("and the key becomes the field id",
  descriptors.map((d) => d.fieldId).sort().join() === "customfield_10016,summary");
check("either shape feeds the form builder unchanged",
  create.formSpecFrom(descriptors).rows.some((r) => r.id === "summary"));

reset();
responses = [
  { status: 200, body: { total: 3, isLast: false, fields: [{ fieldId: "a", schema: { type: "string" } }, { fieldId: "b", schema: { type: "string" } }] } },
  { status: 200, body: { total: 3, isLast: true, fields: [{ fieldId: "c", schema: { type: "string" } }] } },
];
descriptors = await api.getCreateFields("GHI", "10001", CREDS);
check("a project with more fields than one page returns all of them",
  descriptors.map((d) => d.fieldId).join() === "a,b,c");

section("creating the issue");
reset();
responses = [{ status: 201, body: { id: "10500", key: "ABC-42", self: "https://x/rest/api/3/issue/10500" } }];
const created = await api.createIssue({ project: { key: "ABC" }, summary: "x" }, CREDS);
check("posted to the create endpoint",
  requests[0].method === "POST" && requests[0].url === "https://x.atlassian.net/rest/api/3/issue");
check("the fields are wrapped as Jira expects", requests[0].body.fields.summary === "x");
check("the new key comes back for the caller to open", created.key === "ABC-42");

reset();
responses = [{ status: 400, body: { errors: { customfield_9: "Acceptance criteria is required." } } }];
const err = await api.createIssue({ summary: "x" }, CREDS).catch((e) => e);
check("a refused create is attributed to its field",
  err.fields.join() === "customfield_9" && /Acceptance criteria/.test(err.message));

section("the modules load");
// Cheap, and it has caught a real class of bug: the create panel is reached from
// the issue detail and reaches back into it, so a static import both ways would
// be a cycle. This asserts the graph actually resolves, which no amount of
// static checking of identifiers does.
const panel = await import(new URL("../js/components/issue-create.js", import.meta.url));
check("the create panel resolves its imports", typeof panel.openCreateIssue === "function");

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
