# Linked selection + dispersion barcode + full reader — Slice 2 plan

*Slice 2 of the adopted build order (synthesis §11 addendum). Branch
`feature/product-slices`. The governing Codex planner ruling
(`req_consult_6244abb003b20371`, Parley session `ses_44293cff245eacef`) is
recorded below VERBATIM. Commit sequence A–I is the implementation order;
every commit gets a Codex review-diff. NOTE: this ruling CORRECTS the
backlog checkpoint — slice 2 (not 3) is the first new QueryOp and triggers
the simplification-plan F1 QueryExecutor gate plus the staged G2 fixture
support, before either new operation lands.*

**STATUS: COMPLETE (2026-07-29).** The full slice landed on
`feature/product-slices`, with every implementation tree reviewed by Claude
Opus through Parley and ending `looks-good`: A `c9fe8c1` (shared real-hash
fixtures, 2 rounds), B `bf058fe` (generation-bound QueryExecutor, 1), C
`9f1ee54` (`dispersion/1`, 3), D `2f42c5d` (barcode/KWIC, 3), G `8ee6a31`
(canonical `reader-page/1`, 3), E1 `1886bae` + E2 `28e55f3` (linked-selection
store/UI, 2 + 1), F `8fece64` (captured pins, 1), H `a95def5` (lazy full
reader, 1), and I `6798768` (browser acceptance, 1). Phase-end matrix:
typecheck clean; core 420 + web 540 unit tests; Chromium functional 43/43;
serial benchmark 3/3; bundle contract OK with entry 69,555 B gzip and the
reader UI in a 2.63 kB lazy chunk. The deterministic acceptance journey
proves multi-member semantics → exact dispersion/KWIC → one linked range
across trend/barcode/counts/KWIC → captured pin → canonical reader
forward/back → baseline restoration. Durable pins/selections, notebook
persistence, and char-anchor migration remain deliberately deferred to the
versioned share/persistence slice.

---

Ruling: approve Slice 2, and treat it as the trigger for the deferred F1 gate now. The slice is not complete without all four product outcomes: a bounded dispersion barcode, one linked range selection propagated to analytical detail, pinnable passage evidence, and a genuinely page-through-the-document reader. It is acceptable to land pins and click-through before the reader as intermediate commits; it is not acceptable to defer the reader to another slice while calling Slice 2 complete.

Two distinctions govern the design:

1. A barcode is a bounded visualization result over the existing occurrence primitive; it must not expose an unbounded “dump every occurrence” transport.
2. A transient token selection is a snapshot-bound execution intent; it is not the durable, char-anchored `Brush` from the analysis contract.

## 1. Barcode data and the QueryExecutor gate

Slice 2 is the first new `QueryOp`. The backlog sentence saying Slice 3 triggers D3/G2/G3 was based on the mistaken premise that the barcode already had a public occurrence result. Correct that checkpoint. Land the narrow G2 fixture support and extract `QueryExecutor` before adding the new operation. Do not defer F1 to the stats slice and do not add a “temporary” fourth analysis branch to the current engine dispatcher; that is exactly the path the just-in-time ruling forbids.

Keep the F1 seam narrow:

- A generation-bound `QueryExecutor` owns trend/KWIC/passage and then dispersion/reader execution, resolver reuse, and query-derived occurrence caches.
- It receives a read-only published snapshot view, bound shards/text, a narrow resolver loader, and an injected async checkpoint.
- The engine retains job ownership, active/cancelled bookkeeping, generation/snapshot validation, error mapping, transfer-list emission, and a final gate immediately before every emit.
- Structure, structure-edit-context, line-excerpt, ingest, and user-data handling stay in the engine/handlers; do not widen this into a generic worker framework.
- The occurrence cache remains generation-scoped and bounded at five entries. A selected view can evict a full-corpus entry and later recompute it; an in-flight query’s retained reference remains valid.

Use a new operation named `dispersion`, with method/result discriminator `dispersion/1`, rather than a public unbounded `occurrences` op. Its implementation must consume the same `NumericOccurrences` returned by `occurrencesFor`; it must never resolve members or interpret overlap semantics independently.

The result should be adaptive per track:

