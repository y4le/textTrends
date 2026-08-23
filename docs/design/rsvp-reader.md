# Semi-hidden RSVP Reader

**STATUS: BASE IMPLEMENTED; STANDALONE/2,000 WPM AMENDMENT DECIDED
(2026-08-22).** This record supersedes the RSVP recommendations in
[interaction-modes-plan.md](interaction-modes-plan.md) where they differ. The
package boundary and 30ms pacing sections specify commits 19–21 below and do
not yet describe the shipped tree.

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
The phrase-aware frame amendment followed a focused product/research review
and a decision pass by the same explicitly pinned Opus planner (request
`req_consult_7a5b33ad6ce0e175`, artifact
`art_sha256_ca674f91e5847e40f6c387304acdfe1cc1d58e0e6e48fc190ff0f9a69605feac`).
The honest-WPM follow-up was hammered out with that pinned Opus planner after
the shipped mode exposed visually collapsed frame joins and slower-than-stated
throughput (request `req_consult_14f52f6a9c7da913`, artifact
`art_sha256_c2f63db45f8913d946d9d089a0e24473d53c4ce47be969da81b1802f39fed3c6`).
The standalone-foundation and 2,000 WPM amendment was then decided with the
same pinned Opus planner (request `req_consult_89a758dc12ea553f`, artifact
`art_sha256_45fb556a3f68f8419da0cf7d1f94be683f2de7859e13fa3664da900cd5353515`).

## Outcome

Add RSVP as a semi-hidden presentation mode inside the existing full-screen
Reader. It is not a new browser-history layer. The analytical Reader footer
remains mounted and follows the displayed token.

RSVP is framed as a focus-reading aid with a configurable **pace**, not as a
promise that comprehension remains unchanged at the displayed WPM. The pace
is an honest scheduled-throughput contract that includes integration rests.
The mode defaults to one fixed focal word, with an optional two- or three-word
frame and a stable anchor glyph in its first word whose index is left of centre,
deterministic word-length timing, and explicit integration rests at sentence
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
| `h` / `←` | Previous prose page | Reduce pace by 25 WPM |
| `l` / `→` | Next prose page | Increase pace by 25 WPM |
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

An explicit **back** control regresses to the previous resident RSVP frame and
pauses. It replays only authenticated text already in the current source
window, never fetches backward, and has no global shortcut. At the resident
window's first frame it is disabled. Regression publishes the new frame start
immediately, so Return to Reader and every other exit remain exact.

The bounded WPM contract is:

- default: 300 WPM;
- minimum: 100 WPM;
- maximum: 2,000 WPM; and
- keyboard/button step: 25 WPM.

The shipped WPM preference currently survives subsequent RSVP entries in the
browser tab's session storage. The rhythm amendment migrates a valid v1 WPM
into a strict v2 record in local storage. The resulting rhythm survives browser
sessions on the device and remains a local reading preference, never project,
URL, or history state. The widened range does not change that record's shape or
invalidate an existing value, so it needs no storage-version migration.

The active mode is visually unmistakable even though entry is semi-hidden. It
shows the existing Reader title and position idiom, a central focal frame, and
visible 44px Back, Play/Pause, Slower, pace, Faster, words-at-once,
rhythm-disclosure, and Reader controls. The shortcuts surface switches to an
RSVP-specific context after entry; the ordinary Reader shortcut list does not
advertise the entry chord.

The experimental entry is intentionally keyboard-only in this version. Touch
target sizing applies to the controls available after keyboard entry; it does
not imply a visible Speed read entry action.

