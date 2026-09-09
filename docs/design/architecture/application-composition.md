# Application composition

One composed Zustand runtime projects immutable `ProjectSession` publications
and issues bounded queries. The session owns source admission and generations;
corpus arrays and source text remain behind the worker boundary.

The client correlates query results with the requested snapshot and operation.
The shared issuer validates the operation after checking the live lease, then
delivers an operation-specific result type to controllers. Injected query ports
remain union-typed; current mismatches enter the lane's error state and stale
responses remain silent. Payload checks (document, track, method) stay with
their consumers.

## Ownership

| Module in `apps/web/src/lib` | Responsibility |
| --- | --- |
| `app-state.ts` | Type-only shared contracts; no runtime values/imports |
| `app-defaults.ts` | Initial analytical preferences |
| `workspace-state.ts` | Durable projection, unavailable-source references, exact referential prefilter for semantic saves |
| `workspace-persistence.ts` | Connection, hydration baseline, debounce, retry pause, restore suspension/drain, stale-save fencing, visibility flush, disposal |
| `navigation-controller.ts` | Initial URL normalization, layer registry, Back/Forward, history writes, focus return |
| `vocabulary-controller.ts` | Vocabulary settings/pagination and three independent frequency, range-inventory, and baseline-inventory lanes |
| `compare-controller.ts` | Compare initial state, four query lanes, selection/settings and pagination intent, cold-restore/demo reconciliation |
| `reader-controller.ts` | Reader initial state, actions, page-query lane, fitted-page walk, seek session, and disposal |
| `query-lane.ts` | Shared latest-wins lease and best-effort transport cancellation mechanism |
| `trend-queries.ts` | Shared per-series trend and dispersion issuance; runtime retains lanes, guards, pending publication, and refresh order |
| `store.ts` | Runtime composition, session bridge, notebook/query/Find/Speed actions, shared cursor and position history |

Persistence connects before session attachment and establishes its baseline
after restore. Source replacement is synchronous so persistence sees the final
corpus and notebook together. Disposal cancels pending saves and fences late
settlement. Saved unavailable sources survive editing/autosave until repaired
or explicitly removed; healthy library records can open around damaged ones.

Library IndexedDB v2 separates metadata listing from source bodies. Upgrade is
atomic and preserves original records on failure. Actual source use still
verifies byte integrity. File deletion and workspace reconciliation share a
transaction; acquisition and activation share one operation lease.

Navigation construction normalizes the initial URL before Zustand's first
snapshot. Binding then attaches the completed store/callbacks and history
subscription. Back/Forward preserves state publication, history normalization,
focus return, and Reader query ordering. Teardown fences callbacks before
retiring the subscription. The history port has one owner for bootstrap,
ordinary navigation, and teardown.

## View boundaries

