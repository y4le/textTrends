# Reviewed Phase 1 plan: worker adapter, snapshots, and first query surface

## Executive recommendation

Proceed with the worker-owned architecture, but change the sequencing before implementation. The proposed package split is right:

- packages/core owns snapshot composition, selection/term resolution, numeric query kernels, operation request/result types, and semantic validation;
- apps/web owns Worker and IndexedDB APIs, wire-envelope validation, scheduling, persistence, text materialization, and transfer lists;
- the first UI consumes only snapshot IDs and bounded result payloads, never shards.

I would not implement all three proposed bullets as one milestone. There are several contract-to-code prerequisites that need to land first:

1. CorpusTypeId currently has no snapshot-level reverse vocabulary in CorpusSnapshotV1. localToCorpusType is unusable for materialization without it.
2. DocumentIndexV1 is still keyed by IndexRecipeProvisional. Durable IndexedDB keys should not be frozen until the recipe either graduates to canonical v1 or is explicitly stored in a disposable provisional namespace.
3. CorpusDocRef requires IndexArtifactHash and StructureHash, but the current builder produces neither identity. A snapshot cannot be validly composed from a naked DocumentIndexV1.
4. The current ingest envelope does not carry the document language needed by locale.mode = document-metadata, nor enough per-document identity to discover a warm cached artifact before bytes are reprocessed.
5. The contract requires each operation’s request/result types and runtime schema to be complete in core before implementation. Defining the only per-op schemas in apps/web would create two authorities.
6. “Check cancellation between documents” is not meaningful for this protocol: one ingest message is already one document/job. It gives the current job no cooperative cancellation point.

These are small enough to resolve before the adapter, and resolving them now will keep the first vertical slice from teaching the UI temporary semantics.

My recommended milestone sequence is:

1. contract-to-code closure and artifact identities;
2. deterministic snapshot/selection composition;
3. term resolution and the occurrence primitive;
4. trend and numeric KWIC planning/materialization;
5. worker state machine against an in-memory ArtifactStore;
6. IndexedDB ArtifactStore and warm reopen;
7. actual-browser integration/benchmark gates;
8. trends + barcode + KWIC UI.

## Direct answers

### a. Snapshot vocabulary: eager at publication, with an incremental fast path

Build the snapshot vocabulary and every localToCorpusType translation **eagerly as part of snapshot composition**. Do not make them query-triggered.

Reasons:

- localToCorpusType is already part of CorpusDocRef, so the contract treats translation as frozen snapshot input, not a cache side effect;
- CorpusTypeId needs deterministic meaning for provenance, later frequency/keyness operations, stable result ordering, and snapshot validation;
- lazy merge makes the first query pay an unpredictable corpus-wide cost and introduces mutable snapshot-adjacent state;
- every later corpus-level operation would otherwise repeat or coordinate the same merge;
- the cost is O(sum of ready-shard vocabulary sizes), not O(tokens), and is likely small compared with segmentation/indexing. It should still be benchmarked.

The merge must be deterministic from the snapshot’s declared order, never from asynchronous completion order:

~~~ts
interface SnapshotVocabularyV1 {
  readonly schema: 'texttrends/snapshot-vocabulary/1';
  readonly keys: readonly string[];          // CorpusTypeId -> case-bearing key
  readonly hash: SnapshotVocabularyHash;
}

interface CorpusSnapshotV1 {
  readonly schema: 'texttrends/corpus-snapshot/1';
  readonly id: CorpusSnapshotId;
  readonly generation: BuildGeneration;
  readonly expectedDocs: readonly ProjectDocId[];
  readonly docs: readonly CorpusDocRef[];
  readonly missingDocs: readonly ProjectDocId[];
  readonly vocabulary: SnapshotVocabularyV1; // currently missing from §5
}