Pointer clicks on the focal frame, surrounding stage, header backdrop, or
analytical footer exit RSVP. RSVP's own buttons, fields, labels, and rhythm
disclosure are exempt targets, as is the paused context strip. The exit click
is consumed so it cannot also seek, resize, or close a second surface.

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
`white-space: pre`, and visible overflow, so the anchor glyph stays fixed at
the stage guide without measuring proportional text, including for long
words. Frame construction collapses every source-whitespace run to one ordinary
space before those spans render; preserving it at the split flex-item join
therefore cannot introduce a newline or double-width gap. The before span is
right-aligned and the after span left-aligned. The anchor has both accent color
and an underline/guide; color is not its only cue. Words do not tween, fade, or
insert blank frames.

### Timing and rhythm controls

Pacing is budgeted over a stable resident **span**: the complete sentence
containing the cursor, clamped to the current source window. The span starts at
the greatest sentence or paragraph bound at or before the cursor, or the
window start when that authored start is not resident. It ends at the least
sentence or paragraph bound after the cursor, or the window end. A
window-truncated span has no synthetic rest.

For a span of `n` words, the scheduled budget is exact:

```text
targetMs = round(n * 60,000 / paceWpm)
weight   = 1 + lengthEmphasis *
                 (clamp(wordGraphemeCount / 4.7, 0.75, 1.75) - 1)
restMs   = min(configuredRestMs, floor(targetMs * 0.25),
               targetMs - n * 30)
wordPool = targetMs - restMs
```

The word pool is distributed proportionally to the length weights with a 30ms
floor per word. Water-filling protects words that reach the floor, then
largest-remainder apportionment produces deterministic integer milliseconds
whose sum equals the pool exactly, with ties broken in token order. At 0%
length emphasis, exposures are equal within the unavoidable one-millisecond
rounding residue. At 100%, the original length weighting remains, but it
redistributes a fixed span budget rather than silently extending it.
The load-bearing 30ms exposure floor derives the maximum pace.

The rest caps establish a deliberate priority: no word drops below 30ms; the
planned span total always matches the displayed pace; and the configured rest
is kept where that budget permits. The 25% cap guarantees that words retain at
least 75% of a span's nominal time, especially for very short sentences. The
absolute floor cap takes over above 1,500 WPM. Because the maximum pace is
derived as `60,000 / 30 = 2,000 WPM`, an impossible span budget is not
reachable. At exactly 2,000 WPM every word receives 30ms, every rest is zero,
and length emphasis has no room to operate. For an eighteen-word sentence with
a configured 350ms rest, the effective rest is 350ms at 300 WPM, 300ms at
900 WPM, 225ms at 1,200 WPM, 180ms at the 1,500 WPM cap crossover, and zero at
2,000 WPM.

Playback advances against the planned deadline rather than re-anchoring every
new frame to a late `setTimeout` callback. At most 25ms of callback lateness is
absorbed by the next word phase, never below 30ms times that frame's word
count; any larger delay is forgiven instead of becoming unbounded pace debt.
Pausing, editing pace or rhythm, seeking, and explicit regression re-anchor the
deadline. This bounded correction addresses ordinary browser timer jitter
without making a word's plan depend on playback history or creating catch-up
bursts. At 2,000 WPM no exposure headroom remains, so bounded catch-up
self-disables rather than cutting a frame below its floor.

A 30ms one-word exposure spans only 1.8 refresh intervals on a 60Hz display.
The scheduled elapsed throughput remains exact, but an individual word may be
painted for one or two refreshes. This physical display limit is why the UI
factually suggests two or three words at once above 1,200 WPM: the same honest
word throughput then produces a longer-lived visual frame. Above 1,500 WPM it
also states that boundary rests may be capped by the 30ms word floor; the
current span continues to disclose its exact effective rest. These are
explanations of the active timing model, not comprehension claims, warnings,
or confirmation gates.

The final frame remains fully emphasized for its planned word time, then
enters a visibly muted rest phase for the effective boundary time. The frame is
never blank. Rest has no fade or other transition and is only shown for
effective rests of at least 150ms. This makes the boundary rest read as a rest
rather than as extra time needed to recognize the final word.

