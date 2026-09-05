# UX and design backlog

Work that a design review found and nobody has done yet, with enough context to
pick any item up cold. Written 2026-09-05, after the review recorded below.

**Why this file exists separately from [ROADMAP.md](ROADMAP.md):** the roadmap is
organised by milestone — what gets built next and why. This is organised by
surface and by defect. Most of what follows is half a sitting each and belongs
to no milestone; bundling it into one would hide it, and leaving it in a chat
log would lose it.

**Read [Ground rules](#ground-rules) and [Quirks](#quirks-that-will-bite-you)
before touching anything here.** Several of these items look like one-line fixes
and are not, and two of them have already been "fixed" in the wrong direction
once.

---

## Ground rules

Pinned by the author on 2026-09-05. These are not up for re-litigation by
whoever picks this up next, including a future session of the same assistant:

1. **The animated gradient stays.** The blue → purple → orange sweep on the
   STANDUP nav tab (`css/nav.css`), the standup counters (`css/standup.css`) and
   the Start Standup button. Stops live in `--flair-stops` / `--flair-sweep`
   (`css/app.css`) — one source, do not re-inline them. A mechanical detector
   will flag `gradient-text` on the counters every time; that finding is
   declined, not outstanding.
2. **The general colour scheme stays.** The dark palette is deliberate. Light
   theme was fixed because it was broken (chips at 1.5–3.3:1); dark was left
   alone on purpose, including two tones that are marginally under AA — see
   [Deliberate non-goals](#deliberate-non-goals).
3. **The theme toggle's sky stays** — sun, moon, stars, clouds, craters
   (`css/app.css`). The detector flags it as `pulsing-dot` and `dark-glow` on
   every run. Also declined.
4. **Product constraints from [PRODUCT.md](PRODUCT.md) bind all of this:** no
   build step and no runtime dependencies, credentials device-local with no
   telemetry, nothing instance-specific hardcoded. No CSS framework, no icon
   package, no component library. Anything below that seems to want one wants
   something else instead.

---

## How to verify anything here

A fresh session should run these before believing any claim in this file, and
after making any change.

**Tests** — eighteen suites, no dependencies, no network, no browser:

```bash
for f in scripts/test-*.mjs; do node "$f" >/dev/null || echo "FAIL $f"; done
```

**Look at it.** Seven preview harnesses mount the real view against stubbed
storage and a stubbed Jira, with no credentials:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 &     # from the repo root
```

then open `http://127.0.0.1:8765/preview-<view>.html` for `backlog`,
`dashboard`, `standup`, `issue`, `create`, `recap`, `gantt`. Useful params:

| Param | Effect |
|---|---|
| `?theme=light` | The theme most bugs hide in. Every one found in the 2026-09-05 review was in a view that had no harness. |
| `?start=1` | Standup only — jumps straight to a running session. |
| `?pressure=0.8` · `?over=0.5` | Standup only — pins the time-pressure channel so its states can be seen without waiting out a slot. Overwritten by the next clock tick, so it is a viewing aid, not a way to fake a session. |
| `?epics=none` · `?epics=undated` | Roadmap only — the two empty states. |

**Screenshot it headlessly** (macOS path; both themes, both widths):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --window-size=1440,900 --virtual-time-budget=5000 \
  --screenshot=/tmp/shot.png "http://127.0.0.1:8765/preview-backlog.html?theme=light"
```

**Mechanical scan**, if the Impeccable skill is installed:

```bash
<skill>/scripts/impeccable detect --json app.html js/views/ js/components/
```

Expect **3 findings, all declined** — the two theme-toggle rules and the standup
gradient text. Anything else is new.

**There are no harnesses for Kanban or Monitor.** That is item 6 below, and it
is why those two views are where the next light-theme bug will be.

---

## The backlog

Ordered by value, not effort. Each item states what is wrong, why it matters,
where it lives, and what "done" looks like.

### 1. Primary button labels fail contrast in dark theme

**Ten selectors** put `color: #fff` on a `var(--accent-primary)` background.
In dark theme that is `#fff` on `#4F8EF7` = **3.21:1**, under the 4.5:1 AA floor
at every size these buttons use. Light theme is `#fff` on `#2563EB` = 5.17:1 and
is fine. Dark text on the same blue is `var(--bg)` on `#4F8EF7` = **5.98:1**.

```
css/backlog.css:123   .bl-seg.on
css/backlog.css:197   .bl-btn.primary
css/backlog.css:617   .bl-page.on
css/app.css:302       .setup-save
css/issue.css:406     .issue-reply-post
css/standup.css:408   .su-btn.primary
css/standup.css:423   .su-start
css/standup.css:605   .standup-btn.primary
css/standup.css:615   .standup-start
css/standup.css:857   .standup-btn.standup-ctrl.primary
settings.html:349     .btn-save
```

**Caveat — this has already been got wrong once.** `.create-submit`
(`css/issue.css`) originally used `var(--bg)`, which was *correct*, and it was
changed to `#fff` on 2026-09-05 "for consistency" with the other eleven. That
made twelve buttons uniformly wrong rather than noticing the outlier was right.
Fix in the other direction.

**Two that look like they belong on this list and do not:**

- `css/backlog.css:527` `.bl-avatar-fallback` — white on a per-person hash
  colour, not the accent. A different problem, not this one.
- `css/recap.css:521` `.recap-print-btn` — white on `--step-3`, which was
  darkened to `#1d63b8` (5.95:1) on 2026-09-05. Already passes. Leave it.

**Done when:** all ten read against the accent at ≥4.5:1 in both themes. The
likely shape is a `--on-accent` token that is `var(--bg)` in dark and `#fff` in
light, rather than eleven separate edits.

---

### 2. The issue drawer is not really a dialog

`js/components/drawer.js:49-50` sets `role="dialog"` and `aria-label` and stops
there. It never sets `aria-modal`, never moves focus into the panel, never traps
it, and never restores it to the trigger on close. Opening an issue leaves focus
on the card behind a dimmed backdrop, and Tab walks into the still-live view
underneath. Nothing announces that a dialog opened.

**Why it is second on the list rather than an accessibility footnote:** this is
the root cause of the standup Escape collision. `Escape` used to end a standup;
opening a card mid-turn and pressing Escape to dismiss it closed the card *and*
ended the meeting, because focus was still on `<body>` so standup's
INPUT/TEXTAREA guard never fired. That was patched on 2026-09-05 with
capture-phase handlers in `drawer.js` and `reauth.js` plus a move to
`Shift+Esc`. **The patch holds, but it is a patch** — the disease is that the
drawer does not take focus, and the next component that binds a document-level
key will hit the same thing.

**Caveat:** the drawer is opened from at least six places (board cards, backlog
rows, monitor findings, dashboard freeze list, link picker, standup board) and
during a running standup, where it deliberately opens *below* the clock via
`--drawer-top` / `--drawer-bottom`. Focus restoration has to survive the case
where the trigger has been removed from the DOM by a repaint while the drawer
was open — dragging a card repaints the board.

**Done when:** focus moves in on open, is trapped while open, returns to the
trigger (or a sane fallback) on close, `aria-modal="true"` is set, and a standup
can still be driven with a card open.

---

### 3. The Kanban column editor asks you to remember Jira

`js/views/kanban.js:204-226`. Configuring columns means typing **raw Jira status
strings, comma-separated, from memory**:

- `:204` — "Map Jira statuses to columns. Comma-separated."
- `:224` — placeholder `"Status 1, Status 2, ..."`
- `:226` — `statusInput.value.split(",").map(s => s.trim())`
- `:261` — `Save & Apply` silently drops any group with an empty name or no
  statuses. No message, no highlight.

The app has already fetched every real status name on every configured board by
the time this panel opens. It renders them in five other places.

**Why it matters more than it looks:** per PRODUCT.md, the secondary audience is
"anyone who clones it", and this is the *first* thing they must do, because
their statuses are not `To Do / In Progress / In Review / Done`. It is the
least-supported step in the product and the one with the least margin for error.

**Done when:** statuses are picked from what the site actually has (a two-pane
picker or a token input with completion), a half-finished row is either rejected
loudly or kept, and typing a status by hand is still possible for a status that
exists but has not been seen yet.

---

### 4. Settings is the least designed screen in the app

`settings.html` carries **449 lines of inline `<style>`** — the only stylesheet
in the project not in `css/` — holding six more button variants. All **seven
`<details>` sections are collapsed on first paint** (`grep -c '<details open'`
returns 0), so the settings page opens showing no settings. Every label is mono
all-caps micro-type. `SAVE ALL SETTINGS` is a full-bleed button at 3.21:1
(item 1). `settings.js:104-118` reimplements `loadTheme`/`saveTheme` instead of
importing them from `js/utils.js:202-216`, and the theme-toggle markup — twenty
spans — is hand-duplicated from `js/components/nav.js`.

**Caveat:** Settings is also where first-run configuration happens and where the
board picker and field discovery live. It is not a screen to redesign casually;
the `harden`-style pass is the safe one — extract the stylesheet, open the first
section, fix the contrast, share the theme toggle — not a re-layout.

**Done when:** the stylesheet lives in `css/settings.css`, the page opens with
at least the first section expanded, and the theme toggle is imported rather
than copied.

---

### 5. There is no keyboard path to change an issue's status

Dragging a card between columns is the only way (`js/components/board.js:288`
onward, `js/issue-move.js`). Every other write in the app has a keyboard path.
The board is also the surface most often corrected during a standup, on a shared
screen, by someone who may be driving from a laptop trackpad.

**Related, same area:** the drag now shows an in-flight state
(`.kanban-card-writing`, added 2026-09-05) but still has **no undo**, and a Jira
workflow transition is frequently one-way, so "just drag it back" is not always
possible. Adding undo means issuing a *second* Jira write, which is a product
decision — see [Deliberate non-goals](#deliberate-non-goals).

**Done when:** a focused card can be moved between columns from the keyboard,
with the same transition matching, rollback and refusal wording as the drag.

---

### 6. Kanban and Monitor still have no preview harness

Five views had one, and every light-theme bug the 2026-09-05 review found was in
one of the three that did not. The Gantt got `preview-gantt.html` that day
*because* it could not otherwise be seen, and it immediately showed dark zebra
stripes across a white chart and an invisible today marker.

**Copy `preview-gantt.js`, not the others** — it is self-contained (stubs
`chrome` and `fetch` itself) rather than built on `preview-fixture.js`, which is
the pattern that suits a view with its own data shape.

**Two gotchas it cost an hour to find, both now commented in that file:**

- The epic query is a **POST** to `/rest/api/3/search/jql` with the JQL in the
  body, so a stub that only reads the URL matches nothing.
- `saveConfig()` alone is not enough. `BOARDS` in `js/utils.js` is a
  module-level array populated by `loadBoards()`, and API calls that build a
  project-key list from it return empty until that runs.

---

### 7. Error toasts vanish before they can be read

`js/utils.js:249` — `TOAST_MS = 5000`, for every toast including errors. They
are click-through unless they carry an action, and there is no way to recall one.

The refusal text is genuinely good — *"ACME-101: the workflow allows no move from
In Review to Done — only Blocked, Reopened"* — and it appears bottom-centre for
five seconds while the card you dropped is wherever you dropped it, on a screen
that during a standup is being read by a room.

**Done when:** errors dwell longer than confirmations (or until dismissed), and
the last one can be brought back.

---

### 8. Four icon vocabularies, and one of them has no accessible name

- Authored SVG paths, distinguished by silhouette — Backlog only
  (`js/views/backlog.js:74-90`). This is the good one.
- **Emoji** — `js/components/board.js:21-24`, priority as `🔴🟠🟡🔵` with no
  `title` and no text. It is the one element on a card with no accessible name
  at all, and the only encoding of priority. Overdue is a `📅` with
  `filter: hue-rotate(-60deg)` (`board.js:159-168`), which renders differently
  on every platform.
- **Unicode glyphs** everywhere else: `⟳ ⚙ ▾ ▶ ▼ ✕ × ↑ ↓ ✓ − …`, including two
  different close glyphs (`✕` U+2715 in `drawer.js`/`issue-detail.js`, `×`
  U+00D7 in `kanban.js`/`roster-ui.js`) and four caret implementations.
- PNG logos in the nav.

**Constraint:** no icon package (Ground rule 4). The answer is a small authored
SVG sprite in the shape the backlog already uses, not a dependency.

---

### 9. Around fifteen button implementations

`.setup-save`, `.bl-btn`, `.su-btn`, `.standup-btn` (+ `.small`, `.ghost`,
`.primary`, `.standup-ctrl`), `.su-start`, `.standup-start`, `.nav-btn`,
`.gantt-mode-btn`, `.gantt-dropdown-btn`, `.kanban-group-btn`, `.monitor-chip`,
`.dash-freeze-btn`, `.dash-recap-btn`, `.issue-links-action`, `.create-submit`,
`.expiry-banner-btn`, `.filter-toggle`, plus five more inside `settings.html`.

Radii ran 3/4/5/6/7/8/9/10/12/14px. `--radius-xs|sm|md|lg` now exist in
`css/app.css` and most of the shell has been moved onto them; the view
stylesheets have not.

**Do this after items 1 and 4**, not before: a shared button that bakes in the
wrong label colour, or that lands before Settings' inline stylesheet is
extracted, has to be done twice.

---

### 10. Kanban and Monitor are the previous generation

Backlog, dashboard, standup-setup and recap were authored with stated reasoning
in their stylesheets. Kanban (`css/kanban.css`) is generic column/card CSS with
emoji, Monitor likewise. Inside the standup view there are still two design
languages: setup is `.su-*` (radius 10–12, tiles, numbered steps, 1180px) while
the end screen is `.standup-setup` — the previous generation, resized on
2026-09-05 but not merged.

This is the largest item here and the least urgent. Treat it as a redesign of
two surfaces, not as polish, and do items 1–9 first.

---

## Quirks that will bite you

Discovered the hard way. Each of these has already cost someone an hour.

- **`--font-scale` is not optional.** Every font size in the app is
  `calc(<design px> * var(--font-scale))` (`css/app.css:43`) because the
  app is read off a shared screen during standup. `css/nav.css` was a JS string
  that ignored this for six sizes until 2026-09-05. New CSS that hardcodes a
  pixel size is a bug, not a style choice.
- **Tokens must be in scope, not merely defined.** `css/recap.css` declared its
  whole palette on `.recap`, while the toolbar is a sibling of `.recap-sheet`.
  Every `var()` in three rules was invalid at computed-value time, so the Print
  button lost its background *and* its border and rendered white-on-near-white
  at 1.19:1 — the primary action of that page, invisible in production for
  however long. Check where a custom property is declared relative to everything
  that reads it.
- **`var(--accent)` does not exist.** It was used once in `css/standup.css` and
  silently fell through to `currentColor`, working by accident. The token is
  `--accent-primary`.
- **frappe-gantt only draws its today marker in Day view.** `make_grid_highlights()`
  is guarded on it, so Month, Week and Quarter — the views a roadmap is actually
  read in — have no `.today-highlight` element to read a position from. The line
  is computed in `js/views/gantt.js` (`todayX`) by copying the library's own
  `compute_x`, including its Month special case where columns are a nominal
  thirtieth of a month rather than a fixed step. If you change view modes or
  upgrade the library, re-check that function against `compute_x`.
- **`toISOString()` is a bug in date-only code.** A Jira due date is a calendar
  day; formatting one through UTC shifts it a day backwards anywhere east of
  Greenwich. `deliveryState` compares local midnights for this reason, and
  `scripts/test-gantt.mjs` was itself briefly wrong in exactly this way — its
  helper now formats local components, and the suite passes under
  `TZ=Pacific/Auckland` and `TZ=America/Anchorage`. Run it under both after
  touching anything date-shaped.
- **Preview harnesses can hide the bug they exist to show.**
  `preview-standup.html` set `#view-container { position: static }` with no
  height, so `height: 100%` on the running stage resolved against nothing and
  the screen rendered at content height in the harness and full height in the
  app. `preview-issue.js` still omits the page shell, so the issue page renders
  flush to x=0 there and correctly in production. Distrust a harness before
  filing a layout bug from one.
- **`prefers-reduced-motion` has been forgotten twice.** `css/app.css` held the
  app's only infinite animation and was the one stylesheet of eleven with no
  clause; `js/components/nav.js` shipped a second confetti implementation that
  skipped the check the real one makes. Both fixed. `js/confetti.js` is the only
  confetti — it does nothing at all under reduced motion, by design.
- **Board colour is deliberate, not decoration.** Inline `link.style.color` in
  `monitor.js` and `gantt.js` colours an issue key by its board, matching
  `board.js`. It looks like a workaround for the unstyled-link bug and is not.
  Leave it.
- **Every write is user-initiated and enumerable** (PRODUCT.md). The app writes
  in six places and nowhere else. Anything here that would add a seventh —
  notably undo-on-drag — is a product decision, not a polish task.

---

## Deliberate non-goals

Not oversights. Re-open only with the author.

- **Undo on drag-to-transition.** Needs a second Jira write. See item 5.
- **Dark-theme chip tones.** `--tone-red` at 3.96:1 and `--tone-purple` at
  3.71:1 against their own chip backgrounds are marginally under AA. Light
  theme was fixed (it ran 1.5–3.3:1); dark was left because the palette is
  pinned. Changing them is a scheme change, not a contrast fix.
- **The hash-coloured card top border.** `board.js` gives every card a 3px top
  edge from `hashColor(issue.key)` (`js/utils.js:47`). It carries no meaning,
  sits above a *meaningful* board stripe, and puts ~40 random hues on a full
  board. Removing it, or making it carry days-to-due, is a taste call the author
  has not made.
- **The nav's ticking wall clock.** `js/components/nav.js` re-renders a seconds
  clock every 1000ms in the visual centre of the shell, showing what the OS
  already shows, while the one fact only this app knows — how stale its data is
  — sits in 11px muted text in the bottom-left corner. Same kind of call.
- **The three detector findings** listed under Ground rules.

---

## What the 2026-09-05 pass already did

So a fresh session does not re-derive or redo it. Full commit message on
`57e9b5f`; the critique snapshot it came from is under `.impeccable/critique/`,
which is **gitignored and therefore local-only** — this file is the durable
record.

Fixed: `Escape` ending a standup with no confirm and no overlay guard; issue
keys rendering as browser-default links at 1.87:1 in four views; the recap's
invisible Print button; three rival status→colour maps collapsed onto
`statusTone()`; the `--tone-*`, `--flair-*`, radius and z-index tokens; light
theme across the Gantt, the nav and every chip; the nav's injected stylesheet
extracted to `css/nav.css`; its duplicate confetti; reduced-motion clauses in
four stylesheets; a global focus ring plus five `outline:none` sites with no
replacement; `::selection` and `caret-color`; an in-flight state on drag; the
Backlog's starved Summary column; sub-24px hit targets; `.board-badge`'s missing
rule; Gantt truncation.

Reworked: the standup stage (pressure ramp, slim stats rail, pull requests moved
to the bottom strip, the first speaker's missing avatar) and the roadmap (today
line and auto-centring, delivery-state colouring, click-to-open, the caret).

Added: `preview-gantt.html`, `scripts/test-gantt.mjs`, pressure coverage in
`scripts/test-standup.mjs`. Eighteen suites, 1791 checks.
