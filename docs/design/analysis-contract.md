# Analysis contract — v2.2 (amended)

*Status: AGREED DESIGN, 2026-07-19. The v1 draft was reviewed by Codex
([review 1](reviews/2026-07-19-analysis-contract-codex.md)); v2 incorporated its
"must change" list, and a second staged review corrected four more defects (structure
keying, annotation freezing, missing type definitions, G² formula — see the review
receipts). The TypeScript in this document is the design; **the source of truth
becomes `packages/core` as each part is implemented, and no operation may be
implemented before its request/result types and runtime schemas are complete in
code.** The canonical identity chain is:*

> **document index artifact → corpus snapshot → snapshot-bound query result**

*— immutable per-document shards, composed into immutable snapshots; never one mutable
corpus-global index. Implemented in `packages/core`; evolves only via versioned
schemas and migrations.*

## 0. Layer model

```
Web Worker / Node adapter protocol           (strings allowed: sources, queries, excerpts)
  → JS orchestration                         (parse, segment, resolve strings → IDs, bind snapshot)
    → NumericKernel seam                     (immutable typed arrays + scalars in; IDs/counts/
                                              positions/UTF-16 span pairs out — future WASM boundary)
  ← JS materialization                       (IDs → strings, excerpt slicing, provenance envelope)
← typed result protocol
```

The worker protocol is **not** the WASM seam. Strings live in the outer layers; the
NumericKernel sees no vocabulary strings, no per-token calls, no callbacks — batched
numeric operations over bounded ranges only. No zero-copy promise across a future
JS/WASM boundary; the guarantees are coarse calls, numeric data, bounded outputs.

## 1. Brands, ranges, invariants

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

// Stable project identities (strings; survive reorder/reimport):
type ProjectDocId     = Brand<string, 'ProjectDocId'>;
type SectionId        = Brand<string, 'SectionId'>;

// Snapshot-scoped ordinals and positions (numbers; meaningless outside one snapshot/shard):
type DocOrdinal       = Brand<number, 'DocOrdinal'>;
type LocalTypeId      = Brand<number, 'LocalTypeId'>;    // per-shard vocabulary id
type CorpusTypeId     = Brand<number, 'CorpusTypeId'>;   // snapshot-level, via translation table
type DocTokenPos      = Brand<number, 'DocTokenPos'>;    // document-local token position
type Utf16Offset      = Brand<number, 'Utf16Offset'>;    // UTF-16 code units into EXTRACTED text

// Hashes are distinct brands — never interchangeable:
type SourceHash        = Brand<string, 'SourceHash'>;
type TextHash          = Brand<string, 'TextHash'>;
type StructureHash     = Brand<string, 'StructureHash'>;
type IndexArtifactHash = Brand<string, 'IndexArtifactHash'>;
type IndexRecipeHash   = Brand<string, 'IndexRecipeHash'>;
type QueryHash         = Brand<string, 'QueryHash'>;
type SelectionHash     = Brand<string, 'SelectionHash'>;
type CorpusSnapshotId  = Brand<string, 'CorpusSnapshotId'>;
type BuildGeneration   = Brand<string, 'BuildGeneration'>;

interface HalfOpenRange<T> { readonly start: T; readonly end: T }
type TokenRange = HalfOpenRange<DocTokenPos>;
type CharRange  = HalfOpenRange<Utf16Offset>;
```

Invariants: all offsets/positions are finite non-negative integers, capped by
enforced, declared constants:

```ts
export const V1_CAPS = {
  maxDocTokens:    2 ** 31 - 1,   // per document — positions and sentinels fit Uint32 with margin
  maxCorpusTokens: 2 ** 32 - 2,   // per snapshot (declared-sequence coordinate)
  maxVocabSize:    2 ** 31 - 1,   // per shard; CSR offsets length = vocab + 1 fits Uint32
  maxDocTextUtf16: 2 ** 32 - 2,   // extracted-text length addressable by Utf16Offset
} as const;
``` Brands guard
public APIs and constructors; hot loops use raw integers internally — element reads
from typed arrays are unbranded by nature, so validation happens at artifact
construction and adapter boundaries, not per element.

**Normalization-order invariant** (contract, not implementation choice): segmentation
runs over the **unchanged extracted UTF-16 text**; the recorded spans address that
text; Unicode normalization (NFC/NFKC) applies **per emitted token** only, to produce
matching keys. Extracted text is never destructively normalized.

## 2. Source, document, structure

```ts
interface SourceDescriptor {
  hash: SourceHash;                  // identity of the bytes; filenames live on the
  byteLength: number;                //   project's document reference, not here
  format: 'txt' | 'md';              // v1 union; epub/pdf variants arrive with their adapters
  encoding: { declared?: string; detected: string; hadReplacementChars: boolean };
}

interface DocumentMeta {             // lives in the project manifest, keyed by ProjectDocId
  title: string;
  author?: string;
  year?: number;
  language: string;                  // BCP-47
  seriesIndex?: number;              // declared order
  tags: string[];
}
// `included` is project/selection state, not document state. There is no `text`
// property anywhere — extracted text is storage-resident, fetched via excerpt requests.

