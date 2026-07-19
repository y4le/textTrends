# Analysis contract — Phase 0 design draft

*Status: DRAFT for Codex consultation, 2026-07-19. This document defines the typed
contract at the heart of textTrends: the data model every analysis reads, the recipe
that makes results reproducible, and the worker protocol that moves them. Once agreed,
these types are implemented in `packages/core` and only evolve with versioned
migrations.*

Design constraints inherited from [research](../research/synthesis.md): local-first;
exact positions canonical; preprocessing reversible and versioned; every result carries
provenance and completeness; progressive tiered delivery; language honesty; typed
arrays end-to-end; no framework types in `packages/core`.

## 1. Identifiers and primitives

```ts
// Branded numerics — prevent cross-domain mixups at compile time.
type DocId        = number & { readonly __brand: 'DocId' };        // index into corpus.docs
type SectionId    = number & { readonly __brand: 'SectionId' };
type TypeId       = number & { readonly __brand: 'TypeId' };       // vocabulary entry ("type" in the corpus-linguistics sense)
type TokenPos     = number & { readonly __brand: 'TokenPos' };     // global corpus token position [0, N)
type CharOffset   = number & { readonly __brand: 'CharOffset' };   // offset into a document's extracted text
type ContentHash  = string & { readonly __brand: 'ContentHash' };  // sha256:… of source bytes or derived artifact
type RecipeHash   = string & { readonly __brand: 'RecipeHash' };

// All corpus-scale data lives in typed arrays indexed by TokenPos.
```

## 2. Source, document, structure

```ts
interface SourceFile {
  hash: ContentHash;              // identity; dedup key; cache key root
  name: string;
  byteLength: number;
  format: 'txt' | 'md' | 'epub' | 'pdf';
  encoding: { declared?: string; detected: string; hadReplacementChars: boolean };
}

interface DocumentMeta {
  title: string;
  author?: string;
  year?: number;
  language: string;               // BCP-47; drives Intl.Segmenter + pack gating
  seriesIndex?: number;           // declared order within the corpus sequence
  tags: string[];
  sourceNote?: string;
}

interface Document {
  id: DocId;
  source: ContentHash;
  meta: DocumentMeta;
  included: boolean;              // exclude-without-delete
  text: never;                    // extracted text is NOT on this object — it lives in
                                  // worker/IndexedDB storage, fetched by excerpt request
}

// Structure spans are half-open token ranges plus their char equivalents.
interface Section {
  id: SectionId;
  doc: DocId;
  kind: 'declared' | 'detected' | 'artificial';   // epub/md heading | heuristic | fixed-token segment
  title?: string;
  tokenStart: TokenPos; tokenEnd: TokenPos;
  charStart: CharOffset; charEnd: CharOffset;
  depth: 0 | 1 | 2;               // book / chapter / sub-section
}
```

## 3. Normalization recipe (versioned, reversible)

```ts
interface Recipe {
  version: 1;
  unicodeForm: 'NFC' | 'NFKC';
  locale: string;
  caseFold: boolean;
  apostrophes: 'keep' | 'strip' | 'normalize';    // don't ↔ dont ↔ don’t
  hyphens: 'keep' | 'split' | 'join';
  numerals: 'keep' | 'drop' | 'placeholder';
  stopList: { builtin: string; added: string[]; removed: string[] } | null;
  analyzer: { name: 'intl-segmenter'; engineVersion: string };  // recorded, not assumed
}

// Segmentation is an INJECTED adapter (per the portable-core decision, §8.10):
// the core never constructs Intl.Segmenter itself. Browser and Node engines are
// conformance-tested against shared fixtures, never assumed identical. All offsets
// are UTF-16 code-unit offsets (JS string coordinates) by contract.
interface Segmenter {
  segment(text: string): Iterable<{ start: CharOffset; end: CharOffset; isWordLike: boolean }>;
  sentenceBreaks(text: string): Iterable<CharOffset>;
  provenance: { engine: string; version: string; locale: string };
}
// RecipeHash = hash(canonical JSON). Index artifacts are keyed by
// (source ContentHash, RecipeHash, analyzer engineVersion).
// Stop lists affect ranked *views*, never the index or literal search.
```

