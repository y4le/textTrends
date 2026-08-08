# Current roadmap

This is the reconciliation index for the current tree as of 2026-08-03. The
[analysis contract](analysis-contract.md) remains the semantic authority;
feature plans and [the executed simplification record](simplification-plan.md)
explain how the tree arrived here, but may describe superseded UI shapes.

## Shipped

- **One browser-local project pipeline:** TXT, Markdown, HTML/XHTML, and EPUB
  extraction feed one versioned snapshot/index engine (`packages/core`,
  `packages/extractors`, and `apps/web/src/worker`). Durable project and
  research state use browser storage with explicit repair/reattachment paths.
- **Six reachable workbench places:** Corpus, Trends, Concordance, Vocabulary,
  Compare, and Findings (`apps/web/src/places`). They cover structure review,
  term groups, linked selections, frequency/TF-IDF/keyness, saved evidence,
  and method surfaces.
- **Evidence-linked reading:** trends and adaptive dispersion barcodes share
  token geometry with KWIC, passage evidence, and a full-page Reader. The
  Reader is a named destination, not a modal overlay.
- **Bounded analysis results:** occurrence construction now has typed hard
  caps, the worker cache has simultaneous entry/byte ceilings, and publishing
  a new snapshot releases old occurrence entries. Cap failures remain visible
  and recoverable.
- **Responsive presentation:** compact/coarse-pointer behavior, viewport-safe
  sheets, keyboard-accessible overflow regions, and live color-scheme repaint
  of canvas evidence are covered by browser tests.

## In progress

- **Publication hardening:** corpus rights/provenance, repository licensing,
  reproducible deployment, and a clean-checkout CI story still need an
  owner-led publication cut. These are tracked in
  [simplification-plan.md](simplification-plan.md#track-p--publication-blockers-and-hardening).
- **Hermetic Standard Ebooks dependency:** the workspace still requires the
  sibling `../standard_ebooks` checkout. Publishing a pinned package or
  vendoring a provenance-recorded copy is intentionally deferred to that cut.
- **Large-corpus evidence:** the checked-in browser benchmark is below the
  formal 10M/50M-token tiers. Those tiers must be measured before making
  stronger residency or performance claims.

## Deferred with the reason

- **Streaming/folding occurrence architecture:** deferred because the new
  construction cap removes unbounded growth and the corrected 2026-08-03
  Linux benchmark measured both a successful 199,920-occurrence construction
  and a cap rejection below the written latency and phase-local RSS promotion
  thresholds. A streaming change would also have to redesign the shared
  trend/KWIC/dispersion/Reader/passage cache contract; see
  [benchmarks.md](benchmarks.md#occurrence-streaming-promotion-gate).
- **Reader-as-dialog:** rejected for the current one-destination UI. The
  workbench is unmounted while reading, so modal semantics, inert background,
  and a focus trap would add machinery for a background that does not exist.
- **Moving barcode interaction into the store:** deferred until a second
  consumer needs that policy. Gesture ownership remains in the trend stage;
  persisted navigation state does not absorb transient pointer mechanics.
