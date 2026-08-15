# Continuous matches implementation plan

Status: accepted implementation plan, 2026-08-13.

This plan replaces the Matches place's bounded 50-row result table with one
continuous, corpus-order surface containing every occurrence of every enabled
match term. Scrolling the surface and moving the shared footer reading
cursor are two controls for the same declared-sequence position.

The implementation remains local, bounded, snapshot-fenced, and source
honest. “Continuous” describes one logical result, not one unbounded DOM or
wire payload.

## Product contract

- Rows are ordered by declared document order, document-local token start,
  span length ascending, enabled-track order, and member ordinals. This keeps
  the current KWIC deterministic finals. The raw occurrence vectors use a
  different same-start order (span descending), so the new merge must make
  this final ordering explicit rather than inherit occurrence emission order.
- One track occurrence remains one row. Occurrences that share a token start
  are not collapsed: they may have different spans, members, labels, styles,
  node text, or Reader provenance. Consecutive rows may therefore share one
  footer cursor position.
- The surface is a full-ready-corpus reading and navigation surface. A linked
  analytical range is highlighted but does not filter the rows. This matches
  Reader and exact occurrence stepping, whose full-corpus axes cannot be
  narrowed by a linked analytical selection.
- The usable Matches viewport excludes application chrome, Matches
  controls, compact Lens reservation, safe areas, keyboard inset, and the
  fixed reading footer. A horizontal “now” line stays at the midpoint of that
  scrollport.
- The scroll range includes bounded corpus-start and corpus-end sentinels. At
  the top the now line represents the first token of the first non-empty ready
  text; at the bottom it represents the last token of the last non-empty ready
  text. The first and last occurrence each remain separately reachable at the
  now line one half-row interval inside those sentinels. No spacer is
  proportional to the source gap before or after an occurrence.
- Sparse source gaps are compressed. Scrolling is paced by occurrence rank;
  one row interval traverses the source gap linearly rather than representing
  absence as many blank rows.
- The initial continuous surface has fixed-height aligned rows. Complete
  source context remains available to assistive technology and through the
  Reader. The variable-height wrapped mode is removed rather than introducing
  estimated-height drift into the bidirectional coordinate mapping. A future
  explicit row expansion may reintroduce visible wrapped context without
  changing the base geometry.

## Existing bounds and reusable authorities

Each enabled term already resolves to a `NumericOccurrences` value ordered by
`(docOrdinal, pos)` and admitted to the shared executor cache only after order
validation. One term is capped at 200,000 occurrences; at most five terms are
active, so a merged match set contains at most 1,000,000 rows. The existing
occurrence cache remains the only owner of full occurrence vectors and retains
its five-entry, 48 MiB simultaneous ceiling.

Full-corpus Matches windows contend with range-scoped trend/dispersion
entries when a linked selection is active. With five terms, alternating the two
selection families can evict all five entries and make a window refill rebuild
occurrences. The initial implementation keeps the existing hard ceiling but
does not assume every refill is a cache hit: it benchmarks this explicit
five-term selection-thrash case. If measured interaction latency misses the
budget, cache capacity may increase only with a simultaneous justified byte
ceiling; a hidden second cache is not permitted.

The footer's `SequenceLayout` remains the sole declared-sequence axis:
document bases, token counts, and total corpus tokens are not redeclared by
Matches. The existing shared `scrub` target remains the sole current
reading position. The footer passage lane remains independently
single-flight/latest-pending and continues to authenticate source around that
position.

## Core kernel

Add a pure corpus-order Matches kernel over one to five already ordered
occurrence vectors. It performs a bounded k-way merge without sorting or
materializing the complete merged result.

The kernel produces:

1. an exact total and a sparse rank-to-global-token table sampled at
   duplicate-run boundaries at least every fixed stride (initially 128 rows);
   and
2. a materializable window addressed either by corpus position or logical
   occurrence rank.

For every non-empty result, the first sample is emitted at rank zero. At the
one-million-row ceiling, each later sample is emitted only at the first row of
a new `(document, token)` run after at least 128 rows since the previous sample.
Each sample carries its exact rank and global token in two fresh `Uint32Array`
values. A duplicate run has at most one match per declared member in each of
five tracks, hence at most 160 rows under the 32-member group cap. Consecutive
samples are therefore separated by at most `stride + 159` rows, and the table
contains no more than 7,813 entries (about 61 KiB). It never samples inside a
run, so binary-searching every track to the sample token reconstructs the
sample's exact merge frontier. Output arrays are copies, never views into
cached occurrence buffers.

Position addressing binary-searches each track to establish the merge
frontier. Rank addressing selects the preceding sparse sample, binary-searches
each track to its run-boundary token, and walks at most `stride + 159` rows to
the exact rank. A window then merges at most the requested 500 rows. Deep and
shallow windows therefore have the same bounded *planning* cost after
occurrence lookup; a cold occurrence-cache miss can still pay the bounded
construction cost described above. The current `offset + limit` top-K heap is
not reused.

