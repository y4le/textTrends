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

---

# Commit 6 design of record — engine v4 worker lifecycle

*Codex consultation `engine-v4-consult-1`, 2026-07-20. Governs the commit-6
implementation and its required contract corrections. The "Must change before
implementation" list is the commit-6 checklist. Recorded verbatim below.*

# Commit 6 review: v4 worker lifecycle

## Overall verdict

The proposed direction is sound: keep generation replacement synchronous, keep `commitDocuments` as the only publication path, share the text-to-ready build path, and keep durable user-data commands outside analysis state. I would approve the restructuring after four changes are made part of commit 6 rather than left for later:

1. Resolve and semantically validate each v4 document spec once at generation start, but install the new generation identity *before* doing any asynchronous resolution.
2. Add an explicit “no active override” representation. The current v4 shape cannot honestly describe a first cold ingest, because a canonical `StructureOverrideV1` already requires the not-yet-known text and candidate identities.
3. Add per-document work claims/epochs. A `ReadyDocument`-identity superseded guard is no longer sufficient while warm probing, extraction, indexing, and structure building can overlap before any ready document exists.
4. Treat extraction and structure records as untrusted all the way through the engine. Commit 6 needs deep artifact validators and the remaining `StructureArtifactV2` snapshot seam; the IDB envelope checks alone are intentionally insufficient.

Candidates may be deterministically regenerated from verified text for the two currently admitted extraction recipes. That is the right v1 optimization, provided it is expressed as a core capability and not silently generalized to future parsers.

## Recommended state model

Keep declared order separately from a keyed resolved plan:

```ts
type OverrideInputV4 =
  | { readonly kind: "none" }
  | {
      readonly kind: "active";
      readonly value: StructureOverrideV1;
      readonly hash: string; // StructureOverrideHash
    };

interface ResolvedDocPlan {
  readonly spec: GenerationDocSpecV4;
  readonly doc: string;
  readonly language: string;
  readonly source: GenerationDocSpecV4["source"];

  readonly extractionRecipe: ExtractionRecipeProvisional;
  readonly extractionRecipeHash: string;
  readonly structureRecipe: StructureRecipeProvisional;
  readonly structureRecipeHash: string;
  readonly override: OverrideInputV4;

  readonly expectedText?: TextHash;
  readonly expectedTextLengthUtf16?: number;
  readonly expectedCandidates?: string;
  readonly effectiveLocale: string;
}

interface DocWorkSlot {
  /** Monotonic within this generation. */
  epoch: number;
  state: "unresolved" | "probing" | "building" | "ready" | "failed";
  ready?: ReadyDocumentV2;
  acceptedIdentity?: {
    source: SourceHash;
    text: TextHash;
    candidates: string;
  };
}

interface GenerationStateV4 {
  readonly generation: string;
  readonly docs: readonly string[];
  readonly rawSpecs: readonly GenerationDocSpecV4[];
  readonly plans: ReadonlyMap<string, ResolvedDocPlan>;
  readonly indexRecipe: IndexRecipeV1;
  readonly indexRecipeHash: string;

  readonly work: Map<string, DocWorkSlot>;
  readonly texts: Map<string, string>;
  readonly ready: Map<string, ReadyDocumentV2>;
  // snapshot, bindings, resolver caches, etc.
}

interface DocWorkToken {
  readonly generation: GenerationStateV4;
  readonly doc: string;
  readonly epoch: number;
}
```

The maps themselves remain engine-private mutable state. The recipes, hashes, and expected identities in each plan are immutable after resolution.

The important start sequence is:

1. Parse the envelope and synchronously replace the old generation with a new object in a `resolving` state. This immediately invalidates all old jobs and snapshots.
2. Under that captured generation/job, validate limits, document uniqueness, recipes, override values, and hash assertions; yield/checkpoint as needed.
3. Atomically install the resolved plan map only if the same generation still owns the job.
4. Begin warm probes.

Do not compute recipe or override hashes before replacing the generation if those computations await Web Crypto. An old generation must become stale at receipt of `begin-generation`, not after validation happens to finish.

## A. Generation state and resolved plans

**Verdict: precompute a resolved per-document plan.** Keeping the original specs is useful for diagnostics, but repeatedly searching them and rehashing recipes during every cache probe obscures both ownership and identity.

At resolution, the worker should recompute and compare every supplied hash rather than treating it as trusted routing data:

- index recipe hash once per generation;
- extraction and structure recipe hashes per distinct recipe;
- active override hash;
- recipe/source-format agreement (`txt` versus `md`);
- active override base identity agreement once text/candidates are known;
- effective locale and segmenter fingerprint inputs;
- unique document IDs, declared order, source byte lengths, and all ingest caps.

The computed hash is the cache key. A caller-provided hash is an assertion. If the two differ, reject the request rather than probing a caller-selected key.

Segmenter fingerprints can be memoized by effective locale because their computation is independent of the document. The plan can hold either the resolved fingerprint or a shared promise, but a failed or superseded resolution must not populate live generation state.

### Required protocol correction: an override is not always knowable

For a first user ingest, `TextHash` and `CandidateHash` do not exist until extraction completes. A canonical empty `StructureOverrideV1` cannot be constructed before then because its base identity includes those values. Requiring the current full override plus `overrideHash` invites placeholder identities or an override that the worker silently ignores.

Change the doc spec now, while v4 has not become the live protocol:

```ts
structure: {
  recipe: StructureRecipeProvisional;
  recipeHash: string;
  override:
    | { kind: "none" }
    | {
        kind: "active";
        value: StructureOverrideV1;
        hash: string;
      };
}
```

For `none`, the worker derives the canonical empty override and its hash after it knows the text/candidate identities. For `active`, it verifies both the hash and the override's base identities. An override retained by the project but marked needs-review after a source change must not be sent as active; the client should send `none` until the user rebases or accepts it.

This is a v4 correction, not a reason to introduce v5—the v4 engine has not shipped yet.

## B. Warm resolution and candidate reconstruction

### Candidates from verified text

**Yes for the current recipes, with an explicit capability boundary.** Both current extraction recipes define candidate generation as a deterministic function of decoded text plus recipe: TXT yields no heading candidates and Markdown runs the specified heading scanner. A verified text plus a verified recipe is therefore sufficient to reconstruct the same candidate set.

Move that fact into core rather than recreating extraction dispatch in the engine:

```ts
interface CandidateBundle {
  readonly candidates: readonly StructureCandidateV1[];
  readonly candidateHash: string;
}

function deriveCandidatesFromText(
  text: string,
  recipe: ExtractionRecipeProvisional,
): Promise<CandidateBundle>;
```

`extractDocument(bytes, recipe)` should call the same function after decoding, so cold extraction and warm reconstruction cannot drift. If a future recipe's candidate extraction depends on source bytes, parser side channels, or a transformed text representation, that recipe must not advertise this reconstruction path; warm resolution must then require a valid extraction artifact or persisted source.

When `expectedCandidates` exists, compare it with the reconstructed hash. A mismatch is a deterministic identity/manifest failure, not an ordinary cache miss. Fetching the same bytes again cannot repair it and may create an infinite “missing → ingest → mismatch” loop. Add a precise error such as `EXTRACTION_MISMATCH`, or deliberately map it to an existing request/source mismatch error with documented semantics.

