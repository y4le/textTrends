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
reuses a canonical page while it serves the cursor. It does not restore
`passage/1`, excerpts, saved ranges, pins, Findings, sharing, or any durable
Evidence state. Trends retains its detailed graph, barcode, selection controls,
legend, and totals; only the moving visible source/position readout is global,
so Trends does not repeat the same live position below its graph.

The interaction and responsive specifics were reviewed with an explicitly
pinned Claude Opus planner through Parley (request
`req_consult_774ced41afcab047`, artifact
`art_sha256_509e1efd128bc65e29c7352f4591f5c39c6fa23c9e01d0caa7b44564064daff1`).

## 2026-08-07 — Retire retained excerpts and Findings

The owner removed the Evidence surface, saved excerpts and ranges, live and
durable pins, URL sharing, passage/anchor worker operations, and the Findings
place. Source reading now flows through the transient global reading footer or
directly from Concordance and exact barcode occurrences into Reader. Reader
position and linked range selection remain transient; durable research state
is limited to the notebook and analysis-view settings. Project saving and
conflict handling live in Corpus.

Old decisions below remain historical provenance where useful, but their
Evidence, Findings, excerpt, pin, range-persistence, and sharing provisions are
superseded by this decision. The current interface contract is
`docs/design/workbench-ux.md`.

## 2026-08-02 — Barcode embedded in trend geometry

The owner moved dispersion from a separate strip into the bottom of the trend
graph. Series view has one declared-sequence band; by-book view has one
within-book band under every plot row. Fine-pointer hover snaps only to exact
painted evidence within eight horizontal pixels and otherwise follows the raw
graph position; density aggregates never snap. Hover only updates the shared
scrub position. Click activation and accessible navigation retain their prior
evidence behavior only when the pointer is within the same exact-tick
tolerance; a far click remains a plain raw scrub. Summaries/buttons sit outside
the graph slider.

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

## 2026-07-30 — Cross-device workbench UX (partly superseded)

The owner approved replacing the implementation-order long page with a
cross-device research workbench and required mobile to be a first-class
interaction target. The governing design is
`docs/design/workbench-ux.md`.

The design incorporates two exact-pinned Claude Opus consultations through
Parley:

- information architecture: request `req_consult_26725b1a96acef6b`, artifact
  `art_sha256_60dcab231a2d73dbf5e54c1016c0166b6f40b4a581e50522a331bb905697236a`;
- mobile-first correction: request `req_consult_9624a6ff56e2dec2`, artifact
  `art_sha256_d56cad3e874ec5c8c2527d65ce56732d2c206ea2283db3c0dc24bb9257fa1ee2`.

The controlling product decisions are:

1. Keep six canonical places—Corpus, Trends, Concordance, Vocabulary,
   Compare, and Findings—but expose them through a Scope organ
   (Corpus/Findings) and a four-item Lens organ, not six equal tabs.
2. Preserve the explicit Scope/Focus/Evidence distinction; linked evidence
   does not mean every analysis consumes every selection.
3. Use one Evidence component as in-flow line, compact sheet, regular strip,
   or wide margin; Reader alone may take the full viewport.
4. Make tap read/focus but never create a durable pin. Pinning is always an
   explicit action. The chart retains vertical page pan, and touch range
   selection uses explicit mode, handles, steppers, and Apply.
5. Transform compact single-measure ranking tables into
   identity-plus-current-sort row lines with exact row detail; preserve KWIC
   alignment through one shared context port.
6. Present A/B keyness on one signed zero-centered axis at every width, with
   exact numeric tables additionally available when space permits.
7. Use one component/state tree across presentation classes; viewport changes
   never alter analytical/share state or issue analysis work.
8. Preserve the 90 kB entry budget and add no router, sheet, gesture, or UI-kit
   dependency for the shell.

## 2026-07-30 — Slices 3, 4, and durable research state (partly superseded)

The owner approved proceeding with ROI-ranked phases 2, 3, and 4 and ratified
the six product recommendations raised by the governing Claude Opus planning
ruling (Parley request `req_consult_a2002d56c2327772`, session
`ses_cad54a4d184a8c0d`, artifact
`art_sha256_c27b4b4a264a71518248b3c59162d88624c4852049b44c9f631cd550c4d0c842`):

1. Use a bespoke, compressed, source-free URL-fragment codec for sharing
   instead of adding `nuqs`.
2. Do not add a stop list in v1.
3. Define frequency-list DP parts by selected document.
4. Keep the durable pin cap at eight.
5. Make the frequency table's “add exact term” action create a case-sensitive,
   diacritic-sensitive exact-token notebook group.
6. Place Poisson bursts after Slice 4 rather than inside the corpus dashboard
   or keyness slice.

The surviving comparison contract is `docs/design/keyness-plan.md`; current
inventory and frequency behavior is defined by the executable core contracts.
