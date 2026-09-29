# butter_jira — Roadmap

Last updated: 2026-09-29

An MV3 browser extension for Chrome, Firefox and Edge that gives one tab of
Gantt, Backlog, Kanban, sprint and team views over several Jira Cloud boards.

**This file holds what is still open, plus the rules that constrain it.**
Completed milestones were removed on 2026-09-29. What shipped is in
[CHANGELOG.md](CHANGELOG.md). The full milestone record, with the reasoning
behind every shipped decision, is the version of this file at commit `c818893`
(`git show c818893:docs/ROADMAP.md`). Shipped milestone labels still appear in
code comments and commit subjects, so they are indexed at the bottom.

## Current state

| Aspect | Status |
|---|---|
| Browsers | Chrome 111+, Firefox 115+, Edge 111+ — one codebase, three manifests |
| Views | Sprint dashboard, Gantt, Backlog, Kanban, Monitor, Standup, 1:1 (picker + per-person sheet), My todos, Recap config, Issue detail (drawer + full page) |
| Documents | Sprint recap PDF (active, last closed, or any chosen sprints) and quarterly overview PDF, both print-styled pages of their own |
| Jira writes | Transitions, field edits (assignee, due date, story points), issue and sub-task creation, comments, issue links (the only DELETE). Nothing else writes |
| Second source | Optional GitHub sync (`js/github.js`), read-only, scoped to an explicit repo allowlist. Feeds the standup, dashboard, recap, quarterly overview and each issue's Development section |
| Permissions | `storage`, `declarativeNetRequestWithHostAccess` (the opt-in Jira-links redirect), host access to `*.atlassian.net` and `api.github.com`, optional host access for anything else |
| Storage | Synced storage for config. Device-local for tokens, the roster, view prefs, daily snapshots, sprint freezes, 1:1 notes, todos and a five-minute response cache. Settings backs up everything but tokens and 1:1 notes to a file, and restore merges |
| Build step | None to run it; `scripts/build.mjs` packages the three targets (copy plus manifest, no compilation) |
| Releases | Tag-led: a `v*` tag makes `.github/workflows/release.yml` run every suite, build and verify the three zips, publish them with checksums, and push the version bump to `main` |
| Tests | 27 `scripts/test-*.mjs` suites (2295 checks), 13 preview harnesses in `preview/`, a manual `scripts/SMOKE-CHECKLIST.md`. CI runs the suites on every push and pull request |
| Licence | [PolyForm Noncommercial 1.0.0](../LICENSE) |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Order of work

