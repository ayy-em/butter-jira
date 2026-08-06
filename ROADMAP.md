# ButterJira — Roadmap

Last updated: 2026-08-07

A Chrome MV3 extension giving Gantt, Backlog, and Kanban views over Jira Cloud
boards. This roadmap takes it from an internal single-tenant tool to a
configurable, team-facing sprint cockpit that any org can clone and point at
their own Jira site.

## Current state

| Aspect | Status |
|---|---|
| Views | Sprint dashboard, Gantt, Backlog, Kanban, Monitor, Standup, Issue detail (drawer + full page) |
| Data access | HTTP Basic (email + API token), `js/api.js`. Read-only except posting comments |
| Endpoints | `/rest/api/3/myself`, `/rest/api/3/field`, `/rest/api/3/search/jql`, `/rest/agile/1.0/board/*` |
| Config | Single source: `js/config.js` (site, brand, boards, status groups, field mapping), overridable via `config.local.json` |
| Storage | `chrome.storage.sync` for config; `chrome.storage.local` for credentials, roster, view prefs, schema version, and a 5-minute response cache |
| Build step | None — plain ES modules, one vendored lib (`libs/frappe-gantt`) |
| Version control | `.gitignore` in place; `git init` when convenient |
| Tests | None; manual checklist + `scripts/jira-smoke.js` connectivity check |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Milestone sequence at a glance

```
M0 Hygiene ✔ ─▶ M1 Whitelabel ✔ ─▶ M2 Durable config ✔ ─▶ M3 People ✔ ──┬──▶ M4 Monitoring ✔ ─▶ M5 Issue detail ✔
                                                                        │
                                                                        ├──▶ M6 Standup ✔ ─▶ M11 GitHub sync
                                                                        │
                                                                        └──▶ M7 Dashboard ✔ ─▶ M8 Writes + Planner ──┬──▶ M9 Palette + Triage
                                                                                                                    └──▶ M10 Sprint Wrapped
```

Ordering logic: config plumbing first (M0–M2), because every later feature reads
from it and because losing your settings on every extension reload makes the
rest miserable to build. The people layer (M3) is a hard dependency for standup
and planning. Monitoring (M4) lands early — it is pure client-side derivation
over data already being fetched, so it is the cheapest real feature in the list.
The write layer is deliberately deferred to M8 and isolated in one milestone;
everything before it stays read-only. M11 hangs off standup rather than the M8
chain because it is read-only against a second API and shares nothing with the
Jira write path — it can be picked up whenever, and dropped without stranding
anything.

---

## M0 — Hygiene and foundations ✔

**Size: S** · Done. No user-visible change; bought back time on everything after it.

- `.gitignore` authored (`git init` still deferred, by choice).
- `.DS_Store` files removed from the tree.
- Duplicated board defaults collapsed — `settings.js` no longer re-declares what config owns.
- Jira base URL single-sourced. It had been hardcoded in nine places across `js/api.js`, `js/router.js`, `js/components/nav.js`, `js/views/*.js`, and the old test script; all of them now go through `jiraUrl()` / `browseUrl()` / `wikiUrl()`.
- Ad-hoc test script rewritten as `scripts/jira-smoke.js`, reading everything from the environment.
- `README.md`: what it is, how to load unpacked, how to get an API token.
- `scripts/SMOKE-CHECKLIST.md`: manual pass covering install → auth → views → config round-trip. Cheap substitute for a test suite until there is a build step.

**Exit criteria met:** `js/config.js` is the only module that knows the site
URL; no duplicated defaults; README lets a stranger run it.

---

## M1 — Whitelabel: make it configurable ✔ *(feature 1)*

**Size: M** · Done. Depends on M0.

The tool assumed one Jira site, one fixed set of boards, and one org's
branding. All of that is now data rather than code.

**What moved into config**

| What | Becomes |
|---|---|
| Hardcoded site URL (9 call sites) | `CONFIG.site.baseUrl`, set at setup, editable in Settings |
| Hardcoded board list (IDs, labels, project keys) | user-configured `CONFIG.boards`; no built-in defaults |
| Project-named CSS accents | `--accent-primary` / `-success` / `-warning` / `-danger` |
| Per-board Gantt bar colours in `css/gantt.css` | generated at mount from configured board colours |
| Org wordmark asset in the nav bar | optional `CONFIG.brand.orgLogo`, product logo when unset |
| Org email placeholders, org-specific titles | neutral product strings |
| Hardcoded `customfield_*` IDs | discovered field roles (below) |

