# Product decision record

This file records owner decisions that resolve cross-cutting recommendations
from architecture consultations. It is the durable repository provenance for
choices otherwise visible only in an implementation thread.

## 2026-07-30 — Slices 3, 4, and durable research state

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

The implementation contracts are
`docs/design/corpus-dashboard-plan.md`,
`docs/design/keyness-plan.md`, and
`docs/design/research-state-plan.md`.
