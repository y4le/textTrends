# Product decision record

This file records owner decisions that resolve cross-cutting recommendations
from architecture consultations. It is the durable repository provenance for
choices otherwise visible only in an implementation thread.

## 2026-08-10 — Terms joins the persistent reading dock

The global Terms rail moves from the scrolling workbench column into one fixed
bottom dock directly above the corpus-reading footer. Terms and Reading
Position remain separate sibling landmarks: authored query state is not folded
into the transient reading instrument. The layout-only dock owns viewport
placement and reserves both its fixed one-row rail and the expected reading
lane before lazy chunks or the first usable snapshot arrive, so the Terms rail
does not move during startup. With no corpus, the Terms-only rail remains
available.

Buckets scroll horizontally while Add and Manage remain pinned. Compact and
coarse layouts preserve one row and 44px targets; edit and removal move through
Manage, and removal Undo opens upward. The entire dock sits above the compact
portrait Lens dock and to the right of the compact-landscape rail. Reader and
full-screen authoring layers remain the deliberate exceptions. The design was
developed with an explicitly pinned Claude Opus planner through Parley
(request `req_consult_481f34b4fde427c7`, artifact
`art_sha256_aa0484363b4373830252443f6ecfe4bd1b7dc1688b2b666de5ffdbcefe36be31`).

## 2026-08-10 — Hybrid pointers keep both interaction paths

Pointer layout and pointer interaction are separate decisions. If either the
primary pointer or any available pointer is coarse, the workbench retains its
large touch targets and coarse navigation controls. Hover, exact barcode
snapping, and pointer activation are decided from the current `PointerEvent`:
mouse and pen are precise, while touch and unknown input stay direct. The
reading shuttle remains mouse-only. Observing a mouse never removes touch
affordances, and a later touch never inherits the mouse's snapping behavior.

Exact snap indexes remain lazy. The first precise event arms their retained
allocation and uses the same memoized index synchronously, so an iPad trackpad
works on its first hover rather than its second. Trends and the global footer
apply the same rule and captured-target resolver. The split was developed with
an explicitly pinned Claude Opus planner through Parley (request
`req_consult_051f0c3ae6933cdc`, artifact
`art_sha256_6f35c0206d26c30c4c81f78d619fd8954c74e1ebf6065da0a629bc64a139e8f9`).

## 2026-08-09 — Browser-fitted Reader pages

Reader pages follow the viewport, typography, and highlighted source that the
person actually sees. The worker supplies bounded exact-direction source
slices; the browser renders the real marked text and finds the largest token
range that fits without vertical scrolling. Forward pages meet at exact token
boundaries, and a bounded session walk remembers measured boundaries so Back
reproduces pages until a resize or font change deliberately invalidates them.
The prose pane is overflow-hidden, while Home/End, h/l, arrows, Page Up/Down,
and w/W retain their reading semantics. Compact layouts use a two-row control
grid. The requested anchor keeps a layout-neutral underline and background;
font-weight emphasis is excluded because it can move the measured page seam.
On touch screens, a short tap in the Reader's outer edge zone turns toward that
edge. The zone is 18% of the width, bounded to 44–120 CSS pixels. This
supplements the visible controls and ignores unsettled layouts, drags,
selections, and interactive descendants so ordinary text interaction survives.

The design was developed with an explicitly pinned Claude Opus planner through
Parley (requests `req_consult_89063bb9c964ba41` and
`req_consult_a47ca649113d183e`).

## 2026-08-09 — Code-native analytical graphics

Analytical graphics are built directly with React SVG or canvas and the shared
CSS system. A D3 module may be introduced as a pure geometry or scale function
when it earns its weight, but no general chart runtime owns rendering or
interaction. This keeps exact token geometry, accessibility, responsive
adaptation, and source-navigation semantics in one application-owned model.

## 2026-08-08 — One global corpus-reading footer

The owner restored a fixed reading footer across all five workbench places.
It is one transient instrument on the declared-sequence corpus axis: the
current source line sits above a thin all-book trend sparkline, corpus progress,
and the existing multi-track dispersion barcode. Fine-pointer scrubbing and
keyboard movement update the shared reading cursor; exact and density barcode
activation retain their direct Matches behavior. Reader remains the only
full-viewport place and hides the footer.

