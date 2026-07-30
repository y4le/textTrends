import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import {
  frequencyList,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_WINDOW_MAX,
  type FrequencyListRequestV1,
} from '../src/ops/frequency.ts';
import { documentTermCounts } from '../src/ops/term-counts.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { resolveSelection } from '../src/snapshot/selection.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';

const GEN = 'frequency' as BuildGeneration;
const REQUEST: FrequencyListRequestV1 = {
  method: 'freq-list/1',
  filter: {
    minCount: 1,
    minDocFreq: 1,
    classes: ['lexical'],
  },
  sort: { by: 'count', dir: -1 },
  page: { offset: 0, limit: 200 },
  dispersion: true,
};

async function fixture(texts: readonly [string, string][]) {
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
        rootOnlyV2(text, shard.text),
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

async function run(
  world: Awaited<ReturnType<typeof fixture>>,
  request: FrequencyListRequestV1 = REQUEST,
  docs = world.snapshot.docs.map((ref) => ref.doc),
) {
  const selection = await resolveSelection(world.snapshot, { docs });
  const inputs = selection.spec.docs.map((doc) => {
    const ref = world.snapshot.docs.find((candidate) => candidate.doc === doc)!;
    const shard = world.shards.get(doc)!;
    return {
      ref,
      shard,
      counts: documentTermCounts(
        world.snapshot,
        ref,
        shard,
        selection.rangesByDoc.get(doc) ?? null,
      ),
    };
  });
  return frequencyList(world.snapshot, selection, inputs, request, async () => {});
}

describe('freq-list/1', () => {
  it('matches hand-computed counts, document frequency, rates, DP, and DPnorm', async () => {
    const world = await fixture([
      ['a', 'x x x y'],
      ['b', 'x z z z'],
    ]);
    const result = await run(world);
    expect(result.totalTokens).toBe(8);
    expect(result.parts).toBe(2);
    expect(result.rows.map((row) => row.key)).toEqual(['x', 'z', 'y']);
    expect(result.rows[0]).toMatchObject({
      key: 'x',
      count: 4,
      docFreq: 2,
      ratePer10k: 5_000,
      dp: 0.25,
      dpNorm: 0.5,
    });
    expect(result.rows[1]).toMatchObject({
      key: 'z',
      count: 3,
      docFreq: 1,
      dp: 0.5,
      dpNorm: 1,
    });
  });

  it('uses class-filtered denominators and filters before stable paging', async () => {
    const world = await fixture([
      ['a', 'word 12 word 34'],
      ['b', 'word 12 other 56'],
    ]);
    const numerals = await run(world, {
      ...REQUEST,
      filter: { minCount: 1, minDocFreq: 1, classes: ['numeral'] },
      sort: { by: 'key', dir: 1 },
      page: { offset: 1, limit: 2 },
      dispersion: false,
    });
    expect(numerals.totalTokens).toBe(4);
    expect(numerals.total).toBe(3);
    expect(numerals.rows.map((row) => row.key)).toEqual(['34', '56']);
    expect(numerals.rows.every((row) => row.class === 'numeral')).toBe(true);
    expect(numerals.rows.every((row) => row.dp === null && row.dpNorm === null)).toBe(true);

    const filtered = await run(world, {
      ...REQUEST,
      filter: { minCount: 2, minDocFreq: 2, classes: ['lexical'] },
      page: { offset: 0, limit: 1 },
    });
    expect(filtered.total).toBe(1);
    expect(filtered.rows.map((row) => row.key)).toEqual(['word']);
  });

  it('pins deterministic ties to count descending then corpus type id', async () => {
    const world = await fixture([
      ['a', 'root alpha beta'],
      ['b', 'root gamma delta'],
    ]);
    const result = await run(world, {
      ...REQUEST,
      sort: { by: 'docFreq', dir: 1 },
    });
    // All singleton rows tie at df=1,count=1, so declared corpus type order wins.
    expect(result.rows.slice(0, 4).map((row) => row.key)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
    ]);
    expect(result.rows.at(-1)?.key).toBe('root'); // df=2 sorts last ascending
  });

  it('applies a sensitive NFC prefix and reports one-part dispersion honestly', async () => {
    const world = await fixture([['a', 'Alpha Alpine alpha álpha']]);
    const result = await run(world, {
      ...REQUEST,
      filter: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        prefixNfc: 'Al',
      },
    });
    expect(result.rows.map((row) => row.key)).toEqual(['Alpha', 'Alpine']);
    expect(result.rows.every((row) => row.dp === 0 && row.dpNorm === null)).toBe(true);
  });

  it('includes zero-token selected parts in the published DPnorm denominator', async () => {
    const world = await fixture([
      ['a', '12 12'],
      ['b', '34'],
      ['c', 'word'],
    ]);
    const result = await run(world, {
      ...REQUEST,
      filter: { minCount: 1, minDocFreq: 1, classes: ['numeral'] },
      sort: { by: 'key', dir: 1 },
    });
    expect(result.parts).toBe(3);
    expect(result.rows.map((row) => row.key)).toEqual(['12', '34']);
    expect(result.rows[0]!.dp).toBeCloseTo(1 / 3, 12);
    expect(result.rows[0]!.dpNorm).toBeCloseTo(1 / 3, 12);
    expect(result.rows[1]!.dp).toBeCloseTo(2 / 3, 12);
    expect(result.rows[1]!.dpNorm).toBeCloseTo(2 / 3, 12);
  });

  it('rejects all paging/filter/prefix bounds', async () => {
    const world = await fixture([['a', 'one two']]);
    const invalid: FrequencyListRequestV1[] = [
      { ...REQUEST, filter: { ...REQUEST.filter, minCount: 0 } },
      { ...REQUEST, filter: { ...REQUEST.filter, minDocFreq: 0 } },
      { ...REQUEST, filter: { ...REQUEST.filter, classes: [] } },
      { ...REQUEST, filter: { ...REQUEST.filter, classes: ['lexical', 'lexical'] } },
      { ...REQUEST, filter: { ...REQUEST.filter, prefixNfc: 'x'.repeat(FREQUENCY_PREFIX_MAX_UNITS + 1) } },
      { ...REQUEST, filter: { ...REQUEST.filter, prefixNfc: 'e\u0301' } },
      { ...REQUEST, page: { offset: 0, limit: FREQUENCY_PAGE_MAX + 1 } },
      { ...REQUEST, page: { offset: FREQUENCY_WINDOW_MAX, limit: 1 } },
      { ...REQUEST, sort: { by: 'dp', dir: -1 }, dispersion: false },
    ];
    for (const request of invalid) {
      await expect(run(world, request)).rejects.toThrow(RangeError);
    }
  });
});
