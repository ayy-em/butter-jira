# butter_jira — Roadmap

Last updated: 2026-09-30

An MV3 browser extension for Chrome, Firefox and Edge that gives one tab of
Gantt, Backlog, Kanban, sprint and team views over several Jira Cloud boards.

**This file holds what is still open, plus the rules that constrain it.**
Completed milestones were removed on 2026-09-29. What shipped is in
[CHANGELOG.md](CHANGELOG.md). The full milestone record, with the reasoning
behind every shipped decision, is the version of this file at commit `c818893`
(`git show c818893:docs/ROADMAP.md`). M15 (the sprint planner) was removed on
2026-09-30. Its settled answers and the calls made while building it are in the
commit that shipped it (`git log --grep "M15"`). Shipped milestone labels still appear in
code comments and commit subjects, so they are indexed at the bottom.

## Current state

| Aspect | Status |
|---|---|
| Browsers | Chrome 111+, Firefox 115+, Edge 111+ — one codebase, three manifests |
| Views | Sprint dashboard, Gantt, Backlog, Kanban, Monitor, Standup, Sprint planner (setup + plan), 1:1 (picker + per-person sheet), My todos, Recap config, Issue detail (drawer + full page) |
| Documents | Sprint recap PDF (active, last closed, or any chosen sprints) and quarterly overview PDF, both print-styled pages of their own |
| Jira writes | Transitions, field edits (assignee, due date, story points), issue and sub-task creation, comments, issue links (the only DELETE), and the sprint planner's reviewed push (sprint moves in and out, assignee, story points). Nothing else writes |
| Second source | Optional GitHub sync (`js/github.js`), read-only, scoped to an explicit repo allowlist. Feeds the standup, dashboard, recap, quarterly overview and each issue's Development section |
| Permissions | `storage`, `declarativeNetRequestWithHostAccess` (the opt-in Jira-links redirect), host access to `*.atlassian.net` and `api.github.com`, optional host access for anything else |
| Storage | Synced storage for config. Device-local for tokens, the roster, view prefs, daily snapshots, sprint freezes, 1:1 notes, todos, the sprint planner's draft and a five-minute response cache. Settings backs up everything but tokens, 1:1 notes and the planner draft to a file, and restore merges |
| Build step | None to run it; `scripts/build.mjs` packages the three targets (copy plus manifest, no compilation) |
| Releases | Tag-led: a `v*` tag makes `.github/workflows/release.yml` run every suite, build and verify the three zips, publish them with checksums, and push the version bump to `main` |
| Tests | 28 `scripts/test-*.mjs` suites (2375 checks), 14 preview harnesses in `preview/`, a manual `scripts/SMOKE-CHECKLIST.md`. CI runs the suites on every push and pull request |
| Licence | [PolyForm Noncommercial 1.0.0](../LICENSE) |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Order of work

```
M21 Sprint planner v2 (M) ─▶ M22 1:1 screen improvements (S–M) ─▶ M17 Per-sprint history (M) ─▶ M20 1:1 recording (L, gated)
```

The deferred backlog below is scoped but unscheduled, and any item in it can be
taken in a gap. New milestones take the next free number and join the queue at
the end.

## Rules in force

Product decisions that constrain open work. Re-open any of them only with the
author.

- **Binding constraints** (from [PRODUCT.md](PRODUCT.md)): no build step and no
  runtime dependencies; credentials device-local and no telemetry; nothing
  instance-specific hardcoded.
- **Every Jira write is user-initiated and enumerable.** A new kind of write is
  a product decision, not an implementation detail. The sprint planner's push
  is sprint moves and field writes, and its Split is create, link and
  transition, so M15 added none. M21's items 1 to 3 would each add one.
- **The reporting screens count the roster only.** The dashboard, recap and
  quarterly overview count issues held by active roster members, plus unassigned
  ones (`teamScope` in `js/team.js`). The board views keep a Team only /
  Everyone toggle instead.
