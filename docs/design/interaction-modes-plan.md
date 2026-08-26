# Interaction modes, reading navigation, and diagnostics — proposal

**STATUS: PROPOSAL (2026-08-17).** This document ranks and scopes a candidate
interaction backlog. It is not a claim about shipped behavior and does not yet
supersede the implemented rules in [workbench-ux.md](workbench-ux.md).

The proposal was informed by repository inspection, RSVP reading research, and
an explicitly pinned Claude Opus planning consultation through Parley (request
`req_consult_408c65794ca0905b`, artifact
`art_sha256_d518a6c0da53f4970a3ccafda60795344677e168163aee8f55bc65662c9e65a9`).

## Outcome

Build one explicit, visible interaction-mode model before adding corpus find,
normal-mode commands, or persistent RSVP reading. Every mode must have
equivalent keyboard, precise-pointer, and touch/coarse-pointer entry and exit
paths. Touch access must use visible 44 CSS-pixel controls; double-tap,
multi-touch, and press-hold gestures may supplement those controls but must
never be the only way to reach an action.

The recommended sequence is:

1. shared mode state, indicator, focus, and Escape/close contract;
2. corpus find and cursor freeze;
3. transient RSVP presentation on the existing mouse shuttle;
4. debug/recovery surface;
5. colon command registry and one-shot demo links;
6. recent-position breadcrumbs;
7. persistent RSVP with look-ahead and editable WPM; and
8. optional ORP and pacing experiments.

Moving every ordinary demo out of Inputs and lexical “complexity” pacing are
not recommended in their current form.

## Current constraints

### The current product deliberately has no persistent keyboard mode

The implemented UX says that Vim and conventional bindings are simultaneous,
that there is no mode to remember, and that two-key prefixes expire. Find,
colon commands, and latched speed reading deliberately change that contract.
They therefore require an owner decision in [product-decisions.md](product-decisions.md)
before implementation and one shared state model rather than independent
component booleans.

### The requested keys collide with shipped reading commands

The collisions are contextual rather than reasons to discard the proposal:

| Requested input | Shipped meaning |
|---|---|
| `S` | Start a keyboard linked range in Trends |
| `W` / `w` | Go to the next occurrence from the reading footer |
| `h` / `l`, Left / Right | Move through rendered source pages or local controls |
| Space | Toggle the focused term; native activation on buttons |
| `Ctrl-F` | Currently left to the browser because root shortcuts reject Ctrl chords |

An active mode may own otherwise-colliding keys, but native text entry and a
focused local control remain authoritative. The recommended unresolved `S`
rule is:

- a focused Trends scrubber keeps `S` for range selection;
- a focused reading footer or an unfocused workbench may use `S` for speed;
- `:speed` and the visible touch action work everywhere; and
- if the owner requires global `S` even on Trends, range start must receive a
  new documented binding rather than depending on event-order accidents.

Inside speed mode, Space means pause/resume: this is the speed-mode form of
freezing the current reading position. Outside speed mode, Space pins/unpins
the cursor against ambient movement, subject to the focus rules below.

### The existing footer already owns the transient playback engine

The mouse footer shuttle already converts horizontal displacement into a
bounded token rate, advances a fractional corpus position across declared book
order, caps long background frames, updates the truthful shared cursor, and
stops on pointer-up. The first RSVP slice should reuse that traversal and swap
only the passage presentation while the shuttle is active.

The source passage is a bounded `reader-page/1` window. A held mouse gesture is
brief, but a latched player may run through many windows. Persistent playback
therefore needs proactive look-ahead and an explicit pause when authenticated
source is not ready. It must never repeat a stale word while claiming that
playback continues.

### Breadcrumb recording must not debounce source delivery

Pointer sampling is already animation-frame-coalesced and passage delivery is
single-flight/latest-pending. A second trailing debounce previously added
latency without a meaningful work bound and was removed.

Breadcrumbs need origin-aware recording instead:

- **discrete jump:** immediately push the prior and destination positions;
- **continuous motion:** update one pending destination and settle it at
  pointer-up, scroll idle, shuttle pause, or a short breadcrumb-only idle
  timer; and
- **passive hover:** replace one pending hover destination and record at most
  one settled position.

This classifier changes only navigation-history recording. It must not delay
the cursor, source passage, Matches window, or analysis requests.