function composeSnapshot(
  generation: BuildGeneration,
  expectedDocs: readonly ProjectDocId[],
  ready: ReadonlyMap<ProjectDocId, ReadyDocument>,
): CorpusSnapshotV1 {
  const keys: string[] = [];
  const keyToCorpusId = new Map<string, number>();
  const refs: CorpusDocRef[] = [];

  // Critical: expected/declaration order, not ready-map insertion order.
  for (const doc of expectedDocs) {
    const item = ready.get(doc);
    if (!item) continue;

    const localToCorpusType = new Uint32Array(item.shard.vocabulary.length);
    for (let local = 0; local < item.shard.vocabulary.length; local++) {
      const key = item.shard.vocabulary[local] as string;
      let corpus = keyToCorpusId.get(key);
      if (corpus === undefined) {
        corpus = keys.length;
        keyToCorpusId.set(key, corpus);
        keys.push(key);
      }
      localToCorpusType[local] = corpus;
    }
    refs.push(makeDocRef(item, localToCorpusType));
  }

  return finalizeAndHashSnapshot(generation, expectedDocs, refs, keys);
}
~~~

Use an incremental append fast path only when the ready set extends the previous snapshot by a declared-order suffix. Existing corpus IDs and translations can then be reused and only the new shard merged. Rebuild deterministically when:

- a previously missing earlier document arrives;
- documents are reordered;
- an artifact/recipe for an existing document changes;
- a gap or failed document means the ready set is not a simple prefix.

This avoids timing-dependent IDs while keeping the normal “documents finish in order” path O(new vocabulary). Do not mutate a previously published vocabulary array or translation table. Structural sharing may use immutable chunks later if copying the string-reference array measures as material; it is premature now.

Do not eagerly build corpus frequencies, document frequencies, or ranked aggregates in the first snapshot milestone. Vocabulary identity and translations are structural. Counts are T2 derived data and can be added with freq-list/keyness.

Fold maps are a different concern: build them **lazily per shard and matching mode**, not all at shard load. Four eager maps (exact/case/diacritic/both) multiply string/Map heap and are not needed by every session. Cache them in worker orchestration alongside the resident shard and discard them with that shard.

### b. IndexedDB ownership: worker-owned is the right default

The long-lived worker should own derived-text/index persistence and warm loading. This keeps large structured clones off the main thread, co-locates the resident shard registry with the cache, and prevents the main thread from receiving or transferring canonical index buffers.

The main thread should remain authoritative for user intent and small session state:

- current project/document order;
- current BuildGeneration;
- active JobIds and snapshot ID;
- dropped File handles/bytes until transferred;
- UI/project metadata.

It sends that state to the worker; the worker is the storage and analysis actor.

Use an injected storage interface so the worker state machine can be tested without IndexedDB:

~~~ts
interface ArtifactStore {
  getExtraction(key: ExtractionKey): Promise<StoredExtraction | undefined>;
  putExtraction(key: ExtractionKey, value: StoredExtraction): Promise<void>;

  getText(hash: TextHash): Promise<string | undefined>;
  putText(hash: TextHash, text: string): Promise<void>;

  getDocumentIndex(key: DocumentIndexKey): Promise<unknown | undefined>;
  putDocumentIndex(key: DocumentIndexKey, shard: DocumentIndexV1): Promise<void>;

  close(): void;
}

class WorkerEngine {
  constructor(
    private readonly store: ArtifactStore,
    private readonly emit: (message: FromWorker, transfers?: Transferable[]) => void,
    private readonly yieldControl: () => Promise<void>,
  ) {}
}
~~~

Use an in-memory implementation for deterministic unit tests and an idb implementation only in the web adapter.

Important pitfalls:

- **IndexedDB structured clone is not zero-copy.** put/get clones ArrayBuffers. Keep cache I/O off the T1 critical path where practical, and never claim transfer semantics for IDB.
- **Do all CPU work outside transactions.** IDB transactions auto-close when control leaves the chain of requests. Build and validate first; use short get/put transactions only.
- **Validate every loaded record.** Check schema, hash/key agreement, typed-array classes, parallel lengths, CSR terminal, bounds sentinels, caps, and vocabulary/translation invariants before admitting an artifact to a snapshot.
- **Do not transfer canonical shard buffers to the main thread.** Query results get newly owned buffers; transferring a postings/token buffer would detach the worker’s index.
- **Hash the fingerprint for the key.** The contract’s tuple shows segmenterFingerprint, but a plain object is not a valid IndexedDB key component. Add SegmenterFingerprintHash or a canonical fingerprint string and use that in the tuple.
- **Treat cache failure as recoverable.** Quota/private-mode errors should not invalidate a complete in-memory shard. Publish the validated in-memory snapshot, then persist or enqueue persistence; report a generation-level cache warning/error if the write fails.
- **Handle database lifecycle.** Close on versionchange, surface blocked upgrades across tabs, and make content-addressed puts idempotent. Only the worker/storage layer performs schema upgrades.
- **Plan worker restart.** The main thread must be able to resend the project/generation manifest; the replacement worker rehydrates from IndexedDB and republishes a snapshot.
- **Text residency needs a policy.** Keep only texts needed for current KWIC/excerpt pages in a worker-side LRU. A warm shard without its extracted text can answer trends/occurrences but must report a text dependency miss for KWIC unless the source can be re-extracted.

