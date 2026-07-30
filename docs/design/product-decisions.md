# Product decision record

This file records owner decisions that resolve cross-cutting recommendations
from architecture consultations. It is the durable repository provenance for
choices otherwise visible only in an implementation thread.

## 2026-07-30 — Cross-device workbench UX

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
