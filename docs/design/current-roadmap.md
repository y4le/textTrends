# Current roadmap

This is the reconciliation index for the current tree as of 2026-08-07. The
[analysis contract](analysis-contract.md) remains the semantic authority;
feature plans explain how the tree arrived here, but may describe superseded
UI shapes.

## Shipped

- **One browser-local project pipeline:** TXT, Markdown, HTML/XHTML, and EPUB
  extraction feed one versioned snapshot/index engine (`packages/core`,
  `packages/extractors`, and `apps/web/src/worker`). Durable project and
  research state use browser storage with explicit repair/reattachment paths.
- **Five reachable workbench places:** Catalog, Trends, Concordance,
  Vocabulary, and Compare (`apps/web/src/places`). They cover local file and
  active-corpus management, term groups, linked selections, frequency,
  keyness, project saving, and method surfaces.
- **Direct reading paths:** all workbench places share a transient corpus-order
  footer with current source, all-book trends, progress, and adaptive
  dispersion. It shares token geometry with KWIC and the full-page Reader;
  there is no saved excerpt or Findings surface.
- **Bounded analysis results:** occurrence construction now has typed hard
  caps, the worker cache has simultaneous entry/byte ceilings, and publishing
  a new snapshot releases old occurrence entries. Cap failures remain visible
  and recoverable.
- **Responsive presentation:** compact/coarse-pointer behavior, viewport-safe
  sheets, keyboard-accessible overflow regions, and live color-scheme repaint
  of canvas marks are covered by browser tests.

## In progress

- **Publication hardening:** corpus rights/provenance, repository licensing,
  reproducible deployment, and a clean-checkout CI story still need an
  owner-led publication cut. These are tracked in [the backlog](backlog.md).
- **Hermetic Standard Ebooks dependency:** the workspace still requires the
  sibling `../standard_ebooks` checkout. Publishing a pinned package or
  vendoring a provenance-recorded copy is intentionally deferred to that cut.
- **Large-corpus validation:** the checked-in browser benchmark is below the
  formal 10M/50M-token tiers. Those tiers must be measured before making
  stronger residency or performance claims.

## Deferred with the reason

- **Streaming/folding occurrence architecture:** deferred because the new
  construction cap removes unbounded growth and the corrected 2026-08-03
  Linux benchmark measured both a successful 199,920-occurrence construction
  and a cap rejection below the written latency and phase-local RSS promotion
  thresholds. A streaming change would also have to redesign the shared
  trend/KWIC/dispersion/Reader cache contract; see
  [benchmarks.md](benchmarks.md#occurrence-streaming-promotion-gate).
- **Reader-as-dialog:** rejected for the current one-destination UI. The
  workbench is unmounted while reading, so modal semantics, inert background,
  and a focus trap would add machinery for a background that does not exist.
- **Moving barcode interaction into the store:** deferred until a second
  consumer needs that policy. Gesture ownership remains in the trend stage;
  persisted navigation state does not absorb transient pointer mechanics.