I would let W1 use the in-memory store, add IDB in W2, and require warm-reopen integration tests before the UI milestone. That separates protocol/lifecycle failures from browser storage failures without deferring persistence beyond the first vertical slice.

### c. Cancellation: between documents is not sufficient

No, not as the declared v1 behavior.

Each ingest message has one JobId and one document. A cancellation message for that job cannot be observed while synchronous Intl segmentation or index construction is running. “Check between documents” means the job has already finished; it only lets the adapter suppress a late event, not cancel work.

The measured 129–205 ms is encouraging, but it is warmed Node data, not a cold browser module worker, and the current benchmark says segmentation and build are roughly half each. For the sample-corpus vertical slice, it is reasonable to defer **sub-phase** chunking if a browser measurement confirms the budget, but not to defer every within-document checkpoint.

Minimum first-worker behavior:

~~~ts
async function ingest(job: IngestJob): Promise<void> {
  await checkpoint(job);              // yields to the worker task queue + checks job/generation
  const extracted = decodeAndExtract(job);

  await checkpoint(job);
  const segmentation = await segment(extracted.text, job.locale);

  await checkpoint(job);
  const shard = await createDocumentIndex(extracted.text, segmentation, job.recipe);

  await checkpoint(job);
  installValidatedShard(job, shard);  // atomic in-memory publication
  publishSnapshot(job.generation);

  void persistCompletedArtifact(job, shard); // complete artifact only; recoverable failure
}
~~~

checkpoint must yield to the worker **task queue** (for example via MessageChannel or setTimeout(0)); await Promise.resolve() only drains microtasks and does not let queued cancel messages run.

This gives a cancel point between decode, segmentation, and index construction, so the longest uninterruptible span is one measured phase rather than a whole document. Add a browser acceptance budget—my suggested initial gate is p95 cancel acknowledgement within 250 ms on the sample corpus and 1M tier. If either segmentation or build alone breaches that budget, sub-document chunking moves into v1 rather than being deferred.

For larger tiers, phase-level checkpoints are not enough. Add one of:

- an async/chunked Intl segment iterator that yields every bounded number of segments (segmentation is outside NumericKernel, so an injected scheduling checkpoint does not violate the WASM seam);
- a resumable document-index builder that interns/counts/fills in bounded ranges, while retaining the synchronous convenience wrapper for CLI/tests.

Do not overlook query cancellation. occurrences for a very common term, trend aggregation, and non-positional KWIC sorting can exceed ingest time at scale. Design numeric kernels with bounded step/range APIs from the start:

~~~ts
interface KernelStep<S, O> {
  readonly state: S;
  readonly output: O;
  readonly done: boolean;
}

function occurrenceStep(
  input: NumericOccurrenceInput,
  state: OccurrenceCursor,
  maxCandidates: number,
): KernelStep<OccurrenceCursor, NumericOccurrenceChunk>;
~~~

The worker calls a step, checks cancellation, yields, and continues. A Node convenience function may loop synchronously to completion. This preserves the batched numeric seam; do not pass a per-token shouldCancel callback into a future kernel.

Cancellation correctness still relies on identity:

- every async continuation rechecks JobId + generation/snapshot before mutation;
- the main adapter drops stale-generation messages even if cancellation races;
- an incomplete artifact is never admitted or persisted;
- old content-addressed complete artifacts need not be deleted on generation replacement.

### d. Contract violations, re-sequencing, and first-milestone cuts

The package structure is correct, but several details need adjustment.

#### 1. Complete operation contracts in core, not only Zod schemas in web

