/**
 * Worker wire protocol v4 — contract §12.8 (ingest & structure). Introduced
 * AHEAD of the engine migration (ingest/structure plan commit 5); the engine,
 * client, and worker shell switch from v3 to these shapes in commit 6, at
 * which point protocol.ts (v3) is removed. Until then these types and their
 * runtime validators are exercised only by their own unit tests.
 *
 * What v4 adds over v3 (all breaking, hence the version bump):
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
  StructureOverrideV1,
  StructureRecipeProvisional,
  TermGroupSpec,
  TokenRange,
  TrendRequest,
} from '@texttrends/core';

export const PROTOCOL_VERSION_V4 = 4;

export type SourceFormat = 'txt' | 'md';

export type BuildPhaseV4 = 'decode' | 'extract' | 'segment' | 'index' | 'structure' | 'compose';

export type SourceAvailability = 'bundled' | 'persisted' | 'external';

/** Detected encoding + honest decoder evidence (§12.4). */
export interface SourceDescriptorV4 {
  readonly hash: string; // SourceHash
  readonly byteLength: number;
  readonly format: SourceFormat;
  readonly encoding: { readonly detected: string; readonly hadReplacementChars: boolean };
}

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

export type QueryOpV4 =
  | { readonly op: 'trend'; readonly selection: WireSelectionV4; readonly group: TermGroupSpec; readonly request: TrendRequest }
  | { readonly op: 'kwic'; readonly selection: WireSelectionV4; readonly group: TermGroupSpec; readonly request: KwicRequest }
  | { readonly op: 'passage'; readonly request: PassageRequest }
  | { readonly op: 'structure'; readonly request: { readonly doc: string } };

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

export type QueryResultDataV4 =
  | { readonly op: 'trend'; readonly trend: NumericTrend }
  | { readonly op: 'kwic'; readonly total: number; readonly rows: readonly KwicRow[] }
  | { readonly op: 'passage'; readonly passage: PassageResult }
  | { readonly op: 'structure'; readonly structure: StructureQueryResultV1 };

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
