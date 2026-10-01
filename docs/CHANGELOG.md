# Changelog

What changed between released versions, for somebody deciding whether to
download a zip. `.github/workflows/release.yml` lifts the section matching the
tag into the release notes, so the wording here is the wording published — keep
it about what a user gets. The reasoning is in the commit history;
[ROADMAP.md](ROADMAP.md) is what is still to come.

## Unreleased

**Sprint planning as a process.** `LAUNCH → SPRINT PLANNING (NEW)`: set up,
wrap up the outgoing sprint, plan, review and start, one board at a time. The
new sprint can be created from here, the outgoing one is closed and the new one
started from here, the recap opens before the close and the scope snapshot is
taken at the start. Split proposes part one's points from the time already
spent; due dates can be proposed for the whole plan; new issues can be created
straight into it. A Solo / Group switch sizes the type for one person or a
shared screen.

**The 1:1 sheet, tidier.** Copy for Slack works when the browser refuses its
clipboard (it said "Clipboard was refused" whenever the page had lost focus).
Keys in the Closed list open the issue. In What is planned, epics are purple and
stories and tasks green. The "waiting on their review" list and the "activity,
not performance" note are gone, and the picker's footnote says where notes are
deleted.

## v0.8.1

**A sprint planner.** `LAUNCH → SPRINT PLANNER`, or press `p`. Prepare the next
sprint before the planning meeting, go through it in the meeting, and push it to
Jira in one reviewed batch at the end. Sprints are still created, started and
closed in Jira.

- **Setup.** Choose the boards. On each, choose the sprint to plan into and the
  sprints to carry leftovers over from, including another board's. Then the
  dates and working days, a buffer for unplanned work (20% by default, or
  points per person), and the people. Dutch public holidays are taken off the
  working days and named, each one untickable. Everyone's capacity is their
  working days less their buffer, one day being one story point unless
  Settings → Sprint planner says otherwise. Days and buffer can be changed per
  person for leave.
- **Planning.** Everyone down the left with their capacity, what is assigned to
  them and the difference, warning at 100% and 120%. Beside them, the leftovers
  first, then the backlogs, under way before to do before on hold, filterable
  by epic, label and priority, with each epic's remaining work alongside. Drag
  cards onto the plan or onto a person, or press +. Nothing gets in without an
  assignee and an estimate, and cards with no estimate are marked in red.
  Cards are two lines, with the estimate and the assignee changed in place.
  Add issues from any board by key or link.
- **Split** a half-done leftover: the original becomes "- pt.1" and closes with
  the points done (half by default), "- pt.2" carries the rest, the due date and
  the parent, and both are linked and commented.
- **The draft stays on this device** until you push, so it survives a reload
  and can be finished the next day. **Refresh tasks** re-reads Jira.
- **Review & push** re-reads Jira, shows every change and anything that moved
  underneath the plan, and refuses to push an unassigned or unestimated issue.
  A write that fails is retried three times, then reported by issue with Jira's
  reason.
- **Settings → Sprint planner:** hours per story point and the holiday
  calendar, both carried in the config export.

## v0.8.0

**Development on every issue.** With GitHub connected, an issue's page and
drawer now list the pull requests, branches and commits that mention its key in
your configured repositories: each pull request's state and review status, its
branch, who opened it and when it last moved. Matching is exact, so ABC-1 does
not pick up ABC-12.

**Jira links can open here.** Switch on Settings → Jira links, and clicking a
Jira issue, board or backlog link anywhere in the browser opens the issue page,
the Kanban or the Backlog in butter_jira instead. Everything else still opens in
Jira, and the app's own "Open in Jira" links always do. Atlassian Cloud sites
only; off unless you turn it on.

**Back up this device.** Settings → Backup & transfer can now save everything the
app has recorded and could not fetch again: the snapshots behind every burndown,
sprint freezes, your todos, preferences and the config, plus the roster if you
tick it. Restoring merges the backup in without changing anything already on the
device, so an old backup is safe to restore. Tokens and 1:1 notes are never in
the file.

**No more double counting across boards.** When two configured boards show
the same issue (two boards over one project, split by team or component), it is
now counted once everywhere: sprint totals, the burndown, hygiene findings, the
backlog and the standup. Filtering by either board still shows it, and each
board's own block on the dashboard and in the recap still counts it.

**Recap config: build a recap from any sprints you like.** `LAUNCH → RECAP
CONFIG`, or *Configure a recap…* in the Sprint Dashboard's recap menu. Tick the
boards you want and, within each, the sprints — active or closed, one or
several, with quick picks for *Active*, *Last closed* and *Last 3 closed* — then
**Generate recap** for one combined document across all of them. The same board
choice opens the quarterly overview for just those boards. The selection lives in
the recap's link, so a recap can be reloaded or bookmarked, and the screen
remembers your last choice. Recaps of sprints older than six weeks now read
GitHub over those sprints' own dates rather than stopping at the last 45 days.

**The dashboard and recaps only count your team.** With a roster set up under
Settings → Team, the Sprint Dashboard, the sprint recap and the quarterly
overview count only tickets held by people on it, plus unassigned tickets.
Anyone else working on the same boards — opening, closing or picking up
tickets — no longer appears in a row, a total, the burndown or the freeze diff,
and outside contributors to your repositories never did. The dashboard header
and the recap both say how many issues were left out. A team ticket handed to
somebody outside the team mid-sprint shows as pulled out, "reassigned outside
the team". Kanban, Backlog and Monitor keep their Team only / Everyone toggle.