interface Section {                  // CANONICAL form — char-anchored only
  readonly id: SectionId;
  readonly doc: ProjectDocId;
  readonly origin: 'source' | 'heuristic' | 'user' | 'fixed';
  readonly parent?: SectionId;       // arbitrary depth; no hardcoded 3 levels
  readonly level: number;            // validated non-negative
  readonly title?: string;
  readonly chars: CharRange;         // addresses the extracted text (TextHash-stable)
}
// The canonical structure artifact is char-anchored and keyed by
// [textHash, structureRecipeHash(+user-override hash)] — it never contains token
// positions, so an index-recipe change cannot make it stale (review-2 finding).
// Token-range views of sections are a DERIVED artifact compiled per index, keyed by
// [StructureHash, IndexArtifactHash]:
interface SectionTokenView {
  readonly structure: StructureHash;
  readonly index: IndexArtifactHash;
  readonly tokens: readonly TokenRange[];   // parallel to the section table order
}
```

## 3. Recipes — split invalidation domains

One giant recipe hash would couple unrelated invalidation. Separate versioned
identities; each keys its own artifacts:

| Recipe | Invalidates | Never invalidates |
|---|---|---|
| `ExtractionRecipeV1` — format, decoder policy, parser id/version/options | extracted text + structure candidates | — |
| `IndexRecipeV1` — unicode form + `application: 'per-emitted-token-after-segmentation'`; locale resolution (`document-metadata`+fallback \| fixed); word-segmentation policy + emitted-class policy (`word-like-v1`); sentence policy; paragraph policy (CRLF/blank-line rules); apostrophe/hyphen policies **with table hashes**; numeral policy + classifier version | token arrays, vocab, postings, sentence/paragraph bounds | extracted text |
| `StructureRecipeV1` + user-override hash | section table | index |
| `ViewDefaultsV1` — stop list (base id + content hash + added/removed), default `MatchMode` | ranked *views* only | index, search, KWIC |
| `QuoteRecipeV1` — locale quote-pair table hash, nesting policy, unmatched policy, apostrophe disambiguation | quote annotation artifact | index |
| NLP pack config (Phase 3) | that pack's annotations | everything else |

**Segmenter fingerprint**: browsers expose no stable ICU version, so the artifact key
records a *behavioral* fingerprint — adapter id/version, effective locale, granularity
policies, and the hash of the segmenter's output over a fixed probe corpus. Browser
and Node are conformance-tested by comparing packed starts/ends/classes and sentence
bounds, not token strings.

```ts
interface SegmentationBatch {                 // batched — never per-token adapter calls
  readonly startsUtf16: Uint32Array;
  readonly endsUtf16: Uint32Array;
  readonly classes: Uint8Array;               // versioned token-class ABI (below)
  readonly sentenceBoundsUtf16: Uint32Array;  // includes terminal sentinel
  readonly provenance: SegmenterFingerprint;
}
interface Segmenter { segment(text: string, locale: string): SegmentationBatch }
```

**Token emission (v1)**: the index contains **only countable lexical segments** per
`word-like-v1` (numerals kept/dropped/placeheld per recipe). Punctuation and
whitespace are not index tokens; every denominator, bin, adjacency, and window counts
the same thing. `tokenClasses` is a closed, versioned enum (v1: `1=lexical`,
`2=numeral`; `0` reserved; readers reject unknown `tokenClassVersion`). Sentence and
paragraph boundaries are canonical boundary arrays **with terminal sentinels** (a
starts-only array cannot express the final half-open range) — not per-token flag bits.
Quote membership is *not* in the index (see §7 Q2).

## 4. The document index shard (canonical persisted artifact)

```ts
interface DocumentIndexV1 {
  readonly schema: 'texttrends/document-index/1';
  readonly text: TextHash;
  readonly recipe: IndexRecipeHash;
  readonly segmenter: SegmenterFingerprint;

  // Document-local positions throughout:
  readonly tokenTypeIds: Uint32Array;         // DocTokenPos -> LocalTypeId
  readonly startsUtf16: Uint32Array;          // DocTokenPos -> start in extracted text
  readonly lengths8: Uint8Array;              // 0..254 exact; 255 = consult overflow:
  readonly longTokenPositions: Uint32Array;   //   sorted DocTokenPos
  readonly longTokenLengths: Uint32Array;     //   parallel lengths

  readonly tokenClassVersion: 1;
  readonly tokenClasses: Uint8Array;

  // Case/diacritic-BEARING keys (per-query sensitivity stays implementable; fold maps
  // are reconstructed at runtime, never persisted):
  readonly vocabulary: readonly string[];

  readonly postings: {                        // CSR — decided (review Q1)
    readonly offsets: Uint32Array;            // length = vocabulary.length + 1
    readonly positions: Uint32Array;          // sorted DocTokenPos, one flat buffer
  };

  readonly sentenceBounds: Uint32Array;       // with terminal tokenCount sentinel
  readonly paragraphBounds: Uint32Array;      // with terminal tokenCount sentinel
}
```

Postings for local type `t` = `positions.subarray(offsets[t], offsets[t+1])`. That
subarray is canonical storage — never transferred out; query outputs are newly owned
buffers. Array-of-arrays is permitted only as a transient build representation.

## 5. Corpus snapshots (immutable composition)

```ts
interface CorpusDocRef {
  readonly doc: ProjectDocId;
  readonly index: IndexArtifactHash;
  readonly structure: StructureHash;
  // Annotation inputs are FROZEN into the snapshot (review-2 finding): a query bound
  // to this snapshot sees exactly these artifacts or reports them missing — never a
  // moving annotation set. Quote is named because it is an MVP dependency.
  readonly quote?: { readonly recipe: string; readonly artifact: string };
  readonly annotations: readonly { readonly id: string; readonly artifact: string }[];
  readonly localToCorpusType: Uint32Array;    // LocalTypeId -> CorpusTypeId
  readonly sequenceTokenBase: number;         // cumulative base in declared order
}

