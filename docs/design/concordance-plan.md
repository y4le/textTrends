# Concordance: nearest-to-axis + all-terms (kwic/2) — plan

Owner request (2026-07-22): the concordance shows the nearest examples to the current axis
position and includes all search terms by default, with per-term toggle on/off.

Planner ruling (parley consult `req_consult_1458236f5790b275`) recorded verbatim below;
governs the 3-commit split (core kwic/2 → protocol/engine → store/UI+browser).

---

Planner ruling: APPROVE WITH BLOCKING CORRECTIONS. Keep this as one `kwic` operation, but treat the changed semantics as `kwic/2`; do not implement the proposed five-way flattened full sort, and do not make no-center mode erase the existing L/R sort contract.

I verified the relevant current paths. `kwicPage` accepts one `NumericOccurrences`, allocates an index for every occurrence, fully sorts it, then materializes only the page. `occurrences` emits document-local starts in declared snapshot order. The v4 engine builds resolvers from `q.group`, computes one occurrence set, and has checkpoints only around those whole synchronous phases. The store issues one focused-series KWIC and `setFocus` reissues it. Also, the passage guard band is spatial block reuse, not an idle/settle debounce. `V1_CAPS.maxCorpusTokens` is `2^32 - 2`, so `sequenceTokenBase + pos` and its difference are exact JS integers, but a five-track full sort is not usefully bounded by the 500-row output cap.

1. Shape — EXTEND `kwic`; do not add an op and do not merge independently paged results on the main thread.

Use the wire shape `{op:'kwic', selection, tracks:[{seriesId,group}], request:{contextTokens,center?,sort,page}}`. Require 1..5 tracks and unique, nonempty `seriesId`s at the protocol boundary. Move the value 5 to one shared core/protocol constant and have the store's `MAX_SERIES` use that authority; do not leave a second hard-coded passage/KWIC cap.

This is a breaking request and ordering change, so document it as `kwic/2` even though the op discriminator remains `kwic`. Updating all in-repo v4 callers atomically is acceptable; do not preserve an ambiguous `group`-or-`tracks` dual shape.

Numeric layering must mirror passage precisely: `NumericKwicRow` gains only `trackOrdinal`, never a `seriesId` string. `materializeKwicPage` receives the exact ordered track table, validates every ordinal, and emits `seriesId`. The public row should also emit `groupId`; otherwise its member ordinals are not self-describing evidence once several groups share one result.

2. Ordering — YES for centered global proximity, with one correction for no-center behavior.

With a center, the total order is:

1. `abs((snapshot.docs[row.docOrdinal].sequenceTokenBase + row.pos) - (centerRef.sequenceTokenBase + center.token))` ascending;
2. the caller's existing `sort` keys, in order;
3. deterministic final keys: declared doc ordinal, occurrence start, span length, track ordinal, then member ordinals lexicographically.

Use occurrence start as the anchor, not nearest point of the span. That agrees with the existing trend/bin contract, which places an occurrence by its start. Validate that the center doc is in the snapshot and that `token` is an integer in `[0, tokenCount)`; never clamp a stale center.

An equal-distance hit on each side of a document boundary is not a semantic problem. Declared-sequence coordinates deliberately have no artificial inter-document gap, and the requested sort plus final keys make the result stable. With the store's `[doc asc,pos asc]` tie-break, the earlier/left occurrence wins the tie.

Blocking correction: when `center` is absent, the core must preserve the existing `sort` as the primary order, followed by the same deterministic final keys. The store should request `[doc asc,pos asc]`, which is declared reading order. Hard-wiring global position ahead of `sort` in no-center mode would silently make the currently supported L1..R3 sorts almost inert and break the `kwic/1` behavior for no product reason. “Reading order by default” belongs in the caller's request, not as an override of an explicit sort.

3. Merge/dedup — KEEP one row per `(occurrence, track)`; do not deduplicate across tracks.

A shared token/span matched by two enabled series is two independent pieces of tagged evidence and contributes two rows to `total`. Preserve each group's existing intra-track overlap/dedup semantics exactly as produced by `occurrences`; only cross-track dedup is forbidden. Add `trackOrdinal` to the final tie-break and include `seriesId` in React row identity, since the current `${doc}:${pos}` key would collide for these legitimate rows.

