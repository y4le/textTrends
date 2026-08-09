# Product decision record

This file records owner decisions that resolve cross-cutting recommendations
from architecture consultations. It is the durable repository provenance for
choices otherwise visible only in an implementation thread.

## 2026-08-08 — One global corpus-reading footer

The owner restored a fixed reading footer across all five workbench places.
It is one transient instrument on the declared-sequence corpus axis: the
current source line sits above a thin all-book trend sparkline, corpus progress,
and the existing multi-track dispersion barcode. Fine-pointer scrubbing and
keyboard movement update the shared reading cursor; exact and density barcode
activation retain their direct Concordance behavior. Reader remains the only
full-viewport place and hides the footer.

The source line uses a separately fenced, debounced `reader-page/1` lane and
reuses a canonical page while it serves the cursor. Reading position remains
transient. Trends retains its detailed graph, barcode, selection controls,
legend, and totals; only the moving visible source/position readout is global,
so Trends does not repeat the same live position below its graph.

The interaction and responsive specifics were reviewed with an explicitly
pinned Claude Opus planner through Parley (request
`req_consult_774ced41afcab047`, artifact
`art_sha256_509e1efd128bc65e29c7352f4591f5c39c6fa23c9e01d0caa7b44564064daff1`).

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
