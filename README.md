# ButterJira

A Chrome extension that gives you Gantt (roadmap), Backlog, Kanban, and sprint
hygiene views across several Jira boards at once, in one tab, with your own
status grouping.
Because the other one sucks.

Works against any Jira Cloud site — nothing about your instance is baked into
the code. Board IDs, project keys, custom field IDs, and branding all come from
configuration you supply at setup.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repo directory.
4. Click the ButterJira toolbar icon.

## First run

The setup screen asks for three things:

| Field | Example | Notes |
|---|---|---|
| Jira site URL | `your-org.atlassian.net` | Scheme optional; Data Center hosts work too |
| Email | `you@example.com` | The Atlassian account the token belongs to |
| API token | — | Create one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |

On connect it verifies the credentials, resolves this site's custom field IDs
automatically, then offers every board your account can see so you can pick the
ones you care about. No board IDs to look up by hand.

### API tokens

Use an **unscoped** API token — it inherits your own Jira permissions and
needs no scope selection. Tokens expire (1–365 days, one year by default), and
an expired token shows up as a 401.

If you would rather use a **scoped** token, note that scoped tokens only work
against `https://api.atlassian.com/ex/jira/{cloudId}` rather than your site URL,
and need these read scopes: `read:jira-user`, `read:jira-work`,
`read:sprint:jira-software`, `read:board-scope:jira-software`,
`read:issue-details:jira`, `read:jql:jira`.

## Configuration

Everything is editable from the Settings page (⚙ in the nav bar):

- **Jira site URL** — switch instances without touching code
- **Boards in scope** — import from Jira, or add board ID + label + project key manually
- **Status column grouping** — map your workflow's statuses onto Kanban columns
- **Team roster** — who is on the team, with display-name overrides and emoji
- **Monitoring checks** — mute any of the four hygiene checks
- **Field mapping** — which custom field holds story points, start date, epic link, sprint
- **Additional fields** — extra field IDs to fetch on every issue query
- **Branding** — optional org name and logo shown in the nav bar

### config.local.json

For anything you would rather keep in the repo directory than in browser
storage — or want to seed before first run — copy the example:

```bash
cp config.local.example.json config.local.json
```

`config.local.json` is gitignored. Resolution order is: built-in defaults →
`config.local.json` → Settings page (browser storage). `additionalFields` is
the exception: local file entries and Settings entries are merged, so a field
listed there is always requested.

Reload the extension at `chrome://extensions` after editing it.

### Field mapping, and why it matters

Jira assigns custom field IDs per site, so `customfield_10016` is story points
on one instance and something else entirely on the next. Nothing here hardcodes
those IDs: the app resolves them by field name (Settings → Field mapping →
**Discover from Jira**) and falls back to manual entry when a site uses unusual
names. An unresolved role means the related column simply shows no value.

### Team roster

Defines who counts as "the team": it drives the **Team Only** filter,
display-name overrides, and later standup and planning. Three ways to populate
it, in Settings:

| Method | Needs | Finds |
|---|---|---|
| Harvest from boards | nothing beyond normal access | anyone with an assigned issue on your boards |
| Search directory | Jira "Browse users and groups" permission | anyone on the site |
| Add manually | nothing | anyone, by account ID or email |

Directory search 403s on sites that restrict user browsing to admins — that is
expected, and the UI says so. Adding by **account ID** (the last path segment of
a Jira profile URL) always works. Adding by **email** stores the person as
`unlinked`: they show in the roster but cannot be matched to issues until their
account ID is filled in, which happens automatically on the next harvest.

Per member you can set a display-name override (used everywhere in place of the
Jira name), an emoji, an avatar override, a Slack handle, and an active flag.
Inactive members are kept but ignored by filters.

The Slack handle is only used to address people in the standup parking-lot
digest, so type it exactly as Slack's @-autocomplete shows it — **spaces and
accents included**. The old `@lowercase-no-spaces` rule belonged to Slack's
legacy *username*, retired in 2017; what mentions match now is the display name,
which in directory-provisioned workspaces is usually someone's full name.

