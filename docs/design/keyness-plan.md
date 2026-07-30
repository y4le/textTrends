# Two-text dueling keyness — Slice 4 plan

*Slice 4 of the adopted product sequence. Governing Claude Opus planner ruling:
Parley request `req_consult_a2002d56c2327772`, session
`ses_cad54a4d184a8c0d`, artifact
`art_sha256_c27b4b4a264a71518248b3c59162d88624c4852049b44c9f631cd550c4d0c842`.
This plan depends on the term-count primitive and cache specified in
`docs/design/corpus-dashboard-plan.md`.*

**STATUS: PLANNED (2026-07-30).**

## Architectural ruling

Slice 4 introduces **no counting kernel**. It resolves and validates two
explicit selections, folds the Slice-3 per-document sparse term-count vectors
once per side, performs a linear merge of the two sorted type-ID vectors, and
applies the already-published `g2Keyness` and `logRatio` scalars.

The operation is named `keyness` at the app query union and carries the method
IDs `keyness-g2-2x2/1` and `log-ratio-halves/1`. It is not a mode of a generic
statistics operation.

The global linked trend selection is deliberately irrelevant. Comparison
sides are explicit research intent; allowing a brush to silently redefine
them is forbidden.

## Scalar prerequisite

Before the operation lands, harden the exported scalar functions. Both
`g2Keyness(a, n1, b, n2)` and `logRatio(a, n1, b, n2)` throw `RangeError` for
non-integers, `n1 <= 0`, `n2 <= 0`, negative counts, or counts exceeding their
corpus totals. Existing valid published vectors remain exact, including:

```text
a=10, N1=1000, b=2, N2=2000
G² = 12.8349 (±1e-3)
log ratio = 3.0697 (±1e-3)
```

Zero term count on one side remains valid and finite because log ratio uses
the named 0.5 four-cell correction.

## Selection-pair contract

Both sides are `WireSelectionV4` values resolved against one snapshot. V1 UI
offers document-v-document and document-v-rest; the wire shape can express
ranges later without changing the operation.

Sides must be disjoint by construction. Any intersection of resolved token
ranges, including a whole document overlapping a ranged document, is rejected
as `SELECTION_INVALID` with the document named. A side with zero
class-filtered tokens is `REQUEST_INVALID`.

## `keyness-g2-2x2/1`

Request:

```ts
interface KeynessRequestV1 {
  readonly method: "keyness-g2-2x2/1";
  readonly effect: "log-ratio-halves/1";
  readonly a: WireSelectionV4;
  readonly b: WireSelectionV4;
  readonly filter: {
    readonly minCountTotal: number;   // default 5
    readonly minDocFreqTotal: number; // default 2
    readonly classes: readonly ("lexical" | "numeral")[];
  };
  readonly sort: {
    readonly by: "logRatio" | "g2" | "countA" | "countB";
    readonly dir: 1 | -1;
  };
  readonly page: { readonly offset: number; readonly limit: number };
  readonly side: "a" | "b" | "both";
}
```

The same exported paging policy as the frequency table applies:
`limit <= 200`, `offset + limit <= 5_000`. Class filters are nonempty and
unique.

Result provenance includes both resolved selection hashes and class-filtered
token/document totals. Rows contain key, corpus type ID, raw counts, per-10k
rates, log ratio, signed G², and `rangeA`/`rangeB`: the per-side document
frequency (“range” in the corpus-linguistics sense), not a min/max rate
interval.

The union walk is linear in the two sparse sorted vectors. Combined-count and
combined-document-frequency filters run before ranking. Class-filtered
denominators are used for rates and both statistical methods.

The tie-breaking chain is:

1. requested field and direction;
2. signed `g2` descending where the primary field does not already
   determine it;
3. combined raw count descending;
4. corpus type ID ascending.

The exact operation implementation will encode the chain once and its
forced-tie fixtures are contract tests. The default view is two projections of
one comparison: A-key uses `side: "a"` and log ratio descending; B-key uses
`side: "b"` and log ratio ascending. Ranking is by log-ratio effect size and
G² evidence is displayed, never the reverse.

`side` is a pre-paging projection: `"a"` retains rows with `logRatio > 0`,
`"b"` retains rows with `logRatio < 0`, and `"both"` retains every row,
including `logRatio === 0`. A zero-effect row appears in neither default
projection because it is key to neither side. The result's `total` is
therefore the number of rows after all count, document-frequency, class, and
side filters but before paging.

## Store and UI

Keyness uses comparison-owned lanes keyed per visible side/table so an A
request cannot supersede a B request. Guards include generation, snapshot,
both canonical side selections, filters, sort, page, and side projection.
Comparison-header inventory requests are independently keyed per side.

The dueling view provides:

- side pickers for document-v-document and document-v-rest;
- both class-filtered token totals and document counts;
- two paged tables on a shared scale with key, both counts/rates, log ratio,
  G², and per-side document frequencies/ranges;
- row actions that open KWIC restricted to the chosen side through the
  existing `detailSelection` path;
- side swapping with clean latest-wins supersession;
- a small-corpus warning whenever a side has fewer than 10,000 tokens;
- a method drawer naming both method IDs and every filter value;
- the explicit statement “No confidence intervals — see method notes.”

Uncertainty is deferred, and the UI says so out loud. A live trend brush must
not alter either table. The comparison header reuses `inventory/1` for both
sides, making the Slice-3 aggregation seam visible rather than reimplementing
summary counts.

`KeynessViewV1` is a versioned exact semantic record. Side membership is
persisted/shared later by TextHash lists, not app-local document IDs. Side
definitions, filters, sort, and page size are semantic; page offsets, hover,
pending state, and open drawers are ephemeral.

## Owner ratifications

The owner ratified the cross-phase product recommendations recorded in the
Slice-3 plan on 2026-07-30, including putting Poisson bursts after this slice;
`docs/design/product-decisions.md` is the repository-local decision record.
No open planner recommendation is being silently treated as settled here.

## Reviewed commit sequence

### 4A — scalar hardening and selection-pair plumbing

Add scalar preconditions and fixtures. Resolve two selections against one
snapshot and reject any overlap with a precise `SELECTION_INVALID` message.

### 4B — keyness core, protocol, executor

Add closed types/narrowers, sparse folds/merge, filters/ranking/side
projection/paging/provenance, chunked checkpoints, explicit result transport,
and end-to-end worked-vector coverage. Pin class-filtered denominators, finite
zero counts, ties, empty sides, paging, and cancellation.

### 4C — dueling UI

Add side pickers, comparison summaries, two tables, side-restricted KWIC, view
state, and guarded store lanes. Pin default effect ranking, side swap,
per-side supersession, and trend-brush independence.

### 4D — guardrails

Add small-corpus warnings, totals, full method/filter disclosure, and the
visible uncertainty statement.

### 4E — browser acceptance

Compare two Doyle novels, inspect A-key/B-key results, open side-restricted
KWIC, swap sides, prove inversion and global-brush independence, and verify
method disclosure.

Every nontrivial commit is reviewed through Parley to `looks-good`. Core and
protocol changes run root typecheck, all units, production build, and bundle
contract; phase end also runs full functional Playwright and the serial
benchmark suite.
