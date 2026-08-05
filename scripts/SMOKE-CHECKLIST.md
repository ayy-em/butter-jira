# Manual smoke checklist

Run `node scripts/test-config.mjs` first — it covers the config layer and field
mapping automatically. This checklist is for everything it cannot reach: the UI,
the browser APIs, and real Jira data. Run it after touching config,
API, or view code. `chrome://extensions` → reload the extension first, and keep
DevTools open on the app tab: a clean console is part of every pass.

One expected console line: a 404 for `config.local.json` when you have no local
override file. Anything else is a finding.

## 1. Fresh install
- [ ] Remove the extension, load unpacked again → setup screen appears
- [ ] Setup shows site URL, email, token, and no organisation-specific defaults
- [ ] Connect with a bad token → "Invalid credentials", form stays filled
- [ ] Connect with a bad site URL → connection error, not a silent hang
- [ ] Connect with valid details → "Connected as …", then the board picker
- [ ] Board picker lists real boards; filter box narrows them
- [ ] Select two boards, save → a view renders with issues from both

## 2. Config round-trip
- [ ] Settings: change status grouping, save, reload app → Kanban columns match
- [ ] Settings: change a board colour → Gantt bars and card stripes both follow
- [ ] Settings: **Import from Jira** → new boards appear, existing ones are not duplicated
- [ ] Settings: **Discover from Jira** → field roles resolve; unresolved ones flag in orange
- [ ] Clear a field-role value manually → story points / dates degrade to "—", no crash
- [ ] Add `additionalFields` entry → it appears in the network request's `fields`
- [ ] With `config.local.json` present, its `additionalFields` show in the hint line
- [ ] Reload the extension → every setting survives

## 3. Views
- [ ] Backlog: sorting by each column works, including Epic
- [ ] Backlog: issue key and epic key links open the right Jira issue
- [ ] Gantt: dated epics render; undated section counts correctly
- [ ] Gantt: bar colours match configured board colours
- [ ] Gantt: click a child task → opens in Jira; click an epic → expands children
- [ ] Kanban: cards grouped into the configured columns; click opens Jira
- [ ] Filters: board and assignee filters apply across all three views
- [ ] `b` / `r` / `k` switch views; typing in an input does not trigger them

## 4. Branding and theme
- [ ] No org logo configured → product logo only, nothing broken
- [ ] Point Branding → logo path at a real file → appears in the nav bar
- [ ] Point it at a missing file → falls back to the product logo
- [ ] Set organisation name with no logo → text label appears
- [ ] Toggle light/dark on app and settings → both readable, org wordmark inverts

## 5. Auth failure path
- [ ] Corrupt the stored token (Settings → save a bad one) → 401 toast, no crash loop
- [ ] Restore a good token → views load again

## 6. Repo hygiene (before pushing)
- [ ] `node scripts/test-config.mjs` passes
- [ ] `grep -ri` for your org name, site host, and internal project keys → no hits in tracked files
- [ ] `git status --ignored` → `config.local.json` and `assets/brand/*` are ignored
- [ ] `node scripts/jira-smoke.js` passes with env vars set
