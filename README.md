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
Jira name), an emoji, an avatar override, and an active flag. Inactive members
are kept but ignored by filters.

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
a slide-over drawer. **⌘/Ctrl-click, middle-click, or "open link in new tab"**
opens the same detail as a full page instead — that page is linkable and
reloadable, the drawer is not.

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
| `Esc` | Close the issue drawer |

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
js/sanitize.js      # allowlist sanitiser for Jira-rendered HTML
js/adf.js           # Atlassian Document Format <-> text (comment posting)
js/roster-ui.js     # roster editor for the Settings page
js/migrations.js    # numbered storage migrations
js/portable.js      # config export/import
js/api.js           # Jira REST client (read-only)
js/utils.js         # board/field/date/theme helpers + response cache
js/router.js        # hash routing, setup flow, board picker
js/components/      # nav bar, filter bar, re-auth prompt, issue detail
js/views/           # backlog, gantt, kanban, monitor
css/                # one stylesheet per view
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

`scripts/SMOKE-CHECKLIST.md` is the manual pass for anything involving the UI.

### Checking a Jira site from the CLI

```bash
JIRA_SITE=your-org.atlassian.net \
JIRA_EMAIL=you@example.com \
JIRA_TOKEN=your_api_token \
JIRA_PROJECTS=ABC,DEF \
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
planner, and dashboards are planned. M0–M5 are done: hygiene, whitelabelling,
durable identity/config, the team roster, the monitoring tab, and issue detail.

## Licence

Not yet chosen — add one before making this repo public if you want others to
be able to use it.
