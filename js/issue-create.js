// Turning Jira's createmeta into a form, and the filled form back into a create
// payload.
//
// **The form is generated, not written.** Which fields a new issue must carry is
// a per-project *and* per-issue-type question, and the answer differs between
// Jira sites: one site requires a component, another a team, another nothing but
// a summary. A hardcoded form is a guaranteed 400 on somebody else's instance,
// so this module reads the field descriptors `/rest/api/3/issue/createmeta`
// hands back and derives the rows from them.
//
// Kept free of the DOM so the derivation is testable: the two ways this can go
// wrong quietly are sending a field in the wrong shape (Jira accepts an option
// as `{id}` and rejects a bare string) and dropping a required field the site
// needs. Both are assertions in `scripts/test-create.mjs`.
//
// What it will not do is guess. A required field whose type has no control here
// stops the form with the field named, rather than posting without it and
// showing whatever Jira says about a field the user was never asked for.

import { textToAdf } from "./adf.js";

// Project and issue type are the modal's own two pickers — they decide which
// createmeta to read in the first place, so they are never generated rows.
const CHROME_FIELDS = new Set(["project", "issuetype"]);

// Ordered so the form reads like the issue does, whatever order createmeta
// happens to return. Anything unlisted keeps createmeta's order, after these.
const FIELD_ORDER = [
  "summary", "description", "parent", "assignee", "reporter",
  "priority", "duedate", "labels", "components",
];

export const CONTROLS = {
  TEXT: "text",
  TEXTAREA: "textarea",
  NUMBER: "number",
  DATE: "date",
  DATETIME: "datetime",
  SELECT: "select",
  MULTISELECT: "multiselect",
  USER: "user",
  USERS: "users",
  LABELS: "labels",
  ISSUE_KEY: "issueKey",
  SPRINT: "sprint",
  EPIC: "epic",
  UNSUPPORTED: "unsupported",
};

// One row per field the form should show, plus the two lists a caller has to be
// honest about: `unsupported` are required fields with no control (the form
// cannot be submitted until they are dealt with in Jira), and `omitted` are
// optional ones left out (worth saying once, so nobody thinks the form is the
// whole of Jira's).
export function formSpecFrom(descriptors = []) {
  const rows = [];
  const unsupported = [];
  const omitted = [];

  for (const field of descriptors) {
    const id = field?.fieldId;
    if (!id || CHROME_FIELDS.has(id)) continue;

    const control = controlFor(field);
    const row = {
      id,
      label: field.name || id,
      required: field.required === true,
      control,
      options: optionsFrom(field),
      schema: {
        type: field.schema?.type || "",
        items: field.schema?.items || "",
        system: field.schema?.system || "",
        custom: field.schema?.custom || "",
      },
      // Jira's own default, so a form pre-filled the way the project's create
      // screen would be pre-filled.
      defaultValue: field.hasDefaultValue ? field.defaultValue ?? null : null,
      // Sprint and epic options are not in createmeta — they come from the
      // board — so the modal fills them in after the spec is built.
      needsBoardOptions: control === CONTROLS.SPRINT || control === CONTROLS.EPIC,
    };

    if (control === CONTROLS.UNSUPPORTED) {
      (row.required ? unsupported : omitted).push(row);
      continue;
    }
    rows.push(row);
  }

  rows.sort(byFieldOrder);
  return { rows, unsupported, omitted };
}

function byFieldOrder(a, b) {
  const ai = FIELD_ORDER.indexOf(a.id);
  const bi = FIELD_ORDER.indexOf(b.id);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  // Required fields first among the rest: they are the ones that stop a submit.
  if (a.required !== b.required) return a.required ? -1 : 1;
  return 0;
}

// The control for a field descriptor, from its schema rather than its name — the
// name is whatever the site's admin called it, in whatever language.
function controlFor(field) {
  const schema = field?.schema || {};
  const custom = String(schema.custom || "");
  const system = String(schema.system || "");

  // Agile's two fields are the ones createmeta describes but cannot populate:
  // the sprint list and the epic list live on the board.
  if (custom.endsWith(":gh-sprint") || custom.endsWith(":sprint")) return CONTROLS.SPRINT;
  if (custom.endsWith(":gh-epic-link") || custom.endsWith(":epic-link")) return CONTROLS.EPIC;

  switch (schema.type) {
    case "string":
      // Jira v3 takes rich text as Atlassian Document Format, and both the
      // system description and a custom textarea are rich text.
      if (system === "description" || system === "environment") return CONTROLS.TEXTAREA;
      if (custom.endsWith(":textarea")) return CONTROLS.TEXTAREA;
      // A single-select rendered as a string field: options decide, not the type.
      return hasOptions(field) ? CONTROLS.SELECT : CONTROLS.TEXT;
    case "number":
      return CONTROLS.NUMBER;
    case "date":
      return CONTROLS.DATE;
    case "datetime":
      return CONTROLS.DATETIME;
    case "user":
      return CONTROLS.USER;
    case "option":
    case "priority":
    case "resolution":
    case "securitylevel":
    case "component":
    case "version":
    case "team":
      return hasOptions(field) ? CONTROLS.SELECT : CONTROLS.UNSUPPORTED;
    case "issuelink":
      return CONTROLS.ISSUE_KEY;
    case "any":
      // `any` is what Jira says when it has nothing useful to say. Text is the
      // one shape that cannot be wrong for a free-form field, and a required
      // one gets flagged rather than guessed at.
      return field.required ? CONTROLS.UNSUPPORTED : CONTROLS.TEXT;
    case "array":
      switch (schema.items) {
        case "string":
          return system === "labels" || custom.endsWith(":labels")
            ? CONTROLS.LABELS
            : hasOptions(field)
              ? CONTROLS.MULTISELECT
              : CONTROLS.LABELS;
        case "user":
          return CONTROLS.USERS;
        case "option":
        case "component":
        case "version":
        case "group":
          return hasOptions(field) ? CONTROLS.MULTISELECT : CONTROLS.UNSUPPORTED;
        default:
          return CONTROLS.UNSUPPORTED;
      }
    default:
      return CONTROLS.UNSUPPORTED;
  }
}

