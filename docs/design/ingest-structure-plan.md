# Reviewed plan: user ingest and chapter structure

*Codex (gpt-5.6-sol) consultation `ingest-structure-consult-1`, 2026-07-20, via
parley — the planning review for the phase following Milestones 5–6. Recorded
verbatim as the plan of record (precedent: phase1-plan.md). The "must change
before implementation" list amends analysis-contract.md §2–3; the commit
sequence at the end governs this phase's implementation order.*

---

# User ingest + chapter structure: architecture review

## Overall verdict

Proceed, but do not implement the proposal exactly as written. The phase is correctly scoped around TXT/MD ingest, one explicit project, previewable structure, and warm reopen. Five contract-level changes should land before storage or protocol code:

1. **Separate durable user data from disposable artifacts.** `projects` and opted-in `sources` must not live in the provisional artifact database. They are class 1 and require acknowledged writes and migrations; artifacts are class 3 and may be abandoned.
2. **Add the missing extraction artifact.** The proposed stores omit the contract's `[SourceHash, ExtractionRecipeHash] -> TextHash + evidence + structure candidates` record. Without it, a warm open cannot prove how bytes became text or invalidate Markdown candidates independently.
3. **Fix the structure key.** A section table that consumes parser-produced candidates cannot be keyed only by `TextHash + StructureRecipeHash + OverrideHash`. The same decoded text can produce different candidates under different extraction/parser recipes. Add `StructureCandidateHash` (or an equivalent extraction-artifact identity) to the structure key.
4. **Send override content, not only its hash.** A restart cannot reconstruct the section table from a hash. `begin-generation` must carry the canonical override value plus its claimed hash, and the worker must recompute the hash.
5. **Do not persist an ordered UI edit log as the override contract.** Store a canonical, declarative, conflict-free patch set (or final corrected outline). Arbitrary command order becomes accidental semantics and omits important corrections such as re-anchoring and re-parenting.

I agree with keeping fixed-token segments out of the canonical section artifact and computing section token views lazily in v1. I also agree with a snapshot-bound `structure` query rather than adding section tables to every `snapshot-published` event.

One stale UI reference should be removed from the phase: the owner cut the barcode and the landed UI no longer has one. Render chapter rules in the declared-sequence trend and by-book sparklines; do not reintroduce a barcode for this work.

## Direct answers

### (a) Database layout: new artifact DB name; separate stable user-data DB

For the current provisional artifact database, the M5 rule applies to **additive stores too**. Its name ends in `db1`, and the implementation explicitly promises that a future layout bump opens a new name. Do not weaken that promise in the very next phase.

Use a new disposable artifact namespace, for example:

```text
texttrends-artifacts-provisional-db2
  texts
  extractions
  shards
  structures
```

Abandoning the old database costs one cold rebuild and no user data. This early phase is the cheapest possible time to pay that cost. The new name also avoids an upgrade being blocked by a tab that still has the M5 database open.

Do **not** put `projects` or `sources` there. Create a stable database whose contract is migration, not abandonment:

```text
texttrends-user-data                 // IDB version 1
  projects
  sources
```

Future additive changes to this durable database should bump the IndexedDB version under the **same** name and run explicit migrations. A blocked upgrade here must surface “close the other tab and retry”; it must not silently fall back and claim a project was saved.

This split also makes “clear cache” implementable without dangerous store-name filtering:

- clearing the artifact DB removes only recomputable class-3 data;
- deleting a project or persisted source is an explicit class-1 action in the user-data DB.

### (b) Raw Markdown: acceptable only as an explicitly literal provisional mode

Indexing literal Markdown is not an identity poison: a later parser recipe changes the extraction identity and `TextHash`, so the invalidation chain can rebuild correctly. It can, however, be an **analysis-quality poison** if described as semantic Markdown extraction.

The heading markers themselves are not the main problem. `#` and emphasis punctuation are not emitted lexical tokens, and heading words are legitimate document words. The meaningful pollution comes from:

- link destinations and reference definitions;
- URLs and autolinks;
- fenced/inline code;
- YAML front matter;
- raw HTML and generated metadata.

For book-like prose Markdown with little of those constructs, literal indexing is a reasonable v1 scope cut. Name it honestly:

```ts
type MarkdownParserV0 = {
  readonly id: 'markdown-literal-with-heading-scan-v0';
  readonly textPolicy: 'preserve-source-markdown';
  readonly headingScanner: 'markdown-heading-scan-v1';
};
```

The import preview should say “Markdown markup is included in analysis” and offer “treat as TXT” if heading detection is unwanted. Do not call this `mdast`, CommonMark extraction, or cleaned prose.

Before freezing even that provisional recipe, run the already-planned parser spike against a small golden set containing links, fences, HTML, front matter, ATX headings, and setext headings. That is a bounded decision spike, not a commitment to ship an AST dependency now. If representative book files contain material link/code pollution, pull semantic extraction forward; otherwise ship literal mode and defer it.

A regex-only heading scanner must at least track fenced and indented code. Otherwise `# heading` inside a code fence becomes a false chapter. If it does not implement CommonMark rules, call it a heading scan rather than `CommonMark headings`.

### (c) Project ownership: main thread owns meaning; worker owns physical storage

A real project manifest changes the M5 verdict. The rejected worker-owned doc-to-hash map was a hidden mutable alias cache that could silently outrank the authoritative corpus manifest. A versioned project record written in response to explicit user intent is the authority itself.

Use this ownership split:

- **Main thread:** constructs and owns the current `ProjectManifestV1`, stable doc IDs, declared order, metadata, override values, dirty/saved state, and generation intent.
- **Worker:** is the sole IndexedDB actor for both databases, validates records, stores/retrieves large source bytes without cloning them through the main thread, and acknowledges durable commits.

Do not simply extend the existing `ArtifactStore`. It has intentionally weak “best effort, degrade to memory” semantics that are correct only for class-3 data. Introduce a second capability:

```ts
interface UserDataStore {
  getProject(id: ProjectId): Promise<CacheRead<unknown>>;
  putProject(
    project: ProjectManifestV1,
    expectedRevision: number,
  ): Promise<{ readonly revision: number }>;

  getSource(hash: SourceHash): Promise<CacheRead<ArrayBuffer>>;
  putSource(source: StoredSourceV1): Promise<void>;
  deleteSource(hash: SourceHash): Promise<void>;

  close(): void;
}
```

User-data writes may fail without failing analysis, but they may **not** pretend to succeed. The UI remains session-capable and visibly unsaved. Keep the dropped `File` object in main-thread session state until a `source-persisted` acknowledgement, so a worker death or quota failure can be retried by reading the file again.

For a persisted source, the safe ordering is:

1. worker hashes/extracts the bytes;
2. worker durably stores the content-addressed source and acknowledges it;
3. main marks that source as `persisted` in its manifest and asks the worker to save the new project revision.

A crash between 2 and 3 leaves an unreferenced source record, which is harmless. The reverse ordering would leave a manifest falsely claiming its source is durable. An atomic cross-store transaction is also fine because `sources` and `projects` share the stable database, but it is not required for v1.

Add a monotonic project `revision` and compare-and-swap save. Two tabs must not silently last-write-win over metadata or chapter corrections. BroadcastChannel collaboration can wait; conflict detection cannot.

### (d) Section token views: derive lazily and memoize; do not persist in v1

Compute `[StructureHash, IndexArtifactHash] -> SectionTokenView` on the first structure query and memoize it in worker memory. For a few dozen or few hundred sections, binary searches over `startsUtf16` are trivial compared with IDB clone and validation costs. The contract calls this a derived artifact; it does not require every derived artifact to be durable.

Define the projection rule now. Use token-start ownership:

```ts
function charRangeToTokenRange(
  startsUtf16: Uint32Array,
  chars: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number } {
  return {
    start: lowerBound(startsUtf16, chars.start),
    end: lowerBound(startsUtf16, chars.end),
  };
}
```

That means a token belongs to a section when its start offset is in the section's half-open character range. It gives adjacent sibling sections disjoint token ranges even if a user places a character boundary inside a token. An “any span overlap” rule can assign the same token to both siblings and must not be used. The correction UI should snap boundaries to line starts and, when an index exists, optionally warn about an anchor inside a token.

Persist `section-tokens` only if a benchmark later shows repeated derivation is material. The public `structure` result should echo both input identities so no consumer can pair ranges with the wrong snapshot artifacts:

```ts
interface StructureQueryResultV1 {
  readonly doc: ProjectDocId;
  readonly structure: StructureHash;
  readonly index: IndexArtifactHash;
  readonly sections: readonly Section[];
  readonly tokens: readonly TokenRange[]; // parallel, validated lengths
}
```

Since this is a small string-bearing adapter result, a row shape `{ section, tokens }` is also reasonable and harder for UI code to mis-zip. The numeric core can still produce paired start/end arrays.

### (e) SourceHash and TextHash: store both, bound to the extraction recipe

Yes. They answer different questions:

- `SourceHash` identifies the exact dropped bytes, including a BOM and original byte encoding.
- `TextHash` identifies the unchanged decoded/extracted UTF-16 string addressed by every character offset and index shard.

The same text with and without a BOM should have different source hashes and the same text hash. The same Markdown bytes under literal versus semantic extraction may have the same or different text hash, but the extraction artifact identity still changes.

Do not store a floating `expectedText` divorced from its recipe. Store the full evidence chain in the manifest:

```ts
interface ProjectDocV1 {
  readonly doc: ProjectDocId;
  readonly sourceName: string; // display hint, never identity
  readonly meta: DocumentMeta;
  readonly source: SourceDescriptor;
  readonly sourceAvailability: 'persisted' | 'external' | 'bundled';
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: ExtractionRecipeHash;
    readonly text: TextHash;
    readonly candidates: StructureCandidateHash;
  };
  readonly structure: {
    readonly recipe: StructureRecipeProvisional;
    readonly recipeHash: StructureRecipeHash;
    readonly override: StructureOverrideV1;
    readonly overrideHash: StructureOverrideHash;
  };
}
```

On warm open, `expectedText` is derived only from an extraction record whose recipe hash still matches. If extraction changes, the old text identity is not an assertion about the new extraction.

Also keep one authority for order. Prefer `ProjectManifestV1.order: ProjectDocId[]`. If `DocumentMeta.seriesIndex` remains, define it as display metadata or derive it from `order`; do not let the two disagree.

### (f) Encoding fallback: exact deterministic policy

Use this v1 algorithm:

1. Compute and cap-check `SourceHash`/byte length over the received bytes.
2. If bytes begin with a supported BOM, treat it as authoritative:
   - UTF-8 BOM -> strict UTF-8;
   - UTF-16LE BOM -> strict UTF-16LE;
   - UTF-16BE BOM -> strict UTF-16BE.
   Strip the BOM from extracted text. Do not reinterpret malformed BOM-declared data as Windows-1252.
3. With no BOM, try UTF-8 with fatal errors.
4. If strict UTF-8 fails, decode with the WHATWG `windows-1252` mapping.
5. Preserve every newline and all other decoded characters exactly; no NFC, CRLF, or whitespace normalization of extracted text.

If `declared` is introduced through a future user encoding override, define precedence as `supported BOM > explicit declared encoding > automatic UTF-8/Windows-1252`. Restrict declared values to a versioned allowlist; filenames and browser MIME values are not trustworthy declarations.