**What was built**

- `js/config.js` — single module owning site URL, brand, boards, status groups, field mapping, and additional fields. Resolution order: built-in defaults → `config.local.json` (untracked) → browser storage. `additionalFields` merges rather than overrides, so a local file always contributes.
- **Custom field discovery.** `GET /rest/api/3/field` matched by field name resolves the four roles the app needs (story points, start date, epic link, sprint) into ordered candidate ID lists; `fieldValue(issue, role)` takes the first that carries a value. Runs automatically at setup, re-runnable from Settings, with manual override per role. Unresolved roles degrade to empty values instead of breaking a view.
- **Extensible extra fields.** `additionalFields` is appended to every issue query, editable in Settings and in `config.local.json` — the gitignored escape hatch for site-specific fields.
- `.gitignore` covers `config.local.json`, `assets/brand/*` (bar `.gitkeep`), secrets patterns, packaging output, OS/editor noise, and local agent state.
- First-run flow: site URL → credentials → verify → field discovery → board picker populated from `GET /rest/agile/1.0/board`, so nobody types a numeric board ID.
- `optional_host_permissions` so a non-Atlassian host (Jira Data Center on a custom domain) can be granted at setup for that origin only.

**Cross-cutting note:** `baseUrl` is swappable in one place. If an org ever
mandates scoped API tokens, the base becomes
`https://api.atlassian.com/ex/jira/{cloudId}` and every path gains a prefix —
now a small change in `js/config.js` rather than a nine-file search-and-replace.

**Exit criteria met:** a fresh clone pointed at an unrelated Jira Cloud site
with different boards and different custom field IDs renders all three views
with no code edits. No org string or asset in the tracked tree.

---

## M2 — Durable identity and config ✔ *(feature 2)*

**Size: M** · Done. Depends on M1.

**Root cause of the re-login pain:** removing and re-adding an unpacked
extension mints a **new extension ID**, and `chrome.storage` is namespaced per
ID — so the old settings are still on disk but unreachable. Plain reloads (the
↻ button, or a code change) keep the same ID and *do* preserve storage. So this
is an identity problem, not a storage problem.

**What was built**

- **Pinned the extension ID** — `manifest.json` carries a `key` (public half of a generated keypair), so the ID is `bcbejonnfmamlddbojnjjgdabndpicff` on every machine and survives remove/re-add. The private half was never written to disk: unpacked loading only needs the public key. Must be removed before a Chrome Web Store upload, which assigns its own identity — noted in the README.
- **Config export/import** (`js/portable.js`) — JSON file with site, brand, boards, status groups, field mapping and additional fields. The token is excluded by default and needs an explicit checkbox plus a confirm to include. Import validates and sanitises every field, drops junk with a warning rather than throwing, and refuses files that are not ButterJira exports.
- **Token moved to `chrome.storage.local`** (`js/credentials.js`) — off `sync`, which replicated it in plaintext through the user's Google account to every signed-in device. Non-secret config stays on `sync`. Cross-machine transfer is now the export/import flow. Also added a "forget token on this device" action that keeps everything else.
- **Numbered storage migrations** (`js/migrations.js`) — `schemaVersion` in local storage, migrations run before any config or credential read (memoised, idempotent) and on `chrome.runtime.onInstalled`. v1→v2 moves legacy synced credentials to local. Storage written by a newer build is left untouched rather than mangled. This is what makes a codebase change a non-event.
- **Token lifecycle UX** — creation and expiry dates recorded at setup (default one year, since Atlassian does not expose real expiry over the API), correctable in Settings, with a once-a-day banner from T-14 onwards. A 401 now opens a re-auth prompt asking for the token alone, with site, email, boards and field mapping preserved; parallel 401s produce one prompt, not a pile-up.

**Exit criteria met:** remove the extension, re-add it, and land straight in the
app with all settings intact. An expired token asks for a token and nothing else.
Verified by `scripts/test-credentials.mjs` (82 checks) for everything except the
browser-level ID pinning, which is on the manual checklist.

---

## M3 — People layer: team mapping ✔ *(feature 3)*

**Size: M** · Done. Depends on M2. Hard dependency for M6, M8, M9, M10.

**What was built**

