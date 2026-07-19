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
  hashIndexRecipe,
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
  materializeKwicPage,
  type KwicRequest,
  type KwicRow,
  type NumericKwicPage,
} from './ops/kwic.ts';
export {
  occurrences,
  type GroupMember,
  type NumericOccurrences,
  type ResolverTable,
  type TermGroupSpec,
} from './ops/occurrences.ts';
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