For Windows-1252, follow the browser-compatible WHATWG mapping rather than inventing a “strict CP1252” variant. It maps 0x80 to the euro sign and maps the historically undefined bytes 0x81, 0x8D, 0x8F, 0x90, and 0x9D to their corresponding C1 control code points. A conforming `TextDecoder('windows-1252')` therefore has a total mapping and does **not** insert U+FFFD for those bytes. The [Encoding Standard](https://encoding.spec.whatwg.org/#names-and-labels) defines the labels/mapping, and its [single-byte decoder](https://encoding.spec.whatwg.org/#single-byte-decoder) is the normative algorithm.

Make the recipe reproducible rather than depending on an unnamed platform behavior:

```ts
interface DecoderPolicyV0 {
  readonly id: 'bom-utf8-windows1252-v1';
  readonly bom: 'utf8-utf16le-utf16be-v1';
  readonly unicodeErrors: 'fatal';
  readonly fallback: 'windows-1252-whatwg-v1';
  readonly windows1252TableHash: string;
  readonly newlineNormalization: 'none';
}
```

Either embed the tiny table or conformance-test the platform decoder against a table whose content hash is in the recipe.

`hadReplacementChars` must mean “the decoder inserted replacements,” not “the decoded text contains U+FFFD.” Under the strict-Unicode/total-Windows policy it will normally be false. If you expose a count in protocol v4, name it `decoderReplacementCount`; do not count an intentional U+FFFD in valid UTF-8 as data loss. Separately count suspicious C0/C1 controls as extraction evidence if useful.

The UX should use persistent per-document badges, with a one-time warning in addition:

- `Windows-1252 fallback` always gets a badge because detection was inferential;
- any decoder replacement or suspicious-control count gets a stronger badge and detail;
- encoding evidence remains inspectable after the toast disappears.

With a total Windows-1252 fallback, `DECODE_FAILED` is expected only for malformed BOM-declared Unicode, an unsupported explicit declaration, or an unavailable/conformance-failing decoder. Oversized input is `CAP_EXCEEDED`, not `DECODE_FAILED`.

### (g) Scope changes and sequencing

Keep the stated cuts, plus these:

- cut durable `section-tokens`; memoize only;
- cut fixed-token fallback entirely from this phase, including view-time UI, unless a real owner story needs it now;
- cut user-supplied regex rules; the built-in, constant chapter detector is enough for preview/correction and avoids a new untrusted-execution surface;
- cut arbitrary ordered edit history; persist canonical override intent;
- cut structure data from snapshot events;
- cut multi-tab live synchronization, but retain revision conflict detection;
- cut fancy reorder DnD; buttons/native controls are enough as long as the declared order is editable.

Pull these forward because later storage would make them expensive:

- the extraction artifact and candidate hash;
- a stable `ProjectManifestV1` with migration rules;
- separate durable-user-data failure semantics and save acknowledgements;
- exact file/document/project byte and character caps, checked both before transfer and in the worker;
- stable generated `ProjectDocId`s independent of filenames;
- structure artifact/runtime validators and deterministic section order;
- protocol runtime schemas for every new v4 request/result;
- an explicit “source unavailable; reattach matching file” state for non-persisted user documents.

## Contract corrections before code

### 1. Extraction candidates must participate in structure identity

The current contract says extraction invalidates structure candidates, while the structure persistence key contains only `TextHash + StructureRecipeHash + OverrideHash`. Those statements are incoherent when parser changes can leave text unchanged but change headings.

Add a candidate-set identity:

```ts
type ExtractionRecipeHash = Brand<string, 'ExtractionRecipeHash'>;
type StructureRecipeHash = Brand<string, 'StructureRecipeHash'>;
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

type StructureKeyV2 = readonly [
  'texttrends/structure/2',
  TextHash,
  StructureCandidateHash,
  StructureRecipeHash,
  StructureOverrideHash,
];
```

The extraction record remains keyed by `[source schema, SourceHash, ExtractionRecipeHash]`. The structure table is keyed by `StructureKeyV2`. A no-override case uses the hash of a canonical empty `StructureOverrideV1`; it is not represented by a missing tuple component.

### 2. Persisted structure records cannot contain project-scoped document identity

The contract's `Section` contains `doc: ProjectDocId`, but the structure artifact is keyed by text/recipe and is therefore reusable for identical text in two project documents. A single shared artifact cannot contain both project IDs. The landed root-only artifact already avoids `doc`, which is the coherent direction.

Separate persisted records from bound public views:

```ts
type StructureSectionKey = Brand<string, 'StructureSectionKey'>;

interface StructureSectionRecordV2 {
  readonly key: StructureSectionKey; // stable within this text/override lineage
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

interface Section extends Omit<StructureSectionRecordV2, 'key' | 'parent'> {
  readonly id: SectionId;       // project-bound view, derived from doc + stable key
  readonly doc: ProjectDocId;
  readonly parent?: SectionId;
}
```

Do not silently expand the already-landed `'texttrends/structure/1'` shape. Use a new artifact schema because adding recipe/candidate/override identity is a breaking persisted-ABI change even though structures have not yet been stored.

### 3. Define section-table invariants

Before detector code, require:

- exactly one root record, key `root`, origin `fixed`, level 0, no parent, range `[0, text.length)`;
- every offset is a finite non-negative UTF-16 integer within text length;
- keys are unique; parent keys exist; the parent graph is acyclic;
- every child range is contained in its parent's range;
- non-ancestor records do not overlap; adjacent siblings use half-open boundaries;
- deterministic table order: root, then depth-first in character-start order with key as final tie-breaker;
- no empty non-root range unless the UI explicitly supports marker-only sections (I recommend rejecting them in v1);
- title strings are bounded and cannot contain unpaired surrogates;
- `level` is validated but parent links, not level numbers, define hierarchy.

For detected chapters, start a section at its heading line and end it at the next heading of equal or higher outline rank, or document end. Root contains front matter and every child. A `Book`/`Part` detector may parent following `Chapter`s; a corpus with only `Chapter`s places them directly under root.

### 4. Make overrides declarative and complete

The proposed add/remove/retitle/re-level list is missing boundary movement and re-parenting—the two corrections a chapter editor will need. Use a non-conflicting patch set in canonical sort order:

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
```

Canonicalization sorts by `(target-or-key, op)` and rejects multiple changes to the same target/key; array order then has no semantic effect. `replace` carries the complete desired range/title/level/parent, so there is no ambiguity about omitted fields. User-added keys are generated once and stored in the manifest. The worker recomputes the override hash, applies it to the exact text/candidate/recipe base, validates the final table, and only then publishes a new snapshot.

If the text or candidate identity changes, do not guess how to shift anchors. Mark the override as needing review and present a rebase UI later. Silent offset migration would be worse than losing a cache.

## Recipe placement

Keep the invalidation split clean:

- TXT/Markdown byte decoding and parser-produced Markdown heading candidates belong to `ExtractionRecipeProvisional` and `ExtractionArtifactV1`.
- Conservative `Chapter|Book|Part` recognition over extracted text, evidence priority, hierarchy construction, and candidate selection belong to `StructureRecipeProvisional`.
- User corrections are a separate value/hash, not fields mutated into either recipe.

A reasonable provisional structure recipe is:

```ts
interface StructureRecipeProvisional {
  readonly schema: 'texttrends/structure-recipe/0-provisional';
  readonly root: 'whole-extracted-text-v1';
  readonly evidenceOrder: readonly [
    'extraction-candidates',
    'english-chapter-heading-v1',
  ];
  readonly chapterHeading: {
    readonly id: 'english-chapter-heading-v1';
    readonly linePolicy: 'unicode-lines-preserve-offsets-v1';
    readonly numerals: 'arabic-or-validated-roman-v1';
    readonly labels: readonly ['part', 'book', 'chapter'];
  };
}
```

Do not include fixed-token segmentation. It depends on an index recipe and cannot be placed in a canonical artifact keyed without `IndexArtifactHash`. If added later, expose it as an explicitly artificial snapshot/index-bound view, not as persisted canonical structure.

## Protocol v4 recommendation

A version bump is correct. This is not merely adding an optional field: `GenerationDocSpec`, progress phases, warm-miss reasons, source evidence, query union, and persistence messages all change exhaustiveness.

The begin-generation document must contain the values needed for a cold worker restart:

```ts
interface GenerationDocSpecV4 {
  readonly doc: ProjectDocId;
  readonly language: string;
  readonly source: {
    readonly expectedHash?: SourceHash;
    readonly byteLength: number;
    readonly format: 'txt' | 'md';
    readonly declaredEncoding?: string;
    readonly availability: 'bundled' | 'persisted' | 'external';
  };
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: ExtractionRecipeHash;
    readonly expectedText?: TextHash;
    readonly expectedCandidates?: StructureCandidateHash;
  };
  readonly structure: {
    readonly recipe: StructureRecipeProvisional;
    readonly recipeHash: StructureRecipeHash;
    readonly override: StructureOverrideV1;
    readonly overrideHash: StructureOverrideHash;
  };
}
```

The worker validates each recipe/override value and recomputes every claimed hash. Hashes are admission checks and lookup accelerators, not authority without their values.

`source-ready` should return the complete extraction evidence rather than one extra encoding string:

```ts
type SourceReadyV4 = {
  readonly t: 'source-ready';
  readonly job: JobId;
  readonly generation: BuildGeneration;
  readonly doc: ProjectDocId;
  readonly source: SourceDescriptor;
  readonly extractionRecipe: ExtractionRecipeHash;
  readonly text: TextHash;
  readonly textLengthUtf16: number;
  readonly candidates: StructureCandidateHash;
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
};
```

Add `extract` and `structure` to progress phases. Keep project/source durability as correlated storage acknowledgements rather than pretending it is analysis progress.

Warm-miss results need a requested dependency, not only a reason. User files cannot be fetched from a URL when the source is absent:

```ts
interface MissingWarmDocV4 {
  readonly doc: ProjectDocId;
  readonly need: 'source-bytes';
  readonly reason:
    | 'source-not-persisted'
    | 'source-miss'
    | 'source-corrupt'
    | 'extraction-miss'
    | 'rehydrate-failed';
}
```

The worker should re-extract directly from a persisted source on extraction/text miss and re-index from verified text on shard miss. It should recompute structure from extraction candidates/text on structure miss. Only an unavailable source should require main-thread bytes.

Add the structure operation to the existing snapshot-bound query union:

```ts
type QueryOpV4 = ExistingQueryOpV3 | {
  readonly op: 'structure';
  readonly request: { readonly doc: ProjectDocId };
};
```

The result returns the table and token views bound to the snapshot's exact `StructureHash` and `IndexArtifactHash`. Section edits replace the generation (the established recipe/intent invalidation mechanism), reuse text/shards, compose a new immutable snapshot, and reissue active queries. Do not mutate a published snapshot in place.

Project load/save/source-persist can be protocol messages on the same long-lived worker, but keep their types in a clearly separate storage operation map. They are not snapshot queries and have different error semantics (`PERSISTENCE_UNAVAILABLE`, `REVISION_CONFLICT`, `QUOTA_EXCEEDED`).

## Minimal project schema and UX semantics

Even “one implicit project” deserves a real schema:

```ts
interface ProjectManifestV1 {
  readonly schema: 'texttrends/project/1';
  readonly id: ProjectId;
  readonly revision: number;
  readonly order: readonly ProjectDocId[];
  readonly docs: readonly ProjectDocV1[];
  readonly indexRecipe: IndexRecipeProvisional;
  readonly indexRecipeHash: IndexRecipeHash;
}
```

Validate unique doc IDs, exact agreement between `order` and `docs`, all hashes and recipe values, byte/text caps, and source availability. Store full recipe values needed to reproduce the project, not only hashes.

For a non-persisted user file, reload should show the document metadata and a precise request to reattach the matching bytes. On reattachment, hash bytes before accepting them for that doc. Do not silently substitute a same-named file. A content-identical file with a different name is valid; a same-named file with a different `SourceHash` is not.

“Persist source” must be an explicit per-document or import-level choice. Its status should be `saving | persisted | external | failed`, not a boolean that can become true before IDB durability.

Set hard ingest caps before accepting multiple files. The main thread rejects obviously oversized `File.size` values before reading, and the worker independently validates byte length, decoded UTF-16 length, document count, and project total. Pick the actual provisional numbers from the landed browser benchmarks; record them in a shared contract constant and return `CAP_EXCEEDED`, never an OOM-shaped `INTERNAL` error.

## Chapter preview and rendering semantics

The structure panel should make detection provenance visible per row (`Markdown heading`, `chapter heuristic`, `user`) and support:

- accept/revert candidate;
- add/remove;
- edit title;
- move start/end boundary;
- re-parent/change outline level.

These controls generate the declarative override; they do not mutate stored detected candidates. Show the exact source line around an anchor so users correct evidence rather than opaque offsets.

In charts, render only the chosen outline level by default (usually top-level chapters), with deeper headings available in the structure panel. Drawing every Markdown subheading across six books will recreate the chartjunk problem the owner already rejected. Rules derive from the structure query's token ranges and the chart's existing declared-sequence bases.

## Recommended commit sequence

1. **Decision fixtures and contract amendment.** Time-box the Markdown literal-vs-parser spike; amend the structure key with candidate identity; separate persisted records from bound `Section`; define decoder, artifact, override, project, caps, and validator contracts.
2. **Pure extraction core.** Source hashing, BOM/UTF-8/Windows-1252 decoding, literal TXT/MD extraction, Markdown candidate scan, extraction identity, and golden tests. No worker or IDB yet.
3. **Pure structure core.** Conservative chapter candidates, hierarchy/range construction, override application, `StructureArtifactV2` validation/hash, and char-to-token projection. Test CR/LF/CRLF, Unicode/surrogate offsets, nested headings, false positives in code fences, malformed overrides, and boundary-inside-token behavior.
4. **Storage split.** New disposable artifact DB with `extractions` and `structures`; new stable user-data DB with `sources` and `projects`; in-memory implementations; corruption, quota, versionchange, revision-conflict, and migration fixtures. Do not modify the worker protocol in the same commit.
5. **Protocol v4 types and runtime schemas.** Per-doc source/extraction/structure inputs, full source evidence, dependency-aware warm misses, structure query, and explicit user-data storage operations/acks.
6. **Worker lifecycle.** Cold ingest, persisted-source re-extraction, text/shard/structure warm paths, source durability acknowledgements, cancellation checkpoints, generation replacement on override/recipe changes, and restart rehydration.
7. **Main-thread project store.** Stable doc IDs, one-project state, native drop/file picker, simple declared-order controls, metadata, dirty/saved/revision state, and reattachment flow. Keep `File` objects until persistence acknowledgements.
8. **Preview/correction and chart rules.** Structure query consumer, correction controls, visible encoding/provenance badges, top-level boundary rules, and no barcode resurrection.
9. **Real-browser proofs.** Extend Playwright for UTF BOMs and Windows fallback, multi-file transfer/detach, opted-in versus external reload, source/project durability failure, worker restart, extraction/structure corruption repair, override generation races, user-data versionchange, clear-cache isolation, and no main-thread long tasks.

This sequence keeps each commit reviewable and prevents the protocol or IDB schema from freezing shapes that the pure core has not validated.

## Must change before implementation

- Split durable user data from the disposable provisional artifact database.
- Honor the M5 new-name rule for artifact layout db2; use same-name migrations only for the new stable user-data DB.
- Add `ExtractionArtifactV1`/`StructureCandidateHash` and include candidate identity in structure keying.
- Store both SourceHash and recipe-bound TextHash in the manifest.
- Carry and verify full recipe/override values in protocol v4; a hash alone is insufficient.
- Replace ordered edit history with a complete, canonical override model including range and parent changes.
- Resolve the text-keyed-artifact versus `Section.doc` identity contradiction and bump the landed structure artifact schema.
- Define exact decoder/BOM/C1 behavior and persistent encoding evidence.
- Give class-1 writes explicit success/failure acknowledgements and revision-conflict semantics.
- Define section invariants, token projection semantics, ingest caps, and runtime validators before IDB records exist.

## Fine to defer

- Semantic Markdown AST extraction, if the bounded spike supports an explicitly labeled literal mode.
- EPUB/PDF and source maps back to their container formats.
- Fixed-token artificial segments.
- User-authored detector regexes.
- Durable section-token views.
- Multi-project navigation and multi-tab live collaboration.
- Portable project ZIPs, share links, file-system handles, eviction/LRU, and full-text editing.
- Sophisticated drag-and-drop ordering polish.

With those corrections, this phase remains a disciplined vertical slice: users can import honest bytes, understand decoding and chapter evidence, correct stable char anchors, reopen persisted work without re-tokenization, and clear caches without risking the only copy of their source.

---

## Spike result (2026-07-20, decision per §(b) above)

Literal-indexing pollution measured over two golden fixtures
(`packages/core/test/fixtures/md/*.ts` — TS modules so core tests stay platform-pure) by the EXECUTABLE methodology in
`packages/core/test/md-spike.test.ts` — the region definitions (front matter,
fenced code including info strings, inline code, link destinations,
reference-definition lines, reference-link labels in prose, autolinks, raw
HTML tag spans but NOT rendered element content) are precisely documented and
asserted there, and these numbers are its golden output:

| Fixture | Tokens | Polluted | Share |
|---|---:|---:|---:|
| `book-like.md` (headings + prose — the target corpus shape) | 177 | 0 | **0.0%** |
| `technical.md` (front matter, fences, links, HTML) | 146 | 68 | **46.6%** |

(The review of this commit measured 70 under a slightly different region
interpretation; the difference — reference-link labels vs rendered HTML
element content — is now pinned down explicitly in the test, which is the
methodology of record. The decision is insensitive to it either way.)

**Decision**: ship `markdown-literal-with-heading-scan-v0` for this phase —
book-like prose is unpolluted, and that is the product's corpus shape. The
import preview must disclose "Markdown markup is included in analysis" and
offer treat-as-TXT (heading detection off). The technical fixture stays as
the recorded boundary of this decision: material link/code pollution is real
for technical markdown, and the semantic-AST extraction spike (§8.8) is
pulled forward the moment such corpora become a target. Both fixtures feed
the extraction core's golden tests (commit 2 of the sequence).