```
M15 Sprint planner (L) ─▶ M17 Per-sprint history (M) ─▶ M20 1:1 recording (L, gated)
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
  a product decision, not an implementation detail. That matters for M15, which
  may need several.
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
| Writes corrupt real sprint data | M15 | Draft mode, one reviewed batch, per-issue failures reported by name. No write on drag |
| Request fan-out across boards hits rate limits | M15, M17 | Reuse cached aggregates, batch where the API allows (sprint moves already batch 50) |
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

## M15 — Sprint planner

**Size: L** · Every dependency is in place: the write layer (sprint moves
batched 50 at a time, assignee and story-point writes with rollback), the roster,
the dashboard aggregates, and the daily snapshot's per-person block, recorded
since 2026-08-20.

**The scope as it stands:**

- **Inputs:** sprint length and working days, days off per person, an optional
  focus factor.
- **Capacity per person:** from historical velocity in the app's own snapshot
  history, not Jira's closed-sprint data, with a manual points-per-day rate for
  anyone without history.
- **Carryover:** the unfinished issues from the current sprint, with their
  points, listed before anything new.
- **Assignment:** pick backlog issues and give each to a person. Each person has
  a live utilisation bar, with warnings at 100% and 120%, and the team's
  committed points show against its capacity throughout.
- **Draft, then push:** plan locally, review the full diff, then push every
  sprint move and assignment in one confirmed batch. Never write on a drag.

**What velocity history exists.** Snapshots before 2026-08-20 have no
`byPerson`, so a person's history is at most about three sprints today. The
unassigned bucket is recorded under `__unassigned__`, so rows sum to the day's
totals.

**Exit criteria:** a sprint can be planned in the app and pushed to Jira in one
reviewed batch, with per-person utilisation visible throughout and any failed
write attributed rather than silently dropped.

**A first cut was sketched on 2026-09-29 for a planning session the next day:**
capacity, carryover first, click-to-assign into a draft, utilisation bars and a
reviewed push, with drag-and-drop and multi-board planning deferred. It was not
built. The questions below come first.

### Open questions — to settle in a scoping pass before building

**The session**

1. **Who drives it, and on what screen?** Shared on a big screen during the
   meeting, like the standup (large type, the keyboard owned for the duration),
   or prepared by one person beforehand and reviewed in the meeting? The answer
   changes the whole layout.
2. **One board or all of them?** The team works across several boards. Is it one
   plan across every configured board, with capacity per person across all of
   them, or one board at a time?
3. **Can a draft be prepared the day before and finished in the meeting?** That
   means keeping the draft on the device and re-checking it against Jira before
   the push, since issues may have moved in between.

**The sprint itself**

4. **Plan into a sprint that already exists, or create it?** Today the app reads
   only active and closed sprints. Reading future sprints is a new read.
   Creating a sprint, and setting its name, dates or goal, would each be a new
   kind of write.
5. **Does the app start the sprint, or close the old one?** Jira's "complete
   sprint" is also what moves unfinished issues on. Doing either here is a new
   write with consequences Jira normally confirms itself. Leaving both in Jira
   is the conservative answer.

**Capacity**

6. **What unit is capacity in?** Story points (what the velocity history
   holds), issue count for people who don't estimate, or hours? And how are
   unestimated issues treated: zero, a default, or a blocker until estimated?
7. **How is a person's velocity computed?** Mean of their last N sprints'
   completed points, done only or done plus in review, and what N, given at most
   about three sprints of per-person history today? What about someone new to
   the team?
8. **Where do days off come from?** Typed in each session, or stored per person
   as a working pattern (part-time, a four-day week)? And public holidays:
   typed, or a Dutch calendar built in? A calendar feed is in the icebox.
9. **A buffer for unplanned work?** A fixed share of capacity held back for
   support and incidents, per team or per person, and does the focus factor
   already cover it?

**The plan**

10. **Carryover by default?** Are unfinished issues included in the new sprint
    automatically (their remaining points counting against capacity, and
    removable), or offered for selection like everything else?
11. **Which issues are candidates?** The board backlog in its rank order, plus
    filters by epic, label or priority? Issues from other boards? Should it
    surface each epic's remaining work to steer the choice?
12. **Can the plan hold unassigned issues?** A team that pulls work needs
    unassigned items in the sprint. Do they count against team capacity but
    no one's bar?
13. **Is estimating part of the session?** Editing story points in the planner
    already works through the field write. Should unestimated candidates be
    estimated in line, before they can be committed?
14. **Order within the sprint.** Does the plan's order need writing back as Jira
    rank? That is a new write (the rank API) and the one most likely to be
    refused on a busy board.

**The push**

15. **What goes in the batch?** At least sprint moves and assignments. Story
    points if estimated in the session. A sprint goal and rank only if 4 and 14
    say so. Each extra kind of write is a product decision under "Rules in
    force".
16. **What happens on a partial failure?** Retry just the failures, report and
    stop, or offer to undo what landed? Undo is a second write and the app has
    none.
17. **Hygiene before the push?** Should the Monitor checks (no estimate, no
    assignee, overdue) run over the plan and warn before anything is written?

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
| M16 | Quarterly overview (was "Quarter Wrapped") |
| M18 | Linked issues |
| M19 | Tagged releases built by CI |