Do **not** synthesize an `ExtractionArtifactV1` from text alone. The source descriptor, detected encoding, fallback evidence, and the source-to-text relationship cannot be reconstructed from decoded text. A warm rescan may yield an internal `CandidateBundle`; it does not create evidence that the source was decoded again. Cache a complete extraction artifact only after a real source extraction.

### Split probing from building

I would not make one large `prepareDocument(spec, opts)` own every cache probe and source case. That tends to become a flag matrix and makes it hard to distinguish admission from construction. Use two layers:

```ts
type WarmProbe =
  | { kind: "ready"; value: PreparedDocument }
  | { kind: "from-text"; text: VerifiedText; parts: AdmittedParts }
  | { kind: "from-source"; bytes: Uint8Array }
  | { kind: "needs-bytes"; reason: MissingReason }
  | { kind: "failed"; error: AnalysisError };

async function probeWarmDocument(
  plan: ResolvedDocPlan,
  token: DocWorkToken,
): Promise<WarmProbe>;

async function prepareFromText(
  plan: ResolvedDocPlan,
  input: {
    text: VerifiedText;
    extraction?: ExtractionArtifactV1;
    candidates?: CandidateBundle;
    admittedShard?: DocumentIndexV1;
    admittedStructure?: StructureArtifactV2;
  },
  token: DocWorkToken,
): Promise<PreparedDocument>;
```

Cold ingest is `extract bytes → prepareFromText`. Warm reopen probes artifacts, then calls the same builder only for missing dependencies.

### Recommended warm paths

| Available and valid | Work required | Network/ingest missing? |
|---|---|---|
| text + shard + structure, with all tuple identities known | none; exact admission | no |
| text + structure, shard missing | segment/index only | no |
| text + shard, structure missing | obtain candidates from valid extraction artifact or deterministic rescan; compose structure | no |
| text only | derive candidates as needed; build shard and structure | no |
| persisted source only | extract, then shared text preparation | no |
| neither text nor persisted source | none | yes, with the precise availability reason |

An exact structure hit does not require loading the candidate list if `expectedCandidates` supplies the candidate identity used in its key. If that identity is absent, a valid extraction artifact or deterministic rescan can discover it.

An extraction record is therefore useful for evidence, source identity, and avoiding rescans, but it is not a mandatory dependency of an exact warm reopen. This distinction is consistent with the artifact graph: the structure depends on candidate identity, not on the continued presence of the extraction record that once materialized the candidates.

### Deep admission is mandatory

The IDB adapter intentionally only checks record envelopes and key agreement. Before using a value returned as `unknown`, the engine/core must validate:

- extraction schema and complete key tuple;
- source descriptor/source hash/recipe agreement;
- text identity and UTF-16 length assertions;
- candidate ranges and ordering;
- recomputed candidate hash and well-formed evidence counts;
- structure schema and complete key tuple;
- root/parent/level/range invariants via `validateSectionTable` against verified text length.

Also finish the core v2 seam: `ReadyDocument`, structure hashing, `makeReadyDocument`, and snapshot composition currently accept the root-only `StructureArtifactV1`. Add explicit V2 functions/types; do not silently widen V1 schema handling.

### Honest progress

The current `extractDocument` performs decode and candidate scan as one call. That cannot truthfully support distinct `decode` and `extract` progress boundaries. Split core into a decode phase and an extraction-from-decoded-text phase, while retaining `extractDocument` as their convenience composition if desired. Emit a phase only immediately before the work it names.

On a text-only warm rescan, `extract` progress is appropriate; `decode` is not. On an exact artifact hit, neither is appropriate.

`source-ready` should be emitted when a complete, verified extraction result is available. If warm reopening only has verified text and a reconstructed candidate bundle, do not invent encoding/source evidence merely to emit the event. Either omit `source-ready` for that path or emit it only from a valid cached extraction artifact; document the event semantics for the client.

## C. Race and cancellation discipline

The existing synchronous generation/snapshot gates, query gates, composition mutex, and single publication path should all remain. The longer pipeline introduces one important hole: a `ReadyDocument`-identity guard cannot identify supersession before either competing path has committed a ready document.

Example:

1. warm resolution begins reading a cached structure for document D;
2. a live ingest for D starts and builds a new valid extraction/structure, but has not yet published its `ReadyDocument`;
3. the old warm read returns corrupt;
4. a guard that only compares the current ready object sees no replacement and deletes or diagnoses against the wrong work.

Use the `DocWorkToken`/epoch described above. Warm resolution claims D; a live ingest for D increments the slot epoch and becomes its owner. Before acting on any awaited result, emitting a warning, deleting an artifact, publishing, or updating missing state, check:

```ts
function ownsDoc(token: DocWorkToken): boolean {
  const gen = this.generation;
  return gen === token.generation
    && gen.work.get(token.doc)?.epoch === token.epoch;
}
```

`commitDocuments` should receive `{ prepared, token }` pairs. While holding the composition mutex it should discard any item that is no longer owned and stage bindings from the remaining candidates. If snapshot composition awaits, the final synchronous commit gate must recheck **all** candidate tokens as well as job/generation identity; if any changed, abort that staged commit and let the new owner publish from current state. A stale candidate cannot merely be filtered out after a snapshot was already composed around it. If no candidates remain, it emits nothing.

Other requirements to preserve:

- Checkpoint/gate after every awaited store read, hash, segmenter resolution, build, structure hash, and before every externally visible side effect.
- Put checkpoints before and after long synchronous decode/scan/index/structure work. A checkpoint before a synchronous function does not make the function interruptible, but it prevents obsolete work from starting; the checkpoint after prevents obsolete results from committing.
- Repair/delete only the exact disposable artifact key just admitted as corrupt, and only while the token still owns the document. Never delete a durable stored source automatically; it may be the user's only copy. Report corruption and request reattachment.
- Delay all best-effort disposable cache writes until the full `ReadyDocument` has passed the commit gate. This prevents a cancelled half-pipeline from looking like a completed build. Content-addressed writes may finish after publication, but they must contain fully validated artifacts.
- Freeze the first accepted source/text/candidate identity for a cold spec whose expected hashes were absent. A second ingest for the same document and generation with different bytes must be rejected or require a new generation; it must not mutate what that generation's document means.
- Reconcile `generation-ready.missing` against ready **and owned in-flight/accepted-byte** states, not just the ready map. Otherwise a concurrent ingest can be accepted while the begin job still reports the document missing and triggers a duplicate fetch. If that ingest later fails, the correlated error can make it retryable.
- Preserve snapshot identity in all query gates, including `structure`. A successful generation gate alone is insufficient because an incremental publication can supersede the snapshot within the same generation.

Cache mismatch and cache corruption must stay distinct. An internally valid artifact whose identity conflicts with an asserted `expectedText`/`expectedCandidates` is not corrupt storage and should not be deleted. It is a stale project manifest, changed source, or nondeterminism error.

## D. Override-only generations