## 4. The corpus index (the single source of truth)

```ts
interface CorpusIndex {
  recipe: RecipeHash;
  docs: DocumentIndexEntry[];         // per-doc slices into the global arrays

  // Global, corpus-ordered:
  tokens: Uint32Array;                // TokenPos -> TypeId
  starts: Uint32Array;                // TokenPos -> CharOffset (into owning doc's text)
  lengths: Uint8Array;                // TokenPos -> char length (255 cap; overflow table)
  flags: Uint8Array;                  // TokenPos -> bitfield: isWordLike | sentenceStart |
                                      //   paragraphStart | inQuote | …

  vocab: {
    surface: string[];                // TypeId -> normalized surface form
    byteLength: Uint32Array;          // for budget accounting
    corpusFreq: Uint32Array;          // TypeId -> total count
    docFreq: Uint32Array;             // TypeId -> number of docs containing
    lookup: Map<string, TypeId>;
  };

  postings: Uint32Array[];            // TypeId -> sorted TokenPos[] (built by counting sort)

  bounds: {
    doc: Uint32Array;                 // DocId -> first TokenPos
    section: Uint32Array;             // SectionId -> first TokenPos (+ Section table)
    sentence: Uint32Array;            // sentence starts, global
    paragraph: Uint32Array;
  };
}

interface DocumentIndexEntry {
  doc: DocId;
  tokenStart: TokenPos; tokenEnd: TokenPos;
  textHash: ContentHash;              // extracted text identity (≠ source bytes for epub)
}
```

Notes for review: (a) `lengths`+`starts` reconstruct exact source spans for KWIC and
the readable axis without storing token strings twice; (b) `flags.inQuote` is set by
the quote-span pass at index time since dialogue share is MVP; (c) postings for
hapax-heavy vocab are many small arrays — alternative is one flat array + offsets
(CSR layout). **Question for Codex: CSR vs array-of-arrays?**

## 5. Selection, time, query

```ts
// A Selection is the universal "what am I looking at" — every panel filters by one.
interface Selection {
  docs: DocId[];                              // ordered (declared sequence)
  tokenRanges?: Array<[TokenPos, TokenPos]>;  // brushed spans, optional refinement
  hash: string;                               // canonical hash for provenance
}

type TimeCoordinate =
  | { kind: 'relative' }                      // percentile within each doc
  | { kind: 'absolute' }                      // global TokenPos
  | { kind: 'sequence' };                     // concatenated declared order

interface BinSpec { mode: 'equal-tokens'; count: number }          // default trend
interface SmoothingSpec { method: 'rolling-mean' | 'loess'; window: number }  // overlay only

interface TermGroup {
  id: string;                                 // stable, serialized to share links
  name: string;
  members: GroupMember[];
  countOverlaps: boolean;                     // default false: dedup within group
}

type GroupMember =
  | { kind: 'token';  surface: string;  caseSensitive?: boolean; diacriticSensitive?: boolean }
  | { kind: 'phrase'; surfaces: string[]; caseSensitive?: boolean }   // token sequence
  | { kind: 'prefix' | 'suffix'; stem: string }                       // safe wildcard
  | { kind: 'regex';  pattern: string };      // opt-in; worker-isolated; never auto-shared

interface Occurrence {
  pos: TokenPos;
  span: number;                               // tokens covered (phrases > 1)
  member: number;                             // index into group.members
}
```

## 6. Results and provenance

```ts
// Every analysis result — no exceptions — is wrapped:
interface AnalysisResult<T> {
  data: T;
  provenance: {
    app: string;                    // version
    recipe: RecipeHash;
    selection: string;              // Selection.hash
    indexedDocs: ContentHash[];     // exactly what was indexed when computed
    complete: boolean;              // false ⇒ partial (progressive tiers)
    missingDocs: DocId[];
    analyzers: Record<string, string>;  // e.g. { 'wink-eng-lite': '1.8.1' }
    computedAt: string;             // ISO — stamped by the shell, not the core
  };
}
// Exports serialize provenance alongside data. Partial results are marked or held.
```

## 7. Worker protocol (explicit, typed, no RPC library)

