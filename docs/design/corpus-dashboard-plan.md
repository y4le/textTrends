# Corpus overview + book dashboard — Slice 3 plan

*Slice 3 of the adopted product sequence. The governing Claude Opus planner
ruling was produced through Parley request
`req_consult_a2002d56c2327772`, session `ses_cad54a4d184a8c0d`, artifact
`art_sha256_c27b4b4a264a71518248b3c59162d88624c4852049b44c9f631cd550c4d0c842`.
The relevant decisions are recorded below; `docs/design/keyness-plan.md` and
`docs/design/research-state-plan.md` carry the dependent Slice 4 and research
state rulings.*

**STATUS: IN PROGRESS (2026-07-30).** The preliminary protocol-admission
sweep landed in `e716d2b`: non-group arrays now use `denseArray`, while the
bounded group path retains `denseBoundedArray`. Every new array narrower
starts from that same hostile-input discipline.

## Product boundary

Slice 3 adds three named, closed operations. It does not add a generic
statistics operation, an unbounded occurrence dump, a dense type-by-document
matrix, or a second query engine:

1. `inventory/1` returns selection-scoped corpus totals, document rows,
   sentence rhythm, vocabulary growth, and optional section summaries.
2. `freq-list/1` returns a bounded, filtered, sorted, paged vocabulary table.
3. `tfidf-sections/1` returns distinctive labels for one document's eligible
   sections and deliberately ignores the live linked selection.

This slice establishes exactly one reusable counting primitive:
`documentTermCounts`. Slice 4 introduces **no counting kernel** — keyness is
two folds over this Slice-3 primitive.

Poisson bursts remain deferred to a later “notable moments” annotation
vertical. A stop list is not admitted in v1: its origin/rights and language
policy are unresolved, TF-IDF naturally gives corpus-ubiquitous words zero
weight, and the frequency table already exposes class and dispersion filters.
The corpus-aware composer remains deferred, but `freq-list/1` includes an
optional case-sensitive NFC prefix so later autocomplete does not need a new
vocabulary transport.

## Shared term-count primitive and cache

Core owns a cacheless pure kernel in `packages/core/src/ops/term-counts.ts`:

```ts
interface DocTermCountsV1 {
  readonly snapshot: string;
  readonly doc: string;
  readonly rangeKey: string;
  readonly typeIds: Uint32Array; // ascending corpus type ids present
  readonly counts: Uint32Array;
  readonly tokens: number;
  readonly lexicalTokens: number;
  readonly numeralTokens: number;
}

function documentTermCounts(
  snapshot: CorpusSnapshotV1,
  ref: CorpusSnapshotV1["docs"][number],
  shard: DocumentIndexV1,
  ranges: readonly TokenRangeSpan[] | null,
): DocTermCountsV1;
```

Whole-document execution uses postings offsets as local-type counts and
translates through `localToCorpusType`; it is O(local vocabulary), not a token
scan. Ranged execution scans only the already-canonicalized merged token
ranges. Output type IDs are strictly ascending, both typed arrays have equal
length, and counters use safe integers.

The generation-bound `QueryExecutor` owns the only cache. It is an LRU bounded
by both 96 entries and 64 MiB. The key is JSON
`[snapshot.id, doc, rangeKey]`.

The cache-key immutability argument recorded by the ruling is:

> `composeSnapshot` incorporates each document's `IndexArtifactHash` into
> `snapshot.id`, so `(snapshot.id, doc)` identifies one immutable shard.
> `resolveSelection` has already reduced ranges to declared-document order,
> sorted, merged, in-bounds spans, making their `rangeKey` canonical. The
> executor dies with its generation, and `publish` eagerly drops entries for
> replaced documents.

Equivalently, `snapshot.id` transitively pins each document's
`IndexArtifactHash`, and `rangeKey` is derived from an already-canonicalized
`ResolvedSelection`. A replaced document is removed eagerly on `publish`;
older snapshot entries otherwise age out. Cached arrays are never transferred.
Every operation materializes fresh output arrays through an explicit,
enumerated transfer-list helper. There is no operation-result cache.

Per-call folding may use one bounded dense count accumulator and a bitset, but
neither is retained. Every new limit is an exported core constant and the
wire narrower validates it; there are no component-local cap numbers.

Numeric MATTR is a blocking prerequisite. Add `mattrIds` over
`ArrayLike<number>` and a numeric count table; keep `mattr` as a delegating
string API with all published fixtures unchanged. Inventory must not
materialize millions of vocabulary strings merely to calculate diversity.

