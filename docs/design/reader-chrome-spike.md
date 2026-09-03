# Reader and Speed chrome consolidation spike

**Status:** accepted product and architecture direction; implementation pending
**Date:** 2026-09-01
**Scope:** Read and Speed presentation, responsive chrome, navigation,
analytical context, Find, accessibility, and delivery sequencing

This spike is grounded in the shipped components and browser screenshots at
390×844 and 1440×900. It was challenged by an explicitly pinned Claude Opus
planner through Parley (request `req_consult_86ac172427f1f02a`, artifact
`art_sha256_a8fa13964547ed38e49bbfce1d932ceae2493af5a7dc53db1460b05381fdf7c4`).
The accepted direction was then reduced to source-of-truth, component, state,
pointer-arbitration, migration, and test boundaries with the same pinned Opus
planner (request `req_consult_afb03055ab855c51`, artifact
`art_sha256_6689ccad74b18e884b597fcd2917145275841a318e9ae0244e04362768fb853c`).

## Recommendation

> **Read is the evidence. Chrome is a guest.**

Ordinary Read should stop carrying a workbench dashboard around the source
text. On a phone, keep one 44px reading bar with a three-pixel progress rail
integrated into its top edge. Move the remaining commands into an explicit
Reader sheet, remove the analytical dock from Read, and reduce the four large
page/reference controls to compact page actions in the reading bar.

Speed has a different job. Its content is deliberately small, so transport and
pacing controls are legitimate content. Consolidate them into named transport
and frame rows, move advanced tuning into a sheet, and remove duplicated status
and the analytical dock. Atlas remains an analytical instrument and may retain
its scale-specific ruler and dock; it should not force their cost onto Read.

At 390×844, shipped Read currently spends 376.9px, or 44.6% of the viewport,
on non-prose UI:

| Resident band | Height |
| --- | ---: |
| header | 122.8px |
| text ruler | 80.1px |
| page/reference navigation | 109px |
| analytical dock | 65px |
| prose | 451.1px |

The proposed steady Read state spends about 47px plus safe areas. The prose
pane should grow to roughly 780px at the measured viewport—a 73% increase in
visible reading height—without hiding the way out.

## What is wrong in the shipped hierarchy

This is more than oversized controls.

1. **Identity and position are duplicated.** `ReaderDrawer` renders the title
   and fitted page range. `ReaderRuler` immediately renders the same title,
   cursor position, percentage, and progress again. The page range and cursor
   token are different facts, but the layout presents them as competing
   answers to the same question.
2. **Mobile wraps desktop chrome instead of composing a mobile Reader.** The
   header actions wrap below the title and the four navigation actions become
   two rows. Each control remains individually usable while the overall
   composition fails the reading job.
3. **The footer duplicates analytical context.** Read already displays source
   evidence and highlighted terms. The retained Terms/graph/barcode dock
   repeats the workbench and Atlas at the exact point where height is most
   valuable.
4. **Speed flattens several control families into one region.** Rewind,
   playback, pace, frame shape, rhythm, diagnostics, and exit have little
   hierarchy. `back` and `return to Reader` also describe two different kinds
   of going back.
5. **Chrome removal has hidden dependencies.** At compact width, `.source-text`
   fills the pane, while the current pointer arbitration rejects an edge tap
   whose target is inside `.source-text`. Only a very narrow blank gutter and
   the visible page buttons offer dependable touch page turns. Reader Find is
   also mounted in `WorkbenchDock`; removing the dock without re-homing Find
   would strand `/`.

## Product hierarchy by scale

| Scale | Primary job | Appropriate persistent UI |
| --- | --- | --- |
| **Read** | Immerse in authenticated source | position, exit, frequent movement |
| **Atlas** | Compare text extents and term distribution | ruler, normalization, analytical key |
| **Speed** | Drive source playback at a controlled pace | transport, pace, frame shape, exit |

Read's strict priority is:

1. prose;
2. one truthful position;
3. an unmistakable exit;
4. page and reference movement;
5. presentation, text switching, settings, and help; and
6. analytical context.

Only the first four may justify persistent pixels. On mobile, frequent page
turning does; lower-frequency reference movement does not. Levels five and six
must remain reachable, but simultaneous visibility is not the same as access.

## Mobile Read

### Steady state

There is no auto-hide timer and no tap-anywhere chrome mode. Read is fitted,
not scrolled, so it has no honest scroll signal. A generic prose tap already
means reading-cursor selection, while long press and double tap belong to
native text selection. A fixed 44px bar is cheaper and more predictable than
a reveal state machine.