## Shared interaction state

One primary mode is active at a time:

```text
none
find(query, direction, status)
command(input, suggestions)
speed(origin, playing, wpm, pacing)
range-capture(origin?, head?)
```

`cursorPinned` is orthogonal rather than a primary mode. Debug and settings are
utility panes, not browser-history layers, but opening either pauses speed and
cancels unfinished find/command/range input. Playback never resumes merely
because a pane closes; resumption is an explicit action.

Every primary mode supplies:

- one visible, textual indicator, never color alone;
- a stable accessible name and polite status announcements;
- a visible close or cancel action;
- Escape as the keyboard equivalent of that action;
- focus restoration to the invoking control;
- deterministic behavior on route, Reader, corpus, and snapshot changes; and
- a safe `pointercancel`, visibility-change, and component-unmount path.

Mode priority is:

1. native editing and interactive-control semantics;
2. the active mode;
3. the focused surface's local commands;
4. global workbench commands; and
5. native page scrolling.

No handler may infer priority from whichever React or document listener happens
to run first.

## Cross-input control matrix

| Capability | Keyboard | Precise pointer | Touch/coarse pointer | Active surface |
|---|---|---|---|---|
| Find | `/`, `Ctrl/Cmd-F`, or `:find` | **Find** in Help/Tools | **Find** in Help/Tools | Terms-rail takeover with query, result/edge status, Previous, Next, Close |
| Command line | `:` | **Commands** in Help/Tools | **Commands** in Help/Tools | Text input, suggestions, Run, Close |
| Transient speed | Mouse path is not keyboard-relevant | Press-drag the footer graph; release pauses/exits | No hidden equivalent; use the visible persistent entry | Fixed-focal word plus approximate effective rate |
| Persistent speed | `S` or `:speed` subject to the local `S` rule | **Speed read** in Help/Tools or the footer status | **Speed read** in Help/Tools or the footer status | Word, Play/Pause, slower, WPM, faster, seek, Close |
| Edit WPM | `W`, then numeric entry; `h`/`l` and arrows nudge only while speed owns focus | Click WPM or slower/faster | Tap WPM for numeric input or use 44px slower/faster buttons | Set pace and effective pace are distinguishable |
| Freeze cursor | Space outside native controls | Click the footer pin/lock action | Tap the 44px footer pin/lock action | Persistent `position pinned` indicator and Unpin |
| Recent positions | Visible Back/Forward controls; shortcut deferred | Click a breadcrumb or recent-position menu | Tap 44px Back/Forward or a recent-position row | Book, position, origin, and current marker |
| Debug | `Shift+D` | **Debug** action in Help | **Debug** action in Help | Full utility pane with Copy and recovery actions |
| Linked range from footer graph | Double-click clears; second-click-hold-drag replaces | Same | Enter visible **Select range**, then one-finger drag or anchor/end taps | Anchor/head, Cancel, Commit |

The Help/Shortcuts pane becomes the universal discovery surface. Add a
**Tools** section with real buttons for Find, Commands, Speed read, Pin
position, and Debug. Keyboard labels remain present beside those buttons. The
same actions remain available to mouse users; capability detection changes
layout and target size, never whether an action exists.

## Find mode

### MVP semantics

Find is a temporary, snapshot-bound corpus term used for seeking and analysis.
It does not enter or mutate the durable notebook. While active, it owns the
interactive comparison and barcode with one transient identity. Opening the
composer immediately leaves durable trend lines and barcode rows visible as
dimmed, non-interactive context. After submission, a wider, haloed Find line
and full-height Find barcode paint above them. Only the transient identity is
hit-testable. Ghosts and Find share one y-scale, so the graph holds until its
non-failed contributors settle; hover values stay Find-only and the accessible
name distinguishes the Find subject from its de-emphasized context.

- Use the same tokenizer, folding, phrase, exact-match, and overlap contracts
  as an ordinary term group.
- MVP accepts the same comma-authored alias list as the Terms editor. Each
  alias may be a token, tokenizer-recognized phrase, or existing one-ended
  wildcard, and the aliases match as OR alternatives within one temporary
  term identity. It is not arbitrary substring search, a regular expression,
  or browser DOM find.
- `/`, `Ctrl/Cmd-F`, the `find` command, and the visible Find action open the
  same composer.
