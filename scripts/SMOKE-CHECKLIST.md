# Manual smoke checklist

Run the automated suites first — they cover the config layer, field mapping,
storage migrations, the token lifecycle, the roster, GitHub sync, the
cross-browser shim and the per-target manifests:

```bash
for f in scripts/test-*.mjs; do node "$f" >/dev/null || echo "FAIL $f"; done
```

CI runs exactly that loop on every push to `main`, on every pull request, and
again as the gate before a release publishes — so the suites are covered whether
or not anyone remembers. This checklist is for everything they cannot reach: the
UI, the browser APIs, and real Jira data. Run it after touching config, API, or view code. Reload the
extension first, and keep DevTools open on the app tab — a clean console is part
of every pass.

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
- [ ] Opening the app with no hash lands on the Kanban, filtered to the current sprint, with KANBAN lit under the SPRINT menu
- [ ] A nonsense hash (`app.html#nope`) still lands on the Backlog

## 3z. Backlog screen
- [ ] Header shows the icon, title, subtitle, and one tile per configured status group
- [ ] Tiles recount as filters change; Total always matches the unfiltered count
- [ ] Compact / Default / Cozy visibly change row height and survive a reload
- [ ] `/` focuses search from anywhere; typing in a field does not steal the key
- [ ] Search narrows the list and the "N total · M visible" counter follows
- [ ] Sidebar: each filter group shows "All" or a count; Clear all resets everything
- [ ] Assignee filter search box narrows the option list
- [ ] Group by Epic / Assignee / Board / Status → sticky group headers, collapsible, counts right
- [ ] Grouped view shows no pager and says grouped views are not paginated
- [ ] Ungrouped: pager works, page size persists, page clamps when a filter shrinks the list
- [ ] Row checkbox and header checkbox select; count appears in the pager bar
- [ ] Left accent bar colour matches the board; Board column is off by default
- [ ] Column menu toggles columns, persists across a reload; Key and Summary cannot be hidden
- [ ] Summary text opens the issue, same as the key; ⌘/Ctrl-click opens the full page
- [ ] Save view stores filters + sort + grouping + columns; reopening it restores all four
- [ ] Filter to nothing → empty state with a working Clear filters button
- [ ] Reload with a slow connection → skeleton rows, not a spinner, and no layout jump
- [ ] Command palette → jump to a person → Backlog opens filtered to them, and only once
- [ ] Light theme: tiles, status chips, SP badges and the accent bar all legible

## 3a. Sprint dashboard
- [ ] `d` or the SPRINT tab opens it; sprint name, goal and dates match Jira
- [ ] Working days left is right (weekends not counted); a finished sprint reads "ended …" in red
- [ ] Points complete matches Jira's own sprint total, sub-tasks excluded
- [ ] A sprint with no estimates shows "—" for points, not 0%
- [ ] Carried in matches the issues that were in a previous sprint
- [ ] Added after start looks plausible; the tile reads "exact" or "approx." and the "?" tooltip says which and why
- [ ] Hygiene tile shows an icon AND a word; clicking it goes to Monitor
- [ ] First visit → burndown says it is collecting history and explains why
- [ ] Second day → burndown draws, with the ideal line dashed and a legend present
- [ ] Hovering the burndown moves the crosshair and updates the readout
- [ ] Readout says ahead/behind and matches the line position
- [ ] Progression bar segments sum to the whole; hovering shows each share
- [ ] Narrow segments have no clipped inline label (the legend carries them)
- [ ] By board: bars share one hue, board colours appear as dots in the key
- [ ] By person: roster display-name overrides used; outsiders labelled
- [ ] Light theme: charts re-pick colours, everything still readable
- [ ] Opening the tab straight after Kanban issues no new Jira requests (check the Network tab)
- [ ] Opening it twice in a day does not add a second snapshot row (Storage → `sprintSnapshots`)
- [ ] Opening it twice does not take a second freeze either (Storage → `sprintFreezes` — `takenAt` unchanged)
- [ ] No console errors; no chart drawn outside its card