interface CorpusSnapshotV1 {
  readonly schema: 'texttrends/corpus-snapshot/1';
  readonly id: CorpusSnapshotId;
  readonly generation: BuildGeneration;
  readonly expectedDocs: readonly ProjectDocId[];
  readonly docs: readonly CorpusDocRef[];     // ready docs, in declared order
  readonly missingDocs: readonly ProjectDocId[];
}
```

Reordering books = new snapshot with new bases — zero re-tokenization. **Annotation
readiness is snapshot republication**: when a quote/NLP artifact lands, the worker
publishes a new snapshot whose `CorpusDocRef`s bind it — that `snapshot-published`
event *is* the T3 annotation-ready signal, and ops that depend on an unbound
annotation report `missing: {dependency: 'quote', reason: 'pending'}` rather than
observing mutable availability. A corpus-wide compacted acceleration buffer may exist
later as a *derived* artifact, never the canonical identity.

## 6. Selection, time, query

```ts
interface SelectionSpec {                     // user/project layer
  readonly docs: readonly ProjectDocId[];
  readonly ranges?: readonly { readonly doc: ProjectDocId; readonly tokens: TokenRange }[];
}
interface ResolvedSelection {                 // execution layer — always snapshot-bound
  readonly snapshot: CorpusSnapshotId;
  readonly spec: SelectionSpec;               // canonicalized: doc order, sorted merged
  readonly hash: SelectionHash;               //   ranges, no empties/out-of-bounds;
}                                             //   hash COMPUTED, never caller-supplied

interface Brush {                             // durable project/share object; compiles
  readonly id: string;                        //   to a SelectionSpec per snapshot
  readonly name: string;
  readonly anchors: readonly { doc: ProjectDocId; text: TextHash; chars: CharRange }[];
}   // char anchors survive recipe changes; a TextHash mismatch is reported, not guessed

type TimeCoordinate =
  | { kind: 'document-relative' }             // 0..1 within each selected document
  | { kind: 'document-token' }                // doc-local absolute, faceted by document
  | { kind: 'declared-sequence' };            // cumulative via snapshot order; result
                                              //   echoes effective order + bases

interface MatchMode {                         // required, fully resolved — no hidden defaults
  readonly case: 'sensitive' | 'folded';
  readonly diacritics: 'sensitive' | 'folded';
}

type GroupMember =                            // stable member ids for evidence/provenance
  | { readonly id: string; readonly kind: 'token';  readonly surface: string; readonly match: MatchMode }
  | { readonly id: string; readonly kind: 'phrase'; readonly surfaces: readonly string[];
      readonly match: MatchMode; readonly crossSentence: boolean }
  | { readonly id: string; readonly kind: 'prefix' | 'suffix'; readonly stem: string;
      readonly match: MatchMode };
// regex: CUT from v1 (revisit only with a disposable secondary worker or linear-time engine).

interface TermGroup {
  readonly id: string;
  readonly name: string;
  readonly members: readonly GroupMember[];
  readonly countOverlaps: boolean;            // overlap identity = covered-token union
}
```

`caseFold` is a view/query concern, not an index concern: the shard vocabulary keeps
case/diacritic variants distinct; the orchestration layer resolves a `GroupMember` +
`MatchMode` to a set of `LocalTypeId`s via runtime fold maps before any kernel call.

**Every QueryOp is fully resolved and self-describing**: it carries
`method: { id, version, …parameters }` (registry: [statistics.md](statistics.md) —
denominators, corrections, signedness, window semantics, boundary-crossing rules, tie
breaking), and its canonical serialization is hashed to `QueryHash`, echoed in
provenance. No semantic defaults hidden in UI code. Compile-time typing uses a
correlated operation map; runtime narrowing uses per-op schemas at the adapter (review
Q4 — both, not either):

```ts
interface OperationMap {
  trend:        { request: TrendRequest;        result: TrendResult };
  occurrences:  { request: OccurrencesRequest;  result: OccurrencesResult };
  kwic:         { request: KwicRequest;         result: KwicResult };
  inventory:    { request: InventoryRequest;    result: InventoryResult };
  'freq-list':  { request: FreqListRequest;     result: FreqListResult };
  keyness:      { request: KeynessRequest;      result: KeynessResult };
  collocates:   { request: CollocatesRequest;   result: CollocatesResult };
  'tfidf-sections': { request: TfidfRequest;    result: TfidfResult };
  bursts:       { request: BurstsRequest;       result: BurstsResult };
}
type QueryOp = { [K in keyof OperationMap]: { readonly op: K } & OperationMap[K]['request'] }[keyof OperationMap];
```

**Binding rule** (corrected per review 2, which rightly called the v2 claim false
while `packages/core` was a placeholder): every request/result pair, with its runtime
schema, must be complete in `packages/core` **before that operation is implemented**;
nothing referenced-but-undefined may ship, and `AnalysisResult<unknown>` never escapes
the adapter. Exemplar definitions fixing the pattern (remaining ops follow it in code):

```ts
interface TrendRequest {
  readonly selection: ResolvedSelection;
  readonly group: TermGroup;
  readonly time: TimeCoordinate;
  readonly bins: { readonly mode: 'equal-tokens'; readonly count: number };
  readonly method: { readonly id: 'trend'; readonly version: 1 };   // statistics.md `trend/1`
}
interface TrendResult {                       // parallel arrays, one entry per bin per doc
  readonly doc: readonly ProjectDocId[];
  readonly binIndex: Uint32Array;
  readonly binTokens: Uint32Array;            // true size — final bins may be short
  readonly count: Uint32Array;
  readonly ratePer10k: Float64Array;
  readonly order: readonly ProjectDocId[];    // effective declared order + bases echoed
  readonly sequenceBases: readonly number[];
}

