# Architecture review: analysis contract

## Executive verdict

The direction is strong, but I would not implement this draft as the migration baseline yet. The right decisions are already present: document-local UTF-16 offsets, half-open spans, exact positions, explicit worker messages, content-addressed artifacts, immutable numeric analysis inputs, and provenance-wrapped results.

The main issue is not a small field omission. The draft currently combines three things that need different identities and lifetimes:

1. an immutable index for one extracted document;
2. a progressively changing corpus assembled from those indexes; and
3. a worker job executing against one frozen view of that corpus.

That causes the largest contradictions in the document:

- persistence is keyed by text hash, implying a per-document artifact, while CorpusIndex is corpus-global and uses corpus-global TokenPos;
- each document is meant to become queryable independently, but one global typed-array index cannot grow while remaining immutable;
- document reordering changes every global TokenPos even though no document text or tokenization changed;
- doc-ready has no recipe, build generation, job, or snapshot identity, so stale events from a cancelled ingest can be accepted;
- the worker protocol contains strings, but is described as the exact numeric WASM seam.

My central recommendation is: **persist immutable per-document index shards and publish immutable CorpusSnapshot objects that compose them**. Queries bind to a snapshot. A new document or recipe produces a new snapshot/generation; it never mutates the snapshot used by an in-flight query. This preserves the product design while resolving persistence, progressive delivery, ordering, cancellation, and the WASM boundary together.

## 1. Type-design review

### 1.1 Brands are useful, but the current brands conflate stable identity, ordinal, and artifact scope

DocId is documented as an array index, yet it appears in project selections, sections, worker messages, missing-document provenance, and potentially share links. An array ordinal is not a durable document identity. Reordering or incrementally inserting a document changes it. Likewise, ContentHash intentionally covers source bytes, extracted text, and derived artifacts, which defeats the stated purpose of preventing cross-domain mixups.

Use stable string IDs for project entities, numeric ordinals only inside a snapshot, and distinct hash brands:

~~~ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type ProjectDocId = Brand<string, 'ProjectDocId'>;
type SectionId = Brand<string, 'SectionId'>;
type DocOrdinal = Brand<number, 'DocOrdinal'>;
type LocalTypeId = Brand<number, 'LocalTypeId'>;
type CorpusTypeId = Brand<number, 'CorpusTypeId'>;
type DocTokenPos = Brand<number, 'DocTokenPos'>;
type CorpusTokenPos = Brand<number, 'CorpusTokenPos'>; // derived within one snapshot only
type Utf16Offset = Brand<number, 'Utf16Offset'>;

type SourceHash = Brand<string, 'SourceHash'>;
type TextHash = Brand<string, 'TextHash'>;
type StructureHash = Brand<string, 'StructureHash'>;
type IndexArtifactHash = Brand<string, 'IndexArtifactHash'>;
type IndexRecipeHash = Brand<string, 'IndexRecipeHash'>;
type QueryHash = Brand<string, 'QueryHash'>;
type SelectionHash = Brand<string, 'SelectionHash'>;
type CorpusSnapshotId = Brand<string, 'CorpusSnapshotId'>;
type BuildGeneration = Brand<string, 'BuildGeneration'>;

interface HalfOpenRange<T> {
  readonly start: T;
  readonly end: T;
}

type TokenRange = HalfOpenRange<DocTokenPos>;
type CharRange = HalfOpenRange<Utf16Offset>;
~~~

Brands cannot protect elements read directly from Uint32Array; those are still number in TypeScript. Use brands at public APIs and validated constructors/accessors, while hot loops use raw integer indexes internally. Validate that all offsets and positions are finite, non-negative integers and fit the chosen 32-bit representation. State the hard artifact caps explicitly. A terminal boundary can equal the item count, so the maximum supported count must itself fit in Uint32.

### 1.2 UTF-16 and half-open ranges are the correct contract

Keep UTF-16 code-unit offsets and half-open ranges. They line up with JavaScript slicing and Intl.Segmenter indices in both browser and Node. Rename CharOffset to Utf16Offset so the unit cannot be forgotten, and state that it addresses the **extracted text**, not original source bytes.

Add fixtures for:

- astral characters and emoji;
- combining sequences;
- CRLF versus LF;
- smart quotes, apostrophes, and multiple hyphen code points;
- normalization that changes code-unit length;
- empty documents and empty sections;
- tokens longer than 254/255 code units;
- unmatched and nested quotation marks.

There is a critical normalization-order invariant missing. If the implementation normalizes the whole text and then segments it, NFC/NFKC can change lengths and invalidate offsets. The simplest safe v1 rule is:

> Segment the unchanged extracted UTF-16 text; preserve those spans; normalize each emitted token only to produce matching keys.

