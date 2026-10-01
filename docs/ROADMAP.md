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
| Tests | 28 `scripts/test-*.mjs` suites (2389 checks), 14 preview harnesses in `preview/`, a manual `scripts/SMOKE-CHECKLIST.md`. CI runs the suites on every push and pull request |
| Licence | [PolyForm Noncommercial 1.0.0](../LICENSE) |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Order of work

```
M21 Planner polish (S–M) ─▶ M23 Planning as a process (L, v0.9.0) ─▶ M22 1:1 screen improvements (S–M) ─▶ M24 Assisted planning (L, gated) ─▶ M17 Per-sprint history (M) ─▶ M20 1:1 recording (L, gated)
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
  transition, so M15 added none. M23 adds three, settled 2026-10-01: create,
  start and complete a sprint.
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
| Writes corrupt real sprint data | Planner (shipped), M23 | Device-local draft, Jira re-read before the review, one confirmed batch, each failure retried alone up to three times and then reported by name. No write on drag |
| Request fan-out across boards hits rate limits | Planner (shipped), M17 | Reuse cached aggregates, batch where the API allows (sprint moves already batch 50) |
| Per-person figures read as a performance measure | 1:1, recap, quarterly | Stated framing on every surface. Ranked only in the quarterly overview, at the author's request |
| A planner that proposes who does what is worker-management AI | M24 | Suggestions change the draft only and are accepted by hand. AI Enablement review (EU AI Act Annex III, GDPR) before the assisted half is built; any LLM only through the approved LiteLLM gateway |
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


## M21 — Sprint planner polish

**Size: S–M, as a set.** Follows M15. Polish and bugfixes on the planner's two
screens as they are: sprints are still created, started and closed in Jira's
own UI. Anything that changes that, or that has the app suggest a plan, is M23.

### Shipped from it so far

- [x] **Story points value setting** (2026-10-01): Settings → Sprint planner →
      Hours per story point, default 8, against a fixed eight-hour day (so 4
      makes a point half a day). Days stay days on screen; capacity is scaled to
      points, and a `%` buffer scales with it. Estimates in Jira are not
      rescaled.
- [x] **Split, as the author's flow describes it** (2026-10-01). The original is
      renamed "<summary> - pt.1", keeps the points typed for part one, and is
      moved to Done. "<summary> - pt.2" gets the rest of the points, the same
      due date and the same parent. The two are linked, and each gets a comment
      naming the other. Every step reports on its own. A project that refuses
      `parent` or `duedate` on create gets part two without it, then the due
      date by a field write. Splitting "… - pt.2" again makes "… - pt.3".

### Still to do

- [ ] **Public holidays without typing them.** A Dutch holiday calendar built
      in (computed, so Easter-based dates need no table per year), taken off
      the suggested working days with each holiday named. Optionally a calendar
      feed (ICS URL) for personal leave, the iCal idea in the deferred backlog.
      That is a new host permission, so it is opt-in and per origin.
- [ ] **Part two in To Do explicitly.** If a workflow's first status is not in
      the To Do category, Split would transition part two there. Only worth
      doing once a site shows the case.
- [ ] **The people strip.** See open question 7.

### From M15 QA (2026-09-30)

Setup screen:

- [x] **Cross-board carryover.** Shipped 2026-10-01, built as open question 1
      proposed: "From another board", under each board's "Carry over from",
      lists the other boards' active and last closed sprints. Their leftovers go
      into the target sprint of the board they were picked under. The other
      board does not have to be planned. Please confirm that shape.
- [x] **Dates: calendar picker.** Shipped 2026-10-01: a click anywhere in either
      date field opens the browser's calendar, not only the icon. A range
      picker is still open question 2.
- [x] **Dates: one line of help, below the pickers.** "Defaults to the number of
      working days in the timeframe: 10 weekdays. Override above for holidays."
- [x] **Buffer: one line of help** under the controls.
- [x] **Buffer: a % / # toggle** instead of the dropdown.
- [x] **Buffer: default 20%** for a new draft. A stored draft keeps its own.
- [x] **People: help text removed**, both lines. The table's heading carries
      the buffer's unit instead.

Planner screen. **The design basis is a 14" MacBook Pro, browser window
maximised (about 1512 × 830 CSS px of page, 754 of it below the app's nav).**
Planning 40+ issues across eight people does not work when each column shows
three cards, so vertical space is the constraint every item here serves.

- [x] **Planned cards, much shorter.** Shipped 2026-10-01: two lines, 66px
      instead of about 130. Key, status, epic, due date and story points on the
      first; summary and assignee on the second. The assignee is one control,
      avatar and name, that opens a list of the plan's people (arrows and
      Escape work).
- [x] **Candidate cards, the same**, with Split and + at the end of the second
      line.
- [x] **Add an issue from another board: a small + beside the filter**, which
      opens into the key or link field and an OK button.
- [x] **More of the screen for the lists**: the header is one row with the
      figures and buttons in it, and each person's card is two lines. At the
      design size the candidate list shows six cards, up from three.
- [ ] **The people strip** find a way to have pl-strip button/cards be less tall

Bug:

- [x] **Only the first per-person override was saved** (reported in Chrome:
      "can't override capacity for multiple people, or changing DAYS more than
      once per cell; sometimes it randomly works"). Fixed 2026-09-30. Each save
      replaced the draft object while the rows on screen still pointed into the
      old one, so later edits went to a copy that was never saved again, until
      the next repaint re-pointed them, which is why it sometimes worked. Every
      setup field was affected, not only capacity. The planner now keeps one
      draft object for the life of the screen.

### Open questions

1. **Cross-board carryover: is the shape right?** Built as described above:
   sources from any board, leftovers into the target of the board they were
   picked under, and the source board need not be planned. Should a source
   board's backlog also be offered?
2. **The calendar picker: is opening on click enough,** or is the ask one range
   calendar that picks start and end together?
3. **Hours per working day.** The new setting assumes an eight-hour day. Should
   the day be a setting too, or set per person for part-time?
4. **Story points value: synced, or per device?** It is in synced config now,
   with the boards. Say if it should differ between machines.
5. **Split: are the comments' words right?** Part one says the rest continues in
   part two; part two says it continues part one. Both are fixed text.
6. **Split: what should part one's points default to?** It is blank, with part
   two showing the whole estimate until part one is typed. The alternative is
   half each.
7. **The people strip.** The note stops at "find a way to have pl-strip
   button/cards". What should it do or become? Some readings: hidden behind a
   toggle, a narrow sidebar instead of a row, one line per person, or each
   person's card opening their plan.

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

## M23 — Sprint planning as a process

**Size: L · Target release: v0.9.0.** Next after M21. The author's ten-step
planning ritual (below) as one flow in the app, from wrapping up the outgoing sprint to starting the new
one, including the sprint writes Jira's UI does today. Not gated: nothing here
proposes the plan; that is M24.

### Settled 2026-10-01

- **Shape:** a process of screens; four, per the proposal below.
- **Scope:** one board is one planning session.
- **Sprint writes are in scope:** create, start and complete. Each is a new kind
  of Jira write, recorded here as the product decision "Rules in force" asks
  for.
- **Recap:** generated automatically before the outgoing sprint is closed.
- **New issues:** a quick inline row or small modal: title, parent,
  description, assignee, story points.
- **Scope snapshot:** taken automatically the moment the new sprint starts.
- **Who runs it:** one person, possibly sharing the screen.
- **Other boards:** an issue from another board joins by "add an issue from
  another board" and a link, not by a cross-board carryover setting. Today's
  multi-board setup and carryover code is moved into the flow where that is
  little work, and copied where moving it would not be.
- **Four screens:** filling and balancing share the Plan screen.
- **Wrap-up default:** every open issue shows, and goes to the backlog unless
  it is deliberately moved into the new sprint.
- **Jira refusing to start the sprint:** a **Retry** button and a link to the
  board in Jira, so it can be done there by hand.
- **Carried issues touch two sprints' history briefly** (moved in before the
  old sprint closes). Accepted, as long as it does not break the snapshots: the
  freeze reads the new sprint's issues at the moment it starts, so it does not,
  and the closed sprint's daily snapshots stop at its last day as now.
- **Solo and group modes:** a toggle between solo (small type, as much on
  screen as fits) and group (larger type, for sharing the screen).

### Proposal

Four screens, with a step bar across the top and Back/Next. The draft stays on
the device as it does now, so the flow can be left and resumed at any screen.
Nothing is written to Jira until the last screen, except Split and quick
create, which write at once from their own confirm as they do today.

1. **Set up.** Pick the board. Pick the new sprint from its upcoming sprints,
   or **New sprint…**: name, dates, goal, created at once from its own
   confirm, because everything after this needs a real sprint id. Then dates,
   working days, buffer and people, as on today's setup screen.
2. **Wrap up the outgoing sprint.** Its open issues, one row each, with three
   choices: **Carry** (into the new sprint as is), **Split** (part one closes
   here, part two is carried), or **Back to backlog**. The default is backlog,
   because carrying should be a decision. Points and assignees can be fixed
   here.
3. **Plan.** Today's planning screen for the one board: the carried issues
   already in, the backlog beside them, people's capacity at the top, and a
   **+ New issue** row (title, parent, description, assignee, points) that
   creates in Jira and lands in the plan. Balancing between people is
   reassigning here.
4. **Review and start.** Every write, as today's Review & push lists them, then
   one confirm that runs, in order:
   1. open the outgoing sprint's recap in a new tab (on the click itself, so
      the browser allows the tab);
   2. the field writes and the moves into the new sprint;
   3. complete the outgoing sprint, whose open issues not carried go to the
      backlog;
   4. start the new sprint;
   5. take the sprint freeze, the scope snapshot M13 already defines, at that
      moment.

   Each step reports on its own. A failure stops the steps after it, since
   starting a sprint on top of a failed close is worse than stopping, and the
   screen says what has and has not happened.

### The planning flow, as the author runs it

```
1. Generate a sprint recap of the sprint about to be closed
2. Look at all still-open issues from last/current sprint
3. Split up ones that are med+ sized and are currently in progress (and that
   progress we intend to continue - not always the case) into two parts,
   labeling current "ORIGINAL_ISSUE_NAME - pt.1", and marking it as "Done",
   then creating a follow-up "ORIGINAL_ISSUE_NAME - pt.2" issue, adding it to
   new sprint. Both parts should reference each other with a link and a
   comment explaining the split is to be posted in both tasks. If the original
   had a set due date, same due date applies to the follow-up task. Split
   original's story points between pt1 and pt2.