`places/ActivePlace` owns explicit lazy module readiness. A finite module cache
shares in-flight loads, exposes synchronous warm values and evicts rejected
promises. Keyed place mounts fence obsolete completions; the outer semantic
section retains its focus target during loading. Trends loads its always-used
chart/distribution with its place chunk. Reader, utility panes and descendant
fallbacks retain Suspense. See the [first-place measurements](../hidden-query-measurement.md#first-place-module-readiness-september-8-2026).

`TrendPanel` derives data and composes controls. `trends/ScrubSurface` owns
pointer, keyboard, touch range, and cursor interaction; its parent does not
subscribe to cursor motion and supplies stable chart children. `TrendCharts`
owns series/text rendering; `TrendRowResizeHandle` owns the sizing gesture.
Shared geometry and pointer types remain pure library modules.

`WorkbenchFooter` composes the strip; `footer/FooterInteractive` owns input and
navigation. `QuerySurface` composes Terms; `terms/TermControls` owns buttons and
actions. These boundaries preserve props, lifetimes, and pure gesture helpers.

`inputs/useLibraryAcquisition` owns library inspection, acquisition, activation,
removal and demo loading. Inspection epochs reject stale refresh results and
unmount invalidates view publication; durable operations retain the process-wide
library lease until their own finally block completes. `ProjectPanel` retains
file-input reset, disclosures, drag/drop, reordering, confirmations for active
workspace reset, markup and ARIA.

`KwicPanel` retains view models, markup, and ARIA. `matches/useMatchesScroll`
owns viewport measurement, native/programmatic scroll fencing, cursor
publication, prefetch, and announcements. `matches/useMatchesColumnResize`
consumes that measurement and owns pointer/keyboard resizing and focus cleanup.
Each hook cancels its own frames and timers; context escalation stays a focused
effect in the panel.

`reader/useRsvpPlayback` owns Speed source residency, cursor and passage history,
continuation requests, visibility pausing, and playback timers. Store-owned
playing and pacing remain inputs; `RsvpReader` owns settings, announcements,
focus, keyboard/pointer handling, and markup. Pure timing rules stay in
`packages/rsvp`. The hook is mounted for one keyed Speed session and clears its
timer both when paused and when unmounted.

The Reader controller is constructed inside Zustand initialization after query
and matching capabilities exist, without reading state during construction.
Navigation binds after initialization. The controller owns Reader queries and
local state; Find and Speed stay in the composed runtime and call its target
replacement method. A named reading-position patch capability performs shared
occurrence cancellation and optional history scheduling, returning cursor state
for one atomic publication with Reader fields. Fitted-page publication does not
schedule footer passage work. Snapshot invalidation remains ordered in the
runtime; disposal closes the shared scope before cancelling controller queries.

Compare consumes a derived scope and the shared query issuer. Its reconciliation
methods return a view for atomic session/workspace publication; the runtime
retains the cross-slice geometry subscription and snapshot refresh order. Neither
controller reads state during construction or owns a second store.

Vocabulary publishes shared token counts and clamped position history through a
named runtime patch, atomically with its inventory result. Only full-corpus
inventory landing triggers trend-bin normalization; range work never cancels
that baseline. Notebook creation and Matches navigation remain runtime actions.

Pure comparison policy, Matches row keys, and occurrence status text live in
their domain modules. Only the composition root imports the runtime in product
code; the import-boundary test enforces this direction. Further extraction should follow concrete ownership needs in
[open work](../current-roadmap.md#architecture-follow-ups).

Guide tests require one visible publisher and effective highlight per semantic
anchor, not a prescribed component filename. Keep source-level checks for real
package, worker, bundle, and application boundaries; use rendered behavior for
presentation ownership.

## Styles and scheduling

Twelve stylesheets load eagerly in `main.tsx` in the order pinned by
`apps/web/test/style-order.test.ts`. `tokens.css` owns tokens, document defaults,
guide and application chrome;
`reader.css` owns the contiguous Read/Atlas/Speed rules, followed by
`query-scope.css` for query chrome and scope labels. This partition preserves
rule order. Document scroll locking stays in the foundational sheet; dock
controls and compact Reader integration retain their later shared overrides.
Other names indicate dominant responsibility; later files still overlap
earlier features. Moving a rule requires checking the cascade, not assuming
file boundaries isolate it. Historical split hashes
are not current CSS validation targets.

Eager hidden-table queries remain deliberate after an
[observational baseline](../hidden-query-measurement.md). Evaluate work
avoided, first-result time, and tab-switch latency together before changing
scheduling. Preserve lane-specific product policies rather than introducing a
generic registry to shorten the runtime. Current local evidence is in
[benchmarks](../benchmarks.md); it does not establish larger corpus tiers.

`provenance.ts` is a tested deferred capability without a production export
surface. Result completeness still needs a product decision. Portable source
and workspace restoration follows the [backup contract](../workspace-backup.md).

### App interaction lifetimes

`components/app/useUtilityPanes.ts` owns utility-pane state, return-focus capture
and restoration, and the existing Find/Speed-reader handoffs.
`useWorkbenchShortcuts.ts` owns chord prefixes, timeout cleanup and keyboard
announcements. App keeps command meaning, route/reader composition and its
document listener, so these extractions follow resource lifetimes without
creating a second application controller.
