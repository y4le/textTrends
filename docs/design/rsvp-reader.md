# Speed reader

Speed presents authenticated Read text as paced word frames. The private
`@texttrends/rsvp` package owns pure framing, pacing, source adaptation, and
playback planning; the web host owns effects and Reader integration. A reusable
domain is already available without an independent package-release process.

[Reader](spatial-reader.md) owns chrome and source navigation.
[Workbench reference](../reference.md#speed) owns control ranges and defaults.
Speed is a focus-reading aid; pace is scheduled throughput including rests,
not a comprehension guarantee.

## Interaction and state

Entry requires an authenticated ready Read source, never Atlas or a pending
page. Visible Speed enters paused; Shift+S enters playing unless reduced motion
requests paused entry. Start precedence is explicit selected token, authenticated
source anchor, then fitted-page start. Space or a stable primary stage tap
toggles once. Holds, drags, nested controls, background taps, and cancelled or
secondary pointers do not toggle or exit.

Return to Reader, Escape, and Shift+S exit at the displayed frame's first token.
The store's primary-interaction union owns Speed and suspends the settled
`none` or Find interaction it replaced. All query/presentation consumers obtain
Find through `findScope`; exit restores that same interaction. Pending Find
seeks settle to idle before suspension. Escape unwinds Speed, then restored
Find if present, then Reader through their respective owners.

Prose paging, Home/End, lowercase occurrence navigation, and Find-open commands
cannot replace Speed's source. Shift+W pauses and focuses the pace input.
Enter accepts a valid pace and restores its prior playing state; Escape exits.
Native text/caret and button behavior wins over global nudges and Space.

Single arrows move one word. Double arrows page across the authenticated
paused-context span, landing at the first unseen token with no source skipped.
Passage reversal retraces a bounded uninterrupted passage history; word moves,
playback, or direct seeking starts a new chain. Navigation pauses and publishes
the destination immediately, using ordinary bounded source fetch when needed.
The pure previous-frame helper remains a package capability, not the meaning
of the visible Previous word control.

Read/Speed have no analytical dock. Speed's transport, pace, frame count, and
rhythm preset keep stable reserved space. Advanced frame/rhythm tuning overlays
the stage. Utility entry, hidden document, or source failure pauses and never
auto-resumes. Source failure retains retry; document end pauses with a completed
state rather than crossing to another text. Corpus replacement invalidates the
snapshot-bound mode.

Device-local pacing uses only the exact current `texttrends/rsvp-rhythm/3`
record with bounded integer fields. Unsupported records are ignored as a whole;
there is no compatibility translator or clamping of malformed stored values.
Rhythm presets do not change frame preferences; reset preserves them.

## Framing

The fixed anchor is a product heuristic over bare-word Unicode graphemes:

| Grapheme count | Anchor index |
| --- | ---: |
| 1 | 0 |
| 2–5 | 1 |
| 6–9 | 2 |
| 10–13 | 3 |
| 14+ | 4 |

Attached punctuation does not move it. Before/anchor/after spans preserve one
collapsed source-whitespace space at flex joins. The anchor has a guide and
underline as well as color. Its x-position is fixed within each frame size;
larger frames place it farther left. There is no tween, fade, or blank frame.

Frames greedily take up to the effective word count and rendered-grapheme
ceiling, including spaces and punctuation. The first word always stays whole.
Sentence, paragraph, served-window end, or a trailing clause mark stops a frame
after its owning word. Clause marks are exactly comma (`, 、 ，`), semicolon
and colon (`; : ； ：`), en/em dash, `…`, and closing brackets (`) ] } ）`).
Any listed grapheme in the trailing punctuation run qualifies. ASCII dots,
full stops, question/exclamation marks remain the authored sentence segmenter's
responsibility; the browser does not invent extra punctuation families.

Only after three members are admitted, if the third is not a hard stop and the
next word is, the builder drops that third member. This avoids an unnecessary
`3+1` when `2+2` fits. Character-limit-shortened frames are never expanded or
rebalanced; two-word mode keeps an unavoidable `2+1`.

Framing is stateless in authenticated source, start token, effective count, and
character limit. A continuation may change grouping at a formerly truncated
window edge, but restarts at the live token and cannot skip/repeat source.
The exact source slice supplies text and attached punctuation, with whitespace
collapsed only for display. Compact presentation limits three words to two
without changing the authored count or character limit. At 320px, a long frame
may clip at the Reader pane edge but never wraps, splits its first word in
frame data, or creates page-level overflow.

Paused context is the enclosing resident sentence, capped to forty tokens per
side with explicit truncation. It highlights the frame in exact source, retains
the focal position, is focusable, and is not live content. It disappears during
playback. The prior-frame helper replays the same forward partition from the
previous hard stop/window start and chooses the greatest frame start below
the live cursor; it does not invent reverse grouping.

## Timing

The planning span is the complete sentence containing the cursor, clamped to
the resident source and paragraph bounds. Boundaries come from the index;
React does not infer them from displayed punctuation. A window-truncated span
has no synthetic rest. For `n` words:

```text
targetMs = round(n × 60,000 / paceWpm)
weight   = 1 + (lengthEmphasis / 100) × (clamp(graphemes/4.7, 0.75, 1.75) − 1)
restMs   = min(configuredRestMs, floor(targetMs × 0.25), targetMs − n × 30)
wordPool = targetMs − restMs
```

`lengthEmphasis` is the stored percentage (0–100). Water-filling distributes the
pool by length weights with a 30ms floor per word. Largest-remainder
apportionment gives deterministic integer milliseconds,
with token-order ties, summing exactly to the pool. At zero length emphasis,
exposure differs only by rounding. Paragraph rest replaces sentence rest at a
shared boundary; the maxima reallocate time rather than extend the span.

The 30ms floor derives the 2,000-WPM ceiling. At that ceiling all words receive
30ms, rests are zero, and length emphasis has no spare budget. For an 18-word
sentence with a 350ms configured rest, effective rests at 300/900/1200/1500/2000
WPM are 350/300/225/180/0ms. Rest caps preserve at least 75% of nominal span time
for words until the stricter exposure floor takes over.

Frame word time is the sum of member exposures. Only its final boundary frame
emits the span rest, so total scheduled time is identical across one-, two-,
and three-word presentation. The final frame stays fully emphasized during
word exposure, then visibly muted for effective rests of at least 150ms;
it is never blank and has no transition. Configured/effective rest is disclosed.

Playback follows planned deadlines. At most 25ms of callback lateness can be
absorbed by the next word phase, never below 30ms times its member count.
Larger delays are forgiven; pause, seek, regression, and timing edits re-anchor.
There is no unbounded pace debt or catch-up burst. At 2,000 WPM no catch-up
headroom remains. On a 60Hz display, 30ms is only 1.8 refresh intervals;
scheduling exactness does not imply identical painted exposure for every word.

## Package and source boundary

The package imports no workspace package, React, DOM, storage, fetch, worker,
or filesystem API and typechecks without DOM libraries. Root exports are pure
functions and frozen data. Hosts supply the structural `RsvpSource` from
`packages/rsvp/src/rsvp.ts`, extended with document token count for playback.

Source token indices are document-global; UTF-16 starts/ends and sentence/
paragraph bounds are local to the resident text. Token arrays match the served
token count and contain ordered, non-overlapping positive spans. Unit bounds
are sorted, deduplicated local token indices. Terminal bounds are optional for
package callers; source edges are the fallback. The web boundary proves
`ReaderPageResultV1` is structurally assignable instead of casting it.

`@texttrends/rsvp/source` offers `createRsvpSource(text, options?)` for standalone
hosts. It uses word-like `Intl.Segmenter` output, sentence mapping, and paragraph
breaks at a Unicode paragraph separator or two line terminators (CRLF counts
as one). This is its own policy, not promised parity with the app indexer.
The root does not import that subpath and the web app does not use it.

The web host uses the full bounded Reader slice while prose fitting is absent.
`publishRsvpPosition` updates canonical scrub without a redundant footer-passage
query, Reader walk, or navigation update. It stays valid during continuation
and clears stale occurrence/reveal work. Late pre-entry results cannot replace
the live Speed source. Pause and exit flush the live component token.

With roughly three seconds of runway left, `rsvpSeek` requests forward source
from the live token using the same budget as the resident slice. This retains
its suffix and supports adoption without skipping while the current frame
remains available. Exhaustion pauses honestly; a failed continuation never
claims to advance. `exitRsvp` restores suspended interaction, then opens prose
from the live token even if continuation is pending. Source and snapshot
validation do not depend on a currently ready replacement page.

## Accessibility and verification

Controls retain native keyboard behavior and focus containment; rapidly
changing frames are never `aria-live`. Stable mode/status, paused context,
pace controls, and immediate Return to Reader provide an accessible recovery
path. Utilities pause before taking focus and return to paused Speed.
Reduced-motion entry remains explicit.

Package fixtures pin grapheme anchors, punctuation stops, orphan/width rules,
exact source slices, span-budget conservation, floors, rest caps, rounding,
previous-frame replay, and deadline correction. Browser checks cover selected-
word entry, nested Find suspension, exact exit during continuation, stale
navigation cancellation, stage taps, native Space, compact 44px controls,
overlay geometry, long tokens, and document-end/source-failure pause.

## Research basis

The retained design basis distinguishes experimental findings from product
choices. [Masson (1983)](https://doi.org/10.3758/BF03196973) studied fixed
sentence pauses with unchanged word exposure; Speed instead reallocates a
fixed span budget. Its rest maxima are product defaults, not isolated
experimental optima. [Cocklin et al. (1984)](https://doi.org/10.3758/BF03198304)
informed short, punctuation-shaped frames;
[O'Regan et al. (1984)](https://doi.org/10.1037/0096-1523.10.2.250) informed the
left-of-centre anchor, applied here as a heuristic.

The broader reading tradeoff is documented by
[Rayner et al. (2016)](https://doi.org/10.1177/1529100615623267),
[Rahman and Muter (1999)](https://pubmed.ncbi.nlm.nih.gov/10354807/),
[Benedetto et al. (2015)](https://doi.org/10.1016/j.chb.2014.12.043), and
[Di Nocera et al. (2018)](https://doi.org/10.1504/IJHFE.2018.096118).
Bionic prefixes and randomized/complexity pacing remain excluded; the prior
review included [Snell (2024)](https://doi.org/10.1016/j.actpsy.2024.104304) and
[Spear et al. (2025)](https://doi.org/10.3758/s13414-025-03067-w).