- Enter seeks forward; `n` and `Ctrl/Cmd-G` seek forward; `p` and
  `Ctrl/Cmd-Shift-G` seek backward.
- Escape clears the temporary term, its status, and any transient marks.
- Save promotes the submitted alias group through the durable Terms authoring
  path. It is disabled until submission and whenever either the active-analysis
  or saved-notebook capacity is full.
- A hit updates the shared cursor as a discrete jump and may open/reposition
  Reader only when that is already the active reading surface.
- The submitted identity is the only active series in the barcode and totals,
  Reader marks, Matches, and navigation until exit. Main and footer trend-line
  and barcode surfaces retain durable terms as deemphasized visual context.
- An edge/no-hit result remains explicit. Once the exact match window for a hit
  lands, wider layouts show its one-based position and total as `x/y`; compact
  layouts show a bounded percentage while retaining exact progress in the
  action's accessible name and live status. Progress stays hidden while seeking
  so retained windows cannot mislabel a newer hit. Activating that
  current-result explainer opens Reader at the hit.

The existing worker query accepts an arbitrary `KwicTrack`, so seeking can
reuse the occurrence cache and `occurrence-step/1`. Find uses separate transient
seek, trend, and dispersion lanes so late results cannot commit after the query
changes. Term-aware source requests use the same temporary track without
mutating `series`, notebook identity, or the resident durable analysis maps;
only the explicit Save action crosses that boundary through normal Terms admission.

### Touch behavior

Touch opens Find from Help/Tools. In both the workbench and Reader, compact Find
owns the retained Terms rail: the query field fills that row and a temporary
44px controls row opens above it. Before submission the controls are Find and
Clear and close. A current submitted draft exposes Previous, Next, Save, and
Clear and close; once a result is ready it also exposes the fixed-width
result-progress action. Editing the draft returns to Find and Clear and close
until it is submitted again. The visible progress uses a bounded percentage,
while its accessible name and live status retain the exact match and total.
After submission, the Previous, Next, and Clear-and-close glyphs share one size
and target style. Repeated navigation does not require reopening the keyboard,
and no swipe gesture is required.

## Speed reading mode

### Product framing