// kwic/2 (concordance amendment, 2026-07-22 — planner consult
// req_consult_1458236f5790b275, recorded in docs/design/concordance-plan.md).
// SUPERSEDES kwic/1: `group` is REPLACED by 1..MAX_KWIC_TRACKS `tracks` (a merged
// multi-term concordance), an optional `center` orders by proximity to an axis
// position, and rows carry their `seriesId`/`groupId`. Breaking; the discriminator
// stays `kwic`. Ordering: with a `center`, primary key = ascending distance from
// the center's GLOBAL declared-sequence position (sequenceTokenBase + occurrence
// start), then `sort`, then deterministic finals (doc ordinal, start, span, track
// ordinal, member ordinals); WITHOUT a center, `sort` is primary (reading order is
// the caller's `[doc,pos]`). Paging is EXACT bounded top-K over all tracks; `total`
// is the sum of every track's occurrence count (one row per (occurrence, track);
// no cross-track dedup).
interface KwicTrack { readonly seriesId: string; readonly group: TermGroup; }
interface KwicRequest {
  readonly selection: ResolvedSelection;
  readonly tracks: readonly KwicTrack[];       // 1..MAX_KWIC_TRACKS, unique seriesIds
  readonly contextTokens: number;
  readonly center?: { readonly doc: ProjectDocId; readonly token: number }; // axis proximity
  readonly sort: readonly { readonly at: 'L3'|'L2'|'L1'|'R1'|'R2'|'R3'|'doc'|'pos';
                            readonly dir: 1 | -1 }[];
  readonly page: { readonly offset: number; readonly limit: number };
  readonly method: { readonly id: 'kwic'; readonly version: 2 };
}
interface KwicResult {
  readonly total: number;
  readonly rows: readonly {                   // strings materialized JS-side, per page only
    readonly seriesId: string; readonly groupId: string; // the track that produced the row
    readonly doc: ProjectDocId; readonly pos: number; readonly members: readonly number[];
    readonly node: CharRange;                 // char span for stable highlighting
    readonly left: string; readonly nodeText: string; readonly right: string;
  }[];
}

interface KeynessRequest {
  readonly a: ResolvedSelection;              // both bound to the SAME snapshot
  readonly b: ResolvedSelection;
  readonly minCount: number;
  readonly minDocRange: number;
  readonly method: { readonly id: 'keyness-g2-2x2'; readonly version: 1;
                     readonly effect: 'log-ratio-halves'; };        // statistics.md
}
interface KeynessResult {
  readonly type: readonly string[];           // vocabulary keys of ranked terms
  readonly countA: Uint32Array; readonly countB: Uint32Array;
  readonly rateA: Float64Array; readonly rateB: Float64Array;
  readonly logRatio: Float64Array; readonly g2: Float64Array;       // signed
  readonly rangeA: Uint32Array; readonly rangeB: Uint32Array;
}

interface FreqFilter {                        // freq-list request component
  readonly minCount: number;
  readonly classes: readonly ('lexical' | 'numeral')[];
  readonly stopList: 'apply' | 'ignore';      // view-layer; never affects the index
}

type WorkerErrorCode =
  | 'UNKNOWN_OP' | 'PROTOCOL_VERSION' | 'SNAPSHOT_UNKNOWN' | 'GENERATION_STALE'
  | 'SELECTION_INVALID' | 'CAP_EXCEEDED' | 'DECODE_FAILED' | 'PARSE_FAILED'
  | 'ARTIFACT_CORRUPT' | 'DEPENDENCY_MISSING' | 'CANCELLED_RACE' | 'INTERNAL';

type JobId = Brand<number, 'JobId'>;
type BuildPhase = 'decode' | 'parse' | 'segment' | 'index' | 'aggregate' | 'annotate';

interface SegmenterFingerprint {
  readonly adapter: string; readonly adapterVersion: string;
  readonly locale: string;
  readonly wordPolicy: 'intl-word-v1'; readonly sentencePolicy: 'intl-sentence-v1';
  readonly probeHash: string;                 // hash of output over the fixed probe corpus
}

