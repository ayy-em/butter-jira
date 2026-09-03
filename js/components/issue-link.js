// The link picker: choose a relationship, find the other issue, create the link.
//
// Two halves, and each one exists because of a way the naive version fails:
//
//   - **The relationship list is read from the site**, never written here. Link
//     types are instance configuration, so a hardcoded "blocks / relates to /
//     duplicates" is a list that offers relationships some sites do not have.
//   - **The other issue is searched for, not typed.** A raw key field is a typo
//     waiting to 400, and the app already has an issue search that degrades
//     honestly — the palette's.
//
// What it does not do is guess: a site whose link types cannot be read gets a
// sentence saying so, not an empty dropdown.

import { createIssueLink, getIssueLinkTypes, searchIssuesByJql } from "../api.js";
import { showToast } from "../utils.js";
import {
  MIN_QUERY,
  alreadyLinked,
  describeLink,
  linkChoices,
  linkPayloadFor,
  pickerJql,
} from "../issue-link.js";
import { openDrawerPanel } from "./drawer.js";

const SEARCH_DEBOUNCE_MS = 300;

// `issue` is the whole issue, not just its key: the panel filters out what is
// already linked, and that needs the links.
export async function openLinkIssue(creds, { issue, onLinked = null } = {}) {
  const issueKey = issue?.key || "";
  const { body, close } = openDrawerPanel({
    label: `Link an issue to ${issueKey}`,
    className: "create-drawer",
  });

  const state = {
    choices: [],
    choiceId: "",
    results: [],
    picked: null,
    query: "",
    searching: false,
    searchError: "",
    loading: true,
    error: "",
    submitting: false,
  };
  const linked = alreadyLinked(issue);

  // The results list repaints on its own so typing does not rebuild the input
  // under the cursor. Declared up here rather than beside `renderResults`
  // because the first `render()` runs before that point in the function body,
  // and a `let` read ahead of its declaration is a crash, not an undefined.
  let resultsEl = null;
  let previewEl = null;
  let submitBtn = null;

  const root = document.createElement("form");
  root.className = "create-form";
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  body.appendChild(root);
  render();

  try {
    state.choices = linkChoices(await getIssueLinkTypes(creds));
    state.choiceId = state.choices[0]?.id || "";
    if (!state.choices.length) {
      state.error =
        "This Jira site has no issue link types configured, so there is no " +
        "relationship to create. An admin adds them under Issues → Issue linking.";
    }
  } catch (err) {
    state.error = `Could not read this site's link types: ${err.message || err}`;
  }
  state.loading = false;
  render();

  function chosen() {
    return state.choices.find((c) => c.id === state.choiceId) || null;
  }

  // Every keystroke starts a search, and the answers can come back out of
  // order; the token is what stops a slow early query overwriting a fast late
  // one. Same guard the palette's JQL box uses, for the same reason.
  let searchToken = 0;
  let searchTimer = null;

  function queueSearch(text) {
    state.query = text;
    state.picked = null;
    if (searchTimer) clearTimeout(searchTimer);
    const jql = pickerJql(text, { excludeKey: issueKey });
    if (!jql) {
      searchToken++;
      state.results = [];
      state.searching = false;
      state.searchError = "";
      renderResults();
      return;
    }
    state.searching = true;
    state.searchError = "";
    renderResults();
    searchTimer = setTimeout(() => runSearch(jql), SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(jql) {
    const token = ++searchToken;
    try {
      const found = await searchIssuesByJql(jql, creds, 20);
      if (token !== searchToken) return;
      // An issue already linked from here, or the issue itself, is filtered out
      // rather than offered: creating a duplicate link is a 400 the user has no
      // way to have predicted.
      state.results = found.filter((i) => !linked.has(String(i.key).toUpperCase()));
      state.searchError = "";
    } catch (err) {
      if (token !== searchToken) return;
      state.results = [];
      state.searchError = String(err.message || err).slice(0, 120);
    }
    state.searching = false;
    renderResults();
  }

  function render() {
    root.textContent = "";
    resultsEl = null;
    previewEl = null;
    submitBtn = null;

    const title = document.createElement("h1");
    title.className = "create-title mono";
    title.textContent = "LINK ISSUE";
    root.appendChild(title);

    root.appendChild(note(`From: ${issueKey}${issue?.fields?.summary ? ` — ${issue.fields.summary}` : ""}`, "create-parent"));

    if (state.loading) {
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      spinner.style.margin = "28px auto";
      root.appendChild(spinner);
      return;
    }
    if (state.error) {
      root.appendChild(note(state.error, "create-error"));
      return;
    }

    const select = document.createElement("select");
    select.className = "create-input mono";
    for (const choice of state.choices) {
      const option = document.createElement("option");
      option.value = choice.id;
      option.textContent = choice.phrase;
      select.appendChild(option);
    }
    select.value = state.choiceId;
    select.addEventListener("change", () => {
      state.choiceId = select.value;
      renderResults();
    });
    root.appendChild(labelled("Relationship", select));

    const search = document.createElement("input");
    search.className = "create-input";
    search.type = "text";
    search.placeholder = "Issue key or words from the summary";
    search.value = state.query;
    search.addEventListener("input", () => queueSearch(search.value));
    // Enter in the search box would otherwise submit the form with nothing
    // picked; it belongs to the search.
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
    root.appendChild(labelled("Issue", search));

    resultsEl = document.createElement("div");
    resultsEl.className = "link-results";
    root.appendChild(resultsEl);

    previewEl = document.createElement("div");
    previewEl.className = "create-note link-preview";
    root.appendChild(previewEl);

    const actions = document.createElement("div");
    actions.className = "create-actions";
    submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "create-submit";
    submitBtn.textContent = "Link";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "create-cancel mono";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    actions.append(submitBtn, cancel);
    root.appendChild(actions);

    setTimeout(() => search.focus(), 0);
    renderResults();
  }

  function renderResults() {
    if (!resultsEl) return;
    resultsEl.textContent = "";

    if (state.searchError) {
      resultsEl.appendChild(note(state.searchError, "create-error"));
    } else if (state.searching) {
      resultsEl.appendChild(note("Searching…"));
    } else if (state.query.trim().length < MIN_QUERY) {
      resultsEl.appendChild(note("Type at least two characters to search."));
    } else if (!state.results.length) {
      resultsEl.appendChild(
        note("Nothing matches — or everything that does is already linked.")
      );
    } else {
      for (const found of state.results) resultsEl.appendChild(resultRow(found));
    }

    const choice = chosen();
    previewEl.textContent =
      choice && state.picked
        ? `${describeLink(choice, issueKey, state.picked.key)}.`
        : "";
    if (submitBtn) submitBtn.disabled = !state.picked || state.submitting;
  }

  function resultRow(found) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "link-result";
    if (state.picked?.key === found.key) row.classList.add("picked");

    const key = document.createElement("span");
    key.className = "issue-key mono";
    key.textContent = found.key;
    row.appendChild(key);

    const summary = document.createElement("span");
    summary.className = "issue-link-summary";
    const text = found.fields?.summary || "";
    summary.textContent = text;
    summary.title = text;
    row.appendChild(summary);

    row.addEventListener("click", () => {
      state.picked = state.picked?.key === found.key ? null : found;
      renderResults();
    });
    return row;
  }

  async function submit() {
    const choice = chosen();
    if (state.submitting || !choice || !state.picked) return;
    const payload = linkPayloadFor(choice, { issueKey, otherKey: state.picked.key });
    if (!payload) return;

    state.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Linking…";
    try {
      await createIssueLink(payload, creds);
      const sentence = describeLink(choice, issueKey, state.picked.key);
      close();
      showToast(sentence);
      // Jira answers the create with an empty body, so there is nothing to
      // render from — the caller re-reads the issue instead.
      onLinked?.();
    } catch (err) {
      state.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Link";
      resultsEl.prepend(note(err.message || String(err), "create-error"));
    }
  }

  return { close };
}

function labelled(label, control) {
  const wrap = document.createElement("div");
  wrap.className = "create-row";
  const key = document.createElement("label");
  key.className = "create-label mono";
  key.textContent = label;
  wrap.append(key, control);
  return wrap;
}

function note(text, className = "create-note") {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}
