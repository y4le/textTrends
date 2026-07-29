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
export { mattr, mtld } from './stats/diversity.ts';
export { CapError } from './contract/brands.ts';
// The explicit retained brand list (the wildcard export is gone): TextHash is
// the one brand production code names through the package surface.
export type { TextHash } from './contract/brands.ts';
export { canonicalJson, hashSourceBytes, hashText } from './contract/hash.ts';
export { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from './contract/verified-text.ts';
export { exactArray, exactRecord, isNonNegSafeInt, isRecord, isString } from './contract/guards.ts';
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
export { bindSectionId, hashSegmenterFingerprint } from './contract/identity.ts';
export {
  composeSnapshot,
  makeReadyDocument,
  type CorpusSnapshotV1,
  type ReadyDocument,
} from './snapshot/compose.ts';
export { resolveSelection, type ResolvedSelection } from './snapshot/selection.ts';
export { trend, type NumericTrend, type TrendRequest } from './ops/trend.ts';
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
  kwicPage,
  MAX_KWIC_TRACKS,
  materializeKwicPage,
  type KwicRequest,
  type KwicRow,
} from './ops/kwic.ts';
export {
  checkedResolverFor,
  occurrences,
  TERM_GROUP_LIMITS_V1,
  termGroupIdentity,
  validateGroup,
  type GroupMember,
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
  materializePassage,
  PASSAGE_MAX_TOKENS,
  planPassage,
  type PassageRequest,
  type PassageResult,
} from './ops/passage.ts';
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
export { buildResolver, modeKey, type MatchMode, type Resolver } from './resolve/fold.ts';
export { DecodeError, decodeSource } from './extract/decode.ts';
export { hashStructureCandidates, type StructureCandidateV1 } from './extract/candidates.ts';
export {
  decodeDocumentSource,
  defaultExtractionRecipes,
  deriveCandidatesFromText,
  type CandidateBundle,
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
export { STRUCTURE_LIMITS_V0 } from './contract/structure-limits.ts';
export { lineWindowAround } from './extract/lines.ts';
export {
  ROOT_KEY,
  StructureCapError,
  StructureError,
  type CharRange,
  type StructureSectionRecordV2,
} from './structure/sections.ts';
export {
  DEFAULT_STRUCTURE_RECIPE,
  buildDetectedSections,
  composeStructure,
  emptyOverride,
  hashStructureOverride,
  hashStructureRecipe,
  isStructureOverrideV1,
  isStructureRecipeProvisional,
  overrideFromEditedOutline,
  type EditableSectionValue,
  type StructureArtifactV2,
  type StructureOverrideV1,
  type StructureRecipeProvisional,
} from './structure/build.ts';
export { projectSections, type TokenRange } from './structure/project.ts';
export {
  validateExtractionArtifactVerified,
  validateStructureArtifactV2,
} from './extract/validate.ts';
export {
  upgradeStoredManifest,
  validateProjectManifest,
  type DocumentMetaV1,
  type PersistedOverride,
  type ProjectDocV1,
  type ProjectManifestV1,
  type SourceAvailability,
} from './project/manifest.ts';