A paragraph rest replaces the sentence rest at the same boundary rather than
stacking with it, and the preference model enforces paragraph rest greater
than or equal to sentence rest. Both configured values are maxima taken from
the enclosing span's time, not additive delays. Sentence and paragraph
boundaries are index-authored: `sentenceBounds` come from the existing Intl sentence
segmenter and `paragraphBounds` from the indexer's paragraph rules. The RSVP
browser view does not guess either from the displayed punctuation. A
comma/clause pause remains an unbuilt seam because no RSVP experiment in the
reviewed evidence isolates it.

Masson (1983) found that a fixed inter-sentence pause improved RSVP
comprehension while keeping word exposure unchanged. The product retains the
integration-rest direction but deliberately diverges from that manipulation:
it holds total span time fixed, so a rest reallocates rather than adds time.
The 350ms and 700ms maxima are product choices, not experimentally isolated
values. The Study preset retains the previously shipped 500ms and 900ms
maxima. When a maximum is capped for the current span, the surface discloses
both the configured and effective values.

The control model deliberately stays small:

| Control | Default | Range | Step |
|---|---:|---:|---:|
| pace | 300 WPM | 100–2,000 | 25 WPM |
| words at once | 1 | 1–3 | 1 |
| sentence rest | 350ms | 0–800ms | 50ms |
| paragraph rest | 700ms | 0–1500ms | 100ms |
| length emphasis | 100% | 0–100% | 25% |

Pace and **words at once** remain in the primary control row. The pace helper
states “words per minute, including rests.” Rest helpers state “at most, taken
from this sentence's time,” so increasing a rest is not presented as extending
the total. Words at once
is a native radio group labelled as an upper bound: phrases may break early at
punctuation or the internal width guard. It is a display preference rather
than part of `RsvpRhythm`; choosing two or three words therefore does not turn
an otherwise Natural rhythm into Custom, and reset does not erase the choice.
On compact viewports an authored three-word setting is presented as two words
at once, while the authored preference is retained for the next wider
viewport. The radio fieldset spans a full compact control row and divides its
three 44px choices evenly; it does not compete with transport or pace controls
for the same two-column row.

The remaining settings live behind a native **rhythm** disclosure; opening it
pauses playback and closing it never auto-resumes. Selections commit
immediately; numeric rest and emphasis edits commit on Enter or blur. Changes
affect the next frame after playback resumes. No new global shortcuts are
introduced. Every control participates in the RSVP focus trap and keeps its
native Space and arrow-key behavior from reaching the document shortcuts.

Presets change rhythm without moving pace or words at once: **Even** has no
length emphasis or rests; **Natural** is the default timing row above; **Study**
uses 100% emphasis, 500ms sentence rests, and 900ms paragraph rests. Any timing
divergence selects **Custom**. Reset restores Natural timing and 300 WPM while
preserving words at once. This regrouping does not change the strict v2 storage
record's keys, ranges, or defaults, so it does not require a storage migration.

### Multi-word frames

Two- and three-word display is a presentation preference, not a speed claim.
A frame starts at the live cursor and greedily takes up to the configured
number of consecutive tokens. Sentence end, paragraph end, served-window end,
and a trailing clause mark are hard stops after their owning word. The closed
clause-mark list is exactly comma (`,`, `、`, `，`), semicolon/colon (`;`, `:`,
`；`, `：`), en/em dash (`–`, `—`), the single-glyph ellipsis (`…`), and closing
brackets (`)`, `]`, `}`, `）`). A trailing punctuation run is a stop when it
contains any listed grapheme, so `said,"` stops on its comma even though the
quote follows it. ASCII dots, full stops, question marks, and exclamation marks
remain exclusively the authored sentence segmenter's responsibility so
abbreviations and `...` are not split. Quotes and all unlisted bracket forms
are not clause marks; quotes frequently close a quotation inside a larger
clause, and the browser does not infer new families beyond the enumerated set.