The v2.1 binding rule is explicit: request/result types and runtime schemas are complete in packages/core before an operation is implemented. Keep Zod as a web dependency if desired, but do not redefine semantic schemas there.

One workable split is:

- core exports OperationMap, QueryOp, result types, and dependency-free parse/validate functions for every op;
- web Zod validates the shallow versioned wire envelope and delegates op/result semantic validation to core;
- alternatively, put environment-neutral schemas in a shared core subpath and infer the TS types from them.

Avoid a hand-written core type plus a separate hand-written web Zod object for the same request. They will drift.

The adapter narrows immediately:

~~~ts
const envelope = WireEnvelopeSchema.parse(event.data);

switch (envelope.t) {
  case 'query': {
    const op = parseQueryOp(envelope.op); // single semantic authority in core
    return engine.query(envelope.job, envelope.snapshot, op);
  }
}
~~~

Typed-array result validation should inspect constructor, lengths, paired-array invariants, terminal values, and caps, not every element.

#### 2. Distinguish Numeric KWIC output from the public KwicResult

The proposed “char spans out, strings materialized by caller” is correct for NumericKernel, but the committed public KwicResult includes left, nodeText, and right strings. Preserve both layers:

~~~ts
interface NumericKwicRow {
  readonly docOrdinal: number;
  readonly pos: number;
  readonly spanTokens: number;
  readonly memberOrdinal: number;
  readonly leftChars: CharRange;
  readonly nodeChars: CharRange;
  readonly rightChars: CharRange;
}

// Numeric core planning/sort/page:
function kwicPageKernel(...): NumericKwicPage;

// JS orchestration after loading only texts represented on the page:
function materializeKwicPage(
  page: NumericKwicPage,
  texts: ReadonlyMap<ProjectDocId, string>,
): KwicResult;
~~~

Only bounded page strings cross postMessage. Sorting by L/R tokens can compare vocabulary keys/IDs without slicing every source string; materialize after sorting and paging. Specify deterministic final tie-breakers (declared doc ordinal, token position, member ID) and validate page caps.

The helper that computes token end must honor lengths8 = 255 through the long-token overflow table. Centralize it; do not duplicate overflow lookup in KWIC/excerpt code.

#### 3. Define artifact identity before snapshot composition

The current DocumentIndexV1 includes text/recipe/fingerprint but no IndexArtifactHash. Define a deterministic identity helper before snapshot.ts. A practical v1 identity can hash the canonical descriptor:

~~~ts
interface DocumentIndexIdentityV1 {
  readonly schema: 'texttrends/document-index-identity/1';
  readonly text: TextHash;
  readonly recipe: IndexRecipeHash;
  readonly segmenter: SegmenterFingerprintHash;
}
~~~

Because the builder is deterministic under a versioned schema, this avoids hashing every 15-bytes/token artifact again. Loaded arrays still require structural validation; if “artifact hash” is intended to mean a full byte-content digest instead, decide and benchmark that before using the brand.

Likewise, the first snapshot needs a real StructureHash. For the initial TXT vertical slice, use a deterministic root-only char-anchored structure artifact rather than fake-casting a string. Full heading/chapter detection can follow, but provenance cannot contain invented hashes.

#### 4. Close the warm-reopen/input-envelope gap

begin-generation currently carries expected document IDs and global recipes, while ingest carries SourceDescriptor + bytes. That is insufficient for:

- locale.mode = document-metadata, because no document language is sent;
- warm lookup, because no doc-to-source/text/index identity manifest is sent before bytes;
- detected encoding, because SourceDescriptor currently looks like post-decode metadata but is used as input;
- mixed TXT/Markdown extraction recipes if extraction is generation-global.

Add a per-document generation specification or extend ingest with resolved document inputs:

~~~ts
interface GenerationDocSpec {
  readonly doc: ProjectDocId;
  readonly language: string;
  readonly source: {
    readonly hash: SourceHash;
    readonly byteLength: number;
    readonly format: 'txt' | 'md';
    readonly declaredEncoding?: string;
  };
  readonly extraction: ExtractionRecipeV1;
  readonly knownText?: TextHash;
}

