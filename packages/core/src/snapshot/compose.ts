/**
 * Corpus snapshot composition — Phase 1 plan, Milestone 1.
 *
 * Snapshots are immutable compositions of validated ready documents in
 * DECLARED order. Vocabulary merge and local→corpus translations are built
 * eagerly and deterministically at composition time — identical ready sets
 * produce identical snapshots regardless of completion timing. Reordering
 * or artifact replacement produces a new snapshot; nothing is mutated.
 *
 * Identity discipline (review finding): ready records are created only by
 * the async factory below, which computes the index/structure hashes from
 * the artifacts themselves; composition re-verifies every binding (map key,
 * document id, recomputed index hash) so a stale or foreign identity claim
 * can never be hashed into a snapshot ID.
 */

import {
  CapError,
  V1_CAPS,
  type CorpusSnapshotId,
  type BuildGeneration,
  type IndexArtifactHash,
  type ProjectDocId,
  type StructureHash,
} from '../contract/brands.ts';
import { canonicalJson, sha256Hex } from '../contract/hash.ts';
import {
  indexArtifactHash,
  structureHash,
  type StructureArtifactV1,
} from '../contract/identity.ts';
import type { DocumentIndexV1 } from '../index/build.ts';

declare const brand: unique symbol;
export type SnapshotVocabularyHash = string & { readonly [brand]: 'SnapshotVocabularyHash' };

/** A validated, identity-bearing document ready for composition. */
export interface ReadyDocument {
  readonly doc: ProjectDocId;
  readonly shard: DocumentIndexV1;
  /** The structure artifact itself — composition re-verifies its binding. */
  readonly structureArtifact: StructureArtifactV1;
  readonly index: IndexArtifactHash;
  readonly structure: StructureHash;
}

/**
 * The only sanctioned way to build a ReadyDocument: hashes are computed from
 * the artifacts, and the structure artifact must describe the shard's text.
 */
export async function makeReadyDocument(
  doc: ProjectDocId,
  shard: DocumentIndexV1,
  structure: StructureArtifactV1,
): Promise<ReadyDocument> {
  if (structure.text !== shard.text) {
    throw new RangeError('structure artifact describes a different text than the shard');
  }
  return {
    doc,
    shard,
    structureArtifact: structure,
    index: await indexArtifactHash(shard),
    structure: await structureHash(structure),
  };
}

export interface SnapshotVocabularyV1 {
  readonly schema: 'texttrends/snapshot-vocabulary/1';
  /** CorpusTypeId -> case-bearing key, in deterministic declared-merge order. */
  readonly keys: readonly string[];
  readonly hash: SnapshotVocabularyHash;
}

export interface CorpusDocRef {
  readonly doc: ProjectDocId;
  readonly index: IndexArtifactHash;
  readonly structure: StructureHash;
  readonly localToCorpusType: Uint32Array;
  readonly sequenceTokenBase: number;
  readonly tokenCount: number;
}

export interface CorpusSnapshotV1 {
  readonly schema: 'texttrends/corpus-snapshot/1';
  readonly id: CorpusSnapshotId;
  readonly generation: BuildGeneration;
  readonly expectedDocs: readonly ProjectDocId[];
  readonly docs: readonly CorpusDocRef[];
  readonly missingDocs: readonly ProjectDocId[];
  readonly vocabulary: SnapshotVocabularyV1;
}

async function snapshotId(
  generation: BuildGeneration,
  expectedDocs: readonly ProjectDocId[],
  refs: readonly CorpusDocRef[],
  vocabularyHash: SnapshotVocabularyHash,
): Promise<CorpusSnapshotId> {
  return (await sha256Hex(
    canonicalJson({
      schema: 'texttrends/corpus-snapshot/1',
      generation,
      expectedDocs,
      docs: refs.map((r) => ({
        doc: r.doc,
        index: r.index,
        structure: r.structure,
        base: r.sequenceTokenBase,
        tokens: r.tokenCount,
      })),
      vocabulary: vocabularyHash,
    }),
  )) as CorpusSnapshotId;
}

export interface SnapshotLimits {
  readonly maxVocabSize: number;
  readonly maxCorpusTokens: number;
}
const DEFAULT_LIMITS: SnapshotLimits = {
  maxVocabSize: V1_CAPS.maxVocabSize,
  maxCorpusTokens: V1_CAPS.maxCorpusTokens,
};

