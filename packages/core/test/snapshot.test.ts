import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId, StructureHash } from '../src/contract/brands.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import { segment } from '../src/segment/intl.ts';
import {
  composeSnapshot,
  makeReadyDocument,
  validateSnapshot,
  type ReadyDocument,
} from '../src/snapshot/compose.ts';
import { resolveSelection } from '../src/snapshot/selection.ts';

const GEN = 'gen-1' as BuildGeneration;

async function readyDoc(id: string, text: string): Promise<ReadyDocument> {
  const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
  return makeReadyDocument(id as ProjectDocId, shard, rootOnlyV2(text, shard.text));
}

describe('artifact identity', () => {
  it('is stable for identical inputs and differs across texts', async () => {
    const a1 = await readyDoc('a', 'the cat sat');
    const a2 = await readyDoc('a', 'the cat sat');
    const b = await readyDoc('b', 'a different text');
    expect(a1.index).toBe(a2.index);
    expect(a1.index).not.toBe(b.index);
    expect(a1.index).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('composeSnapshot determinism', () => {
  it('identical ready sets in different completion order produce identical snapshots', async () => {
    const a = await readyDoc('a', 'alpha beta gamma');
    const b = await readyDoc('b', 'beta delta');
    const expected = ['a', 'b'] as ProjectDocId[];

    const orderOne = new Map([[a.doc, a], [b.doc, b]]);
    const orderTwo = new Map([[b.doc, b], [a.doc, a]]);
    const s1 = await composeSnapshot(GEN, expected, orderOne);
    const s2 = await composeSnapshot(GEN, expected, orderTwo);
    expect(s1.id).toBe(s2.id);
    expect(s1.vocabulary.keys).toEqual(s2.vocabulary.keys);
    expect(Array.from(s1.docs[1]!.localToCorpusType)).toEqual(
      Array.from(s2.docs[1]!.localToCorpusType),
    );
  });

  it('merges vocabularies with shared keys mapped to one corpus id', async () => {
    const a = await readyDoc('a', 'alpha beta');
    const b = await readyDoc('b', 'beta gamma');
    const s = await composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], new Map([[a.doc, a], [b.doc, b]]));
    expect(s.vocabulary.keys).toEqual(['alpha', 'beta', 'gamma']);
    const aRef = s.docs[0]!;
    const bRef = s.docs[1]!;
    // 'beta' is local id 1 in doc a and local id 0 in doc b — same corpus id.
    expect(aRef.localToCorpusType[1]).toBe(bRef.localToCorpusType[0]);
  });

  it('GOLDEN merge: declared order + overlap + a missing doc pin the exact key/translation assignment', async () => {
    // Pass-2 contested-item ruling: composeSnapshot and validateSnapshot keep
    // INDEPENDENT merge implementations (the validator is the verification
    // authority); drift between them is mitigated by pinning the exact merge
    // output here, not by sharing production code. If this fails, one of the
    // two implementations changed the canonical merge — reconcile them, never
    // weaken this expectation.
    const a = await readyDoc('a', 'alpha beta');
    const c = await readyDoc('c', 'beta gamma alpha');
    // 'b' is declared but not ready — the merge must skip it and record it.
    const s = await composeSnapshot(GEN, ['a', 'b', 'c'] as ProjectDocId[], new Map([[a.doc, a], [c.doc, c]]));
    expect(s.vocabulary.keys).toEqual(['alpha', 'beta', 'gamma']); // declared-order interning
    expect(s.missingDocs).toEqual(['b']);
    expect(s.docs.map((d) => d.doc)).toEqual(['a', 'c']);
    // Exact per-doc translations: a's locals [alpha, beta] → [0, 1];
    // c's locals [beta, gamma, alpha] → [1, 2, 0].
    expect(Array.from(s.docs[0]!.localToCorpusType)).toEqual([0, 1]);
    expect(Array.from(s.docs[1]!.localToCorpusType)).toEqual([1, 2, 0]);
    // And the independent validator accepts exactly this assignment.
    await expect(
      validateSnapshot(s, new Map([[a.doc, a.shard], [c.doc, c.shard]])),
    ).resolves.toBeUndefined();
  });

  it('reordering changes only order, bases, and id — not translations', async () => {
    const a = await readyDoc('a', 'alpha beta gamma');
    const b = await readyDoc('b', 'beta delta');
    const ready = new Map([[a.doc, a], [b.doc, b]]);
    const ab = await composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], ready);
    const ba = await composeSnapshot(GEN, ['b', 'a'] as ProjectDocId[], ready);
    expect(ab.id).not.toBe(ba.id);
    expect(ab.docs[0]!.sequenceTokenBase).toBe(0);
    expect(ab.docs[1]!.sequenceTokenBase).toBe(3);
    expect(ba.docs[0]!.sequenceTokenBase).toBe(0);
    expect(ba.docs[1]!.sequenceTokenBase).toBe(2);
    // Vocabulary order differs (merge order), but every doc still resolves keys coherently.
    const keyOf = (s: typeof ab, ref: number, local: number) =>
      s.vocabulary.keys[s.docs[ref]!.localToCorpusType[local] as number];
    expect(keyOf(ab, 0, 0)).toBe('alpha');
    expect(keyOf(ba, 1, 0)).toBe('alpha');
  });

  it('a missing earlier document lands in missingDocs and later docs still compose', async () => {
    const b = await readyDoc('b', 'beta delta');
    const s = await composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], new Map([[b.doc, b]]));
    expect(s.missingDocs).toEqual(['a']);
    expect(s.docs.length).toBe(1);
    expect(s.docs[0]!.sequenceTokenBase).toBe(0);
  });

  it('empty corpus and empty documents compose', async () => {
    const empty = await composeSnapshot(GEN, [] as ProjectDocId[], new Map());
    expect(empty.docs).toEqual([]);
    expect(empty.vocabulary.keys).toEqual([]);
    const e = await readyDoc('e', '');
    const s = await composeSnapshot(GEN, ['e'] as ProjectDocId[], new Map([[e.doc, e]]));
    expect(s.docs[0]!.tokenCount).toBe(0);
  });

  it('rejects a stale/foreign index identity claim', async () => {
    const a = await readyDoc('a', 'a b');
    const grown = await createDocumentIndex('a b a', await segment('a b a', 'en'), DEFAULT_INDEX_RECIPE);
    const stale: ReadyDocument = { ...a, shard: grown }; // hash no longer matches shard
    await expect(
      composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[stale.doc, stale]])),
    ).rejects.toThrow(/stale index identity/);
  });

  it('rejects a ready record filed under a different map key', async () => {
    const b = await readyDoc('b', 'x y');
    await expect(
      composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], new Map([['a' as ProjectDocId, b]])),
    ).rejects.toThrow(/claims document id/);
  });

  it('artifact replacement changes the snapshot id', async () => {
    const v1 = await readyDoc('a', 'the cat sat');
    const v2 = await readyDoc('a', 'the cat sat down');
    const s1 = await composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[v1.doc, v1]]));
    const s2 = await composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[v2.doc, v2]]));
    expect(s1.id).not.toBe(s2.id);
  });

  it('makeReadyDocument rejects a structure for a different text', async () => {
    const shard = await createDocumentIndex('a b', await segment('a b', 'en'), DEFAULT_INDEX_RECIPE);
    const other = await createDocumentIndex('c d', await segment('c d', 'en'), DEFAULT_INDEX_RECIPE);
    await expect(
      makeReadyDocument('a' as ProjectDocId, shard, rootOnlyV2('c d', other.text)),
    ).rejects.toThrow(/different text/);
  });

  it('validateSnapshot accepts a faithful snapshot and rejects every tampered identity', async () => {
    const a = await readyDoc('a', 'alpha beta');
    const s = await composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[a.doc, a]]));
    const shards = new Map([[a.doc, a.shard]]);
    await expect(validateSnapshot(s, shards)).resolves.toBeUndefined();
    await expect(
      validateSnapshot({ ...s, docs: [{ ...s.docs[0]!, localToCorpusType: Uint32Array.from([1, 0]) }] }, shards),
    ).rejects.toThrow(/disagrees with canonical merge/);
    await expect(validateSnapshot(s, new Map())).rejects.toThrow(/missing shard/);
    await expect(
      validateSnapshot({ ...s, id: ('0'.repeat(64)) as typeof s.id }, shards),
    ).rejects.toThrow(/snapshot id disagrees/);
    await expect(
      validateSnapshot(
        { ...s, vocabulary: { ...s.vocabulary, hash: ('0'.repeat(64)) as typeof s.vocabulary.hash } },
        shards,
      ),
    ).rejects.toThrow(/vocabulary hash disagrees/);
    await expect(
      validateSnapshot({ ...s, expectedDocs: ['a', 'zz'] as ProjectDocId[] }, shards),
    ).rejects.toThrow(/complement|id disagrees/);
    await expect(
      validateSnapshot({ ...s, missingDocs: ['zz'] as ProjectDocId[] }, shards),
    ).rejects.toThrow(/complement/);
    const b = await readyDoc('b', 'other text');
    await expect(
      validateSnapshot({ ...s, docs: [{ ...s.docs[0]!, index: b.index }] }, shards),
    ).rejects.toThrow(/identity disagrees/);
  });

  it('composition rejects a forged or stale structure claim', async () => {
    const a = await readyDoc('a', 'alpha beta');
    const forged = { ...a, structure: ('0'.repeat(64)) as StructureHash };
    await expect(
      composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[forged.doc, forged]])),
    ).rejects.toThrow(/stale structure identity/);
  });

  it('resolveSelection returns the canonical contract spec; equivalent inputs are identical', async () => {
    const a = await readyDoc('a', 'alpha beta gamma delta');
    const b = await readyDoc('b', 'beta delta');
    const s = await composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], new Map([[a.doc, a], [b.doc, b]]));
    const range = (doc: string, start: number, end: number) => ({
      doc: doc as ProjectDocId,
      tokens: { start: start as never, end: end as never },
    });
    const one = await resolveSelection(s, {
      docs: ['b', 'a'] as ProjectDocId[],
      ranges: [range('b', 0, 1), range('a', 2, 4), range('a', 0, 2)],
    });
    const two = await resolveSelection(s, {
      docs: ['a', 'b'] as ProjectDocId[],
      ranges: [range('a', 0, 4), range('b', 0, 1)],
    });
    // Equivalent inputs -> the COMPLETE resolved value agrees, not just the hash.
    expect(one).toEqual(two);
    expect(one.spec.docs).toEqual(['a', 'b']);
    expect(one.spec.ranges).toEqual([range('a', 0, 4), range('b', 0, 1)]);
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(resolveSelection(s, { docs: ['zz'] as ProjectDocId[] })).rejects.toThrow(/not composed/);
    await expect(
      resolveSelection(s, { docs: ['a'] as ProjectDocId[], ranges: [range('a', 3, 99)] }),
    ).rejects.toThrow(/exceeds/);
    await expect(
      resolveSelection(s, { docs: ['a'] as ProjectDocId[], ranges: [range('a', 2, 2)] }),
    ).rejects.toThrow(/invalid range/);
  });

  it('execution indexes mirror the canonical spec and never feed the hash', async () => {
    const a = await readyDoc('a', 'alpha beta gamma delta');
    const b = await readyDoc('b', 'beta delta');
    const s = await composeSnapshot(GEN, ['a', 'b'] as ProjectDocId[], new Map([[a.doc, a], [b.doc, b]]));
    const range = (doc: string, start: number, end: number) => ({
      doc: doc as ProjectDocId,
      tokens: { start: start as never, end: end as never },
    });
    const sel = await resolveSelection(s, {
      docs: ['b', 'a'] as ProjectDocId[],
      ranges: [range('a', 2, 4), range('a', 0, 2)],
    });
    // docSet follows canonical (declared) order; rangesByDoc carries the
    // merged canonical ranges; a whole-doc selection has NO map entry.
    expect([...sel.docSet]).toEqual(['a', 'b']);
    expect(sel.rangesByDoc.get('a' as ProjectDocId)).toEqual([{ start: 0, end: 4 }]);
    expect(sel.rangesByDoc.has('b' as ProjectDocId)).toBe(false);
    // The hash is a function of `spec` ALONE — recomputing it from the spec
    // reproduces the stored hash, so the indexes cannot have widened it.
    const { sha256Hex, canonicalJson } = await import('../src/contract/hash.ts');
    const specOnly = await sha256Hex(
      canonicalJson({
        snapshot: s.id,
        docs: sel.spec.docs,
        ranges: (sel.spec.ranges ?? []).map((r) => ({ doc: r.doc, start: r.tokens.start, end: r.tokens.end })),
      }),
    );
    expect(sel.hash).toBe(specOnly);
    // And the serialized contract shape itself never mentions the indexes.
    expect(canonicalJson(sel.spec)).not.toMatch(/docSet|rangesByDoc/);
  });

  it('validateSnapshot rejects schema, missing-order, and alternative-merge tampering', async () => {
    const a = await readyDoc('a', 'alpha beta');
    const b = await readyDoc('b', 'beta gamma');
    const s = await composeSnapshot(GEN, ['a', 'b', 'c', 'd'] as ProjectDocId[], new Map([[a.doc, a], [b.doc, b]]));
    const shards = new Map([[a.doc, a.shard], [b.doc, b.shard]]);
    await expect(validateSnapshot(s, shards)).resolves.toBeUndefined();
    await expect(
      validateSnapshot({ ...s, schema: 'texttrends/corpus-snapshot/999' as never }, shards),
    ).rejects.toThrow(/unknown snapshot schema/);
    await expect(
      validateSnapshot(
        { ...s, vocabulary: { ...s.vocabulary, schema: 'texttrends/snapshot-vocabulary/999' as never } },
        shards,
      ),
    ).rejects.toThrow(/unknown vocabulary schema/);
    await expect(
      validateSnapshot({ ...s, missingDocs: ['d', 'c'] as ProjectDocId[] }, shards),
    ).rejects.toThrow(/complement/);
    await expect(
      validateSnapshot({ ...s, missingDocs: ['c', 'c', 'd'] as ProjectDocId[] }, shards),
    ).rejects.toThrow(/complement/);
    // A self-consistent ALTERNATIVE merge (reversed keys + rehashed) must be rejected.
    const reversedKeys = [...s.vocabulary.keys].reverse();
    const { sha256Hex, canonicalJson } = await import('../src/contract/hash.ts');
    const rehashed = (await sha256Hex(canonicalJson(reversedKeys))) as typeof s.vocabulary.hash;
    const flip = (arr: Uint32Array) =>
      Uint32Array.from(arr, (v) => s.vocabulary.keys.length - 1 - v);
    const tampered = {
      ...s,
      vocabulary: { ...s.vocabulary, keys: reversedKeys, hash: rehashed },
      docs: s.docs.map((r) => ({ ...r, localToCorpusType: flip(r.localToCorpusType) })),
    };
    await expect(validateSnapshot(tampered, shards)).rejects.toThrow(/canonical/);
  });

  it('rejects limits that are not valid reductions of the V1 caps', async () => {
    const a = await readyDoc('a', 'one two');
    const ready = new Map([[a.doc, a]]);
    for (const bad of [
      { maxVocabSize: Number.NaN, maxCorpusTokens: 10 },
      { maxVocabSize: 10, maxCorpusTokens: Number.POSITIVE_INFINITY },
      { maxVocabSize: 1.5, maxCorpusTokens: 10 },
      { maxVocabSize: -1, maxCorpusTokens: 10 },
      { maxVocabSize: 10, maxCorpusTokens: 2 ** 32 - 1 }, // above the V1 cap
    ]) {
      await expect(composeSnapshot(GEN, ['a'] as ProjectDocId[], ready, bad)).rejects.toThrow(/limit/);
    }
    const s = await composeSnapshot(GEN, ['a'] as ProjectDocId[], ready);
    await expect(
      validateSnapshot(s, new Map([[a.doc, a.shard]]), { maxVocabSize: Number.NaN, maxCorpusTokens: 10 }),
    ).rejects.toThrow(/limit/);
  });

  it('enforces caps in both composer and validator via injectable limits', async () => {
    const a = await readyDoc('a', 'one two three four');
    const tiny = { maxVocabSize: 2, maxCorpusTokens: 1000 };
    await expect(
      composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[a.doc, a]]), tiny),
    ).rejects.toThrow(/vocabulary exceeds/);
    const tinyTokens = { maxVocabSize: 1000, maxCorpusTokens: 2 };
    await expect(
      composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[a.doc, a]]), tinyTokens),
    ).rejects.toThrow(/corpus token cap/);
    const s = await composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[a.doc, a]]));
    const shards = new Map([[a.doc, a.shard]]);
    await expect(validateSnapshot(s, shards, tiny)).rejects.toThrow(/vocabulary exceeds/);
    await expect(validateSnapshot(s, shards, tinyTokens)).rejects.toThrow(/corpus token cap/);
  });

  it('rejects duplicate expectedDocs and unknown ready docs', async () => {
    const a = await readyDoc('a', 'x');
    await expect(
      composeSnapshot(GEN, ['a', 'a'] as ProjectDocId[], new Map([[a.doc, a]])),
    ).rejects.toThrow(/unique/);
    await expect(
      composeSnapshot(GEN, ['b'] as ProjectDocId[], new Map([[a.doc, a]])),
    ).rejects.toThrow(/not in expectedDocs/);
  });

  it('case/diacritic variants stay distinct corpus types', async () => {
    const a = await readyDoc('a', 'May may Café Cafe');
    const s = await composeSnapshot(GEN, ['a'] as ProjectDocId[], new Map([[a.doc, a]]));
    expect(s.vocabulary.keys.length).toBe(4);
  });
});
