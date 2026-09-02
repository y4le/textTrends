# Current roadmap

This is the reconciliation index for the current tree as of 2026-09-02. The
[analysis contract](analysis-contract.md) remains the semantic authority;
the other retained design documents record current product decisions,
measurement gates, and method contracts.

## Shipped

- **One browser-local workspace pipeline:** TXT, Markdown, HTML/XHTML, and EPUB
  extraction feed one versioned snapshot/index engine (`packages/core`,
  `packages/epub`, `packages/extractors`, and `apps/web/src/worker`). Generic
  EPUB extraction is provider-neutral; Standard Ebooks owns only its catalog,
  download, and source-archive policy. One content-addressed local library and
  one last-write-wins workspace own durable browser state. The durable parser
  accepts only the current exact workspace and query-notebook shapes.
- **Five reachable workbench places:** Inputs, Trends, Matches,
  Vocabulary, and Compare (`apps/web/src/places`). They cover local file and
  active-corpus management, term groups, linked selections, frequency,
  keyness, workspace restore, and method surfaces.
- **Inputs as a first-class composition surface:** empty workspaces open Inputs;
  non-empty workspaces open Trends. A three-card composition area shares one
  local-library ownership lane; its empty Active inputs state leads with user
  files and offers rights-documented prepared corpora as secondary samples. Samples become ordinary
  local texts, and stable full-corpus text details report every active term. See the
  [Inputs workspace proposal and decision record](inputs-workspace.md).
- **Direct reading paths:** all workbench places share a transient corpus-order
  footer with current source, all-book trends, progress, and adaptive
  dispersion. The full-viewport Reader now has two explicit scales: Read keeps
  browser-fitted highlighted prose, while Atlas lays every ready text out in
  declared order for horizontally pannable whole-text comparison. Equal and
  To-scale normalization, exact-versus-density evidence, contextual text
  rulers, scale-aware keyboard/Help behavior, compact/coarse controls, and
  bounded canvas residency are shipped. Reader retains its Terms, trend,
  progress, and dispersion lanes in a compressed default while omitting the
  redundant footer source line and prose highlights legend. Conditional
  notices still disclose capped marks and marks retained from a superseded
  query. The footer, KWIC, Read, and Atlas share authored token geometry. See
  the [spatial Reader contract and decision](spatial-reader.md).
- **Reusable Speed engine:** `@texttrends/rsvp` is a framework-free package for
  framing, pacing, source adaptation, and playback planning. The web app keeps
  Speed as a first-class Reader mode while depending on that extraction seam;
  publishing it independently remains optional rather than required.
- **Guided learning:** a seven-card tour teaches one round trip from a resident
  analytical mark to canonical source text and back. Four pull-only contextual
  notes live in Help, useful empty states explain their own next action, and a
  once-per-version in-flow invitation offers discovery without autostart. The
  system writes no durable research state, performs no guide-specific analysis,
  and passed the full accessibility, history, compact-layout,
  no-durable-write, bundle, and browser gates. See the
  [guided-learning authority](guided-learning.md) and
  [shipped implementation plan](guided-learning-execution.md).
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
  metadata-only copy report. Allowlisted one-shot demo links cover the public
  corpus shelf plus private `lotr` and `asoif`; they replace active research
  state while preserving reusable local-library bytes.
- **Hermetic builds and deployment:** every workspace package, including the
  EPUB reader, Standard Ebooks client, and Speed engine, lives in this
  repository. Pull requests run the full CI suite; successful pushes to
  `master` build and deploy the production bundle to GitHub Pages.

## In progress

- **Publication hardening:** corpus rights/provenance and repository licensing
  still need an owner-led publication cut. These are tracked in
  [the backlog](backlog.md).
- **Large-corpus validation:** the checked-in browser benchmark is below the
  formal 10M/50M-token tiers. The 66-text Bible Atlas now has a five-exact-track
  canvas-residency and 100ms long-task gate, but the larger token tiers must be
  measured before making stronger general residency or performance claims.

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
- **Continuous and side-by-side prose:** deferred until a document-scale source
  window, stable measurement compensation, deep-jump anchoring, cross-window
  selection, and residency baselines exist. Atlas intentionally compares
  whole-text evidence rather than rendering microscopic prose; a future
  reference view is asymmetric and follows Continuous Read.
- **Moving barcode interaction into the store:** deferred until a second
  consumer needs that policy. Gesture ownership remains in the trend stage;
  persisted navigation state does not absorb transient pointer mechanics.