Call this **RSVP** or **focus reading**, not proof that a displayed WPM was read
with equivalent comprehension. [Appnull](https://appnull.com/) is a useful
interaction reference for a fixed focal point, visible WPM/progress, pause,
rewind, and jump controls, but its randomized “chaos” pacing is not a model to
copy.

Research supports treating regressions, self-pacing, sentence pauses, and
progress as first-class controls. High-rate RSVP and Spritz-like presentation
can reduce literal comprehension and may increase visual fatigue:

- [Modern Speed-Reading Apps Do Not Foster Reading Comprehension](https://pubmed.ncbi.nlm.nih.gov/29461715/)
- [Rapid serial visual presentation in reading: The case of Spritz](https://www.sciencedirect.com/science/article/pii/S0747563214007663)
- [Designing an interface to optimize reading with small display windows](https://pubmed.ncbi.nlm.nih.gov/10354807/)
- [Optimal viewing position in printed words](https://doi.org/10.3758/BF03209148)

### Delivery slices

1. **Transient presentation:** while the existing mouse shuttle runs, render
   one current token at a fixed focal location and show approximate effective
   WPM. Pointer-up pauses at the exact displayed token and exits transient mode.
2. **Pacing fundamentals:** add sentence/paragraph and lighter punctuation
   pauses, immediate pause/resume, one-token and short rewind, and visible
   progress. Label configured WPM as a set pace when pauses make effective WPM
   lower.
3. **Persistent playback:** `S`, `:speed`, or the visible action latches speed
   at the current position. `S`, Escape, Close, opening another pane, corpus
   replacement, source failure, or end-of-corpus exits or pauses according to
   the visible state. Look ahead before crossing source-window margins.
4. **WPM editing:** `W` focuses bounded numeric entry. While speed mode—not
   ordinary reading—owns focus, `h`/`l` and Left/Right nudge WPM. Slower/Faster
   buttons provide the touch equivalent.
5. **Optional ORP:** align and highlight one focal letter using a documented,
   deterministic heuristic. Keep it toggleable and test proportional fonts,
   punctuation, combining marks, emoji, and non-Latin scripts before claiming
   broad language support.
6. **Experimental pacing:** simple documented length adjustment may be tested,
   but lexical-frequency or “complexity” scoring waits for a named multilingual
   method and comprehension evidence. Never randomize rate while displaying a
   stable WPM label.

### Touch behavior

Touch does not imitate the mouse press-drag shuttle. The existing touch footer
contract—tap to jump and horizontal drag to scrub the absolute corpus axis—stays
intact.

Tapping **Speed read** enters persistent speed mode **paused** at the current
cursor, or at the first available token when no cursor exists. This prevents a
rapid visual sequence from beginning as a side effect of opening a control and
is mandatory when reduced motion is requested.

The active passage exposes:

- one large token/focal word; tapping it toggles Play/Pause;
- 44px Play/Pause and Close buttons;
- 44px Slower and Faster buttons;
- a tappable WPM value that opens bounded numeric entry;
- short rewind and forward controls; and
- the existing footer strip for explicit seek.

Seeking while speed mode is active pauses first, updates the cursor directly,
and leaves the mode paused at the released position. The user explicitly
resumes. Backgrounding the page, losing authenticated source, or receiving
`pointercancel` also pauses. There is no automatic resume after any of these
events.

## Cursor freeze

“Freeze current selection” is interpreted as pinning the transient reading
cursor, not protecting the linked analytical range. A committed linked range
already persists until explicitly replaced, cleared, or invalidated by a new
snapshot.

Pinning gates ambient sources:

- precise-pointer hover after its dwell; and
- logical cursor publication caused solely by Matches scrolling.

Pinning does not block deliberate navigation:

- footer or Trends taps and drags;
- keyboard movement;
- find and occurrence next/previous;
- barcode or row activation;
- breadcrumb selection; or
- Reader navigation.

A deliberate navigation updates the pinned position and leaves it pinned.
Space toggles pinning only when a native control or text input has not claimed
Space. Touch uses the visible footer pin/lock control. The indicator always
names the state; it is not a color-only lock icon.

## Recent-position breadcrumbs

Breadcrumbs are a bounded, session-only history separate from browser Back and
the governed Reader/row-detail layer stack. They are discarded on snapshot
replacement and are not added to the durable workspace.

Each entry contains only:

- snapshot, document, and token position;
- a readable book title paired with stable document identity;
- an origin category such as find, occurrence, barcode, Reader, explicit seek,
  or settled continuous motion; and
- enough ordering metadata for a capped back/forward cursor.

Do not store source snippets unless a later privacy and invalidation design
requires them. Consecutive positions within a small token tolerance may replace
one another when they share the same continuous origin. A discrete jump always
creates a boundary even when the distance is small.

Touch exposes 44px Back/Forward actions and a tappable recent-position list.
Selecting an entry is itself a discrete jump but must truncate or advance the
existing cursor in the conventional history manner rather than recursively
adding duplicate entries.

## Footer graph range gesture

The footer currently assigns double-click to opening Reader and mouse drag to
the shuttle. The phrase “graph only, not barcode or text” therefore describes a
new footer gesture, not the already-shipped Trends range drag.

Recommended precise-pointer contract:

- passage-text double-click remains native text selection and never starts an
  application action;
- barcode double-click retains the captured Reader target;
- graph double-click without movement clears the linked range;
- the held second press of a graph double-click followed by movement replaces
  the range; and
- single press-drag remains the shuttle/RSVP path.

Implement a pointer-state guard before the gesture so a synthesized `dblclick`
after a completed drag cannot clear the range that drag just committed.

Touch must not depend on double-tap timing and must not repurpose the existing
multi-touch-cancels-footer rule. A visible **Select range** action enters a
one-shot range-capture mode. In that mode, one-finger horizontal drag on the
graph previews a range; alternatively, one tap sets an anchor and a second tap
sets the endpoint. Commit and Cancel remain visible. Barcode and passage taps
retain their normal behavior outside that explicitly indicated mode.

## Colon commands

`:` opens a bounded command composer; the visible **Commands** action opens the
same composer without requiring a hardware keyboard. It is a utility pane, not
a browser-history layer and not an arbitrary scripting console.

The initial allowlisted registry should be small:

```text
find <term-or-phrase>
speed
wpm <bounded-number>
debug
demo <allowlisted-slug>
place <inputs|trends|matches|vocabulary|compare>
```

Commands that lead to destructive actions open the same confirmation UI as
their visible counterpart; text entry alone never confirms deletion. Touch
shows actionable suggestions below the input so the command system also works
as a discoverable palette.

## Debug menu and demo loading

`Shift+D` and the visible Debug action in Help open one utility pane. A
shipped debug pane follows the trace privacy rule: metadata only, never source
text, query surfaces, result arrays, KWIC rows, Reader passages, or imported
bytes.

### Production essentials

- build/commit identity;
- generation and snapshot identity, ready/missing documents, and per-document
  token counts;
- extraction recipe, index recipe, and segmenter identities;
- a row for every analysis lane with pending/ready/error state and last error;
- worker health and restart count;
- local-library file count and total bytes;
- `navigator.storage.estimate()` usage/quota;
- artifact persistence versus in-memory fallback and the last storage warning;
- database names/versions;
- width class, coarse-pointer availability, current event pointer class, color
  scheme, and reduced-motion state; and
- a **Copy diagnostics** action that emits a sanitized JSON record.

Production recovery actions are:

- retry analysis;
- retry workspace save;
- restart the worker;
- clear the disposable artifact cache;
- full reset with destructive confirmation; and
- load an allowlisted demo additively.

Clearing the artifact cache preserves the `texttrends-library` database and
current workspace, closes the worker-held artifact connection, deletes only
the disposable artifact database, and reloads into an honest cold rebuild.

Full reset explains that imported source bytes, the active corpus, notebook,
workspace settings, artifact cache, and relevant session storage will be lost.
It requires an explicit second confirmation, coordinates open tabs/connections,
deletes both application databases, clears owned session-storage keys, and
reloads into the empty workspace. Cache clear and full reset must never share a
single ambiguous “clear” button.

### Development-only diagnostics

Keep these behind the existing dev/E2E compile-time seam:

- protocol trace and dropped-event count;
- render-commit counters and per-operation timing;
- cache hit/miss/eviction counters and cap headroom;
- worker, cache, extraction, and `versionchange` fault injection; and
- synthetic/stress corpus loaders.

### Demo policy

The debug menu may expose the same additive demo loader, plus development-only
synthetic fixtures. Keep the ordinary public Sherlock sample discoverable in
Inputs as a secondary empty-state onboarding path; the shipped Inputs design
still treats its texts as ordinary local acquisition. If the owner chooses to
move it, update [inputs-workspace.md](inputs-workspace.md),
[workbench-ux.md](workbench-ux.md), and [current-roadmap.md](current-roadmap.md)
in the same decision series.

`?demo=<slug>` is different from an explicit menu action:

- it is an owned, allowlisted, one-shot boot parameter;
- it is consumed and removed with `replaceState` before ordinary route writes;
- unknown or unavailable slugs produce a notice and are still removed;
- it claims the shared library-operation lease;
- it clears the active corpus and notebook, **not saved local-library bytes**,
  before adding the preset, including when the current workspace is nonempty;
- it does not run again on reload, Back, or place navigation.

Public deployments must use a rights-aware build allowlist. The repository
currently documents LOTR and ASOIF as private corpora; a URL route must not make
an excluded asset discoverable or imply that it is licensed for a public build.

## Ranked backlog

Effort includes implementation, unit/browser regression coverage,
accessibility, touch, and hybrid-pointer behavior. Effort 1 is hours; 5 is a
multi-week architectural change. Value and ROI range from 1 (low) to 5 (high).

| Rank | Deliverable | Effort | Value | ROI | Notes |
|---:|---|:---:|:---:|:---:|---|
| 1 | Shared mode model + visible/touch indicator | 2 | 4 | 5 | Cross-cutting prerequisite |
| 2 | Exact temporary corpus find | 3 | 5 | 5 | Reuses occurrence-step and matcher |
| 3 | Space/visible-control cursor freeze | 2 | 4 | 5 | Gate ambient sources only |
| 4 | Transient RSVP on the existing mouse shuttle | 3 | 4 | 4 | Traversal already ships |
| 5 | Sentence/punctuation pauses + regression controls | +2 | 4 | 5 | Strongest RSVP enhancement |
| 6 | Debug shell, essentials, and copy report | 3 | 4 | 4 | Makes later work diagnosable |
| 7 | Colon registry and touch command palette | 3 | 4 | 4 | Valuable when commands are specified |
| 8 | Clear artifact cache | 3 | 4 | 4 | Needs worker close/reload handshake |
| 9 | Full reset | +2 | 4 | 4 | Strong destructive confirmation |
| 10 | One-shot URL demo loading | 3 | 4 | 4 | Consume, strip, lease, allowlist |
| 11 | Session breadcrumbs with jump classifier | 3 | 4 | 4 | Separate from browser Back |
| 12 | Footer graph clear/second-drag range gesture | 3 | 3 | 3 | Mouse gesture arbitration; visible touch mode |
| 13 | Persistent RSVP latch and WPM editing | 4 | 3 | 2 | Needs window look-ahead |
| 14 | ORP centering/highlight | +2 | 2–3 | 2–3 | Optional, documented heuristic |
| 15 | Lexical complexity pacing | +4 | 2 | 1 | Defer pending method/evidence |
| 16 | Remove all real demos from Inputs | 2 | 1 | 1 | Not recommended as stated |

## Delivery plan

### Phase 0 — ratify semantics

- Record the persistent-mode exception to the current no-mode rule.
- Confirm that freeze means the cursor, not the linked range.
- Resolve the local Trends `S` versus global speed `S` rule.
- Confirm that find means tokenizer-aware temporary term/phrase seeking.
- Confirm the footer graph/barcode/text double-click split.
- Confirm the nonempty-workspace safety rule for URL demo replacement.

### Phase 1 — shared state and navigation

- Implement the primary mode state machine and orthogonal cursor pin.
- Add the mode indicator and Help/Tools touch entries.
- Ship find and its touch result controls.
- Add origin-aware cursor movement and breadcrumb recording seams without yet
  rendering a breadcrumb list.

### Phase 2 — reading interaction

- Add the graph drag's transient fixed-focal RSVP rendering and approximate
  effective WPM.
- Add pause, regression, progress, and documented punctuation pauses.
- Add cursor pinning at hover and Matches-scroll sources.
- Add the footer graph double-click guard and deliberate touch range-capture
  control.

### Phase 3 — diagnostics and recovery

- Ship the debug pane and sanitized copy report.
- Add full reset.
- Add artifact-cache close/delete/reload.
- Keep fault injection and raw traces behind the dev/E2E build seam.

### Phase 4 — command and demo entry

- Ship the allowlisted colon registry and touch suggestions.
- Extract demo acquisition from `ProjectPanel` into the shared library lane.
- Add additive debug loading and one-shot, rights-aware URL loading.

### Phase 5 — persistent reading and memory

- Add RSVP source-window look-ahead, persistent latch, and WPM editing.
- Render the capped breadcrumb back/forward controls and recent-position list.
- Evaluate ORP and simple pacing variants behind explicit settings.

## Acceptance signals

Every implemented phase must demonstrate:

- keyboard, mouse/pen, touch-only, and hybrid-pointer entry and exit;
- no action available only through hover, double-click, double-tap, multi-touch,
  or long-press;
- 44px compact/coarse targets at 320px and 390px widths, except page and
  local-header chrome may interpolate to the documented 32px floor in a short
  viewport;
- native text entry, button activation, text selection, and page scrolling
  remain available outside an explicitly indicated mode;
- mode precedence does not depend on bubbling order;
- Escape and visible Close produce the same state and restore focus;
- snapshot/corpus replacement clears stale find, range, breadcrumb, and speed
  identities;
- backgrounding, source failure, reduced motion, and `pointercancel` cannot
  leave speed claiming to play;
- continuous scrolling/scrubbing does not flood breadcrumbs or delay reading;
- cache clear preserves library bytes and workspace state;
- full reset names and confirms every class of local data it removes;
- copied diagnostics contain no source, query, or result content;
- unknown demo parameters are harmless, one-shot, and removed; and
- touch behavior is covered in WebKit compact tests as well as Chromium's
  synthetic multi-touch paths.

## Decisions still required

1. Does global `S` replace the Trends range binding, or does the focused Trends
   surface retain local precedence?
2. Should ORP ship at all, or remain an experiment after the fixed-center RSVP
   slice is measured?