/**
 * Limits may only REDUCE the hard V1 caps (a bounded-fixture seam, never a
 * cap-escalation mechanism — round-4 review finding: NaN/Infinity would
 * silently disable every cap comparison).
 */
function checkLimits(limits: SnapshotLimits): void {
  const pairs: readonly [number, number][] = [
    [limits.maxVocabSize, V1_CAPS.maxVocabSize],
    [limits.maxCorpusTokens, V1_CAPS.maxCorpusTokens],
  ];
  for (const [value, cap] of pairs) {
    if (!Number.isInteger(value) || value < 0 || value > cap) {
      throw new RangeError(`snapshot limit ${value} must be an integer in [0, ${cap}]`);
    }
  }
}

export async function composeSnapshot(
  generation: BuildGeneration,
  expectedDocs: readonly ProjectDocId[],
  ready: ReadonlyMap<ProjectDocId, ReadyDocument>,
  limits: SnapshotLimits = DEFAULT_LIMITS,
): Promise<CorpusSnapshotV1> {
  checkLimits(limits);
  if (new Set(expectedDocs).size !== expectedDocs.length) {
    throw new RangeError('expectedDocs must be unique');
  }
  for (const [key, item] of ready) {
    if (!expectedDocs.includes(key)) {
      throw new RangeError(`ready document '${key}' is not in expectedDocs`);
    }
    if (item.doc !== key) {
      throw new RangeError(`ready record for '${key}' claims document id '${item.doc}'`);
    }
    // Re-verify every identity claim against the artifacts actually being
    // composed — a stale or foreign hash must never enter the snapshot ID
    // (review findings, rounds 1-2).
    const recomputedIndex = await indexArtifactHash(item.shard);
    if (recomputedIndex !== item.index) {
      throw new RangeError(`ready record for '${key}' carries a stale index identity`);
    }
    if (item.structureArtifact.text !== item.shard.text) {
      throw new RangeError(`structure artifact for '${key}' describes a different text`);
    }
    const recomputedStructure = await structureHash(item.structureArtifact);
    if (recomputedStructure !== item.structure) {
      throw new RangeError(`ready record for '${key}' carries a stale structure identity`);
    }
  }

  const keys: string[] = [];
  const keyToCorpusId = new Map<string, number>();
  const refs: CorpusDocRef[] = [];
  const missing: ProjectDocId[] = [];
  let sequenceBase = 0;

  // Declared order, never ready-map insertion order (determinism contract).
  for (const doc of expectedDocs) {
    const item = ready.get(doc);
    if (!item) {
      missing.push(doc);
      continue;
    }
    const vocab = item.shard.vocabulary;
    const localToCorpusType = new Uint32Array(vocab.length);
    for (let local = 0; local < vocab.length; local++) {
      const key = vocab[local] as string;
      let corpus = keyToCorpusId.get(key);
      if (corpus === undefined) {
        corpus = keys.length;
        if (corpus >= limits.maxVocabSize) {
          throw new CapError('snapshot vocabulary exceeds v1 cap');
        }
        keyToCorpusId.set(key, corpus);
        keys.push(key);
      }
      localToCorpusType[local] = corpus;
    }
    const tokenCount = item.shard.tokenTypeIds.length;
    if (sequenceBase + tokenCount > limits.maxCorpusTokens) {
      throw new CapError('snapshot exceeds v1 corpus token cap');
    }
    refs.push({
      doc,
      index: item.index,
      structure: item.structure,
      localToCorpusType,
      sequenceTokenBase: sequenceBase,
      tokenCount,
    });
    sequenceBase += tokenCount;
  }

  const vocabularyHash = (await sha256Hex(canonicalJson(keys))) as SnapshotVocabularyHash;
  const id = await snapshotId(generation, expectedDocs, refs, vocabularyHash);

  return {
    schema: 'texttrends/corpus-snapshot/1',
    id,
    generation,
    expectedDocs,
    docs: refs,
    missingDocs: missing,
    vocabulary: { schema: 'texttrends/snapshot-vocabulary/1', keys, hash: vocabularyHash },
  };
}

/**
 * Runtime validation for a snapshot against its resident shards — used when
 * artifacts are loaded rather than freshly composed (plan Milestone 1).
 * Validates the FULL identity: recomputed vocabulary hash and snapshot id,
 * per-doc index identity against the resident shard, membership/set
 * invariants (uniqueness, declared order, exact missing complement), and
 * every structural translation invariant (round-2 review finding).
 */
