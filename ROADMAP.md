# ButterJira — Roadmap

Last updated: 2026-08-05

A Chrome MV3 extension giving Gantt, Backlog, and Kanban views over Jira Cloud
boards. This roadmap takes it from an internal single-tenant tool to a
configurable, team-facing sprint cockpit that any org can clone and point at
their own Jira site.

## Current state

| Aspect | Status |
|---|---|
| Views | Gantt, Backlog, Kanban (`js/views/`) |
| Data access | Read-only, HTTP Basic (email + API token), `js/api.js` |
| Endpoints | `/rest/api/3/myself`, `/rest/api/3/field`, `/rest/api/3/search/jql`, `/rest/agile/1.0/board/*` |
| Config | Single source: `js/config.js` (site, brand, boards, status groups, field mapping), overridable via `config.local.json` |
| Storage | `chrome.storage.sync` for config + credentials, `chrome.storage.local` for a 5-minute response cache |
| Build step | None — plain ES modules, one vendored lib (`libs/frappe-gantt`) |
| Version control | `.gitignore` in place; `git init` when convenient |
| Tests | None; manual checklist + `scripts/jira-smoke.js` connectivity check |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Milestone sequence at a glance

```
M0 Hygiene ✔ ─▶ M1 Whitelabel ✔ ─▶ M2 Durable config ──▶ M3 People layer ──┬──▶ M4 Monitoring ──▶ M5 Issue detail
                                                                        │
                                                                        ├──▶ M6 Standup mode
                                                                        │
                                                                        └──▶ M7 Dashboard ──▶ M8 Writes + Planner ──┬──▶ M9 Palette + Triage
                                                                                                                    └──▶ M10 Sprint Wrapped
```

Ordering logic: config plumbing first (M0–M2), because every later feature reads
from it and because losing your settings on every extension reload makes the
rest miserable to build. The people layer (M3) is a hard dependency for standup
and planning. Monitoring (M4) lands early — it is pure client-side derivation
over data already being fetched, so it is the cheapest real feature in the list.
The write layer is deliberately deferred to M8 and isolated in one milestone;
everything before it stays read-only.

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

## M2 — Durable identity and config *(feature 2)*

**Size: M** · Depends on M1.

**Root cause of the re-login pain:** removing and re-adding an unpacked
extension mints a **new extension ID**, and `chrome.storage` is namespaced per
ID — so the old settings are still on disk but unreachable. Plain reloads (the
↻ button, or a code change) keep the same ID and *do* preserve storage. So this
is an identity problem, not a storage problem.

**Tasks**

- Pin the extension ID: add a `key` field to `manifest.json` (public half of a generated keypair). Same ID across remove/re-add and across machines, so storage survives. Private key stays out of the repo.
- Config export/import as a JSON file — the belt-and-braces answer, and also how you onboard a teammate or move to another browser. Offer "export without credentials" as the default.
- Move the API token out of `chrome.storage.sync` (`js/api.js:237`, `js/router.js:209`, `settings.js:327`) into `chrome.storage.local`. `sync` replicates it in plaintext through the user's Google account to every signed-in device; `local` keeps it on the machine. Non-secret config can stay on `sync`.
- Schema versioning + migrations: store `configVersion`, run migrations on `chrome.runtime.onInstalled`. This is what makes "the codebase changed" a non-event instead of a reset.
- **Token lifecycle UX.** Atlassian API tokens now expire (1–365 days, one year by default). Record the creation/expiry date at setup, warn at T-14 days, and on a 401 show a "your token expired — paste a new one" banner that keeps boards, team, and field mappings intact. Today `jiraFetch` fires a `jira-auth-error` event (`js/api.js:20`, `js/api.js:39`) that drops the user back to a bare setup screen; expiry is the single most likely 401 cause and deserves a named path.

**Exit criteria:** remove the extension, re-add it, and land straight in the app
with all settings intact. An expired token asks for a token and nothing else.

---

## M3 — People layer: team mapping *(feature 3)*