If the product instead requires segmentation of normalized text, the contract must require a normalized-to-source offset map. Do not leave this as an implementation choice.

### 1.3 Document and section types need small correctness fixes

Document.text: never makes Document impossible to construct because the property is required and no value can inhabit never. Omit the property. TypeScript object types are not exact anyway; enforce the serialized shape with a boundary schema.

Move included out of the document/index artifact and into the project manifest or active selection. It is user view state and should not change a content-addressed document.

The source blob name is also not intrinsic to SourceHash: identical bytes may arrive under two names. Store bytes by SourceHash and keep filename/import metadata on the project document reference.

Section.depth: 0 | 1 | 2 encodes an unnecessary three-level guess and cannot represent deeper Markdown/EPUB headings. Use parent?: SectionId plus a validated non-negative level, or just parent if consumers do not need the number. The origin also needs the already-decided user-corrected case:

~~~ts
interface Section {
  readonly id: SectionId;
  readonly doc: ProjectDocId;
  readonly origin: 'source' | 'heuristic' | 'user' | 'fixed';
  readonly parent?: SectionId;
  readonly title?: string;
  readonly tokens: TokenRange;
  readonly chars: CharRange;
}
~~~

The current CorpusIndex mentions a “+ Section table” but has no sections property. Whichever structure is chosen, the table and its artifact/hash must be explicit.

### 1.4 Make the canonical persisted index a document shard

The storage key index/<textHash>/... and T1 delivery both naturally want this shape:

~~~ts
interface DocumentIndexV1 {
  readonly schema: 'texttrends/document-index/1';
  readonly text: TextHash;
  readonly recipe: IndexRecipeHash;
  readonly segmenter: SegmenterFingerprint;

  // All positions below are document-local.
  readonly tokenTypeIds: Uint32Array;   // DocTokenPos -> LocalTypeId
  readonly startsUtf16: Uint32Array;    // DocTokenPos -> start in extracted text

  // 0..254 are exact; 255 means consult the sorted overflow arrays.
  readonly lengths8: Uint8Array;
  readonly longTokenPositions: Uint32Array;
  readonly longTokenLengths: Uint32Array;

  readonly tokenClassVersion: 1;
  readonly tokenClasses: Uint8Array;

  // LocalTypeId -> preserved, case/diacritic-bearing token key.
  readonly vocabulary: readonly string[];

  readonly postings: {
    readonly offsets: Uint32Array;      // length vocabulary.length + 1
    readonly positions: Uint32Array;    // sorted DocTokenPos values
  };

  // Each contains a terminal tokenCount sentinel.
  readonly sentenceBounds: Uint32Array;
  readonly paragraphBounds: Uint32Array;
}

interface CorpusDocRef {
  readonly doc: ProjectDocId;
  readonly index: IndexArtifactHash;
  readonly structure: StructureHash;
  readonly localToCorpusType: Uint32Array;
  readonly sequenceTokenBase: CorpusTokenPos;
}

interface CorpusSnapshotV1 {
  readonly schema: 'texttrends/corpus-snapshot/1';
  readonly id: CorpusSnapshotId;
  readonly generation: BuildGeneration;
  readonly expectedDocs: readonly ProjectDocId[];
  readonly docs: readonly CorpusDocRef[];
  readonly missingDocs: readonly ProjectDocId[];
}
~~~

The document vocabulary can use local IDs, making the artifact reusable across corpora and document orderings. A corpus snapshot owns the local-to-corpus vocabulary translations and sequence bases. If benchmarks later justify a fully compacted corpus-wide token/postings buffer, make it an optional derived acceleration artifact, not the canonical identity.

This also fixes a subtle cache problem: a user can reorder books without re-tokenizing every book. Only the snapshot’s order and sequence bases change.

### 1.5 The token stream and flags ABI are underspecified

The draft never decides whether tokens includes:

- every Intl segment, including whitespace;
- non-whitespace punctuation plus word-like segments; or
- only countable lexical/word-like segments.

That decision affects every denominator, equal-token bin, phrase adjacency rule, collocation window, inventory count, and memory estimate. An ellipsis in a bitfield comment is not a stable binary contract.

For v1, I recommend indexing only countable lexical segments produced by the resolved word-segmentation/token-class policy. Numerals remain or disappear according to the recipe. Sentence and paragraph boundaries are canonical boundary arrays, not duplicated sentenceStart/paragraphStart bits. Quote membership is a separate annotation. tokenClasses then needs only a small, explicitly versioned enum for distinctions analyses actually use, such as lexical and numeral; reserved values must be zero and readers must reject an unknown tokenClassVersion.