4. Close the old sprint, moving the remaining still-not-done stuff from old
   sprint to backlog
5. Look at backlog, put some stuff from there in the sprint
6. Evaluate story points for all stuff added to new sprint
7. Pick and choose what else to add to sprint from backlog if spare capacity
   exists OR create a few more issues to put in OR move stuff out of sprint if
   not enough capacity
8. Shuffle and reassign stuff between people to balance workload
9. Start a new sprint once satisfied with the split
10. Generate a snapshot of what the scope is for the newly started sprint to
    compare end-of-sprint state against when wrapping the current one up
```

### Open questions

None open. Build questions get asked as the screens are built.

## M24 — Assisted sprint planning

**Size: L, gated.** Follows M23. The app proposing parts of the plan instead of
every card being placed by hand.

**Gated, like M20.** It proposes who does what, and assigning work to named
people by capacity is close to what the EU AI Act lists as high-risk: Annex
III, point 4, AI used to allocate tasks to workers. If it uses an LLM, Jira
content about colleagues also leaves the device, which the binding constraints
do not allow today. **Raise both with AI Enablement before it is built**,
including whether an LLM is used at all and, if so, only through the approved
LiteLLM gateway with a key provisioned through them:
https://stxgroup.atlassian.net/servicedesk/customer/portal/1/group/819

Whatever the engine, the rule stays: a suggestion changes the draft, never
Jira, and is accepted or undone by the person planning before the push.

### What it would propose

The author's ideas, 2026-10-01:

- [ ] **Split between sprints, in one press**, on an issue in the outgoing
      sprint that is in progress and not finished: Split with part one's and
      part two's points already proposed.
- [ ] **Smart-assign leftovers.** For issues added to the sprint without an
      estimate, propose story points; then propose an assignee for each among
      the plan's people, by their remaining capacity.
- [ ] **Suggest filling remaining capacity.** Take the next issues from epics
      already in progress, in order, into the plan until capacity is reached.
- [ ] **Proposed due dates.** For each planned issue, a due date from its
      estimate, the other work already planned for the same person, and for an
      epic the due dates and points of its children. Written only if accepted:
      a due-date write, a kind the app already makes.

### Open questions

1. **Rules or a model?** Several of these can be plain arithmetic the app
   already has the data for: remaining capacity, epic order, the share of an
   estimate already worked. Which ones are you picturing needing an LLM? The
   ones that do not need one avoid the AI Act and data questions entirely.
2. **What does a proposed estimate come from?** Similar past issues, the
   summary and description, the epic's own estimates? Each is a different data
   flow to describe to AI Enablement.
3. **Smart assign: by capacity only, or by fit too?** Capacity alone (who has
   room) is load balancing. Matching people to work by history or skill is
   the part Annex III is about, and the one to ask about first.
4. **"Next items from in-progress epics": next by what?** Backlog rank, epic
   priority, due date, or how close the epic is to done?

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