export async function validateSnapshot(
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<ProjectDocId, DocumentIndexV1>,
  limits: SnapshotLimits = DEFAULT_LIMITS,
): Promise<void> {
  checkLimits(limits);
  if (snapshot.schema !== 'texttrends/corpus-snapshot/1') {
    throw new RangeError(`unknown snapshot schema '${snapshot.schema}'`);
  }
  if (snapshot.vocabulary.schema !== 'texttrends/snapshot-vocabulary/1') {
    throw new RangeError(`unknown vocabulary schema '${snapshot.vocabulary.schema}'`);
  }
  if (new Set(snapshot.expectedDocs).size !== snapshot.expectedDocs.length) {
    throw new RangeError('expectedDocs must be unique');
  }
  const composedDocs = snapshot.docs.map((r) => r.doc);
  if (new Set(composedDocs).size !== composedDocs.length) {
    throw new RangeError('composed docs must be unique');
  }
  // docs must be expectedDocs-in-declared-order minus exactly missingDocs, and
  // missingDocs itself must be the declared-order, duplicate-free complement
  // (round-3 finding: a Set comparison silently forgave order/duplicates).
  const composedSet = new Set(composedDocs);
  const expectedMissing = snapshot.expectedDocs.filter((d) => !composedSet.has(d));
  if (
    snapshot.missingDocs.length !== expectedMissing.length ||
    snapshot.missingDocs.some((d, i) => d !== expectedMissing[i])
  ) {
    throw new RangeError('missingDocs is not the declared-order exact complement');
  }
  const derived = snapshot.expectedDocs.filter((d) => composedSet.has(d));
  if (derived.length !== composedDocs.length || derived.some((d, i) => d !== composedDocs[i])) {
    throw new RangeError('docs are not in declared expectedDocs order');
  }

  // Rebuild the CANONICAL declared-order vocabulary merge from the resident
  // shards and require exact agreement — a self-consistent alternative
  // assignment must be rejected, not just an inconsistent one (round-3 finding).
  const expectedKeys: string[] = [];
  const keyToCorpusId = new Map<string, number>();
  let base = 0;
  for (const ref of snapshot.docs) {
    const shard = shards.get(ref.doc);
    if (!shard) throw new RangeError(`snapshot references missing shard '${ref.doc}'`);
    if ((await indexArtifactHash(shard)) !== ref.index) {
      throw new RangeError(`resident shard identity disagrees with snapshot ref for '${ref.doc}'`);
    }
    if (ref.localToCorpusType.length !== shard.vocabulary.length) {
      throw new RangeError(`translation length disagrees with shard vocabulary for '${ref.doc}'`);
    }
    if (ref.tokenCount !== shard.tokenTypeIds.length) {
      throw new RangeError(`token count disagrees with shard for '${ref.doc}'`);
    }
    if (ref.sequenceTokenBase !== base) {
      throw new RangeError(`sequence base out of order at '${ref.doc}'`);
    }
    base += ref.tokenCount;
    if (base > limits.maxCorpusTokens) {
      throw new CapError('snapshot exceeds v1 corpus token cap');
    }
    for (let local = 0; local < shard.vocabulary.length; local++) {
      const key = shard.vocabulary[local] as string;
      let corpus = keyToCorpusId.get(key);
      if (corpus === undefined) {
        corpus = expectedKeys.length;
        if (corpus >= limits.maxVocabSize) {
          throw new CapError('snapshot vocabulary exceeds v1 cap');
        }
        keyToCorpusId.set(key, corpus);
        expectedKeys.push(key);
      }
      if (ref.localToCorpusType[local] !== corpus) {
        throw new RangeError(`translation disagrees with canonical merge for '${ref.doc}' at local ${local}`);
      }
    }
  }
  if (
    snapshot.vocabulary.keys.length !== expectedKeys.length ||
    expectedKeys.some((k, i) => snapshot.vocabulary.keys[i] !== k)
  ) {
    throw new RangeError('vocabulary keys disagree with the canonical declared-order merge');
  }

  const vocabularyHash = (await sha256Hex(
    canonicalJson(snapshot.vocabulary.keys),
  )) as SnapshotVocabularyHash;
  if (vocabularyHash !== snapshot.vocabulary.hash) {
    throw new RangeError('vocabulary hash disagrees with vocabulary keys');
  }
  const id = await snapshotId(snapshot.generation, snapshot.expectedDocs, snapshot.docs, vocabularyHash);
  if (id !== snapshot.id) {
    throw new RangeError('snapshot id disagrees with snapshot content');
  }
}