## `inventory/1`

Request:

```ts
interface InventoryRequestV1 {
  readonly method: "inventory/1";
  readonly rhythmBinsPerDoc: number; // 0, or 1..256
  readonly growthPoints: number;     // 0, or 16..1024
  readonly sections: boolean;
  readonly mattrWindow: number;          // 1..2000, default 500
}
```

The result echoes method, resolved selection hash, declared document order,
missing documents, and MATTR window. It returns:

- totals: selected/expected/missing documents; tokens, lexical tokens, numeral
  tokens, vocabulary types, hapax types, sentences, paragraphs, and spanned
  UTF-16 characters;
- one row per selected ready document: selected and full tokens, types, hapax,
  sentences, paragraphs, mean/median/p90 sentence length, mean paragraph
  length, descriptive TTR, MATTR, and `mattrIsPlainTtr`;
- optional sentence rhythm, growth, and section arrays, represented as `null`
  when not requested rather than empty arrays.

In every total, document row, and section row, `types` is the count of
distinct corpus type IDs whose selected count is at least one. It comes from
the merged term counts and is never copied from a shard's whole-document
vocabulary size.

The ownership and length rules are recorded verbatim:

> Start-token ownership with full length for sentences and paragraphs;
> spanned-character definition; the per-run MATTR rule.

Concretely, under a ranged selection a sentence or paragraph belongs when its
start token is selected, and its reported length is its full canonical length,
not a clipped length. `charsUtf16` is the sum, per contiguous selected run, of
`tokenEnd(last) - starts(first)`; it therefore includes intervening whitespace
within the run but never fabricates a span across a gap. Ranged MATTR is the
token-weighted mean of the MATTR of each contiguous run. A run shorter than
the window contributes plain TTR and sets `mattrIsPlainTtr`; gaps never create
false adjacency.

TTR and hapax ratios are labeled length-dependent. Empty denominators produce
`null`, never a fabricated zero.

Sentence rhythm uses equal-token bins per document. Its bin geometry is
identical to `trend/1`'s geometry for the same `binsPerDoc`. Each bin reports
mean and median full sentence length using the same start-token ownership
rule; zero-denominator bins are display gaps.

Vocabulary growth walks declared document order and samples monotonically at
bounded points plus document boundaries. It terminates at the exact selected
token and type totals.

Sections are bounded to 2,048 rows and include title, token range, selected
tokens, owned sentences, mean sentence length, and selected types. A request
that would exceed the cap fails with `CAP_EXCEEDED`; the result never silently
truncates and therefore has no `truncated` flag. This explicit refusal replaces
the planner ruling's proposed `{ rows, truncated }` shape. Structure and index
identities remain available wherever a section-derived result could otherwise
be paired with the wrong artifact.

Cancellation checkpoints occur between documents, every 65,536 scanned types
or growth tokens, after section materialization, and at the engine's final
gate.

## `freq-list/1`

Request:

```ts
interface FrequencyListRequestV1 {
  readonly method: "freq-list/1";
  readonly filter: {
    readonly minCount: number;       // >= 1
    readonly minDocFreq: number;     // >= 1
    readonly classes: readonly ("lexical" | "numeral")[]; // unique, nonempty
    readonly prefixNfc?: string;     // case-sensitive, NFC, 1..64 UTF-16 units
  };
  readonly sort: {
    readonly by: "count" | "docFreq" | "dp" | "dpNorm" | "key";
    readonly dir: 1 | -1;
  };
  readonly page: { readonly offset: number; readonly limit: number };
  readonly dispersion: boolean;
}
```

`limit <= 200` and `offset + limit <= 5_000`. Filtering precedes ranking and
paging. The result reports selection hash, number of selected document parts,
total passing rows, and the class-filtered `totalTokens`. Rows contain key,
corpus type ID, count, rate per 10k class-filtered tokens, document frequency,
and optional DP/DPnorm.

Vocabulary key order means ascending corpus type ID — the snapshot's
declared-merge order.

The tie chain is: requested field and direction, then count descending, then
corpus type ID ascending. DP parts are selected documents. The term
occurrence shares are compared with selected, class-filtered document token
shares. Below two nonempty parts, `dp` is `0` and `dpNorm` is `null`. The
`parts` result field is the count of selected document parts, rather than the
planner ruling's proposed array of document IDs; it is retained so a future
partition method does not require a row-shape change. Class-filtered
denominators are used throughout.

