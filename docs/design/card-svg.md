# Project card SVG

`.yalethomas/card.svg` shows a corpus footer for `sunlight` in Bram Stoker's
*Dracula*: source passage, trend, barcode, and reading position. The card teaches
that a word has a reachable position. `.yalethomas/project.yaml` already
references the SVG.

## Generation and fidelity

Run from the repository root:

```sh
python3 scripts/gen-card-svg.py
```

Edit the generator, not the generated SVG. It reads the checked-in Dracula text
and derives positions, snippets, bins, and percentages. Its Python
`[A-Za-z']+` tokenizer is an artwork approximation, not the app's
`Intl.Segmenter` index recipe. The card's token totals/positions therefore must
not be cited as app analysis or exact cross-runtime parity.

Geometry is a 3× rendering of compact footer constants; changes to
`footer-metrics.ts`, footer components, palette, or trend defaults require
reviewing the generator. The artwork has no runtime connection to those
modules. Its bin curve uses count/peak scaling, not an exported app trend result.
The source snippets fit each side of the mark on whole-word boundaries; the
match box clamps at corpus edges. This differs deliberately from the live
passage scrollport's clipping.

## Motion and frame

The generator finds nine sunlight occurrences and cycles through them in source
order, 0.9 seconds per step. The fifth occurrence is the initial/rest frame,
placing useful context on both sides. CSS animations share one phase and
zero delay; each final keyframe returns to its initial state. CSS, rather than
SMIL, supports the publishing page's Web Animations playback/finish control.
Reduced motion retains the complete still.

The transparent 1618×1000 frame has title `textTrends`, light/dark palettes and
explicit color-scheme overrides, with no script, foreignObject, or remote
resources. It uses the app-inspired ink values `#1c1913`/`#e8e2d5`; those differ
from the publishing contract's `#1a1814`/`#e8e3d5` and are an intentional
palette choice, not identical values.

The footer's sparse, separated marks make every step visible. Alternative
illustrations and a borrowed zoom gesture were discarded because the source-
position loop demonstrates the product directly.