## 3a-i. Sprint freeze and diff (M13)
The freeze is taken on the first load of a sprint, so most of this needs a sprint
that has actually moved since. A scratch sprint you can drag issues in and out of
is the fastest way to see all six buckets.
- [ ] First ever load of a sprint → a freeze is written (Storage → `sprintFreezes`) and the panel says nothing has moved
- [ ] The readout says whether it was taken at the sprint start or on day N of it, and matches when you first opened the tab
- [ ] Drag an issue into the sprint in Jira, reload → it appears under **Crept in**, in the *already existed* half
- [ ] Create a new issue in the sprint, reload → it appears under **Crept in**, in the *created after the freeze* half
- [ ] Drag an issue out to the backlog → **Pulled out**, "→ backlog"
- [ ] Move an issue to a different sprint → **Pulled out**, naming that sprint
- [ ] Delete an issue that was in the freeze → **Pulled out**, "deleted, or no longer visible to you"
- [ ] Change an estimate → **Re-estimated**, then → now, and the bucket's total point change is the sum of the deltas
- [ ] Clear an estimate → reads as "→ —", not as 0
- [ ] Move a due date → the direction and the number of days are right; setting one that was absent reads "set to …"
- [ ] Reassign an issue → both people are **named**, and the "from" name is the one it had at the freeze even if they have since left the roster
- [ ] Reopen a Done issue → **Went backwards**
- [ ] The arithmetic line reconciles: frozen − pulled out + crept in = the issue count in the KPI row above
- [ ] Sub-tasks appear in no bucket and in no count
- [ ] Every issue key in the panel opens the drawer; ⌘/Ctrl-click opens the page
- [ ] The blind-spot note is present, and says a round trip in and out of the sprint reads as unchanged
- [ ] The departure lookup is **one** request for all of them, after the first paint (Network tab, `search/jql` with `key in (...)`)
- [ ] **Freeze now** → the confirm names the date, issue count and points it is discarding; cancelling changes nothing
- [ ] Confirm it → the panel redraws empty and the readout shows today
- [ ] With a start-of-sprint freeze the "Added after start" tile reads **exact**; with one taken mid-sprint it reads **approx.** and names the day
- [ ] The recap PDF's "What changed underneath the plan" section matches the panel, and its scope note matches the tile
- [ ] A recap opened for a sprint the dashboard has never seen says there is no frozen state — and writes no freeze (Storage unchanged)
- [ ] After nine sprints, `sprintFreezes` and `sprintSnapshots` hold the same eight keys

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

## 3c. Issue detail
- [ ] Plain click on an issue key in Backlog → drawer slides in with that issue
- [ ] ⌘/Ctrl-click the same key → full page opens in a new tab, same content
- [ ] Middle-click → full page in a new tab (no drawer)
- [ ] Right-click → "Open link in new tab" works and lands on the full page
- [ ] Kanban card click → drawer; ⌘/Ctrl-click and middle-click → full page
- [ ] Gantt child bar click → drawer; Monitor row keys → drawer
- [ ] Esc closes the drawer; clicking the dark backdrop closes it; ✕ closes it
- [ ] Drawer sits below the nav and above the footer — both stay fully visible
- [ ] Clicking a nav tab with the drawer open navigates and closes the drawer
- [ ] Opening a second issue from inside the drawer replaces the first
- [ ] Header: status badge colour matches the status category (grey/blue/green)
- [ ] Header: parent row shows type, key and truncated summary; its key opens the parent
- [ ] Header: project key links to the project in Jira; "Open in Jira" opens the issue
- [ ] Drawer only: "Full page ↗" opens the standalone page
- [ ] Meta: assignee and reporter honour roster display-name overrides and avatars
- [ ] Meta: overdue due date renders red; missing values render as "—"
- [ ] Meta: sprint shows the sprint name; a carried-over issue lists closed sprints
- [ ] Description renders formatting (lists, code, tables, links, images)
- [ ] Links inside the description open in a new tab and are absolute
- [ ] An issue with no description shows "No description."
- [ ] Linked issues grouped with Jira's wording ("blocks" vs "is blocked by")
- [ ] Sub-tasks appear under "has sub-task"; an issue with neither still shows the section, for the + Sub-task and + Link buttons
- [ ] Comments load oldest-first with avatars, relative time, exact time on hover
- [ ] An edited comment shows the "edited" marker
- [ ] Post a comment → appears at the bottom, count in the heading increments, box clears
- [ ] ⌘/Ctrl+Enter posts; empty/whitespace-only input keeps the button disabled
- [ ] Multi-paragraph comment (blank line between) keeps both paragraphs in Jira
- [ ] Single newline becomes a line break, not a new paragraph, in Jira
- [ ] Typing `<b>x</b>` posts literally, not as bold
- [ ] Comment on an issue you lack permission for → "Not allowed to comment"
- [ ] Open `issue.html?key=NOPE-1` → clean "not found" message
- [ ] Open `issue.html` with no key → clean "no issue key" message
- [ ] Full page in light theme is readable; drawer too