**Correct:** an override-only change requires no bytes, so `generation-ready.missing` is empty. It normally emits `structure` and `compose` progress for the affected document, reuses verified text and shard artifacts, creates a new immutable snapshot, and never emits `segment` or `index`.

If the extraction artifact has been evicted and the worker must rescan verified Markdown text to recover the candidates needed for structure composition, an `extract` phase is also honest. The invariant should be “no source fetch and no index work,” not “only one exact phase name.”

For this case, batch exact hits and cheap structure-only reconstructions, then publish one complete snapshot. Publishing five unchanged exact documents and then a sixth structure-updated document provides no useful progressive-loading benefit and makes an atomic user edit appear temporarily incomplete. Continue incremental publication for genuinely longer source extraction or index rebuild paths.

The structure query must be cancelled/reissued on the new snapshot just like trend, KWIC, and passage. A structure result is bound to both `StructureHash` and `IndexArtifactHash`; it must echo both, and the client must gate on request epoch plus snapshot identity.

Compute token views lazily in v1. Memoize the doc-independent range projection by `[StructureHash, IndexArtifactHash]`, then bind project/document-specific `SectionId` values when answering the query. Add a deterministic binding helper for `DocumentId + lineage key → SectionId`, with an explicit method/version tag. Do not derive the ID from `StructureHash`, or a harmless retitle/range correction will unnecessarily change every section ID.

## E. User-data operations

The separate handler group is the correct architecture. It should share only the worker's envelope/job/cancellation infrastructure, not generation progress, snapshots, or the generic analysis error channel.

**Yes, `source-persist` must hash the exact received bytes and compare that result with the claimed `SourceHash` before writing.** Enforce source byte caps before copying or hashing. Transfer the buffer from the main thread and include this path in the transfer/detachment tests. Acknowledge `source-persisted` only after the durable transaction commits; only then may the main thread mark the source persisted and save a manifest that depends on it.

The current user-data error union lacks an identity mismatch. Add `SOURCE_MISMATCH` there rather than leaking an analysis error for a user-data command. Cancellation after hashing but before the put/ack must prevent both operations.

Keep a distinct catch/error mapping for user-data handlers:

```ts
async function handleUserData(
  message: UserDataRequestV4,
  job: JobContext,
): Promise<void> {
  try {
    // total payload validation, checkpoints, durable operation, ack
  } catch (error) {
    this.emitUserDataError(mapUserDataError(error, message));
  }
}
```

The fact that these commands do not mutate `GenerationState` does not make them uncancellable. Give them job ownership, particularly around source hashing and project CAS.

### Two landed storage issues should be fixed before wiring the handlers

1. `StoredProjectV1` currently wraps an `unknown` manifest and has its own `id`/`revision`, while the contractual `ProjectManifestV1` also owns schema/id/revision. The CAS increments the wrapper revision without necessarily updating the manifest revision. Eliminate the duplicate authority: validate a canonical `ProjectManifestV1`, and write the new revision into that canonical value within the compare-and-swap transaction (or make the envelope the sole contractual revision, not both).
2. A closed/unavailable durable user store must not report ordinary `miss`. `getProject`/`getSource` after failed open or `versionchange` should return `PERSISTENCE_UNAVAILABLE`. Install a `versionchange` close path and bound the initial open. A blocked or hung durable DB open must not prevent the artifact store and analysis engine from starting forever.

Commit 6 therefore needs a total `ProjectManifestV1` runtime validator before it accepts or emits `project-save`/`project-loaded`. If manifest semantics are deliberately commit 7, land the wire types and client methods now but do not enable the corresponding engine handlers against `unknown` data.

The shell can open artifact and user-data stores concurrently, with a bounded failure result for the latter. Analysis remains usable when durable project storage is unavailable; user-data commands receive a precise error rather than silently falling back to memory.

## F. Commit boundary and migration mechanics

An engine-only v4 commit that leaves the built app speaking v3 is not acceptable. Every repository commit should compile, test, and run. Your proposed boundary is right if commit 6 includes the minimal complete wire cutover:

- core V2 ready-document/snapshot identity functions and deep artifact validators;
- v4 engine and all engine lifecycle/race tests;
- worker shell switched to `parseToWorkerV4`, with both injected stores;
- `WorkerClient` message types, transfer lists, event dispatch, cancellation, and restart replay moved to v4;
- the current Sherlock loader constructing valid v4 specs;
- existing UI store calls adapted enough that the current application still boots and queries;
- real-browser/debug-trace fixtures updated for v4 phase/event/store expectations.

Commit 7 can still own the actual project feature surface:

- project manifest state in the application store;
- drag/drop and file picker;
- metadata/order/structure-edit UX;
- persist-source opt-in and dirty/saved UI semantics;
- built-in versus user-project selection.

It is fine for unused typed client methods for project load/save/source persist to land with the wire migration, but do not ship engine endpoints that store unvalidated `unknown` manifests merely to claim completeness.

If the combined cutover is too large for review, split it into two individually green commits:

1. Add V2 core admission/composition and a tested `engine-v4` implementation behind an unused entry while the app still runs v3.
2. Cut shell/client/Sherlock/e2e to v4 and remove v3.

Do not merge a midpoint at which the engine accepts only v4 while the client emits v3.

The bundled Sherlock specs will need actual extraction/structure recipe hashes, candidate assertions, source descriptors, and the new `override: { kind: "none" }` form. The source-byte hash and decoded-text hash happen to coincide for some plain UTF-8 files, but keep them semantically and structurally distinct.

## Suggested engine flow

```text
begin-generation received
  └─ synchronously replace generation / invalidate old snapshot
     └─ resolve + validate immutable doc plans
        └─ claim each doc for warm probing
           ├─ exact text + shard + structure ───────────┐
           ├─ verified text ── prepareFromText ─────────┤
           ├─ persisted source ─ extract ─ prepare... ──┤
           └─ no recoverable source ─ record byte miss  │
                                                        ▼
                          batch exact + structure-only commit
                                                        │
                          stream expensive rebuild commits
                                                        │
                          generation-ready(missing bytes only)

ingest bytes
  └─ claim/supersede doc work
     └─ cap + source-hash assertion
        └─ decode → extract candidates
           └─ freeze/check document identity
              └─ prepareFromText (admit or build shard/structure)
                 └─ single commitDocuments gate
                    └─ best-effort disposable artifact writes
```

Every downward transition after an `await` must recheck job, generation, and document claim ownership. Only the final commit mutates ready/text/snapshot bindings.

## Tests that should move with commit 6

In addition to rewriting the v3 fixtures into v4 shapes, add focused tests for the new failure modes:

1. A first cold ingest with `override: none` derives a canonical empty override after extraction.
2. An active override with the wrong hash or wrong base text/candidate identity is rejected before structure composition.
3. Exact warm reopen needs no decode/extract/segment/index/structure work.
4. Text + shard + missing structure performs only candidate recovery/structure/compose and publishes once for an override-only generation.
5. Text + missing shard + valid structure rebuilds the shard without source fetch.
6. Text without extraction record deterministically reconstructs candidates; a wrong `expectedCandidates` produces a terminal correlated error, not a byte miss loop.
7. Persisted source without text re-extracts; corrupt durable source is reported and retained.
8. A live ingest supersedes a warm structure/extraction read before either has a `ReadyDocument`; the stale read cannot warn, delete, commit, or publish.
9. Two same-generation ingests with different source/text identities cannot change the document identity in place.
10. `generation-ready.missing` excludes accepted/in-flight bytes and contains only documents that actually require bytes.
11. Cancellation at every new awaited boundary prevents cache repair, publication, and result emission.
12. A structure query cancelled by an incremental snapshot never emits a stale result, and returned hashes match the bound snapshot.
13. `source-persist` rejects a claimed-hash mismatch, transfers/detaches bytes, and acknowledges only after a completed durable write.
14. User-data store unavailability/versionchange emits `user-data-error` while analysis queries continue.
15. Browser warm/corruption tests account for `extractions` and `structures`; cold progress now includes honest `extract` and `structure` phases.

Retain the current injected-yield race matrix rather than merely translating happy-path fixtures. The central claim of commit 6 is preservation of the M5 lifecycle guarantees across two more artifact stages.

## Must change before implementation

- Add `override: none | active` to the not-yet-live v4 doc contract.
- Install a generation synchronously, then resolve immutable per-doc plans and verify all recipe/override hash assertions.
- Introduce per-document work claims/epochs; do not rely only on committed `ReadyDocument` identity.
- Export one core deterministic candidate-derivation function used by cold and warm paths.
- Add deep extraction/structure artifact validation before admission.
- Complete the `StructureArtifactV2` → `ReadyDocument` → snapshot hash/composition seam.
- Split decode from candidate extraction so progress events are truthful.
- Define terminal mismatch behavior for text/candidate assertions so the client cannot refetch forever.
- Bind section IDs deterministically from document plus lineage key and keep structure queries snapshot-bound.
- Verify bytes in `source-persist` and add a user-data mismatch error.
- Resolve the project manifest/revision double authority and validate manifests before enabling project handlers.
- Fix durable user-store unavailable/versionchange/open behavior so it neither masquerades as a miss nor blocks analysis startup.
- Migrate the minimum client, shell, Sherlock flow, tests, and browser harness in the same green cutover as the engine.

## Fine to defer

- Persisted section token views; lazy memoization is sufficient.
- Parallel document builds; sequential rebuild plus progressive publication remains simpler and safe.
- General support for candidate reconstruction by future extraction recipes; encode only the current deterministic capability.
- Project UI, drag/drop, structure editor, source-persistence choice, and multi-project lifecycle to commit 7.
- Recovery UI for needs-review overrides, provided inactive overrides are represented honestly as `none` now.
- Cache eviction, result caches, source transformations, and portable-project concerns already outside this phase.

With those changes, the v4 engine remains the same architecture rather than a second lifecycle bolted beside v3: immutable generation intent, dependency-aware artifact preparation, one guarded publication path, snapshot-bound queries, and a separate durable user-data lane.

---

# Commit 6b/6c boundary ruling — engine-v4 sequencing

*Codex consultation `req_consult_d6e2cf679dcd3e0d` (planner), 2026-07-20. Refines
the commit-6 design of record into a three-commit sequence: a storage
prerequisite, the cohesive unused engine (6b), and the atomic wire cutover
(6c). Recorded verbatim below; governs the 6b implementation.*

# Commit 6b boundary ruling

## Executive decision

Your split is the intended §F split.

- **Prerequisite storage correction:** land the two durable-store fixes as a small standalone commit before 6b.
- **6b:** add `WorkerEngineV4` as a new, directly unit-tested module, including its analysis lifecycle, warm/cold pipeline, structure query, and injected user-data handlers. It remains unused by `index.worker.ts`; the running app remains wholly v3.
- **6c:** atomically cut the shell, client, Sherlock spec construction, browser harness, and UI store to v4, then remove v3. No committed state may pair the v4 engine with the v3 client.

Keep the v4 engine cohesive in one file for this implementation. The state ownership and gates matter more than reaching a preferred line count.

There are three small prerequisite gaps to close before or alongside 6b: the durable project record/CAS shape, semantic hash verification in `validateProjectManifest`, and the still-unexported shared ingest caps. None should be reimplemented privately inside the engine.

## Q1 — Boundary

**Approve the proposed 6b boundary.** A new `engine-v4.ts` imported only by a new `engine-v4.test.ts` is a green, useful commit. It is not the forbidden midpoint because the production shell still imports the old `engine.ts` and the old client continues speaking v3 to it.

### 6b should contain

- `WorkerEngineV4` and its v4-only internal types;
- resolved generation plans and per-document work tokens;
- cold extraction, warm probing, preparation, structure composition, and the single publication path;
- trend/KWIC/passage/excerpt behavior migrated into the v4 engine;
- the new snapshot-bound structure query;
- user-data command handlers against an injected access seam;
- engine-level transfer lists and v4 event/error mapping;
- comprehensive lifecycle, yield-injection, cancellation, cache-corruption, supersession, structure-query, and user-data unit tests;
- any v4-only protocol corrections required by those handlers, notably user-data `SOURCE_MISMATCH` and a durable-data corruption code.

The new module must be included in normal typechecking even though Vite does not reach it from the worker entry.

### 6b should not contain

- an import change in `index.worker.ts`;
- a `WorkerClient` migration;
- Sherlock v4 spec construction in the application store;
- changes to current browser assertions merely to anticipate v4;
- deletion or weakening of the v3 engine/tests.

Those are one coupled 6c cutover. Within 6c it is fine for the tree to be temporarily mismatched while editing; the commit itself must build and run end to end.

Keep the new unit suite separate rather than rewriting the v3 suite in place. Reuse inert fixture builders if useful, but preserve the old tests until 6c so both executable contracts remain demonstrably green.

### Small dependencies allowed in 6b

If a helper is genuinely required to implement the v4 engine correctly, a narrow core addition is acceptable in 6b. Two examples are the shared ingest-cap constant and a decode/finalize-extraction helper described below. Do not duplicate either behavior locally merely to keep the diff nominally “engine only.” If review size is the concern, put these in the prerequisite commit instead.

## Q2 — User-data handlers

**Put the handlers and their unit tests in 6b.** Your reasoning is correct: they are engine behavior over an injected seam, not shell wiring.

The constructor should not require a successfully opened durable store. Give the engine a discriminated access/provider seam so 6b can test all outcomes and 6c can start analysis independently of durable-store opening:

```ts
type UserDataAccess =
  | { readonly kind: "ok"; readonly store: UserDataStore }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

type UserDataProvider = () => Promise<UserDataAccess>;

class WorkerEngineV4 {
  constructor(
    artifactStore: ArtifactStore,
    userData: UserDataProvider,
    emit: EmitV4,
    yieldControl: Yield,
  ) {}
}
```

In 6b, inject resolved, deferred, failed, and blocked providers. In 6c, start the user-data open concurrently and pass its bounded promise/provider to the engine; analysis messages must not await it. Only a user-data command waits for user-data availability.

