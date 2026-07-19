/**
 * Bound execution contexts — Milestone 3 review rounds 1-4.
 *
 * Kernels must not accept structural objects that merely CLAIM to be verified
 * contexts. The factories here return frozen, minimal capability objects
 * whose stores live in MODULE-PRIVATE WeakMaps:
 * - authentication: kernels resolve residency through internal accessors that
 *   look the capability up in the private WeakMap — a structurally identical
 *   imposter object is rejected, not consulted;
 * - ownership: every shard typed array and the vocabulary are deep-copied at
 *   bind time, the OWNED COPY is structurally validated against the full
 *   document-index ABI, and no public API returns the resident shard — there
 *   is no supported path to its arrays outside this package's kernels.
 *
 * The internal accessors are exported from this module for sibling kernels
 * but are deliberately NOT re-exported from the package root; deep-path
 * imports are outside the supported API surface.
 */

import type { ProjectDocId } from '../contract/brands.ts';
import { hashText } from '../contract/hash.ts';
import { indexArtifactHash } from '../contract/identity.ts';
import { tokenEndChar, validateShardStructure, type DocumentIndexV1 } from '../index/build.ts';
import { validateSnapshot, type CorpusSnapshotV1 } from '../snapshot/compose.ts';

/** A typed, code-bearing dependency failure (contract WorkerErrorCode family). */
export class DependencyError extends Error {
  // Plain fields + body assignment: parameter properties are not erasable
  // syntax and would break Node's type-stripping loader (review round 2).
  readonly code = 'DEPENDENCY_MISSING';
  readonly dependency: 'shard' | 'text';
  readonly doc: string;
  constructor(dependency: 'shard' | 'text', doc: string) {
    super(`missing ${dependency} dependency for '${doc}'`);
    this.name = 'DependencyError';
    this.dependency = dependency;
    this.doc = doc;
  }
}

/** Deep copy — residency owns its arrays; the caller keeps only its own. */
function cloneShard(s: DocumentIndexV1): DocumentIndexV1 {
  return {
    schema: s.schema,
    text: s.text,
    recipe: s.recipe,
    segmenter: s.segmenter,
    tokenTypeIds: s.tokenTypeIds.slice(),
    startsUtf16: s.startsUtf16.slice(),
    lengths8: s.lengths8.slice(),
    longTokenPositions: s.longTokenPositions.slice(),
    longTokenLengths: s.longTokenLengths.slice(),
    tokenClassVersion: s.tokenClassVersion,
    tokenClasses: s.tokenClasses.slice(),
    vocabulary: [...s.vocabulary],
    postings: {
      offsets: s.postings.offsets.slice(),
      positions: s.postings.positions.slice(),
    },
    sentenceBounds: s.sentenceBounds.slice(),
    paragraphBounds: s.paragraphBounds.slice(),
  };
}

/** Minimal public capability — residency is reachable only via kernels. */
export interface BoundShards {
  readonly snapshot: CorpusSnapshotV1['id'];
  docs(): readonly string[];
}

export interface BoundTexts {
  readonly snapshot: CorpusSnapshotV1['id'];
  docs(): readonly string[];
}

const SHARD_STORES = new WeakMap<BoundShards, Map<string, DocumentIndexV1>>();
const TEXT_STORES = new WeakMap<BoundTexts, Map<string, string>>();

/** INTERNAL: eager context authentication — kernels call these at ENTRY so a
 *  forged capability is rejected even on zero-row paths (review round 5). */
export function assertBoundShards(bound: BoundShards): void {
  if (!SHARD_STORES.has(bound)) throw new RangeError('unauthenticated shard context');
}
export function assertBoundTexts(texts: BoundTexts): void {
  if (!TEXT_STORES.has(texts)) throw new RangeError('unauthenticated text context');
}

/** INTERNAL (not in the package root): authenticated residency lookup. */
export function internalShardOf(bound: BoundShards, doc: string): DocumentIndexV1 {
  const store = SHARD_STORES.get(bound);
  if (!store) throw new RangeError('unauthenticated shard context');
  const shard = store.get(doc);
  if (!shard) throw new DependencyError('shard', doc);
  return shard;
}

/** INTERNAL (not in the package root): authenticated text lookup. */
export function internalTextOf(texts: BoundTexts, doc: string): string {
  const store = TEXT_STORES.get(texts);
  if (!store) throw new RangeError('unauthenticated text context');
  const text = store.get(doc);
  if (text === undefined) throw new DependencyError('text', doc);
  return text;
}

/**
 * Verify that every supplied shard IS the artifact its snapshot ref names.
 * Every composed document must be present — a partial bind is a declared
 * dependency failure, not a silent gap. The owned copy is structurally
 * validated (full ABI: array constructors, parallel lengths, monotone
 * starts, overflow-table agreement, postings permutation, bounds sentinels)
 * BEFORE the descriptor identity is compared — descriptor identity alone is
 * not integrity (review round 4).
 */
export async function bindShards(
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<string, DocumentIndexV1>,
): Promise<BoundShards> {
  const verified = new Map<string, DocumentIndexV1>();
  for (const ref of snapshot.docs) {
    const shard = shards.get(ref.doc);
    if (!shard) throw new DependencyError('shard', ref.doc);
    // Copy first (caller-side TOCTOU), then validate the copy's structure,
    // then compare the descriptor identity.
    const owned = cloneShard(shard);
    validateShardStructure(owned);
    if ((await indexArtifactHash(owned)) !== ref.index) {
      throw new RangeError(`shard for '${ref.doc}' is not the artifact named by the snapshot`);
    }
    verified.set(ref.doc, owned);
  }
  // Cross-artifact binding (review round 6): an internally valid shard can
  // still contradict the snapshot's coordinates (token count, translation
  // lengths, canonical vocabulary merge) because the descriptor identity
  // excludes arrays. Validate the COMPLETE snapshot against the owned map.
  await validateSnapshot(snapshot, verified as unknown as ReadonlyMap<ProjectDocId, DocumentIndexV1>);
  const docList = Object.freeze([...verified.keys()]);
  const capability: BoundShards = Object.freeze({
    snapshot: snapshot.id,
    docs: () => docList,
  });
  SHARD_STORES.set(capability, verified);
  return capability;
}

/**
 * Verify each supplied text's identity against its bound shard (hash check
 * happens ONCE at residency time, not per page). Partial maps are fine —
 * materialization later demands only the docs actually on a page.
 */
export async function bindTexts(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  texts: ReadonlyMap<string, string>,
): Promise<BoundTexts> {
  if (bound.snapshot !== snapshot.id) {
    throw new RangeError('bound shards belong to a different snapshot');
  }
  assertBoundShards(bound);
  const verified = new Map<string, string>();
  for (const [doc, text] of texts) {
    const shard = internalShardOf(bound, doc);
    if ((await hashText(text)) !== shard.text) {
      throw new RangeError(`text for '${doc}' does not match the bound shard's text identity`);
    }
    // Bind resident char spans to the ACTUAL verified text extent (round 6):
    // in-domain geometry can still point past this text's end.
    const n = shard.tokenTypeIds.length;
    if (n > 0 && tokenEndChar(shard, n - 1) > text.length) {
      throw new RangeError(`resident token spans for '${doc}' exceed the verified text length`);
    }
    verified.set(doc, text);
  }
  const docList = Object.freeze([...verified.keys()]);
  const capability: BoundTexts = Object.freeze({
    snapshot: snapshot.id,
    docs: () => docList,
  });
  TEXT_STORES.set(capability, verified);
  return capability;
}
