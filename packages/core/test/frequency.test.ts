import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE, TOKEN_CLASS } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import {
  frequencyList,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_REGEX_MAX_UNITS,
  type FrequencyListRequestV1,
} from '../src/ops/frequency.ts';
import { buildStoplistRanks } from '../src/ops/stoplist.ts';
import { STOPLIST_EN_ID, STOPLIST_EN_VERSION } from '../src/ops/stoplist-contract.ts';
import { documentTermCounts } from '../src/ops/term-counts.ts';
import { segment, type SegmentationBatch } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { resolveSelection } from '../src/snapshot/selection.ts';

const GEN = 'frequency' as BuildGeneration;
const REQUEST: FrequencyListRequestV1 = {
  method: 'freq-list/2',
  filter: {
    minCount: 1,
    minDocFreq: 1,
    classes: ['lexical'],
  },
  sort: { by: 'count', dir: -1 },
  page: { offset: 0, limit: 200 },
  dispersion: true,
};

async function fixture(texts: readonly [string, string, SegmentationBatch?][]) {
  const shards = new Map<string, Awaited<ReturnType<typeof createDocumentIndex>>>();
  const ready = new Map();
  for (const [doc, text, suppliedSegmentation] of texts) {
    const shard = await createDocumentIndex(
      text,
      suppliedSegmentation ?? await segment(text, 'en'),
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
  return frequencyList(
    world.snapshot,
    selection,
    inputs,
    request,
    async () => {},
    request.filter.stoplist === undefined ? null : buildStoplistRanks(world.snapshot),
  );
}

describe('freq-list/2', () => {
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

  it('excludes punctuation-only keys from rows, totals, rates, and paging', async () => {
    const text = 'word . ! 12';
    const normal = await segment(text, 'en');
    const punctuationAdmittingBatch: SegmentationBatch = {
      ...normal,
      startsUtf16: Uint32Array.from([0, 5, 7, 9]),
      endsUtf16: Uint32Array.from([4, 6, 8, 11]),
      classes: Uint8Array.from([
        TOKEN_CLASS.lexical,
        TOKEN_CLASS.lexical,
        TOKEN_CLASS.lexical,
        TOKEN_CLASS.numeral,
      ]),
    };
    const world = await fixture([['a', text, punctuationAdmittingBatch]]);
    const result = await run(world, {
      ...REQUEST,
      filter: { ...REQUEST.filter, classes: ['lexical', 'numeral'] },
      sort: { by: 'key', dir: 1 },
      page: { offset: 0, limit: 1 },
    });

    expect(result.totalTokens).toBe(2);
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ key: '12', ratePer10k: 5_000 });
  });

  it('excludes word-like punctuation from normal segmentation but keeps punctuation within terms', async () => {
    const world = await fixture([['a', 'word ___ Ⓐ _word_ word']]);
    const result = await run(world);

    expect(result.totalTokens).toBe(3);
    expect(result.rows.map((row) => row.key)).toEqual(['word', '_word_']);
  });

  it('uses punctuation-free document sizes for multi-part dispersion', async () => {
    const world = await fixture([
      ['a', 'x x ___'],
      ['b', 'x y ___ ___ ___'],
    ]);
    const result = await run(world, {
      ...REQUEST,
      sort: { by: 'key', dir: 1 },
    });

    expect(result.totalTokens).toBe(4);
    const x = result.rows.find((row) => row.key === 'x');
    expect(x?.dp).toBeCloseTo(1 / 6, 12);
    expect(x?.dpNorm).toBeCloseTo(1 / 3, 12);
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

  it('sorts the rate and token-class columns directly', async () => {
    const world = await fixture([
      ['a', 'word word 12'],
      ['b', 'other 34'],
    ]);
    const byRate = await run(world, {
      ...REQUEST,
      filter: { ...REQUEST.filter, classes: ['lexical', 'numeral'] },
      sort: { by: 'ratePer10k', dir: 1 },
    });
    expect(byRate.rows.at(-1)?.key).toBe('word');

    const byClass = await run(world, {
      ...REQUEST,
      filter: { ...REQUEST.filter, classes: ['lexical', 'numeral'] },
      sort: { by: 'class', dir: 1 },
    });
    expect(byClass.rows.map((row) => row.class)).toEqual([
      'lexical',
      'lexical',
      'numeral',
      'numeral',
    ]);
  });

  it('sorts terms case-insensitively in lexicographic order', async () => {
    const world = await fixture([['a', 'Zulu apple Beta alpha']]);
    const ascending = await run(world, {
      ...REQUEST,
      sort: { by: 'key', dir: 1 },
    });
    expect(ascending.rows.map((row) => row.key)).toEqual([
      'alpha',
      'apple',
      'Beta',
      'Zulu',
    ]);

    const descending = await run(world, {
      ...REQUEST,
      sort: { by: 'key', dir: -1 },
    });
    expect(descending.rows.map((row) => row.key)).toEqual([
      'Zulu',
      'Beta',
      'apple',
      'alpha',
    ]);
  });

  it('applies a case-sensitive Unicode regex before paging and reports one-part dispersion honestly', async () => {
    const world = await fixture([['a', 'Alpha Alpine alpha álpha']]);
    const result = await run(world, {
      ...REQUEST,
      filter: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        regex: '^Al(?:pha|pine)$',
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

  it('removes a ranked common-word prefix without changing surviving measures', async () => {
    const world = await fixture([
      ['a', 'the The quokka quokka 12'],
      ['b', 'the quokka 12'],
    ]);
    const baseRequest: FrequencyListRequestV1 = {
      ...REQUEST,
      filter: { ...REQUEST.filter, classes: ['lexical', 'numeral'] },
      sort: { by: 'key', dir: 1 },
    };
    const unfiltered = await run(world, baseRequest);
    const filtered = await run(world, {
      ...baseRequest,
      filter: {
        ...baseRequest.filter,
        stoplist: { id: STOPLIST_EN_ID, version: STOPLIST_EN_VERSION, topN: 2 },
      },
    });
    expect(filtered.rows.map((row) => row.key)).toEqual(['12', 'quokka']);
    expect(filtered.rows).toEqual(
      unfiltered.rows.filter((row) => row.key === '12' || row.key === 'quokka'),
    );
    expect(filtered.total + filtered.stoplist!.removedRows).toBe(unfiltered.total);
    expect(filtered.totalTokens).toBe(unfiltered.totalTokens);
    expect(filtered.parts).toBe(unfiltered.parts);
    expect(filtered.stoplist).toEqual({
      id: STOPLIST_EN_ID,
      version: STOPLIST_EN_VERSION,
      topN: 2,
      removedRows: 2,
      boundaryKey: 'a',
    });
    const thresholded = await run(world, {
      ...baseRequest,
      filter: {
        ...baseRequest.filter,
        minCount: 3,
        stoplist: { id: STOPLIST_EN_ID, version: STOPLIST_EN_VERSION, topN: 2 },
      },
    });
    expect(thresholded.stoplist?.removedRows).toBe(0);
  });

  it('rejects invalid chunk/filter/regex bounds without imposing a result window', async () => {
    const world = await fixture([['a', 'one two']]);
    await expect(run(world, {
      ...REQUEST,
      page: { offset: 50_000, limit: 1 },
    })).resolves.toMatchObject({ rows: [] });
    const invalid: FrequencyListRequestV1[] = [
      { ...REQUEST, filter: { ...REQUEST.filter, minCount: 0 } },
      { ...REQUEST, filter: { ...REQUEST.filter, minDocFreq: 0 } },
      { ...REQUEST, filter: { ...REQUEST.filter, classes: [] } },
      { ...REQUEST, filter: { ...REQUEST.filter, classes: ['lexical', 'lexical'] } },
      { ...REQUEST, filter: { ...REQUEST.filter, regex: 'x'.repeat(FREQUENCY_REGEX_MAX_UNITS + 1) } },
      { ...REQUEST, filter: { ...REQUEST.filter, regex: 'e\u0301' } },
      { ...REQUEST, filter: { ...REQUEST.filter, regex: '[' } },
      { ...REQUEST, filter: {
        ...REQUEST.filter,
        stoplist: { id: STOPLIST_EN_ID, version: STOPLIST_EN_VERSION, topN: 0 },
      } },
      { ...REQUEST, page: { offset: 0, limit: FREQUENCY_PAGE_MAX + 1 } },
      { ...REQUEST, page: { offset: Number.MAX_SAFE_INTEGER, limit: 1 } },
      { ...REQUEST, sort: { by: 'dp', dir: -1 }, dispersion: false },
    ];
    for (const request of invalid) {
      await expect(run(world, request)).rejects.toThrow(RangeError);
    }
    await expect(run(world, {
      ...REQUEST,
      method: 'freq-list/1',
    } as unknown as FrequencyListRequestV1)).rejects.toThrow(RangeError);
  });
});
