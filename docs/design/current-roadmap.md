# Current roadmap

This is the reconciliation index for the current tree as of 2026-08-18. The
[analysis contract](analysis-contract.md) remains the semantic authority;
the other retained design documents record current product decisions,
measurement gates, and method contracts.

## Shipped

- **One browser-local workspace pipeline:** TXT, Markdown, HTML/XHTML, and EPUB
  extraction feed one versioned snapshot/index engine (`packages/core`,
  `packages/extractors`, and `apps/web/src/worker`). One content-addressed local
  library and one last-write-wins workspace own durable browser state.
- **Five reachable workbench places:** Inputs, Trends, Matches,
  Vocabulary, and Compare (`apps/web/src/places`). They cover local file and
  active-corpus management, term groups, linked selections, frequency,
  keyness, workspace restore, and method surfaces.
- **Inputs as a first-class composition surface:** empty workspaces open Inputs;
  non-empty workspaces open Trends. A three-card composition area shares one
  local-library ownership lane; its empty Active inputs state leads with user
  files and offers Sherlock as a secondary sample. Samples become ordinary
  local texts, and stable full-corpus text details report every active term. See the
  [Inputs workspace proposal and decision record](inputs-workspace.md).
- **Direct reading paths:** all workbench places share a transient corpus-order
  footer with current source, all-book trends, progress, and adaptive
  dispersion. It shares token geometry with KWIC and the full-page Reader.
- **Bounded analysis results:** occurrence construction now has typed hard
  caps, the worker cache has simultaneous entry/byte ceilings, and publishing
  a new snapshot releases old occurrence entries. Cap failures remain visible
  and recoverable.
- **Responsive presentation:** compact/coarse-pointer behavior, viewport-safe
  sheets, keyboard-accessible overflow regions, and live color-scheme repaint
  of canvas marks are covered by browser tests.
- **Discoverable debug and recovery surface:** `Shift+D`, or the visible Debug
  action in Help, opens sanitized runtime, worker, analysis-lane, storage, and
  presentation diagnostics. The pane owns additive private demo loaders,
  explicit cache eviction, full browser-data reset, worker/retry actions, and a
  metadata-only copy report. Allowlisted one-shot `?demo=sherlock`,
  `?demo=lotr`, and `?demo=asoif` links replace active research state while
  preserving reusable local-library bytes.

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