The configured count is an upper bound. A candidate after the first member is
accepted only when the exact rendered frame, including collapsed internal
whitespace and attached punctuation, remains within a `10 × effective-count`
Unicode-grapheme budget. Effective count is the presented count after the
compact clamp, so authored three-word mode uses a budget of twenty when it is
presented as two. The first word is unconditional, so pathological source
tokens remain whole and retain visible overflow.

Budget admission happens while greedily adding members and therefore precedes
orphan handling. Only when three members were admitted, the third did not end
on a hard stop, and the immediately following word is itself a hard stop does
the builder drop the already-admissible third member. That normally produces
`2 + 2` rather than `3 + 1`; a following frame shortened by its own width
budget may instead produce `2 + 1 + 1`. A budget-shortened frame is never
expanded or rebalanced. The rule performs one look-ahead only. Two-word mode
keeps an unavoidable `2 + 1` rather than merely moving the singleton.

The builder remains stateless in the authenticated page, live start token, and
effective count. Entering mid-sentence and re-entering with the same page and
token therefore reproduce the same forward partition without a whole-sentence
parser. A continuation source can change grouping at the former served-window
edge because window end is a hard stop and new look-ahead becomes available.
The live cursor remains authoritative and the replacement partition starts
from it, so the changed grouping still cannot skip or repeat a token. Frame
display is the exact authenticated source slice with internal whitespace
collapsed, preserving attached punctuation without synthetic spaces.

The fixed anchor remains the first member word's ORP grapheme; later words
extend to its right. The anchor column is authored once per frame size and the
word-row shift is derived from that value, so the visible guide and focal
grapheme cannot drift apart. One-, two-, and three-word columns are
monotonically farther left while the focal x-coordinate stays invariant within
each size. Type continues to ramp down by size; the grapheme budget and type
ramp bound different parts of the layout.

The frame word time is the sum of its members' planned exposures. Its boundary
rest comes from the enclosing span and is emitted only after the final frame.
Because both planning inputs are independent of frame size, a span takes
identical total scheduled time at one, two, or three words per frame, including
rests. The live cursor and exact-token exit position are always the first token
of the displayed frame, and the next cursor advances by the number of words
actually shown. Frames never skip, repeat, or cross a sentence or paragraph
boundary.

### Paused context

Pausing reserves the focal word's position and reveals a static, labelled
context strip containing the enclosing resident sentence. The exact current
frame is highlighted inside an exact source slice; at most forty authenticated
tokens of context are retained on either side, with a plain ellipsis when the
resident sentence or cap truncates the slice. It is never an `aria-live`
region and never appears while playback is running. The strip is focusable and
participates in the RSVP focus trap, giving visual and assistive-technology
users a stable recovery path without a second changing stream or a new fetch.

Back-one-frame derives the prior start by replaying the same pure forward frame
partition from the token after the nearest resident hard stop before the live
cursor, or from the window start when none exists. When a hard stop immediately
precedes the live cursor, the search continues past it to the preceding stop so
regression can cross that boundary; only the resident window's first token has
no prior frame. When mid-sentence entry is not itself a start in the replay,
regression chooses the greatest replayed frame start strictly below the live
cursor. It never invents a reverse grouping algorithm, never leaves the
resident source, pauses before moving, and publishes the regressed cursor
immediately. A dedicated regression key, backward source fetching, context
while playing, and a clause rest remain explicitly deferred.

## Standalone engine boundary

The reusable RSVP domain belongs in a private workspace package named
`@texttrends/rsvp`. Private status is deliberate: a publishable package would
also need compiled output, versioning, licensing, and a release contract. None
is necessary to prove the dependency boundary or to host a second application.
The package has no imports from another workspace package and does not depend
on React, DOM APIs, storage, fetch, workers, or filesystem APIs. Its TypeScript
configuration does not add the DOM library, making part of that boundary
compiler-enforced. It exports pure functions and frozen data; each host owns
playback state and side effects.