- **Per-person figures.** Per-person GitHub figures are shown on the 1:1 sheet,
  the sprint recap and the quarterly overview. The quarterly overview's
  per-person table is ranked (Jira activity, commits, lines, equal weights), and
  its charts stay in name order. Every such surface prints a
  not-an-assessment note.
- **1:1 notes never leave the device.** There is no export path and they are not
  in the backup; the only way out is Copy for Slack. Retention is unbounded, and
  the Settings delete is the whole retention policy.
- **Figures that are approximate say so where they are printed.** Absent, pending
  and zero are three different things on every surface.
- **History is built forward.** Where Jira cannot cheaply answer a question about
  the past, the app records the answer locally from now on, rather than mining
  Jira backwards.

## Risk register

| Risk | Where | Mitigation |
|---|---|---|
| Writes corrupt real sprint data | Planner (shipped), M21 | Device-local draft, Jira re-read before the review, one confirmed batch, each failure retried alone up to three times and then reported by name. No write on drag |
| Request fan-out across boards hits rate limits | Planner (shipped), M17 | Reuse cached aggregates, batch where the API allows (sprint moves already batch 50) |
| Per-person figures read as a performance measure | 1:1, recap, quarterly | Stated framing on every surface. Ranked only in the quarterly overview, at the author's request |
| Recording a colleague's voice is a different category of data | M20 | Local-only, off by default, per-session start, visible indicator, and an AI Enablement / DPIA review before any code |
| The Jira-links redirect misbehaves on Firefox | shipped | Verified in Chromium only. Settings reports "not supported" where the API is missing; check with the smoke checklist before relying on it there |
| GitHub search (30 requests a minute) throttles the Development section | shipped | Fetch only when an issue opens, batch repos per search, cache per key for 10 minutes |
| CI's version-bump push to `main` is rejected | releases | The bump is the last step, after publishing, so a failed push leaves the release up and the fix at two commands |

## Open questions

1. **How much history should the app keep?** Daily snapshots and freezes are
   capped at eight sprints (`MAX_SPRINTS_KEPT`). That is right for sixty rows a
   sprint and wrong for M17's one rollup row a sprint, which a trend wants years
   of. Decide per store, with a visible clear action, as part of M17.

---

# Open

## M17 — Per-sprint history

**Size: M** · Depends on the daily snapshots and GitHub sync, both in place.

**One chart, a row per sprint:** issues opened and closed, completion rate, pull
requests merged and lines reaching the default branch, across the last N
sprints, as a section on the Sprint Dashboard below the burndown. The quarterly
overview no longer needs it: it now reads GitHub over the quarter's own dates.

- **A rollup record written once per sprint, at rollover**, from the last daily
  snapshot of the outgoing sprint plus a GitHub window over that sprint's dates.
  `sprintKey()` already detects the rollover, and the freeze hooks the same
  moment. A figure not stored when it was available is gone, so history is built
  forward.
- **A row holds:** sprint id, name, dates, issues opened and closed, points
  committed and completed, completion rate, PRs opened, merged and reviewed,
  additions and deletions, and a per-source `partial` flag, so a row built from
  a truncated window draws as incomplete rather than as a dip.
- **Its own retention**, far longer than the eight sprints the daily snapshots
  keep, set deliberately with a visible clear action (open question 1).
- **Charting:** five series with two units and one very different magnitude.
  Small multiples on the `weeklyLines` primitive, not a multi-axis chart.

**Open questions:**

1. **Active sprint on the chart?** A partial current sprint beside complete ones
   reads as a drop every time. Exclude it, or draw it in an in-progress style.
2. **Sprints or calendar months?** Everything here is per sprint, which matches
   the app. Months would need events counted by date, as the quarterly overview
   does.

## M20 — 1:1 recording and local transcription

**Size: L** · Depends on the 1:1 sheet. Last in the queue, and gated.

**Record the 1:1 and turn it into text, entirely on the device.** v1 is a
"Transcribe recording" button after the meeting that drops the text into that
session's notes. v2 is streaming transcription during it.