The handlers remain outside `GenerationState`. They may share global job-number ownership and cancellation machinery, but they emit only the user-data acknowledgement/error union—never analysis progress, warnings, results, or generation errors.

Add two v4 user-data error codes before the protocol becomes live:

- `SOURCE_MISMATCH` for `source-persist` bytes that do not hash to the claimed source identity;
- `DATA_CORRUPT` (or the narrower `PROJECT_CORRUPT`) for a durable project record that fails deep validation on load.

Mapping a corrupt stored project to `REQUEST_INVALID` blames the current request; mapping it to `PERSISTENCE_UNAVAILABLE` loses important recovery information. Do not delete a corrupt durable project or source automatically.

### User-data cancellation has a commit point

Sharpen the earlier “user-data jobs are cancellable” rule. Reads and pre-write CPU work are cancellable. Durable writes are only cancellable **before** their transaction starts.

For `source-persist`:

1. cap-check and hash the bytes;
2. verify the claimed hash;
3. checkpoint/gate cancellation;
4. call `putSource`;
5. once the durable promise resolves, emit `source-persisted` even if a cancel arrived while the transaction was committing.

The same rule applies to `project-save`. Suppressing the acknowledgement after a successful commit would leave the main thread at revision N while storage is at N+1, producing a misleading conflict on retry. Once the irreversible side effect succeeds, truthful acknowledgement wins over a late cancellation. A worker death between commit and acknowledgement remains recoverable: source puts are idempotent, and a project retry can load/reconcile the committed revision.

## Q3 — Storage fixes and revision authority

**Choose (a): a small standalone storage-contract commit before 6b.** Do not bury changes to durable-record identity, CAS semantics, IndexedDB migration, close behavior, and open timing inside a thousand-line state-machine diff. Do not wait for 6c, because the 6b handlers and their tests should target the final store contract.

### Manifest is the sole revision authority

Use `ProjectManifestV1.revision` as the only persisted revision. Store the canonical manifest directly as the project record; the object store can continue keying it by `id`. A wrapper containing another `id` and `revision` creates exactly the dual authority §E rejects.

I recommend that the save message carry the *proposed committed manifest*:

- `expectedRevision` is the CAS token for the currently observed record;
- `manifest.revision` must equal `expectedRevision + 1`;
- first creation is `expectedRevision = 0`, `manifest.revision = 1`;
- the engine deeply validates the manifest and this relationship before calling the store;
- the store transaction compares the current stored manifest revision with `expectedRevision` and writes the already validated next manifest unchanged.

That is preferable to stamping a revision into an `unknown` value inside the transaction. It also avoids doing asynchronous recipe/hash validation while an IndexedDB transaction is live—a transaction can become inactive while Web Crypto promises settle.

```ts
interface UserDataStore {
  /** A hit is still untrusted persisted input; the engine deep-validates it. */
  getProject(id: string): Promise<CacheRead<unknown>>;

  /** `next` is a validated canonical manifest at expectedRevision + 1. */
  putProject(
    next: ProjectManifestV1,
    expectedRevision: number,
  ): Promise<{ readonly committed: ProjectManifestV1 }>;

  getSource(hash: string): Promise<CacheRead<StoredSourceV1>>;
  putSource(source: StoredSourceV1): Promise<void>;
  deleteSource(hash: string): Promise<void>;
  close(): void;
}
```

Inside `putProject`, synchronously reject an invalid key/id relationship, a non-safe revision, `next.revision !== expectedRevision + 1`, or revision overflow. The read and put remain in one readwrite transaction. The store may shallow-check the current record's `schema`, `id`, and safe revision for CAS; the engine performs full validation on project load and before save.

The protocol should follow the single-authority choice. `project-loaded` does not need a second `revision` beside the manifest; remove it now or require exact equality. `project-saved.revision` is fine as an acknowledgement of the committed value, not another stored authority.

### This is a durable layout migration

Changing the project value from `{id, revision, manifest}` to `ProjectManifestV1` changes the stable user-data record ABI. Bump `USER_DATA_DB_VERSION` and provide a same-name migration. The feature has not yet been wired to production, but the database was deliberately given migration—not abandonment—semantics.

Do not silently delete an old wrapper. A migration can unwrap only a record whose inner manifest and outer id/revision agree under the migration's synchronous checks; anything else should remain detectable as corrupt/quarantined rather than being invented into a valid project.

### Closed/versionchange/open behavior

The prerequisite commit should prove all of these:

- `getProject` and `getSource` after close reject with `PERSISTENCE_UNAVAILABLE`, not `miss`;
- `put*`/delete continue to reject rather than fake success;
- the live connection closes and invalidates the adapter on `versionchange`/`blocking`;
- a blocked open resolves promptly as `blocked` and any late connection is closed;
- an opener that neither resolves nor fires `blocked` is bounded by an injected timeout, resolves `unavailable`, and closes any late connection;
- two-connection CAS still permits exactly one winner;
- class-1 operations never fall back to an in-memory store while claiming durability.

The 6c shell should start artifact and user-data opening concurrently, but should instantiate analysis as soon as its disposable artifact-store policy permits. The user-data provider may still be pending; this must not add the durable-open timeout to cold T1.

### One 6a validator follow-up belongs with this prerequisite

`validateProjectManifest` now performs excellent structural and override-status validation, but the landed implementation does not yet recompute the claimed index, extraction, structure-recipe, or override hashes. Its current tests deliberately admit placeholders such as `ir`, `er`, `sr`, and `h`.

Before the handlers rely on it as the canonical durable boundary, make it verify:

```ts
await hashIndexRecipe(manifest.indexRecipe) === manifest.indexRecipeHash;
await hashExtractionRecipe(doc.extraction.recipe) === doc.extraction.recipeHash;
await hashStructureRecipe(doc.structure.recipe) === doc.structure.recipeHash;
await hashStructureOverride(savedOverride.value) === savedOverride.hash;
doc.source.format === doc.extraction.recipe.format;
```

Verify override hashes for both `active` and `needs-review`; “not currently applied” does not mean “identity may be false.” Also close the manifest's detected-encoding union to the implemented encodings. This makes the validator satisfy its documented “hashes are assertions” role rather than forcing every user-data handler to duplicate semantic checks.

## Q4 — Module decomposition

**Keep 6b's implementation in one `engine-v4.ts`.** That is the better first-review shape here.

Warm probing, document claims, cache-repair guards, preparation, composition serialization, and emission all depend on the same private ownership rules. Moving `probeWarmDocument` and `prepareFromText` into `warm-resolve.ts` would either expose stateful private methods or pass a large callback/context object whose omissions become new race hazards. Keeping them adjacent makes comparison with the v3 engine and audit of every await/gate much easier.

Likewise, keep `handleUserData` in the engine for 6b so job ownership, cancellation, and the write commit point are visible in the same dispatch. It can be a clearly separated section without being a separate module.

Use internal sections and small private methods rather than one enormous method:

1. dispatch/job ownership;
2. generation plan resolution and document claims;
3. warm probe/admission;
4. text preparation/build;
5. serialized composition/publication;
6. queries/resolver caches;
7. user-data lane;
8. error mapping/emission.