- For a track with at most `DISPERSION_EXACT_MAX = 50_000` occurrences, return exact document-local start positions and `spanTokens`, grouped by document with typed-array offsets. Keeping the span makes a clicked phrase/merged occurrence an exact piece of evidence rather than merely a point.
- Above that threshold, return honest density buckets, not sampled or silently dropped ticks. Use shared bucket geometry plus a track-major `Uint32Array` of counts and exact per-track totals. A fixed `DISPERSION_BUCKET_BUDGET = 4_096`, allocated across at most 64 selected documents with at least one bucket per nonempty document and the remainder token-proportionally, is bounded and sufficient for a high-DPI canvas.
- A rare track remains exact when a different track is dense; representation is per track. At five tracks the worst exact payload is approximately 2 MiB for starts plus spans, transferred once per query intent—not once per redraw. That is acceptable. A 50,000-hit common term is about 400 KiB for those two arrays and should remain exact.
- The result must identify each track by the request’s presentation ID and group ID and echo its exact total and representation. Density mode must be labeled “density” in the UI; never render one bucket as if it were one occurrence.
- Bucket geometry remains in full document coordinates even for a ranged selection; counts reflect only selected occurrences. That makes a selected layer align with the unchanged overview axis.

The request should carry the fixed resolution policy explicitly or bind it through exported `dispersion/1` constants validated by the protocol; no component-local magic numbers. Resize and redraw operate entirely on the resident result and must not issue another worker query.

Do not transfer the occurrence-cache arrays themselves. Pack fresh exact-result buffers and transfer those, preserving the worker cache. Density packing over millions of occurrences must be stepped/ranged with a checkpoint every bounded chunk; a new monolithic loop would violate the cancellation discipline even if the existing occurrence pass is currently synchronous. Benchmark rare, 50k-exact, and over-threshold density cases.

Click semantics:

- An exact tick centers the existing merged KWIC immediately at its exact `(doc, start)`; no 150 ms hover debounce.
- A density bucket centers KWIC at the bucket midpoint. The UI says “nearest occurrence to this bucket” and reports distance when the first row is not at the midpoint, consistent with the synthesis evidence rule.
- Multiple exact occurrences at the same start remain multiple entries/counts even if they paint the same pixel. KWIC remains the detailed evidence surface.

Render the strip on 2D canvas with an HTML/SVG overlay for document bounds, labels, focus, and the selection. Never create one DOM node per occurrence. Provide an accessible per-track/document summary and Previous/Next occurrence controls in exact mode; density mode exposes bucket totals and the same nearest-KWIC action.

## 2. Linked selection model and panel behavior

Adopt one store-owned, transient selection:

```ts
interface TokenRangeSelectionV1 {
  readonly snapshot: string;
  readonly doc: string;
  readonly tokens: { readonly start: number; readonly end: number };
}
```

It is single-document in v1, half-open, nonempty, and snapshot-bound. Capture the current generation/snapshot identity in the owning store intent even if the public shape stores only the snapshot ID. Clear it on snapshot publication/replacement, project reset, or removal of the document. Rename/member changes do not clear it.

Do not persist this object and do not call it a `Brush`. The durable contract object is char-anchored with `TextHash` precisely so tokenizer/recipe changes can be handled honestly. Saving one requires a worker conversion from the token range to char anchors plus a class-1 project/share schema. Defer “Save selection as brush” to the persistence/share slice. A future compile must reject a text-hash mismatch rather than guessing. Token coordinates from an old snapshot are never durable authority.

Create one pure `detailSelection(snapshot, linkedSelection)` builder:

- no linked selection → `{ docs: allReadyDocs }`;
- linked selection → `{ docs: [doc], ranges: [{ doc, tokens }] }`.

The `[doc]` is load-bearing. Sending every ready document plus one range would mean “that range in this document and every other document in full,” because an absent per-doc range means whole document. Pin that exact bug with a unit test.

Separate preview from committed intent. Pointer motion and keyboard extension update component-local preview only. Commit once on pointer-up/Enter; cancel on Escape. A click without a drag remains the axis-pin gesture. Do not issue selected queries per pointer frame.

For pointer input, capture on down, begin a brush after a small movement threshold, clamp the endpoint to the origin document, and convert inclusive endpoint tokens to a half-open range. Crossing a book boundary does not create a multi-document range. Hover with no pressed button continues to scrub. For keyboard input, use an explicit selection mode: start at the scrub cursor, arrows move the endpoint, Enter commits, Escape cancels. Do not overload the existing Shift+Arrow fast scrub ambiguously without an announced mode.