The root package surface owns framing, pacing, span planning, paused context,
cursor stepping, continuation decisions, and bounded-deadline helpers. It
accepts two structural source types:

```ts
interface RsvpSource {
  readonly text: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly tokenStartsUtf16: readonly number[];
  readonly tokenEndsUtf16: readonly number[];
  readonly sentenceBounds: readonly number[];
  readonly paragraphBounds: readonly number[];
}

interface RsvpPlaybackSource extends RsvpSource {
  readonly docTokenCount: number;
}
```

Framing does not need to know where a document ends, so `docTokenCount` appears
only in the playback extension. `tokens` are global document indices; the
UTF-16 offsets and unit bounds are local to `text`. The start and end arrays
have `tokens.end - tokens.start` members. Token spans are strictly increasing,
non-overlapping, and satisfy `0 <= start < end <= text.length`. Sentence and
paragraph bounds are ascending, deduplicated local token indices in
`[0, tokenCount]`. Terminal bounds are optional to package consumers; planning
falls back to the source edges when they are absent.

TextTrends' `ReaderPageResultV1` satisfies `RsvpPlaybackSource` structurally.
A compile-time assertion at the web boundary pins that relationship so drift
requires a deliberate adapter rather than a cast. The DOM input id, React
presentation, local preference persistence, source fetching, and windowed
reader integration remain in the web host.

The separate `@texttrends/rsvp/source` subpath owns one convenient standalone
adapter, `createRsvpSource(text, options?)`. It creates a whole-document
`RsvpPlaybackSource` with `Intl.Segmenter`: word-like word segments, sentence
segments mapped onto emitted tokens, and a documented paragraph policy based
on blank-line gaps and Unicode paragraph separators. A paragraph begins after
two line terminators, including CRLF pairs, or one Unicode paragraph separator.
This is deliberately the builder's own policy rather than a claim of parity
with TextTrends' indexer. The builder includes source terminal bounds.
Consumers with another tokenizer or authenticated index construct the
structural source directly; that data boundary is the injection seam, so there
is no speculative segmentation interface or exported validator. The root
surface never imports the source-builder subpath, and TextTrends does not
import it, keeping unused segmentation policy out of the app bundle.

## State and source ownership

RSVP extends the store's one-primary-interaction union; it does not add an
independent component mode or an `rsvp` layer. Its snapshot-bound interaction
state owns playing/paused and pace. It also suspends the exact `none` or
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

The phrase-aware amendment adds five focused commits:

9. this amended decision record;
10. deterministic clause-, width-, and orphan-aware frame primitives plus
    backward-frame derivation and unit tests;
11. separation of the words-at-once display preference from rhythm presets and
    reset semantics without a storage migration;
12. the primary words-at-once control and per-size fixed-anchor presentation;
    and
13. paused sentence context, resident frame regression, and browser acceptance.

The honest-WPM follow-up adds four focused commits:

14. preserve ordinary spaces at the split flex-span join and pin the browser
    whitespace contract;
15. this amended decision record;
16. deterministic resident-span timing plans, exact integer apportionment,
    widened pace validation, and pure-model coverage; and
17. honest pace/rest copy, planned-deadline playback, capped-rest disclosure,
    and cross-browser acceptance.

The standalone-foundation amendment adds four focused commits:

18. this amended decision record;
19. behavior-preserving extraction of the pure engine into
    `@texttrends/rsvp`, including the structural host contract and drift guard;
20. the inert plain-text source builder on `@texttrends/rsvp/source`; and
21. the 30ms exposure floor, derived 2,000 WPM ceiling, factual high-speed
    guidance, and updated unit/browser acceptance.

Every staged commit receives an exact Opus review before commit.

Acceptance requires:

- sentence/paragraph bounds survive `reader-page/1` planning, materialization,
  wire transport, and browser slicing;