The deterministic tie order is:

1. document ordinal;
2. token start;
3. span length ascending;
4. track ordinal; and
5. member ordinals lexicographically.

This preserves every mention and makes duplicate-position behavior stable.
Context strings and member arrays are copied only for the returned window,
using the existing verified-text KWIC materialization boundary.

## Worker operation

Add one `matches-window/1` query operation. It carries enabled tracks and a
bounded request:

- anchor by `{ kind: 'position', doc, token }` or `{ kind: 'rank', rank }`;
- bounded rows before and after the anchor, whose total is at most the existing
  `KWIC_MAX_PAGE` of 500; and
- the existing context-token width; and
- a stateless `includeAxis` flag, set when the caller does not already retain
  the sparse table for the request's snapshot and ordered track identity.

The caller cannot provide a linked selection. The engine constructs the
canonical full-ready-corpus selection, as it already does for Reader pages and
exact occurrence stepping.

The result contains the exact total, exact anchor rank, first returned rank,
materialized rows, and, when `includeAxis` is set, the sparse rank/token samples
for the current snapshot/track identity. For a position anchor, `anchorRank` is
the first row at or after that position (or the last row at the corpus end), and
the window also identifies the preceding distinct-position bracket as both rank and
global token. Those brackets let the client place the unchanged source cursor
at an exact fractional rank, including when the requested window has no row
before the anchor; the worker never snaps the shared cursor to an occurrence.
The executor may cache the small sparse table beside the occurrence cache
under explicit entry and byte ceilings. The store retains the table for the
current snapshot/track identity, so later window responses omit it unless that
identity changes. The explicit request flag makes that omission stateless; no
opaque worker handle or second occurrence-vector lifecycle is introduced.

Executor checkpoints follow the existing KWIC discipline: after resolver
preparation, after each track occurrence lookup, after numeric planning, and
after materialization. Every output typed array is freshly allocated before it
is transferred or cloned; resident occurrence buffers are never transferred.

## Store lifecycle

Replace the centered KWIC lane with a Matches intent/window lane fenced by:

- snapshot identity;
- ordered enabled series IDs and their matching identities; and
- the full-corpus selection constructed by the engine.

The store retains the sparse axis and a bounded current window. A latest-wins
window request is issued when an external cursor lies outside the resident
overscan or scrolling nears a window edge. Scrolling within a resident window
issues no analysis query.

The following nearest-page machinery is removed:

- the private KWIC center and timer;
- `KWIC_CENTER_DEBOUNCE_MS`;
- scrub-triggered result invalidation and delayed nearest-50 queries; and
- center/bucket caption state whose only purpose was to describe a proximity
  result.

`setScrub` continues to validate and publish the shared cursor and schedule the
footer passage. It no longer schedules Matches analysis. Exact occurrence
stepping, Trends/barcode activation, Reader marks, footer pointer movement,
and keyboard movement all converge on `setScrub`; the mounted Matches
surface follows that state.

Changing a linked range no longer reissues Matches. Changing snapshot,
enabled-track membership, or a track's matching semantics does.

`centerKwicAt` currently has two responsibilities beyond centering. Clearing a
linked range for an activation outside it is removed: a full-corpus navigation
surface must not destroy an analytical brush. Re-enabling the activated track
is retained before publishing the cursor, because otherwise the requested
occurrence may not exist in the enabled Matches result. The action also
publishes a one-shot Matches reveal target containing series, document,
token, and exact occurrence provenance when available. Density-bucket
activation is the exception: its midpoint publishes only the shared cursor and
no reveal target, because a bucket midpoint is not an exact occurrence and
must remain an honest between-row position. A reveal target is navigation
intent, not a second reading cursor: it disambiguates an occurrence row from a
corpus-edge sentinel or sibling row sharing the same token, then is consumed
when the matching window lands whether or not that window still contains a
matching row. It is fenced by snapshot and ordered track identities and is
cleared on any incompatible intent change, so it cannot fire against a later
unrelated window. Raw footer scrubbing carries no reveal target and therefore
maps an endpoint token to its corpus sentinel. Exact occurrence
stepping already collapses a same-token cluster into one reading stop; when no
more specific provenance exists, Matches deterministically selects the
cluster's first row and therefore skips rows two through N of that cluster by
design.

## Scroll geometry

The pure view geometry maps among:

- global corpus token;
- exact or interpolated logical occurrence rank;
- capped physical `scrollTop`; and
- a visible/overscan rank interval.

The physical scroll range is:

```text
min(totalRows × fixedRowHeight, SAFE_SCROLL_EXTENT)
```