interface ResolvedRecipes {                   // carried by begin-generation
  readonly extraction: ExtractionRecipeV1;   readonly extractionHash: string;
  readonly index: IndexRecipeV1;             readonly indexHash: IndexRecipeHash;
  readonly structure: StructureRecipeV1;     readonly structureRecipeHash: string;
  readonly quote: QuoteRecipeV1;             readonly quoteHash: string;
}
```

Phrase gap policy (fixing review-2's "referenced but undefined"): phrase members
match **strictly adjacent** lexical tokens (gap 0) in v1; `crossSentence: false`
rejects matches spanning a sentence bound; document boundaries are never crossed.

The worker protocol version rides on every message envelope (§8); mismatches yield
`PROTOCOL_VERSION`, unknown ops `UNKNOWN_OP` — union growth is *not* assumed
non-breaking for exhaustive consumers.

## 7. Reviewed decisions (the six open questions)

1. **Postings: CSR** per immutable shard (flat positions + offsets). Decided.
2. **Quote detection: separate deterministic annotation artifact**, in `packages/core`
   (not an NLP pack), **eagerly scheduled** because dialogue share is MVP. Keyed by
   `IndexArtifactHash + QuoteRecipeHash`. Stores char/token span pairs + nesting +
   unmatched status; a token bitset is a derived accelerator. Never in index flags —
   a quote-policy change must not rebuild the index.
3. **Phrases: on-demand positional verification** — resolve surfaces to type-ID sets,
   anchor on the rarest member, verify neighbors at relative offsets, reject
   document-boundary crossings, apply the explicit sentence/gap policy. No eager
   bigram vocabulary; caches are benchmark-gated later.
4. **Result typing: operation map (compile time) + per-op schemas (runtime)** as above.
   Typed-array validation checks class/length/pairing/caps, not elements. Persisted
   and imported artifacts are always validated.
5. **Selection is the execution primitive; Brush is the durable object** — compiled to
   selections per snapshot; char-anchored so recipe changes degrade loudly, not silently.
6. **Recipe gaps**: resolved by the split-recipe scheme (§3) — sentence/paragraph
   policy, token emission, mixed-locale resolution, normalization order, table hashes,
   canonical JSON/hash scheme, segmenter fingerprint, per-op methods all versioned.

## 8. Worker protocol (generation- and snapshot-aware)

*SUPERSEDED IN PART by §12.8 (Amendment v2.2): the envelope discipline,
lifecycle rules, and error taxonomy below remain normative, but the concrete
`PROTOCOL_VERSION` and the begin-generation/ingest/source-ready/warm-miss/
query-union SHAPES are historical — the implemented protocol has since moved
through v2 (passage op), v3 (warm reopen: expectedText, generation-ready,
warnings — see the M5 commits), and v4 as specified in §12.8. Where a shape
here disagrees with §12.8 or with `apps/web/src/worker/protocol.ts`, this
section does not govern.*

```ts
// Every message literally carries the protocol version (fixing round-2's finding
// that the version was claimed but absent). There is no separate handshake: each
// message is self-describing, any message is legal first, and a receiver that sees
// v !== PROTOCOL_VERSION replies with error{code:'PROTOCOL_VERSION'} (correlated by
// job/generation when present) and ignores the message.
export const PROTOCOL_VERSION = 1;
type Envelope<T> = { readonly v: typeof PROTOCOL_VERSION } & T;

type ToWorker = Envelope<
  | { t: 'begin-generation'; job: JobId; generation: BuildGeneration;
      expectedDocs: readonly ProjectDocId[]; recipes: ResolvedRecipes }
  | { t: 'ingest';  job: JobId; generation: BuildGeneration; doc: ProjectDocId;
      source: SourceDescriptor; bytes: ArrayBuffer }                    // transferred
  | { t: 'query';   job: JobId; snapshot: CorpusSnapshotId; op: QueryOp }
  | { t: 'excerpt'; job: JobId; snapshot: CorpusSnapshotId; doc: ProjectDocId; chars: CharRange }
  | { t: 'cancel';  job: JobId }
>;

type FromWorker = Envelope<
  | { t: 'progress'; job: JobId; generation: BuildGeneration; phase: BuildPhase;
      unit: 'bytes' | 'utf16-code-units' | 'tokens' | 'documents';
      completed: number; total?: number }                               // total may be unknown
  | { t: 'source-ready'; job: JobId; generation: BuildGeneration;      // T0
      doc: ProjectDocId; text: TextHash }
  | { t: 'snapshot-published'; generation: BuildGeneration;            // T1/T2/T3 spine
      snapshot: CorpusSnapshotId; readyDocs: readonly ProjectDocId[];
      missingDocs: readonly ProjectDocId[] }
  | QueryResultMessage                                                  // echoes op + snapshot
  | { t: 'excerpt-result'; job: JobId; snapshot: CorpusSnapshotId;
      doc: ProjectDocId; chars: CharRange; text: string }
  | { t: 'error'; job?: JobId; generation?: BuildGeneration;           // at least one is
      code: WorkerErrorCode; message: string; recoverable: boolean }   //   present (schema-
  | { t: 'cancelled'; job: JobId }                                     //   enforced)