- NFC/NFD, astral characters, punctuation, and long tokens never split the
  focal grapheme or move the anchor beyond the right-middle grapheme;
- every resident span's plan totals `round(words * 60,000 / WPM)`, every word
  retains at least 30ms, configured rests are capped at 25% of the span and by
  the word floor, and impossible budgets are excluded by the derived 2,000 WPM
  ceiling;
- effective rests of at least 150ms appear as a distinct muted phase after
  word exposure, while any capped rest discloses configured and effective time;
- one-, two-, and three-word frames partition the source without crossing a
  sentence, paragraph, clause, or served-window boundary, respect the rendered
  grapheme budget and orphan rule, and take identical aggregate span time
  including rests;
- timer jitter correction carries the planned deadline across frames, absorbs
  no more than 25ms without violating the per-frame word floor, and never banks
  unbounded pace debt;
- the engine package typechecks without DOM libraries or other workspace
  dependencies, and `ReaderPageResultV1` remains structurally assignable to
  its playback source contract;
- the plain-text source builder returns exact UTF-16 token slices and sorted,
  deduplicated terminal sentence/paragraph bounds for empty, punctuation-only,
  Unicode, and mixed-line-ending sources;
- at 2,000 WPM every word receives exactly 30ms, rests collapse to zero,
  length emphasis has no residual budget, and timer catch-up cannot reduce an
  exposure;
- the first member's anchor stays on the pixel guide for every frame size;
- strict local-storage preference validation, session-storage v1 pace
  migration, rhythm-only presets, compact clamping, and display-preserving
  reset behavior are covered;
- paused context is an exact resident sentence slice, does not move the focal
  row or update while playing, is pointer-exempt, and is exposed as focusable,
  trapped, stable non-live content;
- back-one-frame pauses, stays within the resident source, follows the forward
  partition across an immediately preceding hard stop to the greatest start
  strictly below the live cursor, is inert only at the window start, and
  preserves exact exit position;
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
- [Masson (1983), *Conceptual processing of text during skimming and rapid sequential reading*](https://doi.org/10.3758/BF03196973): fixed sentence pauses improved RSVP comprehension without changing word exposure; this product adopts the integration-rest direction but instead reallocates a fixed span budget to keep displayed WPM honest.
- [Rahman & Muter (1999), *Designing an interface to optimize reading with small display windows*](https://pubmed.ncbi.nlm.nih.gov/10354807/): self-pacing, regressions, sentence pauses, and completion meters improve the usable RSVP interface.
- [Cocklin et al. (1984), *Factors influencing readability of rapidly presented text segments*](https://doi.org/10.3758/BF03198304): comprehension peaked around twelve-character segments and was better for short idea units than random segments of equal average length; the product uses this as support for bounded, punctuation-shaped frames rather than as a literal modern CSS width.
- [Benedetto et al. (2015), *Rapid serial visual presentation in reading: The case of Spritz*](https://doi.org/10.1016/j.chb.2014.12.043): Spritz produced worse literal comprehension, no speed advantage, and more visual fatigue than traditional reading.
- [Di Nocera, Ricciardi & Juola (2018), RSVP comprehension by speed](https://doi.org/10.1504/IJHFE.2018.096118): comprehension held at 250–350 WPM in their experiment and declined above that band.
- [O'Regan et al. (1984), convenient fixation location in isolated words](https://doi.org/10.1037/0096-1523.10.2.250): word recognition is best slightly left of center; applying that position to fixed RSVP alignment remains a product extrapolation.
- [Spear et al. (2025), boldface letters and eye movements](https://doi.org/10.3758/s13414-025-03067-w) and [Snell (2024), *No, Bionic Reading does not work*](https://doi.org/10.1016/j.actpsy.2024.104304): Bionic-style initial bolding did not improve reading and could impose costs.
- [W3C, Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) and [Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html): continuously changing content needs an immediate control and motion-sensitive users need an opt-out.
