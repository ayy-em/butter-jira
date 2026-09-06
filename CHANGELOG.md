# Changelog

What changed between released versions, for somebody deciding whether to
download a zip. `.github/workflows/release.yml` lifts the section matching the
tag into the release notes, so the wording here is the wording published — keep
it about what a user gets, and leave the reasoning to
[ROADMAP.md](ROADMAP.md), which keeps the full record.

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
[PolyForm Noncommercial 1.0.0](LICENSE). Source-available, not open source:
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
