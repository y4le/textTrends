// @texttrends/core — the analysis engine.
//
// This package is environment-agnostic by contract: no DOM, no Worker, no
// filesystem, no framework imports. Buffers and plain data in, typed results
// out. The web app wraps it in a Web Worker; the CLI wraps it in Node.
//
// The public surface is defined by the analysis contract
// (docs/design/analysis-contract.md) and grows here as each part is
// implemented; methods are specified in docs/design/statistics.md.
//
// SURFACE DISCIPLINE (simplification plan, Phase G): the barrel exports ONLY
// symbols consumed through the package surface by production code, plus the
// documented owner-retained surfaces (the stats methods, epubExtractionRecipe).
// Internal contracts stay module-exported for cross-module use and focused
// same-package tests; those tests import the module path, never the barrel.

// Explicit .ts specifiers keep these modules loadable under Node's type-stripping
// runner as well as bundlers — the CLI adapter depends on it.

// The statistics contract surface — implemented AHEAD of UI per
// docs/design/statistics.md ("implemented ⇒ exported with fixtures"); each
// method carries a versioned id future QueryOps reference. Deliberately kept
// exported with zero app consumers (owner decision, simplification plan §2).
export { g2Keyness, logRatio } from './stats/keyness.ts';
export { logDice, pmi, tScore } from './stats/collocation.ts';
export { dp, dpNorm } from './stats/dispersion.ts';
export { MATTR_MAX_TYPES, mattr, mattrIds, mtld } from './stats/diversity.ts';
export { CapError } from './contract/brands.ts';
// The explicit retained brand list (the wildcard export is gone): TextHash is
// the one brand production code names through the package surface.
export type { TextHash } from './contract/brands.ts';
export { canonicalJson, hashSourceBytes, hashText } from './contract/hash.ts';
export { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from './contract/verified-text.ts';
export { exactArray, exactRecord, isNonNegSafeInt, isRecord, isString } from './contract/guards.ts';
export {
  ALIAS_COMPILER_V1,
  compileAlias,
  compileAliasOrThrow,
  type AliasCompileErrorCode,
  type AliasCompileResult,
} from './project/alias.ts';
export {
  EMPTY_NOTEBOOK,
  EXACT_MATCH,
  FOLDED_MATCH,
  NOTEBOOK_LIMITS_V1,
  SERIES_COLOR_IDS,
  SERIES_LINE_IDS,
  coreGroupOf,
  defaultSeriesStyle,
  groupIdentity,
  groupTitle,
  isSeriesColor,
  memberSemanticKey,
  parseQueryNotebook,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
  type SeriesColor,
  type SeriesCustomColor,
  type SeriesColorId,
  type SeriesLineId,
  type SeriesStyleV1,
} from './project/notebook.ts';
export {
  TREND_RATE_DENOMINATORS,
  TREND_RATE_DENOMINATOR,
  TREND_SMOOTHING_WINDOWS,
  WORKSPACE_MAX_ID_UNITS,
  WORKSPACE_SCHEMA,
  parseWorkspace,
  parseWorkspaceTrendView,
  reconcileWorkspaceDocuments,
  type TrendRateDenominator,
  type TrendSmoothingWindow,
  type WorkspaceCompareViewV1,
  type WorkspaceCorpusV1,
  type WorkspaceDocumentMetaV1,
  type WorkspaceFrequencyViewV1,
  type WorkspaceLibraryDocumentV1,
  type WorkspaceTrendMeasureV1,
  type WorkspaceTrendViewV1,
  type WorkspaceV1,
  type WorkspaceWarmTextV1,
} from './project/workspace.ts';
export {
  DEFAULT_INDEX_RECIPE,
  hashIndexRecipe,
  isIndexRecipeProvisional,
  type IndexRecipeProvisional,
} from './contract/recipes.ts';
export { segment, segmentVerified, fingerprint } from './segment/intl.ts';
export {
  createDocumentIndex,
  createDocumentIndexVerified,
  tokenEndChar,
  validateShardStructure,
  type DocumentIndexV1,
} from './index/build.ts';
export { hashSegmenterFingerprint } from './contract/identity.ts';
export {
  composeSnapshot,
  makeReadyDocument,
  type CorpusSnapshotV1,
  type ReadyDocument,
} from './snapshot/compose.ts';
export { resolveSelection, type ResolvedSelection } from './snapshot/selection.ts';
export {
  TREND_FIXED_TOKENS_MAX,
  TREND_FIXED_TOKENS_MIN,
  TREND_MAX_ROWS,
  TREND_PER_DOC_MAX,
  TREND_PER_DOC_MIN,
  trend,
  type NumericTrend,
  type TrendBinMode,
  type TrendBinsSpecV1,
  type TrendRequest,
} from './ops/trend.ts';
export {
  bindShardsIncremental,
  bindTextsVerified,
  createBindingSession,
  DependencyError,
  type BindingSession,
  type BoundShards,
  type BoundTexts,
} from './ops/binding.ts';
export {
  KWIC_MAX_PAGE,
  MAX_KWIC_TRACKS,
  materializeKwicPage,
  type KwicRow,
} from './ops/kwic.ts';
export {
  buildConcordanceAxis,
  CONCORDANCE_AXIS_STRIDE,
  concordanceAxisPayloadBytes,
  copyConcordanceAxis,
  materializeConcordanceWindow,
  planConcordanceWindow,
  type ConcordanceAnchorV1,
  type ConcordanceAxisArraysV1,
  type ConcordanceAxisV1,
  type ConcordancePositionBracketV1,
  type ConcordanceWindowRequestV1,
  type ConcordanceWindowV1,
  type NumericConcordanceWindowV1,
} from './ops/concordance.ts';
export {
  checkedResolverFor,
  occurrencePayloadBytes,
  occurrences,
  OCCURRENCE_LIMITS_V1,
  TERM_GROUP_LIMITS_V1,
  termGroupIdentity,
  validateGroup,
  type GroupMember,
  type PhraseElement,
  type NumericOccurrences,
  type ResolverTable,
  type TermGroupSpec,
} from './ops/occurrences.ts';
export {
  materializeReaderPage,
  planReaderPage,
  READER_MAX_MARKS,
  READER_MAX_TEXT_UTF16,
  READER_MAX_TOKENS,
  READER_MAX_TRACKS,
  type NumericReaderPagePlan,
  type ReaderCappedBy,
  type ReaderCursor,
  type ReaderPageMark,
  type ReaderPageResult,
  type ReaderTrackIdentity,
} from './ops/reader.ts';
export {
  occurrenceStep,
  validateOccurrenceOrder,
  type OccurrenceStepHitV1,
  type OccurrenceStepRequestV1,
  type OccurrenceStepResultV1,
} from './ops/occurrence-step.ts';
export {
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  DISPERSION_PACK_CHUNK,
  dispersionTransferBuffers,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  selectionSlotMap,
  type DispersionGeometryV1,
  type DispersionResultV1,
  type DispersionTrackDataV1,
  type DispersionTrackV1,
} from './ops/dispersion.ts';
export {
  documentTermCounts,
  termCountPayloadBytes,
  termCountRangeKey,
  TERM_COUNT_CACHE_MAX_BYTES,
  TERM_COUNT_CACHE_MAX_ENTRIES,
  type DocTermCountsV1,
} from './ops/term-counts.ts';
export {
  inventory,
  inventoryTransferBuffers,
  INVENTORY_MAX_GROWTH_POINTS,
  INVENTORY_MAX_MATTR_WINDOW,
  INVENTORY_MAX_RHYTHM_BINS_PER_DOC,
  INVENTORY_MAX_VOCAB_TYPES,
  INVENTORY_MIN_GROWTH_POINTS,
  INVENTORY_SCAN_CHUNK,
  type InventoryCheckpoint,
  type InventoryDocumentInputV1,
  type InventoryDocumentRowV1,
  type InventoryGrowthV1,
  type InventoryRequestV1,
  type InventoryResultV1,
  type InventoryRhythmV1,
  type InventoryTotalsV1,
} from './ops/inventory.ts';
export {
  frequencyList,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_SCAN_CHUNK,
  FREQUENCY_WINDOW_MAX,
  type FrequencyCheckpoint,
  type FrequencyListRequestV1,
  type FrequencyListResultV1,
  type FrequencyListRowV1,
  type FrequencySortFieldV1,
  type FrequencyTokenClassV1,
} from './ops/frequency.ts';
export {
  firstSelectionOverlap,
  keyness,
  KEYNESS_SCAN_CHUNK,
  type KeynessCheckpoint,
  type KeynessResultV1,
  type KeynessRowV1,
  type KeynessSideTotalsV1,
  type KeynessSideV1,
  type KeynessSortFieldV1,
  type KeynessTableRequestV1,
} from './ops/keyness.ts';
export { buildResolver, modeKey, type MatchMode, type Resolver } from './resolve/fold.ts';
export { DecodeError, decodeSource, type DetectedEncoding } from './extract/decode.ts';
export {
  decodeDocumentSource,
  defaultExtractionRecipes,
  epubExtractionRecipe,
  finalizeExtraction,
  hashExtractionRecipe,
  validateExtractionRecipe,
  type ExtractedDocument,
  type ExtractionArtifactV1,
  type ExtractionRecipeProvisional,
  type PreparedExtraction,
  type SourceDescriptorV1,
  type SourceFormat,
} from './extract/extraction.ts';
export {
  isLiteralFormat,
  isSourceFormat,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  sourceFormatForFilename,
  stripSourceExtension,
} from './extract/formats.ts';
export { INGEST_CAPS_V0, type IngestCapsV0 } from './contract/ingest-caps.ts';
