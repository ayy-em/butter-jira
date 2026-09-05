# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the author, running their own sprint.** butter_jira is built first for
one person's own use — the person accountable for a sprint on one or more Jira
boards. Their jobs, in the order the app supports them: see everything in flight
across several boards in one tab, run the daily standup, keep sprint hygiene
honest, review what actually happened at the end of a sprint, and make small
writes (transition, assignee, due date, points, comment, link, create) without
leaving for Jira's own UI.

**Secondary: anyone who clones it.** Other people adopting it is welcome and the
product is deliberately configurable for it, but adoption does not drive
decisions. Nothing is designed around a hypothetical other team's workflow; the
config surface exists so the tool is not single-tenant, not because a second
tenant has asked for something.

Consequence for future work: when the author's workflow and a general-audience
feature disagree, the author's workflow wins. Confirmed 2026-09-05.

## Product Purpose

A browser extension that puts Gantt (roadmap), Backlog, Kanban, Monitor,
Standup, Sprint dashboard and issue detail over Jira Cloud boards — several
boards at once, in one tab, under the user's own status grouping. It exists
because Jira's own equivalents do not do this well enough for the way its author
runs a sprint.

Success is that the sprint can be run out of this tab: planned, watched, stood
up on, and reviewed, with Jira left as the system of record rather than the
daily interface.

## Positioning

Three things a neighbouring tool could not truthfully copy without rebuilding
the same way:

- **Several boards, one workspace, the user's own status grouping.** Views are
  cross-board by default and columns are mapped from the site's real statuses,
  not from Jira's fixed idea of a board.
- **History Jira does not keep, recorded locally rather than reconstructed.**
  Daily sprint snapshots power the burndown; a per-issue *sprint freeze* powers
  "what changed underneath the plan" (crept in, pulled out, re-estimated, due
  date moved, re-assigned, went backwards). Both exist because the API routes to
  the same answers are a changelog request per issue or an undocumented internal
  endpoint.
- **Zero infrastructure.** No server, no account, no build step, no runtime
  dependencies. The repo directory *is* the extension.

## Operating Context

- **Where it runs:** Chrome 111+, Firefox 115+, Edge 111+ — one codebase, three
  manifests, packaged by `scripts/build.mjs` (copy + manifest write, no
  compilation). Chrome loads the repo directory unpacked with no build step.
- **What it talks to:** the user's own Jira Cloud or Data Center site over HTTP
  Basic (email + API token), and optionally their GitHub host, read-only, scoped
  to an explicit repo allowlist.
- **Rituals it is shaped around:** the daily standup (timed, per-person, with
  sound cues and the keyboard handed to the session); sprint hygiene checks
  between standups; the end-of-sprint review, including a printable recap PDF
  produced by a print stylesheet over the same numbers the dashboard shows.
- **Setup is a real part of the product:** first run asks for site, email and
  token, resolves the site's custom field IDs by name, and offers every board
  the account can see. A non-`*.atlassian.net` host is requested as an optional
  origin at that moment.
- **Distribution:** public repository, unpacked installs only — no
  Chrome/Edge/Firefox store submission is planned. Confirmed 2026-09-05.
  **Target state:** a GitHub Actions workflow triggered by a release tag builds
  all three targets and publishes `chrome-<version>.zip`,
  `firefox-<version>.zip` and `edge-<version>.zip` as release assets, which is
  what the README's install instructions already send people to download. The
  producing half exists (`scripts/build.mjs --zip` writes exactly those
  filenames from `dist/<target>/`); the workflow does not — there is no
  `.github/` in the repo as of 2026-09-05. The store-safe packaging paths the
  code already carries (the `key`-field note, `assets/avatars/` and
  `assets/brand/` exclusion, `--zip` refusing to combine with `--local-assets`)
  stay correct under this plan: a public release asset must not carry
  colleagues' photographs whether or not a store ever sees it.

## Capabilities and Constraints

**Shipped capabilities.** Sprint dashboard (KPI row, burndown, since-the-freeze
panel, breakdowns by status, board and person, delivery-per-person including
optional GitHub columns), Gantt/roadmap, Backlog, Kanban, Monitor (four hygiene
checks), Standup mode, issue detail as drawer and full page, command palette,
sprint freeze and diff, linked issues, sprint recap PDF, team roster, GitHub
sync, config export/import, numbered storage migrations, Settings for
everything above.

**Writes.** The app writes to Jira in a bounded set of places and nowhere else:
workflow transition by dragging a card, field edits (assignee, due date, story
points), issue and sub-task creation, comments, and issue links (its only
DELETE). Each is user-initiated by a click and reports what Jira said if it
refused.

