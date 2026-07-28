/**
 * Artifact identity derivation — Phase 1 plan, Milestone 0.
 *
 * The index artifact identity is the hash of a canonical DESCRIPTOR (text,
 * recipe, segmenter-fingerprint hashes), not a digest of every array byte:
 * the builder is deterministic under a versioned schema, so the descriptor
 * fully determines the artifact. Loaded arrays are still structurally
 * validated before use — identity is not integrity.
 */

import type { IndexArtifactHash, IndexRecipeHash, SectionId, TextHash } from './brands.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import type { SegmenterFingerprint } from '../segment/intl.ts';
import type { DocumentIndexV1 } from '../index/build.ts';

declare const brand: unique symbol;
type SegmenterFingerprintHash = string & { readonly [brand]: 'SegmenterFingerprintHash' };

export async function hashSegmenterFingerprint(
  fp: SegmenterFingerprint,
): Promise<SegmenterFingerprintHash> {
  return (await sha256Hex(canonicalJson(fp))) as SegmenterFingerprintHash;
}

interface DocumentIndexIdentityV1 {
  readonly schema: 'texttrends/document-index-identity/1';
  readonly text: TextHash;
  readonly recipe: IndexRecipeHash;
  readonly segmenter: SegmenterFingerprintHash;
}

export async function indexArtifactHash(shard: DocumentIndexV1): Promise<IndexArtifactHash> {
  const identity: DocumentIndexIdentityV1 = {
    schema: 'texttrends/document-index-identity/1',
    text: shard.text,
    recipe: shard.recipe,
    segmenter: await hashSegmenterFingerprint(shard.segmenter),
  };
  return (await sha256Hex(canonicalJson(identity))) as IndexArtifactHash;
}

/**
 * Deterministic SectionId binding — engine-v4 consult §D. A project-bound
 * SectionId derives from the document id and the section's LINEAGE key, with
 * an explicit versioned method tag. It must NOT depend on the StructureHash,
 * or a harmless retitle/range correction would change every section's id.
 */
export async function bindSectionId(doc: string, lineageKey: string): Promise<SectionId> {
  return (await sha256Hex(canonicalJson({ method: 'section-id/1', doc, key: lineageKey }))) as SectionId;
}