Split test fixtures/builders into a helper file if that reduces noise. After 6c is stable, extract only helpers that are demonstrably stateless. A future `user-data-service.ts` is reasonable if it returns typed outcomes and never owns jobs, emits messages, or touches generation state; it is not needed to make 6b reviewable.

## Q5 — Implementation sharpenings

### 1. Make document claims the authority before any ready value exists

Use generation-object identity plus a monotonic per-document epoch:

```ts
interface DocWorkToken {
  readonly generation: GenerationStateV4; // object identity, not its string
  readonly doc: string;
  readonly epoch: number;
}

private owns(token: DocWorkToken): boolean {
  return this.generation === token.generation &&
    token.generation.work.get(token.doc)?.epoch === token.epoch;
}
```

Warm resolution claims each doc. An ingest for that doc increments its epoch and supersedes the warm owner. Two ingests may be idempotent only after the first accepted source/text/candidate identity is frozen; different bytes under the same generation are rejected rather than changing document meaning in place.

Use a combined gate after every await:

```ts
private docGate(job: number, token: DocWorkToken): void {
  this.gate(job, token.generation);
  if (!this.owns(token)) throw new SupersededError();
}
```

Gate before warnings, disposable repair deletes, state writes, and emissions—not merely before `commitDocuments`.

### 2. `commitDocuments` must recompose if ownership changes during composition

The composition mutex serializes publications but does not prevent an ingest from incrementing a document epoch while `composeSnapshot` awaits hashing. Use this shape:

1. enter the composition chain;
2. filter candidates to currently owned tokens;
3. stage from the current committed ready/text maps without mutating them;
4. compose/bind locally;
5. synchronously recheck job, generation, **every candidate token**, and the staged ready-base publication version;
6. if a candidate was superseded, discard the staged snapshot and recompose with the still-owned candidates (or explicitly reschedule them); never commit a snapshot composed around the stale item;
7. mutate ready/text/bindings/snapshot and emit in one synchronous section.

A plain “abort the whole batch” is safe but can lose publication of the other exact hits unless they are requeued. A short recompose loop over the remaining owned candidates preserves safety and liveness.

Track a generation-local `publicationEpoch` incremented only on successful commit. Capturing and rechecking it makes the staged-base assumption explicit even though the mutex should serialize writers.

### 3. Keep accepted identity separate from work ownership

`DocWorkSlot.acceptedIdentity` should survive an epoch increment. The epoch says which asynchronous task may act; accepted identity says what this generation's document means. Set/freeze it after a cold extraction's source/text/candidate assertions pass and before long index/structure work. A later same-generation attempt must match it.

`generation-ready.missing` must exclude a document whose bytes have been accepted and are owned in flight, not only documents already in `ready`. If that build later fails, its correlated error drives retry; the begin job must not start a duplicate fetch meanwhile.

### 4. Structure query binding

The query is bound to the **current snapshot object**, not only to the generation:

1. capture `gen` and `snapshot` and run the normal query checkpoint;
2. require the requested doc to appear in the snapshot's refs;
3. get the matching `ReadyDocument` and require `ready.index === ref.index` and `ready.structure === ref.structure`;
4. require a V2 structure artifact;
5. obtain raw token ranges from a cache keyed by `[ref.structure, ref.index]` using `projectSections`;
6. build one lineage-key → `SectionId` map with `bindSectionId(doc, key)`, then translate parent keys through that map;
7. after all asynchronous ID binding, run `queryGate(job, gen, snapshot.id)` immediately before emitting;
8. echo exactly `ref.structure` and `ref.index` in the result.

Cache only doc-independent token projections by the artifact pair. Section IDs are doc-bound; either bind them per request or key a second cache by `(doc, structure, index)`.

### 5. Export and use the §12.9 caps

`INGEST_CAPS_V0` still exists only in the design document. Export one shared core constant now. The v4 engine must enforce document count and declared aggregate source/text caps at begin-generation, the actual received source size before processing, and decoded UTF-16 limits after decode. 6c reuses the same constant for main-thread preflight. Violations are `CAP_EXCEEDED`, never generic parse/internal errors.

### 6. Preserve honest decode/extract phases without duplicating artifact assembly

6a exports `decodeSource` and `deriveCandidatesFromText`, but `extractDocument` still performs the complete operation. Do not hand-assemble `ExtractionArtifactV1` independently in the engine and create a second canonical builder.

Add a small core phase seam—e.g. `decodeDocumentSource(bytes, recipe)` plus `finalizeExtraction(decoded, recipe)`—and have both `extractDocument` and the engine use it. Then the worker can emit `decode` immediately before byte decoding and `extract` immediately before candidate derivation/artifact finalization. Warm text rescans emit only `extract`.

### 7. Cache and evidence rules remain asymmetric by design

- A candidate bundle regenerated from verified text can rebuild structure but cannot recreate source decoding evidence.
- Do not persist a fabricated extraction artifact or emit a fabricated `source-ready` from that bundle.
- A valid artifact that conflicts with a project expectation is a terminal mismatch, not cache corruption; do not delete it or report the doc as an ordinary byte miss.
- Disposable extraction/shard/structure writes occur only after the full prepared document commits; a durable source is never repair-deleted.

### 8. Minimum 6b test gates

In addition to the design-of-record matrix, make these explicit acceptance tests for the split commit:

- `engine.ts` and its v3 tests remain unchanged and green;
- `engine-v4.ts` is not imported by `index.worker.ts`;
- a stale doc token cannot warn, repair-delete, publish, or alter `missing`;
- supersession during awaited snapshot composition forces recompose/no stale publication;
- an override-only generation publishes one complete snapshot with no index work;
- structure results are suppressed after snapshot supersession and echo the bound artifact hashes;
- project load validates the durable manifest deeply, including hashes;
- project save enforces `manifest.revision === expectedRevision + 1` and maps CAS conflict precisely;
- source persist verifies bytes and acknowledges only durable success;
- cancellation before a user-data write prevents it, while cancellation during an already committed write does not suppress the acknowledgement;
- unavailable/blocked user data does not affect analysis queries or progress.

## Final sequencing

1. **Storage prerequisite:** single-authority project record/CAS, schema migration, close/versionchange/timeout behavior, semantic manifest-hash verification, and focused tests. Add the v4 user-data error codes here or in 6b.
2. **6b:** cohesive unused `WorkerEngineV4` plus its full unit/race suite and any narrow shared core phase/cap helpers.
3. **6c:** one green production wire cutover—shell/provider opening, client, Sherlock v4 specs, UI-store compatibility, browser fixtures—then remove v3.

That keeps each commit independently meaningful: the durable substrate is correct, the new state machine is reviewable in isolation, and the deployed protocol changes atomically.

---

# Commit 6c wire-cutover ruling — atomic v3→v4 production migration

*Codex planner consult `claude_6c_consult`, 2026-07-20. Governs the 6c
atomic cutover and its acceptance checklist. Recorded verbatim below.*

# Commit 6c wire-cutover ruling

## Executive decision

Proceed with 6c as one atomic production cutover.