```text
┌────────────────────────────────────────┐
│                                        │
│  Part I                                │
│                                        │
│  Being a Reprint from the              │
│  Reminiscences of John H. Watson, M.D. │
│                                        │
│  Mr. Sherlock Holmes                   │
│                                        │
│  In the year 1878 I took my degree...  │
│                                        │
│  edge: previous       edge: next       │
├────────────────────────────────────────┤
│▓▓▓▓●░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ 3px reading progress
│ [←] │‹ page│ A Study… · t1,204 · 3% │page ›│▶│
└────────────────────────────────────────┘
```

The bar contains:

- **Back**, always present and first in focus order;
- previous and next **page** actions, replacing the current 109px two-row
  transport and ensuring that touch navigation never depends on a gesture;
- one flexible **position button** containing the ellipsized title, cursor
  token, and percentage; it opens the Reader sheet;
- a visible **Speed** entry, preserving the recently established one-tap path;
  and
- adaptive degradation at extreme zoom: the page labels become arrows, then
  the title truncates to token and percentage, while Back never disappears.

Every control keeps a 44×44 target. The bar background extends through the
bottom safe area while its targets remain above the home indicator. The top
edge of the bar owns within-text progress without adding another layout row.
Exact text ordinal belongs in the sheet.

The fitted page range is not persistent chrome. The cursor token and percent
answer the ordinary orientation question. Exact page range remains available
in the sheet and in the existing accessible status.

### Shared reading-progress rail

Progress is a load-bearing part of both Read and Speed; only its analytical
decoration is removed. The shared rail has one simple meaning:

- the track is the active text from token zero to its authenticated token
  count;
- the accent fill ends at the current reading token;
- a small cursor marker remains visible at both 0% and 100%; and
- the rail resets when the active text changes rather than pretending that a
  multi-text corpus is one authored book.

Read drives the rail from the explicit reading cursor when selected, otherwise
from the current fitted-page position. Speed drives it from the displayed
frame token, not from a throttled footer broadcast, and holds the marker during
an integration rest. Exiting Speed therefore leaves the Reader rail at the
same exact position.

On compact and regular layouts the rail occupies three pixels inside the top
edge of the bottom bar or Speed transport stack. On wide Read it may rotate
vertically into the position rail, using the same progress model. It is never
a separate header/footer band.

The rail is deliberately not interactive: a three-pixel scrub target would be
inaccessible and would turn orientation into accidental navigation. Corpus
scrubbing, term marks, density, and barcode evidence remain workbench/Atlas
jobs. The rail has one `progressbar` semantic, an active-text label, rounded
`aria-valuenow`, and no live announcements. Exact token changes continue
through the existing status model. Updates are discrete with no easing or
motion transition, including under reduced motion, and forced-colors mode must
preserve both track and cursor.

### Reader sheet

The position button opens a compact bottom sheet rather than an unexplained
ellipsis menu. The sheet overlays the fitted page; it does not change the prose
pane's dimensions or trigger a page refit.

```text
┌ Reader controls                    [×] ┐
│ Position                                │
│ A Study in Scarlet · text 1 of 9        │
│ token 1,204 of 43,558 · 3%              │
│ page tokens 1,180–1,249                 │
│                                         │
│ View       [ Read | Atlas ]             │
│            [ ▶ Speed from “Watson,” ]   │
│                                         │
│ Page       [ ← previous ] [ next → ]    │
│ Reference  [ ← previous ] [ next → ]    │
│ Text       [ ← ] text 1 of 9 [ → ]      │
│            [ start ]       [ end ]      │
│                                         │
│ Highlights  Holmes · Watson · Moriarty  │
│                                         │
│ [ Display settings ]       [ Help ]     │
└─────────────────────────────────────────┘
```

Unavailable groups are omitted rather than rendered as a field of disabled
buttons. Reference controls appear only for active terms or Find. Text controls
appear only for multiple ready texts. Read/Atlas appears only when Atlas is
available. The Speed label names the selected source word when there is one.

The highlight key is read-only in this spike. Editing Terms or changing corpus
intent remains a workbench task. Conditional stale-mark and mark-cap notices
remain in Read because Terms cannot communicate those facts.

### Page taps and word selection

The compact bar keeps explicit page actions, so a gesture is never the only
route. The consolidation is still the right time to give pointer intent on the
prose surface one explicit arbitration owner:

```text
non-primary, moved >8px, held >500ms, selection active → no Reader action
interactive mark target                                → existing mark action
stable tap outside painted token rects in an edge zone  → previous / next page
stable tap on a source token, including near an edge   → set reading cursor
stable tap on blank centre                             → no action
```