## 3c-i. Editing fields on the issue detail (M8a)
Each of these is a real write. Use a scratch issue, not one somebody is working on.
- [ ] Assignee, Due date and Story points show a dotted underline on hover; the other three meta cells do not
- [ ] Click Story points → input opens with the current value selected; type a number, Enter → value updates, toast names the change
- [ ] The toast carries **Undo** → click it → the previous value is written back and the cell follows
- [ ] Let the toast expire → the change stands; reload the view → still there (so Jira has it, not just the screen)
- [ ] Click a cell, change nothing, click away → no toast, no request in the network tab
- [ ] Type letters into Story points → nothing is written, the old value comes back
- [ ] Clear Story points entirely → the estimate is cleared in Jira, not set to 0
- [ ] Escape while editing → no write
- [ ] Assignee picker lists the roster, plus the current assignee when they are not on it, plus Unassigned
- [ ] Assign to someone, then Unassigned → both write; avatars and names follow
- [ ] Due date: pick a past date → the value renders red after saving
- [ ] Edit an issue in a project you cannot write to → old value returns, toast names the permission
- [ ] Set an impossible value Jira rejects (e.g. a due date on a screen without it) → error names the field
- [ ] While a Story points edit is in flight, the same cell cannot be started twice
- [ ] Kanban and Backlog show the new value after a refresh — only that board refetches, not all of them

## 3c-ii. Creating an issue (M8b)
- [ ] Backlog **+ New issue** and the palette's "Create issue" open the same panel
- [ ] With the Backlog filtered to one board, the panel opens on that project; with several, on the first
- [ ] Changing project re-reads the type list; changing type re-reads the fields
- [ ] Required fields are marked; submitting empty marks them rather than posting
- [ ] Summary is focused on open; Escape and the backdrop both close the panel
- [ ] A project with a required field the form cannot render says so and offers no submit
- [ ] Optional unrenderable fields are listed as left unset
- [ ] Create with only a summary → issue appears in Jira with the right project and type
- [ ] Description with a blank line → two paragraphs in Jira; `<b>x</b>` posts literally
- [ ] Assignee, priority, labels (comma separated, spaces hyphenated), components, estimate, sprint and epic all land as set
- [ ] The success toast's **Open** button opens the new issue's drawer
- [ ] The Backlog list includes the new issue after the panel closes
- [ ] Force a refusal (a project you cannot create in) → the error is attributed, the form stays filled

## 3c-iii. Creating a sub-task (M8c)
- [ ] **+ Sub-task** appears on the Linked issues heading of a story, and not on a sub-task
- [ ] It opens with the parent named, the project fixed, and the type read from Jira (not the string "Sub-task")
- [ ] Create it → the parent's sub-task list shows it without a manual reload
- [ ] The new sub-task's own detail shows the parent in its header
- [ ] In a project with sub-tasks disabled, the panel says so instead of showing a form

