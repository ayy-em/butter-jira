# butter_jira

A browser extension that gives you Gantt (roadmap), Backlog, Kanban, and sprint
hygiene views across several Jira boards at once, in one tab, with your own
status grouping.
Because the other one sucks.

Runs on **Chrome, Firefox and Edge**. Works against any Jira Cloud site —
nothing about your instance is baked into the code. Board IDs, project keys,
custom field IDs, and branding all come from configuration you supply at setup.

## Install on Chrome — step by step

**No command line, no developer tools, nothing to build.** You download one
file, unzip it, and point Chrome at the folder. It takes about two minutes, and
you need nothing installed beyond Chrome itself (version 111 or newer — anything
from 2023 onwards).

There are two halves: getting the extension into Chrome, then connecting it to
your Jira. Do them in order.

### Part 1 — Put the extension in Chrome

**1. Download it.** Go to the
[Releases page](https://github.com/ayy-em/butter-jira/releases) and, under the
newest release, download the file named **`chrome-<version>.zip`** (for example
`chrome-0.5.0.zip`). Ignore the Firefox and Edge files, and ignore the two
"Source code" links — those are not what you want.

**2. Unzip it.** Double-click the downloaded file. You will get a folder with a
name like `chrome-0.5.0`.

**3. Move the folder somewhere permanent.** Your Documents folder is fine.
Anywhere except Downloads.

> **This matters more than it sounds.** Chrome does not copy the extension in —
> it reads it from this folder every time it starts. If you later delete the
> folder, empty your Downloads, or move it elsewhere, the extension stops
> working. Put it somewhere you will not tidy up.

**4. Open Chrome's extensions page.** Copy `chrome://extensions` into the
address bar and press Enter. (Clicking a link to it does not work — Chrome
blocks that. Type or paste it.)

**5. Turn on Developer mode.** There is a switch labelled **Developer mode** in
the *top right* of that page. Click it on. Three new buttons appear below.

**6. Click "Load unpacked"** — the leftmost of the three new buttons.

**7. Pick the folder.** In the file chooser, select the folder from step 3 — the
one that has a file called **`manifest.json`** directly inside it. Select the
*folder itself*; do not open it and do not select a file inside it. Then click
**Select** / **Open**.

butter_jira now appears in your list of extensions.

**8. Pin it to your toolbar** so you can find it again. Click the small
jigsaw-piece icon to the right of Chrome's address bar, find butter_jira in the
list, and click the pin next to it. Its icon now sits in the toolbar.

**9. Click the butter_jira icon.** The app opens in a new tab.

### Part 2 — Connect it to your Jira

The app opens on a short form asking for three things.

**1. Jira site URL.** The address you normally use for Jira, without the
`https://`. If your Jira lives at `https://acme.atlassian.net/jira/...`, type
`acme.atlassian.net`.

**2. Email.** The email address you sign in to Jira with.

**3. API token.** This is *not* your Jira password — it is a separate key you
generate, and it is what lets the extension read your boards.

- Click **"Need an API token? Create one here"** on the form. Atlassian's own
  page opens in a new tab.
- Click **Create API token**, give it any name you like (`butter_jira` is a
  fine choice), and confirm.
- Atlassian shows the token **once**. Click **Copy**.
- Go back to the butter_jira tab and paste it into the API token box.

If Atlassian offers you a choice, take the **unscoped** token — it simply
inherits whatever you can already do in Jira yourself, so there is nothing to
configure. Tokens expire (a year by default) and you make a new one the same way.

> Your token stays on the computer you typed it into. It is deliberately kept
> out of Chrome's account sync, so it is never copied to your other machines or
> to Google. See [Data handling](#data-handling).

**4. Click Connect.** Chrome may ask permission to access your Jira address —
say yes, it is how the extension reads anything at all. The extension then
checks your details, works out this Jira's custom field IDs on its own, and
shows you every board your account can see.

**5. Tick the boards you care about** and click **Save**. You can change this
later in Settings.

That's it — the Backlog opens on your own data.

### If something goes wrong

| What you see | What it means |
|---|---|
| *"Invalid credentials — check email and token"* | Almost always a mistyped or expired token, or the wrong email. Generate a fresh token and paste it again — do not retype it by hand. |
| *"Site reachable but Jira API not found"* | The URL is not a Jira site. Check for a typo, and leave off any `/jira/...` path — just the host. |
| *"Connection failed"* | Network or VPN. If your Jira is only reachable on a company network, connect to it first. |
| *"No boards are visible to this account"* | Your Jira account can see projects but not boards. Ask whoever administers your Jira for board access. |
| Chrome warns about *"extensions in developer mode"* on startup | Expected, and harmless — it is how Chrome treats every extension not installed from its store. Keep the extension enabled. |
| The extension icon disappeared or shows an error after a restart | The folder from step 3 was moved or deleted. Put it back, or repeat Part 1. |

Chrome keeps the extension across restarts and updates. To move to a newer
version, download the new zip, unzip it over the old folder, and press the
refresh arrow on butter_jira's card in `chrome://extensions`. Your settings and
boards survive — they live in Chrome's storage, not in the folder.

## Install on Firefox and Edge

Both are packaged in each release the same way Chrome is: download
**`firefox-<version>.zip`** or **`edge-<version>.zip`** from the
[Releases page](https://github.com/ayy-em/butter-jira/releases) and unzip it
somewhere permanent, exactly as in Part 1 above. Their manifests differ from
Chrome's in ways one file cannot hold, which is why they are separate downloads
— see [Browser targets](#browser-targets).

- **Edge**: `edge://extensions` → turn on **Developer mode** → **Load unpacked**
  → select the unzipped folder. Then Part 2 above is identical.
- **Firefox**: `about:debugging` → *This Firefox* → **Load Temporary Add-on** →
  select the `manifest.json` file inside the unzipped folder (Firefox asks for
  the file, not the folder). Note the word *temporary*: Firefox drops it when
  you quit, and a permanent install needs a signed build from
  addons.mozilla.org.

## Install from source (developers)

**Chrome needs no build step: the repo directory *is* the extension.**

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repo directory.
4. Click the butter_jira toolbar icon.

Firefox and Edge need a package first:

```bash
node scripts/build.mjs                  # writes dist/chrome, dist/firefox, dist/edge
node scripts/build.mjs --zip            # …and a zip per target, for releases and store uploads
node scripts/build.mjs --local-assets   # …including your own avatars and brand marks
```

`--local-assets` is for an install on your own machine. It refuses to combine
with `--zip`: a store package must not carry colleagues' photographs.

## Moving between browsers

**A config export is browser-neutral.** Nothing in the file names Chrome,
Firefox or Edge, so an export from one imports into any of the others —
Settings → Backup & transfer → Export, then Import on the far side. Both tokens
travel if you tick their boxes; neither does otherwise.

Two things to know before you rely on it:

- **Avatar overrides are paths, not images.** A roster entry pointing at
  `assets/avatars/sam.png` needs that file to exist in the *target* install.
  Chrome loaded unpacked from the repo has them; a built package does not, since
  `scripts/build.mjs` excludes `assets/avatars/` and `assets/brand/` so a store
  upload cannot carry photographs of colleagues. For a personal Firefox or Edge
  install, build with `--local-assets` and they come along. Without it, those
  members fall back to their Jira picture — nothing breaks, but nobody tells you.
- **Firefox's `storage.sync` needs a Firefox Account** to actually sync between
  machines. Without one it still works, just as device-local storage. That
  affects syncing, not importing.

Delete the export file once the other browser has it. It is a plaintext
credential if you ticked either token box.

## Browser targets

One codebase, three packages. Nothing is compiled — `scripts/build.mjs` copies
the same source files into each `dist/<target>/` and writes the only file that
genuinely cannot be shared: the manifest.

| | Chrome | Firefox | Edge |
|---|---|---|---|
| Background | `service_worker` | `scripts` (event page) | `service_worker` |
| Extension ID | pinned via `key` | `browser_specific_settings.gecko.id` | assigned by the store |
| Minimum | Chrome 111 | Firefox 115 | Chromium 111 |

Those three differences are each load-bearing, and each fails in a way you would
otherwise only discover at submission:

- **Firefox MV3 has no service-worker background.** It runs a non-persistent
  event page, so `background.scripts` is not a stylistic preference.
- **`key` is a Chrome mechanism.** It pins the ID so an unpacked extension keeps
  its storage across a remove-and-re-add. Firefox and the Edge store both reject
  a package carrying one, so the build strips it from both.
- **Firefox needs a gecko id for `storage.sync` to work at all.** Without a
  stable add-on ID there is nothing to sync against, and every configuration
  write goes quietly nowhere.

`manifest.base.json` holds everything the three agree on;
`manifest.{chrome,firefox,edge}.json` are the overlays. Edit those, never the
generated `dist/*/manifest.json`. The repo-root `manifest.json` is the Chrome
output, regenerated by the build so unpacked loading keeps working and cannot
drift from the base.

**No `chrome.*` in application code.** Everything goes through `js/browser.js`,
which resolves `browser` (Firefox, promise-native) or `chrome` (Chromium) once
and exposes one promise-shaped surface. `scripts/test-browser.mjs` runs the real
modules against a Firefox-shaped global with **no `chrome` global present**, so
a stray `chrome.` reference fails a test rather than a Firefox user.

## First run

Walked through click by click in [Part 2](#part-2--connect-it-to-your-jira)
above; this is the same thing as a reference. The setup screen asks for three
things:

| Field | Example | Notes |
|---|---|---|
| Jira site URL | `your-org.atlassian.net` | Scheme optional; Data Center hosts work too |
| Email | `you@example.com` | The Atlassian account the token belongs to |
| API token | — | Create one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |

On connect it verifies the credentials, resolves this site's custom field IDs
automatically, then offers every board your account can see so you can pick the
ones you care about. No board IDs to look up by hand.

A Data Center host on a custom domain is requested as an optional origin at this
point, which is why Chrome may show a permission prompt — `*.atlassian.net` is
granted in the manifest up front, anything else has to be asked for.

### API tokens

Use an **unscoped** API token — it inherits your own Jira permissions and
needs no scope selection. Tokens expire (1–365 days, one year by default), and
an expired token shows up as a 401.

If you would rather use a **scoped** token, note that scoped tokens only work
against `https://api.atlassian.com/ex/jira/{cloudId}` rather than your site URL,
and need these read scopes: `read:jira-user`, `read:jira-work`,
`read:sprint:jira-software`, `read:board-scope:jira-software`,
`read:issue-details:jira`, `read:jql:jira`.

Editing and creating issues need write scopes on top of those:
`write:jira-work` (or the granular `write:issue:jira`), plus
`write:comment:jira` for commenting. An unscoped token needs nothing added — it
already has whatever you can do in Jira yourself. Either way the app only writes
when you ask it to: dragging a card, editing a field, or creating an issue.

## Configuration

Everything is editable from the Settings page (⚙ in the nav bar):

- **Jira site URL** — switch instances without touching code
- **Boards in scope** — import from Jira, or add board ID + label + project key manually
- **Status column grouping** — map your workflow's statuses onto Kanban columns
- **Team roster** — who is on the team, with display-name overrides and emoji
- **Monitoring checks** — mute any of the four hygiene checks
- **GitHub sync** — optional; host, org, and the explicit list of team repos
- **Field mapping** — which custom field holds story points, start date, epic link, epic name, sprint
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

Credentials are not configurable here, by design — neither the Jira token nor
the GitHub one. `config.local.json` is a file in the repo directory; tokens
belong in device-local browser storage.

Reload the extension at `chrome://extensions` after editing it.

### Field mapping, and why it matters

Jira assigns custom field IDs per site, so `customfield_10016` is story points
on one instance and something else entirely on the next. Nothing here hardcodes
those IDs: the app resolves them by field name (Settings → Field mapping →
**Discover from Jira**) and falls back to manual entry when a site uses unusual
names. An unresolved role means the related column simply shows no value.

**Epic name** is the one role that is optional by design. Company-managed Jira
gives an epic a short label of its own — "Checkout rewrite" rather than the full
summary — and that is what the Backlog's Epic column shows. Team-managed
projects have no such field, so the column falls back to the epic's summary, and
then to its key.

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
Jira name), an emoji, an avatar override, a Slack handle, a GitHub login, and an
active flag. Inactive members are kept but ignored by filters.

The Slack handle is only used to address people in the standup parking-lot
digest, so type it exactly as Slack's @-autocomplete shows it — **spaces and
accents included**. The old `@lowercase-no-spaces` rule belonged to Slack's
legacy *username*, retired in 2017; what mentions match now is the display name,
which in directory-provisioned workspaces is usually someone's full name.

**Team Only** in the filter bar hides work assigned outside the roster. It keeps
unassigned issues visible on purpose — those are usually the team's problem too.
People outside the roster are labelled `· outside team` in the assignee filter
rather than silently dropped.

The roster lives in device-local extension storage only, because it holds
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
linked issues grouped by relationship (creatable and removable), sub-tasks, and
comments.

**Assignee, due date and story points are editable in place.** Click the value,
type or pick, and press Enter — or click away, which also saves, because losing
typing to a stray click is worse than an unintended save you can undo. Escape
cancels. The change appears immediately and the toast that confirms it carries an
**Undo** for as long as it is on screen; if Jira refuses the write, the old value
comes back and the toast says which field it objected to and why.

Three of the six meta fields are deliberately *not* editable. Reporter is a
permission most accounts do not have, start date only makes sense to edit
alongside the roadmap's dates, and moving an issue between sprints needs the
board's sprint list to choose from — the write layer supports the move, and the
sprint planner is where it gets a UI.

**+ Sub-task**, on the Linked issues heading, opens the create form with the
parent fixed. The sub-task issue type is discovered from your project rather
than matched by name, so it works on a site where it is called something else,
or in another language; a project with sub-tasks switched off says so instead of
offering a form that cannot be submitted. After creation the parent's sub-task
list is re-read from Jira rather than patched from the form.

**+ Link**, beside it, adds a relationship to another issue — blocks, duplicates,
relates to, or whatever your site calls its own.

- **The relationships are read from your Jira** (`/rest/api/3/issueLinkType`),
  never written into the app. A site can rename them, add its own or delete the
  ones you assumed, so a hardcoded list would offer relationships that fail on
  creation. Same rule as field discovery and the sub-task type.
- **Direction is a choice of phrase, not a toggle.** "blocks" and "is blocked
  by" are two entries over one type, because that is how you say what you mean;
  a symmetric type like "relates to" appears once. The sentence the link will
  make is shown before you commit it, in the direction you picked — a link
  created backwards does not fail, and reads wrong only on the *other* issue.
- **The other issue is searched for, not typed.** Two characters start a
  search; an issue key finds that issue, anything else searches summaries. What
  is already linked, and the issue itself, are not offered.
- **Removing a link asks first.** The ✕ on a link row is the app's only DELETE,
  and Jira has no undo for it, so the confirm names both issues and the
  relationship rather than saying "remove the link". Sub-task rows carry no ✕:
  a sub-task is a parent/child field, not a link, and there is nothing to remove.

Both writes re-read the issue afterwards rather than patching the list — Jira
answers a link create with an empty body, and the second issue in a link is one
this view does not own.

**Commenting.** Type in the reply box and press **Comment** or ⌘/Ctrl+Enter.
Plain text only: blank lines become paragraphs, single newlines become line
breaks, and any markup you type is posted literally rather than
half-interpreted.

Descriptions and comments arrive from Jira as HTML written by whoever can
comment on the issue, so everything passes through an allowlist sanitiser
(`js/sanitize.js`) before it reaches the page — scripts, iframes, forms, event
handlers, inline styles and non-http(s) URLs are all removed.

Pull requests, branches and commits are **not** shown *on the issue*: Jira has
no public API for them, and correlating GitHub work back to an issue key is its
own problem — that's still in the roadmap's deferred backlog. GitHub sync does
show pull requests per *person* during standup; see below.

### Roadmap (Gantt)

Press `r` or the ROADMAP tab. Epics as bars over a time axis, with their children
one level down.

- **It opens on today**, centred, with a red line marking now. frappe-gantt draws
  a today marker of its own but only in Day view, which is not the view a roadmap
  is read in — so in Month, Week and Quarter there was nothing marking the
  present at all. Changing the zoom re-centres; expanding an epic does not, so
  the chart never jumps while you are reading it.
- **Bars are coloured by how they are tracking against their own due date** —
  green with more than a week to go, amber inside the week, red past the date and
  still open, grey once done. A finished epic is deliberately not green: it has
  stopped being something to watch, and colouring it as "fine" makes a board of
  mostly-finished work read as uniformly healthy. An epic with no due date says
  nothing rather than guessing.
- **Board identity moved to the bar's outline**, so one bar carries both signals.
- **Clicking a bar opens the issue** — the same drawer the Kanban cards and the
  standup board open. Expanding an epic's children is the caret beside it, which
  is a different action and used to be the only one available.

### Creating issues

**+ New issue** on the Backlog toolbar, or "Create issue" in the command palette
(⌘/Ctrl+K) — both open the same panel, in the same drawer the issue detail uses.

**The form is not written into the app; it is read from your Jira.** Pick a
project and an issue type and the panel asks Jira which fields that combination
has and which of them are required
(`/rest/api/3/issue/createmeta/{project}/issuetypes/{type}`), then builds the
rows from the answer. So a project that insists on a component, a team, or an
acceptance-criteria field shows those rows, and one that wants nothing but a
summary shows one box. Switching issue type re-reads the layout, because a Bug
and a Story genuinely do ask different questions on most sites.

Consequences of doing it that way, all of them deliberate:

- **Nothing is hardcoded**, including the field ids. Story points, sprint and
  epic link are matched by their Jira field *types*, not by name or by a
  `customfield_10016` baked into the source.
- **A required field of a type the form cannot render stops the form**, naming
  the field, rather than posting without it and showing you Jira's complaint
  about something you were never asked for. Optional fields in that position are
  listed as left unset, so the form never quietly pretends to be all of Jira's.
- **A refused create is attributed.** Jira reports what was wrong per field, and
  those messages land on the rows they belong to; anything it could not attribute
  goes to a toast.
- Sprint and epic dropdowns are filled from the board rather than from
  createmeta, which does not carry them.

The panel writes nothing else: it posts one issue, drops that board's cached
lists, and offers to open what it created.

### Sprint dashboard

Press `d` or the SPRINT tab. Sprint name, goal, dates and working days left, then
a KPI row: points complete, issues done, carried in, added after start, projected
carry-out, and a hygiene score that links through to the Monitor tab.

Below that: a burndown, **what changed since the freeze**, sprint progression by
status, and breakdowns by board and by person. Everything is derived from data
the other views already fetched, so opening the tab normally costs no Jira
requests at all.

At the foot of the view, **delivery by person** — tickets assigned, how many are
in review or done, points planned, points in review or done, that last pair as a
share, and with GitHub sync on, PRs opened and lines to main over the sprint. It
opens sorted by the share, best first; any heading sorts by its column, and rows
GitHub cannot answer for stay at the bottom either way, because a dash is not a
small number. The `All` row is always last and is computed by the same code as
the rows above it.

A ticket counts as *in review* when the status group it resolves to reads as a
review state, so splitting a dedicated code review column out of "In Review" in
Settings is picked up without a code change. The share is points-based, with
unestimated issues counting as zero, so someone with no estimates shows a dash
rather than 0%.

The two GitHub columns are counted over the sprint's own window — its start date,
or a stated 14-day guess when the active sprint has none — and clamped to how far
back the query reached, which the note under the table says when it happens.
Lines to main is additions plus deletions that reached the default branch —
merged pull requests plus commits pushed straight to it — and only people with a
GitHub login on the roster are counted. The fetch
never blocks the view: the Jira columns render immediately and the GitHub pair
fills in when the window query lands, or shows why it did not.

**About the burndown.** Jira has no public API for what a sprint looked like on a
past day. The two available routes are a changelog request *per issue* (60 issues
= 60 requests, every time you open the tab) and an undocumented internal endpoint.
So ButterJira records its own aggregate once a day and builds history forward.
That means:

- the burndown appears on the **second day** you use the tab, not the first;
- sprints that ran before you installed the extension have no history;
- history is device-local and not part of a config export.

The chart says which of these applies instead of drawing a line it can't support.

**Hygiene** is a coarse share of issues with no finding, meant as a nudge rather
than a KPI to optimise. **Added after start** used to be an approximation too;
with a freeze it is not — see below, and note that the tile says which of the two
it is printing on every load.

Sub-tasks are excluded from point totals — their estimates duplicate the parent
story's — and the excluded count is shown rather than hidden.

### Sprint freeze, and what changed under the plan

The dashboard answers "how much got done". The freeze answers the other question
a sprint review asks: **what changed underneath the plan.**

The first time the tab sees a sprint it records a per-issue snapshot of it — key,
summary, type, status, assignee, estimate, due date, parent, board and sprint —
and from then on the **Since the freeze** panel shows what moved:

- **Crept in**, split in two: issues *created* after the freeze, and issues that
  already existed and were *dragged into* the sprint later. Nothing before this
  could tell those apart.
- **Pulled out** — gone from the sprint, and where to: the backlog, another
  sprint, or gone entirely (deleted and no-longer-visible look the same from
  here, and the wording says so rather than picking one).
- **Re-estimated** — then → now per issue, and the sprint's total point change
  from re-estimation alone, which a burndown cannot separate from work finishing.
- **Due date moved** — then → now, with the direction and the number of days.
- **Re-assigned**, naming both people, and **went backwards** — an issue that was
  Done at the freeze and is not now.
- An **unchanged** count, and a line of arithmetic: frozen − pulled out + crept
  in = the sprint now. The buckets have to reconcile on screen.

It is taken **automatically**, unasked, on the first load of a sprint — history
only accrues forward, and a sprint boundary that passes unfrozen cannot be
reconstructed later. **Freeze now**, on the panel, replaces it for a sprint that
was re-planned; it confirms with what it is about to discard, because there is no
way back to the old one.

**Added after start becomes exact, conditionally.** With a freeze taken on the
sprint's first day the figure is set membership rather than a date comparison,
and the tile says `exact`. With a freeze taken mid-sprint — which is what you get
if you install the extension in week two — it is exact from that day and blind to
what came before, and it says `approx.` and names the day it can see from. With
no freeze it is the old creation-date approximation and says so. Three states,
because a number that silently means different things on different machines is
worse than one that is honestly approximate.

**What it deliberately cannot see.** A freeze compares two points in time, not
the route between them, so an issue that left the sprint and came back reads as
unchanged. Catching that needs a changelog request per issue — 60 issues, 60
requests, every time you open the tab — which is the cost this whole design
exists to avoid. The panel names the blind spot rather than leaving it to be
discovered.

Stored device-local and pruned to the same eight sprints the burndown keeps, from
the same constant, so the two histories cannot end up different lengths. A
60-issue sprint freezes to roughly 22 KB; eight of them, under 200 KB — measured
in `scripts/test-dashboard.mjs` rather than assumed.

### Sprint recap (PDF)

**Generate recap** in the top right of the Sprint Dashboard opens a printable
end-of-sprint document in a new tab — the retro artefact. Pick **Save as PDF** in
the print dialog that follows. There is no PDF library involved and nothing is
rasterised: it is a print stylesheet over the same numbers the dashboard shows,
so the text in the PDF is real text, selectable and searchable, and it prints the
same on every platform.

What is in it, in order:

| Section | Contents |
|---|---|
| Header, on every page | Your organisation's logo — the `org-logo-dark.png` sibling of `brand.orgLogo`, this being a document that always prints on white paper — or your organisation's name, and `Sprint Recap` on the right |
| Title | `Sprint Recap DD.MM.YYYY - DD.MM.YYYY` over the combined window, the calendar and working day counts, then a bullet per active sprint with its name and goal, the bullet coloured by its board |
| The sprint, combined | Four cards — **issues started with**, **crept in**, **in PR + ready**, **LoC in main** — then points done, in review, still open, carried in and review traffic as a single supporting line rather than eight more cards |
| Per person, at a glance | One table across the page, sorted by story-point completion: issues, PRs & done, completion %, SP assigned, SP done & in PRs, SPs complete %, PRs opened, reviews, **moved** and **created** — with an `All` row from the combined figures. The last two come from issue history: *moved* is status changes that person made, *created* is issues they raised inside the window. A caption says what they count, that they describe activity rather than performance, and — where Jira returned only part of an issue's history — that *moved* is a floor rather than a total |
| Where the points ended up | The status split as a labelled bar, with every figure also written out |
| Contribution by person | One full-width row each, in name order: photo, name and GitHub handle on the left, then points planned, points wrapped (with its share), crept in, commits to main (merged pull requests plus commits pushed straight to the default branch) and lines to main, divided evenly across the rest of the row so every figure lines up with the one above it |
| Board by board | One block per board with its sprint name, dates and goal, then issues, done, points, completion, crept in and carried in |
| Tickets in this sprint | Every ticket grouped by board — key, summary, assignee, status, points, and a flag when it crept in or carried over |

**It recaps the sprints the dashboard is showing**, which on retro day are the
ones ending. It rebuilds from the same cached calls the dashboard made rather
than being handed a copy of the screen, so a recap can't be generated from a tab
someone left open yesterday — but equally, once a sprint is *closed* in Jira the
boards have moved on and it will recap the new one.

**Completion is given twice, by issue and by points.** The issue-based figure is
the one that exists for everybody, including anyone whose tickets carry no
estimate at all; the points-based one is a dash rather than a zero when nothing
that person holds is estimated, which is why the table carries both.

**The table is sorted by story-point completion; the cards are not.** The cards
stay in name order, and the heading over them says contribution rather than
performance — a per-colleague number here is retro conversation fuel, not a
score. Sorting the table is a concession to how a table of figures is actually
read, not a ranking of people.

**Content is inset from the background by `--page-gutter` (1.5rem) on every
edge of every page.** Sides come from padding on `.recap`, which repeats down the
page on its own. Top and bottom cannot: padding on a container applies once, at
the start and end of the whole document, so every page but the first and last
would run hard against the edge. They come from the layout table's `thead` and
`tfoot` instead — the two boxes Blink repeats *and* reserves height for on every
printed page. Widening the gutter to 40mm takes the sample recap from three pages
to six, which is how you can tell it is being reserved per page rather than once.

**Every page carries `assets/bgs/pdf-bg.png` as its background.** It is set on
`body`, whose background reaches the page canvas, and tiled at exactly the page
content height (`--page-content-height`, A4 less the `@page` top and bottom
margins) so each page gets one whole copy rather than a third of one. Three
things each made it silently print blank while this was built: `cover` instead of
tiling, `background-attachment: fixed` (which Blink does not paint in print at
all), and declaring the image only inside `@media print` — a print-only
background is not fetched until the print styles apply, and Chrome snapshots the
page without waiting for it. `.recap` names the same URL outside any media query, which both
previews it and gets it into the cache before anyone reaches the print dialog.
On screen it is *stretched* over the sheet rather than tiled: there are no page
boxes there, so a 267mm tile would restart partway down at a seam corresponding
to nothing the reader can see.
The `@page` margins stay white: Blink clips the canvas background to the page
content box. Swap the file to change the look; if you change the `@page` margins,
change `--page-content-height` with them.

**Contribution by person and Tickets in this sprint each start a new page.**
Both are read as a block, and both used to open halfway down a page behind the
tail of the section above. Blink honours a forced `break-before` inside a table
cell, which is where the whole document lives — see the next note.

**The running header is a table `thead`, not a fixed element.** A `thead` is the
only thing Blink both repeats on every printed page *and* reserves vertical space
for; `position: fixed` does the first half only, so from page two onwards it
painted over whatever card had started at the top. If you are looking at a PDF
whose sections seem sliced off at the top of each page, that is the bug this
replaced.

**Chrome's own header and footer** — date, title, URL, page numbers — are drawn
in the page margins and are controlled by the **Headers and footers** checkbox in
the print dialog, not by this app. Untick it for a clean document.

**The Jira half renders first; the GitHub figures fill in.** The pull-request
window pages through 45 days of history *and* 45 days of default-branch commits
per repository — ten sequential requests each in the worst case — which on a busy
month takes a minute or more. So the document goes on screen as soon as Jira
answers, with the GitHub figures showing `…`, and re-renders when they land.
**Printing stays disabled until they do**, so what goes to paper is never a
half-document; the toolbar says why it is waiting.

The deadlines exist to stop an indefinite wait, not to set a target: 60s for Jira,
180s for GitHub. An earlier 30s GitHub deadline was simply wrong — it fired
routinely on real repositories while the dashboard, which sets no deadline at all,
filled in a moment later. A timeout names the service that went quiet and says to
reload or narrow the repository list.

**A partial GitHub answer is reported as partial.** A repository that answers for
pull requests but not for commits — which is what happens when the token lacks
*Contents: read* — or one whose history runs past the page cap, is named in the
note under the per-person section, along with what it means: the figures below it
undercount. The whole point of separating an absent number from a zero is lost if a
partial answer prints as a whole one.

**Failure is never silent.** A failure leaves the print button disabled and
retitles the tab, so a PDF saved anyway is not named as though it worked.

Photos come from the roster's avatar overrides first (`assets/avatars/`, an
untracked folder), then from Jira, then from initials — a person with no photo
does not leave a hole. The GitHub half is awaited here rather than filled in
later, unlike on the dashboard: a document is generated once and kept, so it is
worth a second to have the numbers in it. When GitHub is off, fails, or has
nobody mapped, the affected figures are dashes and the note under the section
says which of the three it was.

**Framing is deliberate.** The per-person section is ordered by name, never by
output, and it is headed "contribution", not "performance" — the same discipline
the roadmap sets for M16 and M14. It is material for a retro conversation, and a
document that ranked colleagues would be read as an assessment however it was
labelled. The footer says so on every copy.

### Standup mode

Press `s` or the STANDUP tab. Pick who's in today, set each person's minutes
(2 by default), and hit start: five-second countdown, then each person's sprint
board in a randomised order, one at a time, full-screen.

- The countdown cue is timed to *finish* as the clock hits zero, using the
  actual length of the audio file — swap in your own and it still lands right.
- **Time closing in is a gradient, not a cliff.** For the first two thirds of a
  slot the screen says nothing. Through the last third the progress bar warms
  from blue through amber and a rim closes in around the whole stage — visible
  from the far end of a room, over nothing anyone is reading. Past time-up the
  rim goes red and starts to pulse, and the pulse gets faster the longer it
  runs; the clock keeps swelling a step every five seconds on top. Nobody is
  cut off, and `+1 min` adds time without disturbing any of it. The point is
  that the speaker feels it coming rather than the facilitator having to
  interrupt.
- Someone who has asked their OS for reduced motion keeps the colour and the
  rim and loses only the pulse.
- Reload mid-standup and you get "Resume — same order as before": the order
  comes from a stored seed, so it's reproducible.
- Cards drag between columns on the speaker's board, exactly as they do on
  Kanban — "that one's actually done" gets fixed in the meeting rather than
  after it.
- A parking-lot box is saved as you type and appears in the end summary, with
  copy and download buttons.
- The summary shows actual vs planned time per person and who never got reached.

**The turn screen is the speaker's board, and everything else gets out of its
way.** Their sprint board takes the width; a slim rail down the right carries
both sets of numbers; their pull requests run along the bottom, one line each,
beside the parking lot. The two panels this replaced — a Jira column and a
GitHub column, each with its own title and tile grid — were between them taking
better than a third of a projected screen to show eight numbers and a list.

**What each person actually did this sprint** shows on the setup row and again in
the rail on their turn: how many tickets they *moved*, *closed*, *picked up* and
*created*, then their GitHub four — open PRs, PRs opened, reviews and comments,
lines to main. Cards on the board open in the drawer rather than navigating away
mid-turn.

This is read from issue history, which rides the sprint request the standup
already makes, so it costs no extra call and needs no GitHub. Two things it is
careful about:

- **It is activity, not performance.** A high count is not a better one — ten
  moves can be one ticket going back and forth between review and rework. Rows
  are ordered by name, there is no sort-by-count anywhere, and the figures carry
  no total or score. They are a prompt for "tell us about ACME-118", not a
  scoreboard.
- **A dash is not a zero.** Jira's history is capped per issue and does not
  paginate, so where a long-running ticket's older changes are missing the
  tooltip says "at least this many" rather than presenting a floor as a total.
  On a site that returns no history at all, the three history-based numbers are
  dashes — "created" still counts, because it does not need history.

Sound cues live in `assets/sfx/` (`dun-dun-dun.mp3` at the start,
`countdown.mp3` before each handover). They're bundled rather than fetched — the
extension's CSP rules out remote media, and a standup shouldn't lose its cues to
a slow network. Replace the files to change the sounds; the toggle under the
start button mutes them.

Needs a team roster (Settings → Team roster) — that's where the participant list
comes from.

### GitHub sync (optional)

The board answers "what is assigned to you". It cannot answer "what have you got
in review", which is where half the day usually went. Turn on **Settings →
GitHub sync** and each speaker's board gains a panel beside it: their open pull
requests, pull requests waiting on *their* review, what they merged since the
last working day, and any GitHub issues assigned to them.

**Four numbers per person**, on the setup screen beside each name and again as
tiles on the speaker's panel:

| Number | What it counts |
|---|---|
| Open PRs | Pull requests they authored that are open right now |
| PRs opened | Pull requests they opened since the sprint started |
| Reviews & comments | Reviews they submitted, plus review and conversation comments they wrote, on *other people's* pull requests, since the sprint started |
| Lines to main | Lines added and removed that reached a repo's default branch since the sprint started — through a merged pull request, or pushed straight to it with no pull request at all |

**Draft pull requests count for nothing.** They are dropped where the response is
read, so a draft appears in no list, no count and no statistic — its reviews and
comments go with it. Work someone has explicitly marked as not ready is not work
a standup chases.

Two definitions are worth knowing before anyone reads anything into these
numbers. Reviews and comments are counted on *other people's* pull requests only:
replying to feedback on your own is authorship, not review. And "lines to main"
means lines that reached the default branch — a merge into a release or feature
branch has not shipped, so it is not counted. Hovering any number says what it
counted and over what window.

**Direct pushes count**, given the token can read them — commit history needs
*Repository → Contents: read*, which the pull-request permission does not imply.
Without it the commit half of the query fails on its own, the pull-request numbers
render as before, and the table says direct pushes are unavailable rather than
reporting a short total as a full one. Not every team works through pull requests
for everything, and counting only merged PRs flattered the people who did while
undercounting everyone else. So the default branch's own commit history is read
as well, and any commit with no pull request behind it is added to that author's
total. `associatedPullRequests` is what keeps the two from overlapping: a commit
that arrived through a pull request is dropped from the commit side, because that
pull request's diff already accounts for it. A commit whose author email is not
linked to a GitHub account cannot be attributed to anyone and is left out rather
than guessed at. The tooltip breaks the total down when any of it was pushed
directly.

The sprint window is the **earliest start date among the active sprints**, so two
boards on staggered sprints still produce one meaning of "this sprint" per table.
A board whose active sprint carries no start date falls back to the last 14 days,
and says so. GitHub is only queried 45 days back, so a sprint longer than that is
counted from where the query stopped — again, stated in the tooltip rather than
quietly.

**You list the repos. Nothing else is read.** The repo list in Settings is an
allowlist, not a filter — the queries are built from exactly those repos, so a
token with access to fifty repos still only ever pulls the ones you typed in. An
empty list means the feature is off, whatever the enable checkbox says. Paste a
bare name (read as belonging to the configured org), `owner/name`, or a repo URL;
one per line.

**Token.** Create a **fine-grained personal access token**, owned by the
organisation, with repository access set to *only* the repos you listed, and
these read-only permissions:

| Permission | Level | Needed for |
|---|---|---|
| Repository → Metadata | Read | Mandatory; implied by any other repo permission |
| Repository → Pull requests | Read | Open PRs, review state, merged PRs |
| Repository → Contents | Read | Lines pushed straight to the default branch — optional |
| Repository → Issues | Read | Open issues assigned to someone |
| Repository → Checks | Read | The "checks failing" state — optional |
| Organisation → Members | Read | The "Match logins from GitHub org" button — optional |

Classic tokens work too (`repo` + `read:org`), but `repo` also grants **write**
access to every private repo you can see, which is a poor thing to leave sitting
in browser storage. Prefer fine-grained. If your org requires approval for
fine-grained tokens, an org owner has to approve yours before it can see
anything — until then private repos answer `404`, not `403`. **Test connection**
checks each repo separately and names the ones that fail, because listing a repo
in Settings does not grant the token access to it.

The token is stored device-local, is never in synced storage, and is in a config
export only when you tick **Include the GitHub token** — a separate box from the
Jira one, because they authenticate different services and a fine-grained PAT
reads every repo it was scoped to, not just the ones listed here. Its expiry is
real rather than guessed: GitHub reports it on every authenticated call, so an
imported token starts as "unknown" and corrects itself on first use rather than
inheriting a stale date from the machine that exported it.

**People are matched by GitHub login**, set per person in the roster. *Match
logins from GitHub org* proposes mappings from the org member list and fills in
only the blanks — every row stays editable, and an ambiguous match is left empty
rather than guessed. Someone with no login simply gets no panel.

**It is never on the critical path.** The fetch starts the moment the STANDUP tab
is clicked — before the view has even loaded — and runs alongside the sprint
issues; the standup begins whether or not it has landed. If it is slow the screen
fills in behind; if it fails, or the token is dead, or GitHub sync is off, the
panel is absent and the standup is exactly what it was before. A line on the
setup card says which of those happened, including how many of the declared repos
could not be read, and whether any repo was too busy for the page cap.

Note the gap that leaves: pull requests by people who aren't on the roster, and
roster members with no GitHub login, are simply not shown and are not counted
anywhere. The panel shows what it can attribute, not everything that exists.

Three queries run: one GraphQL request covering every declared repo for the
lists, and two paged ones per repo for the sprint numbers — 45 days back, capped
at 300 pull requests and 400 default-branch commits per repo. The commit half is
allowed to fail on its own: losing direct pushes is a smaller loss than losing
the repo, so the rest still renders and the gap is named in the failure list
rather than silently zeroed. Both are cached for five minutes and keyed by the repo
list, so leaving and re-entering standup does not re-query, and a second caller
arriving while one is in flight joins it rather than issuing it again. Pull
requests are **not** correlated to Jira issue keys; that is a separate problem
and is in the roadmap's deferred backlog.

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
- `https://api.github.com/*` — granted up front, used only when GitHub sync is
  switched on and only for the repos you list
- `optional_host_permissions` — any other host (Jira Data Center on a custom
  domain, or a GitHub Enterprise Server host) is requested at setup time, only
  for the origin you enter

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

Opening the extension with no view in the URL lands on the **Kanban, filtered to
the current sprint** — the sprint in flight is what people arrive asking about.
An unrecognised view in the URL still falls back to the Backlog, which lists
everything.

During a standup the keyboard belongs to the session: `Space` pauses, `→` moves
to the next person, `Shift+Esc` ends it. View shortcuts are suspended so you
can't navigate away mid-standup.

**Ending takes Shift.** Plain `Esc` is the dismiss gesture for every overlay in
the app and the browser's own way out of fullscreen, which a standup enters when
it starts — so the key you reach for to close a card, dismiss a prompt or leave
fullscreen was also the key that ended the meeting and cleared the session, with
no confirmation and no way back. Overlays now consume their own `Esc`, and
ending early asks first when anyone is still waiting to speak.

## Layout

```
app.html            # main app shell
settings.html/.js   # configuration UI
issue.html          # full-page issue detail (new-tab target)
background.js       # service worker: opens the app tab
js/browser.js       # the only module that knows browser.* from chrome.*
js/config.js        # all instance-specific config lives here
js/credentials.js   # device-local token storage + expiry lifecycle
js/team.js          # team roster: storage, display names, team-only filter
js/monitor.js       # sprint hygiene checks (pure derivation)
js/dashboard.js     # sprint aggregation (pure derivation)
js/recap.js         # sprint recap model (pure derivation)
js/recap-page.js    # the printable recap document
js/snapshots.js     # daily sprint snapshots — the burndown's history
js/freeze.js        # per-issue sprint freeze and the diff over it (DOM-free)
js/charts.js        # inline SVG chart primitives, no libraries
js/standup.js       # standup session: order, phases, timing (DOM-free)
js/sfx.js           # bundled sound cues
js/sanitize.js      # allowlist sanitiser for Jira-rendered HTML
js/adf.js           # Atlassian Document Format <-> text (comment posting)
js/roster-ui.js     # roster editor for the Settings page
js/migrations.js    # numbered storage migrations
js/portable.js      # config export/import
js/api.js           # Jira REST client: reads, field writes, creation, links
js/activity.js      # per-person Jira activity from issue history (DOM-free)
js/issue-edit.js    # field writes: optimistic paint, rollback, undo, bulk
js/issue-create.js  # createmeta -> form spec -> create payload (DOM-free)
js/issue-link.js    # issue links: direction, grouping, picker JQL (DOM-free)
js/utils.js         # board/field/date/theme helpers + response cache
js/router.js        # hash routing, setup flow, board picker
js/components/      # nav, filter bar, re-auth, issue detail, board, drawer,
                    #   click-to-edit cells, create-issue panel, link picker,
                    #   icons, theme toggle, view header
js/components/icons.js       # the app's icon sprite: authored SVG paths
js/components/theme-toggle.js# the sun/moon toggle, drawn in one place
js/components/view-header.js # the header every view puts at the top of itself
js/views/           # dashboard, backlog, gantt, kanban, monitor, standup
css/                # one stylesheet per view, plus nav.css for the shell and
                    #   settings.css for the settings page
assets/sfx/         # standup sound cues
libs/               # vendored frappe-gantt
manifest.base.json  # shared manifest; overlays in manifest.<target>.json
scripts/build.mjs   # copies source + writes each target's manifest
scripts/            # jira-smoke.js, manual smoke checklist
```

No build step — plain ES modules, loaded directly by Chrome.

## Design system

No CSS framework, no icon package, no component library — see
[PRODUCT.md](PRODUCT.md). What holds the screens together instead is a small set
of tokens and two or three shared implementations, all of them in
`css/app.css` and `js/components/`. This section is the reference; each rule also
carries its reasoning where it lives.

**Type.** Every font size in the app is written `calc(<design px> *
var(--font-scale))`. That one number moves all of them together, and it is above
1 because the app is read off a shared screen during standup, where 11px body
copy is unreadable from the far end of the room. **New CSS that hardcodes a pixel
font size is a bug, not a style choice.**

**Colour.** Four accents, an extended palette (purple, yellow, cyan, neutral) and
six status tones, each declared per theme on `:root` / `[data-theme="light"]`.
Two things about them are easy to get wrong:

- **`--on-accent` is the label colour for anything sitting *on*
  `--accent-primary`.** The accents are picked to read against `--bg`, which
  means the text on top of them has to flip per theme: `#fff` on the dark theme's
  accent is 3.21:1 and fails AA at every size a button uses, while near-black on
  the same blue is 5.98:1. Light theme is the other way round.
  `scripts/test-contrast.mjs` enforces it.
- **A colour written as a literal is right in one theme.** `#EF4444` is the dark
  theme's danger colour and 3.76:1 on the light theme's white surface. Both of
  those shipped once.

**Radii.** `--radius-xs|sm|md|lg` (3/4/7/10px) plus `--radius-pill`. The app
shipped ten different values before that, which is not a system, it is a history.
**1px and 2px stay literals on purpose**: they sit on 8px legend dots, 7px timer
pips, chart segments and the theme toggle's rays, where the radius is a softened
corner on a shape a few pixels wide rather than a box with a corner style —
rounding those up rounds them away.

**Buttons.** Two implementations, in `css/app.css`:

- `.btn` — a thing you press. Modifiers `.primary`, `.ghost`, `.small`.
- `.btn-chip` — a small mono control in a toolbar. Modifiers `.active`, `.plain`.

There were about fifteen. The old class names (`.bl-btn`, `.su-btn`,
`.standup-btn`, `.kanban-group-btn`, `.gantt-mode-btn`, `.gantt-dropdown-btn`,
`.filter-toggle`, `.monitor-chip`, `.dash-freeze-btn`, `.issue-links-action`,
`.expiry-banner-btn`) are kept as **aliases on those two rules** rather than
renamed across the markup: the win was one definition of a button, and renaming
twenty call sites to get it would have been a second, riskier change wearing the
same hat. Each view stylesheet now holds only what its button genuinely does
differently, which in most cases is nothing. New code should use `.btn` and
`.btn-chip`.

**Icons.** `js/components/icons.js` — authored SVG paths on a 24×24 grid,
stroked, inheriting `currentColor`, so one drawing works in both themes.
`icon(name, size, { label })` is aria-hidden by default and takes a name only
when it asks for one, so the decorative case is the quiet one. There is **one
cross** and **one caret** — everything that points another way is that caret
rotated (`.icon-rot-*`, `.icon-caret.open/.closed`), not a different glyph.
Two places cannot hold an element and get the same drawing another way:
`svgIconPath()` for the roadmap's in-chart caret, and the `--caret-mask` custom
property for the settings page's `::before` section marker. There are no emoji in
the UI: they had no accessible name, carried their meaning in hue, and rendered
as a different picture on every platform.

**Headers.** `js/components/view-header.js` — icon tile, title, a line saying
what you are looking at, and an optional strip of counts. Every view has one. The
Backlog's `.bl-*` class names are aliases on the same rules, for the reason the
buttons are.

**Focus.** One visible ring for everything the keyboard can reach
(`:focus-visible`, so a mouse click does not paint it), with `outline: none`
allowed only where something replaces it. The two containers focused by script
and never by Tab — the drawer panel and `#view-container` — suppress it
deliberately, because a ring around a full-height region reads as a rendering
fault rather than as focus.

**Three things are pinned and are not up for re-litigation.** A mechanical design
scan flags all three on every run; all three findings are declined, not
outstanding:

1. **The animated gradient** on the STANDUP nav tab, the standup counters and the
   Start Standup button. Stops live in `--flair-stops` / `--flair-sweep` — one
   source, do not re-inline them.
2. **The dark palette.** Light theme was fixed because it was broken (chips at
   1.5–3.3:1). Dark was left alone on purpose, including `--tone-red` (3.96:1)
   and `--tone-purple` (3.71:1), which are marginally under AA against their own
   chip backgrounds. Changing them is a scheme change, not a contrast fix.
3. **The theme toggle's sky** — sun, moon, stars, clouds, craters. Its markup is
   in `js/components/theme-toggle.js`, which is the one place it is drawn.

### Traps

Each of these has already cost someone an hour.

- **Tokens must be in scope, not merely defined.** `css/recap.css` declared its
  whole palette on `.recap`, while the toolbar is a sibling of `.recap-sheet`.
  Every `var()` in three rules was invalid at computed-value time, so the Print
  button lost its background *and* its border and rendered white-on-near-white at
  1.19:1 — the primary action of that page, invisible in production for however
  long. Check where a custom property is declared relative to everything that
  reads it.
- **`var(--accent)` does not exist.** It was used once in `css/standup.css` and
  silently fell through to `currentColor`, working by accident. The token is
  `--accent-primary`.
- **`toISOString()` is a bug in date-only code.** A Jira due date is a calendar
  day; formatting one through UTC shifts it a day backwards anywhere east of
  Greenwich. `deliveryState` compares local midnights for this reason, and
  `scripts/test-gantt.mjs` was itself briefly wrong in exactly this way. Run it
  under `TZ=Pacific/Auckland` and `TZ=America/Anchorage` after touching anything
  date-shaped.
- **frappe-gantt only draws its today marker in Day view.**
  `make_grid_highlights()` is guarded on it, so Month, Week and Quarter — the
  views a roadmap is actually read in — have no `.today-highlight` element to
  read a position from. The line is computed in `js/views/gantt.js` (`todayX`) by
  copying the library's own `compute_x`, including its Month special case where
  columns are a nominal thirtieth of a month rather than a fixed step. Re-check
  that function if you change view modes or upgrade the library.
- **Preview harnesses can hide the bug they exist to show, and invent ones that
  are not there.** `preview-standup.html` set `#view-container { position: static }`
  with no height, so `height: 100%` on the running stage resolved against nothing
  and the screen rendered at content height in the harness and full height in the
  app. `preview-kanban.html` briefly made that container a flex parent, which let
  the board's wrap grow to its full content width and pushed the COLUMNS button
  off-screen — in the harness and nowhere else. `preview-issue.js` still omits
  the page shell, so the issue page renders flush to x=0 there and correctly in
  production. Distrust a harness before filing a layout bug from one.
- **Headless Chrome's `--virtual-time-budget` will not wait for the app.** A
  `setTimeout` polling loop burns the entire budget before the page's own pending
  work has run, so a harness that waits for an element by sleeping never finds it
   — and the element is there in the `--dump-dom` afterwards. Watch for it with a
  `MutationObserver` instead; `preview-standup.js` does, for `?done=1`. Add
  `--force-prefers-reduced-motion` to stop the standup's confetti landing on top
  of the screen you are trying to photograph.
- **`prefers-reduced-motion` has been forgotten twice.** `css/app.css` held the
  app's only infinite animation and was the one stylesheet of eleven with no
  clause; `js/components/nav.js` shipped a second confetti implementation that
  skipped the check the real one makes. `js/confetti.js` is the only confetti —
  it does nothing at all under reduced motion, by design.
- **Board colour is deliberate, not decoration.** Inline `link.style.color` in
  `monitor.js` and `gantt.js` colours an issue key by its board, matching
  `board.js`. It looks like a workaround for the unstyled-link bug and is not.
- **Every write is user-initiated and enumerable.** The app writes in six places
  and nowhere else. Anything that would add a seventh — notably undo on
  drag-to-transition — is a product decision, not a polish task.

## Checks

Config-layer unit checks — no dependencies, no network, no browser:

```bash
node scripts/test-backlog.mjs      # grouping, paging, tones, views    (115 checks)
node scripts/test-browser.mjs      # cross-browser shim, Gecko + Blink  (40 checks)
node scripts/test-imports.mjs      # every module imports what it calls  (54 checks)
node scripts/test-manifests.mjs    # per-target manifest rules          (49 checks)
node scripts/test-config.mjs       # config layer, field discovery      (88 checks)
node scripts/test-credentials.mjs  # migrations, tokens, export/import (102 checks)
node scripts/test-team.mjs         # roster, display names, filtering (127 checks)
node scripts/test-monitor.mjs      # hygiene checks, exclusions        (54 checks)
node scripts/test-issue.mjs        # sanitiser, ADF conversion         (86 checks)
node scripts/test-standup.mjs      # session timing, order, pressure (183 checks)
node scripts/test-dashboard.mjs    # aggregation, burndown, freeze    (226 checks)
node scripts/test-recap.mjs        # recap model, flags, PDF caveats  (117 checks)
node scripts/test-palette.mjs      # command palette matching          (47 checks)
node scripts/test-github.mjs       # GitHub sync: scope, model, auth  (206 checks)
node scripts/test-write.mjs        # field writes, undo, bulk, links  (152 checks)
node scripts/test-create.mjs       # createmeta -> form -> payload      (71 checks)
node scripts/test-activity.mjs     # issue history -> per-person activity (75 checks)
node scripts/test-gantt.mjs        # roadmap delivery colouring         (18 checks)
node scripts/test-kanban.mjs       # column config, grouping, key nav   (47 checks)
node scripts/test-contrast.mjs     # theme tokens against WCAG AA       (24 checks)
node scripts/test-drawer.mjs       # the drawer's focus layer           (24 checks)
```

View code is verified by rendering it rather than asserting on it:
`preview-standup.html`, `preview-backlog.html`, `preview-dashboard.html`,
`preview-recap.html`, `preview-issue.html`, `preview-create.html`,
`preview-gantt.html`, `preview-kanban.html` and `preview-monitor.html` mount the
real view against stubbed extension storage and a stubbed Jira/GitHub network, so
a screen can be looked at in each of its states without a site, a token or a
roster. Every view has one, and that is not decoration: for a long stretch only
five did, and every light-theme defect a design review found in September 2026
was in one of the three that did not. The create panel in particular has no other way of being checked — its
form is generated from whatever createmeta returns, so reading the code tells you
very little about what appears. The last four share their fixture
(`preview-fixture.js`) — three boards, three staggered sprints, synthetic people
and generated avatars — so the dashboard and the recap are always previewed
against the same sprint. Query parameters pick the state: `?theme=light`,
`?github=off`, `?stats=slow`, `?stats=error`, `?sprint=undated`, `?push=off`,
`?avatars=off`, `?logo=off`, `?jira=slow`, `?stats=partial`, `?history=off` — which
strips issue history, the case that dashes the per-person activity figures while
leaving "created" counted — and `?freeze=mid|none`, which takes the seeded freeze
four days into the sprint or seeds none at all, the two states the scope wording
has to distinguish — plus `?sort=<column>` on the
dashboard, `?print=1` on the recap, `?edit=points|due|assignee` and
`?link=open|search|refuse` on the issue
detail (which open that cell and the link picker — the states a screenshot
cannot reach on its own; `?link=search` types a query, lists results and picks
one, and `?link=refuse` submits it and has Jira say no), and `?createmeta=minimal|blocked` · `?create=refuse` · `?parent=ABC-1` on
the create panel — a project that asks for nothing, one that requires a field the
form cannot render, a refused create, and the sub-task form.

The Kanban and Monitor harnesses are self-contained rather than sharing that
fixture, because they want the opposite of a tidy sprint: Kanban wants a wide
spread of statuses across two boards, Monitor wants issues that are deliberately
wrong in four specific ways. Kanban takes `?editor=1` (opens the column editor),
`?groups=stale` — the four columns the app ships with, against a site that spells
almost none of them that way, which is what a fresh clone actually looks like —
`?groups=none`, and `?refuse=1`, which makes every workflow transition refuse, so
the refusal wording is reachable without a Jira that says no. Monitor takes
`?clean=1` (nothing to fix — the good day a live Jira will never show you on
demand), `?fields=none` (no story-points field mapped, so that check reports as
unavailable rather than flagging every issue), `?checks=muted`, `?roster=off` and
`?scope=all`. Standup adds `?done=1`, which starts a session, leaves a parking-lot
note and ends it, because the end screen cannot otherwise be reached without
sitting through a meeting. `?jira=slow` and `?stats=slow` hold the recap's
loading states open long enough to look at — the states that must never offer a
print button — and `?stats=partial` marks one repo half-answered and another
truncated, which is what the undercount warning is for. None of them ships: `scripts/build.mjs` copies an
explicit file list.

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

`test-recap.mjs` covers the recap model: the combined figures and their shares,
per-person contribution rows with the GitHub and Jira-activity halves attached or
absent, the board split, the ticket list's ordering and its scope-creep and
carry-in flags, the three separate ways GitHub can have no answer, and — since
the freeze exists — that the document's per-ticket, per-person and headline creep
figures all switch basis together, so a page cannot print an exact tile over
approximate rows. The
document itself is verified by printing it — see the preview harnesses below.

`test-activity.mjs` covers per-person Jira activity: the compaction that reduces
a raw changelog at the fetch boundary (and drops the nested author records that
would otherwise triple the cached payload), attribution of a transition to
whoever *made* it rather than whoever owns the ticket, the three sources
done-ness is resolved from when a changelog gives a status name but no category,
assignment split into picked-up versus handed-out, the window as a parameter —
exercised over a week as well as a sprint, so M14 does not discover it — and the
framing rules the module commits to: people ordered by name whatever their
counts, no total or score exposed, an authorless automation entry attributed to
nobody, a truncated history reported rather than silently undercounted, and
absence kept distinct from zero on each half separately.

`test-dashboard.mjs` covers working-day arithmetic, carry-in and scope-change
detection, the per-status/board/person buckets, review-versus-done classification
and the points share built on it, snapshot storage and pruning including the
per-person block written for the planner, and the burndown series — plus chart geometry against a DOM shim, so a NaN coordinate
or a label placed outside the viewBox fails the suite rather than the eye. The
sprint freeze is in the same suite: what a frozen row keeps and what it
deliberately excludes, all six diff buckets, the crept-in split the creation-date
approximation cannot make, the arithmetic reconciling the buckets with the sprint
total, both departure answers, and the three states the scope figure can be in —
including the one that matters most, a mid-sprint freeze **not** being allowed to
call itself exact. It also *measures* what a freeze costs on the device, and
prints the figure, because the roadmap's own risk register calls this the largest
thing the extension keeps and "assume it is small" is how a storage quota gets
discovered by a user instead of by a test.

`test-write.mjs` covers the write layer against a stubbed transport: the
domain-name → field-id mapping (so an estimate cannot go to the wrong custom
field), the three ways Jira says no — a field error, a permission refusal, a dead
token — the optimistic paint and its rollback, the undo writing the previous
value back rather than reverting locally, a bulk edit reporting what landed and
what did not, and sprint moves batching at Jira's 50-issue ceiling. Issue links
are in the same suite and get the most attention per line of code in the app,
because their one failure mode is silent: a link built the wrong way round reads
correctly on the issue you made it from and wrong on the other one, so both
directions of `inwardIssue <outward phrase> outwardIssue` are pinned, alongside
the symmetric type appearing once, the JQL the picker builds (with its escaping),
and the DELETE sending no body.

`test-create.mjs` covers issue creation: a control derived for every field type
createmeta can describe, a required field of an unknown type stopping the form
rather than being guessed at, the payload shape each control produces (an option
is `{id}` and not its label, a user is `{accountId}`, rich text is a document),
Jira's own defaults prefilling the form, the sub-task type found by its flag and
not its name, and both response shapes createmeta comes in.

`test-github.mjs` covers the parts of GitHub sync that can be wrong quietly:
repo-reference parsing (including the injection cases the GraphQL document would
otherwise interpolate), API base derivation for github.com vs Enterprise Server,
the aliased query, review-state and staleness derivation, per-person slicing,
and the roster matcher. The sprint-window layer gets its own arithmetic checks —
a pull request opened before the sprint but merged during it, a merge into a
branch that is not the default one, a review on your own pull request, a review
never submitted, and a sprint older than the fetch window — because every one of
those is a number that would look plausible while being wrong. It also asserts
the behaviours that only show up in the transport: paging stops at the window,
a repo busier than the page cap says so, one repo failing degrades to that one
repo, every repo failing throws rather than reading as a sprint of zeroes, a
second caller joins a request already in flight, and the real token expiry is
read off the response header.

`test-imports.mjs` exists because a mechanical rename across twenty files once
missed two imports and shipped: `node --check` parses without resolving
identifiers, and the unit suites do not import the DOM-heavy view modules. It
flags any identifier a module calls that another module exports and this one
never imported. It used to skip template literals whole, on the grounds that a
name inside one is usually prose — and then a call inside `${…}` went in without
its import and the file said nothing, which is precisely the bug it was written
for. Interpolations are code; only the text between them is prose.

`test-kanban.mjs` covers the board's pure layer: what a column editor is allowed
to save (a row nobody touched is dropped quietly, a half-finished one is refused
loudly and says which row and why, a status claimed by two columns is refused
because `resolveStatusGroup` would otherwise silently give it to the earlier
one), the statuses the editor's shelf offers and how they are counted, how issues
fall into columns once it has saved — including the forgiving case where a status
in no column gets a column of its own — and the arrow-key grid, whose interesting
edges are the ends of a column, the ends of the board, and the empty column in
the middle that has to be stepped over rather than landed in.

`test-contrast.mjs` reads the theme tokens out of `css/app.css` rather than from
numbers retyped into the test, checks the pairs the app actually paints against
the 4.5:1 AA floor in both themes, and fails if any rule sets a solid
`background: var(--accent-primary)` and then names its own `color` — the label on
an accent belongs to `--on-accent`, which flips per theme, and a literal there is
wrong in one of them by construction. It exists because ten primary buttons
shipped at 3.21:1 in dark theme while an eleventh was correct and got "fixed"
into line with the other ten. No reviewer holds eleven selectors and two palettes
in their head; this file does.

`test-drawer.mjs` covers the issue drawer's focus layer — which elements a Tab
may land on, where the cycle wraps, and how a trigger is described so it can be
found again after the board repaints out from under it. Written because the bug
it replaces was invisible to every other kind of test: `role="dialog"` was set,
`aria-label` was set, the panel looked right in a screenshot, and focus was still
sitting on `<body>` behind the backdrop while the view underneath answered the
keyboard.

`test-browser.mjs` is the one that matters for the port: it runs the real
modules against a Firefox-shaped `browser` global with **no `chrome` global at
all**, so anything still reaching for `chrome.*` fails there rather than in
front of a Firefox user. `test-manifests.mjs` encodes the store rules that only
bite at submission — a `key` left in a Firefox package, a service-worker
background on Gecko, a missing gecko id quietly breaking `storage.sync`.

`scripts/SMOKE-CHECKLIST.md` is the manual pass for anything involving the UI.

### Checking a Jira site from the CLI

```bash
JIRA_SITE=your-org.atlassian.net \
JIRA_EMAIL=you@example.com \
JIRA_TOKEN=your_api_token \
JIRA_PROJEACME=ABC,DEF \
node scripts/jira-smoke.js
```

Verifies credentials, resolves field roles, lists boards, exercises search
pagination, and reports what your site's issue history actually looks like — that
the agile sprint endpoint honours `expand=changelog`, the per-issue entry cap it
applies, how many of your tickets exceed that cap, and how much the compaction
saves on the cached payload. Useful for telling "my token is dead" apart from
"the extension is broken", and the per-issue cap is worth knowing because it is
what makes the activity figures a floor rather than a total. It reads only from
the environment — no credentials on disk.

## Data handling

Your API token is stored in device-local extension storage — on that device
only. It is deliberately kept out of synced storage, which would replicate it in
plaintext through your Google account to every signed-in browser. To move to
another machine, use **Settings → Export config** (the token is excluded unless
you tick the box) or just paste a fresh token there.

**Settings → Forget token on this device** removes the credential and keeps
everything else — useful on a shared machine.

The team roster is also `chrome.storage.local` only — it holds colleagues'
names, emails and account IDs, so it never goes into synced storage and is
excluded from exports unless you opt in.

The GitHub token, when GitHub sync is used, is a second credential with its own
keys and its own lifecycle: device-local, never synced, and excluded from an
export unless you tick **its own** box — ticking the Jira one does not carry it.
**Forget GitHub token** removes it on its own. A
GitHub login on a roster member is one more identifier attached to a named
colleague, so it rides in the roster record and inherits its treatment.

Jira responses are cached in device-local storage for five minutes. Nothing is
sent anywhere except your own Jira site, and — if you switch GitHub sync on —
your GitHub host, for the repos you listed.

### Token expiry

Atlassian does not expose a token's expiry date over the API, so the app records
one at setup (creation + 365 days) and treats it as a reminder you can correct in
Settings. From 14 days out you get a once-a-day banner. If a token dies anyway,
a 401 opens a prompt asking for the new token alone — boards, field mapping and
branding are untouched.

GitHub does report a real expiry, on every authenticated call, so that date is
recorded rather than assumed. Its banner is deliberately separate from the Jira
one and says what actually breaks: standup loses its pull-request panel, and
nothing else changes.

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

See [ROADMAP.md](ROADMAP.md) for the full record, including why each thing is
built the way it is. Design and UX work had its own backlog until 2026-09-06,
when the last of it was closed; the reference that outlived it is
[Design system](#design-system) above, and the things that were deliberately not
done are in the roadmap's icebox, stated as decisions rather than as omissions.

**Done:** hygiene (M0), whitelabelling (M1), durable identity and config (M2),
the team roster (M3), the monitoring tab (M4), issue detail (M5), standup mode
(M6), the sprint dashboard (M7), the write layer and issue creation (M8), the
command palette (M9), GitHub sync (M11), the Firefox and Edge ports (M12), the
sprint freeze and diff (M13), linked issues (M18), and the design backlog
(ad-hoc, 2026-09-06).
M10 is vacant: it was Sprint Wrapped, re-aimed at the quarter and renumbered to
M16 on 2026-09-03, and the number is retired rather than reused.

**Open, in queue order** — re-sequenced on 2026-09-03 and renumbered the same
day so the number and the position agree. Anything written before that date uses
the old numbers, and M13 and M15 swapped; ROADMAP.md has the reconciliation
table.

| | | |
|---|---|---|
| M14 | Weekly 1:1 screen | Per-person prep sheet. Scope is a first pass, not agreed |
| M15 | Sprint planner | Capacity, carryover and drag-to-assign, pushed as one reviewed batch |
| M16 | Quarter Wrapped | Quarter-to-date stats recap, printed to PDF on demand |
| M17 | Per-sprint history | Issues, completion, PRs and lines per sprint, from rollups written at each rollover |
| M19 | Tagged releases | A release tag builds all three targets in CI and publishes the zips this README already tells you to download. Depends on nothing; carries the licence decision |

**Releases are not automated yet.** The install instructions above send you to
the Releases page for `chrome-<version>.zip` — today those files are built by
hand with `node scripts/build.mjs --zip` and uploaded the same way. M19 is the
workflow that does it on a tag.

The app writes to Jira in four places and nowhere else: dragging a card between
columns (a workflow transition), editing assignee, due date or story points on
the issue detail, creating an issue or a sub-task, and posting a comment. Every
one of them is something you asked for by clicking it, and every one reports what
Jira said if it refused.

## Licence

Not yet chosen — add one before making this repo public if you want others to
be able to use it.