**Team Only** in the filter bar hides work assigned outside the roster. It keeps
unassigned issues visible on purpose — those are usually the team's problem too.
People outside the roster are labelled `· outside team` in the assignee filter
rather than silently dropped.

The roster lives in `chrome.storage.local` on that device only, because it holds
other people's personal data. It is never written to synced storage, never
belongs in `config.local.json`, and is excluded from config exports unless you
tick the box.

### Issue detail

Click any issue key (or a Kanban card, or a Gantt child bar) to open the issue in
a drawer that slides in from the right. **⌘/Ctrl-click, middle-click, or "open
link in new tab"** opens the same detail as a full page instead — that page is
linkable and reloadable, the drawer is not.

The drawer covers the view, not the window: the nav and footer keep their bands
and stay usable, and in standup so do the speaker's clock and the parking lot.
Escape closes it, as does clicking the dimmed area or navigating away.

Shows the header (key, status, type, parent, project, links out to Jira),
assignee and reporter, description, start/due dates, story points, sprint,
linked issues grouped by relationship, sub-tasks, and comments.

**Commenting** is the one thing the app writes back to Jira. Type in the reply
box and press **Comment** or ⌘/Ctrl+Enter. Plain text only: blank lines become
paragraphs, single newlines become line breaks, and any markup you type is
posted literally rather than half-interpreted. Scoped-token setups need
`write:comment:jira`; unscoped tokens inherit your own Jira permissions.

Descriptions and comments arrive from Jira as HTML written by whoever can
comment on the issue, so everything passes through an allowlist sanitiser
(`js/sanitize.js`) before it reaches the page — scripts, iframes, forms, event
handlers, inline styles and non-http(s) URLs are all removed.

Pull requests, branches and commits are **not** shown: Jira has no public API
for them. That's tracked in the roadmap's deferred backlog, to be built against
the GitHub API instead.

### Sprint dashboard

Press `d` or the SPRINT tab. Sprint name, goal, dates and working days left, then
a KPI row: points complete, issues done, carried in, added after start, projected
carry-out, and a hygiene score that links through to the Monitor tab.

Below that: a burndown, sprint progression by status, and breakdowns by board and
by person. Everything is derived from data the other views already fetched, so
opening the tab normally costs no Jira requests at all.

**About the burndown.** Jira has no public API for what a sprint looked like on a
past day. The two available routes are a changelog request *per issue* (60 issues
= 60 requests, every time you open the tab) and an undocumented internal endpoint.
So ButterJira records its own aggregate once a day and builds history forward.
That means:

- the burndown appears on the **second day** you use the tab, not the first;
- sprints that ran before you installed the extension have no history;
- history is device-local and not part of a config export.

The chart says which of these applies instead of drawing a line it can't support.

Two figures are approximations, and the UI marks them: **added after start** is
counted from issue creation date, so an older issue dragged into the sprint
mid-flight isn't caught; **hygiene** is a coarse share of issues with no finding,
meant as a nudge rather than a KPI to optimise.

Sub-tasks are excluded from point totals — their estimates duplicate the parent
story's — and the excluded count is shown rather than hidden.

### Standup mode

Press `s` or the STANDUP tab. Pick who's in today, set each person's minutes
(2 by default), and hit start: five-second countdown, then each person's sprint
board in a randomised order, one at a time, full-screen.

- The countdown cue is timed to *finish* as the clock hits zero, using the
  actual length of the audio file — swap in your own and it still lands right.
- Running over counts up in red rather than cutting anyone off. `+1 min` adds
  time without disturbing the clock.
- Reload mid-standup and you get "Resume — same order as before": the order
  comes from a stored seed, so it's reproducible.
- Cards drag between columns on the speaker's board, exactly as they do on
  Kanban — "that one's actually done" gets fixed in the meeting rather than
  after it.
- A parking-lot box is saved as you type and appears in the end summary, with
  copy and download buttons.
- The summary shows actual vs planned time per person and who never got reached.

Sound cues live in `assets/sfx/` (`dun-dun-dun.mp3` at the start,
`countdown.mp3` before each handover). They're bundled rather than fetched — the
extension's CSP rules out remote media, and a standup shouldn't lose its cues to
a slow network. Replace the files to change the sounds; the toggle under the
start button mutes them.

