import { describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import {
  tfidfSections,
  TFIDF_MAX_MIN_SECTION_TOKENS,
  TFIDF_MAX_SECTIONS,
  TFIDF_MAX_TOP_K,
  type TfidfSectionInputV1,
} from '../src/ops/tfidf-sections.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';

const GEN = 'tfidf' as BuildGeneration;

async function fixture() {
  const doc = 'a' as ProjectDocId;
  const text = [
    'common common apple apple pear',
    'common common banana banana pear',
    'shortonly',
  ].join(' ');
  const shard = await createDocumentIndex(
    text,
    await segment(text, 'en'),
    DEFAULT_INDEX_RECIPE,
  );
  const ready = await makeReadyDocument(doc, shard, rootOnlyV2(text, shard.text));
  const snapshot = await composeSnapshot(GEN, [doc], new Map([[doc, ready]]));
  const sections: TfidfSectionInputV1[] = [
    { id: 's1', doc, level: 1, title: 'One', tokens: { start: 0, end: 5 } },
    { id: 's2', doc, level: 1, title: 'Two', tokens: { start: 5, end: 10 } },
    { id: 'short', doc, level: 1, title: 'Short', tokens: { start: 10, end: 11 } },
    { id: 'deeper', doc, level: 2, title: 'Deep', tokens: { start: 0, end: 2 } },
  ];
  return { doc, shard, snapshot, ref: snapshot.docs[0]!, sections };
}

describe('tfidf-sections/1', () => {
  it('matches the specified formula and excludes short sections from N and df', async () => {
    const world = await fixture();
    const result = await tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: 5,
        topK: 5,
      },
      async () => {},
    );
    expect(result.eligibleSections).toBe(2);
    expect(result.sections).toHaveLength(3);
    expect(result.sections[2]).toMatchObject({
      id: 'short',
      eligible: false,
      labels: [],
    });
    expect(result.sections[0]!.labels.map((label) => label.key)).toEqual(['apple']);
    expect(result.sections[0]!.labels[0]).toMatchObject({
      count: 2,
      weight: 2 * Math.log(2),
    });
    expect(result.sections[1]!.labels.map((label) => label.key)).toEqual(['banana']);
    // `common` and `pear` occur in both eligible sections: df=N, weight=0,
    // so the v1 method needs no stop list.
    expect(result.sections.flatMap((section) => section.labels).map((label) => label.key))
      .not.toContain('common');
    expect(result.sections.flatMap((section) => section.labels).map((label) => label.key))
      .not.toContain('pear');
  });

  it('breaks equal-weight/equal-frequency ties by corpus type id', async () => {
    const world = await fixture();
    // In s1, apple and pear both occur only there after clipping s2 to omit
    // pear; each has raw f=1 on this range, so corpus type order decides.
    const sections: TfidfSectionInputV1[] = [
      { id: 's1', doc: world.doc, level: 1, tokens: { start: 3, end: 5 } },
      { id: 's2', doc: world.doc, level: 1, tokens: { start: 5, end: 9 } },
    ];
    const result = await tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: 1,
        topK: 10,
      },
      async () => {},
    );
    // Equal weight and raw frequency: declared corpus type order wins.
    expect(result.sections[0]!.labels.map((label) => label.key)).toEqual(['apple', 'pear']);
  });

  it('returns an honest one-eligible-section state with no zero-weight labels', async () => {
    const world = await fixture();
    const result = await tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 2,
        minSectionTokens: 1,
        topK: 5,
      },
      async () => {},
    );
    expect(result.eligibleSections).toBe(1);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.labels).toEqual([]);
  });

  it('checkpoints and rejects caps, invalid levels, and foreign documents', async () => {
    const world = await fixture();
    const checkpoint = vi.fn(async () => {});
    await tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: 1,
        topK: 1,
      },
      checkpoint,
    );
    expect(checkpoint).toHaveBeenCalled();

    await expect(tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: TFIDF_MAX_MIN_SECTION_TOKENS + 1,
        topK: 1,
      },
      async () => {},
    )).rejects.toThrow(RangeError);
    await expect(tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: 1,
        topK: TFIDF_MAX_TOP_K + 1,
      },
      async () => {},
    )).rejects.toThrow(RangeError);
    await expect(tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      Array.from(
        { length: TFIDF_MAX_SECTIONS + 1 },
        (_, i) => ({ id: `s${i}`, doc: world.doc, level: 1, tokens: { start: 0, end: 1 } }),
      ),
      {
        method: 'tfidf-sections/1',
        doc: world.doc,
        level: 1,
        minSectionTokens: 1,
        topK: 1,
      },
      async () => {},
    )).rejects.toThrow(/sections exceed/);
    await expect(tfidfSections(
      world.snapshot,
      world.ref,
      world.shard,
      world.sections,
      {
        method: 'tfidf-sections/1',
        doc: 'foreign',
        level: 1,
        minSectionTokens: 1,
        topK: 1,
      },
      async () => {},
    )).rejects.toThrow(/outside/);
  });
});