“Every panel filters” should be implemented without destroying the overview that authored the brush:

- Trend remains the stable whole-corpus context. Add a separate `selectedTrends` lane/map and render its values as an overlay only where `binTokens > 0`; zero-denominator bins are gaps, never zero-rate observations. Shade the exact token range. Keep the existing baseline trend arrays and shared scale.
- Barcode retains the whole-corpus strip as dim context and issues/renders a selection-specific dispersion layer over it. In exact mode the component could filter locally, but a second result is still required for dense mode; use one consistent path.
- KWIC reissues against `detailSelection`, so every row and its `total` is inside the range.
- Notebook counts remain corpus totals; while a range is active, show the selected count separately as “N selected / M corpus” rather than silently relabeling the existing number.
- Passage is a point inspector, and the reader is a navigation/context surface. They show the current range boundary/shading when it intersects the served text but do not hide prose outside it.
- Slice 3 inventory/statistics consumers must use the same `detailSelection` helper rather than inventing another selection state.

Thus every aggregate/detail result consumes the selection, while the trend/barcode baseline and full reader remain explicit context. This is more honest than morphing the source chart or pretending an unreadable excerpt is the entire selected universe.

Use separate latest-wins lanes for selected trends and selected dispersion; KWIC keeps its existing lane. Every commit guard includes generation/snapshot, the canonical wire selection intent (or resolved selection hash as echoed provenance), ordered track IDs, and each track’s `termGroupIdentity`. Rapid brush A→B, clear-during-pending, active-group edits, and snapshot replacement must never admit A under B’s shading.

Clearing a brush immediately drops selected overlays and reissues KWIC for the baseline selection. It does not recompute the already-resident baseline trends/barcode. Switching series/by-book view preserves the token range.

When a barcode/reader occurrence outside an active range is deliberately clicked, clear the range and announce that the selection was cleared before centering KWIC. Otherwise the clicked occurrence could not appear in the filtered concordance. Inside-range clicks preserve the range.

## 3. Reader scope

Ship a full-document, one-document-at-a-time, cursor-paged reader in this slice. Reject both shortcuts:

- Repeated passage blocks are center windows, not stable pages; char-cap shrinkage makes naïve next/previous arithmetic overlap or skip text.
- `line-excerpt` is a physical-line authoring aid with no token cursors, term marks, or document paging contract.

Add a second new operation, `reader-page/1`, after QueryExecutor and dispersion are established. A suitable request is:

```ts
interface ReaderPageRequest {
  readonly doc: string;
  readonly cursor:
    | { readonly kind: "around"; readonly token: number }
    | { readonly kind: "from"; readonly token: number }
    | { readonly kind: "before"; readonly token: number };
  readonly maxTokens: number;
  readonly tracks: readonly ReaderTrack[];
}
```

Allow zero tracks so reading does not depend on the notebook. Cap tracks at five and use exported limits such as 400 requested tokens, 32 Ki UTF-16 text, and 5,000 marks. The worker shrinks a page honestly to all caps, always retains the requested anchor in `around` mode, and reports which cap applied. A single token exceeding the text cap produces a typed cap error; never slice through a token silently.

The result carries:

- absolute document token and character ranges;
- bounded authenticated text and relative token offsets;
- stable previous/next cursors (`before(currentStart)` and `from(currentEnd)`) so paging neither skips nor relies on client arithmetic;
- the around-anchor’s relative location;
- per-track occurrence marks with absolute occurrence token span, contributing members, clipped relative char span, and explicit `clippedStart`/`clippedEnd`;
- document token count and end-of-document state.

Build reader marks from the shared cached `NumericOccurrences` for the base full-corpus selection, then binary-search the relevant document/page slice. Do not re-run a page-local matcher. This preserves `countOverlaps`, merged-span, and member-evidence semantics and catches an occurrence that begins before a page but intersects it. A cross-page occurrence is rendered with an explicitly clipped mark; it is never silently omitted or presented as a complete span. Clicking it opens the existing KWIC row for the full occurrence.

The reader is a lazily imported drawer/panel so its UI does not inflate the initial entry chunk. Open it from:

- any KWIC row at `row.pos`;
- an exact barcode tick, or the nearest returned KWIC row for a density bucket;
- a pinned snippet at its anchor;
- the passage/context pane’s “Open reader” action.

