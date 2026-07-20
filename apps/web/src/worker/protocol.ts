/**
 * Worker wire protocol — analysis contract §8 (versioned envelope) plus the
 * Phase 1 plan's warm-reopen inputs (per-document GenerationDocSpec).
 * Every message literally carries the protocol version; any message is legal
 * first; a version mismatch is answered with error{PROTOCOL_VERSION}.
 *
 * v2: adds the `passage` query op (token-addressed evidence read for text
 * scrubbing). QueryOp/QueryResultData are EXHAUSTIVE unions, and the
 * contract states union growth is not assumed non-breaking — so the version
 * bumps even though both ends ship from one bundle.
 */

import type {
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

export const PROTOCOL_VERSION = 2;

export type BuildPhase = 'decode' | 'segment' | 'index' | 'compose';

export type WorkerErrorCode =
  | 'UNKNOWN_OP'
  | 'PROTOCOL_VERSION'
  | 'SNAPSHOT_UNKNOWN'
  | 'GENERATION_STALE'
  | 'SELECTION_INVALID'
  | 'CAP_EXCEEDED'
  | 'DECODE_FAILED'
  | 'PARSE_FAILED'
  | 'ARTIFACT_CORRUPT'
  | 'DEPENDENCY_MISSING'
  | 'REQUEST_INVALID'
  | 'INTERNAL';

export interface GenerationDocSpec {
  readonly doc: string;
  readonly language: string;
  readonly sourceByteLength: number;
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
        readonly docs: readonly GenerationDocSpec[] }
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
    | { readonly t: 'result'; readonly job: number; readonly snapshot: string;
        readonly data: QueryResultData }
    | { readonly t: 'excerpt-result'; readonly job: number; readonly snapshot: string;
        readonly doc: string; readonly charStart: number; readonly charEnd: number;
        readonly text: string }
    | { readonly t: 'error'; readonly job?: number; readonly generation?: string;
        readonly code: WorkerErrorCode; readonly message: string;
        readonly recoverable: boolean }
    | { readonly t: 'cancelled'; readonly job: number }
  );