- Wire the memoized, concurrently opened `UserDataProvider` into the shell now, but defer public `WorkerClient` user-data methods to commit 7.
- Give Sherlock separate `sourceHash` and `textHash` fields even though all six current values are equal. Use each in its proper v4 slot.
- Treat the client migration as “same restart/epoch model, new wire semantics,” not as a blind rename: handle the enlarged event union, preserve missing reasons, and fix successful ingest-job cleanup at snapshot publication.
- `trace.ts` needs no schema change. Browser assertions and the IDB durability barrier do need v4 semantic changes.
- Delete v3 only after translating the still-uncovered behavioral assertions into v4. The 6b suite covers the new pipeline well, but it does not yet replace all legacy query, protocol, locale, corruption, and injected-yield coverage.

## Q1 — User-data client methods and shell provider

**Defer the public client methods to commit 7. Wire the provider in the shell in 6c.** That keeps 6c focused on the analysis path without leaving the production v4 engine constructed against a fake or unavailable-only user-data seam.

The shell should start both opens concurrently but await only the disposable artifact store before constructing the engine:

```ts
const userDataOpen = openUserDataStore(); // starts now; bounded internally
const userDataProvider: UserDataProvider = () => userDataOpen;

void openArtifactStore(onArtifactWarning).then(
  (artifacts) => start(new WorkerEngineV4(
    artifacts,
    userDataProvider,
    emit,
    taskQueueYield,
  )),
  () => start(new WorkerEngineV4(
    new InMemoryArtifactStore(),
    userDataProvider,
    emit,
    taskQueueYield,
  )),
);
```

Do not `await Promise.all([artifactOpen, userDataOpen])`: that would add the durable-open timeout to analysis startup. Do not substitute `InMemoryUserDataStore` for a blocked/unavailable durable store; class-1 storage must report its real state.

Use `MessageEvent<unknown>` and an `unknown[]` pre-engine buffer. `WorkerEngineV4.handle` owns total v4 parsing; the shell should not cast unvalidated browser messages to `ToWorkerV4` merely to populate the queue.

Opening the durable database at boot is acceptable and cheap relative to the worker lifecycle, especially because it runs concurrently. It validates migration/open/versionchange behavior early and gives commit 7 a ready seam. Describe the proof accurately, though: boot exercises the open and constructor wiring, not a user-data handler round trip. Full load/save/persist browser proof remains commit 7/phase step 9.

If client methods are deferred, make `WorkerClient.receive` explicitly consume the currently unreachable user-data acknowledgements/errors so the expanded `FromWorkerV4` switch is intentional rather than accidentally incomplete:

```ts
case "project-loaded":
case "project-missing":
case "project-saved":
case "source-persisted":
case "user-data-error":
  // No public producer until commit 7; trace already captured metadata.
  return;
```

Do not add hidden or e2e-only user-data methods just to exercise the seam. Commit 7 should add the real typed pending variants, transfer behavior for `source-persist`, and UI-visible error semantics together.

## Q2 — Sherlock v4 specs

### Keep SourceHash and TextHash structurally separate

The hashes genuinely coincide for these exact UTF-8 assets, so using the same hex value in both v4 fields is correct. **Do not use one property named `textHash` as both authorities.** The §F warning means the manifest should encode two meanings even when their present values compare equal:

```ts
interface BundledCorpusEntry {
  readonly doc: string;
  readonly bytes: number;
  readonly sourceHash: string; // SHA-256 of exact bytes
  readonly textHash: string;   // hashText(decoded text)
}
```

For the six current rows, duplicate the literal value deliberately. The fixture should independently assert:

```ts
expect(await hashSourceBytes(bytes)).toBe(entry.sourceHash);
expect(await hashText(decoded)).toBe(entry.textHash);
expect(entry.sourceHash).toBe(entry.textHash); // fixture-specific fact
```

That last equality is evidence about this corpus, not a data-model alias. A future BOM, Windows-1252 file, or extraction transform can make the values diverge without changing the manifest shape or accidentally routing a TextHash into an extraction cache key.

### Proposed v4 document shape

The proposed shape is otherwise correct:

```ts
{
  doc,
  language: "en",
  source: {
    expectedHash: sourceHash,
    byteLength: bytes,
    format: "txt",
    availability: "bundled",
  },
  extraction: {
    recipe: txtRecipe,
    recipeHash: txtRecipeHash,
    expectedText: textHash,
    expectedCandidates: emptyCandidateHash,
  },
  structure: {
    recipe: DEFAULT_STRUCTURE_RECIPE,
    recipeHash: structureRecipeHash,
    override: { kind: "none" },
  },
}
```

`availability: "bundled"` is the correct provenance. It means the worker may use disposable warm artifacts but has no class-1 persisted source to recover from; if the needed text/source dependency is absent, the barrier requests source bytes and the Sherlock loader fetches the authoritative bundled URL.

Omitting `expectedTextLengthUtf16` is valid. The landed engine uses `source.byteLength` as a sound preflight upper bound for every supported decoder and then enforces the actual decoded UTF-16 limit. Do not add a second static length field merely for 6c.

Compute the TXT extraction recipe/hash, structure recipe hash, and empty-candidate hash once behind a module-level memoized promise. `loadSherlock` becomes async before `openGeneration`, so recheck its attempt token immediately after awaiting spec construction. Reuse the resolved immutable specs for restart reopen; do not recompute hashes per restart or per document.

The store should only fetch entries named by the current authoritative manifest and whose miss has `need === "source-bytes"`. Preserve the `reason` in the typed result even if every current bundled reason leads to the same URL fetch; commit 7 needs those distinctions for external/persisted files.

## Q3 — Client migration

The worker-death budget, worker-instance epoch fence, transactional dead-client revival, pending rejection on death, and restart listener model do not change. The app still owns replay: after a nonfatal replacement, it opens a new generation with the same immutable v4 specs and follows the new barrier.

It is not quite a pure type swap. Make these deliberate changes:

1. Replace every v3 protocol import and constant with the v4 names. `openGeneration` posts `indexRecipe`, not `recipe`.
2. Keep `GenerationReady.missing` as `readonly MissingWarmDocV4[]`; do not flatten it to document names in the client.
3. Change pending query resolution to `QueryResultDataV4`. The unused structure member is harmless and prepares commit 8's consumer.
4. Explicitly handle all new `FromWorkerV4` discriminants, even if the user-data cases are no-ops until commit 7.
5. Keep `source-ready` ignored for Sherlock UI state. The bundled manifest is authoritative, and this commit has no user-project manifest to update. Do **not** treat `source-ready` as ingest completion: segment/index/structure can still fail afterward.
6. Preserve `EXTRACTION_MISMATCH` as a correlated terminal open/ingest error. It must never be transformed into a missing-doc retry.

### Clean up successful ingest jobs at publication

The current `ingestJobs` map is only cleared on failure/restart. A successful ingest has no job-bearing completion event, and v4 `source-ready` is explicitly too early to serve as one. Change the map to retain the document:

```ts
private readonly ingestJobs = new Map<
  number,
  { readonly generation: string; readonly doc: string }
>();
```