Reader state is transient and store-owned. Page requests have their own latest-wins lane guarded by snapshot, document, cursor, and current track semantic identities. Next/Previous clicked rapidly cannot display an older page under the new cursor. A group rename changes labels without requery; active/member/overlap changes reissue the current page’s highlight projection. Snapshot replacement closes the reader. Opening from an evidence row must carry the row’s served snapshot identity; a stale row can never open against a new snapshot.

The page shows document title, absolute token range, Previous/Next controls, a close action, current-query highlight legend, linked-selection boundaries, and selectable prose. It must preserve whitespace safely as text, never mount source HTML.

## 4. Pinned snippets

Adopt pins in this slice as bounded session store state rendered in a context pane beneath the chart. A click on the axis with no drag creates a pending pin at the exact snapshot/doc/token, uses the existing bounded passage operation, and resolves to a snippet with marks. If the already-loaded passage serves that token, derive the pin immediately without a round trip.

Set `MAX_PINNED_SNIPPETS = 8`. A ninth pin is refused visibly; do not silently evict a user’s evidence. Pinning the same snapshot/doc/token focuses the existing pin rather than duplicating it. Removing a pending pin cancels its request. Clear all pins on snapshot replacement because their token anchors are not durable.

Each resolved pin captures the served snapshot, anchor, title/doc, passage range/text/marks, and the track labels plus semantic identities under which the marks were produced. Treat that as immutable captured evidence and label it “captured with …”; a later group edit must not silently reinterpret old marks. “Open reader” uses the place with the current track set. Durable pins later use the same char-anchor/TextHash migration as durable brushes, not this token object.

Pending pins are independent intents, not one latest-wins lane: a user may pin two positions before the first settles. Give each item its own operation lease/cancel handle under the store’s lifetime scope. A removed pin, old snapshot, or disposed runtime cannot resurrect.

## 5. Commit sequence and verification

Use nine reviewed commits. Record this ruling in `docs/design/linked-selection-plan.md` and correct the backlog’s “Slice 3 triggers F1” checkpoint before implementation.

### A. Test support and seam alignment

Land only the narrowly approved G2 support: memoized valid canonical recipes/hashes and one visible-default `GenerationDocSpecV4` builder. Keep malformed hashes, cap edges, and boundary violations local. Move user-data behavior to `user-data-handler.test.ts`; retain engine routing assertions.

Invariants: fixtures cannot manufacture invalid-by-default production inputs; no production behavior changes.

Verification: root typecheck and all unit suites.

### B. Generation-bound QueryExecutor

Extract trend/KWIC/passage semantics and the occurrence/resolver cache behind the narrow seam above. Move those semantic tests to `query-executor.test.ts`; keep engine tests for dispatch, final gates, error mapping, generation replacement, cancellation bookkeeping, and emission/transfer behavior.

Invariants: byte-for-byte-equivalent domain results, the same five-entry cache discipline, no executor access to engine lifecycle state, and a final engine gate after executor return.

Verification: typecheck + all units; production build and bundle check; focused dense-KWIC/cache/cancel benchmarks and engine race tests.

### C. `dispersion/1` core, protocol, executor

Implement exact/density planning, stepped density packing, runtime narrowing, typed results, transfer lists, and query-executor routing. Add no UI yet.

Invariants: totals equal the source occurrences; exact arrays preserve order/multiplicity/span; density bucket sums equal totals; bucket geometry covers each selected document without overlap/gaps; no cached buffer is detached; output is bounded.

Verification: typecheck + units; production build + bundle gate; rare/50k/dense benchmarks; cancellation at packing checkpoints; malformed/cap/schema and snapshot/selection identity tests.

### D. Barcode surface and mark-to-KWIC

Add the base dispersion store lane and canvas barcode in both trend layouts, exact/density labels, accessible summaries/navigation, focus styling, and immediate click-to-KWIC. Resize is presentation-only.

Invariants: barcode and trend use identical groups/selection/occurrence-start placement; no DOM-per-hit; exact and dense clicks describe what they actually target.

Verification: typecheck + units + production build/bundle; targeted Playwright for tick→correct merged KWIC and resize-without-query. Exercise density interaction in deterministic unit/component fixtures rather than creating a huge browser corpus.

### E. Linked token selection

Add the pure selection model/builder, pointer/keyboard preview and commit, range shading, selected trend overlays, selected dispersion, selected/corpus counts, and KWIC filtering.