type BeginGeneration = Envelope<{
  t: 'begin-generation';
  job: JobId;
  generation: BuildGeneration;
  docs: readonly GenerationDocSpec[]; // also establishes declared order
  indexRecipe: IndexRecipeV1;
  structureRecipe: StructureRecipeV1;
}>;
~~~

Then warm reopen is:

1. resolve effective locale/fingerprint per doc;
2. use source + extraction identity to find TextHash unless knownText is trusted and verified;
3. form the document-index tuple key;
4. load/validate the shard;
5. request/accept bytes only for misses.

If changing the envelope is too much for W1, explicitly scope W1 to transferred, already-extracted UTF-16 sample text and do not call it the contract ingest path. Do not implement a misleading warm path that still transfers and hashes every source.

The worker should verify any supplied source hash against received bytes. SourceDescriptor.encoding.detected belongs in extraction output, not untrusted pre-decode input.

#### 5. Finalize or quarantine IndexRecipeProvisional before durable caching

The current source deliberately uses texttrends/index-recipe/0-provisional and documents missing canonical table identities. That is good defensive work, but the worker plan must acknowledge it.

Preferred: finish the canonical v1 recipe and validators before W2 IndexedDB persistence. At minimum, if work proceeds on provisional keys:

- use a storage schema/key namespace that says provisional;
- treat all such entries as disposable;
- do not write a migration promising semantic compatibility;
- never alias the provisional hash to texttrends/index-recipe/1 later.

#### 6. Define term-fold behavior before building fold maps

MatchMode says folded but does not specify the algorithm. JavaScript locale lowercasing is not full Unicode case folding, and diacritic removal order matters. Add a versioned resolver method, effective locale behavior, and fixtures before term-group resolution:

- case transform (for example toLocaleLowerCase under each shard’s resolved locale, named honestly rather than “Unicode full case fold”);
- diacritic transform (for example NFD, remove Mark code points, NFC);
- transform order;
- Turkish dotted/dotless I, Greek sigma, composed/decomposed accents, and smart-apostrophe fixtures;
- prefix/suffix matching over the effective transformed key.

Record the resolver method/version in QueryHash/provenance. Cache maps by shard artifact + resolver version + effective MatchMode.

#### 7. Clarify occurrence and trend edge semantics before coding

The shared occurrence primitive is the correct center. Its public/numeric shape should be decided first:

~~~ts
interface NumericOccurrences {
  readonly docOrdinal: Uint32Array;
  readonly pos: Uint32Array;
  readonly spanTokens: Uint32Array;
  readonly memberOrdinal: Uint32Array;
}
~~~

But v2.1 still leaves cases that affect results:

- when countOverlaps is false and two members cover overlapping but unequal spans, which span/member is emitted as evidence;
- whether a phrase must be fully contained in one selected token range (recommend yes);
- whether a phrase crossing a bin is assigned by start token (recommend yes);
- deterministic member precedence/ties;
- how a unioned overlap reports multiple matching member IDs.

For evidence honesty, consider a membership CSR alongside deduplicated spans if one span can be produced by multiple members. Do not silently discard that fact merely to preserve a singular member field.

Trend also needs a type correction before implementation. One bins: { count } does not fully specify all three coordinates:

- document-relative naturally means count bins per document;
- document-token comparison usually needs a fixed token width to preserve an absolute scale;
- declared-sequence must say whether bins span document boundaries or restart per document.

The exemplar returns doc per bin and says each document’s final bin may be short, which suggests bins restart per document even for declared-sequence; if so, declared-sequence changes only x-coordinate bases. State that explicitly. Also specify how discontinuous SelectionSpec.ranges affect bin domains and denominators. Do not let the first chart choose these semantics accidentally.

#### 8. Do not eagerly build every resolver map

The proposed “fold maps built per shard at load” should become:

- exact map built with or immediately after load if needed;
- one folded map built on first query for that MatchMode/resolver version;
- prefix/suffix initially scan the relevant normalized vocabulary or a sorted-key view; no trie;
- all resolver caches bounded and coupled to shard residency.

This preserves the persisted shard contract and avoids turning the preliminary ~15 bytes/token array-buffer result into an unmeasured heap multiplier.

## Recommended implementation sequence

### Milestone 0 — contract-to-code closure

Before a worker entry point:

