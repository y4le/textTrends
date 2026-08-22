/**
 * The analysis DOMAIN contract shared by the main thread and the worker — the
 * generation inputs, warm-miss vocabulary, query operations, and result view
 * models the UI renders. These are semantic shapes, NOT transport: the
 * versioned wire envelopes live in `worker/protocol-v4.ts` and EMBED these
 * types. Components and lib modules import from here (or from core), never
 * from the wire module — an import-boundary test enforces that.
 *
 * Core owns the recipe/request/row vocabularies; this module owns
 * only the app-level shapes composed from them.
 */

import type {
  CompanyRequestV1,
  CompanyResultV1,
  DestinationsRequestV1,
  DestinationsResultV1,
  MatchesAnchorV1,
  MatchesAxisArraysV1,
  MatchesPositionBracketV1,
  DispersionResultV1,
  ExtractionRecipeProvisional,
  KwicRow,
  NumericTrend,
  SourceFormat,
  TermGroupSpec,
  TrendRequest,
  InventoryRequestV1,
  InventoryResultV1,
  FrequencyListRequestV1,
  FrequencyListResultV1,
  KeynessResultV1,
  KeynessTableRequestV1,
  OccurrenceStepRequestV1,
  OccurrenceStepResultV1,
} from '@texttrends/core';

/** The source format vocabulary is core's — re-exported rather than
 *  redeclared so it can never drift from the extractor's authority. */
export type { SourceFormat };

export type BuildPhaseV4 = 'decode' | 'extract' | 'segment' | 'index' | 'compose';

/**
 * Per-document generation input. Recipe
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
  };
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: string;
    readonly expectedText?: string;
    readonly expectedTextLengthUtf16?: number;
  };
}

/** One match track: a series identity + the term group that matched. */
export interface KwicTrack {
  readonly seriesId: string;
  readonly group: TermGroupSpec;
}

export interface MatchesWindowQueryRequestV1 {
  readonly method: 'matches-window/1';
  readonly anchor: MatchesAnchorV1;
  readonly before: number;
  readonly after: number;
  readonly contextTokens: number;
  /** Stateless response shaping: false when the caller retains this axis. */
  readonly includeAxis: boolean;
}

export interface MatchesWindowResultV1 {
  readonly method: 'matches-window/1';
  readonly total: number;
  readonly trackCount: number;
  readonly anchorRank: number | null;
  readonly firstRank: number;
  readonly preceding: MatchesPositionBracketV1 | null;
  readonly rows: readonly KwicRow[];
  readonly axis?: MatchesAxisArraysV1;
}

export type QueryOpV4 =
  | { readonly op: 'trend'; readonly selection: WireSelectionV4; readonly group: TermGroupSpec; readonly request: TrendRequest }
  // matches-window/1 is the full-corpus continuous reading surface. It has
  // no selection field; the engine constructs canonical full-ready-corpus
  // coordinates, so a linked analytical brush cannot narrow navigation.
  | { readonly op: 'matches-window'; readonly tracks: readonly KwicTrack[]; readonly request: MatchesWindowQueryRequestV1 }
  // dispersion/1 (slice-2 ruling): the barcode's bounded numeric result over
  // the shared occurrence primitive — adaptive exact/density per track. The
  // request PINS the fixed resolution policy (the exported core constants);
  // the narrower refuses any other values, so no component-local magic numbers
  // can drift the contract.
  | { readonly op: 'dispersion'; readonly selection: WireSelectionV4; readonly tracks: readonly KwicTrack[]; readonly request: DispersionRequestV1 }
  // company/1 and destinations/1 are full-corpus overview lanes. Like other
  // context surfaces, their wire requests have no caller-owned selection;
  // the engine supplies one canonical full-ready-corpus selection so all
  // occurrence consumers share the same prepared vectors.
  | { readonly op: 'company'; readonly tracks: readonly KwicTrack[]; readonly request: CompanyRequestV1 }
  | { readonly op: 'destinations'; readonly tracks: readonly KwicTrack[]; readonly request: DestinationsRequestV1 }
  // inventory/1: vocabulary-wide overview over the shared per-document
  // term-count cache. It consumes the same linked detail selection as the
  // frequency table; notebook groups are deliberately absent.
  | { readonly op: 'inventory'; readonly selection: WireSelectionV4; readonly request: InventoryRequestV1 }
  | { readonly op: 'freq-list'; readonly selection: WireSelectionV4; readonly request: FrequencyListRequestV1 }
  // keyness/1 owns both sides. The global linked trend brush is deliberately
  // absent: a comparison can only change through its explicit side records.
  | { readonly op: 'keyness'; readonly request: KeynessRequestV1 }
  // reader-page/1: bounded directional source slices for browser-fitted
  // reading, with occurrence marks from the SHARED cached BASE occurrences. Like
  // other context/navigation surfaces, this carries NO selection field; the
  // engine constructs the only valid full-corpus selection, making accidental
  // range-filtered reader highlights impossible. ZERO tracks is legal.
  | { readonly op: 'reader-page'; readonly tracks: readonly KwicTrack[]; readonly request: ReaderPageRequestV1 }
  // occurrence-step/1 is exact full-corpus navigation over every active track.
  // Like Reader it has no caller-owned selection; linked ranges must not turn
  // next/previous reference into a partial-corpus operation.
  | { readonly op: 'occurrence-step'; readonly tracks: readonly KwicTrack[]; readonly request: OccurrenceStepRequestV1 };