The corresponding logical cursor coordinate spans `0…totalRows`: `0` is the
corpus-start sentinel, occurrence row `i` is centered at `i + 0.5`, and
`totalRows` is the corpus-end sentinel. Sentinels are cursor coordinates, not
rendered rows. For a corpus with mentions, this gives both edge sentinels and
every row a distinct reachable now-line position without adding another full
row interval. Zero rows produce a zero physical range; empty documents own no
token coordinate; and a one-token corpus may legitimately give a sentinel and
occurrence the same source token while keeping their scroll coordinates
distinct.

`SAFE_SCROLL_EXTENT` is an application constant initially set below browser
layout-coordinate limits and covered by browser tests. At ordinary totals,
one physical row pitch equals one logical row pitch. At extreme totals, the
native scroll range is compressed while rendered rows keep their normal fixed
height around the current fractional rank.

The scrollport contains a bounded physical plane and an absolutely positioned
visible table overlay. The overlay's anchor row stays on the now line; it does
not depend on a proportional million-row spacer. The native scrollbar remains
visible and represents the entire logical result.

Within a resident window, rank/token mapping is exact. Outside it, sparse
samples provide an immediate monotone approximation while the latest exact
position/rank window settles. Exact results may correct by at most one sample
interval (`stride + 159` rows). Corrections are anchored at the now line and
must never oscillate.

For repeated token positions:

- scrolling through consecutive duplicate ranks leaves the footer cursor at
  the shared token; the following row interval then interpolates linearly to
  the next distinct token; and
