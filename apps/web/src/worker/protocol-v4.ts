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
 * - warm opens verify disposable cached text and indexes before asking the
 *   main thread for source bytes.
 */

import type {
  IndexRecipeProvisional,
  SourceDescriptorV1,
} from '@texttrends/core';
import type {
  BuildPhaseV4,
  GenerationDocSpecV4,
  QueryOpV4,
  QueryResultDataV4,
} from '../shared/analysis-contract.ts';

export const PROTOCOL_VERSION_V4 = 4;

/** The DOMAIN shapes the envelopes embed live in `shared/analysis-contract.ts`
 *  (semantic view models the UI renders) — this module owns only the protocol
 *  version, wire-only code vocabularies, and the versioned envelopes.
 *  Re-exported so worker-side modules keep one protocol import. */
export type {
  BuildPhaseV4,
  CompanyRequestV1,
  CompanyResultV1,
  DestinationsRequestV1,
  DestinationsResultV1,
  MatchesWindowQueryRequestV1,
  MatchesWindowResultV1,
  GenerationDocSpecV4,
  KeynessRequestV1,
  KwicTrack,
  OccurrenceStepRequestV1,
  OccurrenceStepResultV1,
  QueryOpV4,
  QueryResultDataV4,
  SourceFormat,
  WireSelectionV4,
} from '../shared/analysis-contract.ts';

/** Artifact-cache health degradation emitted on the worker wire. */
export type StorageWarningCodeV4 =
  | 'CACHE_UNAVAILABLE'
  | 'CACHE_READ_FAILED'
  | 'CACHE_WRITE_FAILED'
  | 'CACHE_CORRUPT';

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
        readonly snapshot: string | null; readonly readyDocs: readonly string[]; readonly missingDocs: readonly string[] }
    | { readonly t: 'result'; readonly job: number; readonly snapshot: string; readonly data: QueryResultDataV4 }
    | { readonly t: 'warning'; readonly generation?: string; readonly code: StorageWarningCodeV4; readonly message: string }
    | { readonly t: 'error'; readonly job?: number; readonly generation?: string;
        readonly code: WorkerErrorCodeV4; readonly message: string; readonly recoverable: boolean }
    | { readonly t: 'cancelled'; readonly job: number }
  );