Needs a team roster (Settings → Team roster) — that's where the participant list
comes from.

### Monitor tab

Four hygiene checks over the sprint, derived from data the other views already
fetch — no extra Jira requests:

| Check | Asks |
|---|---|
| Unassigned | Who is picking this up? |
| No epic parent | Which piece of work does this belong to? |
| No due date | When is this expected to land? |
| No story points | How big is this? |

Every check skips epics and anything already done. All but "unassigned" also
skip sub-tasks: a sub-task hangs off a story, so it has no epic of its own and
inherits its parent's dates and estimate — flagging them all would just be
noise. The exclusions are printed next to each check rather than left implicit.

Issues that trip more than one check are ranked under **Fix these first**, since
one edit clears several findings. A check with no field to read (for example
story points on a site where that field isn't mapped) reports itself as
unavailable instead of flagging every issue.

Scope defaults to the current sprint; switch to **All Issues** to include the
backlog. **Team Only** and the scope choice are both remembered.

### Branding

`assets/brand/` is gitignored apart from its `.gitkeep`. Drop a logo there,
point **Branding → Organisation logo path** at it (e.g.
`assets/brand/org-logo.png`), and it appears in the nav bar. Single-colour
wordmarks are inverted automatically in light theme. With nothing configured,
the product logo stands alone.

## Permissions

- `storage` — configuration and cached Jira responses
- `https://*.atlassian.net/*` — granted up front, covers any Jira Cloud site
- `optional_host_permissions` — any other host (Jira Data Center on a custom
  domain) is requested at setup time, only for the origin you enter

## Keyboard shortcuts

| Key | View |
|---|---|
| `b` | Backlog |
| `r` | Roadmap (Gantt) |
| `k` | Kanban |
| `m` | Monitor |
| `s` | Standup |
| `d` | Sprint dashboard |
| `Esc` | Close the issue drawer |

During a standup the keyboard belongs to the session: `Space` pauses, `→` moves
to the next person, `Esc` ends it. View shortcuts are suspended so you can't
navigate away mid-standup.

## Layout

```
app.html            # main app shell
settings.html/.js   # configuration UI
issue.html          # full-page issue detail (new-tab target)
background.js       # service worker: opens the app tab
js/config.js        # all instance-specific config lives here
js/credentials.js   # device-local token storage + expiry lifecycle
js/team.js          # team roster: storage, display names, team-only filter
js/monitor.js       # sprint hygiene checks (pure derivation)
js/dashboard.js     # sprint aggregation (pure derivation)
js/snapshots.js     # daily sprint snapshots — the burndown's history
js/charts.js        # inline SVG chart primitives, no libraries
js/standup.js       # standup session: order, phases, timing (DOM-free)
js/sfx.js           # bundled sound cues
js/sanitize.js      # allowlist sanitiser for Jira-rendered HTML
js/adf.js           # Atlassian Document Format <-> text (comment posting)
js/roster-ui.js     # roster editor for the Settings page
js/migrations.js    # numbered storage migrations
js/portable.js      # config export/import
js/api.js           # Jira REST client (read-only)
js/utils.js         # board/field/date/theme helpers + response cache
js/router.js        # hash routing, setup flow, board picker
js/components/      # nav bar, filter bar, re-auth prompt, issue detail, board
js/views/           # dashboard, backlog, gantt, kanban, monitor, standup
css/                # one stylesheet per view
assets/sfx/         # standup sound cues
libs/               # vendored frappe-gantt
scripts/            # jira-smoke.js, manual smoke checklist
```

No build step — plain ES modules, loaded directly by Chrome.

## Checks

Config-layer unit checks — no dependencies, no network, no browser:

```bash
node scripts/test-config.mjs       # config layer, field discovery     (68 checks)
node scripts/test-credentials.mjs  # migrations, tokens, export/import (82 checks)
node scripts/test-team.mjs         # roster, display names, filtering  (84 checks)
node scripts/test-monitor.mjs      # hygiene checks, exclusions        (54 checks)
node scripts/test-issue.mjs        # sanitiser, ADF conversion         (86 checks)
node scripts/test-standup.mjs      # session timing, order, resume    (105 checks)
node scripts/test-dashboard.mjs    # aggregation, burndown, geometry  (123 checks)
```

`test-config.mjs` covers URL normalisation, the defaults → `config.local.json` →
storage resolution order, field discovery against both company-managed and
team-managed Jira naming, and the field accessors.

`test-credentials.mjs` covers storage migrations (including the legacy
sync→local credential move), token expiry arithmetic and wording, and
export/import validation.

`test-team.mjs` covers roster storage and deduplication, display-name
resolution, the team-only filter, linking members added by email, and
roster export/import opt-in.

`test-monitor.mjs` covers each hygiene check's type exclusions, done-detection
via `statusCategory`, both Jira epic-linking styles, muting, and the
unavailable-check path.

`test-issue.mjs` covers the sanitiser — tag/attribute/URL policy plus the
element walk against a DOM stub, including obfuscated `javascript:` URLs, event
handlers and script stripping — and ADF conversion in both directions.

`test-standup.mjs` covers the standup session with injected clocks: seeded
ordering, phase transitions, pause arithmetic (including multiple pauses),
overrun, resume-after-reload, and the board grouping shared with Kanban.

`test-dashboard.mjs` covers working-day arithmetic, carry-in and scope-change
detection, the per-status/board/person buckets, snapshot storage and pruning, and
the burndown series — plus chart geometry against a DOM shim, so a NaN coordinate
or a label placed outside the viewBox fails the suite rather than the eye.

`scripts/SMOKE-CHECKLIST.md` is the manual pass for anything involving the UI.

### Checking a Jira site from the CLI

```bash
JIRA_SITE=your-org.atlassian.net \
JIRA_EMAIL=you@example.com \
JIRA_TOKEN=your_api_token \
JIRA_PROJEACME=ABC,DEF \
node scripts/jira-smoke.js
```

Verifies credentials, resolves field roles, lists boards, and exercises search
pagination. Useful for telling "my token is dead" apart from "the extension is
broken". It reads only from the environment — no credentials on disk.

## Data handling

Your API token is stored in `chrome.storage.local` — on that device only. It is
deliberately kept out of `chrome.storage.sync`, which would replicate it in
plaintext through your Google account to every signed-in browser. To move to
another machine, use **Settings → Export config** (the token is excluded unless
you tick the box) or just paste a fresh token there.

**Settings → Forget token on this device** removes the credential and keeps
everything else — useful on a shared machine.

The team roster is also `chrome.storage.local` only — it holds colleagues'
names, emails and account IDs, so it never goes into synced storage and is
excluded from exports unless you opt in.

Jira responses are cached in `chrome.storage.local` for five minutes. Nothing is
sent anywhere except your own Jira site.

### Token expiry

Atlassian does not expose a token's expiry date over the API, so the app records
one at setup (creation + 365 days) and treats it as a reminder you can correct in
Settings. From 14 days out you get a once-a-day banner. If a token dies anyway,
a 401 opens a prompt asking for the new token alone — boards, field mapping and
branding are untouched.

## Extension identity

`manifest.json` includes a `key`, which pins the extension ID to
`bcbejonnfmamlddbojnjjgdabndpicff`. Without it Chrome mints a new ID whenever the
extension is removed and re-added, and because `chrome.storage` is namespaced per
ID, your settings would appear to vanish. The private half of that keypair is not
in the repo and is not needed for loading unpacked.

**Before uploading to the Chrome Web Store, delete the `key` field** — the store
assigns its own identity, and the stored settings on your dev install will not
carry over to the listed version.

## Storage migrations

Anything that changes the shape of stored data gets a numbered migration in
`js/migrations.js` rather than a "clear your settings" note. Migrations are
idempotent, run once per device before any config read, and refuse to touch
storage written by a newer build. Bump `SCHEMA_VERSION` and add an entry when you
change the shape.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — issue detail, monitoring, standup mode, sprint
the sprint planner is planned. M0–M7 are done: hygiene, whitelabelling,
durable identity/config, the team roster, the monitoring tab, issue detail,
standup mode, and the sprint dashboard.

## Licence

Not yet chosen — add one before making this repo public if you want others to
be able to use it.