**Size: M** · Depends on M2. Hard dependency for M6, M8, M9, M10.

- Roster editor in settings: add members from `GET /rest/api/3/user/search` or harvested from board issues (`extractAssignees` in `js/utils.js:122` already does the harvesting).
- Per-member: `accountId` (the stable key), display name override, optional nickname/emoji, avatar override, active flag, default capacity inputs (reserved for M8).
- Global "my team only" filter, wired into the existing filter component (`js/components/filters.js`) so all three views honour it.
- Replace `formatDisplayName` (`js/utils.js:113`) heuristics with roster lookup, falling back to the Jira name.
- Surface non-roster assignees as "outside team" rather than hiding them silently — silent filtering makes issue counts lie.

**Exit criteria:** one roster, defined once, respected by every view and reused
by later milestones. Use synthetic names in any fixtures or screenshots.

---

## M4 — Monitoring tab *(feature 6)*

**Size: S–M** · Depends on M3. The cheapest real feature here — no new endpoints.

Four hygiene checks over the current sprint plus backlog data already in hand:

1. Unassigned issues
2. Issues/stories/tasks with no epic parent
3. Current-sprint issues with no due date
4. Current-sprint issues with no story points

- One tab, four collapsible sections, per-section counts as nav badges.
- Each row: key, summary, board, assignee, and a jump-out link. Rows become deep links into the M5 detail drawer once it exists; until then, link to Jira `/browse/{key}`.
- Configurable checks (mute a check, or scope it to team-only via M3).
- Empty state that is actually satisfying — this tab should be boring most days.

**Exit criteria:** the four checks are correct against a real sprint, and each
finding is one click from being fixed (in Jira now, in-app after M8).

---

## M5 — Issue detail *(feature 4)*

**Size: L** · Depends on M4 (shares the drawer/route shell).

Fields: key, summary, status, type, assignee/reporter, start and end dates, due
date, story points, sprint, description, linked issues, subtasks, comments, and
development links (PRs/branches/commits).

- `GET /rest/api/3/issue/{key}?expand=renderedFields` — use `renderedFields` for the description so you get HTML instead of hand-rendering Atlassian Document Format.
- `GET /rest/api/3/issue/{key}/comment` (paginated), newest-first, with author avatars from the M3 roster.
- Issue links + subtasks + parent breadcrumb; each link opens the same drawer.
- **Sanitise before injecting.** Jira-rendered HTML goes through a strict allowlist sanitiser before it touches `innerHTML`. The extension CSP (`manifest.json:19`) blocks inline scripts, which limits the blast radius but does not make untrusted HTML safe.
- **Spike: development information.** PRs, branches, and commits are not in the public REST API. The panel Jira itself renders is backed by `/rest/dev-status/1.0/issue/detail?issueId=…&applicationType=…&dataType=pullrequest`, which is undocumented and unsupported — usable, but it can change without notice. Timebox the spike; ship `GET /rest/api/3/issue/{key}/remotelink` plus commit references parsed from comments as the documented fallback, and degrade to "no dev info available" rather than erroring.

**Exit criteria:** every field in the feature list renders or is explicitly
marked unavailable; the dev-info path degrades gracefully; no unsanitised HTML.

---

## M6 — Daily standup mode *(feature 7)*

**Size: L** · Depends on M3 (roster) and reuses the Kanban renderer.

Flow: **Start** → pick who is in today → per-person duration (default 2 min) →
randomise order → 5-second countdown → person's Kanban (current sprint, their
issues) → audio cue at 3-2-1 → draw next name → "get ready" card with name and
avatar → fade → next Kanban, timer starts.