>;
// begin-generation now carries a JobId so generation-level failures have a
// correlated error; error's job is optional only for PROTOCOL_VERSION replies to
// unparseable envelopes.
```

Lifecycle rules:

- **Queries bind to one immutable snapshot**; results describe exactly one frozen
  input set. New doc/aggregate availability ⇒ new `snapshot-published`; live panels
  cancel/reissue. A recipe edit ⇒ **new generation**; stale events are dropped by
  identity, not by luck. Recipe "invalidation" is generation replacement — old
  content-addressed artifacts await ordinary eviction, and unaffected artifacts
  (e.g. extraction under an index-recipe change) are reused.
- **Cancellation is scheduled, not nominal**: ingest and analysis run in bounded
  chunks that yield to the worker event loop and check cancellation between chunks
  (same rule for future WASM kernels via bounded ranges). Cancel/result races resolve
  by job terminal state + snapshot/generation filtering in the adapter.
- **Atomic publication**: derived artifacts are staged and committed only on
  successful completion + generation validity; a cancelled ingest never publishes.
- **No `evict` in the core protocol** — cache management belongs to the storage
  adapter, with explicit keys and acknowledgements.
- The worker is never killed for feature-level failures (regex is cut from v1 anyway);
  respawn would drop resident shards.

## 9. Provenance

```ts
interface AnalysisProvenance {
  readonly schema: 'texttrends/analysis-provenance/1';
  readonly coreVersion: string;
  readonly snapshot: CorpusSnapshotId;
  readonly query: QueryHash;
  readonly selection: SelectionHash;
  readonly indexRecipe: IndexRecipeHash;
  readonly inputs: readonly {
    readonly doc: ProjectDocId; readonly text: TextHash;
    readonly index: IndexArtifactHash; readonly structure: StructureHash;
    readonly annotations: readonly { readonly id: string; readonly artifact: string }[];
  }[];
  readonly completeness: {
    readonly complete: boolean;                       // relative to expectedDocs AND the
    readonly expectedDocs: readonly ProjectDocId[];   //   op's declared dependencies
    readonly usedDocs: readonly ProjectDocId[];
    readonly missing: readonly { readonly doc: ProjectDocId;
      readonly dependency: 'index' | 'structure' | string;
      readonly reason: 'pending' | 'unsupported' | 'failed' | 'excluded' }[];
  };
  readonly methods: readonly { readonly id: string; readonly version: string;
    readonly configHash: string }[];
}
// computedAt is export metadata stamped by the shell — not a reproducibility input.
// "Index ready but quote annotation missing" is representable (dependency: 'quote').
```

## 10. Persistence (IndexedDB, tuple keys)

```
['source-blob',     schema, sourceHash]
['extraction',      schema, sourceHash, extractionRecipeHash]      → TextHash + evidence
['text',            schema, textHash]
['structure',       schema, textHash, structureRecipeHash]         // + user-override hash; char-anchored ONLY
['section-tokens',  schema, structureHash, indexArtifactHash]      // derived token-range view
['document-index',  schema, textHash, indexRecipeHash, segmenterFingerprint]
['quote',           schema, indexArtifactHash, quoteRecipeHash]
['annotation',      schema, indexArtifactHash, packId, modelVersion, configHash]
['project',         schema, projectId]
```

Artifacts carry internal schema/version headers and length invariants, validated on
load. Runtime lookup maps and fold maps are reconstructable — never persisted. Storage
classes per synthesis §5: only derived artifacts are evictable; "clear caches" touches
only those.

## 11. Deferred (explicitly)

Eager bigram postings · corpus-wide compacted acceleration buffers · phrase-result
LRU caches · quote-membership bitsets · regex members + isolated execution · core
LOESS/smoothing (presentation-layer overlay first) · EPUB/PDF source variants (arrive
with their adapters, Phases 2/4) · WASM kernels and WASM-owned memory · 64-bit
positions beyond the enforced Uint32 caps · brush share-URL compression · persisted
query-result caches.

## 12. Amendment v2.2 — ingest & structure (2026-07-20)

*Adopted from the reviewed ingest/structure plan
([ingest-structure-plan.md](ingest-structure-plan.md), Codex consultation
`ingest-structure-consult-1`). Where this section conflicts with §2, §3, §8,
or §10, THIS section governs (§8's concrete shapes are additionally marked
superseded in place). Rationale for each change lives in the plan.*

### 12.1 Extraction artifact and candidate identity

§3's claim that extraction invalidates "structure candidates" was incoherent
with §10's structure key (text + structure recipe + override only): a parser
change can leave the text unchanged while changing heading candidates. The
candidate set becomes an explicit identity that participates in structure
keying:

```ts
type ExtractionRecipeHash  = Brand<string, 'ExtractionRecipeHash'>;
type StructureRecipeHash   = Brand<string, 'StructureRecipeHash'>;
type StructureCandidateHash = Brand<string, 'StructureCandidateHash'>;
type StructureOverrideHash = Brand<string, 'StructureOverrideHash'>;

interface ExtractionArtifactV1 {
  readonly schema: 'texttrends/extraction/1';
  readonly source: SourceHash;
  readonly recipe: ExtractionRecipeHash;
  readonly text: TextHash;
  readonly descriptor: SourceDescriptor;
  readonly candidates: readonly StructureCandidateV1[];
  readonly candidateHash: StructureCandidateHash;
  readonly evidence: {
    readonly decoderReplacementCount: number;
    readonly suspiciousControlCount: number;
  };
}
// Keyed ['extraction', schema, SourceHash, ExtractionRecipeHash].
```

### 12.2 Structure artifact v2 — no project identity in persisted records

§2's `Section.doc: ProjectDocId` contradicted the text-keyed (reusable)
structure artifact. Persisted records carry a lineage-stable key and no
project identity; the project-bound `Section` view derives ids at bind time:

```ts
type StructureSectionKey = Brand<string, 'StructureSectionKey'>;

interface StructureSectionRecordV2 {
  readonly key: StructureSectionKey;   // stable within this text/override lineage
  readonly origin: 'source' | 'heuristic' | 'user' | 'fixed';
  readonly parent?: StructureSectionKey;
  readonly level: number;
  readonly title?: string;
  readonly chars: CharRange;
}

interface StructureArtifactV2 {
  readonly schema: 'texttrends/structure/2';
  readonly text: TextHash;
  readonly candidates: StructureCandidateHash;
  readonly recipe: StructureRecipeHash;
  readonly override: StructureOverrideHash;
  readonly sections: readonly StructureSectionRecordV2[];
}
// Keyed ['structure', schema, TextHash, StructureCandidateHash,
//        StructureRecipeHash, StructureOverrideHash].
// The no-override case is the hash of a canonical EMPTY override — never a
// missing tuple component. 'texttrends/structure/1' (root-only) is superseded;
// adding identity fields is a breaking persisted-ABI change, hence /2.

