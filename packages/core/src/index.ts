export { FREQUENCY_TOKEN_CLASSES_V1, FREQUENCY_SORT_FIELDS_V1, KEYNESS_SORT_FIELDS_V1, TREND_COORDINATES, TREND_BIN_MODES, isFrequencyTokenClass, isFrequencySortField, isKeynessSortField, isTrendCoordinate, isTrendBins } from './contract/analysis-literals.ts';
// @texttrends/core — the analysis engine.
//
// This package is environment-agnostic by contract: no DOM, no Worker, no
// filesystem, no framework imports. Buffers and plain data in, typed results
// out. The web app wraps it in a Web Worker; the CLI wraps it in Node.
// Vocabulary regex filtering lazily loads the environment-agnostic RE2JS engine.
//
// The public surface is defined by the analysis contract
// (docs/design/analysis-contract.md) and grows here as each part is
// implemented; methods are specified in docs/design/statistics.md.
//
// SURFACE DISCIPLINE (simplification plan, Phase G): the barrel exports ONLY
// symbols consumed through the package surface by production code, plus the
// documented owner-retained surfaces (the stats methods, analytical literals, epubExtractionRecipe).
// Internal contracts stay module-exported for cross-module use and focused
// same-package tests; those tests import the module path, never the barrel.

// Explicit .ts specifiers keep these modules loadable under Node's type-stripping
// runner as well as bundlers — the CLI adapter depends on it.

// The statistics contract surface — implemented AHEAD of UI per
// docs/design/statistics.md ("implemented ⇒ exported with fixtures"); each
// method carries a versioned id future QueryOps reference. Deliberately kept
// exported with zero app consumers (owner decision, simplification plan §2).
export {
  g2Keyness,
  logRatio,
  logRatioInterval,
  LOG_RATIO_Z_95,
  type LogRatioIntervalV1,
} from './stats/keyness.ts';
export { logDice, pmi, tScore } from './stats/collocation.ts';
export { dp, dpNorm } from './stats/dispersion.ts';
export { rateContrast } from './stats/contrast.ts';
export { jensenShannon, jsdContribution } from './stats/divergence.ts';
export {
  automatedReadabilityIndex,
  colemanLiauIndex,
} from './stats/readability.ts';
export { MATTR_MAX_TYPES, mattr, mattrIds, mtld } from './stats/diversity.ts';
export { CapError } from './contract/brands.ts';
// The explicit retained brand list (the wildcard export is gone): TextHash is
// the one brand production code names through the package surface.
export type { TextHash } from './contract/brands.ts';
export {
  canonicalJson,
  hashSourceBytes,
} from './contract/hash.ts';
export { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from './contract/verified-text.ts';
export {
  exactRecord,
  isNonNegSafeInt,
  isRecord,
  isString,
} from './contract/guards.ts';

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
  TREND_RATE_DENOMINATOR,
  TREND_SMOOTHING_WINDOWS,
  parseWorkspace,
  parseWorkspaceTrendView,
  reconcileWorkspaceDocuments,
  type TrendSmoothingWindow,
  type WorkspaceDocumentMetaV1,
  type WorkspaceLibraryDocumentV1,
  type WorkspaceTrendMeasureV1,
  type WorkspaceTrendViewV1,
  type WorkspaceV1,
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
  KWIC_CONTEXT_MAX_TOKENS,
  KWIC_MAX_PAGE,
  MAX_KWIC_TRACKS,
  type KwicContextMark,
  type KwicRow,
} from './ops/kwic.ts';
export {
  buildMatchesAxis,
  matchesAxisPayloadBytes,
  copyMatchesAxis,
  materializeMatchesWindow,
  planMatchesWindow,
  type MatchesAnchorV1,
  type MatchesAxisArraysV1,
  type MatchesAxisV1,
  type MatchesPositionBracketV1,
  type MatchesWindowRequestV1,
  type MatchesWindowV1,
} from './ops/matches.ts';
export {
  occurrencePayloadBytes,
  occurrences,
  OCCURRENCE_LIMITS_V1,
  TERM_GROUP_LIMITS_V1,
  termGroupIdentity,
  type GroupMember,
  type NumericOccurrences,
  type TermGroupSpec,
} from './ops/occurrences.ts';
export {
  company,
  createCompanyScratch,
  COMPANY_GAP_EDGES_V1,
  type CompanyRequestV1,
  type CompanyResultV1,
  type CompanyTrackInputV1,
} from './ops/company.ts';
export {
  createDestinationsScratch,
  destinationScratchBytes,
  materializeDestinations,
  planDestinationWindowSpikeV0,
  planDestinations,
  DESTINATION_MAX_RESULTS,
  DESTINATION_WINDOW_TOKENS_V1,
  type DestinationsRequestV1,
  type DestinationsResultV1,
  type DestinationTrackInputV1,
} from './ops/destinations.ts';
export {
  materializeReaderPage,
  planReaderPage,
  type ReaderCursor,
  type ReaderPageMark,
  type ReaderPageResult,
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
  dispersionTransferBuffers,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  selectionSlotMap,
  type DispersionGeometryV1,
  type DispersionResultV1,
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
  INVENTORY_MAX_MATTR_WINDOW,
  INVENTORY_MAX_RHYTHM_BINS_PER_DOC,
  type InventoryDocumentInputV1,
  type InventoryDocumentRowV1,
  type InventoryRequestV1,
  type InventoryResultV1,
  type InventoryRhythmV1,
} from './ops/inventory.ts';
export {
  frequencyList,
  FREQUENCY_FILTER_MAX_UNITS,
  FREQUENCY_PAGE_MAX,
  type FrequencyListRequestV1,
  type FrequencyListResultV1,
  type FrequencyListRowV1,
  type FrequencySortFieldV1,
  type FrequencyTextFilterV1,
  type FrequencyTokenClassV1,
} from './ops/frequency.ts';
export {
  STOPLIST_EN_ID,
  STOPLIST_EN_VERSION,
  STOPLIST_MAX_TOP_N,
  isStoplistSpecV1,
} from './ops/stoplist-contract.ts';

export {
  firstSelectionOverlap,
  keyness,
  type KeynessResultV1,
  type KeynessDivergenceV1,
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
