# Application composition

The application keeps one composed Zustand runtime. `ProjectSession` owns source admission,
generations, and immutable session publications. The runtime projects those publications and
issues bounded queries; corpus arrays and source text stay behind the worker boundary.

## Ownership

| Module | Responsibility |
| --- | --- |
| `apps/web/src/lib/app-state.ts` | Shared type contracts, with no runtime imports or values. Consumers import contracts directly. |
| `apps/web/src/lib/app-defaults.ts` | Shared initial analytical preferences. |
| `apps/web/src/lib/workspace-state.ts` | Durable workspace projection, unavailable-source references, and the exact referential prefilter for semantic saves. |
| `apps/web/src/lib/workspace-persistence.ts` | Storage connection, hydration baseline, debounce, retry pause, stale-save fencing, visibility flush, and disposal. |
| `apps/web/src/lib/navigation-controller.ts` | Initial URL normalization, layer registry, Back/Forward reconciliation, history writes, and focus return. |
| `apps/web/src/lib/store.ts` | Runtime composition, session bridge, notebook actions, and query/Reader interaction. |

Persistence connects before session attachment and establishes its baseline after workspace
restoration. A source replacement remains synchronous: persistence observes the final corpus
and notebook together. Disposal cancels pending saves and prevents late settlements from
publishing. Saved but unavailable document references survive ordinary editing and autosave
until repaired or explicitly removed.

Navigation has two phases. Construction normalizes the initial URL before Zustand creates its
first snapshot. Binding attaches the completed store and callbacks, then subscribes to history.
Back/Forward preserves the existing order of state publication, history normalization, focus
return, and Reader query issuance. Runtime teardown fences callbacks before retiring the
subscription. The history port has one owner, including bootstrap and teardown writes.

## View boundaries

`TrendPanel` derives chart data and composes controls. `trends/ScrubSurface` owns pointer,
keyboard, touch-range, and cursor interaction. The parent does not subscribe to cursor movement;
it supplies stable chart children so scrubbing does not recommit the SVG charts.
`trends/TrendCharts` renders the series and per-book charts, while `TrendRowResizeHandle` owns
the row-size gesture. Shared chart and pointer types live in pure library modules.

`WorkbenchFooter` composes the reading strip; `footer/FooterInteractive` owns its input and
navigation behavior. `QuerySurface` owns the term rail; `terms/TermControls` owns term buttons
and their action menu. These extractions retain the existing props, component lifetimes,
and pure geometry/gesture helpers.

Guide tests assert one visible rendered publisher and an effective highlight for each active
semantic anchor. They no longer prescribe the filename that must render that anchor. Package,
worker, bundle, and application-contract boundaries remain explicitly tested.

## Stylesheet order

The ten stylesheets are eager imports in `main.tsx`, in the order pinned by
`test/style-order.test.ts`. They are contiguous slices of the former stylesheet. Their names
identify the dominant responsibility; later rules still overlap earlier features. Moving a rule
between files requires checking the cascade.

The split was checked mechanically: every boundary was at brace depth zero, and concatenating
all slices without their explanatory headers reproduced the original 8,637-line source exactly
(SHA-256 `4cbab73ec5b2ee5eba24d4cc0c6ef722a6f49c206d3229db8ec90926fc0fcb8d`).
The production CSS before and after the split was byte-identical: 153,821 bytes, SHA-256
`2c7fa3452c66ffc1319a970627b2c6c6d0bb8700b4093a9633933a1a89f8194b`.
A subsequent cleanup removed two unused library regex-error rules; it is separate from
the mechanically verified split.

## Deliberate follow-ups

Reader and vocabulary/query controllers remain candidates for subsequent extraction. Keep
individual query lanes and their distinct product policies; do not introduce a generic registry
merely to shorten the composition module. Further extraction should preserve initialization,
lease ownership, and disposal with explicit dependencies.

The eager hidden-table query policy remains unchanged. The five local performance checks passed;
the 66-text, five-track Atlas interaction windows had no attributed tasks reaching 100 ms, and
cancellation remained inside its gate. That evidence does not justify changing scheduling now
or establish results at the deferred larger corpus tiers. A future scheduling change should
measure work avoided, first-result time, and tab-switch latency together.

The provenance formatters remain a tested, deferred capability. They have no production export
surface. Result export and workspace backup need their own product decisions about completeness,
methods, and source bytes; this refactor does not imply those features exist.