```ts
type JobId = number & { readonly __brand: 'JobId' };

type ToWorker =
  | { t: 'ingest';   job: JobId; source: SourceFile; bytes: ArrayBuffer; recipe: Recipe }   // transferred
  | { t: 'query';    job: JobId; op: QueryOp }
  | { t: 'excerpt';  job: JobId; doc: DocId; charStart: CharOffset; charEnd: CharOffset }
  | { t: 'cancel';   job: JobId }
  | { t: 'evict';    scope: 'derived' | 'all' };

type QueryOp =                       // one discriminated union per §3-research analysis
  | { op: 'trend';       group: TermGroup; sel: Selection; time: TimeCoordinate; bins: BinSpec }
  | { op: 'occurrences'; group: TermGroup; sel: Selection }
  | { op: 'kwic';        group: TermGroup; sel: Selection; contextTokens: number;
      sort: Array<{ at: 'L3'|'L2'|'L1'|'R1'|'R2'|'R3'|'doc'|'pos'; dir: 1|-1 }> }
  | { op: 'freq-list';   sel: Selection; filter: FreqFilter }
  | { op: 'keyness';     a: Selection; b: Selection; minCount: number }
  | { op: 'collocates';  node: TermGroup; sel: Selection; window: [number, number] }
  | { op: 'tfidf-sections'; sel: Selection; topK: number }
  | { op: 'bursts';      group: TermGroup; sel: Selection }
  | { op: 'inventory';   sel: Selection }
  // …extends per phase; adding a variant is non-breaking.

type FromWorker =
  | { t: 'progress'; job: JobId; phase: 'parse'|'tokenize'|'index'|'aggregate'; done: number; total: number }
  | { t: 'doc-ready'; doc: DocId; entry: DocumentIndexEntry }        // progressive T1
  | { t: 'result';   job: JobId; result: AnalysisResult<unknown> }   // narrowed by op at the boundary via Zod
  | { t: 'error';    job: JobId; code: WorkerErrorCode; message: string; recoverable: boolean }
  | { t: 'cancelled'; job: JobId };
```

Rules: buffers always transferred, never cloned; one long-lived worker; runaway regex ⇒
terminate + respawn + `error{recoverable:true}`; the UI store holds only results and
handles, never corpus arrays.

The analysis boundary doubles as the future WASM seam (§8.10 of the synthesis): index
buffers are immutable once built, every operation is batched (numeric buffers and
scalars in, numeric aggregates/positions/span-pairs out, strings materialized JS-side),
and no per-token callbacks cross the boundary. A pass can move to WASM behind this
exact interface without contract change.

## 8. Persistence keys (IndexedDB via idb)

```
sources/<contentHash>                  → class 1/2: original bytes (user opt-in) + meta
texts/<contentHash>                    → class 3*: extracted text (recomputable from source)
index/<textHash>/<recipeHash>/<engine> → class 3: CorpusIndex artifact (structured-clone of arrays)
annot/<textHash>/<pack>/<packVersion>  → class 3: NLP pack annotations
project/<projectId>                    → class 1: manifest (docs, groups, views, recipes)
```
*"Clear derived caches" deletes only class 3. Eviction of class 3 is a perf event iff a
class 1/2 source (or re-suppliable file) exists.*

## 9. Open questions for Codex

1. Postings layout: array-of-arrays vs CSR (flat Uint32Array + offset table)? CSR is
   friendlier to structured-clone/IndexedDB and cache-warm iteration; AoA is simpler.
2. Should `flags.inQuote` live in the core index build (quote detection is
   locale-sensitive) or as a separate deterministic pass keyed like an annotation pack?
3. Phrase queries: index bigram postings eagerly, or intersect unigram postings at
   query time (with position adjacency check)? Research says on-demand; confirm.
4. `AnalysisResult.data` typing across the worker boundary: per-op Zod schemas at the
   boundary vs a generated discriminated union — where does the narrowing live?
5. Is `Selection.tokenRanges` the right brushing primitive, or should brushes be
   first-class named objects (linkable, serializable to share links)?
6. Anything missing from Recipe that would break reproducibility if added later?