The source line uses a separately fenced, frame-coalesced and single-flight
`reader-page/1` lane. It reuses a resident source slice while it serves the cursor and
retains the last authenticated page, marked stale and non-actionable, while the
newest unserved position is in flight. Reading position remains
transient. Trends retains its detailed graph, barcode, selection controls,
legend, and totals; only the moving visible source/position readout is global,
so Trends does not repeat the same live position below its graph.

The interaction and responsive specifics were reviewed with an explicitly
pinned Claude Opus planner through Parley (request
`req_consult_774ced41afcab047`, artifact
`art_sha256_509e1efd128bc65e29c7352f4591f5c39c6fa23c9e01d0caa7b44564064daff1`).

The later performance pass removed the redundant passage debounce while
retaining frame coalescing and single-flight delivery. Because an absolute
corpus axis cannot spatially expose every token of a long book, fine-pointer
dragging now provides an explicit time-based reading shuttle: offset controls
bounded reading rate, the cursor remains tied to the displayed token, and
release pauses. Hover seeking, unmoved clicks, barcode activation, and
double-click Reader targets remain absolute. The design was developed with an
explicitly pinned Claude Opus planner through Parley (requests
`req_consult_fcf58840756d3ec5` and `req_consult_74ebce271aa7c433`, artifacts
`art_sha256_a255426783351f3ba4d86e9f3163f70f51fd75d64a9bf7c55a769eb28ee6e0ec`
and `art_sha256_82ea70944cd693abfb7797df42f937f16b4f4f4eeace168c8d4880da76cd8049`).

Keyboard reading uses the same source-honest axis. In the footer, `h`/`l`,
Left/Right, and PageUp/PageDown move by the passage interval actually rendered,
with an overlapping or adjacent seam and no skipped source; shifted horizontal
keys retain one-token precision. Reader owns those page keys while it is open
and uses browser-fitted, remembered token boundaries instead. Variable text widths,
stale-window repeat, exact term-occurrence navigation, focus/layer priority,
and accessible shortcut discovery were designed with the pinned Claude Opus
planner through Parley (request `req_consult_830ae8f3aed60d75`, artifact
`art_sha256_e2c6d27a61376cadb73504d393190c50e2c3a17bca07b27ada6e1eace3d23dd5`).

## 2026-08-02 — Barcode embedded in trend geometry

The owner moved dispersion from a separate strip into the bottom of the trend
graph. Series view has one declared-sequence band; by-book view has one
within-book band under every plot row. Fine-pointer hover snaps only to exact
occurrences within eight horizontal pixels and otherwise follows the raw
graph position; density aggregates never snap. Hover only updates the shared
scrub position. Click activation and accessible navigation snap only when the
pointer is within the same exact-tick tolerance; a far click remains a plain
raw scrub. Summaries/buttons sit outside the graph slider.

The geometry and interaction design was reviewed with an explicitly pinned
Claude Opus planner through Parley (request `req_consult_4d67d7be870ef28a`,
artifact `art_sha256_d014ec07c6b63b1801466a9877f18db9651a5024f2f44fecc1a9bf67392c336b`).
The staged implementation then passed an iterative explicitly pinned Opus diff
review after its findings were addressed (accepted request
`req_review_diff_b572c7a67522449d`, artifact
`art_sha256_31a9bc1f5442c631bdd39cb957c115c13da0978ea2b7f5868a7f22f3579389d8`,
receipt
`rev_sha256_5b81c7923c31ff806af9cc0b74c9b041977e7205ae362fb25be14aef54212dee`).

## 2026-08-02 — One full-viewport Reader

The owner removed the Reader's study/full choice. Reader now has one
full-viewport presentation at every width, with workbench surfaces hidden and
the outer document scroll-locked while it is open. This makes tablet behavior
match phone behavior and prevents iPad Safari from moving the Reader partly
off-screen through page-level scrolling.
