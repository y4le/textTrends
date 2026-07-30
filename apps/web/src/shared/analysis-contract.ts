/**
 * The analysis DOMAIN contract shared by the main thread and the worker — the
 * generation inputs, warm-miss vocabulary, query operations, and result view
 * models the UI renders. These are semantic shapes, NOT transport: the
 * versioned wire envelopes live in `worker/protocol-v4.ts` and EMBED these
 * types. Components and lib modules import from here (or from core), never
 * from the wire module — an import-boundary test enforces that.
 *
 * Core owns the recipe/override/request/row vocabularies; this module owns
 * only the app-level shapes composed from them.
 */

import type {
  DispersionResultV1,
  ExtractionRecipeProvisional,
  KwicRequest,
  KwicRow,
  NumericTrend,
  PassageRequest,
  PassageResult,
  SourceAvailability,
  SourceFormat,
  StructureOverrideV1,
  StructureRecipeProvisional,
  TermGroupSpec,
  TokenRange,
  TrendRequest,
  InventoryRequestV1,
  InventoryResultV1,
  FrequencyListRequestV1,
  FrequencyListResultV1,
  TfidfSectionsRequestV1,
  TfidfSectionsResultV1,
} from '@texttrends/core';

/** The source format vocabulary is core's — re-exported rather than
 *  redeclared so it can never drift from the extractor's authority. The same
 *  goes for `SourceAvailability` (the manifest's vocabulary). */
export type { SourceAvailability, SourceFormat };

export type BuildPhaseV4 = 'decode' | 'extract' | 'segment' | 'index' | 'structure' | 'compose';

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
  | { readonly op: 'line-excerpt'; readonly request: { readonly doc: string; readonly anchor: number; readonly maxChars: number } }
  // dispersion/1 (slice-2 ruling): the barcode's bounded numeric result over
  // the shared occurrence primitive — adaptive exact/density per track. The
  // request PINS the fixed resolution policy (the exported core constants);
  // the narrower refuses any other values, so no component-local magic numbers
  // can drift the contract.
  | { readonly op: 'dispersion'; readonly selection: WireSelectionV4; readonly tracks: readonly KwicTrack[]; readonly request: DispersionRequestV1 }
  // inventory/1: vocabulary-wide overview over the shared per-document
  // term-count cache. It consumes the same linked detail selection as the
  // frequency table; notebook groups are deliberately absent.
  | { readonly op: 'inventory'; readonly selection: WireSelectionV4; readonly request: InventoryRequestV1 }
  | { readonly op: 'freq-list'; readonly selection: WireSelectionV4; readonly request: FrequencyListRequestV1 }
  // Section labels are a full-document structural comparison. There is no
  // selection degree of freedom, so a linked trend brush cannot redefine N.
  | { readonly op: 'tfidf-sections'; readonly request: TfidfSectionsRequestV1 }
  // reader-page/1 (slice-2 ruling §3/§G): bounded cursor-paged reading with
  // occurrence marks sliced from the SHARED cached BASE occurrences. Like
  // passage, this context/navigation surface carries NO selection field; the
  // engine constructs the only valid full-corpus selection, making accidental
  // range-filtered reader highlights impossible. ZERO tracks is legal.
  | { readonly op: 'reader-page'; readonly tracks: readonly KwicTrack[]; readonly request: ReaderPageRequestV1 };

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
 *  by the core materializer (the KWIC/passage precedent). */
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
  InventoryGrowthV1,
  InventoryRequestV1,
  InventoryResultV1,
  InventoryRhythmV1,
  InventorySectionsV1,
} from '@texttrends/core';
export type {
  FrequencyListRequestV1,
  FrequencyListResultV1,
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
  TfidfSectionsRequestV1,
  TfidfSectionsResultV1,
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
  | { readonly op: 'line-excerpt'; readonly excerpt: LineExcerptResultV1 }
  | { readonly op: 'dispersion'; readonly dispersion: DispersionResultV1 }
  | { readonly op: 'inventory'; readonly inventory: InventoryResultV1 }
  | { readonly op: 'freq-list'; readonly frequency: FrequencyListResultV1 }
  | { readonly op: 'tfidf-sections'; readonly tfidf: TfidfSectionsResultV1 }
  | { readonly op: 'reader-page'; readonly page: ReaderPageResultV1 };