- generic external cursor movement chooses the leftmost logical coordinate at
  that token deterministically (normally the cluster's first row, but the
  start sentinel at the corpus's first token). A one-shot occurrence reveal
  instead selects the first row matching its series/token/provenance under the
  normal finals.

For an external cursor in a source gap, the visible rank is fractional between
the preceding and following distinct token positions. The footer cursor is not
snapped or rewritten; Matches positions its row overlay so the now line
lies proportionally between those rows while requesting an exact surrounding
window. The corpus-start/first-row and last-row/corpus-end intervals apply the
same interpolation against the explicit sentinels. User scrolling publishes
the corresponding interpolated token, so the two directions are true inverses
apart from integer-token rounding.

No-result state disables the scroll mapping and leaves the shared cursor
untouched. Resize and font settlement preserve logical anchor rank, never raw
`scrollTop`.

## Feedback fencing

Scroll input is sampled once per animation frame. The frame resolves the now
line's logical rank to a source position and calls `setScrub` only when the
source position differs from the current store cursor.

External cursor changes map back to physical scroll position imperatively.
The surface records the target rank, ignores the matching programmatic scroll
event for one frame, and applies a sub-pixel tolerance. Programmatic movement
is never smooth while the footer is being scrubbed. Comparing the self-published
rank and cursor makes the round trip idempotent without adding a second cursor
or a lock in the global store.

## Viewport and accessibility

The Matches place becomes a viewport-height grid/flex column. Application
header, status, term chips, context control, and result status occupy natural
rows; the Matches scrollport owns the remaining `minmax(0, 1fr)` above the
already reserved dock. Existing CSS custom properties remain the authority for
footer, Lens, safe-area, and keyboard reservations.

The now line is a pointer-transparent visual marker at 50% of the actual
scrollport. It is not an interactive control and is hidden from assistive
technology.

The virtual grid provides:

- a named scroll region;
- the existing Matches accessible name and column meanings using explicit
  `grid`, `row`, `columnheader`, and `gridcell` roles;
- `aria-rowcount` for the logical total;
- `aria-rowindex` for every rendered data row;
- a throttled status announcement with logical occurrence, book, and token;
- bounded overscan of roughly two to three viewports; and
- focus pinning so a focused occurrence control is not recycled until focus
  moves or is explicitly handed back to the scroll region.

The grid itself is the one focusable control and exposes the active rendered
row through `aria-activedescendant`; DOM focus never chases recyclable rows.
This deliberately differs from the existing roving-tabindex
`useRowNavigation` hook, which requires stable row buttons and is unsuitable
for recycling. The virtual-grid controller reuses the pure
`rowNavigationTarget` and `visibleRowPageSize` helpers and the existing `Rows`
shortcut group, while owning only active-descendant focus retention.
Up/Down and j/k move one logical occurrence, Page Up/Down move by the rendered
viewport, and Home/End move to first/last occurrence; every movement updates
the shared cursor and requests a window when necessary. Tab enters and leaves
the grid once instead of traversing up to one million buttons. Enter opens
Reader at the active occurrence. The active row remains pinned until
navigation settles, so its referenced DOM ID cannot disappear underneath
assistive focus.

Only visible and overscan rows are mounted. Horizontal node-column alignment
remains one shared scrollport concern and is not recomputed on each cursor
frame.

## Verification gates

Core tests cover:

- one-to-five-track merge order;
- same-token occurrences within and across tracks without information loss;
- the maximum 160-row same-token cluster;
- phrase spans and member provenance;
- exact deep-rank and position windows against a fully merged oracle;
- sparse-sample boundaries, including a duplicate-token run straddling a
  sample, and both occurrence bounds;
- empty results, foreign snapshot/selection rejection, and page bounds; and
- equivalence of shallow and deep window semantics.

App unit tests cover:

- sparse interpolation and exact correction;
- duplicate-token inverse rules;
- gap-token inverse rules that never rewrite the footer cursor;
- global-token/document conversion through `SequenceLayout`;
- physical extent capping and fractional-rank mapping;
- zero-row, empty-document, and one-token-corpus sentinel geometry;
- visible/overscan bounds;
- first/last-row centering;
- resize anchor preservation; and
- feedback-loop tolerances.

Browser tests cover:

- scrolling changes footer slider value and source position;
- footer pointer and keyboard scrubbing move the Matches surface;
- occurrence stepping and Reader/Barcode activation land on the correct row;
- scrolling inside a resident window posts no query;
- term toggles and matching edits fence stale windows;
- the now line is within one CSS pixel of the usable viewport midpoint across
  compact, regular, wide, coarse-pointer, and keyboard-inset layouts;
- DOM row count remains bounded for a large logical result;
- focus and grid row metadata survive recycling;
- active-descendant keyboard navigation reaches off-window and first/last
  ranks; and
- continuous scrolling introduces no long task at or above the existing
  100 ms gate.

Performance benchmarks record sparse-index construction at the occurrence cap,
deep-window latency on warm and five-term selection-thrashing caches,
scroll-to-cursor publication, and retained DOM count. Budgets are set from
corrected local samples before becoming CI gates.

## Focused commit sequence

Every candidate is staged exactly and receives an independent Claude Opus
review before commit.

1. `docs(matches): plan continuous corpus-order scrolling`
   Records this architecture and its product/verification contracts.
2. `feat(core): add bounded matches windows`
   Adds sparse sampling, exact position/rank lookup, k-way window planning,
   materialization, exports, and core tests. No app caller changes.
3. `feat(worker): expose full-corpus matches windows`
   Adds the wire/domain contract, runtime narrowing, executor/engine path,
   transfer discipline, cache/checkpoint tests, and cancellation coverage. It
   remains additive. The new closed query-union contract is updated in
   `analysis-contract.md` in the same commit.
4. `refactor(matches): adopt cursor-window state`
   Cuts the store from nearest-50 queries to snapshot/track-fenced sparse axis
   and window state, removes scrub-triggered KWIC work, makes scope
   full-corpus, and updates store races/navigation tests while retaining a
   non-virtual transitional row rendering. It also rewrites every browser
   assertion coupled to the `kwic` wire operation, the linked-range reissue
   set, range-scoped Matches row counts, or the proximity caption (barcode,
   compact-barcode, Matches, footer, notebook, only-this-book, scope,
   selection, and slice-2 acceptance specs). The linked-selection rule in
   `analysis-contract.md` changes in the same commit.
5. `feat(matches): add synchronized virtual scrolling`
   Adds pure scroll geometry tests, the aligned virtual table, capped physical
   plane, now line, rAF bidirectional synchronization, viewport layout, focus
   retention, active-descendant keyboard navigation, and unit/browser
   acceptance. It also
   removes the wrapped toggle so no variable-height mode can violate the fixed
   geometry and rewrites every browser locator or assertion coupled to
   `role="table"`, `tbody tr`, or the old per-row buttons for the
   grid/virtual-row contract (including Matches, compact, EPUB, Reader,
   HTML, selection, keyboard-navigation, slice-2/3 acceptance, range-reset,
   only-this-book, presentation, and notebook specs). It updates
   `workbench-ux.md` in the same commit.
6. `refactor(matches): remove legacy proximity presentation`
   Removes remaining proximity-only core/app paths, records the final product
   decision, and lands final large-result performance and accessibility gates.

## Final product decision

Accepted 2026-08-13: Matches has one continuous, full-corpus, corpus-order
surface. The former proximity-sorted `kwic` operation and aligned/wrapped
presentation split are removed rather than retained as hidden compatibility
paths. Exact barcode activation selects its occurrence rank; density activation
publishes only the shared corpus cursor. Neither changes the ordering model.

The shipped contract is therefore `matches-window/1` plus its sparse axis,
bounded resident rows, fixed-pitch virtual grid, and bidirectional shared-cursor
mapping. Linked analytical selection remains an overlay only.

Each implementation commit must pass its targeted unit tests, repository
typecheck, and the relevant browser slice before staging. Review findings are
fixed in the same candidate and the exact staged tree is reviewed again when a
material correction changes its risk.
