# Manual smoke checklist

Run `node scripts/test-config.mjs`, `test-credentials.mjs`, `test-team.mjs` and
`test-monitor.mjs` first — they cover the config layer, field mapping,
storage migrations, the token lifecycle and the roster automatically. This checklist is for everything it cannot reach: the UI,
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
- [ ] `b` / `r` / `k` / `m` switch views; typing in an input does not trigger them

## 3b. Monitor tab
- [ ] Opens with `m` or the MONITOR tab; nav badge shows the total, hidden at zero
- [ ] Counts match reality — spot-check one finding per section against Jira
- [ ] No sub-tasks in "no epic parent", "no due date" or "no story points"
- [ ] Sub-tasks DO appear in "unassigned" when nobody is on them
- [ ] No epics or done issues in any section
- [ ] A story linked to an epic via `parent` (team-managed project) is not flagged
- [ ] Clean sections start collapsed with a green count; clicking expands them
- [ ] Clicking a summary chip scrolls to and expands that section
- [ ] "Fix these first" lists only issues tripping 2+ checks; hover shows which
- [ ] Issue keys open the right Jira issue
- [ ] Scope toggle → All Issues pulls in the backlog (spinner, then larger counts) and survives a reload
- [ ] Team Only here matches the same toggle in the other views
- [ ] Settings → untick a check → it disappears from the tab after Save
- [ ] Untick all four → "Every check is muted" empty state
- [ ] Clear the story-points field mapping → that section reads "Can't run", counts nothing, and does not flag every issue
- [ ] Clear the epic-link mapping → "no epic parent" still runs, with an orange caveat

## 4. Branding and theme
- [ ] No org logo configured → product logo only, nothing broken
- [ ] Point Branding → logo path at a real file → appears in the nav bar
- [ ] Point it at a missing file → falls back to the product logo
- [ ] Set organisation name with no logo → text label appears
- [ ] Toggle light/dark on app and settings → both readable, org wordmark inverts

## 5. Identity, credentials, expiry
- [ ] Note the ID at `chrome://extensions`, remove the extension, load unpacked again → **same ID**, and settings are still there
- [ ] DevTools → Application → Storage: token is in `chrome.storage.local`, **not** in `sync`
- [ ] Upgrading from a pre-M2 install: token moved to local automatically, no re-login
- [ ] Corrupt the stored token (Settings → save a bad one) → re-auth prompt appears, asking only for a token
- [ ] Re-auth prompt: bad token → "still rejected"; good token → views reload with boards intact
- [ ] Dismiss the re-auth prompt (Esc or "Not now") → toast explains, no crash loop
- [ ] Set token expiry to a date within 14 days → banner appears once; Dismiss → gone for the rest of the day
- [ ] Set expiry to a past date → banner reads "expired" in red
- [ ] Save Settings without changing the token → creation date does not move
- [ ] Forget token on this device → token cleared, boards and field mapping kept

## 5b. Export / import
- [ ] Export without the token box ticked → file downloads, `grep` it for your token: no match
- [ ] Tick "include token" → confirm dialog appears; file then contains it
- [ ] Import that file into a fresh profile → site, boards, status groups, field mapping restored
- [ ] Import a non-ButterJira JSON file → clean "not a ButterJira config export" error
- [ ] Import a truncated/corrupt file → error, existing settings unchanged

## 5c. Team roster
- [ ] Empty roster → no Team Only button in the filter bar
- [ ] Harvest from boards → assignees appear, ranked by issue count, none duplicated
- [ ] Harvest twice → no duplicates, "all already on the roster"
- [ ] Search directory → results list; already-added people show "on roster", disabled
- [ ] Search directory on an account without Browse-users → clean 403 note, no error toast
- [ ] Add by account ID → member appears immediately, no "unlinked" badge
- [ ] Add by email on a site you can search → resolves to a real account
- [ ] Add by email where search 403s → member appears with "unlinked" badge
- [ ] Harvest after adding an unlinked email that matches a real assignee → badge clears, override kept
- [ ] Set a display-name override → used in Backlog, Kanban cards, Kanban person pills, assignee filter
- [ ] Set an emoji → prefixes the name everywhere
- [ ] Set an avatar override → replaces the Jira avatar; broken URL falls back to initials
- [ ] Untick "in" for a member → they drop out of Team Only, stay in the roster
- [ ] Roster edits without pressing Save → not persisted after reload (by design; note says so)
- [ ] DevTools → Storage: `teams` is in `local`, **not** in `sync`
- [ ] Team Only on → issues assigned outside the roster disappear, unassigned stay
- [ ] Team Only choice survives a reload and applies to all three views
- [ ] Assignee filter labels non-roster people `· outside team`
- [ ] Export without the roster box → `grep` the file for a colleague's email: no match
- [ ] Export with the roster box → confirm dialog, then roster present in the file

## 6. Repo hygiene (before pushing)
- [ ] `node scripts/test-config.mjs`, `test-credentials.mjs` and `test-team.mjs` pass
- [ ] `grep -ri` for your org name, site host, and internal project keys → no hits in tracked files
- [ ] `git status --ignored` → `config.local.json` and `assets/brand/*` are ignored
- [ ] `node scripts/jira-smoke.js` passes with env vars set
