# Project card SVG

`.yalethomas/card.svg` is the project's landscape artwork under the
[Yale Thomas publishing contract](https://yalethom.as/). It renders the
workbench's own corpus footer — the graph, barcode and source-text scrubber,
without the Terms rail — reading Bram Stoker's *Dracula* with the query
`sunlight`.

## Why this is the card

It does not depict the product or allude to it. It *is* a surface of the
product, running on a real corpus, showing a real result.

The one thing the card has to teach is that a word has a position and that
position is reachable. The footer already performs exactly that: the source
line is positioned so the matched word sits directly above its own mark on the
token axis. Watching the cursor step from occurrence to occurrence, with the
text sliding to keep the word over its tick, explains textTrends without a
caption.

## The query

`sunlight` occurs **9 times in 162,412 tokens** of *Dracula*, at 9.8%, 25.1%,
33.4%, 41.9%, 44.4%, 68.0%, 83.2%, 86.4% and 97.2% of the corpus. It was chosen
against three constraints:

1. **Sparse but not singular.** Nine marks read as a barcode; three read as
   dust.
2. **Separable at real axis resolution.** The minimum gap is 2.48% of the
   corpus — about 36 card px — so every mark draws exactly and the cursor
   visibly travels on every step. Thematically louder candidates fail this:
   `vengeance` in *Moby-Dick* has 12 hits, but four fall inside the Quarter-Deck
   scene within 0.7px of each other, so the cursor would sit still for four
   beats. `corpse` in *Frankenstein* has exactly 10 and the same defect.
3. **Self-explaining.** Nobody needs to be told why you would search a vampire
   novel for sunlight.

## Fidelity

Everything is taken from the app rather than approximated:

| Element | Source |
| --- | --- |
| Lane heights, gaps, padding, track sizes | `COMPACT_FINE` in `apps/web/src/lib/footer-metrics.ts` |
| Lane order — passage, status, strip | `apps/web/src/components/WorkbenchFooter.tsx` |
| Match tint, series underline, node rule | `apps/web/src/components/FooterPassage.tsx` |
| Mark colour and 1px minimum width | `apps/web/src/components/BarcodeStrip.tsx` |
| Trend bins: 40 per doc, rate, no smoothing | `DEFAULT_TREND_BINS` in `apps/web/src/lib/store.ts` |
| Readout wording | `footerStatusText` in `apps/web/src/lib/footer-view.ts` |
| Palette, both schemes | `apps/web/src/style/tokens.css` |

The card is a 3× render of the footer as it lays out below 600 CSS px — 77 app
px tall, drawn 231 card px tall. The scale is what lets 1px marks survive at
gallery size; the width class follows from the scale honestly, rather than
mixing a desktop geometry with a magnified render.

The readout is exactly what `footerStatusText` produces —
`Dracula · token 72,084 of 162,412 · 44% of corpus` — with no occurrence
counter added. Nothing on the card names the query except the highlighted word,
which is the query.

## Motion

Nine states, 0.9s each, 8.1s per cycle, stepping in corpus order and wrapping.
Each step moves the cursor, rescales the progress fill, slides the source line
so the match stays above its mark, and updates the readout — the same state
change the app makes on next-occurrence. Steps are discrete (`step-end`)
because the app's occurrence jump is discrete.

**The motion is CSS, not SMIL.** The landing page starts playback the moment a
pointer enters the card, and on exit it lets the running cycle finish before
pausing and resetting to the first frame. It schedules that ending cycle
through the Web Animations API, and `document.getAnimations()` does not report
declarative SMIL — so a SMIL-animated card can be played and paused but never
allowed to run out, and leaving the card would snap it back mid-step. This card
exposes 20 CSS animations: nine source lines, nine readouts, the cursor and the
progress fill. They share one duration and one phase with no `animation-delay`,
so the page's per-animation finish handlers all settle on the same frame
instead of tearing.

The last keyframe of every animation restores the first, so the wrap is
seamless and the frame the page returns to at rest is the frame it started
from.

At rest the card shows the fifth occurrence rather than the first: at 44% of
the corpus the source line has context on both sides, where the first
occurrence sits at 9.8% and would leave almost nothing to its left. Reduced
motion gets that same frame.

## Source line fitting

The match is pinned above its own mark, so the room left and right of it
differs at every stop — at 9.8% of the corpus almost everything is to the
right, at 97.2% almost everything is to the left. Each snippet is therefore
sized to the space actually available on each side and cut on word boundaries,
so no stop ends on a half-word or a clipped glyph. The match box itself is
clamped into the lane, which is the same clamp the app's passage scroll
applies at a corpus edge; at the last occurrence that shift is under 6px.

The app clips its passage mid-glyph, because it is a live scrollport. The card
does not, because it is a still image most of the time.

## Contract compliance

Transparent 1618×1000 frame with no backdrop; `<title>` exactly `textTrends`;
`color-scheme: light dark` with `light-dark()` values and `data-color-scheme`
overrides; no script, `foreignObject`, or remote resources; animation begins at
document time zero with no hover or script trigger; complete still at t=0 and
under `prefers-reduced-motion`. About 17KB.

One deliberate deviation: the wordmark uses the app's own primary ink
(`light-dark(#1c1913, #e8e2d5)`) rather than the contract's stated card ink
(`#1a1814` / `#e8e3d5`). The difference is under 1/255 per channel, and using
the app's token keeps the card consistent with the surface it renders.

## Generation

The file is generated by `scripts/gen-card-svg.py`, not hand-written: token
positions, snippets, bin counts and percentages are read from
`text/standard-ebooks/02 - Dracula - Bram Stoker.txt` at generation time, so
the artwork cannot drift from the data. Re-run it after any change rather
than editing the SVG by hand.

## Open

`project.yaml` still declares `svg: null`. Setting it to
`.yalethomas/card.svg` is what publishes the card and turns on the contract's
build validation; that is a decision, not a consequence of the file existing.

## Alternatives considered

Kept because they remain available if the footer card fails to read at gallery
size:

- **Projection.** A whole short document set as texture, with a reading cursor
  sweeping it and writing the barcode in reading order. Its lesson — page
  layout is 2-D, text is 1-D, and linearization is what the extractors do — is
  real, but the footer card demonstrates the same linkage using the product's
  actual surface instead of a diagram of it.
- **Darwin, six editions.** `evolution` occurs 0, 0, 0, 0, 0, 8 across the six
  editions of *Origin of Species*; `fittest` enters in the fifth; the lone
  `evolved` in the first edition is its final word. The best *finding*
  available, and the fallback if the card should report rather than
  demonstrate.
- **LOTR interleaving.** Frodo/Sam and Aragorn/Gandalf barcodes interlock like
  a comb, recovering the chapter structure from token positions alone. Charming,
  and dependent on the viewer knowing the books.
- **Inaugurals, I → we.** The trend half of the name over 230 years. Reads as a
  line chart, which graphtv already owns.
- **Small multiples.** One query, four corpora, four shapes.
- **Self-reference.** The card queries its own wordmark; ten tokens is a joke
  corpus.

A zoom was rejected early. It works for magnitude because orders of magnitude
are that product's subject and the mechanic can run through many of them. Here
it would be a borrowed gesture.
