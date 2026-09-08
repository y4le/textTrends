# Application composition

One composed Zustand runtime projects immutable `ProjectSession` publications
and issues bounded queries. The session owns source admission and generations;
corpus arrays and source text remain behind the worker boundary.

## Ownership

| Module in `apps/web/src/lib` | Responsibility |
| --- | --- |
| `app-state.ts` | Type-only shared contracts; no runtime values/imports |
| `app-defaults.ts` | Initial analytical preferences |
| `workspace-state.ts` | Durable projection, unavailable-source references, exact referential prefilter for semantic saves |
| `workspace-persistence.ts` | Connection, hydration baseline, debounce, retry pause, restore suspension/drain, stale-save fencing, visibility flush, disposal |
| `navigation-controller.ts` | Initial URL normalization, layer registry, Back/Forward, history writes, focus return |
| `store.ts` | Runtime composition, session bridge, notebook actions, query/Reader interaction |

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

`TrendPanel` derives data and composes controls. `trends/ScrubSurface` owns
pointer, keyboard, touch range, and cursor interaction; its parent does not
subscribe to cursor motion and supplies stable chart children. `TrendCharts`
owns series/text rendering; `TrendRowResizeHandle` owns the sizing gesture.
Shared geometry and pointer types remain pure library modules.

`WorkbenchFooter` composes the strip; `footer/FooterInteractive` owns input and
navigation. `QuerySurface` composes Terms; `terms/TermControls` owns buttons and
actions. These boundaries preserve props, lifetimes, and pure gesture helpers.
Further Reader/query extraction must preserve initialization, ownership, and
disposal; [open work](../current-roadmap.md#architecture-follow-ups) records it.

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

Eager hidden-table queries remain deliberate pending measurement. Evaluate work
avoided, first-result time, and tab-switch latency together before changing
scheduling. Preserve lane-specific product policies rather than introducing a
generic registry to shorten the runtime. Current local evidence is in
[benchmarks](../benchmarks.md); it does not establish larger corpus tiers.

`provenance.ts` is a tested deferred capability without a production export
surface. Result completeness still needs a product decision. Portable source
and workspace restoration follows the [backup contract](../workspace-backup.md).