## 3c-iv. Linking issues (M18)
Creating and removing a link are both real writes, and the removal has no undo.
Use a pair of scratch issues.
- [ ] **+ Link** appears on the Linked issues heading of every issue, including a sub-task
- [ ] The relationship list is this site's own — a renamed or locally-added type appears, and the phrases are the site's wording
- [ ] A symmetric type ("relates to") appears once, not twice
- [ ] Typing one character searches nothing; two or more searches, and the list narrows as you type
- [ ] An issue key finds that issue exactly; words find issues by summary
- [ ] The issue being linked from, and anything already linked to it, are not offered
- [ ] Picking a result shows the sentence the link will make, in the direction chosen
- [ ] Create with the outward phrase ("blocks") → **check the other issue in Jira**: it must read "is blocked by", not "blocks"
- [ ] Create with the inward phrase ("is blocked by") → the other issue reads "blocks"
- [ ] After creating, the section redraws with the new link without a manual reload
- [ ] The ✕ on a link row appears on hover and is reachable by keyboard; sub-task rows have none
- [ ] ✕ → the confirm names both issues and the relationship; cancelling removes nothing
- [ ] Confirm → the link goes from Jira, the row goes from the list, the toast says which link
- [ ] Remove a link from a project you cannot write to → the row stays and the toast names the permission
- [ ] On a site with no link types configured, the panel says so instead of showing an empty dropdown

## 3d. Standup mode
- [ ] `s` or the STANDUP tab opens setup; empty roster → pointer to Settings
- [ ] Attendance prefilled from the roster; yesterday's selection restored on a later visit
- [ ] Each person shows their sprint issue count; zero shows in orange
- [ ] Each row shows moved / closed / took / made beside the GitHub cluster, and hovering each gives a sentence saying what it counted and from when
- [ ] Nobody's activity numbers are coloured green — that colour belongs to the GitHub figures, and on a count of a person's actions it would read as praise
- [ ] Rows stay in roster order regardless of whose counts are highest, and no column header is clickable to sort by them
- [ ] A ticket someone moved but does not own counts for the mover, not the assignee (check one against its Jira history)
- [ ] "All in" / "None" work; per-person minutes and "Set all" apply
- [ ] Totals line updates with attendance and shows both speaking and wall-clock time
- [ ] Start → goes full-screen, nav and footer hidden, `dun-dun-dun` plays
- [ ] 5-second countdown shows the first person's name, then their board appears
- [ ] Board shows only that person's current-sprint issues, no assignee avatars
- [ ] Cards are readable from across a room; clicking one still opens the drawer
- [ ] Drawer opened from the standup board leaves the clock bar and parking lot visible
- [ ] Speaker's stage shows a "THIS SPRINT" panel left of the GitHub one, with the same four numbers as that person's setup row
- [ ] The panel lists the ticket keys behind the numbers, ones they finished outlined in green; clicking a key opens the drawer rather than navigating away
- [ ] A person who did nothing this sprint gets no panel at all rather than a row of zeroes
- [ ] With GitHub disconnected the activity panel is still there — it needs no credential and no roster login
- [ ] Drag a card to another column → it moves, toast confirms, Jira reflects it
- [ ] Drag to a column the workflow disallows → card snaps back, toast names the allowed statuses
- [ ] Dragging does not open the drawer; the parking-lot text survives a drag
- [ ] Countdown cue *finishes* as the clock reaches 0:00 (not before, not after)
- [ ] Timer hits zero → keeps counting up in red, bar turns red, nobody is cut off
- [ ] `+1 min` adds a minute without jumping the elapsed time
- [ ] Space pauses (clock dims and freezes) and resumes; paused time is excluded
- [ ] Pause for a minute, resume → remaining time is unchanged from when you paused
- [ ] `→` advances → "GET READY" card with the next person's name and avatar, both large enough to read from the back of the room
- [ ] Handoff auto-advances after ~4s into the next person's board
- [ ] `b` / `k` / `m` do NOT navigate away during a session
- [ ] Mute toggle silences both cues and persists across a reload
- [ ] Reload mid-standup → setup shows "Unfinished standup"; Resume continues at the same person in the same order
- [ ] Discard clears it; starting fresh produces a different order
- [ ] Parking-lot text survives a person change and a reload
- [ ] After the last person → summary with actual vs planned per person
- [ ] Someone who overran is flagged; ending early marks the rest "not reached"
- [ ] Copy notes and Download .txt both work
- [ ] Esc mid-session ends it and exits full-screen
- [ ] Navigating away mid-session stops the timer and the audio (no ghost sounds)