- **Roster data layer** (`js/team.js`) — device-local, since a roster holds colleagues' names, emails and avatars. Shape carries a team list plus an active id from day one, so a team switcher is additive later rather than a migration. Members dedupe on accountId, then email, merging blanks instead of duplicating a person.
- **Three ways onto the roster** (`js/roster-ui.js`), in order of how widely they work:
  1. **Harvest from boards** — `getAllSprintIssues` + `getAllBacklogIssues`, no extra Jira permission, ranked by issue count. Only finds people with an assigned issue right now, which is why it is not the only path.
  2. **Directory search** — `GET /rest/api/3/user/search`, filtered to human accounts. Needs "Browse users and groups", which many sites restrict to admins, so a 403 degrades to an explanatory note rather than an error.
  3. **Manual entry** — account ID (reliable) or email. An email-only member is stored **unlinked**, flagged in the UI, and gets its accountId filled in automatically the next time that person appears in a harvest.
- **Per-member**: display-name override, emoji, avatar override, active flag, and a `capacity` object carried through untouched for the planner (M8).
- **Team Only filter** in the filter bar, persisted, honoured by all three views. It hides work assigned *outside* the roster but keeps unassigned issues — hiding those would make the M4 hygiene checks lie.
- **Outsiders are marked, not hidden**: the assignee dropdown labels them `· outside team`, and `extractAssignees` sorts roster members first.
- Display names resolve through the roster everywhere (`assigneeLabel`), falling back to the Jira name shortened to first + last.
- Roster is **excluded from config export** unless explicitly ticked, behind a confirm — same pattern as the token. Import warns before storing colleagues' details.

**Exit criteria met:** one roster, defined once, respected by every view and
reused by later milestones. Verified by `scripts/test-team.mjs` (84 checks).

---

## M4 — Monitoring tab ✔ *(feature 6)*

**Size: S–M** · Done. Depends on M3. Cheapest real feature here — no new endpoints.

**What was built**

- **Four hygiene checks** (`js/monitor.js`), pure derivation over issues the views already fetch: unassigned, no epic parent, no due date, no story points. Exit criteria met with no extra requests.
- **Type exclusions, stated in the UI rather than hidden.** Every check skips epics and anything already done; all but "unassigned" also skip sub-tasks, because a sub-task hangs off a story — it has no epic of its own and inherits its parent's dates and estimate. Flagging all of them would have made the tab noise. Sub-tasks *do* count as unassigned, since nobody picking one up is a real gap.
- **Done detection prefers `statusCategory`** over status names, so a workflow with a custom done status ("Shipped") is handled, and a status literally named "Done" that isn't in the done category is not.
- **Epic detection works on both project styles**: `getEpicKey` reads the configured Epic Link field and falls back to `parent`, so company-managed and team-managed projects both resolve.
- **Checks that cannot run say so** instead of flagging everything. With no story-points field mapped, "no story points" would otherwise report every issue on the board; it now renders as unavailable with a pointer to Settings, and contributes nothing to the totals. "No epic parent" carries a softer caveat when the Epic Link field is unmapped, since the parent fallback still works.
- **Cross-check "fix these first"**: issues tripping more than one check are ranked at the top of the summary, because one edit clears several findings.
- Scope toggle (current sprint / all issues, backlog fetched only when asked for), Team Only toggle shared with the other views, per-section counts, collapsible sections that start collapsed when clean, and a nav badge with the total.
- Per-check muting in Settings, stored as mutes only — so a check added later defaults to on rather than silently off.

**Exit criteria met:** the four checks are correct against synthetic fixtures
covering both Jira project styles (`scripts/test-monitor.mjs`, 54 checks), and
every finding is one click from Jira. In-app fixing arrives with the write layer
in M8.

---

## M5 — Issue detail ✔ *(feature 4)*

**Size: L** · Done. Depends on M4 (whose rows are now deep links into it).

**Two containers, one renderer.** A plain left-click on any issue key opens a
slide-over **drawer**; ⌘/Ctrl-click, middle-click, or "open in new tab" opens the
**full page** (`issue.html?key=ABC-123`). Both call the same
`renderIssueInto()`, so the layout can't drift between them. Anchors carry the
page URL as their `href` and only intercept unmodified left-clicks, which means
the browser handles new-tab opening natively rather than through hand-rolled
modifier detection.

The drawer deliberately does **not** write the issue key into the URL: the
router keys off the hash, so an issue key there would remount the underlying
view. The full page is the linkable, reloadable form.