**Local, both versions, non-negotiable.** No audio or transcript leaves the
device. Under the no-build, no-dependency constraint, that means the browser's
own speech APIs or a vendored WASM model, and a WASM model would be the first
large vendored binary in the repo. **Answer this before any other work,**
because it decides whether the milestone is possible under the constraints at
all.

**Consent and legality are part of the feature.** The person being recorded
knows it is happening every time, with a visible indicator for the duration.
Recording is off by default and started per session. Audio is discarded after
transcription unless deliberately kept, and the transcript gets the notes'
never-leaves-the-device treatment.

**Escalate before building.** A manager-operated tool that records and
transcribes conversations with reports, stored beside per-person output
figures, is worker-management tooling under the EU AI Act's Annex III, and a
DPIA question under GDPR either way. Raise it with AI Enablement before the first
line is written:
https://stxgroup.atlassian.net/servicedesk/customer/portal/1/group/819

**Open questions:**

1. **Which engine, and does it survive the no-dependency rule?** Web Speech API
   (quality and offline availability vary, and Chrome's has not historically been
   local), a vendored WASM model, or not buildable as specified.
2. **Does a transcript belong in the archived session?** A dated record of what a
   colleague said is a different object from notes about what was agreed.
3. **Diarisation** — who said what. Without it, a transcript is a wall of text.
   With it, the feature attributes statements to a named person.
4. **What happens to a recording if Complete is never pressed?** Audio that
   silently expires and audio that silently persists are both wrong.


## M21 — Sprint planner v2

**Size: M, as a set.** Follows M15. Each item stands alone and can be taken in a
gap. Items 1 to 3 are each a new kind of Jira write, so each is a product
decision under "Rules in force" before it is code.

### New capability

1. **Create a sprint from the planner.** Name, start and end dates, goal, on a
   chosen board (`POST /rest/agile/1.0/sprint`). The setup screen's "Plan into"
   list would offer "New sprint…" beside the upcoming ones, with its dates
   prefilling the planning dates.
2. **Start the planned sprint from the planner** after the push lands
   (`POST /rest/agile/1.0/sprint/{id}` with `state: active`). Jira refuses a
   start on a board that already has an active sprint unless parallel sprints
   are on, and that sentence should reach the user unchanged.
3. **Complete the outgoing sprint from the planner.** Jira's "complete sprint"
   also moves unfinished issues on, which the planner's carryover already does
   issue by issue. Jira normally confirms this write itself, so the planner's
   confirm has to say where the open issues go. Wants a real session's worth of
   use of 1 and 2 first.
4. **Public holidays without typing them.** A Dutch holiday calendar built in
   (computed, so Easter-based dates need no table per year), taken off the
   suggested working days with each holiday named. Optionally a calendar feed
   (ICS URL) for personal leave, which is the iCal idea in the deferred backlog.
   That is a new host permission, so it is opt-in and per origin.
5. **Proposed due dates.** For each planned issue, a suggested due date from its
   estimate, the other work already planned for the same person, and for an
   epic the due dates and points of its children. Shown beside the issue and
   written only if accepted: a due-date write, a kind the app already makes.
6. **Part two in To Do explicitly.** If a workflow's first status is not in the
   To Do category, Split would transition part two there. Only worth doing once
   a site shows the case.
7. **Story points value setting.** Settings gets "Hours per story point",
   default 8 (one working day). The planner uses it everywhere it turns days
   into points. See open question 6.

### From M15 QA (2026-09-30)

Setup screen:

- [ ] **Cross-board carryover.** Leftovers from another board's sprint can
      carry over into this board's new sprint (e.g. MDS's last sprint into the
      new DP sprint). See open question 1.
- [ ] **Dates: calendar picker** for start and end. See open question 2.
- [ ] **Dates: one line of help, below the pickers.** Replace the section hint
      and the row note with one element: "XX weekdays in timeframe, override
      above in case of holidays". The field's own default reads "Defaults to
      number of working days in timeframe".
- [ ] **Buffer: one line of help** under the controls, replacing the two.
- [ ] **Buffer: a % / # toggle** instead of the dropdown.
- [ ] **Buffer: default 20%** for everyone. See open question 5.
- [ ] **People: remove the help text.** See open question 3.