- finish or explicitly quarantine IndexRecipeProvisional;
- define SourceInput/extraction output and per-document language identity;
- define SegmenterFingerprintHash and IndexArtifactHash derivation;
- define minimal StructureArtifactV1 and root-only TXT structure;
- add the missing snapshot vocabulary/reverse mapping;
- define CorpusSnapshotV1 validation and ID hashing;
- define OperationMap entries, request/result types, and runtime validators for only the operations about to ship;
- specify resolver folding, overlap/evidence, trend-bin, selection-range, and KWIC tie semantics.

This is not paperwork: each item affects cache keys or user-visible results.

### Milestone 1 — snapshot composer and selection resolver in core

Implement and test:

- composeSnapshot over validated ReadyDocument records, not naked shards;
- declared-order deterministic vocabulary merge and translations;
- sequenceTokenBase and V1_CAPS overflow checks;
- exact missingDocs complement and uniqueness/order validation;
- snapshot ID independent of completion timing;
- selection canonicalization (snapshot match, sorted/merged ranges, containment, no empty ranges);
- reorder and recipe/artifact replacement producing new snapshot IDs without re-tokenization.

Required fixtures:

- same ready set completed in different timing order -> identical snapshot;
- reorder -> only snapshot/order/bases change;
- a later doc ready before an earlier doc;
- a missing/failed earlier document followed by ready later documents;
- duplicate vocabulary keys across case/diacritic variants;
- empty document/corpus;
- translation length/key agreement and cap failures.

### Milestone 2 — term resolver and occurrence kernel

Build one reusable pipeline:

1. resolve GroupMember under the shard’s locale/resolver method;
2. union sorted postings for all resolved LocalTypeIds;
3. phrase anchor on the rarest resolved member and verify adjacent token IDs;
4. clip to selection ranges/sentences;
5. apply explicit overlap semantics;
6. emit numeric occurrence chunks in declared document order.

Token, phrase, prefix, and suffix variants must all work before the public occurrences op accepts the v1 GroupMember union. Internal token-only steps may land earlier, but the adapter must not silently accept and mishandle the other variants.

The barcode consumes this result directly. Trend and KWIC should reuse it rather than independently re-resolving group semantics.

### Milestone 3 — trend and KWIC core paths

Trend:

- finish coordinate/bin semantics first;
- aggregate occurrence starts into equal-token bins;
- emit raw count, true binTokens, ratePer10k, effective order, and sequence bases;
- no smoothing;
- test final short bins, zero-token docs, selected subranges, phrase spans, overlap mode, and missing docs.

KWIC:

- numeric candidate/sort/page kernel over shards and occurrence spans;
- stable sort with exact tie-breakers;
- page before string materialization;
- text materializer slices unchanged extracted UTF-16 with overflow-aware token ends;
- missing text is a declared dependency failure, not an empty row;
- test astral text, normalized keys versus raw nodeText, long tokens, sentence/document edges, multi-token nodes, all L/R sort keys, and pagination stability.

Inventory can wait unless it is deliberately used as the tiny first query to prove the protocol. It is not needed for the first trends/barcode/KWIC surface and its selection/sentence/type result semantics are not yet defined in code.

### Milestone 4 — worker engine with in-memory storage

Keep self.onmessage thin. Put state transitions in a testable WorkerEngine:

- versioned envelope parse;
- current generation and job terminal-state registry;
- begin-generation replacement;
- one-document ingest;
- phase-level checkpoint/yield;
- validated shard install;
- immutable snapshot publication;
- query binding to a known snapshot;
- excerpt result;
- cancellation and stale-generation suppression;
- typed transfer-list creation;
- deterministic error mapping.

Unit-test the engine in Node with fake storage, fake checkpoint control, and captured messages. Tests must force races by pausing promises between phases.

### Milestone 5 — worker-owned IndexedDB and warm reopen

Add idb behind ArtifactStore:

- tuple keys with only valid IDB key components;
- schema upgrade/versionchange handling;
- text + document-index put/get and validation;
- best-effort asynchronous cache writes;
- warm begin-generation lookup;
- recoverable quota/corruption behavior;
- worker restart rehydration;
- no shard buffers crossing to main.

The storage adapter may later persist sources/projects, structures, and annotations. Do not add eviction, project autosave, quote artifacts, NLP annotations, or result caches to this milestone.