If punctuation is intentionally included, that is also defensible, but then introduce a distinct lexical ordinal or prefix-count structure and state that equal-token bins and collocation windows count only the configured class. Do not let TokenPos silently mean “all segments” in one operation and “words” in another.

The length overflow table must be part of the type, with a sentinel rule. “255 cap; overflow table” is not implementable as written.

Boundary arrays should include the terminal token count. A starts-only array without a sentinel cannot represent the last half-open range by itself.

### 1.6 Per-query case and diacritic controls conflict with recipe-level case folding

The MVP promises per-query case/diacritic sensitivity, but CorpusIndex.vocab.surface contains only a normalized surface and Recipe.caseFold can collapse case variants. Once “May” and “may” share a TypeId, a case-sensitive query cannot recover correct postings without touching the source text per candidate.

Keep case- and diacritic-bearing vocabulary variants in the index. Build exact, case-folded, and diacritic-folded resolver maps in the JavaScript orchestration layer; those maps may be reconstructed on load and need not be persisted. Resolve a TermGroup to one or more LocalTypeId values before calling a numeric kernel. Move caseFold to a view/query default, and make the effective matching mode explicit in the resolved QueryOp and query hash.

All member variants need the same explicit matching contract. phrase, prefix, and suffix currently omit some or all of the sensitivity fields. Optional booleans also hide defaults. A serialized query should contain fully resolved required values:

~~~ts
interface MatchMode {
  readonly case: 'sensitive' | 'folded';
  readonly diacritics: 'sensitive' | 'folded';
}

type GroupMember =
  | { readonly id: string; readonly kind: 'token'; readonly surface: string; readonly match: MatchMode }
  | { readonly id: string; readonly kind: 'phrase'; readonly surfaces: readonly string[];
      readonly match: MatchMode; readonly crossSentence: boolean }
  | { readonly id: string; readonly kind: 'prefix' | 'suffix'; readonly stem: string;
      readonly match: MatchMode };
~~~

Stable member IDs are preferable to Occurrence.member as an array index. If the group is edited or reordered, provenance and evidence should still identify the matching member.

### 1.7 TimeCoordinate currently has two equivalent variants

With TokenPos defined as a global position in concatenated corpus order, absolute and sequence are the same coordinate. Preserve the product’s three intended views, but define them as:

- document-relative: 0..1 within each selected document;
- document-token: document-local absolute token position, normally faceted by document;
- declared-sequence: cumulative token position using the explicit document order in the bound CorpusSnapshot/selection.

The sequence coordinate must never infer an order from incidental array insertion. The result should echo the effective order and per-document bases.

### 1.8 Selection should be derived, canonical, and snapshot-bound

A caller-supplied Selection.hash can disagree with mutable docs/ranges. Split the user/project specification from the validated resolved selection. Ranges must identify their document; one global range becomes unstable after reorder or progressive insertion.

~~~ts
interface SelectionSpec {
  readonly docs: readonly ProjectDocId[];
  readonly ranges?: readonly {
    readonly doc: ProjectDocId;
    readonly tokens: TokenRange;
  }[];
}

interface ResolvedSelection {
  readonly snapshot: CorpusSnapshotId;
  readonly spec: SelectionSpec;       // sorted/merged/validated canonical form
  readonly hash: SelectionHash;       // computed, never accepted from caller
}
~~~

Define canonicalization: document order, sorted ranges, merge overlap/adjacency or reject it, no empty/out-of-bounds ranges, no range for an absent document, and a specified canonical JSON/hash scheme.

For durable named brushes, store text-hash-qualified UTF-16 ranges in project state and compile them to token ranges for a snapshot. Token ranges are efficient execution primitives but are invalidated by a tokenization recipe change; UTF-16 anchors preserve the exact evidence span as long as the extracted TextHash matches.

## 2. Recipe and reproducibility

### 2.1 Split invalidation domains instead of making one Recipe own everything

The note says stop lists never affect the index, but the index key contains RecipeHash and Recipe contains stopList. That either invalidates indexes unnecessarily or means the key does not describe its inputs.

Use separate, versioned recipes/hashes:

~~~ts
interface ExtractionRecipeV1 {
  readonly schema: 'texttrends/extraction-recipe/1';
  readonly format: 'txt' | 'md';
  readonly decoder: {
    readonly policy: 'bom-utf8-windows1252-v1';
    readonly implementation: string;
  };
  readonly parser: {
    readonly id: string;
    readonly version: string;
    readonly optionsHash: string;
  };
}

