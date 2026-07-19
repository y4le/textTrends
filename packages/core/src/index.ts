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
export { V1_CAPS } from './contract/brands.ts';
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
  tokenKey,
  validateBatch,
  type DocumentIndexV1,
  type ShardIdentity,
} from './index/build.ts';
