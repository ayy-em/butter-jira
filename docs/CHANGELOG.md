# Changelog

What changed between released versions, for somebody deciding whether to
download a zip. `.github/workflows/release.yml` lifts the section matching the
tag into the release notes, so the wording here is the wording published — keep
it about what a user gets, and leave the reasoning to
[ROADMAP.md](ROADMAP.md), which keeps the full record.

## Unreleased

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