function hasOptions(field) {
  return Array.isArray(field?.allowedValues) && field.allowedValues.length > 0;
}

// Jira labels an option by `value`, `name`, or `label` depending on which kind
// of field it is. All three are read rather than picking one and being wrong on
// two thirds of the fields.
function optionsFrom(field) {
  if (!hasOptions(field)) return [];
  return field.allowedValues
    .map((option) => ({
      id: String(option.id ?? option.key ?? option.value ?? ""),
      name: String(option.value ?? option.name ?? option.label ?? option.key ?? option.id ?? ""),
    }))
    .filter((o) => o.id || o.name);
}

// Jira's defaults, in the shape the form's own state uses.
export function initialValues(rows = []) {
  const values = {};
  for (const row of rows) {
    const value = row.defaultValue;
    if (value === null || value === undefined) continue;
    switch (row.control) {
      case CONTROLS.SELECT:
        values[row.id] = String(value.id ?? value.value ?? value);
        break;
      case CONTROLS.USER:
        values[row.id] = value.accountId || "";
        break;
      case CONTROLS.MULTISELECT:
      case CONTROLS.USERS:
        values[row.id] = (Array.isArray(value) ? value : [value]).map((v) =>
          String(v.accountId ?? v.id ?? v)
        );
        break;
      case CONTROLS.LABELS:
        values[row.id] = (Array.isArray(value) ? value : [value]).map(String);
        break;
      default:
        values[row.id] = typeof value === "object" ? "" : value;
    }
  }
  return values;
}

// The required rows a caller has not filled. Empty is empty whatever the shape:
// a blank string, an empty list and an unset key are all "not answered".
export function missingRequired(rows = [], values = {}) {
  return rows.filter((row) => row.required && isBlank(values[row.id]));
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === "";
}

// Form state -> the `fields` object for POST /rest/api/3/issue.
//
// Every control has one shape Jira accepts and several it rejects, and this is
// where that knowledge lives: an option is `{id}` and not its label, a user is
// `{accountId}`, a label list is bare strings, rich text is a document. Empty
// values are left out entirely rather than sent as null — on create, "not set"
// and "explicitly cleared" are the same thing, and null is refused by some
// fields.
export function buildCreatePayload({ rows = [], values = {}, projectKey, issueTypeId, parentKey }) {
  const fields = {};
  if (projectKey) fields.project = { key: String(projectKey) };
  if (issueTypeId) fields.issuetype = { id: String(issueTypeId) };
  // A sub-task's parent is chrome rather than a form row: the caller knows it,
  // and 8c prefills it from the issue the modal was opened over.
  if (parentKey) fields.parent = { key: String(parentKey) };

  for (const row of rows) {
    const value = values[row.id];
    if (isBlank(value)) continue;
    const shaped = shapeValue(row, value);
    if (shaped !== undefined) fields[row.id] = shaped;
  }
  return fields;
}

function shapeValue(row, value) {
  switch (row.control) {
    case CONTROLS.TEXT:
      return String(value);
    case CONTROLS.TEXTAREA:
      return textToAdf(String(value));
    case CONTROLS.NUMBER: {
      const n = Number(String(value).replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
    case CONTROLS.DATE:
      return String(value);
    case CONTROLS.DATETIME:
      // `<input type="datetime-local">` gives a local time with no zone; Jira
      // wants an offset, so the browser's own is attached rather than assuming
      // UTC and moving everyone's due times.
      return isoWithOffset(String(value));
    case CONTROLS.SELECT:
      return { id: String(value) };
    case CONTROLS.MULTISELECT:
      return asList(value).map((id) => ({ id: String(id) }));
    case CONTROLS.USER:
      return { accountId: String(value) };
    case CONTROLS.USERS:
      return asList(value).map((id) => ({ accountId: String(id) }));
    case CONTROLS.LABELS:
      // Jira rejects a label containing a space, and splitting on commas is
      // what someone typing a list expects.
      return asList(value)
        .flatMap((entry) => String(entry).split(","))
        .map((label) => label.trim().replace(/\s+/g, "-"))
        .filter(Boolean);
    case CONTROLS.ISSUE_KEY:
      return { key: String(value).trim().toUpperCase() };
    case CONTROLS.SPRINT: {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case CONTROLS.EPIC:
      // The classic Epic Link takes the epic's key as a bare string.
      return String(value).trim().toUpperCase();
    default:
      return undefined;
  }
}

function asList(value) {
  return Array.isArray(value) ? value : [value];
}

function isoWithOffset(local) {
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000` +
    `${sign}${pad(offset / 60)}${pad(offset % 60)}`
  );
}

// The sub-task type for a project, discovered rather than matched by name.
// Returns null when the project has none — team-managed projects can have
// sub-tasks switched off entirely, and the caller has to say so rather than
// offering a button that cannot work.
export function subtaskTypeFrom(issueTypes = []) {
  return issueTypes.find((t) => t.subtask === true) || null;
}

export function creatableTypes(issueTypes = []) {
  return issueTypes.filter((t) => !t.subtask);
}