export interface ReaderPageRequestV1 {
  readonly method: 'reader-page/1';
  readonly doc: string;
  readonly cursor:
    | { readonly kind: 'around'; readonly token: number }
    | { readonly kind: 'from'; readonly token: number }
    | { readonly kind: 'before'; readonly token: number };
  readonly maxTokens: number;
}

/** A reader mark on the wire, bound to the request's series/group identity
 *  by the core materializer (the bounded match-window precedent). */
export interface ReaderPageMarkV1 {
  readonly seriesId: string;
  readonly groupId: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly members: readonly number[];
  readonly charsUtf16: { readonly start: number; readonly end: number };
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export interface ReaderPageResultV1 {
  readonly method: 'reader-page/1';
  readonly doc: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly docCharsUtf16: { readonly start: number; readonly end: number };
  readonly text: string;
  readonly tokenStartsUtf16: readonly number[];
  readonly tokenEndsUtf16: readonly number[];
  /** Index-authored unit boundaries relative to `tokens.start`. A terminal
   *  boundary equal to the page token length is retained when genuine. */
  readonly sentenceBounds: readonly number[];
  readonly paragraphBounds: readonly number[];
  readonly anchor: { readonly token: number; readonly relToken: number; readonly charsUtf16: { readonly start: number; readonly end: number } } | null;
  readonly previous: { readonly kind: 'before'; readonly token: number } | null;
  readonly next: { readonly kind: 'from'; readonly token: number } | null;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly docTokenCount: number;
  readonly cappedBy: 'tokens' | 'text' | null;
  readonly marks: readonly ReaderPageMarkV1[];
  readonly marksTruncated: boolean;
}

/** The dispersion result type re-exported for the app boundary (components
 *  and lib modules import from HERE, never the wire module). */
export type { DispersionResultV1 } from '@texttrends/core';
export type {
  CompanyRequestV1,
  CompanyResultV1,
  DestinationsRequestV1,
  DestinationsResultV1,
} from '@texttrends/core';
export type {
  OccurrenceStepHitV1,
  OccurrenceStepRequestV1,
  OccurrenceStepResultV1,
} from '@texttrends/core';
export type {
  InventoryRequestV1,
  InventoryResultV1,
  InventoryRhythmV1,
} from '@texttrends/core';
export type {
  FrequencyListRequestV1,
  FrequencyListResultV1,
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
} from '@texttrends/core';

/** dispersion/1 request: the policy carried explicitly and validated against
 *  the exported core constants (DISPERSION_EXACT_MAX / DISPERSION_BUCKET_BUDGET). */
export interface DispersionRequestV1 {
  readonly method: 'dispersion/1';
  readonly exactMax: number;
  readonly bucketBudget: number;
}

export interface WireSelectionV4 {
  readonly docs: readonly string[];
  readonly ranges?: readonly { readonly doc: string; readonly tokens: { readonly start: number; readonly end: number } }[];
}

export interface KeynessRequestV1 extends KeynessTableRequestV1 {
  readonly a: WireSelectionV4;
  readonly b: WireSelectionV4;
}

export type {
  KeynessResultV1,
  KeynessRowV1,
  KeynessSideTotalsV1,
  KeynessSideV1,
  KeynessSortFieldV1,
  KeynessTableRequestV1,
} from '@texttrends/core';

export type QueryResultDataV4 =
  | { readonly op: 'trend'; readonly trend: NumericTrend }
  | { readonly op: 'matches-window'; readonly window: MatchesWindowResultV1 }
  | { readonly op: 'dispersion'; readonly dispersion: DispersionResultV1 }
  | { readonly op: 'company'; readonly company: CompanyResultV1 }
  | { readonly op: 'destinations'; readonly destinations: DestinationsResultV1 }
  | { readonly op: 'inventory'; readonly inventory: InventoryResultV1 }
  | { readonly op: 'freq-list'; readonly frequency: FrequencyListResultV1 }
  | { readonly op: 'keyness'; readonly keyness: KeynessResultV1 }
  | { readonly op: 'reader-page'; readonly page: ReaderPageResultV1 }
  | {
      readonly op: 'occurrence-step';
      readonly seriesId: string;
      readonly groupId: string;
      readonly step: OccurrenceStepResultV1;
    };