interface Section extends Omit<StructureSectionRecordV2, 'key' | 'parent'> {
  readonly id: SectionId;              // derived from doc + stable key
  readonly doc: ProjectDocId;
  readonly parent?: SectionId;
}
```

Invariants (validated before any record is admitted or persisted): exactly one
root (key `root`, origin `fixed`, level 0, no parent, range `[0, text.length)`);
offsets are finite non-negative UTF-16 integers within text length; keys unique;
parents exist, acyclic; child ranges contained in parents; non-ancestor records
disjoint (half-open sibling boundaries); deterministic order (root, then
depth-first by char start, key as final tie-breaker); no empty non-root ranges
in v1; titles bounded and well-formed UTF-16; hierarchy is defined by parent
links — `level` is validated display metadata.

### 12.3 Overrides are canonical declarative patch sets

Ordered UI edit logs are rejected (command order becomes accidental
semantics). Corrections are a conflict-free patch set in canonical sort order,
carrying complete replacement values (including range moves and re-parenting):

```ts
interface StructureOverrideV1 {
  readonly schema: 'texttrends/structure-override/1';
  readonly text: TextHash;
  readonly candidates: StructureCandidateHash;
  readonly baseRecipe: StructureRecipeHash;
  readonly changes: readonly (
    | { readonly op: 'remove'; readonly target: StructureSectionKey }
    | { readonly op: 'replace'; readonly target: StructureSectionKey;
        readonly value: Omit<StructureSectionRecordV2, 'key' | 'origin'> }
    | { readonly op: 'add'; readonly key: StructureSectionKey;
        readonly value: Omit<StructureSectionRecordV2, 'key' | 'origin'> }
  )[];
}
// Canonicalization sorts by (target-or-key, op) and rejects multiple changes
// to one target. If text or candidate identity changes, the override is
// MARKED NEEDS-REVIEW — never silently re-anchored. The worker recomputes
// every claimed hash from carried VALUES; hashes are admission checks, not
// authority.
```

### 12.4 Decoder policy (ExtractionRecipe, txt and literal-md)

```ts
interface DecoderPolicyV0 {
  readonly id: 'bom-utf8-windows1252-v1';
  readonly bom: 'utf8-utf16le-utf16be-v1';   // BOM authoritative; stripped; malformed
                                              // BOM-declared data is DECODE_FAILED,
                                              // never reinterpreted as 1252
  readonly unicodeErrors: 'fatal';
  readonly fallback: 'windows-1252-whatwg-v1'; // WHATWG total mapping (0x80=€,
                                              // undefined bytes → C1 controls)
  readonly windows1252TableHash: string;      // platform decoder conformance-
                                              // tested against this table
  readonly newlineNormalization: 'none';      // offsets address text as decoded
}
```

Evidence: `decoderReplacementCount` means the decoder INSERTED replacements
(normally 0 under this policy — an intentional U+FFFD in valid UTF-8 is not
data loss); `suspiciousControlCount` counts C0/C1 controls as extraction
evidence. Windows-1252 fallback always earns a persistent per-document badge
(detection was inferential). Markdown v0 is
`markdown-literal-with-heading-scan-v0` (`textPolicy:
'preserve-source-markdown'`) — honestly labeled, never called semantic
extraction; the spike record in the plan documents its boundary.

### 12.5 Storage classes get separate databases

The provisional ARTIFACT namespace (class 3, disposable) gains `extractions`
and `structures` stores — which is a layout change, so it opens a NEW database
name (`…-provisional-db2`) per the M5 rule; the M5 database is abandoned, one
cold rebuild, no user data. Durable USER data (class 1) lives in a separate
stable database (`texttrends-user-data`: `projects`, `sources`) whose contract
is same-name versioned MIGRATION, acknowledged writes (`saving | persisted |
external | failed` — never a boolean that precedes durability), monotonic
project `revision` with compare-and-swap saves, and visible failure ("close
the other tab and retry") instead of silent fallback. Clear-cache touches only
the artifact database.

### 12.6 Project manifest (main thread owns meaning; worker owns storage)

```ts
interface ProjectManifestV1 {
  readonly schema: 'texttrends/project/1';
  readonly id: ProjectId;
  readonly revision: number;
  readonly order: readonly ProjectDocId[];   // THE order authority
  readonly docs: readonly ProjectDocV1[];
  readonly indexRecipe: IndexRecipeProvisional;
  readonly indexRecipeHash: IndexRecipeHash;
}

