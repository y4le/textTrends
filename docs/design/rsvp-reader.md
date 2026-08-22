# Semi-hidden RSVP Reader

**STATUS: BASE MODE IMPLEMENTED (2026-08-22); RHYTHM AMENDMENT ACCEPTED,
IMPLEMENTATION PENDING.** This record supersedes the RSVP recommendations in
[interaction-modes-plan.md](interaction-modes-plan.md) where they differ. It
describes the shipped interaction and pacing contract.

The decision was informed by repository inspection, direct inspection of
[Appnull](https://www.appnull.com/), primary-source web research, and an
explicitly pinned Claude Opus research consultation through Parley (request
`req_rsvp_research_001`, artifact
`art_sha256_a436b176d70103db8570da4b5e1fab4d653a7c6307a589f8b6882d1eed2e0efb`),
followed by a pinned Opus design consultation (request
`req_rsvp_design_002`, artifact
`art_sha256_e7704df07238fd40c52143c12c4529002ffb08ffd684d3f0382033b410997983`)
and a targeted window-continuity correction (request
`req_rsvp_design_followup_001`, artifact
`art_sha256_1ea7639e5ac1ca920587717b1c4dd573312cfd6c97cd36a0782c67e76d5c3a84`).
The tweakable rhythm model was decided in a further pinned Opus consultation
(request `req_consult_03af216bd1d38185`, artifact
`art_sha256_0db71c5ff6052266713531ae920071cc06d0ae953c0d58db59eb73585ddb13d8`).

## Outcome

Add RSVP as a semi-hidden presentation mode inside the existing full-screen
Reader. It is not a new browser-history layer. The analytical Reader footer
remains mounted and follows the displayed token.

RSVP is framed as a focus-reading aid with a configurable **set pace**, not as
a promise that comprehension remains unchanged at the displayed WPM. The
mode defaults to one fixed focal word, with an optional two- or three-word
frame and a stable anchor glyph in its first word whose index is left of centre,
deterministic word-length timing, and explicit integration pauses at sentence
and paragraph boundaries.

Do not add Bionic Reading prefixes, randomized pacing, automatic speed ramps,
or a lexical/readability “complexity” score. Bionic prefixes have not shown a
reading-speed benefit in controlled tests and have no useful eye-guidance role
when one word is already fixed at the point of gaze. Appnull's randomized
“chaos mode” is not evidence-backed. Its long-word anchor calculation is a
different product convention. Neither is copied.

## Interaction contract

Entry is deliberately available only while the full Reader is open. `S` and
`W` require the physical Shift modifier (`explicitShift` in the shortcut
registry), matching the existing semi-hidden Debug chord and keeping the
lowercase Vim row unambiguous.

| Input | Ordinary Reader | RSVP Reader |
|---|---|---|
| `S` | Enter RSVP at the Reader's published reading position | Exit to prose at the displayed token |
| `Esc` | Close Reader | Exit to prose at the displayed token |
| `W` | Existing Reader behavior is unchanged | Pause and focus the WPM number input |
| `h` / `←` | Previous prose page | Reduce set pace by 25 WPM |
| `l` / `→` | Next prose page | Increase set pace by 25 WPM |
| `Space` | No Reader command | Pause or resume RSVP |
| pointer outside an RSVP control | Existing Reader behavior | Exit to prose at the displayed token; consume that pointer action |

Lowercase `w` and `b`, PageUp/PageDown, Home/End, and the prose paging commands
are suppressed while RSVP owns the Reader; they never replace its source from
under the live cursor. `/` and Ctrl/Cmd-F are also suppressed until RSVP is
exited and consumed rather than passed to browser Find, so they cannot discard
the suspended interaction. Uppercase `W` avoids
the ordinary lowercase `w` collision. RSVP's handlers run before Reader
handlers. One Escape exits RSVP; if it suspended Find, the next Escape closes
Find and a third closes Reader. Without suspended Find, the second Escape
closes Reader.

Explicit keyboard entry starts playback immediately. If
`prefers-reduced-motion: reduce` matches, entry starts paused instead and
requires an explicit Space or Play activation. Opening the WPM editor pauses;
Enter accepts the bounded value and restores the prior play state. Escape
always exits RSVP, including while the editor is focused. `h`, `l`, Left, and
Right nudge pace while RSVP owns non-editing focus. While the number input is
focused, normal text editing and caret keys take priority; only Enter and
Escape plus the mode-exit `Shift+S` chord have mode-specific meanings.

Document-level Space handling ignores buttons and other editing/control
targets. RSVP controls handle their native Space activation locally and stop
it from reaching the document shortcut, so Play/Pause toggles exactly once
and Slower/Faster perform only their labelled action.

The bounded WPM contract is:

- default: 300 WPM;
- minimum: 100 WPM;
- maximum: 900 WPM; and
- keyboard/button step: 25 WPM.

The shipped WPM preference currently survives subsequent RSVP entries in the
browser tab's session storage. The rhythm amendment migrates a valid v1 WPM
into a strict v2 record in local storage. The resulting rhythm survives browser
sessions on the device and remains a local reading preference, never project,
URL, or history state. The UI calls WPM **set pace** because linguistic pauses
and long-word holds make effective throughput lower.

The active mode is visually unmistakable even though entry is semi-hidden. It
shows the existing Reader title and position idiom, a central focal frame, and
visible 44px Play/Pause, Slower, set-pace, Faster, rhythm-disclosure, and Reader
controls. The shortcuts surface switches to an RSVP-specific context after
entry; the ordinary Reader shortcut list does not advertise the entry chord.

The experimental entry is intentionally keyboard-only in this version. Touch
target sizing applies to the controls available after keyboard entry; it does
not imply a visible Speed read entry action.

Pointer clicks on the focal frame, surrounding stage, header backdrop, or
analytical footer exit RSVP. RSVP's own buttons, fields, labels, and rhythm
disclosure are exempt targets. The exit click is consumed so it cannot also
seek, resize, or close a second surface.

Entry is available only from an authenticated ready Reader source. While the
source is pending or errored, `S` is consumed without entering RSVP; the
Reader's existing loading, retry, or error state remains visible.

## Presentation and pacing

### Fixed anchor

The focal letter uses a deterministic, Spritz-compatible left-of-centre
heuristic over Unicode grapheme clusters in the bare word token:

```text
1 cluster      -> index 0
2–5 clusters   -> index 1
6–9 clusters   -> index 2
10–13 clusters -> index 3
14+ clusters   -> index 4
```

The index never lies beyond the right-middle grapheme and stays left of centre
for longer words. Attached punctuation is displayed but does not move the
anchor. Before/anchor/after spans use symmetric flex space,
`white-space: nowrap`, and visible overflow, so the anchor glyph stays fixed at
the stage guide without measuring proportional text, including for long
words. The before span is right-aligned and the after span left-aligned. The
anchor has both accent color and an underline/guide; color is not its only cue.
Words do not tween, fade, or insert blank frames.

### Timing and rhythm controls

The baseline hold is deterministic:

```text
baseMs = 60,000 / setWpm
lengthWeight = clamp(wordGraphemeCount / 4.7, 0.75, 1.75)
weight = 1 + lengthEmphasis * (lengthWeight - 1)
wordMs = max(60, baseMs * weight)
```

At 100% this is the original length weighting. At 0%, all words receive the
same baseline exposure. There is no lexical or readability “complexity”
control because the browser has no grounded signal for it and adaptive
complexity pacing has not shown a reliable benefit.

Boundary time remains additive and rate-invariant, but the product defaults
are reduced in response to the visibly stuck sentence-final word:

```text
paragraph end ->   +700 ms
sentence end  ->   +350 ms
```

The word remains fully emphasized for `wordMs`, then enters a visibly muted
rest phase for boundary time. The frame is never blank. Rest has no fade or
other transition and is only shown for configured rests of at least 150ms.
This makes the boundary pause read as a pause rather than as extra time needed
to recognize the final word.

A paragraph rest replaces the sentence rest at the same boundary rather than
stacking with it, and the preference model enforces paragraph rest greater
than or equal to sentence rest. Sentence and paragraph boundaries are
index-authored: `sentenceBounds` come from the existing Intl sentence
segmenter and `paragraphBounds` from the indexer's paragraph rules. The RSVP
browser view does not guess either from the displayed punctuation. A
comma/clause pause remains an unbuilt seam because no RSVP experiment in the
reviewed evidence isolates it.

Masson (1983) supports the direction of this feature: a fixed inter-sentence
pause improved RSVP comprehension while keeping word exposure unchanged. The
350ms and 700ms defaults are product choices, not experimentally isolated
values. The Study preset retains the previously shipped 500ms and 900ms rests.

The control model deliberately stays small:

| Control | Default | Range | Step |
|---|---:|---:|---:|
| set pace | 300 WPM | 100–900 | 25 WPM |
| words at once | 1 | 1–3 | 1 |
| sentence rest | 350ms | 0–800ms | 50ms |
| paragraph rest | 700ms | 0–1500ms | 100ms |
| length emphasis | 100% | 0–100% | 25% |

Set pace remains in the primary control row. The other settings live behind a
native **rhythm** disclosure; opening it pauses playback and closing it never
auto-resumes. Changes commit live and affect the next frame after playback
resumes. No new global shortcuts are introduced. Every disclosure control
participates in the RSVP focus trap and keeps its native Space and arrow-key
behavior from reaching the document shortcuts. On compact viewports an
authored three-word setting is presented as two words at once, while the
authored preference is retained for the next wider viewport. Type ramps down
at two and three words so ordinary frames fit; pathological long source tokens
retain the shipped visible-overflow behavior.

Presets change rhythm without moving set pace: **Even** is one word with no
length emphasis or rests; **Natural** is the default row above; **Study** uses
one word, 100% emphasis, 500ms sentence rests, and 900ms paragraph rests. Any
divergence selects **Custom**. Reset is the explicit exception: it restores
Natural and 300 WPM.

### Multi-word frames

Two- and three-word display is a presentation preference, not a speed claim.
A frame starts at the live cursor and takes up to the configured number of
consecutive tokens, stopping before a sentence start, paragraph start, or
served-window boundary. Its display is the authenticated source slice with
internal whitespace collapsed, preserving attached punctuation without
synthetic spaces. Its fixed anchor is always the first member word's ORP
grapheme; later words extend to the right of it.

The frame word time is the sum of the individual member-word times. Its
boundary rest is derived only from its last word and is added once. With rests
zeroed, a token range therefore takes identical total time at one, two, or
three words per frame. The live cursor and exact-token exit position are always
the first token of the displayed frame, and the next cursor advances by the
number of words actually shown. Frames never skip, repeat, or cross a sentence
or paragraph boundary.

## State and source ownership

RSVP extends the store's one-primary-interaction union; it does not add an
independent component mode or an `rsvp` layer. Its snapshot-bound interaction
state owns playing/paused and set pace. It also suspends the exact `none` or
Find interaction it displaced. All presentation and query consumers use one
`findScope(interaction)` derivation to obtain the effective Find state through
that suspended value. Exiting RSVP restores the identical settled interaction,
so entering speed mode cannot silently swap a Find footer, query marks, or
navigation back to durable Terms. A Find seek that is pending at entry is
cancelled and settled to idle before that Find interaction is suspended; its
query and resident analytical state are retained. The canonical
corpus scrub owns the displayed position, while the component owns only its
timer and current index within the authenticated source slice.

`reader-page/1` gains page-relative sentence and paragraph boundary arrays,
projected from the index in the numeric plan and re-projected by
`sliceReaderPage`. RSVP uses the worker's full bounded source slice rather
than running browser prose fitting while prose is absent. Token offsets remain
the authority for the bare word and attached punctuation; source text is never
retokenized in React.

RSVP begins at the Reader's currently published reading position: the fitted
page's first visible token, except that an around-token source retains its
exact anchor. This rule also applies after a backward (`before`) page turn; it
never starts at that source's ending cursor.

A narrow `publishRsvpPosition(liveToken)` store action updates the canonical
scrub position without scheduling the footer's redundant passage query. It is
valid while a continuation source is pending and touches neither
`readerWalk` nor `readerNavigation`. Broadcasts may be throttled for footer
rendering, but pause and exit always flush the live component cursor. Entry
supersedes any ordinary occurrence-navigation request already in flight, and
`publishRsvpPosition` clears stale `occurrenceNavigation` and `matchesReveal`
state without issuing a passage request. A late pre-entry result therefore
cannot call `openReader` or replace RSVP's authenticated source.

On exit, a narrow `exitRsvp(liveToken)` store action restores the suspended
interaction first and then replaces Reader at `{ kind: 'from', token:
liveToken }`. It validates the active RSVP document and corpus token count but
does not depend on a currently ready page, so exiting during a continuation
fetch is exact. Normal browser fitting then resumes with the displayed word at
the start of the prose page.

When a source has less than about three seconds of runway, a narrow
`rsvpSeek(liveToken)` action requests a fresh forward source **from the current
token**, not from the old slice end. The forward-slice token and text caps
guarantee that the new source includes the retained suffix, so it can be
adopted without skipping words while the current frame remains available
during the request, provided continuation uses the same `maxTokens` budget as
the source it replaces. If look-ahead proves troublesome, the same action may be
deferred to exhaustion; a boundary occurs only once per 4,096-token source
budget. At the end of the current document RSVP pauses with an explicit
completed state; crossing into another document remains a deliberate
prose/footer action. RSVP never blanks, repeats a stale word while claiming to
advance, or requires a second worker lane.

Changing tabs or hiding the document pauses playback. Source failure also
pauses and exposes the existing retry path. Neither condition auto-resumes. A
corpus snapshot replacement follows the existing store reset: it ends RSVP
and does not restore interaction state from the replaced snapshot.

On keyboard entry, focus remains inside the Reader and moves to the RSVP
Play/Pause control; exit restores focus to the Reader region. Rapid word
replacement is not exposed through `aria-live` because announcing up to 15
words per second is unusable. Assistive technology instead receives a stable
mode/status label and the labelled pace and playback controls, with an
immediate Return to Reader action providing the non-RSVP reading path.
Keyboard focus is contained within those RSVP controls while the mode is
active; the retained analytical footer remains visible but leaves the tab
order until RSVP exits.

Opening Help, Settings, or Debug from an RSVP keyboard command pauses playback
before the utility pane takes focus and retains RSVP beneath it. Closing the
pane returns to RSVP still paused; playback never resumes merely because the
utility pane closed. These command sites do not exit or overwrite the
suspended Find interaction.

## Delivery and acceptance

The base implementation was divided into five reviewable commits:

1. this research-backed decision record;
2. Reader boundary transport plus a pure RSVP unit/anchor/timing library and
   unit tests;
3. interaction/store state, session preference, the effective-Find derivation,
   and state tests;
4. the isolated full-screen RSVP presentation component, styles, and component
   tests; and
5. shortcut context, Reader/footer integration, and browser acceptance.

The rhythm amendment adds three focused commits:

6. this amended decision record;
7. pure pacing/frame primitives, strict v2 local preference migration, store
   state, and unit tests; and
8. the disclosure controls, responsive multi-word presentation, two-phase
   playback timer, and cross-browser acceptance.

Every staged commit receives an exact Opus review before commit.

Acceptance requires:

- sentence/paragraph bounds survive `reader-page/1` planning, materialization,
  wire transport, and browser slicing;
- NFC/NFD, astral characters, punctuation, and long tokens never split the
  focal grapheme or move the anchor beyond the right-middle grapheme;
- boundary rests are additive and independent of WPM, and configured rests of
  at least 150ms appear as a distinct muted phase after word exposure;
- one-, two-, and three-word frames partition the source without crossing a
  sentence or paragraph boundary, and take identical aggregate word time;
- the first member's anchor stays on the pixel guide for every frame size;
- strict local-storage preference validation, session-storage v1 pace
  migration, presets, compact clamping, and reset behavior are covered;
- `S`, `W`, the WPM nudges, Space, nested Escape, backdrop exit, reduced
  motion, and typing-focus priority are covered;
- Space on a focused RSVP button activates exactly one action, and the WPM
  editor retains ordinary text/caret editing;
- entering RSVP with active Find leaves the footer, graph, marks, and query
  state unchanged through `findScope`, then restores the identical settled
  Find interaction on exit;
- PageUp/PageDown, Home/End, lowercase occurrence navigation, and Find-open
  commands cannot replace the RSVP source;
- an occurrence or Find result already in flight at entry is cancelled or
  settled without moving the live RSVP cursor or replacing its source;
- opening Help, Settings, or Debug pauses RSVP before hiding its controls and
  returns to the mode still paused;
- exiting returns prose and the footer to the exact displayed token;
- per-word position publication changes neither Reader walk history nor
  navigation state and remains valid during a continuation fetch;
- source and document boundaries never show a false advancing state;
- the anchor glyph remains at the same pixel guide across short and long words; and
- the normal Reader's page/occurrence shortcuts and fitted-page behavior do
  not regress.

## Research basis

- [Rayner et al. (2016), *So Much to Read, So Little Time*](https://doi.org/10.1177/1529100615623267): speed and comprehension trade off; RSVP removes useful regressions.
- [Masson (1983), *Conceptual processing of text during skimming and rapid sequential reading*](https://doi.org/10.3758/BF03196973): fixed sentence pauses improve RSVP comprehension without changing word exposure.
- [Rahman & Muter (1999), *Designing an interface to optimize reading with small display windows*](https://pubmed.ncbi.nlm.nih.gov/10354807/): self-pacing, regressions, sentence pauses, and completion meters improve the usable RSVP interface.
- [Benedetto et al. (2015), *Rapid serial visual presentation in reading: The case of Spritz*](https://doi.org/10.1016/j.chb.2014.12.043): Spritz produced worse literal comprehension, no speed advantage, and more visual fatigue than traditional reading.
- [Di Nocera, Ricciardi & Juola (2018), RSVP comprehension by speed](https://doi.org/10.1504/IJHFE.2018.096118): comprehension held at 250–350 WPM in their experiment and declined above that band.
- [O'Regan et al. (1984), convenient fixation location in isolated words](https://doi.org/10.1037/0096-1523.10.2.250): word recognition is best slightly left of center; applying that position to fixed RSVP alignment remains a product extrapolation.
- [Spear et al. (2025), boldface letters and eye movements](https://doi.org/10.3758/s13414-025-03067-w) and [Snell (2024), *No, Bionic Reading does not work*](https://doi.org/10.1016/j.actpsy.2024.104304): Bionic-style initial bolding did not improve reading and could impose costs.
- [W3C, Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) and [Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html): continuously changing content needs an immediate control and motion-sensitive users need an opt-out.
