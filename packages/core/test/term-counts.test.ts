import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE, TOKEN_CLASS } from '../src/contract/recipes.ts';
import { createDocumentIndex, validateShardStructure } from '../src/index/build.ts';
import { documentTermCounts, termCountRangeKey } from '../src/ops/term-counts.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { resolveSelection } from '../src/snapshot/selection.ts';

const GEN = 'term-counts' as BuildGeneration;

async function corpus(texts: readonly [string, string][]) {
  const shards = new Map<string, Awaited<ReturnType<typeof createDocumentIndex>>>();
  const ready = new Map();
  for (const [doc, text] of texts) {
    const shard = await createDocumentIndex(
      text,
      await segment(text, 'en'),
      DEFAULT_INDEX_RECIPE,
    );
    shards.set(doc, shard);
    ready.set(
      doc as ProjectDocId,
      await makeReadyDocument(
        doc as ProjectDocId,
        shard,
      ),
    );
  }
  const snapshot = await composeSnapshot(
    GEN,
    texts.map(([doc]) => doc as ProjectDocId),
    ready,
  );
  return { snapshot, shards };
}

function keyed(
  snapshot: Awaited<ReturnType<typeof composeSnapshot>>,
  value: ReturnType<typeof documentTermCounts>,
): Record<string, number> {
  return Object.fromEntries(
    Array.from(value.typeIds, (id, i) => [
      snapshot.vocabulary.keys[id] as string,
      value.counts[i] as number,
    ]),
  );
}

describe('documentTermCounts', () => {
  it('uses posting-run counts for a whole document and reports class totals', async () => {
    const { snapshot, shards } = await corpus([
      ['a', 'alpha 12 beta alpha 12 gamma'],
    ]);
    const ref = snapshot.docs[0]!;
    const result = documentTermCounts(snapshot, ref, shards.get('a')!, null);
    expect(result.rangeKey).toBe('*');
    expect(result.tokens).toBe(6);
    expect(result.lexicalTokens).toBe(4);
    expect(result.numeralTokens).toBe(2);
    expect(keyed(snapshot, result)).toEqual({
      '12': 2,
      alpha: 2,
      beta: 1,
      gamma: 1,
    });
  });

  it('matches an independent ranged token scan and uses the canonical range key', async () => {
    const { snapshot, shards } = await corpus([
      ['a', 'alpha 12 beta alpha 12 gamma'],
    ]);
    const selection = await resolveSelection(snapshot, {
      docs: ['a' as ProjectDocId],
      ranges: [
        { doc: 'a' as ProjectDocId, tokens: { start: 1 as never, end: 4 as never } },
      ],
    });
    const ranges = selection.rangesByDoc.get('a' as ProjectDocId)!;
    const result = documentTermCounts(
      snapshot,
      snapshot.docs[0]!,
      shards.get('a')!,
      ranges,
    );
    expect(result.rangeKey).toBe('[[1,4]]');
    expect(result.tokens).toBe(3);
    expect(result.lexicalTokens).toBe(2);
    expect(result.numeralTokens).toBe(1);
    expect(keyed(snapshot, result)).toEqual({ '12': 1, alpha: 1, beta: 1 });
  });

  it('sorts by corpus type id even when a document-local vocabulary is reversed', async () => {
    const { snapshot, shards } = await corpus([
      ['a', 'zeta alpha'],
      ['b', 'alpha alpha zeta'],
    ]);
    const ref = snapshot.docs[1]!;
    expect([...ref.localToCorpusType]).toEqual([1, 0]);
    const result = documentTermCounts(snapshot, ref, shards.get('b')!, null);
    expect([...result.typeIds]).toEqual([0, 1]);
    expect([...result.counts]).toEqual([1, 2]);
    expect(keyed(snapshot, result)).toEqual({ zeta: 1, alpha: 2 });
  });

  it('refuses noncanonical ranges and a foreign snapshot ref', async () => {
    const { snapshot, shards } = await corpus([['a', 'one two three four']]);
    const ref = snapshot.docs[0]!;
    const shard = shards.get('a')!;
    expect(() => termCountRangeKey([], ref.tokenCount)).toThrow(/nonempty/);
    expect(() => termCountRangeKey([{ start: 0, end: 2 }, { start: 2, end: 3 }], ref.tokenCount))
      .toThrow(/non-adjacent/);
    expect(() => documentTermCounts(
      snapshot,
      { ...ref, localToCorpusType: ref.localToCorpusType.slice() },
      shard,
      null,
    )).toThrow(/resident ref/);
  });

  it('pins the per-type class invariant that makes whole-doc counting O(vocabulary)', async () => {
    const { shards } = await corpus([['a', 'same same']]);
    const shard = shards.get('a')!;
    const corrupt = {
      ...shard,
      tokenClasses: shard.tokenClasses.slice(),
    };
    corrupt.tokenClasses[1] = TOKEN_CLASS.numeral;
    expect(() => validateShardStructure(corrupt)).toThrow(/mixes token classes/);

    const { shards: twoTypeShards } = await corpus([['a', 'same other']]);
    const twoTypeShard = twoTypeShards.get('a')!;
    const emptyRun = {
      ...twoTypeShard,
      postings: {
        offsets: twoTypeShard.postings.offsets.slice(),
        positions: twoTypeShard.postings.positions,
      },
    };
    emptyRun.postings.offsets[1] = 0;
    expect(() => validateShardStructure(emptyRun)).toThrow(/empty posting run/);
  });
});