interface ProjectDocV1 {
  readonly doc: ProjectDocId;                // stable, filename-independent
  readonly sourceName: string;               // display hint, never identity
  readonly meta: DocumentMeta;
  readonly source: SourceDescriptor;
  readonly sourceAvailability: 'persisted' | 'external' | 'bundled';
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: ExtractionRecipeHash;
    readonly text: TextHash;
    /** Recipe-bound asserted decoded length — the begin-generation cap
     *  preflight sums THESE (§12.9); the worker re-verifies on decode. */
    readonly textLengthUtf16: number;
    readonly candidates: StructureCandidateHash;
  };
  readonly structure: {
    readonly recipe: StructureRecipeProvisional;
    readonly recipeHash: StructureRecipeHash;
    /**
     * Discriminated so §12.3's needs-review promise is REPRESENTABLE: an
     * override is bound to the text/candidate/base-recipe identities it was
     * authored against (carried inside its value). While those match the
     * doc's current extraction, it is 'active' and participates in the
     * structure key. When re-extraction changes either identity, the
     * manifest RETAINS the correction verbatim as 'needs-review' — never
     * silently re-anchored, never discarded — and the effective structure
     * builds from the canonical EMPTY override until the user re-affirms
     * (rebase UI later). Validation: 'active' requires ALL THREE base
     * identities to match the doc's current state — value.text and
     * value.candidates equal the current extraction identities AND
     * value.baseRecipe equals structure.recipeHash (a structure-recipe
     * change with unchanged extraction produces a different detected table,
     * so an old override's targets may no longer exist); 'needs-review'
     * requires that at least one of the three differs.
     */
    readonly override:
      | { readonly status: 'active'; readonly value: StructureOverrideV1;
          readonly hash: StructureOverrideHash }
      | { readonly status: 'needs-review'; readonly value: StructureOverrideV1;
          readonly hash: StructureOverrideHash };
  };
}
```

`expectedText` on warm open derives ONLY from an extraction record whose
recipe hash still matches. Reattachment of an external source accepts bytes by
SourceHash, never by filename. Source persistence ordering: worker stores the
content-addressed source durably and acknowledges → main marks it persisted →
project revision saves (a crash between leaves a harmless unreferenced
source; the reverse would leave a manifest falsely claiming durability).

### 12.7 Section token views are derived lazily in v1

`[StructureHash, IndexArtifactHash] → SectionTokenView` is computed on first
structure query and memoized worker-side; not persisted until a benchmark
shows repeated derivation is material. Projection rule — TOKEN-START
ownership: a token belongs to a section iff its start offset lies in the
section's half-open char range (`lowerBound(startsUtf16, chars.start/end)`);
adjacent siblings get disjoint token ranges even when a boundary lands inside
a token. Any-overlap assignment is forbidden. The structure query result
echoes both input identities (StructureHash + IndexArtifactHash) so ranges
can never be paired with the wrong snapshot artifacts.

### 12.8 Protocol v4 (shape; runtime schemas complete in core before code)

`GenerationDocSpecV4` carries per-doc source/extraction/structure FULL VALUES
plus hashes (cold restart must reconstruct everything; the worker recomputes
all hashes); `source-ready` returns the full SourceDescriptor + extraction
evidence; progress adds `extract` and `structure` phases; warm misses become
`{doc, need: 'source-bytes', reason: source-not-persisted | source-miss |
source-corrupt | extraction-miss | rehydrate-failed}` — the worker
re-extracts from persisted sources, re-indexes from verified text, and
recomputes structure from candidates before ever requesting bytes; the query
union adds `structure`; user-data operations (project load/save, source
persist) are a SEPARATE storage operation map with their own error semantics
(`PERSISTENCE_UNAVAILABLE`, `REVISION_CONFLICT`, `QUOTA_EXCEEDED`), never
disguised as analysis progress. Section edits replace the generation (recipe
invalidation mechanism); snapshots are never mutated.

### 12.9 Ingest caps (concrete provisional values)

Shared contract constants (one exported object in core), checked BOTH
main-side before transfer (`File.size`, document count — reject before
reading) and worker-side (received byte length, decoded UTF-16 length,
cumulative project totals over the generation's declared docs). Violations
are `CAP_EXCEEDED`, never an OOM-shaped `INTERNAL`.

```ts
const INGEST_CAPS_V0 = {
  schema: 'texttrends/ingest-caps/0-provisional',
  maxSourceBytesPerFile: 32 * 1024 * 1024,        // 32 MiB
  maxProjectSourceBytes: 128 * 1024 * 1024,       // 128 MiB — transfer guard
  maxTextUtf16PerDoc: 32 * 1024 * 1024,           // 32M code units
  maxDocsPerProject: 64,
  maxProjectTextUtf16: 64 * 1024 * 1024,          // 64M code units
} as const;
```

The project byte cap closes the transfer-guard gap: without it, 64
individually-legal 32 MiB files could be read and transferred before any
text total constrains them. Main-side preflight sums `File.size` over the
included docs and rejects BEFORE reading any file when the sum exceeds
`maxProjectSourceBytes` (the UTF-16 caps still bind tighter after decode:
every supported encoding decodes to at most `byteLength` code units, so the
byte sum is also a sound upper bound on undetermined text lengths).

Grounding (benchmarks.md, 2026-07-19/20): warmed segment+build runs ~2M
tokens/s single-threaded and retained shards cost ~15 bytes/token; English
prose runs ~5.3 UTF-16 units/token, so the 64M-unit project cap ≈ 12M tokens
≈ the 10M formal tier with headroom — ~6 s of worker compute on the dev
machine and ~180 MB retained arrays, survivable WITHOUT the eviction policy
that the 50M tier requires (explicitly deferred; see benchmarks.md). The
per-doc caps admit any real novel (largest common case ~3.5 MB source) with
~9× headroom while keeping a single document's synchronous phases within the
cancellation-budget order of magnitude. Aggregation semantics: the
begin-generation preflight computes the project UTF-16 total over the
generation's DECLARED docs (included only) using each doc's ASSERTED
`extraction.textLengthUtf16` where a matching-recipe extraction exists, and
the sound `byteLength` upper bound for fresh imports with no extraction yet;
the worker re-validates cumulatively as ACTUAL decoded lengths arrive — an
individually-legal doc that crosses a project total mid-generation fails ITS
ingest with `CAP_EXCEEDED` and becomes a normal missing doc; prior docs
stand. These are provisional numbers (schema says so): they graduate or move
only with a benchmark-backed amendment.
