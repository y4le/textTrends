/**
 * Worker wire protocol v4. This is the
 * LIVE protocol: the engine, client, and worker shell all speak it (6c wire
 * cutover), and the v3 protocol.ts has been removed. It was introduced ahead of
 * the engine (commit 5) so its types and total runtime validators could be
 * proven before anything consumed them.
 *
 * What v4 added over the retired v3 (all breaking, hence the version bump):
 * - per-document source/extraction inputs carrying full recipes plus their
 *   claimed hashes (the worker recomputes every hash — hashes are admission
 *   checks and lookup accelerators, never authority);
 * - `source-ready` returns the complete SourceDescriptor plus extraction
 *   evidence;
 * - warm misses carry a REQUESTED DEPENDENCY and reason (a user file cannot
 *   be re-fetched from a URL — the worker re-extracts persisted sources,
 *   and re-indexes verified text before ever asking
 *   for bytes);
 * - a SEPARATE user-data storage operation map (project load/save, source
 *   persist) with its own error semantics — never disguised as analysis
 *   progress.
 */

import type {
  IndexRecipeProvisional,
  ProjectManifestV2,
  ResearchStateV1,
  SourceDescriptorV1,
} from '@texttrends/core';
import type {
  BuildPhaseV4,
  GenerationDocSpecV4,
  MissingWarmDocV4,
  QueryOpV4,
  QueryResultDataV4,
} from '../shared/analysis-contract.ts';
import type { StorageWarningCode } from '../shared/storage-contract.ts';

export const PROTOCOL_VERSION_V4 = 4;

/** The DOMAIN shapes the envelopes embed live in `shared/analysis-contract.ts`
 *  (semantic view models the UI renders) — this module owns only the protocol
 *  version, wire-only code vocabularies, and the versioned envelopes.
 *  Re-exported so worker-side modules keep one protocol import. */
export type {
  BuildPhaseV4,
  GenerationDocSpecV4,
  KeynessRequestV1,
  KwicTrack,
  MissingWarmDocV4,
  QueryOpV4,
  QueryResultDataV4,
  SourceAvailability,
  SourceFormat,
  WarmMissReasonV4,
  WireSelectionV4,
} from '../shared/analysis-contract.ts';

/** The artifact-cache health vocabulary is the storage contract's. */
export type StorageWarningCodeV4 = StorageWarningCode;

export type WorkerErrorCodeV4 =
  | 'PROTOCOL_VERSION'
  | 'SNAPSHOT_UNKNOWN'
  | 'GENERATION_STALE'
  | 'SELECTION_INVALID'
  | 'CAP_EXCEEDED'
  | 'DECODE_FAILED'
  | 'SOURCE_MISMATCH'
  // Deterministic extraction contradicts an asserted text identity.
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
  | { readonly t: 'research-load'; readonly job: number; readonly project: string }
  | { readonly t: 'research-save'; readonly job: number; readonly project: string;
      readonly state: unknown; readonly expectedRevision: number }
  | { readonly t: 'source-persist'; readonly job: number; readonly sourceHash: string; readonly bytes: ArrayBuffer };

export type UserDataErrorCodeV4 =
  | 'PERSISTENCE_UNAVAILABLE'
  | 'REVISION_CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'REQUEST_INVALID'
  | 'INCOMPATIBLE_PROJECT'
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
    | { readonly t: 'cancel'; readonly job: number }
    | UserDataOpV4
  );

export type FromWorkerV4 = VersionedV4 &
  (
    | { readonly t: 'progress'; readonly job: number; readonly generation: string; readonly phase: BuildPhaseV4; readonly doc: string }
    | { readonly t: 'source-ready'; readonly job: number; readonly generation: string; readonly doc: string;
        readonly source: SourceDescriptorV1; readonly extractionRecipe: string; readonly text: string;
        readonly textLengthUtf16: number;
        readonly decoderReplacementCount: number; readonly suspiciousControlCount: number }
    | { readonly t: 'snapshot-published'; readonly generation: string; readonly snapshot: string;
        readonly readyDocs: readonly string[]; readonly missingDocs: readonly string[] }
    | { readonly t: 'generation-ready'; readonly job: number; readonly generation: string;
        readonly snapshot: string | null; readonly readyDocs: readonly string[]; readonly missing: readonly MissingWarmDocV4[] }
    | { readonly t: 'result'; readonly job: number; readonly snapshot: string; readonly data: QueryResultDataV4 }
    | { readonly t: 'warning'; readonly generation?: string; readonly code: StorageWarningCodeV4; readonly message: string }
    | { readonly t: 'error'; readonly job?: number; readonly generation?: string;
        readonly code: WorkerErrorCodeV4; readonly message: string; readonly recoverable: boolean }
    | { readonly t: 'cancelled'; readonly job: number }
    // User-data acknowledgements — distinct from analysis results. The loaded
    // manifest carries its own revision (single authority) — no second copy.
    // The WORKER is the sole durable-admission authority: `manifest` is the
    // deeply-validated record (a corrupt one is a user-data-error),
    // so the main thread installs it without a second validation pass.
    | { readonly t: 'project-loaded'; readonly job: number; readonly project: string;
        readonly manifest: ProjectManifestV2 }
    | { readonly t: 'project-missing'; readonly job: number; readonly project: string }
    | { readonly t: 'project-saved'; readonly job: number; readonly project: string; readonly revision: number }
    | { readonly t: 'research-loaded'; readonly job: number; readonly project: string;
        readonly state: ResearchStateV1 }
    | { readonly t: 'research-missing'; readonly job: number; readonly project: string }
    | { readonly t: 'research-saved'; readonly job: number; readonly project: string; readonly revision: number }
    | { readonly t: 'source-persisted'; readonly job: number; readonly sourceHash: string }
    | { readonly t: 'user-data-error'; readonly job: number; readonly code: UserDataErrorCodeV4;
        readonly message: string; readonly currentRevision?: number }
  );
