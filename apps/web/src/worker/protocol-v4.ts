/**
 * Worker wire protocol v4 — contract §12.8 (ingest & structure). This is the
 * LIVE protocol: the engine, client, and worker shell all speak it (6c wire
 * cutover), and the v3 protocol.ts has been removed. It was introduced ahead of
 * the engine (commit 5) so its types and total runtime validators could be
 * proven before anything consumed them.
 *
 * What v4 added over the retired v3 (all breaking, hence the version bump):
 * - per-document source/extraction/structure inputs carrying FULL recipe and
 *   override VALUES plus their claimed hashes (a cold restart reconstructs
 *   everything; the worker recomputes every hash — hashes are admission
 *   checks and lookup accelerators, never authority);
 * - `source-ready` returns the complete SourceDescriptor plus extraction
 *   evidence, and progress gains `extract` and `structure` phases;
 * - warm misses carry a REQUESTED DEPENDENCY and reason (a user file cannot
 *   be re-fetched from a URL — the worker re-extracts persisted sources,
 *   re-indexes verified text, and recomputes structure before ever asking
 *   for bytes);
 * - a snapshot-bound `structure` query op;
 * - a SEPARATE user-data storage operation map (project load/save, source
 *   persist) with its own error semantics — never disguised as analysis
 *   progress.
 */

import type {
  ExtractionRecipeProvisional,
  IndexRecipeProvisional,
  KwicRequest,
  KwicRow,
  NumericTrend,
  PassageRequest,
  PassageResult,
  SourceFormat,
  StructureOverrideV1,
  StructureRecipeProvisional,
  TermGroupSpec,
  TokenRange,
  TrendRequest,
} from '@texttrends/core';

export const PROTOCOL_VERSION_V4 = 4;

/** The source format vocabulary is core's — the wire re-exports it rather than
 *  redeclaring a set that could silently drift from the extractor's authority. */
export type { SourceFormat };

export type BuildPhaseV4 = 'decode' | 'extract' | 'segment' | 'index' | 'structure' | 'compose';

export type SourceAvailability = 'bundled' | 'persisted' | 'external';

/** Source provenance surfaced by `source-ready` (§12.4), discriminated by how
 *  the bytes became text — mirrors core's `SourceDescriptorV1`. A `text` source
 *  reports its one decoded encoding; a `container` (epub) reports its internal
 *  decoding policy and spine document count instead of a single encoding. */
export type SourceDescriptorV4 =
  | {
      readonly kind: 'text';
      readonly hash: string; // SourceHash
      readonly byteLength: number;
      readonly format: 'txt' | 'md';
      readonly encoding: { readonly detected: string; readonly hadReplacementChars: boolean };
    }
  | {
      readonly kind: 'container';
      readonly hash: string; // SourceHash
      readonly byteLength: number;
      readonly format: 'epub';
      readonly container: { readonly internalDecoding: 'utf-8-strict'; readonly documentCount: number };
    };

/**
 * Per-document generation input (§12.8 GenerationDocSpecV4). Recipe/override
 * VALUES travel so a cold worker can reconstruct the pipeline; the worker
 * recomputes each claimed hash.
 */
export interface GenerationDocSpecV4 {
  readonly doc: string;
  readonly language: string;
  readonly source: {
    readonly expectedHash?: string;
    readonly byteLength: number;
    readonly format: SourceFormat;
    readonly declaredEncoding?: string;
    readonly availability: SourceAvailability;
  };
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: string;
    readonly expectedText?: string;
    readonly expectedTextLengthUtf16?: number;
    readonly expectedCandidates?: string;
  };
  readonly structure: {
    readonly recipe: StructureRecipeProvisional;
    readonly recipeHash: string;
    /**
     * An override is NOT always knowable (engine-v4 consult): a first cold
     * ingest has no TextHash/CandidateHash yet, and a canonical
     * StructureOverrideV1's base identity includes those — so a full override
     * cannot be constructed before extraction. `none` means "derive the
     * canonical empty override after the identities are known"; `active`
     * carries a user correction whose hash and base identities the worker
     * verifies. A project override marked needs-review after a source change
     * is sent as `none` until the user rebases it — never as a stale `active`.
     */
    readonly override: OverrideInputV4;
  };
}

export type OverrideInputV4 =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly value: StructureOverrideV1; readonly hash: string };

/** Why a document still needs its bytes and what dependency is missing. */
export type WarmMissReasonV4 =
  | 'source-not-persisted'
  | 'source-miss'
  | 'source-corrupt'
  | 'extraction-miss'
  | 'rehydrate-failed';

export interface MissingWarmDocV4 {
  readonly doc: string;
  readonly need: 'source-bytes';
  readonly reason: WarmMissReasonV4;
}

/** One concordance track: a series identity + the term group that matched. */
export interface KwicTrack {
  readonly seriesId: string;
  readonly group: TermGroupSpec;
}