**Binding constraints — future work must preserve all three.** Confirmed
2026-09-05:

1. **No build step, no runtime dependencies.** Plain ES modules loaded directly
   by the browser. No framework, no bundler, no npm package at runtime. The only
   vendored library is frappe-gantt in `libs/`.
2. **Credentials device-local, no telemetry.** Both tokens, the team roster and
   the local histories live in device-local extension storage, never synced
   storage, and are excluded from a config export unless explicitly ticked.
   Nothing is sent anywhere except the user's own Jira site and, when GitHub
   sync is on, their GitHub host.
3. **Nothing instance-specific hardcoded.** Board IDs, project keys, custom
   field IDs, status grouping and branding all come from configuration or are
   discovered from the site at runtime. `customfield_10016` means different
   things on different sites and the code never assumes.

**Existing practices, not raised to binding constraints.** Views prefer deriving
from data already fetched over issuing new requests; figures that are
approximate say so on screen (burndown history availability, added-after-start's
exact/approx/approximation states, GitHub window clamping). These are how the
product currently behaves and are worth preserving by default, but the user did
not name them as invariants.

**Terminology.** *Freeze* = the per-issue snapshot of a sprint taken on first
sight of it. *Since the freeze* = the diff over it. *Crept in* / *pulled out* /
*re-estimated* / *went backwards* = the diff's buckets. *Hygiene* = the coarse
share of issues with no Monitor finding, explicitly a nudge and not a KPI.
*Status group* = the user's mapping from real Jira statuses onto columns.
*Roster* = the local team list with display-name overrides, emoji and optional
GitHub login.

**Open product decisions.** Licence is unchosen — and it is on the critical
path for the tagged-release plan above, since a public repo shipping downloadable
builds with no licence grants nobody the right to use them. M14 (weekly 1:1 screen) has a
first-pass scope that is explicitly not agreed. M10 is retired unbuilt and its
number stays vacant.

## Brand Commitments

- **Name:** butter_jira (also written ButterJira in prose).
- **Voice:** plain, blunt, specific; states limits rather than hiding them
  ("Because the other one sucks", "a dash is not a small number", "the panel
  names the blind spot rather than leaving it to be discovered"). Documentation
  explains *why* a thing is built the way it is. Numbers that cannot be trusted
  say so on the surface that prints them.
- **Whitelabelling is a product feature.** An adopting org can set its own name
  and logo path; `assets/brand/` is gitignored, single-colour wordmarks are
  inverted automatically in light theme, and with nothing configured the product
  logo stands alone. Any future brand work must survive being replaced by
  someone else's mark.

## Evidence on Hand

- `README.md` (~69 KB) — install, configuration, every feature, data handling,
  permissions, keyboard shortcuts, file layout.
- `ROADMAP.md` (~121 KB) — the full milestone record, kept unsummarised because
  it holds the reasoning; includes the 2026-09-03 renumbering reconciliation
  table (M13 ↔ M15 swap, M10 retired).
- Seventeen `scripts/test-*.mjs` suites (1755 checks, no dependencies, no
  network, no browser), six preview harnesses with a shared fixture
  (`preview-fixture.js`), and `scripts/SMOKE-CHECKLIST.md`.
- Real running app against live Jira; `scripts/jira-smoke.js` for CLI checks.

**Absences future work must not fabricate:** no users beyond the author, no
adoption numbers, no testimonials, no benchmarks, no pricing, no licence, no
store listing, no uptime or support commitment.

## Product Principles

1. **The author's sprint is the spec.** Build what that workflow needs; treat
   general-audience polish as a bonus, never as the reason.
2. **Own the history Jira throws away.** Where the API cannot answer a question
   affordably, record the answer locally and forward — and say what the record
   cannot see.
3. **State the limit on the surface that shows the number.** Approximate,
   unavailable and exact are three different things and the UI must distinguish
   them where it prints them.
4. **Zero infrastructure, zero assumptions about the site.** No server, no build,
   no dependency, and nothing about any particular Jira instance in the code.
5. **Write only when clicked.** Every mutation is user-initiated, reversible or
   reported, and enumerable.

## Accessibility & Inclusion

No product-specific standard has been established. What exists today is
evidence, not a commitment: `lang="en"`, ARIA in use (`aria-label`,
`aria-expanded`, `aria-sort`, `aria-checked`, `aria-haspopup`, `aria-hidden`),
`prefers-reduced-motion` honoured across six stylesheets and the confetti and
nav modules, light and dark themes via `data-theme`, and keyboard shortcuts for
every view with the standup deliberately taking the keyboard for its duration.
English only; no i18n layer.