4. Paging and cost — PAGE after the true merged order, but do not concatenate and fully sort every candidate, and do not truncate a per-track prefix.

The returned page must be the exact global slice and `total` must be the sum of all track occurrence counts. A lossy “first N from each track” cap is rejected because it can discard the actual nearest rows.

Implement an exact bounded top-K selector: scan every candidate, retain the best `K = offset + limit` under the complete comparator in a max-heap, sort only those retained K, then slice at `offset`. This is exact, not approximate, and makes the normal UI request (`K=50`) independent of total match density. Prefer consuming tracks sequentially/copying retained numeric row data so an additional five-way flattened candidate array is never created. Require safe-integer `offset`, `limit`, and `offset + limit`; keep `KWIC_MAX_PAGE = 500`.

No additional semantic candidate cap is approved. The existing corpus cap plus the shared five-track cap bounds input, while top-K bounds retained sort state. Add checkpoints between tracks and benchmark a dense five-track request. If a single occurrence pass breaches the existing cancellation budget, use the phase plan's stepped/range kernel pattern; do not solve that by silently dropping candidates.

5. Cadence and center source — USE the store scrub, but add a real settle mechanism; empty enabled terms clears evidence without hiding the controls.

Use a dedicated 150 ms trailing debounce (fake-clock tested) from raw `setScrub` updates to the KWIC center. The current passage guard band does not provide this: it reuses a 200-token text block, whereas a KWIC page is exact for one center. Every raw scrub change must invalidate the prior KWIC result immediately so a late result cannot land under the new axis position, but it must only replace one pending center; do not issue/cancel on every pointer frame. On the trailing edge, cancel at most the one old request and issue the latest center. `clearScrub` cancels the timer and immediately issues the no-center reading-order request. A toggle may issue immediately using the latest scrub target.

The center must name a ready snapshot doc before issuance; the worker remains authoritative for token bounds. Carry the issued center in `KwicState` so the caption describes the result that actually landed. Keep the existing epoch plus `(generation,snapshot)` fence, and include the desired-center revision in freshness ownership during the debounce window.

Add a `kwicEnabledSeries` immutable set, initially containing every current series. Preserve on/off state for surviving semantic IDs across an input edit, add newly introduced IDs as enabled, and remove departed IDs. It is independent of `focusedSeries`; specifically, `setFocus` must stop reissuing KWIC. A toggle reissues KWIC only.

For zero enabled terms: cancel/invalidate work, clear all old rows, issue no worker query, and keep KwicPanel plus its toggle chips visible with an explicit “No concordance terms enabled” state. A blank overall term input may still remove the whole analysis panel as today.

6. Contract/commit split — USE three review-diffed commits, in this order.

1. Contract + core (`kwic/2`): amend the KWIC contract first; add track/request/result types and the shared track cap; implement total ordering, exact top-K paging, numeric `trackOrdinal`, public `seriesId`/`groupId`, and materialization checks. Cover centered cross-document order, equal-distance ties, no-center L/R sort preservation, duplicate spans across tracks, intra-group overlap behavior, page continuity, invalid centers/ordinals, and snapshot/selection binding.
2. Protocol + engine: replace `group` with nonempty unique capped `tracks` in the type and runtime schema; union required match modes per selected doc instead of rebuilding duplicate resolvers; compute/consume occurrences per track; checkpoint after selection, resolver preparation, each track, numeric planning, and materialization, with the existing final gate immediately before emit. Add engine/schema and cancellation-race tests. KWIC's bounded strings remain structured-cloned; there is no useful transfer list, and cached shard/posting buffers must never be transferred.
3. Store + UI + browser acceptance: add enabled-term state/toggles, focus independence, settled-center scheduling, stale-result fences, series-colored merged rows, and a caption that records the served center. Use accessible toggle buttons with `aria-pressed`; color cannot be the only on/off cue. Add one real-browser spec using a tiny deterministic imported corpus and keyboard scrubber movement (not fragile pointer pixels): establish a pre-action trace sequence, wait for the post-action KWIC result, assert the nearest merged order and both term tags, toggle one term off, then wait for a second fresh result and assert only that track disappeared.

One final pitfall to pre-empt: context sorting must remain numeric/planning work over bound shards, and text slicing must still happen only for the at-most-500 paged rows. Do not materialize strings before the merged selection, and do not place UI identities into the numeric kernel.