The current blanket rejection of every target inside `.source-text` is too
broad. The forgiving caret resolver cannot make this distinction because a
browser clamps blank inline space to the nearest caret. A separate painted-hit
predicate must use `elementFromPoint` plus the candidate token span's client
rectangles. One pure tap-intent decision then gives painted tokens precedence
even inside an edge zone. The prose pane owns that decision; nested page and
cursor listeners must not both interpret the same pointer event. Edge taps
remain supplementary; the bar is the dependable touch path. Do not add
horizontal swipe, which conflicts with browser history gestures.

## Desktop Read

Desktop should spend its abundant lateral space instead of reproducing a
phone bar across 1440px.

When the 75ch measure plus two useful rails and gaps fit—expected at the
existing wide presentation breakpoint—use two labelled rails and no vertical
chrome:

```text
┌──────────────┬──────────────────────────────┬──────────────┐
│ ← Back       │                              │ A Study in   │
│              │  M.D., Late of the Army      │ Scarlet      │
│ [Read Atlas] │  Medical Department          │ token 1,204  │
│              │                              │ 3%           │
│ ▶ Speed      │  I                           │ ▓            │
│              │                              │ ▓ progress   │
│ TEXTS        │  Mr. Sherlock Holmes         │ ░            │
│ ▸ A Study…   │                              │ ░            │
│   The Sign…  │  In the year 1878 I took...  │ ░            │
│              │                              │              │
│ ← page       │                              │ HIGHLIGHTS   │
│   page →     │                              │ Holmes       │
│              │                              │ Watson       │
│ settings     │                              │ [‹◆] [◆›]    │
│ help         │                              │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

The left rail owns exit, scale, Speed, document identity/switching, page
fallbacks, settings, and help. The right rail owns position, vertical progress,
the highlight key, and reference stepping. The prose measure stays centred and
gets the full viewport height.

At regular and tablet widths where rails do not fit, reuse the bottom bar and
show additional labelled cells as width permits. The breakpoint must be
fit-derived; do not force nominal 200px rails beside 75ch prose merely because
the viewport crossed a round number.

## Speed

Speed's controls should be present but grouped by task. It does not need the
Read footer or duplicated diagnostic header.

### Persistent tiers

```text
┌────────────────────────────────────────┐
│ [Reader] │ A Study… · 3% · 300 WPM │ ⋯ │
├────────────────────────────────────────┤
│                                        │
│                 Watson,                │
│                    ‾                   │
│                                        │
├────────────────────────────────────────┤
│▓▓▓▓▓●░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ reading progress
│ [⟲ previous] [ ▮▮ PAUSE ] [−][300][+] │ transport
├────────────────────────────────────────┤
│ frame [1] 2 3       rhythm [natural ▾] │ shape
└────────────────────────────────────────┘
```

- **Transport:** previous/next passage, previous/next word, Play/Pause, slower,
  pace, faster. Play/Pause is the visual primary. Double arrows cross the
  complete paused-context boundary without skipping authenticated text; short
  contexts may make that distance as small as one word.
- **Shape:** words at once and rhythm preset. Compact captions such as
  “including rests” and “3 becomes 2 here” remain accessible descriptions and
  polite announcements, not permanent multi-line labels.
- **Tuning:** frame character limit, sentence rest, paragraph rest, length
  emphasis, effective-rest diagnostics, and reset move to a **Speed settings**
  sheet. Opening it pauses and never resumes automatically.

The tuning sheet overlays the stage. The current inline `frame & rhythm`
disclosure expands inside the stage's grid and makes the content smaller while
it is being configured. That coupling should be removed.

The top row has a single **Reader** exit, title, position/pace, and menu. Help
moves into the menu. The analytical dock is absent on mobile and desktop. Its
unlabelled three-pixel collapsed residue is replaced by the dedicated,
semantically stable reading-progress rail.

Transport and shape keep stable reserved heights while Speed is active. Do not
hide the shape row only during playback, which would move the focal stage and
controls. Stage tap, Space, Shift+S, Escape, reduced-motion entry, focus
containment, and exact-token exit keep their shipped behavior.

## Atlas boundary

Atlas is not close reading, so the Read chrome budget should not be imposed on
it mechanically.

- Share the single position model, command definitions, Back behavior, and
  utility-sheet primitives.
- Keep the Atlas ruler, active-text controls, normalization, and analytical
  key as scale-specific instruments.
- Keep the analytical dock in Atlas during this programme. It is removed from
  Read and Speed only.
- A later Atlas-specific evaluation may decide whether its dock duplicates the
  columns, but that should be based on Atlas use rather than mobile prose
  scarcity.

## Fate of the current information and controls

| Element | Mobile Read | Wide Read | Speed |
| --- | --- | --- | --- |
| title | position button, once | right rail, once | top row, once |
| fitted token range | sheet | right rail detail | tuning/status sheet |
| visual reading progress | bar rail | vertical right rail | transport rail |
| cursor token and percent | bar | right rail | top row |
| Read/Atlas | sheet | left rail | not shown |
| settings/help | sheet | left rail | menu/sheet |
| exit/back | persistent first cell | persistent left rail | `Reader` in top row |
| previous/next text | sheet | left rail/list | not shown |
| text ordinal | sheet | right rail | not shown |
| Speed entry | persistent cell + sheet | left rail | not shown |
| previous/next page | bar + blank edge tap + sheet | edge click + rail | not shown |
| previous/next reference | sheet | right rail | not shown |
| Terms/highlight key | sheet | right rail | absent |
| graph/barcode footer | absent; use workbench/Atlas | absent | absent |
| frame/rhythm disclosure | not applicable | not applicable | Speed settings sheet |

## Find and utility surfaces

Reader Find cannot disappear with the dock. `/` should replace the compact
Reader bar with a one-row Find takeover, using the existing Find interaction
and focus behavior. Closing Find restores the bar and exact suspended Reader
state. At wide layout, Find appears adjacent to the left rail or as a compact
overlay without changing prose geometry.

Help, display settings, Reader controls, and Speed settings should reuse the
existing governed utility-layer behavior where possible:

- background Reader content is inert;
- focus moves into the sheet and returns to its trigger;
- Escape closes the sheet before closing Reader;
- opening any utility pauses Speed and closing it does not resume playback;
- the sheet respects visual viewport and safe-area changes; and
- opening or closing it issues no worker query and does not change the fitted
  range.

## Shared product and component model

The consolidation should be semantic, not just a new container.

### `ReaderPositionModel`

Derive title, ordinal, text count, cursor token, token count, percentage, fitted
page range, and progress once from Reader state. The bar, rails, sheet,
progress line, and live status consume the same model. This removes the current
disagreement between `ReaderDrawer` and `ReaderRuler`.

The authenticated ready page owns `docTokenCount`; snapshot-bound corpus
counts are a fallback only. Active-token precedence remains explicit reading
cursor, authenticated source anchor, fitted page, then Reader place. The model
is derived, never persisted.

### `ReaderCommandSet`

Define each command once with its label, shortcut, availability, disabled
reason, and action: exit, page ±, reference ±, text ±, start/end, scale, Speed,
Find, settings, and help. The mobile bar, sheet, desktop rails, and shortcut
help project that command set instead of hand-authoring competing labels.

### Scale-specific presentations

- `ReaderBar` and `ReaderRails` present the same Read commands at different
  widths.
- `ReaderSheet` presents infrequent Read commands and exact detail.
- Atlas retains its own ruler and normalization controls.
- Speed retains its own transport and shape controls but consumes the shared
  position, exit, utility, and command semantics.
- `readerProseTapIntent` owns the pure pointer arbitration contract.

Reader controls and Speed tuning are local `App` utility-pane variants so they
reuse the existing inert background, focus trap, Escape order, focus return,
and Speed-pause behavior. Compact controls are a real grid row so the fitted
prose pane is measured honestly. Wide rails activate from measured available
inline size, not a named viewport breakpoint.

Chrome visibility, rail fit, commands, and progress are derived presentation
state. None enters Zustand, the primary-interaction union, workspace
persistence, URL state, browser history, or reading-position state.

## Delivery sequence

1. **Record the superseding decision.** Once approved, amend
   `product-decisions.md`, `spatial-reader.md`, and `rsvp-reader.md`. Supersede
   the persistent Read ruler and footer requirements for Read, not Atlas.
2. **Fix pointer arbitration.** Add the pure tap-intent decision and prove
   blank-edge page turns, source-token selection near an edge, mark actions,
   native selection, holds, and drags.
3. **Unify position and commands without visual change.** Introduce the shared
   models and prove label/action parity before moving their presentations.
4. **Ship compact/regular Reader bar and sheet.** Remove the resident header,
   ruler, and page/reference rows at those widths. Rebaseline fitted pages.
5. **Re-home Find and remove the dock from Read.** These must land together.
   Preserve Atlas's dock and all Find suspension semantics.
6. **Add wide Reader rails.** Gate on actual available inline size around the
   75ch measure and prove no overlap at zoom.
7. **Consolidate Speed.** Introduce transport/shape tiers and move tuning to a
   sheet without changing timing or source contracts.
8. **Harden viewport and accessibility behavior.** Exercise compact WebKit,
   landscape, safe areas, visual keyboards, 200% zoom, reduced motion, forced
   colors, and pointer/keyboard parity.

No worker protocol or analysis operation should change. Taller fitted panes
will change page boundaries and source-window sizing; benchmark and e2e
baselines must be reviewed as expected product changes, not patched around.

## Acceptance contract

- At 390×844, steady Read has no more than 52 CSS pixels of resident chrome,
  excluding safe areas and conditional error/notices, and prose receives at
  least 75% of viewport height.
- Read and Speed always show the shared active-text progress rail. It follows
  the exact selected/displayed token, remains visible at both endpoints, is
  non-interactive, and adds no independent layout row.
- Title and position each have one visible authority.
- Opening Reader controls, Find, Help, or Settings does not resize/refit the
  prose pane, issue a worker query, or move the reading cursor.
- At 320×800 and 200% zoom, there is no page-level overflow; Back stays visible
  and every visible target remains at least 44×44.
- A stable blank-edge tap turns the page. A stable source-token tap, including
  near an edge, selects the exact token. Marks, native selection, holds, drags,
  and multi-pointer input retain their existing precedence.
- Every keyboard command retains a pointer route through the bar, rails, or
  sheet. No feature relies on hover or an undocumented gesture.
- `/` remains usable in Read after dock removal, and Find close restores the
  exact prior Reader state and focus.
- Read and Speed contain no `WorkbenchDock`. Atlas remains unchanged unless a
  separately scoped Atlas decision says otherwise.
- Speed uses unambiguous Reader-exit and previous-frame labels; opening tuning
  pauses and does not shrink the stage or auto-resume.
- Safe areas, browser zoom, forced colors, reduced motion, and visual viewport
  changes preserve reachable controls and authenticated source text.

Likely browser suites affected include `reader.spec.ts`,
`reader-modes.spec.ts`, `rsvp.spec.ts`, `viewport.spec.ts`, `find.spec.ts`,
`shortcuts.spec.ts`, `position-history.spec.ts`, `footer.spec.ts`,
`guide.spec.ts`, and the Reader performance specs. Footer-metric tests should
retain Atlas/workbench coverage while dropping the obsolete Read contract.

## Risks and rejected alternatives

### Risks

- **Find is coupled to the dock.** Re-home it atomically with Read dock removal.
- **Page fitting changes.** More height means different authenticated page
  ranges; tests must assert invariants rather than old incidental boundaries.
- **Edge-tap discoverability.** The visible sheet fallback is mandatory. A
  short first-use hint may teach edge taps, but the gesture cannot be the only
  route.
- **Analytical context becomes less immediate.** That is intentional in Read;
  the highlight key remains in the sheet, and the full analysis is one Back or
  one Atlas switch away.
- **Wide rails can crowd zoomed layouts.** Activate them only when the prose
  measure and rails actually fit, then fall back to the bar.

### Rejected

- **Simply shrink every current band:** preserves duplicated hierarchy.
- **Auto-hide on scroll or centre tap:** Read does not scroll and centre tap
  already selects a source token.
- **Swipe-only page turns:** conflicts with browser history gestures and lacks
  a dependable accessible equivalent.
- **A collapsible analytical bottom drawer:** keeps Reader responsible for the
  dashboard being removed and adds another gesture.
- **Retaining the analytical dock because it can collapse to three pixels:**
  preserves the wrong component contract. A dedicated three-pixel reading rail
  has one stable meaning and no hidden Terms/graph/barcode behavior.
- **Floating controls over prose:** obscure authenticated text and create
  contrast problems.
- **One identical layout for Read, Atlas, and Speed:** ignores their different
  primary jobs.

## Ratified defaults

The owner accepted these defaults rather than leaving an option matrix:

1. remove the analytical dock from Read and Speed, but keep it in Atlas;
2. preserve a one-tap visible Speed entry in the mobile Read bar;
3. keep previous/next page in the bar, with reference movement in the sheet;
4. show cursor token and percentage persistently, with fitted page range in the
   sheet; and
5. invest in wide desktop rails after the mobile bar and Find migration prove
   the shared model.

At widths of at least 360 CSS pixels the page cells use visible `‹ page` and
`page ›` labels. Below that fit threshold they degrade to arrows with full
accessible names; Back remains labelled and present.