export type QueryOpV4 =
  | { readonly op: 'trend'; readonly selection: WireSelectionV4; readonly group: TermGroupSpec; readonly request: TrendRequest }
  // kwic/2: a merged multi-term concordance (1..MAX_KWIC_TRACKS tracks) that can
  // order by proximity to an axis position (`request.center`).
  | { readonly op: 'kwic'; readonly selection: WireSelectionV4; readonly tracks: readonly KwicTrack[]; readonly request: KwicRequest }
  | { readonly op: 'passage'; readonly request: PassageRequest }
  | { readonly op: 'structure'; readonly request: { readonly doc: string } }
  // Authoring context (§12.3, ruling §2): the DETECTED baseline + base identities
  // a correction UI needs to author a complete override. Separate from the cheap
  // `structure` read because it re-derives candidates from resident text.
  | { readonly op: 'structure-edit-context'; readonly request: { readonly doc: string } }
  // The bounded source line around a char anchor (§4) — evidence for a correction.
  | { readonly op: 'line-excerpt'; readonly request: { readonly doc: string; readonly anchor: number; readonly maxChars: number } };

export interface WireSelectionV4 {
  readonly docs: readonly string[];
  readonly ranges?: readonly { readonly doc: string; readonly tokens: { readonly start: number; readonly end: number } }[];
}

/** The project-bound section view (§12.2 Section): the persisted record's
 *  lineage key becomes a project-scoped SectionId at bind time. */
export interface WireSection {
  readonly id: string;          // derived from doc + stable key
  readonly doc: string;
  readonly origin: 'source' | 'heuristic' | 'user' | 'fixed';
  readonly parent?: string;     // sibling SectionId
  readonly level: number;
  readonly title?: string;
  readonly chars: { readonly start: number; readonly end: number };
}

/** The structure query result echoes BOTH input identities so a consumer can
 *  never pair ranges with the wrong snapshot artifacts (§12.7). */
export interface StructureQueryResultV1 {
  readonly doc: string;
  readonly structure: string;       // StructureHash
  readonly index: string;           // IndexArtifactHash
  readonly rows: readonly { readonly section: WireSection; readonly tokens: TokenRange }[];
}

/** A DETECTED-baseline row (ruling §2): char-anchored, keyed by its lineage
 *  key (the authoring handle), parent expressed as a parent KEY. Distinct from
 *  the project-bound `WireSection` — raw keys never appear on that abstraction. */
export interface EditSectionRow {
  readonly key: string;
  readonly origin: 'source' | 'heuristic' | 'user' | 'fixed';
  readonly parent?: string;         // parent lineage key
  readonly level: number;
  readonly title?: string;
  readonly chars: { readonly start: number; readonly end: number };
}

/** The authoring context (ruling §2). Echoes the two artifact identities plus
 *  the base identities and effective override hash the override is authored
 *  against; carries the DETECTED baseline (to diff against) and the CURRENT
 *  composed rows (bound section + lineage key + token range, to render). */
export interface StructureEditContextV1 {
  readonly doc: string;
  readonly structure: string;       // effective StructureHash
  readonly index: string;           // IndexArtifactHash
  readonly base: { readonly text: string; readonly candidates: string; readonly baseRecipe: string };
  readonly override: string;        // effective StructureOverrideHash
  readonly detected: readonly EditSectionRow[];
  readonly current: readonly { readonly key: string; readonly section: WireSection; readonly tokens: TokenRange }[];
}

/** A bounded source-line window around a char anchor (§4). */
export interface LineExcerptResultV1 {
  readonly doc: string;
  readonly chars: { readonly start: number; readonly end: number };
  readonly text: string;
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
}

export type QueryResultDataV4 =
  | { readonly op: 'trend'; readonly trend: NumericTrend }
  | { readonly op: 'kwic'; readonly total: number; readonly rows: readonly KwicRow[] }
  | { readonly op: 'passage'; readonly passage: PassageResult }
  | { readonly op: 'structure'; readonly structure: StructureQueryResultV1 }
  | { readonly op: 'structure-edit-context'; readonly context: StructureEditContextV1 }
  | { readonly op: 'line-excerpt'; readonly excerpt: LineExcerptResultV1 };

export type StorageWarningCodeV4 = 'CACHE_UNAVAILABLE' | 'CACHE_READ_FAILED' | 'CACHE_WRITE_FAILED' | 'CACHE_CORRUPT';