On `snapshot-published`, after the message passes the worker-epoch fence, clear ingest jobs whose generation matches and whose doc is present in `readyDocs`. Errors before publication still find their job; successful jobs no longer accumulate forever. Clearing all same-generation attempts for a now-ready doc is correct—the publication is the document-level success boundary, and older attempts are superseded.

Keep the existing epoch/snapshot checks in the Zustand store exactly as they are. A v4 snapshot can still publish progressively, so the query-cancel/reissue discipline remains necessary.

## Q4 — Trace and real-browser semantics

### Trace

Agree: `trace.ts` requires no type change. Its metadata fields are intentionally open strings, so `extract`, `structure`, richer source events, and future user-data discriminants remain sanitized and bounded. Updating the comment from v3-era wording is optional.

The client receive switch must still trace a message before handling/ignoring it. Do not add manifest contents, source bytes, passage text, or user-source names to the trace when commit 7 adds traffic.

### E2E harness synthetic specs

Build a real v4 spec for the synthetic ASCII document with independently computed source/text/candidate/recipe hashes. Use `availability: "external"` for the harness document: the harness itself holds and supplies the bytes, and there is no bundled URL or opted-in persisted source.

The generation-race terminal predicate remains meaningful. Keep checking stale `snapshot-published`, `source-ready`, and `result` from A after B is posted. Do not broaden it to all progress messages based solely on main-thread post order: an A progress event produced before the worker processes B may legally be delivered after the main thread posts B. The engine unit suite is the authority for “after generation replacement is processed, no stale side effect.”

### Browser assertions that must change

1. **Cold boot phase order:** for each Sherlock doc expect
   `decode → extract → segment → index → structure → compose`. `source-ready` occurs after successful extraction and before publication; assert one per cold-ingested doc.
2. **Warm reload and worker restart:** assert no `decode`, `extract`, `segment`, `index`, or `structure`. `compose` may remain treated as an implementation-detail allowance, although exact v4 hits currently emit no build progress.
3. **Durability barrier:** wait for all four artifact classes—six texts, six shards, six extractions, and six structures. Validate the extraction/structure envelope keys and at least the v4 schema tags, candidate identity, typed shard arrays, and structure section-array presence. Waiting only for text+shard lets a reload race best-effort extraction/structure writes and produces false “warm” results or flaky structure reconstruction.
4. **Shard corruption repair:** retain the current expected behavior. Five exact documents publish first, the victim alone segments/indexes, no corpus fetch occurs, the repaired shard is persisted, and the third reload has no build phases. Because candidates and structure remain valid, the victim should not re-extract or recompose structure.
5. **Cold barrier semantics:** the single initial `generation-ready` still precedes fetch/ingest and lists six `{need:"source-bytes"}` misses. Update comments and store/unit fixtures from v3's `text-miss` reason to the v4 reason shape.
6. **Bench timings:** keep the existing semantic gates and thresholds unless real runs disprove them, but update phase comments and ensure the cold measurement includes the new extraction/structure pipeline.

Do not expand 6c into the full future extraction/structure corruption browser matrix. The phase plan already places those real-browser proofs later. The 6c durability barrier must at least prove those records exist and structured-clone correctly.

## Q5 — Test migration and v3 removal

Deleting `protocol.ts`, `engine.ts`, and `engine.test.ts` is correct **only after behavioral coverage parity**, not merely because `engine-v4.test.ts` has 37 tests. The 6b tests thoroughly cover the new dependency graph, caps, token ownership, structure binding, and user-data lane, but inspection shows important v3 assertions that do not yet have v4 equivalents.

Translate the following invariant groups before deleting the old suite:

### Must translate

- protocol version mismatch, unknown op, and malformed/nested payload narrowing;
- cancellation during snapshot composition and generation replacement during composition—the final commit gate, not only a pre-publication cold-ingest cancel;
- fixed-locale versus document-metadata/fallback behavior and non-aliasing warm keys across locales;
- store-reported corrupt envelopes, deep structural/geometry corruption, exact-key repair, and “next reopen is clean” behavior;
- trend and KWIC integration against the published snapshot;
- passage marks and validation, including duplicate tracks/empty phrases;
- excerpt success and range validation;
- `SNAPSHOT_UNKNOWN`, invalid-selection mapping, generation replacement during a query, and cancellation at the final kernel checkpoint;
- explicit trend-result transfer lists proving resident shard buffers are never transferred;
- resolver-cache replacement after re-ingest;
- late-cancel state cleanup so cancellation bookkeeping does not accrete.

The tests can be consolidated around v4 fixtures; they need not remain one-for-one files. Preserve the injected-yield points and assertions, not the v3 message spelling.

One legacy assertion must change semantically: “invalid UTF-8 without a BOM is `DECODE_FAILED`” is no longer correct because v4 deliberately falls back to Windows-1252. Replace it with malformed or unsupported **authoritatively BOM-declared** Unicode producing `DECODE_FAILED`, plus the existing evidence test for successful fallback.

### Already covered well by 6b

Do not duplicate the v3 versions of exact warm reopen, text/shard/structure dependency paths, candidate reconstruction, override identity, persisted-source recovery, accepted-identity freezing, stale warm claims, missing-barrier reconciliation, structure-query snapshot binding, caps, and user-data semantics. The v4 tests are the new authority for those.

### Client/store tests

Preserve every existing client restart/epoch assertion and every Zustand intent/snapshot race assertion. Their invariants are protocol-independent and remain required after the type migration. Add targeted assertions for:

- the exact v4 `begin-generation` shape and `indexRecipe` field;
- structured `MissingWarmDocV4` propagation;
- no fetch on an empty missing list and fetch only for named source-byte misses;
- separate Sherlock `sourceHash`/`textHash` placement;
- successful ingest-job cleanup on snapshot publication;
- intentional no-op handling of unreachable user-data events in 6c.

Also update cutover files omitted from the question's deletion list: `idb-store.ts` currently imports the v3 `StorageWarningCode`, and `idb-store.test.ts` imports that type too. Run a final repository-wide search for `protocol.ts`, `PROTOCOL_VERSION`, `GenerationDocSpec`, `MissingWarmDoc`, `QueryResultData`, and `WorkerEngine` before removing v3; zero v3 imports should remain.

## Atomic 6c acceptance checklist

- Production shell constructs only `WorkerEngineV4`, buffers `unknown`, and passes the memoized concurrent user-data provider.
- Client and app store import only v4 wire types/constants.
- Sherlock manifests distinguish SourceHash from TextHash and build immutable v4 specs once.
- Cold, warm, restart, corruption, transfer, generation-race, cancel, and no-long-task browser suites pass under the deployed base path.
- Cache settling proves all four v4 artifact stores, not only the old two.
- Every surviving legacy engine invariant has a v4 test or an explicitly documented intentional semantic replacement.
- `protocol.ts`, `engine.ts`, and the old test are deleted only after a repository-wide v3 reference search is empty.
- Typecheck, all unit tests, production build, Chromium Playwright, and benchmark semantic gates are green in the same commit.

With those conditions, 6c is the desired atomic moment: before it, production is consistently v3; after it, every production sender, receiver, restart path, fixture, and proof is consistently v4.