### Milestone 6 — real browser tests and benchmark gates

Vitest/fakes cannot prove Worker transfer behavior or worker-side IndexedDB. Add a small Playwright suite in an actual browser:

- module worker starts under the deployed Vite base path;
- source bytes transfer and detach on the sender as intended;
- ingest emits ordered progress/source-ready/snapshot-published;
- query typed arrays transfer without detaching canonical worker shards;
- cancellation race never publishes an incomplete/stale snapshot;
- recipe change mid-ingest creates a new generation and ignores old messages;
- reload/worker restart warm-opens without invoking segmentation/index build;
- cache corruption is rejected and rebuilt;
- main thread has no long tasks attributable to analysis.

Extend the formal benchmark harness at this point:

- cold and warm worker startup;
- T0 and first T1 latency;
- snapshot merge time and vocabulary heap;
- occurrence/trend/KWIC latency for rare and very common groups;
- IDB write/read time and peak transient memory;
- cancellation acknowledgement latency;
- 1M/10M/50M retained residency and sharded-eviction behavior.

The current warmed Node numbers justify the direction but do not justify browser cancellation or warm-cache claims.

### Milestone 7 — first UI

Only after the worker’s public result contracts are stable:

- load one bundled public-domain corpus;
- render unsmoothed trend + exact barcode from the same occurrence semantics;
- click barcode/bin -> snapshot-bound KWIC page;
- excerpt/open-reader path;
- show partial status and missing documents from provenance;
- on snapshot-published, cancel/reissue active queries against the new immutable snapshot;
- never store shards or corpus typed arrays in React/zustand.

Start with one matching mode and a small number of named sample groups in the UI if necessary, but the worker operation must still implement the full accepted v1 request union.

## What to cut from the first worker milestone

Cut from W1, not necessarily from Phase 1:

- IndexedDB (use injected in-memory storage first; add IDB immediately in W2);
- inventory unless used as a deliberately specified smoke op;
- Markdown parsing and chapter heuristics (TXT + root structure first);
- quote detection/annotations;
- source-byte opt-in persistence and project manifest persistence;
- concurrent document builds;
- corpus frequency/doc-frequency aggregates;
- smoothing;
- query-result caching;
- resolver tries or all-mode eager fold maps;
- cache eviction UI/protocol;
- full structure editor;
- any main-thread ownership of shards.

Do **not** cut:

- versioned envelope validation;
- single-source operation schemas;
- generation/snapshot identity;
- phase-level cancellation checkpoints;
- artifact validation;
- snapshot-determinism tests;
- an actual-browser Worker/IDB test before UI;
- warm reopen before calling the adapter milestone complete.

## Must resolve before implementation versus safe to defer

Must resolve:

- snapshot reverse vocabulary and deterministic CorpusTypeId assignment;
- provisional recipe/cache namespace;
- IndexArtifactHash, SegmenterFingerprintHash, and minimal StructureHash;
- per-document language and warm-reopen manifest inputs;
- one authority for op types/runtime validation;
- matching-fold algorithm/version;
- occurrence overlap/evidence rules;
- trend coordinate/bin/range semantics;
- NumericKwicPage versus public KwicResult;
- real within-job yield points and cancellation measurement.

Safe to defer:

- structural sharing for snapshot vocabularies;
- eager corpus frequency aggregates;
- all-mode eager resolver maps, tries, and phrase caches;
- sub-segment chunking only if browser phase timings stay inside the cancellation budget;
- root structure replacement with chapter parsing;
- inventory, freq-list, keyness, quote annotations, and later MVP panels;
- source/project persistence, eviction, and result caches;
- corpus-wide compacted buffers and WASM.

## Bottom line

The proposed architecture respects the v2.1 portable-core and immutable-snapshot decisions once the public worker protocol is treated as orchestration—not the numeric seam. I recommend **eager deterministic snapshot vocabulary composition, worker-owned IndexedDB behind an injected store, and at least phase-level within-document cancellation in the first adapter**.

The most important re-sequencing is to finish identities and operation semantics before the worker: otherwise the worker will persist provisional artifacts, invent missing language/structure inputs, and force the first UI to depend on result shapes that the contract explicitly says must be complete first.