export type WorkerErrorCodeV4 =
  | 'UNKNOWN_OP'
  | 'PROTOCOL_VERSION'
  | 'SNAPSHOT_UNKNOWN'
  | 'GENERATION_STALE'
  | 'SELECTION_INVALID'
  | 'CAP_EXCEEDED'
  | 'DECODE_FAILED'
  | 'SOURCE_MISMATCH'
  // Deterministically reconstructed candidates contradict an asserted
  // `expectedCandidates` (a stale manifest / changed source / nondeterminism):
  // a TERMINAL identity failure, NOT a byte miss — refetching the same bytes
  // cannot repair it, so the client must not loop "missing → ingest → mismatch"
  // (engine-v4 consult §B).
  | 'EXTRACTION_MISMATCH'
  | 'PARSE_FAILED'
  | 'DEPENDENCY_MISSING'
  | 'REQUEST_INVALID'
  | 'INTERNAL';

/** User-data (class 1) operations — a SEPARATE map with its own error
 *  semantics; never routed through analysis progress or query results. */
export type UserDataOpV4 =
  | { readonly t: 'project-load'; readonly job: number; readonly project: string }
  | { readonly t: 'project-save'; readonly job: number; readonly project: string;
      readonly manifest: unknown; readonly expectedRevision: number }
  | { readonly t: 'source-persist'; readonly job: number; readonly sourceHash: string; readonly bytes: ArrayBuffer };

export type UserDataErrorCodeV4 =
  | 'PERSISTENCE_UNAVAILABLE'
  | 'REVISION_CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'REQUEST_INVALID'
  // A source-persist whose bytes do not hash to the claimed SourceHash — an
  // identity fault on a user-data command, never routed through the analysis
  // error channel (engine-v4 consult §Q2).
  | 'SOURCE_MISMATCH'
  // A durable project record that fails deep validation on load: distinct from
  // PERSISTENCE_UNAVAILABLE (storage works; the datum is bad) and from
  // REQUEST_INVALID (the request is fine; the stored value is not). The record
  // is reported, never auto-deleted.
  | 'DATA_CORRUPT';

interface VersionedV4 {
  readonly v: typeof PROTOCOL_VERSION_V4;
}

export type ToWorkerV4 = VersionedV4 &
  (
    | { readonly t: 'begin-generation'; readonly job: number; readonly generation: string;
        readonly docs: readonly GenerationDocSpecV4[]; readonly indexRecipe: IndexRecipeProvisional }
    | { readonly t: 'ingest'; readonly job: number; readonly generation: string; readonly doc: string; readonly bytes: ArrayBuffer }
    | { readonly t: 'query'; readonly job: number; readonly snapshot: string; readonly query: QueryOpV4 }
    | { readonly t: 'excerpt'; readonly job: number; readonly snapshot: string; readonly doc: string;
        readonly charStart: number; readonly charEnd: number }
    | { readonly t: 'cancel'; readonly job: number }
    | UserDataOpV4
  );

export type FromWorkerV4 = VersionedV4 &
  (
    | { readonly t: 'progress'; readonly job: number; readonly generation: string; readonly phase: BuildPhaseV4; readonly doc: string }
    | { readonly t: 'source-ready'; readonly job: number; readonly generation: string; readonly doc: string;
        readonly source: SourceDescriptorV4; readonly extractionRecipe: string; readonly text: string;
        readonly textLengthUtf16: number; readonly candidates: string;
        readonly decoderReplacementCount: number; readonly suspiciousControlCount: number }
    | { readonly t: 'snapshot-published'; readonly generation: string; readonly snapshot: string;
        readonly readyDocs: readonly string[]; readonly missingDocs: readonly string[] }
    | { readonly t: 'generation-ready'; readonly job: number; readonly generation: string;
        readonly snapshot: string | null; readonly readyDocs: readonly string[]; readonly missing: readonly MissingWarmDocV4[] }
    | { readonly t: 'result'; readonly job: number; readonly snapshot: string; readonly data: QueryResultDataV4 }
    | { readonly t: 'excerpt-result'; readonly job: number; readonly snapshot: string; readonly doc: string;
        readonly charStart: number; readonly charEnd: number; readonly text: string }
    | { readonly t: 'warning'; readonly generation?: string; readonly code: StorageWarningCodeV4; readonly message: string }
    | { readonly t: 'error'; readonly job?: number; readonly generation?: string;
        readonly code: WorkerErrorCodeV4; readonly message: string; readonly recoverable: boolean }
    | { readonly t: 'cancelled'; readonly job: number }
    // User-data acknowledgements — distinct from analysis results. The loaded
    // manifest carries its own revision (single authority) — no second copy.
    | { readonly t: 'project-loaded'; readonly job: number; readonly project: string;
        readonly manifest: unknown }
    | { readonly t: 'project-missing'; readonly job: number; readonly project: string }
    | { readonly t: 'project-saved'; readonly job: number; readonly project: string; readonly revision: number }
    | { readonly t: 'source-persisted'; readonly job: number; readonly sourceHash: string }
    | { readonly t: 'user-data-error'; readonly job: number; readonly code: UserDataErrorCodeV4;
        readonly message: string; readonly currentRevision?: number }
  );
