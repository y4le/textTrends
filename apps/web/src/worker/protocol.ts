/**
 * Worker wire protocol — analysis contract §8 (versioned envelope) plus the
 * Phase 1 plan's warm-reopen inputs (per-document GenerationDocSpec).
 * Every message literally carries the protocol version; any message is legal
 * first; a version mismatch is answered with error{PROTOCOL_VERSION}.
 *
 * v3 (Milestone 5, Codex M5 consult): begin-generation becomes the warm-
 * reopen seam — each doc may assert an exact expected TextHash, the fully
 * resolved (still provisional) index recipe travels in the message instead
 * of living as hidden worker state, and a correlated `generation-ready`
 * barrier tells the main thread exactly which documents still need bytes.
 * Storage health moves to a dedicated non-fatal `warning` channel; cache
 * corruption is repair, not ingest failure, so ARTIFACT_CORRUPT leaves the
 * error union and SOURCE_MISMATCH (delivered bytes contradict the asserted
 * identity) joins it. Union growth is a version bump by contract.
 */

import type {
  IndexRecipeProvisional,
  KwicRequest,
  KwicRow,
  NumericTrend,
  PassageRequest,
  PassageResult,
  TermGroupSpec,
  TrendRequest,
} from '@texttrends/core';

/** Wire-level selection: plain strings; the engine brands after validation. */
export interface WireSelection {
  readonly docs: readonly string[];
  readonly ranges?: readonly {
    readonly doc: string;
    readonly tokens: { readonly start: number; readonly end: number };
  }[];
}

export const PROTOCOL_VERSION = 3;

export type BuildPhase = 'decode' | 'segment' | 'index' | 'compose';

export type WorkerErrorCode =
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

/** Non-fatal storage-health channel — a warning must never reject ingest,
 *  rehydration, or a query; results are unaffected, persistence may be. */
export type StorageWarningCode =
  | 'CACHE_UNAVAILABLE'
  | 'CACHE_READ_FAILED'
  | 'CACHE_WRITE_FAILED'
  | 'CACHE_CORRUPT';

export interface GenerationDocSpec {
  readonly doc: string;
  readonly language: string;
  readonly sourceByteLength: number;
  /**
   * Exact expected TextHash, asserted by the main thread from an
   * AUTHORITATIVE identity (versioned corpus/project manifest) — never a
   * mutable doc-label → hash cache, which could resurrect the wrong text
   * under a reused name. Present: the worker may rehydrate this document
   * from storage without byte transfer, and delivered bytes MUST hash to
   * this value (SOURCE_MISMATCH otherwise). Absent: cold ingest required.
   */
  readonly expectedText?: string;
}

/** Why a document could not be warm-rehydrated and still needs its bytes. */
export type WarmMissReason =
  | 'no-text-identity'
  | 'text-miss'
  | 'text-corrupt'
  | 'rehydrate-failed';

export interface MissingWarmDoc {
  readonly doc: string;
  readonly reason: WarmMissReason;
}

export type QueryOp =
  | { readonly op: 'trend'; readonly selection: WireSelection; readonly group: TermGroupSpec;
      readonly request: TrendRequest }
  | { readonly op: 'kwic'; readonly selection: WireSelection; readonly group: TermGroupSpec;
      readonly request: KwicRequest }
  | { readonly op: 'passage'; readonly request: PassageRequest };

export type QueryResultData =
  | { readonly op: 'trend'; readonly trend: NumericTrend }
  | { readonly op: 'kwic'; readonly total: number; readonly rows: readonly KwicRow[] }
  | { readonly op: 'passage'; readonly passage: PassageResult };

interface Versioned {
  readonly v: typeof PROTOCOL_VERSION;
}

export type ToWorker = Versioned &
  (
    | { readonly t: 'begin-generation'; readonly job: number; readonly generation: string;
        readonly docs: readonly GenerationDocSpec[];
        readonly recipe: IndexRecipeProvisional }
    | { readonly t: 'ingest'; readonly job: number; readonly generation: string;
        readonly doc: string; readonly bytes: ArrayBuffer }
    | { readonly t: 'query'; readonly job: number; readonly snapshot: string;
        readonly query: QueryOp }
    | { readonly t: 'excerpt'; readonly job: number; readonly snapshot: string;
        readonly doc: string; readonly charStart: number; readonly charEnd: number }
    | { readonly t: 'cancel'; readonly job: number }
  );

export type FromWorker = Versioned &
  (
    | { readonly t: 'progress'; readonly job: number; readonly generation: string;
        readonly phase: BuildPhase; readonly doc: string }
    | { readonly t: 'source-ready'; readonly job: number; readonly generation: string;
        readonly doc: string; readonly textHash: string; readonly textLength: number }
    | { readonly t: 'snapshot-published'; readonly generation: string;
        readonly snapshot: string; readonly readyDocs: readonly string[];
        readonly missingDocs: readonly string[] }
    /** Correlated completion barrier for a begin-generation job: warm
     *  resolution is finished; exactly `missing` still need their bytes.
     *  Fires even when everything (or nothing) rehydrated. */
    | { readonly t: 'generation-ready'; readonly job: number;
        readonly generation: string; readonly snapshot: string | null;
        readonly readyDocs: readonly string[];
        readonly missing: readonly MissingWarmDoc[] }
    | { readonly t: 'result'; readonly job: number; readonly snapshot: string;
        readonly data: QueryResultData }
    | { readonly t: 'excerpt-result'; readonly job: number; readonly snapshot: string;
        readonly doc: string; readonly charStart: number; readonly charEnd: number;
        readonly text: string }
    | { readonly t: 'warning'; readonly generation?: string;
        readonly code: StorageWarningCode; readonly message: string }
    | { readonly t: 'error'; readonly job?: number; readonly generation?: string;
        readonly code: WorkerErrorCode; readonly message: string;
        readonly recoverable: boolean }
    | { readonly t: 'cancelled'; readonly job: number }
  );