**What renders**

- **Header** — key (links to Jira), status badge coloured by `statusCategory`, issue type with icon, summary, parent row (type chip + key + truncated summary, opening in the drawer), project key + name linking to Jira, and explicit "Open in Jira" / "Full page" links.
- **Content** — assignee, reporter, start date, due date (overdue in red, with a relative hint), story points, sprint (handles both the object array and the older serialised `name=…` blob, marking closed sprints), then the description.
- **Linked issues** — grouped by relationship using Jira's own `inward`/`outward` wording so "blocks" and "is blocked by" read correctly, with sub-tasks as their own group. Every key opens in the drawer.
- **Comments** — paginated, oldest-first, author avatars and roster display names, relative timestamps with exact time on hover, an "edited" marker, and a reply box.

**Reply is the app's first write** (`POST /rest/api/3/issue/{key}/comment`),
pulled forward from M8 by request. Jira's v3 API takes Atlassian Document
Format, so `js/adf.js` converts textarea text — blank lines become paragraphs,
single newlines become hard breaks, and markup is left literal rather than
half-interpreted. ⌘/Ctrl+Enter posts. The posted comment is re-rendered from
Jira's response rather than from the local draft, so what's on screen is what
exists. Scoped-token setups need `write:comment:jira` for this.

- **Sanitiser** (`js/sanitize.js`). Descriptions and comment bodies arrive as Jira-rendered HTML authored by anyone who can comment, so they go through an allowlist before touching the DOM: unknown elements unwrap (keeping their text), `script`/`style`/`iframe`/`form`/`svg` and friends are dropped with their contents, every `on*`/`style`/`srcset`/`data-*` attribute is stripped, and `href`/`src` must parse as http(s)/mailto after control characters are removed (`java\tscript:` is a real bypass). Site-relative Jira URLs resolve against the configured base; surviving links get `target=_blank` + `rel="noopener noreferrer"`. The element walk runs against a minimal DOM stub in the tests, so the dangerous path is covered without a browser.
- Both rich-text paths degrade: no `renderedFields`/`renderedBody` falls back to text extracted from the ADF rather than showing nothing.

**Exit criteria met:** every field in the feature list renders or is explicitly
marked unavailable, and no HTML reaches the DOM unsanitised. Verified by
`scripts/test-issue.mjs` (86 checks, half of them sanitiser attack cases).
Development links moved to the deferred backlog at the user's request — to be
homebrewed against the GitHub API later.

---

## M6 — Daily standup mode ✔ *(feature 7)*

**Size: L** · Done. Depends on M3 (roster) and reuses the Kanban renderer.

Flow as specified: **Start** → who's in today → per-person duration (default
2 min) → randomised order → 5-second countdown → that person's sprint board →
countdown cue before time is up → "get ready" card with the next person's name
and avatar → their board, timer running.

**What was built**

