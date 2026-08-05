# ButterJira

A Chrome extension that gives you Gantt (roadmap), Backlog, and Kanban views
across several Jira boards at once, in one tab, with your own status grouping.
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

## Layout

```
app.html            # main app shell
settings.html/.js   # configuration UI
background.js       # service worker: opens the app tab
js/config.js        # all instance-specific config lives here
js/api.js           # Jira REST client (read-only)
js/utils.js         # board/field/date/theme helpers + response cache
js/router.js        # hash routing, setup flow, board picker
js/components/      # nav bar, filter bar
js/views/           # backlog, gantt, kanban
css/                # one stylesheet per view
libs/               # vendored frappe-gantt
scripts/            # jira-smoke.js, manual smoke checklist
```

No build step — plain ES modules, loaded directly by Chrome.

## Checks

Config-layer unit checks — no dependencies, no network, no browser:

```bash
node scripts/test-config.mjs
```

Covers URL normalisation, the defaults → `config.local.json` → storage
resolution order, field discovery against both company-managed and team-managed
Jira naming, and the field accessors. Run it after touching `js/config.js`,
`js/utils.js`, or the discovery code in `js/api.js`.

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

Your API token is stored in `chrome.storage.sync`, which replicates it through
your Google account to your signed-in devices. Moving it to device-local
storage is [ROADMAP.md](ROADMAP.md) M2. Jira responses are cached in
`chrome.storage.local` for five minutes. Nothing is sent anywhere except your
own Jira site.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — issue detail, monitoring, standup mode, sprint
planner, and dashboards are planned; M0/M1 (this whitelabelling work) are done.

## Licence

Not yet chosen — add one before making this repo public if you want others to
be able to use it.
