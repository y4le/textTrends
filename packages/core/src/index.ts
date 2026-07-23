// @texttrends/core — the analysis engine.
//
// This package is environment-agnostic by contract: no DOM, no Worker, no
// filesystem, no framework imports. Buffers and plain data in, typed results
// out. The web app wraps it in a Web Worker; the CLI wraps it in Node.
//
// The public surface is defined by the analysis contract
// (docs/design/analysis-contract.md) and grows here as each part is
// implemented; methods are specified in docs/design/statistics.md.

// Explicit .ts specifiers keep these modules loadable under Node's type-stripping
// runner as well as bundlers — the CLI adapter depends on it.
export { g2Keyness, logRatio } from './stats/keyness.ts';
export { logDice, pmi, tScore } from './stats/collocation.ts';
export { dp, dpNorm } from './stats/dispersion.ts';
export { mattr, mtld } from './stats/diversity.ts';
export { CapError, V1_CAPS } from './contract/brands.ts';
export type * from './contract/brands.ts';
export { canonicalJson, hashText, sha256Hex, type JsonValue } from './contract/hash.ts';
export {
  DEFAULT_INDEX_RECIPE,
  exactArray,
  exactRecord,
  hashIndexRecipe,
  isIndexRecipeProvisional,
  TOKEN_CLASS,
  type IndexRecipeProvisional,
} from './contract/recipes.ts';
export { segment, fingerprint, SEGMENTER_PROBE } from './segment/intl.ts';
export type { SegmentationBatch, SegmenterFingerprint } from './segment/intl.ts';
export {
  buildDocumentIndex,
  createDocumentIndex,
  paragraphCharStarts,
  postingsFor,
  tokenCharLength,
  tokenEndChar,
  validateShardStructure,
  tokenKey,
  validateBatch,
  type DocumentIndexV1,
  type ShardIdentity,
} from './index/build.ts';
export {
  bindSectionId,
  hashSegmenterFingerprint,
  indexArtifactHash,
  rootOnlyStructure,
  structureHash,
  type DocumentIndexIdentityV1,
  type SegmenterFingerprintHash,
  type StructureArtifactV1,
} from './contract/identity.ts';
export {
  composeSnapshot,
  makeReadyDocument,
  validateSnapshot,
  type CorpusDocRef,
  type CorpusSnapshotV1,
  type ReadyDocument,
  type SnapshotLimits,
  type SnapshotVocabularyV1,
} from './snapshot/compose.ts';
export { resolveSelection, type ResolvedSelection, type SelectionSpec } from './snapshot/selection.ts';
export { trend, type NumericTrend, type TrendRequest } from './ops/trend.ts';
export {
  bindShards,
  bindTexts,
  DependencyError,
  type BoundShards,
  type BoundTexts,
} from './ops/binding.ts';
export {
  kwicPage,
  KWIC_MAX_PAGE,
  MAX_KWIC_TRACKS,
  materializeKwicPage,
  type KwicRequest,
  type KwicRow,
  type KwicTrackIdentity,
  type NumericKwicPage,
} from './ops/kwic.ts';
export {
  checkedResolverFor,
  matchGroupInTokenRanges,
  mergeGroupSpans,
  occurrences,
  termGroupIdentity,
  type GroupMember,
  type GroupSpan,
  type NumericOccurrences,
  type RawMatch,
  type ResolverTable,
  type TermGroupSpec,
  type TokenRangeSpan,
} from './ops/occurrences.ts';
export {
  materializePassage,
  PASSAGE_MAX_TOKENS,
  PASSAGE_MAX_UTF16,
  planPassage,
  type NumericPassagePlan,
  type PassageMark,
  type PassageRequest,
  type PassageResult,
  type PassageTrackSpec,
} from './ops/passage.ts';
export {
  buildResolver,
  FOLD_RESOLVER,
  foldKey,
  modeKey,
  resolveAffix,
  resolveToken,
  type MatchMode,
  type Resolver,
} from './resolve/fold.ts';
export {
  DecodeError,
  DETECTED_ENCODINGS,
  decodeSource,
  windows1252TableHash,
  type DecodedSource,
  type DetectedEncoding,
} from './extract/decode.ts';
export {
  assertValidCandidates,
  hashStructureCandidates,
  isValidCandidate,
  STRUCTURE_CANDIDATE_KINDS,
  type StructureCandidateKind,
  type StructureCandidateV1,
} from './extract/candidates.ts';
export { scanMarkdownHeadings } from './extract/markdown.ts';
export {
  decodeDocumentSource,
  defaultExtractionRecipes,
  epubExtractionRecipe,
  extractDocument,
  finalizeExtraction,
  hashExtractionRecipe,
  htmlExtractionRecipe,
  validateExtractionRecipe,
  hashSourceBytes,
  type CandidateReconstruction,
  type ContainerSourceDescriptorV1,
  type DecodedDocument,
  type EbookPartition,
  type EpubExtractorPolicyV0,
  type HtmlExtractorPolicyV0,
  type MarkupSourceDescriptorV1,
  type ExtractedDocument,
  type ExtractionArtifactV1,
  type ExtractionEvidence,
  type ExtractionRecipeProvisional,
  type MdExtractionRecipe,
  type PreparedExtraction,
  type SourceDescriptorV1,
  type SourceFormat,
  type TextSourceDescriptorV1,
  type TxtExtractionRecipe,
} from './extract/extraction.ts';
export {
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  isSourceFormat,
  sourceFormatForFilename,
  stripSourceExtension,
  type SourceFormatMetadata,
} from './extract/formats.ts';
export { INGEST_CAPS_V0, type IngestCapsV0 } from './contract/ingest-caps.ts';
export { STRUCTURE_LIMITS_V0, type StructureLimitsV0 } from './contract/structure-limits.ts';
export { lineWindowAround, type LineWindow } from './extract/lines.ts';
export {
  ROOT_KEY,
  StructureCapError,
  StructureError,
  validateSectionTable,
  type CharRange,
  type SectionOrigin,
  type StructureSectionRecordV2,
} from './structure/sections.ts';
export {
  DEFAULT_STRUCTURE_RECIPE,
  applyOverride,
  boundTitle,
  buildDetectedSections,
  canonicalChanges,
  composeStructure,
  emptyOverride,
  hashStructureOverride,
  hashStructureRecipe,
  isStructureOverrideV1,
  isStructureRecipeProvisional,
  overrideFromEditedOutline,
  scanChapterHeadings,
  type EditableSectionValue,
  type SectionValue,
  type StructureArtifactV2,
  type StructureChange,
  type StructureOverrideV1,
  type StructureRecipeProvisional,
} from './structure/build.ts';
export {
  charRangeToTokenRange,
  lowerBound,
  projectSections,
  type TokenRange,
} from './structure/project.ts';
export {
  ArtifactCorruptError,
  validateExtractionArtifact,
  validateStructureArtifactV2,
} from './extract/validate.ts';
export {
  deriveCandidatesFromText,
  type CandidateBundle,
} from './extract/extraction.ts';
export {
  structureHashOf,
  type ReadyStructure,
} from './snapshot/compose.ts';
export {
  ManifestInvalidError,
  upgradeStoredManifest,
  validateProjectManifest,
  type DocumentMetaV1,
  type PersistedOverride,
  type ProjectDocV1,
  type ProjectManifestV1,
} from './project/manifest.ts';