## 3e. Per-person Jira activity
- [ ] A sprint containing a long-lived ticket (one moved dozens of times): its tooltips say "at least this many", naming how many issues Jira truncated
- [ ] The recap's per-person table has **Moved** and **Created** columns, and all eleven columns fit the printed A4 page with nothing clipped
- [ ] The caption under it says the figures are activity rather than performance, and names the window they were counted from
- [ ] Where an issue's history was truncated the caption names it and calls **Moved** a floor rather than a total
- [ ] Someone who created a ticket they did not end up owning is counted under **Created**, and its assignee is not
- [ ] A ticket moved by a Jira automation rather than a person is attributed to nobody — not pooled under Unassigned
- [ ] Open DevTools → Network on a standup load: the sprint request carries `expand=changelog` and there is **no** extra request per issue
- [ ] Application → Local Storage: the cached sprint response holds compact history entries, not Jira's nested author records with avatar URLs
- [ ] The backlog request does *not* carry the expand — nothing reads backlog history, and it would be cache weight for nothing

## 4. Branding and theme
- [ ] No org logo configured → product logo only, nothing broken
- [ ] Point Branding → logo path at a real file → appears in the nav bar
- [ ] Point it at a missing file → falls back to the product logo
- [ ] Set organisation name with no logo → text label appears
- [ ] Toggle light/dark on app and settings → both readable, org wordmark inverts

## 4b. Settings page layout
- [ ] Every section is collapsed on load, including GitHub with sync enabled
- [ ] Opening one section leaves the others shut; state is per-visit, not persisted
- [ ] Save writes fields inside **collapsed** sections too — collapse everything, change the org name, Save, reload
- [ ] Logo click with an app tab already open → that tab is focused and lands on Kanban; this page keeps its unsaved edits
- [ ] Logo click with no app tab open → a new tab opens on Kanban
- [ ] ⌘/Ctrl-click and middle-click on the logo open a new tab natively
- [ ] "What token do I need?" starts collapsed and does not push the token field around when opened
- [ ] Narrow the window below ~900px → Personal settings drops from two columns to one, nothing overlaps
- [ ] Board rows: the colour swatch stays a 28px square, not a stripe
- [ ] Light theme: every section accent, header and hint is legible

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
- [ ] Export with neither token box → `grep` the file for both tokens: no match
- [ ] Export with only the Jira box → the GitHub token is still absent, and vice versa
- [ ] Each token box raises its own confirm, naming what that token exposes
- [ ] Export with both → one warning line mentioning "two live tokens"
- [ ] Import a file carrying a GitHub token → Settings shows it, expiry reads "unknown until the first call"
- [ ] …then Test connection → expiry fills in from the response header