Clicking “add to notebook” mints one `sensitive` single-token member through
the existing notebook admission path: what the user clicked is what the query
will match. The UI labels that behavior. Clicking a row may also center the
existing KWIC surface.

## `tfidf-sections/1`

Request:

```ts
interface TfidfSectionsRequestV1 {
  readonly method: "tfidf-sections/1";
  readonly doc: string;
  readonly level: number;            // 1 = top-level chapters
  readonly minSectionTokens: number; // 1..exported cap, default 50
  readonly topK: number;             // 1..10, default 5
}
```

This operation carries no selection. A trend brush must never change chapter
labels. It echoes document, structure, and index identities and returns every
bounded section with eligibility, tokens, and labels. Sections below the token
threshold are returned as ineligible with no labels and are excluded from
both `N_sections` and document frequency. Fewer than two eligible sections is
an honest “not enough chapters to compare” state.

Weights use the specified `f(t,s) * ln(N_sections / df(t))` variant. Ties
break by raw section frequency descending, then corpus type ID ascending.
There is no stop-list clause in v1.

## Store and UI composition

Inventory, frequency list, and TF-IDF have separate latest-wins lanes.
Inventory/frequency identity includes snapshot, canonical detail selection,
request, filter, sort, and page identity as applicable. TF-IDF identity
includes snapshot, document, artifact identities, and request. A notebook
rename or member edit does not issue inventory work.

The dashboard consumes the existing `detailSelection` builder. It retains
whole-corpus context and labels selected values as selected rather than
relabelling a baseline. Tables and charts provide exact-value table fallbacks,
keyboard access, pending/error/partial states, and missing-document banners.

`InventoryViewV1` is a versioned, exact, plain semantic record suitable for
the later research-state schema. Sort/filter/page size are semantic; table
page offsets, loading state, hovers, and chart cursors are ephemeral.

## Owner ratifications

The owner ratified the planner's six non-blocking recommendations in this
implementation thread on 2026-07-30, recorded in
`docs/design/product-decisions.md`: use a bespoke compressed fragment codec
instead of `nuqs`; omit a v1 stop list; define DP parts by selected document;
keep the durable pin cap at eight; make “add exact term” create a
case-sensitive exact-token group; and place Poisson bursts after Slice 4.
These are product decisions, not unratified planner assumptions.

## Reviewed commit sequence

### 3A — term-count kernel and executor cache

Add `mattrIds`, `documentTermCounts`, the dual-bounded executor LRU, and
brute-force/cache/eviction/replaced-doc/cancellation/transfer-isolation tests.

### 3B — `inventory/1` core, protocol, executor

Add pure aggregation, closed app/wire shapes, narrowers, executor route,
engine dispatch, and explicit transfer list. Pin totals, range ownership,
MATTR runs, rhythm geometry, monotone growth, missing docs, null optionals,
caps, and cancellation.

### 3C — dashboard UI

Add corpus totals, document table with rhythm, vocabulary growth, chapter
strip, view state, and store lane. Pin selection composition, partial labels,
exact-value fallbacks, accessibility, and no notebook-driven reissue.

### 3D — `freq-list/1` core, protocol, executor

Pin brute-force counts/document frequency/DP, deterministic ties and paging,
filter-before-rank, sensitive NFC prefix, one-part DP, page-window cap, and
chunked cancellation. Amend `statistics.md` vocabulary-order terminology.

### 3E — frequency UI

Add sort/filter/page UI, exact-term notebook add, and KWIC action with
request-identity guards and accessibility coverage.

### 3F — TF-IDF sections and labels

Add the operation and chapter-label rendering. Amend `statistics.md` to remove
the v1 stop-list clause. Pin hand-computed weights, eligibility semantics,
ties, the insufficient-sections state, and selection independence.

### 3G — browser acceptance

Open Sherlock, verify totals and document rows, focus a book, inspect labels
and growth, sort by DP, add a clumped term, brush a range, observe selected
inventory/frequency changes with stable chapter labels, then restore baseline.

Each nontrivial commit is reviewed through Parley to `looks-good`. Protocol,
core-surface, and chunk-boundary commits run root typecheck, unit suites,
production build, and the bundle contract. Phase end additionally runs the
full functional Playwright and serial benchmark suites without live network.