- **Session logic** (`js/standup.js`) — DOM-free and audio-free, so the awkward parts are unit-testable: phase machine (`countdown → speaking → handoff → speaking → … → done`), pause arithmetic, overrun, and resume.
- **Timing from timestamps, never accumulated ticks.** A background tab throttles `setInterval` to once a second or worse; a counter built from ticks would silently fall behind the wall clock exactly when someone tabs away mid-standup. Every displayed value is derived from `Date.now()` deltas minus paused stretches.
- **Seeded shuffle** (mulberry32 + Fisher–Yates). A reload offers "Resume — same order as before", and the order is reproducible from the stored seed alone.
- **Attendance** prefilled from `activeMembers()`, remembering yesterday's selection, with "All in" / "None", per-person minutes, a bulk "set all", each person's sprint issue count (so an empty board is visible before the meeting), and both speaking and wall-clock totals — the latter including the lead-in and hand-offs.
- **Audio** (`js/sfx.js`) — the two supplied cues, bundled under `assets/sfx/`. `dun-dun-dun` fires as the standup starts; the countdown cue is scheduled from its own measured duration so it *finishes* exactly as the clock hits zero, rather than starting at a hardcoded 3 seconds. `unlock()` runs inside the Start button's click handler to satisfy the autoplay policy and warm the buffers, so the first real cue isn't swallowed. Mute toggle, persisted.
- **Board reuse, not a fork.** The card and column rendering moved out of `js/views/kanban.js` into `js/components/board.js` (Kanban dropped from 507 to ~300 lines) and standup renders the same cards, with drag-reorder opt-in so the stage gets a read-only board and assignee avatars suppressed (the whole board is one person's).
- **Overrun** counts up in red with the progress bar turning red, rather than cutting anyone off. `+1 min` extends the current person without disturbing the elapsed clock.
- **Presentation mode**: full-screen on start, nav and footer hidden, type scaled for reading across a room, and keyboard-only control — Space pauses, → advances, Esc ends. The router yields the keyboard while a session is live, so `b`/`r`/`k` can't navigate away and lose the standup.
- **Parking lot** per session, saved as you type, shown in the summary with copy-to-clipboard and download-as-txt.
- **Summary** after the last person: actual vs planned time each, overruns flagged, people never reached marked as such.

**Exit criteria met:** the flow runs mouse-free, and a mid-session reload
resumes the same order at the same person. Verified by
`scripts/test-standup.mjs` (105 checks) covering pause arithmetic, overrun,
transitions, resume, and the shared board grouping.

---

## M7 — Sprint overview dashboard ✔ *(feature 5)*

**Size: L** · Done. Depends on M3.

**What was built**

- **Aggregation** (`js/dashboard.js`) — one pass over the sprint issues the other views already cached, producing points and issue counts by status group, by board and by person, completion by both points and issues, carry-in, scope change, projected carry-out, and working-day arithmetic. Zero extra requests in the normal case: `getAllSprintIssues` and `getActiveSprint` are both already cached by Kanban and Monitor.
- **Sub-tasks excluded from totals** — their points duplicate the parent story's and would inflate the sprint total. The count of excluded sub-tasks is stated rather than hidden.
- **Working days, not calendar days.** A burndown that counts weekends makes every team look behind on Monday morning.
- **Carry-in is detected properly** from the issue's sprint field listing a closed (or non-active) sprint, including the older serialised `state=CLOSED` blob format. **Scope-added is honestly approximate** — it compares issue creation against sprint start, so an older issue dragged in mid-sprint isn't caught. The tile says so in a tooltip rather than implying precision.
- **Hygiene score** wired to the M4 checks, as a share of issues with no finding, and the tile links through to the Monitor tab.

**Burndown — the history problem, resolved**

Neither documented route was acceptable: `expand=changelog` costs one request per
issue (a 60-issue sprint = 60 requests every time the tab opens), and the chart
Jira itself draws comes from `/rest/greenhopper/1.0/rapid/charts/sprintreport`,
which is the same class of undocumented, unsupported endpoint the development-links
feature was deferred over. Shipping against it would have contradicted that
decision one milestone later.

So the app **records its own daily snapshot** (`js/snapshots.js`): one small
aggregate per day per sprint, from data already in hand, building history forward.
Honest costs, stated in the UI rather than papered over: the burndown appears on
the second day of use, and sprints that ran before install have no history. The
empty state explains why instead of drawing a line the data can't support.
Storage is bounded (8 sprints × 60 days) and same-day writes overwrite.

**Charts** (`js/charts.js`) — inline SVG, no library (the CSP forbids remote
script, and three chart forms don't justify vendoring one). Built to fixed mark
specs rather than per-chart taste: bars ≤24px with a 4px rounded data-end, 2px
lines with round caps, ≥8px markers carrying a 2px surface ring, hairline
recessive gridlines, and a 2px surface gap between stacked segments instead of
strokes. Form was chosen per data job:

| Data | Form | Colour job |
|---|---|---|
| Headline numbers | KPI row of stat tiles; completion is the single hero figure | none |
| Sprint progression | one horizontal stacked bar | **ordinal** — To Do → Done is a sequence, so one hue in monotone lightness steps |
| By board | horizontal bars, uniform hue + board-colour dot beside the label | nominal — colouring bars by board would spend the identity channel on what the label already says |
| By person | bar-in-table with meters | doubles as the table view, so every value is readable as text |

Palettes were **validated, not eyeballed** — both ordinal ramps pass monotone
lightness, adjacent ΔL ≥ 0.06, light-end contrast ≥ 2:1 and single-hue; every
mark clears 3:1 against its own surface (4.42:1 light, 5.89:1 dark). Light and
dark are each selected against their own surface rather than one being a flip of
the other. The progression ramp is deliberately **not** the app's status badge
colours — those are reserved status tokens, and reusing them would have a status
colour impersonating a series. Status tiles always pair colour with an icon and a
word.

**Exit criteria met:** the dashboard answers "are we going to make it?" without
opening Jira, and adds no requests at all when the other views have already run.
Verified by `scripts/test-dashboard.mjs` (123 checks), which includes a DOM shim
asserting chart geometry — no NaN coordinates, nothing drawn outside the viewBox,
no inline label on a segment too narrow to hold it.

---

## M8 — Write layer + sprint planner *(feature 8)*

**Size: XL — split on contact** · Depends on M3 and M7.

This is the first milestone that mutates Jira. Keep that boundary explicit.

**8a — Write layer (S–M)**

- `jiraPut` mutation helper with per-request error surfacing, alongside the existing read helpers in `js/api.js`. `jiraPost` already exists and carries the comment write from M5.
- `PUT /rest/api/3/issue/{key}` for assignee, story points, due date, sprint.
- Optimistic UI + rollback on failure + targeted cache invalidation (`cache.clear()` at `js/api.js:140` is a blunt instrument once writes exist).
- Confirmation for bulk operations; an undo window for single ones.
- Note for scoped-token setups: writes need `write:jira-work` (or the granular `write:issue:jira`) in addition to the read scopes. Unscoped tokens inherit the user's own Jira permissions and need nothing extra.

**8b — Planner (L)**

- Inputs: sprint length, total working days, per-person OOO days, optional focus factor.
- Capacity: per-person points capacity derived from a configurable historical velocity or a manual points-per-day rate.
- Carryover: unfinished issues from the previous sprint, with points, listed before you plan anything new.
- Assignment board: drag issues from backlog to a person; live utilisation bar per member with over-allocation warnings at 100% and 120%.
- Committed vs planned totals against team capacity, with the delta always visible.
- Draft mode: plan locally, review the diff, then push all assignments in one confirmed batch. Never write on every drag.

**Exit criteria:** a sprint can be planned in-app and pushed to Jira in one
reviewed batch, with per-person utilisation visible throughout, and any failed
write clearly attributed rather than silently dropped.

---

## M9 — Command palette + quick triage *(suggested feature 9)*

**Size: M** · Depends on M4 (findings) and M8a (writes).

The keyboard layer that makes this a power tool rather than another dashboard.

- `Cmd/Ctrl+K`: fuzzy jump to any issue by key or summary, any person, any view, any sprint. Recent items first.
- Raw JQL escape hatch, with results in the standard issue list.
- **Triage mode:** walk the M4 monitoring queue one card at a time and fix each finding by keystroke — `a` assign (roster autocomplete), `p` points, `d` due date, `e` attach epic, `s` skip, `⌫` back. A 40-item hygiene backlog becomes a five-minute pass instead of forty tab-outs to Jira.
- Palette-driven actions everywhere: "start standup", "open planner", "clear cache", "export config".

**Why it earns a slot:** it converts M4 from a list of complaints into a
workflow, and it is the feature people will use twenty times a day.

---

## M10 — Sprint Wrapped *(suggested feature 10)*

**Size: M** · Depends on M7 aggregates.

An end-of-sprint recap card for the retro — the fun one, built almost entirely
from data M7 already computes.

- Headline stats: points shipped, issues closed, cycle-time median, biggest single-day burn, scope added mid-sprint.
- Light-hearted superlatives: *Deadline Whisperer* (most issues closed early), *The Ping-Pong Award* (most status transitions), *Carryover Champion*, *Epic Slayer* (finished the last child of an epic), *Ghost Ticket* (longest untouched issue still in sprint).
- Export as PNG (canvas render) to paste into the retro or a channel.
- Sprint-over-sprint trend strip: last five sprints, points and carryover.

**Keep it team-facing.** Superlatives name individuals, so: opt-in per team,
per-person opt-out in the roster, aim the jokes at tickets rather than people,
and no persistence of individual histories. It is a retro toy, and it should
stay too obviously silly to be mistaken for a performance metric.

---

## M11 — GitHub sync *(feature 11)*

**Size: M — split in two** · Depends on M3 (roster). Independent of M8: this is
read-only against GitHub, so it can land before the Jira write layer.

The standup board answers "what is assigned to you". It cannot answer "what have
you got in review", which in practice is where half the day went and where the
blocker usually is. This milestone adds a second, optional source: open pull
requests across the org, grouped by person, on the same screen as their tickets.

Optional throughout. With no GitHub token configured, nothing in the app changes.

**11a — Config, auth and mapping (S–M)**

- **Settings → GitHub sync**, a collapsed section that stays out of the way until enabled: host, org, token, and a "Test connection" button in the shape Settings already uses for Jira.
- **Config** (synced, non-sensitive): `github: { host, org, enabled }`. `host` defaults to `github.com`; anything else is GitHub Enterprise Server and shifts the API base from `https://api.github.com` to `https://<host>/api/v3`. Both `config.local.json` and Settings write it, same as every other config block.
- **Token** (device-local, never synced, never exported): stored through the existing `js/credentials.js` pattern under its own keys, since it is a second credential with its own lifecycle — a dead GitHub token must never break the Jira views. A fine-grained PAT needs *Pull requests: read*, *Metadata: read*, and *Members: read* on the org; a classic PAT needs `repo` + `read:org`.
- **Real expiry, for once.** Unlike Atlassian, GitHub returns `github-authentication-token-expiration` on every authenticated REST call. Record it from the response instead of guessing at creation + 365 days, and reuse the M2 banner and re-auth prompt verbatim — scoped to a GitHub-only banner that does not present as an app-wide auth failure.
- **Host permission.** `https://api.github.com/*` goes into `host_permissions`. A GHES host cannot be known at build time, so it is requested at runtime via `chrome.permissions.request` against the existing `optional_host_permissions` — from the Save button, which is the user gesture the API requires. The current CSP does not constrain `connect-src`, so nothing there needs to change.
- **Roster gains `githubLogin`**, normalised the way handles already are (GitHub logins: alphanumerics and single inner hyphens, ≤39 chars). Plus a **"Match from GitHub org"** button that pulls `/orgs/{org}/members`, proposes a mapping against roster display names, and leaves every row editable — the same assisted-not-automatic shape as the Jira roster import.
- **Personal data:** a GitHub login is one more identifier attached to a named colleague, so it rides in the roster record and inherits its treatment — local-only storage, and excluded from config export unless the personal-data box is ticked. No new mechanism, and no new decision to get wrong.

**11b — Open PRs in standup (M)**

- **One request for the whole team.** The GraphQL API answers `search(query: "org:X is:pr is:open", type: ISSUE, first: 100)` with author, repo, draft flag, review decision, and check state in a single POST. The REST equivalent is one search call *per person*, against the search endpoint's much tighter 30/minute budget — a nine-person team restarting standup twice would feel it. GraphQL is the primary path; REST search stays as the GHES-version fallback.
- **Pre-fetch on start.** The GitHub query fires in parallel with `getAllSprintIssues` when standup starts, so nobody watches a spinner on their turn. It is never on the critical path: if it is slow, the standup starts anyway and the panel fills in; if it fails or is unconfigured, the panel is absent and the standup is exactly what it is today. A small status chip on the setup card says which of those happened.
- **Per-person PR panel** beside the speaker's board: title, repo, age in days, and the state that actually decides what to say — *draft*, *waiting on review*, *changes requested*, *approved and unmerged*, *checks failing*. Sorted by whatever is most stuck.
- **"Waiting on you" as a second lens.** `review-requested:<login>` PRs are the ones a standup can unblock in ten seconds, so they get their own short list rather than being mixed in with the person's own work.
- **Orphan PRs** — open PRs by org members not on the roster, and roster members with no `githubLogin` — surfaced once on the summary screen rather than silently dropped, or the panel quietly lies about coverage.
- **Cache** with the existing 5-minute TTL, keyed by org, so leaving and re-entering standup does not re-query.

**Not in this milestone:** correlating PRs to individual Jira issue keys. That is
the deferred *development links* item below, and it is a different problem —
key-matching accuracy — sitting on top of the same auth and config this
milestone builds. M11 unblocks it; it does not deliver it.

**Exit criteria:** with GitHub configured, a standup shows every open PR the team
has, grouped by person, fetched in one request before the first person speaks;
with GitHub not configured, or its token dead, every existing screen behaves
exactly as it does today. Verified by `scripts/test-github.mjs` over the pure
parts: login normalisation, API base derivation for github.com vs GHES, GraphQL
response → view model, grouping by author, review-state and staleness
derivation, and the unmapped-login accounting.

---

## Deferred backlog

Scoped, wanted, and deliberately not scheduled yet.

### Development links on the issue detail *(was part of M5)*

Show pull requests, branches and commits for an issue.

**Why it was deferred:** Jira has no public REST API for this. The panel Jira
itself renders is backed by
`/rest/dev-status/1.0/issue/detail?issueId=…&applicationType=…&dataType=pullrequest`,
which is undocumented, unsupported, and free to change without notice — a poor
foundation for a feature people would come to rely on.

**Planned approach instead:** talk to the **GitHub API directly** and correlate
on the issue key. **M11 now builds the auth, config and roster mapping this
needs**, so what is left here is only the per-issue correlation. Sketch, for when
this gets picked up:

- Search PRs and commits by issue key (`GET /search/issues?q=ABC-123+repo:org/repo+type:pr`, `GET /search/commits?q=ABC-123`), plus branch names matching the key.
- Config: which repos to search, per project or per board — a `github` block in `config.local.json` and Settings.
- Auth: a GitHub token, stored device-local like the Jira token (never in synced storage, never in the repo), with the same expiry-reminder treatment.
- Render as a "Development" section on the issue detail: PR state, review state, branch, recent commits, degrading to "no linked development" when nothing matches.
- Rate limits matter: search endpoints are capped, so cache per issue key and only fetch when the detail view opens.

**Sizing: M**, plus a spike on key-matching accuracy (short keys like `AB-1`
produce false positives in commit messages).

## Icebox

- **"What changed since you last looked"** — diff current sprint state against the snapshot from your previous session. Pairs naturally with the M7 daily snapshots.
- WIP limits and blocked-chain visualisation on the Kanban.
- Multi-site support (several Jira Cloud instances in one install).
- Firefox/Edge port — MV3 is mostly portable; `chrome.*` namespace and the manifest `key` are the friction points.
- OOO import from a calendar feed to prefill planner absences.
- Confluence export of standup notes and Wrapped cards.
- A real build step + test runner, once module count justifies it.

## Risk register

| Risk | Milestone | Mitigation |
|---|---|---|
| ~~`/rest/dev-status/1.0/` is undocumented~~ | M5 → deferred | Avoided entirely: dev links move to the GitHub API in the deferred backlog |
| Untrusted Jira HTML reaching the DOM | M5 ✔ | Allowlist sanitiser with the element walk unit-tested; CSP as defence in depth |
| First write path (comments) misfiring | M5 ✔ | Single narrow endpoint, comment re-rendered from Jira's response, explicit 403 handling |
| ~~Hardcoded `customfield_*` IDs are instance-specific~~ | M1 ✔ | Resolved: discovery via `/rest/api/3/field` + manual override per role |
| ~~greenhopper sprint report is undocumented~~ | M7 ✔ | Avoided: daily local snapshots instead, with the trade-off stated in the UI |
| Request fan-out across boards hits rate limits | M7, M8 | Reuse cached aggregates, per-resource TTLs, batch where the API allows |
| ~~Token expiry mistaken for a broken app~~ | M2 ✔ | Resolved: expiry tracking, T-14 banner, token-only re-auth prompt |
| Writes corrupt real sprint data | M8 | Draft mode, batch confirmation, undo window, isolated write helpers |
| Unsanitised Jira HTML injected into the page | M5 | Allowlist sanitiser; CSP as defence in depth, not the primary control |
| GitHub search rate limit (30/min) throttles standup | M11 | One GraphQL query for the whole org instead of one REST search per person; 5-minute cache; pre-fetch once at standup start |
| A dead GitHub token reads as the app being broken | M11 | Separate credential and separate banner from Jira's; every GitHub failure degrades to the panel being absent, never to a blocked view |
| A second identifier per colleague widens the personal-data surface | M11 | `githubLogin` lives in the roster record and inherits its handling — local-only, excluded from export unless explicitly ticked |

## Open questions

1. ~~**Distribution**~~ — answered 2026-08-05: unpacked now, possible Web Store listing later. The manifest `key` is in place for unpacked use and must be deleted before any store upload.
2. **Board-per-project assumption** — `getAllEpics` (`js/api.js:142-160`) maps issue keys to boards via project key. Any org running several boards over one project will need a different mapping before M7's per-board stats are trustworthy. More pressing now that the board picker lets anyone select overlapping boards.
3. **Velocity source for M8** — historical (needs closed-sprint data) or hand-entered per person? Historical is better and more work.
4. ~~**Team scope**~~ — answered 2026-08-05: one roster, but stored under a team key from the start so a switcher can be added later without a migration.
