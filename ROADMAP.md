# butter_jira — Roadmap

Last updated: 2026-09-03

An MV3 browser extension for Chrome, Firefox and Edge, giving Gantt, Backlog,
and Kanban views over Jira Cloud boards. This roadmap takes it from an internal single-tenant tool to a
configurable, team-facing sprint cockpit that any org can clone and point at
their own Jira site.

**How this file is ordered:** context first, then what is still open, then the
deferred backlog, then everything already shipped. Completed milestones are kept
in full rather than summarised away — they are the record of *why* each thing is
built the way it is, which is the part that gets forgotten.

## Current state

| Aspect | Status |
|---|---|
| Browsers | Chrome 111+, Firefox 115+, Edge 111+ — one codebase, three manifests |
| Views | Sprint dashboard, Gantt, Backlog, Kanban, Monitor, Standup, Issue detail (drawer + full page) |
| Data access | HTTP Basic (email + API token), `js/api.js`. Reads, plus five writes: transitions, field edits, issue and sub-task creation, comments, issue links (the app's only DELETE) |
| Derived reads | Per-person Jira activity (`js/activity.js`) from `expand=changelog` riding the sprint fetch — no requests of its own. Sprint freeze and diff (`js/freeze.js`) over a per-issue record written forward at rollover |
| Endpoints | `/rest/api/3/myself`, `/rest/api/3/field`, `/rest/api/3/search/jql`, `/rest/api/3/issue/*` (incl. `createmeta`), `/rest/api/3/issueLinkType`, `/rest/api/3/issueLink/*`, `/rest/agile/1.0/board/*`, `/rest/agile/1.0/sprint/*/issue` |
| Second source | Optional GitHub sync (`js/github.js`), read-only, scoped to an explicit repo allowlist |
| Config | Single source: `js/config.js` (site, brand, boards, status groups, field mapping, GitHub block), overridable via `config.local.json` |
| Storage | Synced extension storage for config; device-local for both tokens, the roster, view prefs, schema version, the daily snapshots and per-sprint freezes, and a 5-minute response cache. One accessor module (`js/browser.js`) |
| Build step | None for Chrome; `scripts/build.mjs` packages Firefox and Edge (copy + manifest, no compilation) |
| Version control | Git, `.gitignore` in place |
| Tests | Seventeen `scripts/test-*.mjs` suites (1755 checks) + six preview harnesses + a manual smoke checklist |

## Sizing

T-shirt sizes, not dates: **S** ≈ a sitting, **M** ≈ a few sittings, **L** ≈ a
sustained chunk of work, **XL** ≈ needs breaking down further once started.

## Milestone numbering

**Renumbered 2026-09-03.** The open milestones were renumbered so the number
matches the queue position: reading down the list and reading up the numbers now
give the same order. The queue had been re-sequenced the same day and the numbers
had been left alone, which meant M13 was third and M10 fourth — a list that
needs a decoder ring to read in order.

The cost is paid here, once, in this table. Every completed milestone keeps its
number: M0–M9, M11 and M12 are cited in commit subjects (`M8:`, `M11:`, `M12:`)
and in code comments, and renumbering shipped work would strand all of it.

| Old | New | Milestone |
|---|---|---|
| M15 | **M13** | Sprint freeze and diff |
| M14 | **M14** | Weekly 1:1 screen (unchanged) |
| M13 | **M15** | Sprint planner |
| M10 | **M16** | Quarter Wrapped |
| M16 | **M17** | Per-sprint history |
| M17 | **M18** | Linked issues |

**M13 and M15 swapped**, which is the one genuinely dangerous row: anything
written before this renumbering that says "M13" means the *planner*, and "M15"
means the sprint freeze — under its earlier placeholder name in `45e560c`
("split M8, add M13/M14/M15"), and fully scoped in `44a55a8` ("re-sequence the
queue, scope M15/M16/M17"), which is dated the same day and landed hours before
the renumbering. Commit history is not rewritable, so this table is the only
place those two subjects can be reconciled.

**M10 is retired unbuilt.** It was Sprint Wrapped, re-aimed at the quarter on
2026-09-03 and renumbered to M16 the same day, so the number now names nothing
and stays vacant rather than being recycled onto a different feature. The
completed run therefore reads M0–M9, M11, M12 with a hole where a milestone was
planned and never shipped.

**The rule going forward:** a new milestone takes the next free number and joins
the queue at its number. If the queue is re-sequenced again, either the numbers
follow it and a dated row lands in the table above, or the sequence is stated
separately — and the second option is what produced the mess this table cleans
up, so the first is the default.

## Milestone sequence at a glance

**Dependencies** — what each thing needs, not the order it gets built in:

```
M0 Hygiene ✔ ─▶ M1 Whitelabel ✔ ─▶ M2 Durable config ✔ ─▶ M3 People ✔ ──┬──▶ M4 Monitoring ✔ ─▶ M5 Issue detail ✔
                                                                        │
                                                                        ├──▶ M6 Standup ✔ ─▶ M11 GitHub sync ✔ ─▶ M12 Firefox + Edge ✔
                                                                        │
                                                                        ├──▶ M7 Dashboard ✔ ──┬──▶ M9 Palette + Triage ✔
                                                                        │                     ├──▶ M8 Writes ✔ ──┬──▶ M15 Sprint planner
                                                                        │                     │                  └──▶ M18 Linked issues ✔
                                                                        │                     ├──▶ M13 Sprint freeze + diff ✔
                                                                        │                     └──▶ M17 Per-sprint history ─▶ M16 Quarter Wrapped
                                                                        │
                                                                        └──▶ M14 Weekly 1:1
```

**Order of work** — re-sequenced 2026-09-03, and the numbers were renumbered the
same day to match it, so this is the dependency graph's rows read in queue order
rather than a second scheme to keep in your head:

```
M18 Linked issues ✔ ─▶ M13 Freeze + diff ✔ ─▶ M14 Weekly 1:1 ─▶ M15 Sprint planner ─▶ M16 Quarter Wrapped ─▶ M17 Per-sprint history
```

**M18 was taken first, out of order, on 2026-09-03** — the second time the queue
has been jumped, after M11, and for the same reason both times: it hangs off a
finished dependency and strands nothing behind it. It was the S at the end of a
queue of Ms and Ls, its write layer had been sitting finished since M8, and
pulling it forward cost the rest of the queue a sitting. The order above is
otherwise the one the re-sequencing settled on, and the reason M13 leads it —
history only accrues forward — is unaffected by a milestone that touches no
history at all.

M16 is queued ahead of M17 because the button is the ask and the history is the
machinery behind it — but the arrow above runs the other way, and M16's GitHub
half is capped at 45 days until M17's rollups exist. That tension is stated in
both entries rather than resolved on this diagram.

Ordering logic: config plumbing first (M0–M2), because every later feature reads
from it and because losing your settings on every extension reload makes the
rest miserable to build. The people layer (M3) is a hard dependency for standup,
planning and the 1:1 screen. Monitoring (M4) lands early — it is pure
client-side derivation over data already being fetched, so it is the cheapest
real feature in the list. The write layer was deliberately isolated in M8, and
everything built before it is read-only.

**M8 was split on 2026-08-12.** It had been "write layer + sprint planner", an
XL carrying two things that share a dependency and nothing else. The write layer
was a gate — M9's triage mode and M4's in-app fixing both sat behind it, and both
were otherwise finished — while the planner is a screen that happens to need
writes at the very end of its flow. Bundled, the gate could not ship until the
screen did. Split, M8 is a shippable milestone that unblocks two others, and the
planner (now M15) is honestly sized on its own. Issue and sub-task creation
joined M8 rather than standing alone: they are the smallest useful thing the
write layer can carry, and they exercise it end to end.

M12 (the Firefox and Edge port) came out of the icebox on 2026-08-07 and is
orthogonal to the feature chain — it changes how every module reaches storage
without changing what any of them do.

M11 was taken **out of order, ahead of M8**, on 2026-08-07. It hangs off standup
rather than the M8 chain, is read-only against a second API, and shares nothing
with the Jira write path — so it could be pulled forward without stranding
anything, and the planner keeps its place in the queue rather than losing it.

**The queue was re-sequenced on 2026-09-03, the milestones were renumbered to
match, and the planner did lose its place — twice over, its position and its
number.**
Not for the reason the sentence above guarded against — nothing was pulled ahead
of it opportunistically. M13 went first because it writes history, and history
only accrues forward: a sprint boundary that passes unfrozen cannot be
reconstructed later, so every week M13 waits costs a data point M15's successors
would have wanted. M14 went ahead of it too, being an M whose dependencies were
all paid against the planner's L. The planner is still fully unblocked, is still
the largest thing in the file, and is now **M15** — it was M13 for three weeks,
and M8b before that, which is a third label for one screen and the reason the
renumbering rule is written down rather than left to judgement.

**Three entries changed shape the same day.** M13 went from a one-paragraph
placeholder to an agreed scope. M16 was re-aimed from a per-sprint PNG card to a
quarter-to-date PDF, because the formal sprint document already shipped on
2026-08-18 and nothing in the app looks past the current sprint. And the
*recapping closed sprints* follow-up was dropped in favour of M17, which keeps a
per-sprint rollup written forward at rollover instead of re-fetching a closed
sprint from Jira — the same build-history-forward argument as the burndown and
open question 3, applied a third time. M18 was added new.

## Risk register

| Risk | Milestone | Mitigation |
|---|---|---|
| Request fan-out across boards hits rate limits | M7, M15 | Reuse cached aggregates, per-resource TTLs, batch where the API allows |
| Writes corrupt real sprint data | M8, M15 | Draft mode, batch confirmation, undo window, isolated write helpers |
| A generated create form still 400s on an unfamiliar site | M8 | Fields come from `createmeta` per project and type; the sub-task type is read from `subtask: true`, never matched by name |
| Notes about a named colleague are the app's most sensitive data | M14 | Device-local, never synced, own export checkbox and confirm, bounded retention, no ranking or evaluation framing |
| ~~A per-issue freeze for eight sprints is the largest thing kept on device~~ | M13 ✔ | Measured, not assumed: a 60-issue sprint freezes to ~22 KB, eight to ~170 KB, asserted and printed by `scripts/test-dashboard.mjs`. Pruned with `MAX_SPRINTS_KEPT` **imported from `js/snapshots.js`** rather than copied, so the two caps cannot drift apart |
| ~~Scope-added silently changes meaning depending on whether a freeze exists~~ | M13 ✔ | Resolved, and in three states rather than two: no freeze is the creation-date approximation, a start-of-sprint freeze is exact, and a mid-sprint freeze is exact only from the day it was taken and says which day. One function (`scopeBasis`) writes the sentence for the tile and the PDF, so they cannot disagree |
| A quarter is ~90 days and the GitHub window is 45 | M16, M17 | Store per-sprint rollups at rollover; until they exist, the quarter document states the shorter window it actually covers |
| Lines of code read as a productivity measure | M16, M17 | Team-level per sprint only, never per person, labelled as lines reaching the default branch |
| ~~Unlinking an issue is destructive and Jira offers no undo~~ | M18 ✔ | Resolved: a confirm naming both issues and the relationship, and no ✕ at all on a sub-task row, which has no link to remove. The DELETE goes through the same `jiraWrite` every other write does — `jiraWrite` learned to send no body rather than the method getting a path of its own |
| ~~`/rest/dev-status/1.0/` is undocumented~~ | M5 → deferred | Avoided entirely: dev links move to the GitHub API in the deferred backlog |
| ~~Untrusted Jira HTML reaching the DOM~~ | M5 ✔ | Allowlist sanitiser with the element walk unit-tested; CSP as defence in depth |
| ~~First write path (comments) misfiring~~ | M5 ✔ | Single narrow endpoint, comment re-rendered from Jira's response, explicit 403 handling |
| ~~Hardcoded `customfield_*` IDs are instance-specific~~ | M1 ✔ | Resolved: discovery via `/rest/api/3/field` + manual override per role |
| ~~greenhopper sprint report is undocumented~~ | M7 ✔ | Avoided: daily local snapshots instead, with the trade-off stated in the UI |
| ~~Token expiry mistaken for a broken app~~ | M2 ✔ | Resolved: expiry tracking, T-14 banner, token-only re-auth prompt |
| ~~GitHub search rate limit (30/min) throttles standup~~ | M11 ✔ | Avoided: the search API is not used at all. Aliased `repository()` fields over the declared repos, one POST, against the 5000-point/hour budget |
| ~~A wide-access token quietly widens the standup's scope~~ | M11 ✔ | Resolved: the repo allowlist is the only scope. An empty list means off, whatever the enable flag says |
| ~~A dead GitHub token reads as the app being broken~~ | M11 ✔ | Resolved: separate credential, separate banner, separate wording. Every GitHub failure degrades to the panel being absent |
| ~~A second identifier per colleague widens the personal-data surface~~ | M11 ✔ | Resolved: `githubLogin` lives in the roster record — local-only, excluded from export unless explicitly ticked |

## Open questions

1. ~~**Distribution**~~ — answered 2026-08-05: unpacked now, possible Web Store listing later. The manifest `key` is in place for unpacked use and must be deleted before any store upload.
2. ~~**Board-per-project assumption**~~ — answered 2026-08-12: the fix is chosen and written up under *Several boards over one project* in the deferred backlog, but not scheduled. The current deployment is one board per project, so neither of the two bugs is live here; the entry names which half to pull forward first if that changes.
3. ~~**Velocity source for the planner**~~ (originally "for M8"; the planner became M13 at the split and is **M15** since the 2026-09-03 renumbering) — answered 2026-08-12: **historical, from the app's own stored history.** Not from closed-sprint data mined out of Jira — same reasoning as the M7 burndown, which is the precedent this follows: build history forward in `js/snapshots.js` rather than lean on `sprintreport`. **Consequence acted on 2026-08-20, ahead of M15:** snapshots recorded team totals only, and per-person velocity needs a `byPerson` block. Since a forward-built history accrues only from the day it starts being written, the field was added on its own rather than waiting for the planner — `snapshotFrom` (`js/snapshots.js:39`) now writes one row per person, keyed by account id, carrying assigned and completed points and issue counts plus the display name as it read that day. M14 reads the same field.
4. ~~**Team scope**~~ — answered 2026-08-05: one roster, but stored under a team key from the start so a switcher can be added later without a migration.
5. ~~**Repo list per board?**~~ — answered 2026-08-12: no, one flat list stays. Revisited only if a real team runs into it. The allowlist is already the only scope, so scoping it per board stays cheap whenever it is actually wanted.

6. **How much history should the app keep?** Open, raised 2026-09-03 by M17. Daily snapshots are capped at eight sprints (`MAX_SPRINTS_KEPT`), which is right for sixty rows per sprint and wrong for one rollup row per sprint — a trend chart wants years of those. M13's per-issue freezes pull the other way, being the bulkiest thing stored. Three stores with three different right answers, so the cap stops being one constant and becomes a decision about what the extension keeps on the device.
7. ~~**Lines of code as a metric**~~ — answered 2026-09-03, when it was asked for in M17: **team-level per sprint, never per person.** It sits next to issue counts as a volume signal, and `fetchTeamStats` measures lines reaching the default branch, so that is what it is labelled. Same rule M16 and M14 already carry, and the reason the recap PDF prints its own framing.
8. **Where does a quarter start?** Open, raised 2026-09-03 by M16. Sprints straddle quarter boundaries, so a quarter-to-date document either cuts a sprint in half or counts a sprint that started in the previous quarter. Calendar quarters with whole sprints assigned to the quarter they end in is the likely answer, but it needs stating on the document rather than implying.

---

# Open

**Re-sequenced 2026-09-03**, and **M18 and M13 both shipped the same day** —
M18 out of order and ahead of the rest, M13 in its place at the head of the
queue. What is left, in order: **M14** (weekly 1:1) → **M15** (sprint planner) →
**M16** (Quarter Wrapped) → **M17** (per-sprint history). The sections below are
in that order.

**The numbers were renumbered to match**, the same day and for the obvious
reason: a queue whose numbers run 13, 14, 15, 16, 17, 18 can be read in order,
and one that ran 15, 14, 13, 10, 16, 17 could not. The old numbers, and the two
commit subjects that use them, are reconciled in the table under *Milestone
numbering* above — M13 and M15 swapped, so that table is worth reading before
trusting any pre-2026-09-03 reference to either.

Why this order — written when all six were open, and kept because the reasoning
is what makes the remaining four's order legible. The first two shipped on
2026-09-03 and their entries are under *Completed*:

- **M13 first** ✔, though it was the vaguest of the three, because a forward-built history only accrues from the day it ships. Every sprint boundary that passes without a freeze is one that cannot be reconstructed afterwards — the same argument that pulled the snapshot `byPerson` block forward ahead of M15 on 2026-08-20, and the same argument `js/snapshots.js` opens with. It also makes M7's approximate scope-added figure exact, which is a caveat currently printed in the UI and in the recap PDF.
- **M14 next**, and now the head of the queue: an M whose dependencies are already paid (the roster, `activityFrom`, the `byPerson` block), against the planner's L. It has four open questions that want answering before any work starts, and answering them is cheap.
- **M15 after that.** Still the biggest thing in the file, still fully unblocked; it loses its "next up" position rather than any of its readiness.
- **M16 then M17**, in that order because the button is the ask and the history is the machinery behind it — but see M17's note on the 45-day GitHub window, which the quarter document runs straight into. If M16 is started first, its GitHub half is scoped to what one window covers until M17 lands.
- **M18 last** ✔ only because it is an S that unblocks nothing — "the obvious thing to pick up in a gap", which is what happened to it the same afternoon.

---

## M14 — Weekly 1:1 screen

**Size: M** · Depends on M3 (roster). Reads M7 aggregates and M11 GitHub
activity. Independent of the write layer unless it grows follow-up actions.
**Next up.**

**Scope below is a first pass, not an agreed spec** — recorded 2026-08-12 from a
one-line request so the intent is not lost. The open questions at the end are
the parts that would change the shape of it.

One person, one week: the sheet you would otherwise assemble by hand in the ten
minutes before a 1:1.

- **Pick a person** from the roster, and a week (defaulting to the one just ending).
- **What they did** — issues closed and moved this week, PRs opened, merged and reviewed. M11 already fetches per-person GitHub activity; it currently windows on *since the last working day* for standup, so this needs a week window over the same query rather than a new source. **The Jira half of this is already built:** `activityFrom(issues, { since, until })` (`js/activity.js`, done 2026-08-24) answers "closed and moved" per person over any window, and a week-long one is exercised in `scripts/test-activity.mjs` precisely so this milestone does not discover it. What is left here is the screen, and — the one real gap — a source of issues for a week that is not the current sprint, since the reader is fed the sprint fetch today. **M16 needs the same thing over a quarter**, so whichever lands first should build it as a shared reader taking a window, not a private one.
- **What is stuck** — their blocked and overdue items, and the PRs where they are the blocker or are being blocked, reusing M11's "changes requested → failing checks → approved-and-unmerged → waiting on review" ordering, which already sorts by how stuck rather than how recent.
- **Load over time** — their points per sprint across stored snapshots. The `byPerson` field this needs exists as of 2026-08-20 (see M15), so this milestone reads it rather than adding it — bounded by how far back history had started accruing when the screen is built.
- **Notes** — free text per person per week, saved as you type, with last week's notes and any open action items pinned at the top. A 1:1 tool that does not remember last week is a status meeting.

**Personal data — the part to get right first.** Everything else in this app
derives from Jira and GitHub and could be re-fetched. A 1:1 note is *written by
the user, about a named colleague*, and exists nowhere else. That makes it the
most sensitive thing the extension would hold, so the roster's treatment is the
floor and not the ceiling:

- Device-local, never `storage.sync`. The roster is already local for weaker reasons than this.
- Excluded from config export behind **its own** checkbox and its own confirm naming what the file would contain — the M2 pattern of one prompt per secret, because a single "this file has sensitive stuff in it" dialog teaches people to click past it.
- Bounded retention with a visible clear action, the way snapshots are pruned. Notes about people should not accumulate silently and forever.
- **Not a performance dashboard.** Same discipline M16 imposes on Quarter Wrapped, and the reason that entry keeps lines of code and pull-request counts team-level: activity is conversation fuel, not a score. No rankings, no per-person trend line framed as evaluation, no comparison between colleagues on one screen.

**Open questions:**

1. **Whose screen is it?** Manager preparing for a report, or each person prepping their own? That decides whether "pick a person" is a roster dropdown or fixed to the logged-in account, and it changes the personal-data answer considerably.
2. **Do notes ever leave the device?** Confluence export of notes is already in the icebox for standup. If 1:1 notes are ever exportable that needs deciding up front, not retrofitted.
3. **Week or sprint as the window?** A week matches the meeting's cadence; a sprint matches every other screen in the app and every number already computed.
4. **Read-only, or does it create follow-ups?** Turning an action item into a Jira issue is a natural ending and would make this depend on M8. Left out of the sketch above deliberately.

---

## M15 — Sprint planner

**Size: L** · Depends on M8 (write layer, done 2026-08-20), M7 (aggregates) and
M3 (roster). **Fully unblocked, third in the queue** — every dependency is in
place, including the two things added ahead of time for it: the snapshot's
`byPerson` block and the write layer's 50-issue sprint-move batching. It held
"next up" from 2026-08-20 until the 2026-09-03 re-sequence put M13 and M14 in
front of it; nothing about its readiness changed.

Split out of M8 on 2026-08-12 so the write layer could ship without waiting for
a screen this size. **Three labels, in order: "M8b — Planner" before 2026-08-12,
M13 from then until 2026-09-03, M15 since.** M8's own sub-parts were renumbered
when issue creation joined it, so the M8b label does not point here any more —
and M13 now points at the sprint freeze, so a pre-2026-09-03 reference to "M13
Sprint planner" is this entry while a bare "M13" is not.

- Inputs: sprint length, total working days, per-person OOO days, optional focus factor.
- Capacity: per-person points capacity from historical velocity (open question 3, answered — the app's own snapshot history, not Jira's closed-sprint data), with a manual points-per-day rate as the fallback for a team with no history yet.
- Carryover: unfinished issues from the previous sprint, with points, listed before you plan anything new.
- Assignment board: drag issues from backlog to a person; live utilisation bar per member with over-allocation warnings at 100% and 120%.
- Committed vs planned totals against team capacity, with the delta always visible.
- Draft mode: plan locally, review the diff, then push all assignments in one confirmed batch. Never write on every drag.

**The dependency that had to be paid early — paid 2026-08-20.** Per-person
velocity comes from snapshot history, and `snapshotFrom` recorded team totals
only. A history built forward accrues from the day the field starts being
written, so the `byPerson` block was added on its own well ahead of this
milestone rather than as part of it; the planner will arrive to whatever has
accrued since, instead of to an empty series and manual rates for its first
eight sprints. What it reads: a map keyed by account id, one row per person per
day, with `points`, `issues`, `donePoints`, `doneIssues` and the `label` as it
stood that day. Two things for the planner to handle rather than assume — rows
written before 2026-08-20 have no `byPerson` at all, and the unassigned bucket is
present under `__unassigned__` so the rows sum to the day's totals.

**Exit criteria:** a sprint can be planned in-app and pushed to Jira in one
reviewed batch, with per-person utilisation visible throughout, and any failed
write clearly attributed rather than silently dropped.

---

## M16 — Quarter Wrapped *(was "Sprint Wrapped", suggested feature 10)*

**Size: M** · Depends on M7 aggregates. Reads M17's per-sprint rollups for its
GitHub half — see the window problem below.

**Re-aimed 2026-09-03 from a sprint card to a quarter document, and renumbered
from M10 to M16 the same day.** Anything written before that date calls this
"M10 — Sprint Wrapped" and describes a PNG card for the retro; M10 itself is
retired rather than reused, so nothing else will ever answer to it. The reason for the change: the formal end-of-sprint artefact
already shipped (Sprint recap PDF, 2026-08-18), so a second sprint-shaped
document had nothing left to say, while nothing in the app looks further back
than the sprint it is in. The quarter is the window the team is actually asked
about and has no artefact at all.

**Quarter-to-date, on demand, as a PDF.** A button in the UI opens a
print-styled page that recaps the quarter so far.

- **Headline figures for the quarter:** points shipped, issues closed and opened, completion rate, sprints run, carryover across sprint boundaries, scope added mid-sprint — the last of which is exact only for sprints M13 froze, and is labelled accordingly.
- **A per-sprint strip** — the same series M17 draws, embedded rather than recomputed. This is the part that makes it a quarter document rather than three sprint recaps stapled together.
- **The GitHub half:** pull requests opened, merged and reviewed, and lines reaching the default branch. Team-level per sprint, never per person — see the framing note below.
- **The superlatives, kept.** They are the point of "Wrapped" and the only genuinely fun thing in the roadmap: *Deadline Whisperer* (most issues closed early), *The Ping-Pong Award* (most status transitions), *Carryover Champion*, *Epic Slayer* (finished the last child of an epic), *Ghost Ticket* (longest untouched issue still in sprint). Two are already read — *Ping-Pong* is `transitions` and *Deadline Whisperer* is `completed`, both per person out of `activityFrom` (`js/activity.js`) over whatever window the caller wants. What is left is picking a winner and drawing it. Note that the reader deliberately offers no sort-by-count: the superlative does its own ranking and owns the framing rather than inheriting one.
- **Where the button goes:** the Sprint Dashboard header, beside **Generate recap** (`js/views/dashboard.js:160-170`). Two buttons opening two print-styled documents from the same header need wording that separates them at a glance — "Generate recap" is the sprint, so this one names the quarter and the period it covers rather than saying "Wrapped", which tells a reader nothing about which document they are about to print.

**Print-to-PDF, not a canvas PNG.** The PNG export in the original sketch made
sense for a card to paste into a channel. A quarter document is a document, and
`recap.html` already established the route: print-styled page of its own, real
vector text, no PDF library in a repo with no build step. It also inherits four
paid-for lessons from that page, and re-learning any of them would be
inexcusable — `css/app.css` deliberately not loaded (its `html, body { overflow:
hidden }` clips a print job to one page), a readiness gate on every route to the
print dialog, the running header in a `thead` so it repeats *and* reserves
space, and per-source failures printed rather than degraded to a confident zero.

**Two data problems it cannot assume away:**

1. **The GitHub window is 45 days** (`STATS_LOOKBACK_DAYS`, `js/github.js:504`) and a quarter is about 90. The quarter's GitHub figures therefore cannot come from one live window. Either M17's stored per-sprint rollups supply the earlier half, or this document states that its GitHub figures cover only the last 45 days — which is a caveat, not a fix. This is the reason M17 sits next to it in the sequence.
2. **`activityFrom` rides the sprint fetch.** The superlatives read per-person activity out of changelogs that arrive with the current sprint's issues, so a quarter of activity needs an issue source spanning the quarter — a JQL search over the period rather than the sprint fetch. **This is the same gap M14 names** for its week window; whichever milestone lands first should build it as a shared reader rather than a private one.

**Keep it team-facing.** Superlatives name individuals, so: opt-in per team,
per-person opt-out in the roster, aim the jokes at tickets rather than people,
and no persistence of individual histories. A quarter is long enough that
per-person figures over it start to look like a performance review, which is
precisely what this must not be — so lines of code and pull-request counts stay
team-level, and the document carries the same explicit "this is not an
assessment" footer the recap PDF prints. It is a retro toy that grew a longer
window, and it should stay too obviously silly to be mistaken for a metric.

---

## M17 — Per-sprint history

**Size: M** · Depends on M7 (snapshots) and M11 (GitHub stats). Sits naturally
next to M13, which is the other thing that writes a record once per sprint.

**Scoped 2026-09-03.** Replaces the deferred *recapping closed sprints*
follow-up, which was dropped the same day: that entry proposed reading
`/board/{id}/sprint?state=closed` and re-fetching a finished sprint's issues to
produce a second recap document. This does the useful half of it — the trend
across sprints — without depending on Jira retaining anything, and without a
second document.

**One chart, several series, one row per sprint.** Issues opened, issues closed,
completion rate, pull requests merged, and lines reaching the default branch,
across the last N sprints.

- **A rollup record written once per sprint, not recomputed on demand.** This is the whole design, and it follows the precedent `js/snapshots.js` sets and the answer to open question 3: build history forward rather than mine it back out of Jira. Neither source can be re-read far back (see the bounds below), so a figure not stored when it was available is gone.
- **When it is written:** at sprint rollover, from the last daily snapshot of the outgoing sprint plus a GitHub window over that sprint's own dates. `sprintKey()` already detects the rollover for the snapshot store, and M13 hooks the same moment for its freeze — one detection, three writers.
- **What a row holds:** sprint id, name, start and end dates, issues opened and closed, points committed and completed, completion rate, and the GitHub figures — PRs opened, merged and reviewed, additions and deletions. Plus a per-source `partial` flag, because a row assembled from a truncated GitHub window or a snapshot series that started mid-sprint must be drawable as incomplete rather than as a dip.

**Two bounds to design around rather than discover:**

1. **`MAX_SPRINTS_KEPT = 8`** (`js/snapshots.js:25`) caps the daily-snapshot history at eight sprints, so "the last year" is not available from snapshots today. The rollup rows are tiny by comparison — one row per sprint against sixty days of rows per sprint — so they want their **own, much longer retention** rather than inheriting that constant. That is a deliberate decision about what the extension keeps on the device, not an implementation detail: it should be set explicitly, with a visible clear action, the way snapshots are.
2. **`STATS_LOOKBACK_DAYS = 45`** (`js/github.js:504`) caps a live GitHub window at 45 days, and `STATS_MAX_PAGES` truncates a busy repo at 300 PRs. So the GitHub half of any sprint older than roughly three sprints cannot be fetched at all — which is exactly why it is stored at rollover instead. A history built forward starts empty here too, and the chart says so rather than drawing a line from zero.

**Lines of code is a volume signal, not a productivity one — and it is
team-level only.** It answers "how much moved" alongside issue counts, which is
the only reason it is in the list. Never per person, never in a ranking, never
next to a name: the same rule M16 and M14 carry, and the reason the recap PDF
prints its own framing rather than trusting the reader to supply one. The chart
labels it as lines reaching the default branch, which is what
`fetchTeamStats` actually measures — PR diffs merged to default plus direct
commits — and not "lines written".

**A fourth chart primitive.** `js/charts.js` has three — `horizontalBars`,
`stackedBar` and `burndownChart` — and none of them draws several series over an
ordinal axis of sprints. Expect one more primitive there, following the mark
specs already stated at the top of that file, rather than a per-view SVG or a
charting library the CSP would block anyway. Five series on one axis with two
different units (counts and a percentage, plus lines of code at a wholly
different magnitude) is a legibility problem before it is a code problem — small
multiples are likelier to be the right answer than one chart with three y-axes.

**Where it lives:** a section on the Sprint Dashboard, below the burndown, and
embedded in M16's quarter document.

**Exit criteria:** after two sprint rollovers with the extension installed, the
dashboard draws a real per-sprint series for both halves, with partial rows
visibly partial and the empty case explained rather than drawn as zero.

**Open questions:**

1. **Active sprint on the chart, or closed sprints only?** A partial current sprint plotted next to complete ones reads as a drop every time someone looks mid-sprint. Excluding it is honest and slightly disappointing; including it needs distinct styling for "in progress".
2. **Sprints, or calendar months?** Everything above is per sprint, which matches the app. A quarter document may want the calendar, and sprints straddle quarter boundaries.

---

# Deferred backlog

Scoped, wanted, and deliberately not scheduled yet.

### Several boards over one project *(open question 2, resolved on paper)*

An issue's board is inferred from its **project key** — `getAllEpics`
(`js/api.js:167-168`), `tagByProject` (`js/api.js:242-252`), `getEpicNames` —
and `.find()` takes the first board that matches. That assumes one board per
project. Jira does not: a board is a saved filter, and any number of them can
slice one project by component, team or label.

**It is two bugs, not one.**

- **Duplication, which corrupts totals.** Nothing to do with the inference above. `getAllSprintIssues` (`js/api.js:208-220`) and `getAllBacklogIssues` (`222-227`) fan out per board and concatenate with no dedupe, so an issue matching two boards' filters is counted twice — in dashboard points and completion, in the M4 findings, in backlog tiles, in the standup's per-person counts, and permanently in whatever snapshot gets written that day. The worse of the two: an inflated total looks entirely plausible.
- **Misattribution, which corrupts the per-board split.** Every epic in a shared project lands on the first configured board. The second board draws an empty Gantt row (`js/views/gantt.js:246`), the board filter hides its own work (`js/components/filters.js:29`), backlog grouping yields one bucket (`js/backlog.js:109`), and `byBoard` reads zero against double (`js/dashboard.js:165`) — the specific reason M7's per-board stats were called untrustworthy.

**Chosen fix (of four considered, 2026-08-12):** dedupe by issue key while
keeping a `boardIds` **set**, and resolve epic membership from
`/rest/agile/1.0/board/{id}/epic` instead of from the key prefix. Keep
`issue.boardId` as a *primary* — lowest configured board index, so colours stay
stable across reloads — so the ten-odd consumers of `boardId` (card stripes,
monitor badges, Gantt colours) keep working untouched and only the two that
should care, the board filter and `byBoard`, learn to read the set. The board
epic endpoint returns a slim shape without dates or points, so the existing
single JQL still supplies the epic *data* and the per-board call supplies only
the *mapping*: one extra cheap request per board, on the Gantt refresh path.

Rejected: resolving each board's saved filter via `/board/{id}/configuration` →
`/filter/{id}`, which is the most literal reading of what a board is but needs a
permission many sites restrict and lands on the same data model with two more
requests per board.

**Why it is here rather than in a milestone:** the current deployment runs one
board per project, so neither bug is live. Sizing **S–M**, and the dedupe half
is worth pulling forward on its own the moment a second board over one project
gets configured, since that is the half that silently produces wrong numbers.

**Carries a migration.** Snapshots already on disk were recorded with the
duplicated totals, so after a dedupe they are not comparable with new ones. A
numbered migration (`js/migrations.js`) dropping pre-change snapshots is the
cheap answer, and is better decided with the fix than discovered later as a kink
in the burndown.

### Development links on the issue detail *(was part of M5)*

Show pull requests, branches and commits **for an issue**.

**Why it was deferred:** Jira has no public REST API for this. The panel Jira
itself renders is backed by
`/rest/dev-status/1.0/issue/detail?issueId=…&applicationType=…&dataType=pullrequest`,
which is undocumented, unsupported, and free to change without notice — a poor
foundation for a feature people would come to rely on.

**What M11 already built for it:** auth, the device-local GitHub credential, the
repo allowlist, host derivation for github.com and Enterprise Server, the
roster's `githubLogin`, and a tested GraphQL client. What is left here is only
the per-issue correlation, which is a different problem — key matching, not
plumbing.

- Search PRs and commits by issue key, restricted to the declared repos: `search(query: "ABC-123 repo:org/api repo:org/web type:pr")`, plus branch names matching the key. The 256-character search-query ceiling matters here in a way it did not for M11, so long repo lists need batching.
- Render as a "Development" section on the issue detail: PR state, review state, branch, recent commits, degrading to "no linked development" when nothing matches.
- Rate limits matter: search endpoints are capped at 30/minute, so cache per issue key and only fetch when the detail view opens.

**Sizing: S–M** now that M11 exists, plus a spike on key-matching accuracy
(short keys like `AB-1` produce false positives in commit messages).

### Icebox

- **"What changed since you last looked"** — diff current sprint state against the snapshot from your previous session. **Kept separate from M13 deliberately:** same diff machinery, different anchor — M13 compares against sprint start, this compares against your last visit, and the second is only worth building once the first has proved the comparison is useful. It would also need a per-issue record written per session rather than per sprint.
- WIP limits and blocked-chain visualisation on the Kanban.
- Multi-site support (several Jira Cloud instances in one install).
- Multi-org GitHub sync — one fine-grained token has exactly one resource owner, so a second org means a second credential. The config block and the credential keys would both become maps; deliberately not built until someone actually needs it.
- OOO import from a calendar feed to prefill planner absences.
- Confluence export of standup notes and the Quarter Wrapped document.
- Slack integration (press a button -> bot posts standup's recap on Slack via webhook)
- A real build step + test runner, once module count justifies it.

---

# Completed

Newest first.

## M13 — Sprint freeze and diff ✔ *(2026-09-03)*

**Size: M** · Done the day it was scoped, first in the re-sequenced queue and for
the reason that put it there: a forward-built history only accrues from the day
it ships, so every sprint boundary that passed unfrozen was one that could never
be reconstructed. **This was M15 until the renumbering earlier the same day** —
anything written before that which says "M13" means the *planner*.

Freeze the sprint's state, and show what happened to it. Not "how much got done",
which the dashboard already answered, but **what changed underneath the plan**.

**The freeze is per-issue, and that is the whole design decision.**
`js/snapshots.js` writes one row of team totals per day plus a `byPerson` block,
which is exactly right for a burndown and cannot answer this at any resolution: a
burndown asks how many points were left on Tuesday, a diff asks *which issue*
changed. So `js/freeze.js` is a second store under its own key, written once per
sprint rather than once per day — and the alternative, a changelog per issue, is
60 requests for a 60-issue sprint every time the tab opens, which is the same
trade `js/snapshots.js` opens with, refused for the same reason.

**Taken unasked, on the first dashboard load of a sprint.** The scope named two
triggers — a new sprint key appearing, and the extension being installed
mid-sprint — but from the code's point of view those are one condition: no freeze
exists for this key. So there is one automatic path, and `atStart` records which
of the two it turned out to be rather than the app assuming. **Freeze now**, on
the panel, re-freezes a re-planned sprint; it confirms with the date, issue count
and points it is about to discard, because `recordFreeze` returns what it
replaced and there is no way back to it.

**Six buckets, and an arithmetic line that makes them reconcile.** Crept in —
split into *created after the freeze* and *already existed, dragged in later*,
which is the split M7's approximation cannot make and the clearest argument for
keeping the record at all. Pulled out, and where to. Re-estimated, with the
sprint's total change from re-estimation alone, a figure a burndown cannot
separate from work finishing. Due date moved, with direction and days.
Re-assigned, and went backwards. Plus `frozen − pulled out + crept in = now`
printed on screen: six buckets of issues invite exactly one question — "so what
about the rest?" — and a panel that cannot answer it reads like a panel that is
hiding something.

**Three decisions worth keeping:**

- **The scope figure has three states, not two.** The scope note said the M7 caveat becomes conditional; it becomes *ternary*. No freeze is the creation-date approximation. A freeze taken on the sprint's first day makes the figure exact — set membership, not a date comparison. A freeze taken mid-sprint is exact from that day and **blind to everything before it**, and calling that "exact" would be the same overclaim in a new coat. `scopeBasis` (`js/freeze.js`) writes one sentence for the dashboard tile, the hover note and the recap PDF, so the three cannot end up disagreeing, and the tile carries `exact` / `approx.` on the visible line rather than only in a tooltip.
- **"Where did it go" is one request, not one per issue** — and it is the only thing in the whole feature that asks Jira anything new. An issue that left the sprint is by definition in no list the app already holds, so `getIssuesByKeys` (`js/api.js`) batches up to fifty keys into a single JQL. It runs *after* the first paint and not at all when nothing left, and until it answers the rows say so: rendering "deleted" for an issue nobody has looked for yet would be a confident wrong answer to the one question local state cannot settle. **The backlog is deliberately not frozen** — the decision taken with the scope — because this answers "where did it go" without the storage a second per-issue record would cost.
- **The blind spot is printed, not buried.** An issue that left the sprint and came back reads as unchanged; a freeze compares two points in time, not the route between them. Catching it needs the changelogs this design exists to avoid, so the panel and the PDF both say so. Same discipline as the burndown's "collecting history" note and the scope tile's qualifier: the app says what its numbers cannot see.

**Two fields the scope list did not name, both with precedent.** A frozen row
keeps the **status category** rather than re-deriving done-ness from a status
name months later — `isDone` reads the category, and matching on "Klaar" in a
year's time is the kind of assumption M1 spent a milestone removing. And it keeps
the assignee's **display name** beside the account id, which is exactly the
argument `snapshotFrom` already makes for its `byPerson` labels: the roster is
current, history is not, and the re-assigned bucket would otherwise read
"5f3a…c1 → Bo".

**One simplification fell out of it.** Jira answers the sprint field two ways —
an array of objects, and a serialised blob on older instances — and three places
were parsing it privately. `sprintEntries` (`js/dashboard.js`) is now the one
that does; `wasCarriedIn` reads it, and the existing carry-in checks covered the
refactor.

**Storage, measured rather than assumed.** The risk register called this the
largest thing the extension keeps, so `freezeBytes` exists and the suite prints
the number: a 60-issue sprint is ~22 KB, eight of them ~170 KB. Pruning imports
`MAX_SPRINTS_KEPT` from `js/snapshots.js` instead of copying the 8, so the two
histories cannot end up different lengths — the failure the scope asked to
prevent, prevented by construction rather than by both files happening to agree.

**Where it shows:** the **Since the freeze** panel under the burndown on the
Sprint Dashboard, and a *What changed underneath the plan* section in the recap
PDF, built from the same `diffFreeze` so the document and the screen cannot
disagree — the rule `js/recap.js` already followed for `summarize`. The recap
**reads** a freeze and never takes one: a document generator has no business
creating the record it reports on, and opening the recap on a sprint the
dashboard had never seen would otherwise freeze it mid-sprint and then print
"nothing has changed".

**Checks:** 64 new in `scripts/test-dashboard.mjs` (226 there) and 12 in
`scripts/test-recap.mjs` (117 there), 1755 across the suite — including the
storage measurement, both departure answers, and the check that matters most,
that a mid-sprint freeze is *not* allowed to call itself exact. Plus
`?freeze=mid|none` on `preview-dashboard.html` and `preview-recap.html`, seeding a
freeze that differs from the fixture's sprint so all six buckets draw, and
`scripts/SMOKE-CHECKLIST.md` 3a-i for the parts only a real sprint can show.

**Open questions, answered:**

1. **Diff against now, or against the last day only?** The general one, defaulted to end-of-sprint framing — it works on any day and cost nothing extra, as the question predicted.
2. **An issue that left and came back.** Accepted *and named in the panel*, rather than accepted silently. It matches how the app already labels the approximate scope figure and the burndown's missing history.
3. **Does the freeze cover the backlog?** No. Sprint only; "where did it go" is answered by one batched lookup at diff time instead, which keeps the bulkiest store on the device as small as it can be.

**Exit criteria, met:** on any day of a sprint the dashboard shows — with no new
per-issue requests, and one batched request only when something actually left —
which issues entered late and how, which left and where to, which were
re-estimated or re-dated and by how much; and M7's scope-added figure is exact
whenever a start-of-sprint freeze exists, and says which basis it used when it is
not.

---

## M18 — Linked issues, read and write ✔ *(2026-09-03)*

**Size: S** · Done the day it was scoped, and taken out of order — it was the
smallest thing in the file, its dependency (M8's write layer) had been finished
since 2026-08-20, and nothing in the queue was waiting on it. Issue links —
*blocks*, *is blocked by*, *duplicates*, *relates to* — readable and editable
from the issue detail.

**The read half already existed**, which is what made this an S:
`renderLinkedIssues` had grouped `issuelinks` by relationship since M5, reading
`type.outward` / `type.inward` per direction. What shipped is the write half plus
type discovery — and a grouping that now hands back link ids, because a row you
cannot identify is a row you cannot remove.

**The thing this milestone is actually about is direction.** Everything else here
is ordinary CRUD; the direction of a link is the one part that fails *silently*.
A link built the wrong way round does not 400, does not warn, and reads correctly
on the issue you created it from — it reads wrong on the other issue, which is
the one you were not looking at. So the rule lives in a pure function with a test
on each direction rather than inside a click handler:

```
inwardIssue  <type.outward>  outwardIssue
```

`linkPayloadFor` (`js/issue-link.js`) is that rule. Picking the outward phrase
("blocks") from issue X puts **X on the inward side**; picking the inward phrase
("is blocked by") swaps them. Which is also why the picker offers *phrases* and
not a type plus a direction toggle: "blocks" and "is blocked by" are two entries
over one type, because that is how someone says what they mean, and the direction
falls out of what they said. A symmetric type — "Relates", the same word both
ways — appears once; offering "relates to" twice is a picker that looks broken
while being correct.

**Five decisions worth keeping:**

- **The types are read, never written into the app** — `GET /rest/api/3/issueLinkType`, cached like createmeta. Link types are instance configuration: a site can rename them, add its own, or delete the ones a hardcoded list would have offered. Same discipline as `customfield_*` discovery in M1 and the sub-task type read off `subtask: true` in M8, both of which exist because a hardcoded assumption broke on a real site. The fixture names one of its types in Dutch for that reason — a fixture using only the English defaults could not show that nothing matches by name.
- **The app's first DELETE went through the helper that already existed.** `jiraWrite` (`js/api.js`) has been the single place that knows how Jira refuses a write since M8, so a refused unlink is attributed exactly like a refused field edit — including the 403 that explains itself and the 401 that raises the reauth event. What was new is that `jiraWrite` now sends *no body at all* when it is given none, rather than an empty object with a Content-Type on a DELETE.
- **Removal asks first, and names what it is removing.** Jira has no undo, so this is the one single-item write in the app that confirms beforehand instead of offering to reverse afterwards — the trade the bulk field edit already makes. The confirm is the sentence, both keys and the relationship: "remove the link" alone does not say *which* of several links is about to go. A sub-task row carries no ✕ at all: a sub-task is a parent/child field, not a link, and there is no link id to DELETE — a button there could only ever fail.
- **The picker reuses issue search.** A raw key field is a typo waiting to 400. `searchIssuesByJql` already backed the palette's issue lookup, so this is the same interaction with a different destination: two characters start a search, a key-shaped query is looked up as a key and anything else searches summaries with a trailing wildcard. The issue itself and everything already linked to it are filtered out — offering a duplicate link is offering a 400 the user had no way to predict.
- **Both writes re-read the issue.** Jira answers a link create with an empty body and a delete with nothing, so there is no response to render from even if we wanted one — and a link involves a second issue whose state this view does not own. The same `refreshLinks` the sub-task path already used now covers all three writes the section can make.

**Where the code went:** `js/issue-link.js` is the DOM-free half — choices,
payload, grouping, and the picker's JQL with its escaping — mirroring the
`issue-create.js` / `components/issue-create.js` split, and for the same reason:
the parts that are silently wrong when wrong are the parts that get a unit test.
`js/components/issue-link.js` is the panel, in the create form's own chrome.

**Checks:** 43 new in `scripts/test-write.mjs` (136 total there, 1678 across the
suite), plus `?link=open|search|refuse` on `preview-issue.html` — the second of
which types a query, lists results and picks one through the real input handlers,
so the debounce and the out-of-order guard are exercised rather than described.
`scripts/SMOKE-CHECKLIST.md` gained 3c-iv, whose load-bearing line is *create with
"blocks", then go and look at the other issue in Jira*: no unit test can catch a
reversed link, because both directions are internally consistent.

**Exit criteria, met:** a link can be created and removed from the issue detail
against a site whose link types were never seen before, with a refusal reported
as Jira worded it and nothing removed without a confirm that names it.

---

## Per-person Jira activity ✔ *(ad-hoc, 2026-08-24)*

**Size: S–M** · Done. Scoped on 2026-08-20, built four days later. The standup
and the recap both answered "what is assigned to this person" and, with GitHub
connected, "what did they push". Neither answered **what they did in Jira** — who
moved which ticket, who picked work up, who created the things that appeared
mid-sprint. That is what this reads.

**It cost no requests, which was the argument for building it.**
`expand=changelog` rides `getSprintIssues` (`js/api.js`), the call that already
fetches these issues, so the whole feature is a reader over data that was
already in flight.

**Two corrections to the scoping note, both cheap.** It claimed the
issues-created figure "needs nothing new whatsoever" because `fields.creator` and
`fields.created` are fetched today. `created` was; `creator` was not — it is now
in `BASE_ISSUE_FIELDS` (`js/config.js`), one person object on a request already
being made, so the claim held in spirit but not in fact. And the expand was
scoped to the sprint call *and its backlog twin*; only the sprint call took it.
Every consumer of activity asks about a sprint, so an expand on the backlog would
have put a compacted history for every unstarted issue into the 5-minute cache
for nothing to read. `getBoardBacklog` says so in place, and turning it on is one
line the day a screen wants it.

**The three things the note said to get right, in the order they bite.**

1. **Framing, settled before the first panel was drawn** — and written into the
   head of `js/activity.js` rather than left to each consumer. `activityFrom`
   returns people ordered **by name**, and no sort-by-count is offered anywhere;
   the module exposes no total, no score and no composite, because a table
   sorted by transition count is very hard to un-read once seen. Every tooltip
   says what the figure counts and none implies it should be larger — the
   standup's read "conversation fuel, not a score", and the document's says
   plainly that "a high count is not a better one, and ten moves can be one
   ticket going back and forth between review and rework". The Jira numbers on
   the setup row are also the one cluster on that screen deliberately *not*
   given the success colour the GitHub figures carry: marking a count green
   reads as praise.
2. **The changelog expand is bounded and does not paginate** — carried, the way
   `js/github.js` carries its own page caps. `compactHistory` keeps `total` and
   `returned` beside the events and sets `truncated` when they disagree;
   `activityFrom` collects the affected issue keys, the standup says "at least
   this many" in every tooltip, and the recap prints a sentence naming the
   issues and calling the figure a floor.
3. **Cache size** — reduced at the fetch boundary, before `cached()` stores
   anything. Jira's history entry is a nested record per change with an author
   object and an avatar URL set; `compactChangelogs` replaces it with five
   fields per event, so nothing downstream and nothing in device-local storage
   ever sees the wide shape.

**Two design points worth keeping.**

- **Done-ness has to be decided from a status *name*.** A changelog carries
  `fromString`/`toString`, not the `statusCategory` that `isDone` reads. So
  `doneResolver` takes three sources in order: the issues in hand (every current
  status carries both its name and its category, which is the only source correct
  on a site with a custom done status nobody configured), then the configured
  status groups (which cover a status transitioned *through* and away from, where
  no current issue sits), then the regex `isDone` itself falls back to.
- **The two halves of the model have different availability, and one flag would
  have hidden it.** Issues created come from `fields.creator` and are answerable
  whenever the issues were fetched; everything else needs the changelog. So
  `historyKnown` sits on each bucket and a site returning no history dashes the
  transition counts while still printing creations — visible on both consumers
  under `?history=off`.

**Where it landed.** A cell on the standup setup row and a "THIS SPRINT" panel on
the speaker's stage, defined once in `jiraStatSpecs` and rendered in both places
for the same reason `statSpecs` is shared. The panel also lists the ticket keys
behind the numbers, done ones outlined, opening in the drawer rather than
navigating away mid-turn — a prompt for a sentence rather than a list to read
out. In the recap document, two columns on the per-person table (**Moved** and
**Created**, which fit A4 portrait at eleven columns) plus a caption carrying the
window and the truncation caveat. Deliberately not on the per-person cards,
which are capped at five statistics on purpose.

**It is a substrate, not one feature.** `activityFrom(issues, { since, until })`
takes its window as a parameter from the first commit, the way
`statsFor(stats, login, { since })` already does — so M16's *Ping-Pong Award*
("most status transitions") and M14's "what they did this week" are this reader
with a different window, and neither pays for it again. A week-long window is
asserted in the suite so it is exercised rather than assumed.

**Out of scope, as scoped:** comments and worklogs, which are per-issue endpoints
and would mean one request per issue against a sprint of a hundred. If comment
counts turn out to be what people wanted, that is a second decision with a real
cost attached.

**Still owed: the spike.** `scripts/jira-smoke.js` grew a Test 5 that answers
both questions against a real site — whether the agile sprint-issue endpoint
honours `expand=changelog` (if it does not, the fallback is the JQL search path,
one query per board) and what the per-issue entry cap actually is here. It has
not been run against the live site yet; the code works either way, but the cap is
worth knowing.

**Tests:** `scripts/test-activity.mjs`, 75 checks, plus 22 in
`scripts/test-recap.mjs` and 2 in `scripts/test-config.mjs`. Seventeen suites,
1633 checks.

---

## M8 — Write layer + issue creation ✔ *(feature 8)*

**Size: M** · Done 2026-08-20. The first milestone to mutate Jira beyond the
single comment endpoint M5 pulled forward. Deferred once, on 2026-08-07, in
favour of M11 — a sequencing call, not a rethink — and split from the planner on
2026-08-12, which is what took it from XL to M.

**8a — Write layer.** `jiraWrite` in `js/api.js` is the single place that knows
how Jira refuses a write, and `JiraWriteError` keeps the structure of the refusal
instead of flattening it: `errors` is a map of field id → what is wrong with that
field, so the message a user sees names the field in the site's own words
(`customfield_10016` reads back as "Story points" through the discovered role
mapping). A 403 with the empty body Jira actually sends explains itself, and says
which token scope a scoped setup is missing.

Three decisions worth keeping:

- **One request per edit, carrying every changed field.** Jira validates the
  whole `fields` object before applying any of it, so a rejected edit leaves the
  issue exactly as it was and the optimistic paint has one outcome to roll back
  rather than a half-applied set. Worth more than saving a round trip.
- **Sprint does not go through the issue PUT**, which is where the original scope
  put it. The Sprint custom field is read-only that way on team-managed projects
  and needs to be on the Edit screen on company-managed ones — so it would work
  on some sites and fail on others, which is the class of difference M1 spent a
  milestone removing. `moveIssuesToSprint` uses the documented agile endpoint,
  which works on both and takes 50 issues a call. That batching is also what
  M15's reviewed push wants, so the planner inherits it.
- **A field this site has no id for is refused before the request**, naming the
  field and pointing at Settings. The alternative — sending the rest of the edit
  and dropping the estimate — is the exact silent failure the milestone existed
  to prevent.

`js/issue-edit.js` is the UI half, deliberately shaped like `issue-move.js` so a
view wires both writers up the same way: optimistic paint, rollback to the value
already in hand rather than a re-fetch, an undo on the success toast (a second
write of the previous values, not a local revert — the first one succeeded), and a
confirmation before a bulk edit rather than an undo after it. Bulk writes issue
by issue so a refusal can name the issue that caused it and the rest still stand.
`showToast` grew an action button and, with it, a cleared timer — a second toast
used to cut the first one short, which for an undo window is a bug.

The editable surface is the issue detail's meta grid: assignee, due date and
story points, click-to-edit. Reporter, start date and sprint stay plain text
rather than pretending to be editable — a permission most accounts lack, a field
only meaningful once the roadmap edits dates, and a move that needs the board's
sprint list respectively. `writeMany` has no multi-select UI to call it yet; it is
built and tested for M15's batch push and for whichever screen grows selection
first.

**8b — Create issue.** The form is generated, and `js/issue-create.js` is where
that happens: field descriptors from
`/rest/api/3/issue/createmeta/{project}/issuetypes/{type}` become form rows, and
filled rows become a create payload. Kept DOM-free, because the two ways this
goes wrong quietly are a field sent in the wrong shape (Jira takes an option as
`{id}` and refuses its label) and a required field dropped from the form — the
first is a 400 on every site, the second a 400 only on somebody else's.

What it will not do is guess. A required field whose type has no control stops
the form with the field named; an optional one is listed as left unset, so the
form never pretends to be all of Jira's. Both createmeta response shapes are
normalised at the API boundary — current Cloud answers with an array of
descriptors, older Cloud and Data Center with a map keyed by field id — so the
form builder sees one shape and the difference never reaches it. Sprint and epic
options come from the board, since createmeta does not carry them.

Launches from the palette and from a Backlog toolbar button, as the open question
assumed; one panel, in the drawer idiom, which was extracted to
`js/components/drawer.js` when the second thing needed to open in it.

**8c — Sub-task.** The same panel with the parent fixed, launched from the issue
detail's Linked issues heading — one launch point, because `renderIssueInto()`
already serves both the drawer and the full page. The sub-task type is found by
`subtask: true` in createmeta and never by name: the fixture calls it "Deeltaak"
precisely so a name match would fail the suite. A project with sub-tasks switched
off says so rather than offering a form that cannot be submitted, a sub-task
offers no button of its own since Jira does not nest them, and after creation the
parent's list is re-read from Jira rather than patched from the form — the create
response carries an id and a key and nothing a row needs to print.

**Exit criteria, met:** an issue and a sub-task can both be created against a
site whose required fields differ from ours with no field list hardcoded
(`?createmeta=blocked` and `?createmeta=minimal` on `preview-create.html` are the
two ends of that), and every failed write is attributed to the field or the
permission that caused it — asserted in `scripts/test-write.mjs` and
`scripts/test-create.mjs`, 164 checks between them.

**What this unblocks, and what it did not do.** M9's triage mode and M4's in-app
fixing were both waiting on nothing but this. M15 gets the sprint move, the
batching and the bulk path. Not done here: a multi-select on any board, editing
from the Kanban card or the Backlog row, and the sprint picker on the issue
detail — each a screen-level addition on top of a write layer that already
supports it.

---

## Per-person block in the daily snapshot ✔ *(ad-hoc, 2026-08-20)*

The one dependency on this roadmap with a lead time rather than a cost: M15's
per-person velocity and M14's load-over-time both read snapshot history, and
history built forward only exists from the day the field starts being written.
So the field was added on its own, ahead of either milestone — `snapshotFrom`
(`js/snapshots.js`) now writes a `byPerson` map beside the team totals, keyed by
account id, one row per person per day with `points`, `issues`, `donePoints`,
`doneIssues` and the display name as it read that day.

Three choices in it, each written into the module so neither milestone has to
re-derive them: keyed by id rather than an array, because every reader asks
"this person, across days"; the unassigned bucket kept under `__unassigned__`,
so the rows keep summing to the day's totals; and the name stored rather than
resolved on read, so somebody who leaves the team is still named in the weeks
they were on it. No `onTeam` flag — that is a question about now, and the roster
answers it without going stale.

Both consumers inherit one caveat: rows written before 2026-08-20 have no
`byPerson` at all, so the field is absent rather than empty on older days.

## Kanban as the home view ✔ *(ad-hoc, 2026-08-20)*

One line of intent: the app opened on the Backlog, and the question people
actually arrive with is where the current sprint stands. `HOME_HASH`
(`js/components/nav.js`) now names the landing view, the router and the nav tab
highlight both read it, and the Kanban already defaulted to current-sprint-only
so no filtering work was needed. An unrecognised hash still falls back to the
Backlog — a stale bookmark should land on the view that lists everything rather
than on one that hides most of it.

## Sprint recap PDF ✔ *(ad-hoc, 2026-08-18)*

**Size: M** · Done. Shipped on request, and it was **not** M16 — a warning that
mattered while M16 was also a per-sprint recap. It stopped mattering on
2026-09-03, when M16 was re-aimed at the quarter precisely because this document
had already taken the sprint.

**Generate recap** on the Sprint Dashboard opens `recap.html`, a print-styled
document over the M7 aggregates plus the M11 GitHub window: combined figures for
every active sprint, a per-person contribution card with photo, a per-board block
and the full ticket list with scope-creep and carry-in flags. Saved as a PDF
through the browser's own print dialog.

**Four decisions worth keeping:**

- **Print-to-PDF, not a PDF library.** No dependency in a repo with no build step, and the output is real vector text rather than the rasterised page a jsPDF-plus-canvas route would produce. Costs one click in the print dialog.
- **A page of its own, recomputed rather than handed a payload.** `css/app.css` is deliberately not loaded: its `html, body { overflow: hidden }` app-shell rule clips a print job to exactly one page, which is how the first draft lost two thirds of the document. Fonts are re-declared in `css/recap.css` instead.
- **It recaps the sprints the dashboard is showing** — the active ones, which on retro day are the ones ending. Recapping *closed* sprints needs new fetches and was deliberately not built; noted below as the follow-up if the team starts closing sprints before running the retro.
- **Ordered by name, headed "contribution", footed with a line saying it is not an assessment.** M16 and M14 both set the rule that per-colleague numbers are conversation fuel, not a score. This document carries named people, photographs and pull-request counts, so it states its own framing rather than relying on whoever opens it to supply one.

**One bug worth remembering.** The first version offered its print button over an
empty page while it was still fetching, so printing in that window produced a
blank A4 sheet — one page whose only content was Chrome's own header and footer.
Every check had used `?print=0` and printed through DevTools *after* the render,
so the window in which the page is printable but not yet built was never
exercised. The fix is a readiness gate on both routes to the dialog plus a visible
build state; the harness gained `?jira=slow` so that window can be held open and
looked at.

**A second print bug, same root cause — a print job is not a scrolling page.**
The running header was `position: fixed`, which Blink repeats on every page but
reserves no space for, so every page after the first had its top card sliced in
half behind it. Fixed by laying the document out as a one-column table and putting
the header in a `thead`, which repeats *and* reserves. Verified by printing each
page separately (`printToPDF` takes a `pageRanges`, and a one-page PDF is
something `sips` can rasterise) rather than by looking at page one and assuming.

**A third print bug, and the lesson behind all three.** The 30-second deadline put
on the GitHub window fired on real repositories: adding the default-branch commit
query had roughly doubled the requests per repo, and the recap was the only caller
with a deadline at all. Raised to 180s, and — more to the point — the document now
renders the Jira half immediately and fills the GitHub figures in, so the wait is
visible rather than blank. Per-repo failures and truncation, which `fetchTeamStats`
had been reporting all along, are now printed too: without them a repo whose token
cannot read commit history produced a confident zero.

Each of the three was the same mistake in a different costume — verifying the
artefact while skipping the conditions under which it is produced: printing after
the render rather than during it, looking at page one rather than every page, and
setting a deadline without measuring what the work actually costs.

**Follow-up:** the *recapping closed sprints* follow-up recorded here was dropped
on 2026-09-03 in favour of M17, which keeps a per-sprint rollup written forward
at rollover rather than re-fetching a closed sprint out of Jira. M13's freeze
replaces the scope-creep approximation this document inherits, and M16's quarter
document reuses this page's print route and all four of its lessons.

---

## Standup setup UX refresh ✔ *(ad-hoc, 2026-08-07)*

**Size: M** · Done. Same treatment as the Backlog, against a mockup, reusing
that screen's vocabulary rather than inventing a second one.

The setup card — a 620px box with a monospaced `DAILY STANDUP` heading, a
checkbox list and a number input per person — became a full-width screen:
header with an inline SVG mark, a date / team / sprint / availability meta
line, four live stat tiles (attendees, speaking time, total estimated, open
PRs), and three numbered panels (participants, quick info, keyboard shortcuts)
over a full-width start button.

Each participant row now answers, at a glance, what the facilitator would
otherwise have to ask: sprint items with a relative workload bar, four GitHub
numbers (open PRs, PRs opened, reviews and comments, lines merged — added in
11c), a blocked/overdue flag, and a per-person speaking time.

**Four decisions worth keeping:**

- **The blocked column is decided once, for the whole table.** Jira gives no universal "blocked" field, so it is read off the status name (`block|impediment|on hold`) — but only when this sprint actually *has* such a status. Otherwise the same slot shows overdue, which every site can answer. Per-row fallback would have made one column mean two things.
- **The pip bar is relative to the busiest person on the roster,** not to a fixed ceiling nobody agreed on. It reads as "who is carrying the most", which is the question a standup asks.
- **An absent PR count and a zero are different facts.** GitHub off, still loading, or no login on the roster renders `—` with a title explaining which; only a real answer renders a number.
- **The GitHub status line was promoted, not dropped.** It used to be one chip under the button; GitHub now appears in four places (tile, the per-person stat cluster, Quick info card and its note), so a fetch landing repaints the setup screen wholesale instead of patching one node.

Enter now starts the standup, matching the hint under the button. The running
stage and the summary screen are untouched.

Verified by rendering the real view — `preview-standup.html`, which mounts
`js/views/standup.js` against stubbed extension storage and a stubbed
Jira/GitHub network — in seven states: default, light, GitHub off, nobody
selected, empty roster, resumable session, and narrow (980px). That caught the
one real layout question, which is what a nine-column row does when the window
is not wide enough for it: below 1080px the item count and the pip bar are the
first things dropped, because the name, the flag and the clock are what the
meeting needs. 11c widened that row again, so the drop order now continues into
the GitHub cluster — lines merged goes below 1400px, PRs opened below 1080px,
both still one hover away in the tooltip.

---

## Backlog UX refresh ✔ *(ad-hoc, 2026-08-07)*

**Size: L** · Done. A brief and a mockup, delivered against after four
clarifying questions.

The Backlog went from a bare table under the nav to a proper screen: page
header with an inline SVG mark, live summary tiles, a density selector, a
promoted search, a filter sidebar, grouping, pagination, row selection, column
visibility, saved views, skeleton loading and an empty state.

**The logic moved out of the view.** `js/backlog.js` now owns grouping,
sorting, pagination, density, columns, saved views, status tones and relative
time — DOM-free, the same split as `monitor.js` and `dashboard.js`, and
covered by `scripts/test-backlog.mjs` (103 checks). This view's failures are
arithmetic ones that a screenshot will not catch: landing on page 9 when a
filter cuts the list to 12 issues, an ellipsis window that repeats a page,
"no due date" sorting as though it were a date.

**Four decisions worth keeping:**

- **No PR column.** The brief assumed GitHub sync could supply per-issue pull requests. It cannot: M11 fetches PRs per *person* from the repo allowlist and deliberately does not correlate them to Jira keys. That correlation is the deferred *development links* item, with an open accuracy risk on short keys. Raised, and the user chose to omit the column rather than smuggle the spike into a UI pass.
- **Pagination only when ungrouped.** A group split across a page boundary reads as missing data. Grouped views show everything and say so in the pager.
- **The sidebar is Backlog-only.** `js/components/filters.js` is shared with Kanban, Gantt and Monitor; the sidebar reuses its `applyFilters` so the two can never disagree about what a filter means, but the other three views keep their bar and take no regression risk.
- **Tiles and status tones follow `CONFIG.statusGroups`,** not the five names in the mockup. Hardcoding "On Hold" would have read zero for any site whose workflow differs — this app is whitelabel, and the tiles had to be too.

**A regression caught before it shipped:** the command palette's "jump to this
person" hands the Backlog a one-shot assignee filter that only the old
`renderFilters` consumed. With the sidebar in place it would have silently done
nothing. `takePendingAssignees` is now exported and consumed by the new view.

Verified by rendering the real view against 277 synthetic issues in four modes
— default, grouped, empty and light — with page errors surfaced on screen: zero
in all four. That also caught a live layout bug, a grid item defaulting to
`min-height: auto` and pushing the pager off the bottom of the viewport.

**Not built, per the brief's own out-of-scope list:** inline editing, bulk
operations (row selection is UI only, ready for them), drag-to-prioritise,
timeline and analytics views.

---

## M12 — Firefox and Edge ✔

**Size: M** · Done 2026-08-07. Promoted out of the icebox at the user's request.
Depends on nothing; touches almost everything.

The icebox entry read: *"MV3 is mostly portable; `chrome.*` namespace and the
manifest `key` are the friction points."* Half right. The namespace and the key
were both real, but the blocker nobody had written down was the **background**:
Firefox MV3 has no service-worker background at all, and no amount of namespace
aliasing papers over a manifest key that does not exist on the target.

**The namespace: one module, not a polyfill**

`js/browser.js` resolves `browser` (Firefox, promise-native) or `chrome`
(Chromium) once and exposes a single promise-shaped surface. Every one of the 19
modules that touched `chrome.*` now imports from it; the only remaining mentions
of `chrome.` in the tree are in prose comments.

Deliberately **not** `webextension-polyfill`: it would have been this project's
first dependency, for a shim that is 140 lines and that we want to be able to
read. And deliberately **no callback fallback** — every API used here returns a
promise on every supported target, so a "retry with a callback" path would be
machinery for a browser we do not support, and after a failed promise call it
would issue side-effecting writes twice.

A side effect worth having: the `localGet`/`localSet`/`localRemove` trio had
been copy-pasted into seven modules, each hand-wrapping the callback form. They
are now defined once.

**Three manifests, generated**

`manifest.base.json` plus `manifest.{chrome,firefox,edge}.json` overlays, merged
by `scripts/build.mjs` into `dist/<target>/`. The differences are not cosmetic:

| | Chrome | Firefox | Edge |
|---|---|---|---|
| Background | `service_worker` | `scripts` (event page) | `service_worker` |
| Extension ID | pinned via `key` | `gecko.id` | assigned by the store |

- **No service worker on Gecko.** Firefox MV3 runs a non-persistent event page.
- **`key` is Chrome-only**, and both Firefox and the Edge store reject a package
  carrying one. The build strips it from both.
- **`gecko.id` is required for `storage.sync` to function.** Without a stable
  add-on ID there is nothing to sync against and every config write goes quietly
  nowhere — the worst kind of failure, because nothing errors.

`scripts/build.mjs` is a copy step, not a bundler: same source files, one
generated manifest. It uses an **allowlist** of what ships rather than an ignore
list, because a deny list silently starts shipping whatever is added next — and
this package is otherwise one careless commit from containing `assets/avatars/`,
which is photographs of colleagues. The repo-root `manifest.json` is the Chrome
output, regenerated by the build, so loading the repo unpacked still needs no
build step and cannot drift from the base.

**A bug this shipped anyway.** The migration swapped `chrome.storage.*` calls
for shim calls across twenty files and missed the import in two of them —
Kanban and Monitor both threw `syncGet is not defined` on mount. Nothing caught
it: `node --check` parses without resolving identifiers, the unit suites never
import the DOM-heavy view modules, and the one browser render exercised the
Backlog. `scripts/test-imports.mjs` closes that hole — for every module, any
identifier another local module exports and this one calls without importing is
a failure. It reproduces all four missing imports when the bug is reintroduced.

**Verification, because "it compiles" is not a port**

- `scripts/test-browser.mjs` (30 checks) runs the real modules against a Firefox-shaped `browser` global with **no `chrome` global present at all** — including a full `credentials.js` round-trip. A stray `chrome.` reference fails there instead of in front of a user. It also covers both-present (browser wins), aliased namespaces, no namespace (fails loudly), and the degradation paths.
- `scripts/test-manifests.mjs` (49 checks) encodes the rules that otherwise only bite at submission: no `key` on Firefox or Edge, exactly one background form per target, gecko id present and well-formed, versions in lockstep, no `_comment` keys shipped, CSP still forbidding remote script.
- **The built package was installed into a real Firefox 153** over WebDriver BiDi. It installed clean with zero warnings, and the profile's extension IndexedDB came back holding `schemaVersion` — which only `background.js` writes, via `runMigrations()`, through the shim. That is the event page loading as an ES module and the `browser.*` path working end to end, not an inference.
- **Not** verified by loading: the Chromium packages. Headless Chrome and Edge refuse to navigate to a `chrome-extension://` page from the command line, and the CLI check originally run here used a `timeout` binary that does not exist on this machine — it produced no output, which was misread as success. What is actually known: the repo-root Chrome manifest is generated from the same base, its `key` is unchanged so the extension ID and storage namespace are preserved, and `dist/chrome` and `dist/edge` carry byte-identical source. Loading those two by hand is on the smoke checklist.

**Follow-up, done 2026-08-07:** the pages used to pull IBM Plex from Google
Fonts. They now ship **Ubuntu Sans** and **Ubuntu Sans Mono** locally —
Canonical's own pre-built variable webfonts, unmodified, under the Ubuntu Font
Licence 1.0, which expressly permits bundling and embedding. Two files, every
weight, full character coverage including the accented and Cyrillic names a real
roster contains. The CSP lost both remote origins and is now
`style-src 'self' 'unsafe-inline'; font-src 'self'` — no third-party request on
any page load, and the app renders correctly offline. Obligations and their
handling are in `assets/fonts/README.md`.

**Exit criteria met:** one codebase produces working Chrome, Firefox and Edge
packages; no application module names a browser; and the differences between
targets are three declared manifest keys rather than branching code.

---

## M11 — GitHub sync ✔ *(feature 11)*

**Size: M — split in two** · Done 2026-08-07. Depends on M3 (roster). Independent
of M8: read-only against GitHub, so it landed before the Jira write layer.

The standup board answers "what is assigned to you". It cannot answer "what have
you got in review", which in practice is where half the day went and where the
blocker usually is. This milestone adds a second, optional source, on the same
screen as the tickets.

Optional throughout. With GitHub sync off, every screen behaves exactly as it
did before.

**The scoping decision, which shaped everything else.** The original sketch was
one org-wide query: `search(query: "org:X is:pr is:open")`. That was rejected
during implementation, at the user's instruction, in favour of an **explicit repo
allowlist**. The reasoning is worth keeping:

- A token's access is not a team's scope. A fine-grained token with fifty repos on it would have pulled fifty repos into a nine-person standup, and nobody would have noticed until the panel was noise.
- "Which repos are ours" is knowledge the team has and GitHub does not. Asking for it costs one textarea and removes an entire class of wrong answers.
- It made the search API unnecessary, which removed the 30/minute budget, the 256-character query ceiling, and the GHES REST fallback the original plan needed. `repository(owner:, name:)` aliases ask for exactly the declared repos in one POST against the ordinary 5000-point/hour budget.
- An empty list means off. The allowlist *is* the scope, so a config with `enabled: true` and no repos is treated as disabled rather than as "everything" — the failure mode points at nothing rather than at everything.

**11a — Config, auth and mapping**

- **Settings → GitHub sync**, a `<details>` section that stays shut until it is wanted and opens already-expanded once enabled: host, org, the repo list, token, and a Test connection button in the shape Settings already uses for Jira.
- **Config** (synced, non-sensitive): `github: { enabled, host, org, repos }`. `host` defaults to `github.com`; anything else is GitHub Enterprise Server and shifts the REST base to `https://<host>/api/v3` and GraphQL to `https://<host>/api/graphql`. Both `config.local.json` and Settings write it. `repos` accepts a bare name (read as belonging to `org`), `owner/name`, a browser URL, or an SSH remote, and normalises all four to the same stored form.
- **The repo strings are also the injection guard.** They are interpolated into a GraphQL document as string literals, so `parseRepoRef` validates against a strict character class and `buildActivityQuery` throws rather than escaping — an unsafe reference is rejected at the door, not sanitised. Covered by tests.
- **Token** (device-local, never synced, exported only behind **its own** checkbox — added 2026-08-07 at the user's request; it was originally excluded unconditionally, which made a browser migration mean re-pasting it by hand): its own keys in `js/credentials.js`, since a dead GitHub token must never break the Jira views and forgetting one must not forget the other. A fine-grained PAT owned by the org, scoped to the listed repos, needs *Metadata: read*, *Pull requests: read* and *Issues: read*; *Checks: read* for check state, and org *Members: read* only for the roster matcher. Classic PATs work (`repo` + `read:org`) and are documented as the worse option, since `repo` also grants write everywhere.
- **Real expiry, for once.** GitHub returns `github-authentication-token-expiration` on every authenticated call, so the date is recorded rather than guessed at creation + 365 days. The M2 banner is reused but kept separate and reworded: a lapsed GitHub token costs one optional panel, and saying otherwise would be a lie.
- **Per-repo reachability.** Listing a repo in Settings does not grant the token access to it — that gap produces a `404`, not a `403`, which is genuinely confusing. Test connection checks each repo individually and names the ones that fail.
- **Host permission.** `https://api.github.com/*` is in `host_permissions`. A GHES host cannot be known at build time, so its origin is requested at runtime from the Save button, which is the user gesture Chrome requires.
- **Roster gains `githubLogin`**, normalised to GitHub's own rule (alphanumerics, single inner hyphens, ≤39), tolerating both `@handle` and a profile URL. Plus **"Match logins from GitHub org"**, which pulls `/orgs/{org}/members`, matches on name and email-local-part variants, fills in blanks only, and leaves an ambiguous match empty rather than guessing. Assisted, not automatic — the same shape as the Jira roster import.
- **Personal data:** a GitHub login is one more identifier attached to a named colleague, so it rides in the roster record and inherits its treatment — local-only, excluded from config export unless the personal-data box is ticked. No new mechanism.

**11b — GitHub in standup**

- **One request for every declared repo.** Aliased `repository()` fields, each pulling open PRs, recently merged PRs and open issues. Aliases are positional (`r0`, `r1`, …) precisely so a partial failure maps back to the repo that caused it — GraphQL reports errors by path, not by content, and "one repo is unreadable" must not read as "GitHub is down".
- **Pre-fetch on mount.** The query fires as the setup card paints. Nothing awaits it: the standup starts whether or not it has landed, a slow fetch fills in behind, and a person already on screen when it lands gets their panel without waiting for the next hand-off. A status line on the setup card says which of loading / ready / partial / failed happened. (It fired *after* the Jira awaits, not alongside them, which 11c fixed — see below.)
- **Per-person panel** beside the speaker's board: open PRs with the state that decides what to say, then "waiting on you", then what they merged since the last working day, then assigned issues. Empty sections are omitted; an empty panel says so in one line.
- **Sorted by how stuck, not by how recent** — changes requested, then failing checks, then approved-and-unmerged, then waiting on review, each tie-broken by age. (Drafts had a fifth rank until 11c dropped them from the model entirely.)
- **"Waiting on you" without the search API.** `review-requested:` is a search qualifier, so it came out of `reviewRequests` on each PR node instead. Team review requests are kept separate from individual ones — a team request is not a name.
- **Merged since the last *working* day**, not the last 24 hours. Anything shorter makes the panel lie every Monday.
- ~~**Coverage gaps stated once, on the summary**~~ — built, then **removed on 2026-08-07 at the user's request**: the end screen is a celebration, not an audit. Repo read failures are still reported, on the setup card's status line; PRs by people off the roster and roster members with no GitHub login are now surfaced nowhere. `coverageGaps()` and its tests went with it rather than sitting unused. If the accounting is wanted back, Settings is the place for it, not the done screen.
- **Cache** with the existing 5-minute TTL, keyed by **the repo list** rather than by the org — changing the allowlist must not serve the previous list's answer.

**11c — Sprint statistics per person** *(2026-08-17)*

Four numbers per person, on the setup row beside each name and again as tiles on
the speaker's panel: open PRs they authored, PRs they opened this sprint, reviews
and comments this sprint, and lines merged into a repo's default branch this
sprint. Requested because the panel answered "what is in flight" but not "what
has this sprint actually consisted of", which is the half a standup keeps asking
about out loud.

- **Drafts count for nothing, anywhere.** Dropped in `toActivity` and in the window fetch rather than filtered per call site, so no count can disagree with the list beside it, and a draft's reviews and comments go with it. `PR_STATES.DRAFT` and its CSS went with them: work explicitly marked not-ready is not work a standup chases.
- **A second query, because it is a second question.** The aliased activity document answers "what is open right now" and cannot be stretched: the sprint numbers need closed pull requests, reviews, comments and diff sizes, over a whole sprint rather than the newest 50 of everything. So `fetchTeamStats` pages `pullRequests(orderBy: UPDATED_AT DESC)` per repo, stopping at the first node older than the window. A PR created, merged, reviewed or commented on inside the window has necessarily been *updated* inside it, which is what makes that a complete stop condition rather than a heuristic.
- **The fetch window is a fixed 45-day lookback, not the sprint's own dates** — the point that makes the rest work. The network shape depends on nothing but the repo list, so the query can start before Jira has said when the sprint began; the sprint boundary is applied afterwards in `statsFor`, over data that already covers it. A sprint older than the window is *clamped* and says so in the tooltip rather than silently undercounting.
- **Started from the header, not from the view.** `prewarmGithub()` fires on `pointerdown` on the STANDUP tab, and an in-flight map keyed the same way as the cache means the view's own call joins that request instead of issuing a second one. The view also starts it above its first `await`, so keyboard and palette navigation get the same parallelism. This is what the README already claimed and the code did not: the fetch used to fire *after* `getAllSprintIssues` resolved.
- **Two definitions, both of which could have gone the other way.** Reviews and comments are counted on *other people's* pull requests only — replying to feedback on your own is authorship, not review, and counting it would reward the noisiest thread. "Lines merged" means lines that reached the **default branch**, attributed to the PR author; a merge into a release branch has not shipped.
- **The sprint window is the earliest start among the active sprints.** Two boards on staggered sprints would otherwise put two meanings of "this sprint" in one table. A sprint with no start date falls back to 14 days and says which it used.
- **Every way the numbers can be short is stated.** A repo too busy for the 6-page cap is reported as truncated, a repo the token cannot read is a per-repo failure, and the window query failing costs the four numbers but not the panel. Every repo failing throws instead: a dead token rendering as "everyone did nothing this sprint" is worse than an absent panel.
- **Not measurement.** These are conversation prompts on a screen the team runs together, not a per-person scorecard, and nothing is ranked, scored, compared or stored. Lines merged is the number most easily misread as productivity; it is shown as `+added −removed` next to three others precisely so no single figure reads as a verdict.

Verified by `scripts/test-github.mjs` and by mounting the real view against a
fake DOM — the cases that would look plausible while being wrong: a PR opened
before the sprint but merged during it, a merge into a non-default branch, a
review on your own PR, an unsubmitted review, a draft's reviews, and a sprint
older than the fetch window.

**Not in this milestone:** correlating pull requests to individual Jira issue
keys. That is the deferred *development links* item above, and it is a different
problem sitting on top of the same auth and config this milestone built.

**Exit criteria met:** with GitHub configured, a standup shows every open PR the
team has in the declared repos, grouped by person, fetched in one request before
the first person speaks; with GitHub not configured, its list empty, or its token
dead, every existing screen behaves exactly as it did before. Verified by
`scripts/test-github.mjs` (181 checks after 11c) covering login normalisation, repo-ref
parsing including the injection cases, API base derivation for github.com vs
GHES, the aliased query, response → view model, review-state and staleness
derivation, per-person slicing, the roster
matcher, and — against a stubbed transport — partial failure and expiry-header
recording.

---

## M9 — Command palette + quick triage ✔ *(suggested feature 9)*

**Size: M** · Done. Depends on M4 (findings).

The keyboard layer that makes this a power tool rather than another dashboard.

- `Cmd/Ctrl+K`: fuzzy jump to any issue by key or summary, any person, any view, any sprint. Recent items first.
- Raw JQL escape hatch, with results in the standard issue list.
- Palette-driven actions everywhere: "start standup", "clear cache", "export config".
- Card drag-and-drop between Kanban columns, shared with the standup board.

**Triage mode** — walking the M4 queue and fixing each finding by keystroke —
needed the M8a write layer, which landed on 2026-08-20. The split on 2026-08-12
is what shortened that wait, and the queue-walking keystrokes are now the only
part left to build: assignee, estimate and due date all have a tested write
behind them, and `js/issue-edit.js` is the same contract the drag path uses.

Verified by `scripts/test-palette.mjs` (47 checks).

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
`scripts/test-standup.mjs` covering pause arithmetic, overrun, transitions,
resume, and the shared board grouping.

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

## M3 — People layer: team mapping ✔ *(feature 3)*

**Size: M** · Done. Depends on M2. Hard dependency for M6, M8, M9, M11, M14, M15, M16.

**What was built**

- **Roster data layer** (`js/team.js`) — device-local, since a roster holds colleagues' names, emails and avatars. Shape carries a team list plus an active id from day one, so a team switcher is additive later rather than a migration. Members dedupe on accountId, then email, merging blanks instead of duplicating a person.
- **Three ways onto the roster** (`js/roster-ui.js`), in order of how widely they work:
  1. **Harvest from boards** — `getAllSprintIssues` + `getAllBacklogIssues`, no extra Jira permission, ranked by issue count. Only finds people with an assigned issue right now, which is why it is not the only path.
  2. **Directory search** — `GET /rest/api/3/user/search`, filtered to human accounts. Needs "Browse users and groups", which many sites restrict to admins, so a 403 degrades to an explanatory note rather than an error.
  3. **Manual entry** — account ID (reliable) or email. An email-only member is stored **unlinked**, flagged in the UI, and gets its accountId filled in automatically the next time that person appears in a harvest.
- **Per-member**: display-name override, emoji, avatar override, Slack handle, GitHub login (added in M11), active flag, and a `capacity` object carried through untouched for the planner (M15).
- **Team Only filter** in the filter bar, persisted, honoured by all three views. It hides work assigned *outside* the roster but keeps unassigned issues — hiding those would make the M4 hygiene checks lie.
- **Outsiders are marked, not hidden**: the assignee dropdown labels them `· outside team`, and `extractAssignees` sorts roster members first.
- Display names resolve through the roster everywhere (`assigneeLabel`), falling back to the Jira name shortened to first + last.
- Roster is **excluded from config export** unless explicitly ticked, behind a confirm — same pattern as the token. Import warns before storing colleagues' details.

**Exit criteria met:** one roster, defined once, respected by every view and
reused by later milestones. Verified by `scripts/test-team.mjs`.

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
- **Config export/import** (`js/portable.js`) — JSON file with site, brand, boards, status groups, field mapping, additional fields and (from M11) the GitHub host, org and repo list. Both tokens are excluded by default and each needs its own checkbox plus its own confirm — one prompt per secret, naming what that secret exposes, because a single "this file has secrets in it" dialog teaches people to click past it. The file is browser-neutral, which is what makes the M12 migration path work. Import validates and sanitises every field, drops junk with a warning rather than throwing, and refuses files that are not ButterJira exports.
- **Token moved to `chrome.storage.local`** (`js/credentials.js`) — off `sync`, which replicated it in plaintext through the user's Google account to every signed-in device. Non-secret config stays on `sync`. Cross-machine transfer is now the export/import flow. Also added a "forget token on this device" action that keeps everything else.
- **Numbered storage migrations** (`js/migrations.js`) — `schemaVersion` in local storage, migrations run before any config or credential read (memoised, idempotent) and on `chrome.runtime.onInstalled`. v1→v2 moves legacy synced credentials to local. Storage written by a newer build is left untouched rather than mangled. This is what makes a codebase change a non-event.
- **Token lifecycle UX** — creation and expiry dates recorded at setup (default one year, since Atlassian does not expose real expiry over the API), correctable in Settings, with a once-a-day banner from T-14 onwards. A 401 now opens a re-auth prompt asking for the token alone, with site, email, boards and field mapping preserved; parallel 401s produce one prompt, not a pile-up.

**Exit criteria met:** remove the extension, re-add it, and land straight in the
app with all settings intact. An expired token asks for a token and nothing else.
Verified by `scripts/test-credentials.mjs` for everything except the browser-level
ID pinning, which is on the manual checklist.

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
- **Custom field discovery.** `GET /rest/api/3/field` matched by field name resolves the four roles the app needed at the time (story points, start date, epic link, sprint — `epicName` was added later for the Backlog's Epic column) into ordered candidate ID lists; `fieldValue(issue, role)` takes the first that carries a value. Runs automatically at setup, re-runnable from Settings, with manual override per role. Unresolved roles degrade to empty values instead of breaking a view.
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

## M0 — Hygiene and foundations ✔

**Size: S** · Done. No user-visible change; bought back time on everything after it.

- `.gitignore` authored.
- `.DS_Store` files removed from the tree.
- Duplicated board defaults collapsed — `settings.js` no longer re-declares what config owns.
- Jira base URL single-sourced. It had been hardcoded in nine places across `js/api.js`, `js/router.js`, `js/components/nav.js`, `js/views/*.js`, and the old test script; all of them now go through `jiraUrl()` / `browseUrl()` / `wikiUrl()`.
- Ad-hoc test script rewritten as `scripts/jira-smoke.js`, reading everything from the environment.
- `README.md`: what it is, how to load unpacked, how to get an API token.
- `scripts/SMOKE-CHECKLIST.md`: manual pass covering install → auth → views → config round-trip. Cheap substitute for a test suite until there is a build step.

**Exit criteria met:** `js/config.js` is the only module that knows the site
URL; no duplicated defaults; README lets a stranger run it.