## 5d. GitHub sync
- [ ] Section starts collapsed on a fresh profile; opens already-expanded once enabled
- [ ] Every screen behaves identically with GitHub sync off — standup shows no chip, no panel
- [ ] Enable + org + repos, no token → Test connection says "paste a token first", no request fired
- [ ] Enable + token, empty repo list → Save refuses; the allowlist is the scope
- [ ] Paste a repo three ways (bare name, `owner/name`, browser URL) → all three normalise to the same row
- [ ] Paste nonsense on its own line → flagged as unreadable in the note, dropped on save, not silently kept
- [ ] Test connection → one row per repo, each marked reachable or not, plus the authenticated login
- [ ] List a repo the token cannot see → that row alone fails with a 404, the others still pass
- [ ] Save with GHES host → Chrome prompts for that origin; declining leaves the setting unsaved
- [ ] DevTools → Storage: `githubToken` in `local`, **not** in `sync`, and not in `github` config
- [ ] Export config **with** "include the API token" ticked → `grep` the file for the GitHub token: no match
- [ ] Export → `github` block present with host, org and repos
- [ ] Forget GitHub token → Jira views keep working, repo list retained
- [ ] Roster: Match logins from GitHub org → fills blanks only, never overwrites a typed login
- [ ] Match with a token lacking org Members:read → clean 403 note pointing at manual entry
- [ ] Standup setup card shows the GitHub line; it settles to a repo/PR count
- [ ] Start standup before the fetch lands → standup starts anyway; panel fills in behind
- [ ] A speaker with a GitHub login → panel shows open PRs most-stuck-first, then waiting-on-you, merged, issues
- [ ] A speaker with no GitHub login → one-line note, not an empty panel and not a broken layout
- [ ] Revoke the token mid-session → panel absent next standup, chip explains, no app-wide auth prompt
- [ ] Summary screen shows the copyable digest and confetti — and no GitHub coverage block
- [ ] Confetti: three bursts half a second apart from three different positions, one canvas, clears itself
- [ ] The Copy button stays clickable the whole time it falls
- [ ] Hand-off card: the phrase differs between speakers and never repeats back to back
- [ ] Pause and resume during a hand-off → the phrase does not change under you
- [ ] Resume an interrupted standup → the same phrases come back in the same order
- [ ] Hand-off countdown digit is large and carries the animated gradient, in both themes
- [ ] Footer bottom-right: "butter_jira on GitHub" opens the repo in a new tab
- [ ] With OS "reduce motion" on → no confetti, everything else identical
- [ ] Leave the standup mid-confetti → the canvas goes with the view, no stray overlay on the next tab
- [ ] Copied message starts `Daily Standup Action Points - DD.MM.YYYY`, and the textarea shows exactly what is copied
- [ ] Downloaded .txt carries the same dated heading once, not twice
- [ ] Re-enter standup within five minutes → no second GitHub request (Network tab)
- [ ] Change the repo list → next standup does fetch again (the cache is keyed by the list)

## 5e. Cross-browser (M12)
- [ ] `node scripts/build.mjs` → three dist/ folders, each with its own manifest.json
- [ ] `grep -r "assets/avatars\|assets/brand\|config.local" dist/` → no hits; personal data never ships
- [ ] Firefox: about:debugging → Load Temporary Add-on → `dist/firefox/manifest.json` loads with no warning
- [ ] Firefox: toolbar icon opens the app; a second click raises the same tab rather than opening another
- [ ] Firefox: complete first-run setup, reload → settings survived (proves storage.sync works, i.e. the gecko id is right)
- [ ] Firefox: Settings → save a non-Atlassian Jira host → the origin prompt appears and is honoured
- [ ] Firefox: standup runs — sound cues play, confetti fires, drag-and-drop works
- [ ] Edge: edge://extensions → Load unpacked → `dist/edge` loads with no warning, app opens
- [ ] Chrome: the repo directory still loads unpacked with no build step
- [ ] Chrome: load `dist/chrome` unpacked → loads with no manifest warning
- [ ] Edge: load `dist/edge` unpacked → loads with no manifest warning
      (these two are manual on purpose: headless Chromium refuses to open a
       chrome-extension:// page from the CLI, so nothing automated covers them)
- [ ] **Click every nav tab after any refactor** — Sprint, Backlog, Roadmap, Kanban, Monitor, Standup.
      A missing import only shows up on the view that has it, and the console is where it shows.
- [ ] `git diff manifest.json` after a build is empty — the root manifest has not drifted from the base
- [ ] Chrome → export config (both token boxes ticked) → import into Firefox → app works with no re-typing
- [ ] Same file imported into Edge → works
- [ ] Roster avatars after that import: present with a `--local-assets` build, fall back to Jira pictures without one
- [ ] `node scripts/build.mjs --local-assets --zip` refuses rather than producing a zip

## 6. Repo hygiene (before pushing)
- [ ] every `scripts/test-*.mjs` passes (`for f in scripts/test-*.mjs; do node "$f" >/dev/null || echo "FAIL $f"; done`)
- [ ] `grep -ri` for your org name, site host, and internal project keys → no hits in tracked files
- [ ] `git status --ignored` → `config.local.json` and `assets/brand/*` are ignored
- [ ] `node scripts/jira-smoke.js` passes with env vars set