Bug:

- [x] **Only the first per-person override was saved.** Fixed 2026-09-30. Each
      save replaced the draft object while the rows on screen still pointed
      into the old one, so later edits went to a copy that was never saved
      again. Every setup field was affected, not only capacity. The planner now
      keeps one draft object for the life of the screen.

### Open questions

1. **Cross-board carryover: which sprints, into which target?** The likely
   shape is that each planned board's "Carry over from" lists every configured
   board's active and recent sprints, grouped by board, and leftovers go into
   the target sprint of the board they were picked under (MDS picked under DP
   goes to DP's new sprint). Is that right? And does picking MDS as a source
   also need MDS to be a planned board, with its backlog shown, or is it a
   source only?
2. **What should the calendar picker be?** The two fields are already the
   browser's date input, with a calendar button at the right in Chrome. Is the
   ask for a click anywhere in the field to open it, or for one range calendar
   that picks start and end together?
3. **People card: which text goes?** There are two: the hint under the heading
   ("One working day is one story point…") and the line under the table ("Buffer
   is in percent…; blank takes the team's"). Both?
4. **The empty checklist item** under the setup-screen notes. Was something
   meant to go there?
5. **The 20% default: new drafts only?** A draft already on the device keeps
   what it has unless told otherwise. And the toggle's "#" is points per person,
   as the dropdown's second option is now?
6. **Story points value: is a working day still 8 hours?** With 4 hours per
   point, a day is 2 points and a ten-day sprint 20. That needs hours per
   working day too: fixed at 8, a second setting, or per person for part-time?
   It would live in synced config (it is not personal data). It changes only the
   planner's day-to-point conversion. Estimates already in Jira are not
   rescaled.
7. **Creating a sprint (item 1): at once, or with the push?** At once, from its
   own confirm like Split, is simpler: the plan cannot target a sprint that does
   not exist yet.

## M22 — 1:1 screen improvements

**Size: S–M.** From use of the 1:1 sheet (M14).

- [ ] Remove the "waiting on their review" list.
- [ ] Replace the "load over time" graph with one combined chart, weekly, from
      four full weeks back to this week so far: pull requests opened and merged
      as a line, Jira issues created, opened and commented on as bars. No
      explanatory text on it.
- [ ] Bug: **Copy for Slack** says "Clipboard was refused — the text is in the
      browser console".
- [ ] Remove the "Activity, not performance" note. This is a stated rule
      (per-person figures print a not-an-assessment note), so the rule changes
      for this screen with it.
- [ ] In "What is planned", mark epics apart from other issues by the key's
      colour: purple for epics, green for stories and tasks.
- [ ] In the "Closed" list, make the issue keys open the issue drawer.
- [ ] 1:1 config screen footnote (`oo-footnote`): "Notes are only stored
      locally. Notes are never synced and never included in exports. To delete
      notes: Settings → Data." No max-width.

### Open questions

1. **"Created + opened + commented on":** is "opened" issues moved into
   progress, or closed? The bars would otherwise count creation twice.
2. **Key colours for other types:** bugs and sub-tasks too? The app already
   colours types (epic purple, story green, task blue, bug red, sub-task cyan).
   Reuse that, or two colours only?
3. **"Settings → Data" does not exist.** The section is "1:1 notes and todos".
   Rename the section, or point the text at the current name?
4. **Copy for Slack:** in which browser, and after doing what? The refusal
   usually means the page lost focus or the permission prompt was dismissed.
   Firefox and Chrome refuse for different reasons.

---

# Deferred backlog

Scoped, wanted, and deliberately not scheduled yet.

### Epics on several boards over one project

**Size: S–M.** The duplication half of this shipped: an issue shown by two boards
is counted once, carries a `boardIds` set, and the board filter and per-board
splits read the set. **What is left is attribution.** An epic's board is still
inferred from its project key, and `.find()` takes the first board that matches.
With two boards over one project, every epic lands on the first board, and the
second draws an empty Gantt row and an empty epic filter.

**Chosen fix:** resolve epic membership from `/rest/agile/1.0/board/{id}/epic` —
the mapping only, one cheap request per board on the Gantt refresh path — while
the existing single JQL keeps supplying the epic data. Rejected: reading each
board's saved filter through `/board/{id}/configuration`, which needs a
permission many sites restrict.

**Not scheduled** because this deployment runs one board per project, so the bug
is not live here.

### A signed Firefox add-on

A Firefox zip loaded through `about:debugging` is dropped when the browser quits,
so one of the three release files behaves differently from the other two. **The
fix is `web-ext sign`** in the release workflow, producing a permanently
installable `.xpi`, with AMO credentials as repository secrets. It is a CI-time
dependency, not a runtime one. What it costs is not the code: an AMO account, a
public-or-unlisted decision, and Mozilla's review latency on a release path that
is otherwise instant.

**Not scheduled** because nobody runs the Firefox build yet. The Jira-links
redirect is also unverified there.

### Icebox

- **"What changed since you last looked"** — diff the sprint against the state at
  your previous session. Same diff machinery as the freeze, a different anchor,
  and a per-issue record written per session.
- WIP limits and blocked-chain visualisation on the Kanban.
- Multi-site support (several Jira Cloud instances in one install).
- Multi-org GitHub sync — one fine-grained token has one resource owner, so a
  second org means a second credential.
- OOO import from a calendar feed to prefill planner days off.
- Confluence export of standup notes and the quarterly overview. Never 1:1 notes.
- Slack integration: a button that posts the standup recap through a webhook.
- Jira-links redirect for custom-domain (Data Center) sites, which would mean
  listing every https site in `web_accessible_resources`.
- A real build step and test runner, once module count justifies it.

### Design decisions taken and not revisited

Looked at during the 2026-09-06 design pass and deliberately left. Re-open only
with the author.

- **No undo on drag-to-transition.** A workflow transition is often one-way.
  Undo would be a second write, and every write is user-initiated and
  enumerable.
- **The dark theme's chip tones.** `--tone-red` (3.96:1) and `--tone-purple`
  (3.71:1) sit marginally under AA against their chip backgrounds. The palette is
  pinned, and moving two tones to clear a threshold is a scheme change.
- **The hash-coloured card top border.** Every board card gets a 3px top edge from
  `hashColor(issue.key)`, which carries no meaning. Removing it, or making it
  carry days-to-due, is an open taste call.
- **The nav's ticking wall clock**, in the visual centre of the shell, while how
  stale the data is sits in 11px muted text. Same kind of call.
- **The dashboard's `✓ ! ✕ –` hygiene scale.** Text, with the word printed beside
  each mark. Turning a severity scale into icons is a design decision.
- **Kanban's and Monitor's interiors.** Both had their chrome redone. The shape of
  the things themselves has not been reconsidered; any further pass is a redesign
  with a stated intent, started in the harnesses in both themes.
- **The Backlog still owns the view header's class names** (`.bl-header` and
  friends, aliased in `css/app.css`). Move it to `viewHeader()` the day that file
  is open for another reason.

---

## Shipped milestone labels

For decoding code comments and commit subjects. Details are in the changelog and
in `git show c818893:docs/ROADMAP.md`.

| Label | What shipped |
|---|---|
| M0 | Hygiene and foundations |
| M1 | Whitelabel: configurable site, brand, fields |
| M2 | Durable identity and config, storage migrations |
| M3 | Team roster |
| M4 | Monitor tab (hygiene checks) |
| M5 | Issue detail |
| M6 | Standup mode |
| M7 | Sprint dashboard and daily snapshots |
| M8 | Write layer and issue creation |
| M9 | Command palette |
| M10 | Retired unbuilt — its idea became M16 |
| M11 | GitHub sync |
| M12 | Firefox and Edge |
| M13 | Sprint freeze and diff |
| M14 | Weekly 1:1 sheet and My todos |
| M15 | Sprint planner |
| M16 | Quarterly overview (was "Quarter Wrapped") |
| M18 | Linked issues |
| M19 | Tagged releases built by CI |