- Attendance picker prefilled from the active roster; remembers yesterday's selection.
- Per-person duration with a bulk "set all" and a visible total ("14 min for 7 people").
- Seeded shuffle so an interrupted session can resume the same order.
- State machine — `idle → countdown → speaking → handoff → done` — held in one place. Timer drift matters here: use timestamp deltas, not accumulated `setInterval` ticks.
- Audio: bundle short cue files in `assets/sfx/` (CSP and `host_permissions` rule out fetching them remotely). Mute toggle, and pre-warm the audio element so the first cue is not swallowed by autoplay policy.
- Per-person Kanban = existing Kanban filtered to assignee + active sprint. Reuse, do not fork, `js/views/kanban.js`.
- Overrun handling: keep counting up in red rather than cutting someone off mid-sentence.
- Parking-lot notes pane, cleared per session, exportable as plain text.
- Full-screen presentation mode, readable from across a room, keyboard-only controls (space = pause, → = next).

**Exit criteria:** a real standup runs end to end without anyone touching a
mouse, and a mid-session browser reload does not lose the order.

---

## M7 — Sprint overview dashboard *(feature 5)*

**Size: L** · Depends on M3.

- Header: sprint name, goal, dates, days remaining (working days).
- Points and issue counts by status group, by board, by assignee.
- Completion rate, scope change (added/removed after sprint start), carryover in and projected carryover out.
- Hygiene score fed by the M4 checks.
- Charts. Pick one small footprint approach and stay consistent — inline SVG is enough here, and the CSP means no CDN chart library anyway.
- **Spike: burndown history.** Point-in-time history needs either `expand=changelog` per issue (accurate, N requests, expensive) or the greenhopper sprint report (`/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=…&sprintId=…`, one request, undocumented). Prototype both; if neither is acceptable, ship the daily snapshot alternative: persist a small aggregate to `chrome.storage.local` once per day and build history forward from first use.
- Watch request volume — `getAllSprintIssues` (`js/api.js:165`) already fans out across boards; the dashboard should reuse that data, not re-fetch it. The 5-minute cache TTL (`js/utils.js:174`) may need to be per-resource.

**Exit criteria:** the dashboard answers "are we going to make it?" without
opening Jira, and adds no more than one extra request per board.

---

## M8 — Write layer + sprint planner *(feature 8)*

**Size: XL — split on contact** · Depends on M3 and M7.

This is the first milestone that mutates Jira. Keep that boundary explicit.

**8a — Write layer (S–M)**

- `jiraPut`/`jiraPost` mutation helpers with per-request error surfacing, alongside the existing read helpers in `js/api.js`.
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
| `/rest/dev-status/1.0/` is undocumented and may break without notice | M5 | Timeboxed spike, documented remote-link fallback, graceful degradation |
| greenhopper sprint report is undocumented | M7 | Two prototypes plus a daily-snapshot fallback that depends on nothing private |
| ~~Hardcoded `customfield_*` IDs are instance-specific~~ | M1 ✔ | Resolved: discovery via `/rest/api/3/field` + manual override per role |
| Request fan-out across boards hits rate limits | M7, M8 | Reuse cached aggregates, per-resource TTLs, batch where the API allows |
| Token expiry mistaken for a broken app | M2 | Expiry tracking, T-14 warning, targeted re-auth banner |
| Writes corrupt real sprint data | M8 | Draft mode, batch confirmation, undo window, isolated write helpers |
| Unsanitised Jira HTML injected into the page | M5 | Allowlist sanitiser; CSP as defence in depth, not the primary control |

## Open questions

1. **Distribution** — private Chrome Web Store listing, or stay unpacked/internal? Affects whether the manifest `key` approach in M2 is the right one, and whether M1's whitelabelling needs to survive a public listing review.
2. **Board-per-project assumption** — `getAllEpics` (`js/api.js:142-160`) maps issue keys to boards via project key. Any org running several boards over one project will need a different mapping before M7's per-board stats are trustworthy. More pressing now that the board picker lets anyone select overlapping boards.
3. **Velocity source for M8** — historical (needs closed-sprint data) or hand-entered per person? Historical is better and more work.
4. **Team scope** — one roster, or several named teams switchable from the nav? Cheap to design for now, awkward to retrofit after M6 and M8 both depend on it.