**A quarterly overview.** The Sprint Dashboard's second button is now a menu,
**Recap past sprint**, with two entries: the past-sprint recap, and **Prepare a
quarterly overview** — a printable document for a calendar quarter. It has the
team's week-by-week velocity as two charts (a Jira activity score and GitHub
commits to main), a table of the quarter's key figures, a small chart and a row
of whole-quarter figures per person, and the epics closed and still in progress.
Pick the quarter on the page: this one so far, or any of the three before it.
The Jira score's formula is printed on the document, and GitHub is read over the
whole quarter rather than the last 45 days. Each person's chart has its own
scale, weeks with fewer than three days in the quarter are left off the charts
(still counted in the figures), the per-person table is ordered by a combined
ranking of Jira activity, commits and lines to main, and the PDF prints edge to
edge.

**Recap a sprint after it has closed.** The Sprint Dashboard has a second button,
**Recap previous sprint**, which builds the same printable document for the last
sprint each board closed rather than the one running now. It is there whether or
not a sprint is currently active — a board between sprints is exactly when you
want it — so a fortnight that rolled over while you were away is no longer a
document you missed the chance to make.

The closed document says so on the page, and its figures are as at the moment the
sprint was completed, not the day you printed it: no "5 days remaining" on a
sprint that finished a fortnight ago, and pull requests merged the week after do
not count towards it.

**The loading screen is the mark, breathing.** Where a small spinning logo used
to sit while a view loaded, the ButterJira wordmark now fades in and out at the
centre of the window. For anyone whose system asks for reduced motion it drops
the scaling and just fades, slowly.

## v0.7.0

**The weekly 1:1.** `LAUNCH → 1:1`, or press `1`. Pick somebody from the roster
and get the sheet you would otherwise assemble by hand in the ten minutes before
the meeting: what is on their plate, what they closed and moved, what is stuck
(including the pull requests in the way, ordered by *how* stuck), what is
planned, their load per sprint, and a mini-Gantt of everything of theirs that
carries a date. On the right, notes you take during the conversation — actions
with an owner and a deadline, and context worth remembering — saved as you type.

**It knows when you last spoke.** Pressing **Complete 1:1** archives the notes
as a dated entry and stamps a per-person clock, so the sheet opens on everything
since that moment: a week for the people you see weekly, a fortnight for the
people you see fortnightly, with nothing to configure. Open actions carry into
next time under a dated rule. **Copy for Slack** puts the outcomes on your
clipboard for the message you were going to send anyway.

**My todos.** `LAUNCH → My todos`, or press `t`. Actions you took on in a 1:1
land here when you complete the meeting, so your own commitments are one list
rather than scattered across a dozen sheets. Add anything else by hand.

**The notes never leave the device.** They are the only thing this extension
holds that you wrote about a named colleague, so they get the strictest
treatment in it: never synced, and **no export path at all** — not even a
checkbox. The only way one leaves is you pasting it. They are also kept until
you delete them, which makes **Settings → 1:1 notes and todos** the whole
retention policy; it says how much is stored and deletes it in one action.

**Standup and the sprint recap moved into `LAUNCH`.** Three rituals behind one
menu instead of one promoted tab and a recap button buried in the dashboard
header. Standup keeps its `s`.

**New mark.** ButterJira has a face. It replaces the old logo everywhere it
appeared — the nav bar, the loading spinner, the setup card, the Settings
header, and the toolbar button, which now carries the mark rendered at 16, 32,
48 and 128 rather than one 128 the browser squashes. Every page also has a
favicon for the first time, so an app tab is findable in a crowded tab strip.

## v0.6.0

**Sprint freeze, and what changed under the plan.** The sprint's state is frozen
per issue on the first dashboard load of a new sprint, and the dashboard shows
what happened to it since: crept in, pulled out, re-estimated, due date moved,
re-assigned, went backwards — with an arithmetic line that reconciles the
buckets. Jira does not keep this; it is recorded forward, so it starts
accruing the day you install.

**Linked issues, read and write.** *Blocks*, *is blocked by*, *duplicates*,
*relates to* — created and removed from the issue detail, with the link types
discovered from your own site. Direction is the part this is careful about: a
link built the wrong way round does not fail, it just quietly means the
opposite.

**The standup setup screen fits one screen.** Participants, speaking clock,
sound toggle and Start, with the meeting's three keys on one line beneath the
button. Two panels that used to push Start below the fold on a 14" laptop are
gone; what they said moved into the header.

**GitHub's fetch says what it is doing.** Hover the GitHub state on the standup
setup screen for both queries, how far the paged one has got, how long it has
taken, and which repos are missing by name — and a headline that says whether
anything is still running. Starting a standup mid-fetch warns first, with a
`Start anyway`. Nothing is blocked and nothing has a timeout: the standup has
never waited for GitHub.

**A design pass over every screen.** Primary button labels now pass WCAG AA in
dark theme (they were 3.21:1), one icon vocabulary replaces four, the drawer
reads as a drawer, and every view carries the same header. The Board's header
is a single row, so the columns get the height back. The Backlog's density
pills now show which one is selected. The nav tabs are one width.

**Installable from a release.** Chrome, Firefox and Edge zips, built and
published by GitHub Actions from a tag, with checksums — and a licence:
[PolyForm Noncommercial 1.0.0](../LICENSE). Source-available, not open source:
fork and modify freely for noncommercial purposes.

**Upgrading from v0.5.0:** unzip over the old folder and press refresh on the
extension's card. Settings, boards, roster and the local histories live in
browser storage, not in the folder, so nothing is lost.

## v0.5.0

The first tagged build. Sprint dashboard, Gantt roadmap, Backlog, Kanban,
Monitor, Standup mode and issue detail over several Jira Cloud boards at once,
with optional GitHub sync, the write layer (transitions, field edits, issue and
sub-task creation, comments) and the daily snapshots behind the burndown.
Packaged by hand.
