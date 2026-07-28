/**
 * Branded identifiers and v1 caps — analysis contract §1.
 *
 * Brands guard public APIs and constructors; typed-array element reads are
 * plain numbers by nature, so hot loops work on raw integers and validation
 * happens at artifact construction and adapter boundaries.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectDocId = Brand<string, 'ProjectDocId'>;
export type SectionId = Brand<string, 'SectionId'>;

export type LocalTypeId = Brand<number, 'LocalTypeId'>;
export type DocTokenPos = Brand<number, 'DocTokenPos'>;

export type SourceHash = Brand<string, 'SourceHash'>;
export type TextHash = Brand<string, 'TextHash'>;
export type StructureHash = Brand<string, 'StructureHash'>;
export type IndexArtifactHash = Brand<string, 'IndexArtifactHash'>;
export type IndexRecipeHash = Brand<string, 'IndexRecipeHash'>;
export type SelectionHash = Brand<string, 'SelectionHash'>;
export type CorpusSnapshotId = Brand<string, 'CorpusSnapshotId'>;
export type BuildGeneration = Brand<string, 'BuildGeneration'>;

export interface HalfOpenRange<T> {
  readonly start: T;
  readonly end: T;
}

/** Typed cap violation — protocol adapters map this to CAP_EXCEEDED without
 *  matching exception text (extends RangeError; existing guards still hold). */
export class CapError extends RangeError {
  override readonly name = 'CapError';
}

/** Enforced v1 limits — every position and terminal sentinel fits in Uint32. */
export const V1_CAPS = {
  maxDocTokens: 2 ** 31 - 1,
  maxCorpusTokens: 2 ** 32 - 2,
  maxVocabSize: 2 ** 31 - 1,
  maxDocTextUtf16: 2 ** 32 - 2,
} as const;