Invariants: one nonempty half-open doc range; no queries during preview; the selected wire spec contains only that document; baseline evidence is retained; zero-denominator bins are gaps; all lanes reject stale selection/track/snapshot results.

Verification: typecheck + units + production build/bundle; job-correlated Playwright for rapid A→B with delayed A, clear while pending, snapshot replacement, pointer brush, keyboard brush, and exact KWIC containment.

### F. Pinned context pane

Add independent bounded pin intents, immediate reuse of a serving passage, pending/error/ready/remove states, captured-query labels, and reader placeholders/actions.

Invariants: eight means eight with visible refusal; no FIFO eviction; duplicate location focuses; removed/old-snapshot pins never land.

Verification: typecheck + units; targeted job-correlated Playwright for click-to-pin, two overlapping pending pins, remove-before-result, and snapshot clear; production build/bundle.

### G. `reader-page/1` core, protocol, executor

Implement bounded forward/backward/around paging, exact cursors, cached-occurrence mark slicing, edge clipping, caps, runtime schema, and executor routing.

Invariants: adjacent next/previous pages have exact token boundaries with no client-guessed gaps; around contains its anchor; all text is authenticated and bounded; marks retain occurrence identity across page edges; zero-track reading works.

Verification: typecheck + units; production build/bundle; long-token, text-cap, mark-cap, phrase-at-boundary, first/last/empty-doc, cancellation, and dense-page benchmarks.

### H. Full reader UI and links

Add the lazy reader drawer, navigation, highlights, selection shading, and open paths from KWIC/barcode/pins/passage. Reissue current-page highlights on semantic active-track changes.

Invariants: displayed page identity always matches the live cursor/snapshot/track projection; rapid navigation cannot flash an old page; stale evidence cannot open against a replacement snapshot; source markup is never mounted.

Verification: typecheck + units + production build/bundle; job-correlated Playwright for KWIC→reader, pin→reader, barcode→reader, rapid Next/Previous, semantic edit, and snapshot replacement.

### I. Slice-2 browser acceptance

Add one deterministic end-to-end journey: create a multi-member group; observe exact barcode totals; click a tick into KWIC; brush a range and prove trend overlay, barcode layer, selected/corpus count, and every KWIC row are in range; pin an axis passage; open it in the reader; page forward/back without a gap; clear the range and restore baseline behavior. Include keyboard-only brush and reader navigation.

Verification: typecheck and all units, production build plus bundle contract, full functional Playwright matrix, then the serial benchmark project. No live network.

## Cross-cutting acceptance invariants

1. QueryExecutor lands before either new operation; the engine remains lifecycle and emission authority.
2. Trend, KWIC, passage, dispersion, and reader derive matches from one occurrence semantic and `termGroupIdentity`.
3. Public payloads are bounded; adaptive density is labeled and lossless in counts, never masquerading as exact ticks.
4. Occurrence-cache buffers are immutable and never transferred; only fresh result buffers move.
5. A committed selection is snapshot-bound, single-doc, half-open, and the only analytical-detail selection authority.
6. Preview gestures issue no queries. Every selected-result commit is fenced by snapshot, selection, ordered track IDs, and matching identities.
7. Baseline context never relabels as selected evidence; selected counts, rates, buckets, and KWIC all use the exact same range.
8. A deliberate occurrence click always yields a concordance capable of containing that occurrence; an incompatible existing range is visibly cleared first.
9. Pins and reader pages never outlive their snapshot. Pins capture their query semantics; reader highlights use current semantics.
10. Reader token ranges and marks are bounded and gap-free across servable pages; page-edge clipping is explicit. Text is token-bounded (inter-page separators are not served), and an oversized-token island requires an explicit out-of-band cursor to skip.
11. Pointer and keyboard users can brush, pin, inspect marks, clear selection, and page the reader; canvas ticks have an HTML evidence path.
12. The initial entry gzip budget, lazy SE/extractor boundaries, worker split, and catalog-chunk exclusion remain enforced. The reader UI stays lazy.

The main missed risks are: (a) `ranges` plus all ready docs does not mean “only this range”; it leaves every other document fully selected, (b) transferring cached occurrence arrays would detach the cache, (c) a centered passage cannot be advanced as a page when char caps shrink it, and (d) page-local matching loses occurrences crossing page boundaries. The plan above pins each one at the contract level before interaction work.
