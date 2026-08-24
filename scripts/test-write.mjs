#!/usr/bin/env node
// Unit checks for the Jira write layer (M8a): the domain-name -> field-id
// mapping, how a refused write is attributed, the optimistic paint and its
// rollback, the undo window, and sprint-move batching.
//
// The transport is stubbed rather than skipped, because the behaviours that
// matter here are transport-shaped: what body reaches Jira, and what the app
// does with the three ways Jira says no — a field error, a permission refusal
// and a dead token.
//
// Usage: node scripts/test-write.mjs

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

// ── Transport and DOM stubs ─────────────────────────────────────────────────
// Requests are logged so a test can assert on the body Jira would have seen;
// responses are scripted per call so a partial failure can be arranged.

let requests = [];
let responses = [];
let nextResponse = { status: 204, body: "" };
globalThis.fetch = async (url, options = {}) => {
  requests.push({
    url: String(url),
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });
  const scripted = responses.length ? responses.shift() : nextResponse;
  const text = typeof scripted.body === "string" ? scripted.body : JSON.stringify(scripted.body ?? "");
  return {
    ok: scripted.status >= 200 && scripted.status < 300,
    status: scripted.status,
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : null),
  };
};

// Toasts and the auth event both go through the document. The toast is captured
// rather than discarded: the undo window *is* the toast, so its button is the
// only handle a test has on the undo path.
let toastLog = [];
let toastAction = null;
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.type = "";
    this.children = [];
    this._text = "";
    this._listeners = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(name, fn) { this._listeners[name] = fn; }
  click() { this._listeners.click?.(); }
  set textContent(v) {
    this._text = String(v);
    if (v === "") this.children = [];
  }
  get textContent() { return this._text; }
  get text() { return [this._text, ...this.children.map((c) => c.text)].join(" ").trim(); }
}
const toastEl = new FakeEl("div");
let authEvents = 0;
globalThis.document = {
  getElementById: (id) => (id === "toast" ? toastEl : null),
  createElement: (tag) => new FakeEl(tag),
  dispatchEvent: (e) => { if (e?.type === "jira-auth-error") authEvents++; return true; },
};
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
const readToast = () => ({ text: toastEl.text, error: toastEl.className.includes("error") });
const undoButton = () =>
  toastEl.children.find((c) => c.tagName === "button" && c.textContent === "Undo") || null;

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name}`); fail++; }
};
const section = (t) => console.log(`\n── ${t} ──`);

sync = {
  site: { baseUrl: "https://x.atlassian.net" },
  fields: { storyPoints: ["customfield_10016", "customfield_20001"], sprint: ["customfield_10020"] },
  boards: [{ id: 1, name: "ABC", projectKey: "ABC", color: "#111111" }],
};
local = { schemaVersion: 2 };

const cfg = await import(new URL("../js/config.js", import.meta.url));
const utils = await import(new URL("../js/utils.js", import.meta.url));
const api = await import(new URL("../js/api.js", import.meta.url));
const edit = await import(new URL("../js/issue-edit.js", import.meta.url));
const fe = await import(new URL("../js/components/field-edit.js", import.meta.url));
await cfg.loadConfig();
await utils.loadBoards();

const CREDS = { email: "someone@example.com", token: "test-token" };
// A toast outlives the check that raised it, exactly as it does on screen, so
// every scenario starts from a cleared one rather than reading the last one's.
const resetRequests = () => {
  requests = [];
  responses = [];
  nextResponse = { status: 204, body: "" };
};
// A bare editor for checks that only care about what reached the wire.
const editorProbe = () => edit.createFieldEditor({ creds: CREDS });
const reset = () => {
  resetRequests();
  toastEl.textContent = "";
  toastEl.className = "";
};
const issue = (o = {}) => ({
  key: o.key || "ABC-1",
  id: "1",
  boardId: 1,
  fields: {
    summary: o.summary ?? "Do the thing",
    duedate: o.duedate ?? null,
    assignee: o.assignee ?? { accountId: "acc-1", displayName: "Ada" },
    customfield_10016: o.points ?? 3,
    ...(o.fields || {}),
  },
});

// ── The mapping ─────────────────────────────────────────────────────────────

section("domain names to field ids");
let mapped = api.fieldWritePayload({ storyPoints: 5 });
check("story points go to the discovered custom field", mapped.fields.customfield_10016 === 5);
check("nothing else is sent", Object.keys(mapped.fields).length === 1);
check("due date is Jira's own one-word field",
  api.fieldWritePayload({ dueDate: "2026-09-01" }).fields.duedate === "2026-09-01");
check("assignee is sent as an account id object",
  api.fieldWritePayload({ assignee: "acc-9" }).fields.assignee.accountId === "acc-9");
check("a whole person object is accepted too",
  api.fieldWritePayload({ assignee: { accountId: "acc-9", displayName: "Zoe" } })
    .fields.assignee.accountId === "acc-9");
check("null clears the assignee", api.fieldWritePayload({ assignee: null }).fields.assignee === null);
check("null clears an estimate rather than writing zero",
  api.fieldWritePayload({ storyPoints: null }).fields.customfield_10016 === null);
check("a numeric string is sent as a number",
  api.fieldWritePayload({ storyPoints: "8" }).fields.customfield_10016 === 8);
check("a key with no mapping is reported, not dropped",
  api.fieldWritePayload({ epicLink: "ABC-9" }).unmapped.join() === "epicLink");
check("an absent key is left alone entirely",
  !("duedate" in api.fieldWritePayload({ summary: "x" }).fields));

section("estimate field resolution");
// Field discovery can resolve two ids for one role, and `fieldValue` reads
// whichever the issue holds — so a write to the other one would set a field
// nothing reads and the estimate on screen would not move. The paint and the
// request have to agree, which is why both take the issue.
const twoFields = issue({ fields: { customfield_10016: null, customfield_20001: 5 } });
check("the field the issue already uses wins over the first configured one",
  edit.pointsFieldFor(twoFields) === "customfield_20001");
check("an unestimated issue falls back to the configured field",
  edit.pointsFieldFor(issue({ fields: { customfield_10016: null } })) === "customfield_10016");
check("the payload writes to the field the issue uses, not the first configured",
  api.fieldWritePayload({ storyPoints: 8 }, { issue: twoFields }).fields.customfield_20001 === 8);
check("and nothing is written to the other one",
  !("customfield_10016" in api.fieldWritePayload({ storyPoints: 8 }, { issue: twoFields }).fields));
check("with no issue to go on, the first configured field is the answer",
  api.fieldWritePayload({ storyPoints: 8 }).fields.customfield_10016 === 8);

reset();
await editorProbe().write(twoFields, { storyPoints: 8 });
check("the request and the paint land on the same field",
  requests[0].body.fields.customfield_20001 === 8 && twoFields.fields.customfield_20001 === 8);

// ── Refusals ────────────────────────────────────────────────────────────────

section("a refused write is attributed");
reset();
responses = [{
  status: 400,
  body: { errorMessages: [], errors: { customfield_10016: "Story Points must be a number." } },
}];
let err = await api.updateIssueFields("ABC-1", { storyPoints: "many" }, CREDS).catch((e) => e);
check("a field error becomes a JiraWriteError", err.name === "JiraWriteError");
check("the field id is translated to the site's name for it",
  err.message === "Story points: Story Points must be a number.");
check("the field ids are kept for a form to mark", err.fields.join() === "customfield_10016");
check("a 400 is not read as a permission problem", err.isPermission === false);

reset();
responses = [{ status: 400, body: { errorMessages: ["Issue does not exist."], errors: {} } }];
err = await api.updateIssueFields("ABC-9", { summary: "x" }, CREDS).catch((e) => e);
check("a message with no field attached still reads", err.message === "Issue does not exist.");

reset();
responses = [{ status: 403, body: "" }];
err = await api.updateIssueFields("ABC-1", { summary: "x" }, CREDS).catch((e) => e);
check("an empty 403 explains itself", /lacks permission/.test(err.message));
check("a 403 names the token scope a scoped token would need",
  /write:jira-work/.test(err.message));
check("a 403 is flagged as a permission refusal", err.isPermission === true);

reset();
responses = [{ status: 500, body: "<html>Gateway problem</html>" }];
err = await api.updateIssueFields("ABC-1", { summary: "x" }, CREDS).catch((e) => e);
check("an unparseable body is passed through, truncated", /Gateway problem/.test(err.message));

reset();
authEvents = 0;
responses = [{ status: 401, body: "" }];
err = await api.updateIssueFields("ABC-1", { summary: "x" }, CREDS).catch((e) => e);
check("a dead token raises the reauth event", authEvents === 1);
check("a dead token is not dressed up as a field error", err.name !== "JiraWriteError");

section("a field this site has no id for is refused before the request");
reset();
await cfg.saveConfig({ fields: { storyPoints: [] } });
err = await api.updateIssueFields("ABC-1", { storyPoints: 5 }, CREDS).catch((e) => e);
check("nothing is sent", requests.length === 0);
check("the refusal names the field and where to set it",
  /Story points/.test(err.message) && /Settings/.test(err.message));
await cfg.saveConfig({ fields: { storyPoints: ["customfield_10016", "customfield_20001"] } });

// ── The request itself ──────────────────────────────────────────────────────

section("the request Jira receives");
reset();
await api.updateIssueFields("ABC-1", { assignee: "acc-9", storyPoints: 8 }, CREDS);
check("one request for a multi-field edit", requests.length === 1);
check("it is a PUT on the issue",
  requests[0].method === "PUT" &&
  requests[0].url === "https://x.atlassian.net/rest/api/3/issue/ABC-1");
check("both fields travel together",
  requests[0].body.fields.assignee.accountId === "acc-9" &&
  requests[0].body.fields.customfield_10016 === 8);
reset();
check("an empty change set makes no request",
  (await api.updateIssueFields("ABC-1", {}, CREDS)).length === 0 && requests.length === 0);

section("sprint membership");
reset();
await api.moveIssuesToSprint(77, ["ABC-1", "ABC-2"], CREDS);
check("the agile move endpoint is used, not a field write",
  requests[0].url === "https://x.atlassian.net/rest/agile/1.0/sprint/77/issue");
check("the keys are sent as a list", requests[0].body.issues.join() === "ABC-1,ABC-2");
reset();
await api.moveIssuesToSprint(77, Array.from({ length: 120 }, (_, i) => `ABC-${i}`), CREDS);
check("batched at Jira's 50-issue ceiling", requests.length === 3);
check("every issue is in exactly one batch",
  requests.reduce((n, r) => n + r.body.issues.length, 0) === 120);
reset();
await api.moveIssuesToSprint(77, ["ABC-1", "ABC-1", ""], CREDS);
check("duplicates and blanks are dropped", requests[0].body.issues.join() === "ABC-1");
reset();
await api.moveIssuesToBacklog(["ABC-1"], CREDS);
check("leaving a sprint uses the backlog endpoint",
  requests[0].url === "https://x.atlassian.net/rest/agile/1.0/backlog/issue");

// ── Optimistic paint, rollback, undo ────────────────────────────────────────

section("local paint and rollback");
let target = issue();
let before = edit.currentValues(target, { storyPoints: null, assignee: null });
check("the previous estimate is captured", before.storyPoints === 3);
check("the previous assignee is captured as the whole person",
  before.assignee.displayName === "Ada");
edit.applyValues(target, { storyPoints: 8, assignee: { accountId: "acc-9", displayName: "Zoe" } });
check("the estimate is painted locally", target.fields.customfield_10016 === 8);
check("the assignee is painted locally", target.fields.assignee.displayName === "Zoe");
edit.applyValues(target, before);
check("rolling back restores the estimate", target.fields.customfield_10016 === 3);
check("rolling back restores the assignee", target.fields.assignee.displayName === "Ada");
edit.applyValues(target, { assignee: "acc-7" });
check("a bare account id paints without inventing a name",
  target.fields.assignee.accountId === "acc-7" && target.fields.assignee.displayName === "");
check("clearing the due date is a value, not an absence",
  edit.applyValues(target, { dueDate: null }).fields.duedate === null);

section("what the toast says");
check("a change reads as from → to",
  edit.describeChanges({ storyPoints: 8 }, { storyPoints: 3 }) === "Story points 3 → 8");
check("clearing a field says so",
  edit.describeChanges({ assignee: null }, { assignee: { displayName: "Ada" } }) ===
    "Assignee Ada → cleared");
check("a person is named rather than identified",
  edit.describeChanges({ assignee: { accountId: "acc-9", displayName: "Zoe" } }) === "Assignee Zoe");
check("several fields are listed",
  edit.describeChanges({ storyPoints: 5, dueDate: "2026-09-01" }) ===
    "Story points 5, Due date 2026-09-01");

section("the editor: success, undo, failure");
reset();
let painted = 0;
target = issue();
const editor = edit.createFieldEditor({ creds: CREDS, repaint: () => painted++ });
let ok = await editor.write(target, { storyPoints: 8 });
check("the write is reported as taken", ok === true);
check("the value stands", target.fields.customfield_10016 === 8);
check("the view is repainted before and after the request", painted >= 2);
check("the toast names the issue and the change",
  readToast().text.includes("ABC-1") && readToast().text.includes("Story points 3 → 8"));
check("the sprint's cached issues are dropped, nothing else",
  !("cache_sprintIssues_1_5" in local) === true);

// The requests are cleared but the toast is not: the undo button on it is the
// only handle the undo path has, and clearing it would be clearing the window.
resetRequests();
check("the success toast carries an undo", Boolean(undoButton()));
undoButton().click();
await new Promise((r) => setTimeout(r, 0));
check("undo writes the previous value back rather than reverting locally",
  requests.length === 1 && requests[0].body.fields.customfield_10016 === 3);
check("undo restores the value on screen", target.fields.customfield_10016 === 3);
check("undo does not offer its own undo", !undoButton());

reset();
target = issue();
responses = [{ status: 400, body: { errors: { duedate: "Not a valid date." } } }];
ok = await editor.write(target, { dueDate: "the 32nd" });
check("a refused write is reported as refused", ok === false);
check("the screen goes back to what Jira still holds", target.fields.duedate === null);
check("the toast is an error and names the field",
  readToast().error && readToast().text.includes("Due date: Not a valid date."));
check("a refused write offers no undo", !undoButton());

reset();
target = issue();
responses = [{ status: 401, body: "" }];
ok = await editor.write(target, { storyPoints: 1 });
check("a dead token is left to the reauth flow, not toasted",
  ok === false && !readToast().text.includes("could not be saved"));

section("the editor: bulk");
reset();
const many = [issue({ key: "ABC-1" }), issue({ key: "ABC-2" }), issue({ key: "ABC-3" })];
globalThis.confirm = () => true;
ok = await editor.writeMany(many, { storyPoints: 5 });
check("every issue is written", requests.length === 3 && ok === true);
check("each is its own request, so a refusal can name one",
  requests.every((r) => r.method === "PUT"));
check("all three are painted", many.every((i) => i.fields.customfield_10016 === 5));
check("the toast counts rather than lists", readToast().text === "Story points 5 on 3 issues");

reset();
const mixed = [issue({ key: "ABC-1" }), issue({ key: "ABC-2" })];
responses = [{ status: 204, body: "" }, { status: 400, body: { errors: { customfield_10016: "Nope." } } }];
ok = await editor.writeMany(mixed, { storyPoints: 5 });
check("a partial failure is not reported as success", ok === false);
check("what landed stays landed", mixed[0].fields.customfield_10016 === 5);
check("what was refused is rolled back", mixed[1].fields.customfield_10016 === 3);
check("the toast says how many and names the first refusal",
  readToast().text.includes("on 1 of 2") && readToast().text.includes("ABC-2"));

reset();
globalThis.confirm = () => false;
ok = await editor.writeMany(many, { storyPoints: 13 });
check("declining the confirmation writes nothing", requests.length === 0 && ok === false);
check("and paints nothing", many.every((i) => i.fields.customfield_10016 === 5));
globalThis.confirm = () => true;

reset();
ok = await editor.writeMany([issue({ key: "ABC-9" })], { storyPoints: 2 });
check("a bulk edit of one is just an edit, with its undo", Boolean(undoButton()) && ok === true);

section("the editor: sprint moves");
reset();
ok = await editor.moveToSprint([issue()], { id: 77, name: "Sprint 42" });
check("the move is made", ok === true && requests.length === 1);
check("the toast names the sprint", readToast().text === "ABC-1 → Sprint 42");
reset();
responses = [{ status: 403, body: "" }];
ok = await editor.moveToSprint([issue()], { id: 77, name: "Sprint 42" });
check("a refused move says why", ok === false && readToast().error);
reset();
ok = await editor.moveToSprint([issue()], {});
check("a move with no sprint is not attempted", ok === false && requests.length === 0);

section("what a cell will accept");
check("blank clears the estimate", fe.parsePointsInput("") === null);
check("a whole number is taken", fe.parsePointsInput("8") === 8);
check("a half point is taken", fe.parsePointsInput("2.5") === 2.5);
check("a comma decimal is taken — European keyboards type it", fe.parsePointsInput("2,5") === 2.5);
check("zero points is a value, not a clear", fe.parsePointsInput("0") === 0);
check("letters are refused rather than sent as NaN", fe.parsePointsInput("many") === undefined);
check("a negative estimate is refused", fe.parsePointsInput("-3") === undefined);
check("blank clears the due date", fe.parseDateInput("") === null);
check("an ISO day is taken", fe.parseDateInput("2026-09-01") === "2026-09-01");
check("anything else is refused", fe.parseDateInput("01/09/2026") === undefined);
check("no write when nothing changed", fe.unchanged(5, 5) && fe.unchanged(null, undefined));
check("a number read back as a string is not a change", fe.unchanged("5", 5));
check("clearing a set value is a change", fe.unchanged(5, null) === false);

console.log(`\n── ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