interface IndexRecipeV1 {
  readonly schema: 'texttrends/index-recipe/1';
  readonly unicode: {
    readonly form: 'NFC' | 'NFKC';
    readonly application: 'per-emitted-token-after-segmentation';
  };
  readonly locale:
    | { readonly mode: 'document-metadata'; readonly fallback: string }
    | { readonly mode: 'fixed'; readonly value: string };
  readonly wordSegmentation: {
    readonly policy: 'intl-word-v1';
    readonly emittedClasses: 'word-like-v1';
  };
  readonly sentenceSegmentation: {
    readonly policy: 'intl-sentence-v1';
  };
  readonly paragraphSegmentation: {
    readonly policy: 'unicode-line-breaks-v1';
  };
  readonly apostrophes: {
    readonly policy: 'keep' | 'strip' | 'normalize';
    readonly tableHash: string;
  };
  readonly hyphens: {
    readonly policy: 'keep' | 'split' | 'join';
    readonly tableHash: string;
  };
  readonly numerals: {
    readonly policy: 'keep' | 'drop' | 'placeholder';
    readonly placeholder?: string;
    readonly classifierVersion: string;
  };
}

interface ViewDefaultsV1 {
  readonly schema: 'texttrends/view-defaults/1';
  readonly matching: MatchMode;
  readonly stopList: null | {
    readonly baseId: string;
    readonly contentHash: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
}

interface QuoteRecipeV1 {
  readonly schema: 'texttrends/quote-recipe/1';
  readonly localeTableHash: string;
  readonly nestingPolicy: 'stack-v1';
  readonly unmatchedPolicy: 'close-at-paragraph-v1' | 'discard-v1';
  readonly apostropheDisambiguation: 'word-context-v1';
}
~~~

The exact policy names are examples, but the separation is important:

- extraction changes source bytes -> extracted text and structure candidates;
- indexing changes token IDs, offsets, lexical classes, sentences, and paragraphs;
- structure includes parser-derived spans, heuristic policy, and user overrides, and gets a StructureHash;
- view defaults include stop words and default matching but do not invalidate the index;
- quote detection is a deterministic derived annotation with its own recipe;
- NLP/model annotations have their own model/config identity;
- each analysis operation contains its mathematical method/version and parameters.

Sentence policy, paragraph policy, and token-class/emission definitions **must** be in IndexRecipe because they change index arrays and denominators. The quote-pair locale table **must be versioned**, but belongs in QuoteRecipe rather than IndexRecipe. Stop-list contents need a content hash and belong outside the index recipe.

### 2.2 Runtime segmenter behavior needs a fingerprint, not an assumed browser engine version

Node can expose an ICU version; browsers generally do not expose a stable Intl/ICU version that is suitable as an artifact key. Keep the requested policy in IndexRecipe and record a resolved SegmenterFingerprint in the artifact and provenance. That fingerprint should include:

- adapter implementation/version;
- effective BCP-47 locale;
- word and sentence granularities/policies;
- a hash of output from a small fixed conformance probe corpus, or another behavior identity the adapter can actually provide.

The persistence key is then textHash + indexRecipeHash + segmenterFingerprint. Browser and Node fixtures should compare packed starts/ends/classes and sentence boundaries, not only token strings.

Prefer a batched Segmenter result over Iterable records:

~~~ts
interface SegmentationBatch {
  readonly startsUtf16: Uint32Array;
  readonly endsUtf16: Uint32Array;
  readonly classes: Uint8Array;
  readonly sentenceBoundsUtf16: Uint32Array;
  readonly provenance: SegmenterFingerprint;
}

interface Segmenter {
  segment(text: string, locale: string): SegmentationBatch;
}
~~~

This is easier to conformance-test and avoids presenting a per-token adapter call pattern as part of the future numeric kernel boundary.

### 2.3 Analysis reproducibility also requires complete operation methods

Recipe cannot carry every analysis choice; those belong to QueryOp and QueryHash. The current operations are not yet reproducible:

- trend lacks denominator/rate scale and any smoothing edge treatment if smoothing is core-computed;
- keyness does not specify log-ratio correction, G2 convention, signedness, or multiple-testing behavior;
- collocates does not specify metric, minimum frequencies, node exclusion, boundary crossing, or left/right interpretation;
- TF-IDF does not specify TF, IDF smoothing/base, section eligibility, or tie-breaking;
- bursts does not specify the burst algorithm and parameters;
- frequency filter is referenced but undefined;
- phrase matching does not state punctuation/sentence/document crossing semantics;
- overlap deduplication does not define whether identity is start position, full span, or covered-token union.

Make every QueryOp fully resolved: no semantic defaults hidden in UI code. Add method: { id, version, ...parameters } or equivalent, hash the canonical request, and echo that QueryHash/method in provenance.

## 3. Concrete answers to the six open questions

### Q1. Postings layout: use CSR

Use one flat Uint32Array of positions plus a Uint32Array of offsets of length vocabulary size + 1. CSR avoids one object and one backing buffer per hapax, persists and structured-clones cleanly, has predictable accounting, and gives cache-friendly iteration. Building by counting sort already produces exactly the counts needed for offsets.

Use CSR per immutable document shard. The posting for local type t is positions.subarray(offsets[t], offsets[t + 1]). Never transfer that subarray’s backing buffer out of the worker, because it is canonical index storage; transferred query results must be newly owned output buffers.

Array-of-arrays is acceptable as a temporary build representation if a benchmark shows it simplifies construction, but it should not be the persisted/runtime contract.

### Q2. Quote detection: separate deterministic annotation, eagerly scheduled for MVP

Do not put inQuote in the base token flags. Quote detection is locale/table/policy-sensitive and will evolve independently of tokenization. Keeping it in flags forces a complete index rebuild when quote heuristics change and loses useful span structure.

Implement quote detection in packages/core as a deterministic pass, not as a language-model pack, and schedule it eagerly because dialogue share is an MVP dependency. Key it by IndexArtifactHash (or TextHash plus exact index identity) and QuoteRecipeHash. Store quote char/token span pairs, nesting/depth if useful, and unmatched status. A compact token bitset can be a derived accelerator, not the canonical evidence.

This also makes quote-derived provenance honest and lets a failed or unsupported quote pass be represented as a missing dependency rather than pretending the document is not indexed.

### Q3. Phrase queries: on-demand positional verification

Do not eagerly index bigrams in v1. Resolve each phrase surface to its allowed type-ID set, choose the phrase term with the smallest combined posting count as the anchor, and for each anchor occurrence verify the other type IDs at relative token offsets. Reject candidates that cross document boundaries and apply the explicit sentence/gap policy.

This is usually better than materializing pairwise posting intersections and dramatically smaller than an eager bigram vocabulary. Add an LRU cache keyed by index/snapshot + normalized phrase query only if measurements show repeated phrases matter. A benchmark-gated promoted-bigram cache is a later optimization, not part of the persistent contract.

### Q4. Worker result typing: use both a discriminated operation map and runtime schemas

This is not an either/or choice. The compile-time contract should be a correlated operation map that generates QueryOp and QueryResult unions. The runtime postMessage boundary should select the per-op schema using the op discriminant. The response must echo op; AnalysisResult<unknown> must not escape the adapter.

~~~ts
interface OperationMap {
  trend: { request: TrendRequest; result: TrendResult };
  occurrences: { request: OccurrencesRequest; result: OccurrencesResult };
  kwic: { request: KwicRequest; result: KwicResult };
  // ...
}

type QueryOp = {
  [K in keyof OperationMap]:
    { readonly op: K } & OperationMap[K]['request']
}[keyof OperationMap];

type QueryResultMessage = {
  [K in keyof OperationMap]: {
    readonly t: 'result';
    readonly job: JobId;
    readonly snapshot: CorpusSnapshotId;
    readonly op: K;
    readonly result: AnalysisResult<OperationMap[K]['result']>;
  }
}[keyof OperationMap];
~~~

Narrowing lives in the web-worker/Node adapter immediately after envelope and per-op validation; the UI/CLI receives a typed result. Use schemas from the same operation registry or infer the TypeScript types from schemas to prevent drift. For large typed arrays, runtime schemas should validate class, lengths, paired-array invariants, caps, and metadata rather than iterate every element. Always validate persisted/imported artifacts; validating same-bundle worker messages can be production-light after the contract has strong conformance tests, but no unknown result should enter application state.

Also note that “adding a union variant is non-breaking” is not generally true for exhaustive consumers. Add a protocol version/capability handshake and an UNKNOWN_OP error if independently versioned adapters can meet.

### Q5. Selection versus named brushes: keep both at different layers

SelectionSpec/ResolvedSelection is the correct core execution primitive. A named Brush is a first-class project/share object that compiles to a selection. Do not put names, colors, or link metadata in the numeric analysis primitive.

~~~ts
interface Brush {
  readonly id: string;
  readonly name: string;
  readonly anchors: readonly {
    readonly doc: ProjectDocId;
    readonly text: TextHash;
    readonly chars: CharRange;
  }[];
}
~~~

This gives the UI linkable/serializable brushes while keeping kernels simple. Character anchors survive a token recipe change; recompilation either produces a new token selection or reports that the TextHash no longer matches. Selection hashes are snapshot-bound and derived, never persisted as authority.

### Q6. Recipe gaps: yes, several would break reproducibility

Must be versioned before implementation:

- normalization order and whether it applies to full text or per-token keys;
- effective locale resolution for mixed-language corpora;
- word token emission and token-class definitions;
- sentence segmentation policy;
- paragraph segmentation policy, including CRLF/newline/blank-line handling;
- apostrophe/hyphen normalization tables and operation order;
- numeral classifier and placeholder value;
- segmenter adapter/behavior fingerprint in artifact provenance and cache identity;
- canonical JSON/hash algorithm, string normalization, sorting, and treatment of defaults;
- extraction decoder/parser version and options, in a separate extraction recipe;
- structure detection policy and user override hash, in a separate structure artifact;
- quote-pair locale table and unmatched/nesting rules, in a separate quote recipe;
- stop-list content hash, in view defaults rather than the index recipe;
- regex engine/flags/time budget if regex remains;
- operation method IDs, versions, parameters, and effective defaults in QueryOp/QueryHash;
- annotation model, tagset, config, and offset-alignment identity in annotation keys/provenance.

Avoid one giant RecipeHash. Separate hashes let a stop-list edit reuse the index, a quote-policy edit reuse tokenization, and a tokenization edit reuse extracted text.

## 4. Worker protocol and progressive delivery

### 4.1 The current progress/doc-ready/provenance messages are not sufficient

Specific gaps:

- doc-ready lacks job, generation, recipe, snapshot, and index artifact identity;
- progress done/total has no unit or scope, and total may be unknown during parsing/tokenization;
- T0 has no source/text metadata event;
- T2/T3 have no snapshot/aggregate/annotation-ready event;
- excerpt has no response variant;
- ingest has no terminal success/commit response beyond doc-ready;
- evict has no acknowledgement, project scope, generation, or precise keys;
- query results do not echo op or snapshot;
- complete is not defined relative to an expected document set;
- indexedDocs uses a generic content hash, while missingDocs uses unstable numeric IDs;
- there is no way to represent “index is ready but quote/sentiment annotation is missing”;
- a synchronous CPU loop cannot receive a cancel message until it yields to the worker event loop.

### 4.2 Bind each query to an immutable snapshot

I recommend one-shot snapshot queries rather than a query silently changing inputs while it runs:

1. The shell starts a BuildGeneration with the expected stable document IDs and resolved recipes.
2. Each completed DocumentIndex is atomically committed under its content key.
3. The worker publishes a new immutable CorpusSnapshot after each document/aggregate availability change.
4. Active UI panels cancel/reissue their queries against the new snapshot. A result always describes exactly one frozen input set.
5. A recipe edit creates a new generation. Old generation events can still arrive, but the adapter ignores them by identity.
6. Extraction results that are independent of the changed index recipe may still be committed and reused; incomplete old index artifacts are never published.

A minimal protocol shape is:

~~~ts
type ToWorker =
  | { t: 'begin-generation'; generation: BuildGeneration;
      expectedDocs: readonly ProjectDocId[]; recipes: ResolvedRecipes }
  | { t: 'ingest'; job: JobId; generation: BuildGeneration; doc: ProjectDocId;
      source: SourceDescriptor; bytes: ArrayBuffer }
  | { t: 'query'; job: JobId; snapshot: CorpusSnapshotId; op: QueryOp }
  | { t: 'excerpt'; job: JobId; snapshot: CorpusSnapshotId; doc: ProjectDocId; chars: CharRange }
  | { t: 'cancel'; job: JobId };

type FromWorker =
  | { t: 'progress'; job: JobId; generation: BuildGeneration;
      phase: BuildPhase; unit: 'bytes' | 'utf16-code-units' | 'tokens' | 'documents';
      completed: number; total?: number }
  | { t: 'source-ready'; job: JobId; generation: BuildGeneration;
      doc: ProjectDocId; text: TextHash; lineCount: number }
  | { t: 'snapshot-published'; generation: BuildGeneration; snapshot: CorpusSnapshotId;
      readyDocs: readonly ProjectDocId[]; missingDocs: readonly ProjectDocId[] }
  | QueryResultMessage
  | { t: 'excerpt-result'; job: JobId; snapshot: CorpusSnapshotId;
      doc: ProjectDocId; chars: CharRange; text: string }
  | { t: 'error'; job: JobId; generation?: BuildGeneration;
      code: WorkerErrorCode; message: string; recoverable: boolean }
  | { t: 'cancelled'; job: JobId };
~~~

The exact names are negotiable; generation and snapshot semantics are not.

### 4.3 Cancellation needs scheduling semantics, not only a message variant

With one long-lived worker and no SharedArrayBuffer, cancel cannot interrupt a long synchronous JS loop or one huge WASM call. Specify that ingest and analysis passes run in bounded chunks, yield to the event loop, and check job cancellation between chunks. For a future WASM kernel, call it on bounded ranges so cancellation and progress remain observable. A cancel/result race is resolved by job terminal state plus snapshot/generation filtering in the adapter.

Recipe change invalidation should be generation replacement, not destructive cache deletion. Content-addressed old artifacts can remain until ordinary eviction. Stage a derived artifact and publish/commit it only after successful completion and generation validation.

Do not kill the sole index-owning worker for regex. Either cut regex from v1 or run it in a disposable secondary worker with a bounded input/result protocol. Respawning the long-lived worker loses resident indexes and makes every concurrent job fail for a non-core feature.

### 4.4 Strengthen partial provenance

indexedDocs: ContentHash[] is ambiguous and cannot distinguish duplicate source bytes, extraction versions, structure edits, or annotation readiness. Provenance should include:

~~~ts
interface AnalysisProvenance {
  readonly schema: 'texttrends/analysis-provenance/1';
  readonly coreVersion: string;
  readonly snapshot: CorpusSnapshotId;
  readonly query: QueryHash;
  readonly selection: SelectionHash;
  readonly indexRecipe: IndexRecipeHash;
  readonly inputs: readonly {
    readonly doc: ProjectDocId;
    readonly text: TextHash;
    readonly index: IndexArtifactHash;
    readonly structure: StructureHash;
    readonly annotations: readonly {
      readonly id: string;
      readonly artifact: string;
    }[];
  }[];
  readonly completeness: {
    readonly complete: boolean;
    readonly expectedDocs: readonly ProjectDocId[];
    readonly usedDocs: readonly ProjectDocId[];
    readonly missing: readonly {
      readonly doc: ProjectDocId;
      readonly dependency: 'index' | 'structure' | string;
      readonly reason: 'pending' | 'unsupported' | 'failed' | 'excluded';
    }[];
  };
  readonly methods: readonly {
    readonly id: string;
    readonly version: string;
    readonly configHash: string;
  }[];
}
~~~

computedAt can remain export metadata, but it is not a reproducibility input. app should be supplemented or replaced by contract/core versions. Analyzers should be a typed, ordered list with config/artifact identity rather than Record<string, string>.

This is adequate for T0-T4 once snapshot publication and dependency readiness are explicit. complete then means complete relative to expectedDocs and the operation’s declared dependencies, not merely “all currently indexed docs were used.”

## 5. WASM seam discipline

The intended discipline is right, but the worker protocol is not and should not be the exact WASM seam. It legitimately contains:

- source bytes and metadata;
- extracted strings for segmentation;
- TermGroup surfaces, prefixes, and potentially regex;
- excerpt text and error messages;
- vocabulary strings and UI-ready labels.

Define three layers:

~~~
Web Worker / Node adapter protocol
  -> JS orchestration: parse, segment, resolve strings, bind snapshot/selection
    -> NumericKernel interface: immutable typed arrays + scalars in; IDs/counts/positions/spans out
  <- JS materialization: TypeId -> string, excerpt slicing, provenance envelope
<- typed result protocol
~~~

The numeric seam should receive a NumericIndexView that excludes vocabulary strings, a ResolvedSelection of numeric ordinals/ranges, and a ResolvedQuery containing type-ID sets or phrase ID sequences. Frequency/collocation kernels return type IDs and numbers; JS maps only the bounded output rows to strings. KWIC kernels return document IDs and UTF-16 span pairs; JS materializes excerpts. Quote detection may remain a deterministic whole-document string pass; if ever moved to WASM, pass one packed document buffer and receive span arrays, never call once per token.

Segmenter.segment currently returns an Iterable of per-token objects. That is acceptable as a TS adapter implementation detail, but it contradicts the claim that this exact boundary has no per-token crossings. Prefer the packed SegmentationBatch shown above and explicitly place segmentation outside NumericKernel.

Also avoid promising zero-copy at the JS/WASM boundary. A WebAssembly module generally operates on its own linear memory, so an adapter may copy immutable index buffers unless it constructs/owns them there. The important guarantees are coarse calls, numeric data, bounded outputs, and no string/per-token FFI—not universal zero-copy.

The proposed per-document shards are a good WASM unit: a pass can consume one or several immutable shards in bounded batches. A mutable global index would be worse for both WASM and progressive cancellation.

## 6. Persistence-key corrections

Use schema-versioned compound keys (native IndexedDB tuple keys are preferable to pretending paths are a filesystem). The dependency chain should be explicit:

~~~
source-blob / schema / sourceHash
extraction / schema / sourceHash / extractionRecipeHash
text / schema / textHash
structure / schema / textHash / structureRecipeHash
document-index / schema / textHash / indexRecipeHash / segmenterFingerprint
quote / schema / indexArtifactHash / quoteRecipeHash
annotation / schema / indexArtifactHash / packId / modelVersion / configHash
project / schema / projectId
~~~

The extraction record maps sourceHash + extraction recipe to TextHash and any parser evidence. The text record is addressed by the hash of the extracted text itself. An annotation key must include the exact index/offset identity it aligns to, not only text hash and pack version. Avoid duplicating engine in both RecipeHash and a trailing key component without specifying which one is authoritative.

Persisted artifacts need an internal schema/version header and length invariants. The runtime lookup Map and vocabulary fold maps are reconstructable indexes, not canonical persisted data. vocab.byteLength is not a meaningful JS memory budget (strings are not UTF-8-resident by contract) and should be removed unless a measured serialization feature needs it.

## 7. Overfit or premature v1 surface

Cut or move these before freezing v1:

- Document.text: never: remove; it is a type error, not a guard.
- Corpus-global canonical TokenPos and monolithic CorpusIndex: replace with document-local shards plus snapshots.
- flags.inQuote: move to the quote artifact.
- open-ended flags ellipsis: replace with a versioned, closed token-class ABI.
- vocabulary.byteLength: remove unless a concrete persisted-byte calculation consumes it.
- vocabulary.lookup Map from the persisted artifact: reconstruct at runtime.
- included on Document: move to project/selection state.
- evict from the portable analysis protocol: cache eviction is adapter/storage management. If retained in the worker adapter, target explicit artifact keys and acknowledge completion; never expose scope: all as a casual core command.
- regex GroupMember in v1: defer until it has a disposable worker or a guaranteed linear-time engine. Term tokens, phrases, prefixes, and suffixes cover the decided MVP.
- SmoothingSpec in core: it is unused and LOESS/rolling window and edge semantics are underspecified. Either keep smoothing in the presentation layer over raw bins or add a complete method spec later.
- epub and pdf in the v1 source union: v1 ingestion is TXT/Markdown; EPUB has an explicit Phase 2 spike and PDF is Phase 4. Add protocol capabilities/versioned variants when those adapters exist.
- Section.depth: 0 | 1 | 2: replace with parent/level.

Do **not** cut trend, occurrences/KWIC, inventory, keyness, collocates, TF-IDF sections, bursts, or quote detection merely because their request/result types are incomplete. They are decided MVP dependencies. Complete their method and result contracts instead.

## 8. Must change before implementation

1. Replace the monolithic corpus-global persisted index with immutable per-document shards and immutable, generation-tagged CorpusSnapshot composition.
2. Replace persistent numeric DocId/global TokenPos uses with stable document IDs plus document-local positions; make sequence position snapshot-derived.
3. Split extraction, index, structure, view/stop-list, quote, annotation, and per-operation method invalidation identities.
4. Fix normalization order, token emission/classes, sentence/paragraph policies, mixed-locale resolution, long-token overflow, terminal bounds, and the closed token flag/class ABI.
5. Preserve case/diacritic-bearing vocabulary variants so promised per-query matching controls are implementable.
6. Define every public request and result type, every referenced type (including FreqFilter and WorkerErrorCode), complete mathematical method parameters, and correlate op to result without unknown.
7. Add build generation and snapshot identity to the worker lifecycle; add source/snapshot/annotation readiness, excerpt response, terminal ingest semantics, and explicit progress units.
8. Specify cooperative chunking/yield points and atomic artifact publication so cancellation and recipe replacement are real rather than nominal.
9. Separate the JS worker protocol from the internal NumericKernel/WASM seam; resolve/materialize strings in JS and batch segmentation output.
10. Strengthen provenance to identify exact document/text/index/structure/annotation inputs and missing dependencies, and correct persistence keys accordingly.

## 9. Fine to defer

- eager bigram postings; use on-demand phrase verification;
- corpus-wide compacted acceleration buffers on top of document shards;
- an LRU phrase-result cache;
- a derived quote membership bitset beyond canonical quote spans;
- regex support and its isolated execution environment;
- core-computed LOESS/smoothing;
- EPUB/PDF adapters and their schema variants;
- actual WASM implementation or WASM-owned index memory;
- 64-bit positions beyond an explicitly enforced v1 Uint32 corpus/document cap;
- compression of named brushes in share URLs and richer brush presentation metadata;
- persisted query-result caches, provided provenance and snapshot-bound recomputation are correct first.

In short: the product contract is conceptually sound, but its canonical identity should be **document index artifact -> corpus snapshot -> snapshot-bound query result**, not one mutable corpus-global array graph. Make that shift and the rest of the draft becomes a tractable set of versioned schemas rather than a set of conflicting lifetime assumptions.
