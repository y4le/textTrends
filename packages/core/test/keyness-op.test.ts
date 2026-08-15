import { describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import {
  firstSelectionOverlap,
  keyness,
  type KeynessTableRequestV1,
} from '../src/ops/keyness.ts';
import {
  type InventoryDocumentInputV1,
} from '../src/ops/inventory.ts';
import { documentTermCounts } from '../src/ops/term-counts.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import {
  resolveSelection,
  type ResolvedSelection,
} from '../src/snapshot/selection.ts';

const GEN = 'keyness' as BuildGeneration;
const REQUEST: KeynessTableRequestV1 = {
  method: 'keyness-g2-2x2/1',
  effect: 'log-ratio-halves/1',
  filter: {
    minCountTotal: 1,
    minDocFreqTotal: 1,
    classes: ['lexical'],
  },
  sort: { by: 'logRatio', dir: -1 },
  page: { offset: 0, limit: 200 },
  side: 'both',
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

function inputsFor(
  world: Awaited<ReturnType<typeof fixture>>,
  selection: ResolvedSelection,
): InventoryDocumentInputV1[] {
  return selection.spec.docs.map((doc) => {
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
}

describe('keyness-g2-2x2/1', () => {
  it('computes counts, rates, effect, evidence, ranges, and side projections', async () => {
    const world = await fixture([
      ['a', 'apple apple apple apple common common common common common common'],
      ['b', 'apple common common common common common common common common common'],
    ]);
    const a = await resolveSelection(world.snapshot, {
      docs: ['a' as ProjectDocId],
    });
    const b = await resolveSelection(world.snapshot, {
      docs: ['b' as ProjectDocId],
    });
    const both = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    expect(both.selectionA).toBe(a.hash);
    expect(both.selectionB).toBe(b.hash);
    expect(both.totalsA).toEqual({ tokens: 10, documents: 1, positiveParts: 1 });
    expect(both.totalsB).toEqual({ tokens: 10, documents: 1, positiveParts: 1 });
    expect(both.rows.map((row) => row.key)).toEqual(['apple', 'common']);
    const apple = both.rows[0]!;
    expect(apple).toMatchObject({
      countA: 4,
      countB: 1,
      rateAper10k: 4_000,
      rateBper10k: 1_000,
      rangeA: 1,
      rangeB: 1,
    });
    expect(apple.logRatio).toBeGreaterThan(0);
    expect(apple.g2).toBeGreaterThan(0);

    const aOnly = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      { ...REQUEST, side: 'a' },
      async () => {},
    );
    expect(aOnly.rows.map((row) => row.key)).toEqual(['apple']);
    const bOnly = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      { ...REQUEST, side: 'b', sort: { by: 'logRatio', dir: 1 } },
      async () => {},
    );
    expect(bOnly.rows.map((row) => row.key)).toEqual(['common']);
  });

  it('inverts effect and evidence exactly when the sides swap', async () => {
    const world = await fixture([
      ['a', 'x x x y'],
      ['b', 'x z z z'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const ab = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    const ba = await keyness(
      world.snapshot,
      b,
      a,
      inputsFor(world, b),
      inputsFor(world, a),
      REQUEST,
      async () => {},
    );
    const abByKey = new Map(ab.rows.map((row) => [row.key, row]));
    for (const row of ba.rows) {
      const inverse = abByKey.get(row.key)!;
      expect(row.logRatio).toBeCloseTo(-inverse.logRatio, 12);
      expect(row.g2).toBeCloseTo(-inverse.g2, 12);
      expect(row.countA).toBe(inverse.countB);
      expect(row.countB).toBe(inverse.countA);
    }
  });

  it('rejects overlapping sides by document while allowing touching ranges', async () => {
    const world = await fixture([['a', 'one two three four five six']]);
    const whole = await resolveSelection(world.snapshot, {
      docs: ['a' as ProjectDocId],
    });
    const left = await resolveSelection(world.snapshot, {
      docs: ['a' as ProjectDocId],
      ranges: [{
        doc: 'a' as ProjectDocId,
        tokens: { start: 0 as never, end: 3 as never },
      }],
    });
    const right = await resolveSelection(world.snapshot, {
      docs: ['a' as ProjectDocId],
      ranges: [{
        doc: 'a' as ProjectDocId,
        tokens: { start: 3 as never, end: 6 as never },
      }],
    });
    expect(firstSelectionOverlap(world.snapshot, whole, left)).toBe('a');
    expect(firstSelectionOverlap(world.snapshot, left, right)).toBeNull();
    await expect(keyness(
      world.snapshot,
      whole,
      left,
      inputsFor(world, whole),
      inputsFor(world, left),
      REQUEST,
      async () => {},
    )).rejects.toThrow(/overlap.*'a'/);
    await expect(keyness(
      world.snapshot,
      left,
      right,
      inputsFor(world, left),
      inputsFor(world, right),
      REQUEST,
      async () => {},
    )).resolves.toMatchObject({
      totalsA: { tokens: 3 },
      totalsB: { tokens: 3 },
    });
  });

  it('filters before deterministic paging, checkpoints, and rejects empty class totals', async () => {
    const world = await fixture([
      ['a', 'alpha beta gamma 12'],
      ['b', 'delta epsilon zeta 34'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const checkpoint = vi.fn(async () => {});
    const result = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      {
        ...REQUEST,
        sort: { by: 'countA', dir: -1 },
        page: { offset: 1, limit: 2 },
      },
      checkpoint,
    );
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(2);
    expect(checkpoint).toHaveBeenCalled();

    await expect(keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      {
        ...REQUEST,
        filter: {
          ...REQUEST.filter,
          classes: ['numeral'],
          minCountTotal: 1,
          minDocFreqTotal: 1,
        },
      },
      async () => {},
    )).resolves.toMatchObject({ totalsA: { tokens: 1 }, totalsB: { tokens: 1 } });

    const noNumerals = await fixture([
      ['a', 'alpha beta'],
      ['b', 'gamma delta'],
    ]);
    const na = await resolveSelection(noNumerals.snapshot, { docs: ['a' as ProjectDocId] });
    const nb = await resolveSelection(noNumerals.snapshot, { docs: ['b' as ProjectDocId] });
    await expect(keyness(
      noNumerals.snapshot,
      na,
      nb,
      inputsFor(noNumerals, na),
      inputsFor(noNumerals, nb),
      { ...REQUEST, filter: { ...REQUEST.filter, classes: ['numeral'] } },
      async () => {},
    )).rejects.toThrow(/class-filtered tokens/);
  });

  it('uses signed evidence, combined count, then corpus type id as forced ties', async () => {
    const world = await fixture([
      ['a', 'x y'],
      ['b', 'z w'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const result = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    expect(result.rows.map((row) => row.key)).toEqual(['x', 'y', 'z', 'w']);
    expect(result.rows.every((row) =>
      Number.isFinite(row.logRatio) && Number.isFinite(row.g2))).toBe(true);

    const signedWorld = await fixture([
      ['a', 'positive negative fill fill fill fill fill fill fill fill'],
      ['b', 'negative negative negative negative negative other other other other other'],
    ]);
    const signedA = await resolveSelection(signedWorld.snapshot, {
      docs: ['a' as ProjectDocId],
    });
    const signedB = await resolveSelection(signedWorld.snapshot, {
      docs: ['b' as ProjectDocId],
    });
    const signed = await keyness(
      signedWorld.snapshot,
      signedA,
      signedB,
      inputsFor(signedWorld, signedA),
      inputsFor(signedWorld, signedB),
      { ...REQUEST, sort: { by: 'countA', dir: -1 } },
      async () => {},
    );
    const positive = signed.rows.findIndex((row) => row.key === 'positive');
    const negative = signed.rows.findIndex((row) => row.key === 'negative');
    expect(signed.rows[positive]!.countA).toBe(signed.rows[negative]!.countA);
    expect(signed.rows[positive]!.g2).toBeGreaterThan(0);
    expect(signed.rows[negative]!.g2).toBeLessThan(0);
    expect(Math.abs(signed.rows[negative]!.g2))
      .toBeGreaterThan(Math.abs(signed.rows[positive]!.g2));
    expect(positive).toBeLessThan(negative);
  });

  it('applies each combined minimum before ranking and paging', async () => {
    const world = await fixture([
      ['a', 'apple apple rare'],
      ['b', 'apple other'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const run = (minCountTotal: number, minDocFreqTotal: number) => keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      {
        ...REQUEST,
        filter: {
          ...REQUEST.filter,
          minCountTotal,
          minDocFreqTotal,
        },
      },
      async () => {},
    );
    await expect(run(3, 1)).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ key: 'apple', countA: 2, countB: 1 })],
    });
    await expect(run(1, 2)).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ key: 'apple', rangeA: 1, rangeB: 1 })],
    });
  });

  it('rejects malformed table policy before scanning either side', async () => {
    const world = await fixture([
      ['a', 'one two'],
      ['b', 'three four'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const checkpoint = vi.fn(async () => {});
    await expect(keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      {
        ...REQUEST,
        filter: { ...REQUEST.filter, classes: [] },
      },
      checkpoint,
    )).rejects.toThrow(/classes/);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

describe('keyness-g2-2x2/1 divergence and dispersion', () => {
  it('measures whole-distribution divergence independently of filter and paging', async () => {
    const world = await fixture([
      ['a', 'alpha alpha alpha alpha'],
      ['b', 'beta beta beta beta'],
      ['c', 'alpha alpha beta beta'],
      ['d', 'alpha alpha beta beta'],
    ]);
    const run = async (
      left: string,
      right: string,
      request: KeynessTableRequestV1 = REQUEST,
    ) => {
      const a = await resolveSelection(world.snapshot, { docs: [left as ProjectDocId] });
      const b = await resolveSelection(world.snapshot, { docs: [right as ProjectDocId] });
      return keyness(
        world.snapshot,
        a,
        b,
        inputsFor(world, a),
        inputsFor(world, b),
        request,
        async () => {},
      );
    };

    const disjoint = await run('a', 'b');
    expect(disjoint.divergence).toEqual({ method: 'jsd-log2/1', bits: 1, types: 2 });

    const identical = await run('c', 'd');
    expect(identical.divergence.method).toBe('jsd-log2/1');
    expect(identical.divergence.bits).toBeCloseTo(0, 12);
    expect(identical.divergence.types).toBe(2);

    // A filter that hides every row leaves the divergence untouched: it
    // describes the distributions, not the visible table.
    const filtered = await run('a', 'b', {
      ...REQUEST,
      filter: { ...REQUEST.filter, minCountTotal: 1_000 },
    });
    expect(filtered.rows).toEqual([]);
    expect(filtered.total).toBe(0);
    expect(filtered.divergence).toEqual(disjoint.divergence);

    // Side projection hides half the rows and likewise cannot move it.
    const projected = await run('a', 'b', { ...REQUEST, side: 'a' });
    expect(projected.divergence).toEqual(disjoint.divergence);
  });

  it('folds Gries DP per side, and reports null where dispersion is undefined', async () => {
    const world = await fixture([
      ['a1', 'clump clump clump clump clump spread spread spread spread spread'],
      ['a2', 'other other other other other spread spread spread spread spread'],
      ['b', 'clump spread other filler filler filler filler filler filler filler'],
    ]);
    const a = await resolveSelection(world.snapshot, {
      docs: ['a1' as ProjectDocId, 'a2' as ProjectDocId],
    });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const result = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    expect(result.totalsA).toEqual({ tokens: 20, documents: 2, positiveParts: 2 });
    expect(result.totalsB).toEqual({ tokens: 10, documents: 1, positiveParts: 1 });

    const byKey = new Map(result.rows.map((row) => [row.key, row]));
    // Equal-sized parts: 'spread' splits 5/5 across them, 'clump' sits wholly
    // in one. Same side total for 'spread' (10) as 'clump' + 'other' (5 each),
    // so only dispersion distinguishes them.
    expect(byKey.get('spread')!.dpA).toBeCloseTo(0, 12);
    expect(byKey.get('clump')!.dpA).toBeCloseTo(0.5, 12);
    expect(byKey.get('other')!.dpA).toBeCloseTo(0.5, 12);
    // A single-document side has no between-document dispersion to report.
    for (const row of result.rows) expect(row.dpB).toBeNull();
    // 'filler' never occurs on side A, so its side-A dispersion is undefined.
    expect(byKey.get('filler')!.dpA).toBeNull();
  });

  it('distinguishes selected documents from positive class-filtered parts', async () => {
    const world = await fixture([
      ['a1', '123 456'],
      ['a2', 'alpha alpha'],
      ['b', 'beta beta'],
    ]);
    const a = await resolveSelection(world.snapshot, {
      docs: ['a1' as ProjectDocId, 'a2' as ProjectDocId],
    });
    const b = await resolveSelection(world.snapshot, {
      docs: ['b' as ProjectDocId],
    });
    const result = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    expect(result.totalsA).toEqual({
      tokens: 2,
      documents: 2,
      positiveParts: 1,
    });
    for (const row of result.rows) expect(row.dpA).toBeNull();
  });

  it('restricts divergence and its type domain to the selected classes', async () => {
    const world = await fixture([
      ['a', 'shared shared 111 111'],
      ['b', 'shared shared 222 222'],
    ]);
    const a = await resolveSelection(world.snapshot, {
      docs: ['a' as ProjectDocId],
    });
    const b = await resolveSelection(world.snapshot, {
      docs: ['b' as ProjectDocId],
    });
    const run = (classes: KeynessTableRequestV1['filter']['classes']) => keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      { ...REQUEST, filter: { ...REQUEST.filter, classes } },
      async () => {},
    );
    const lexical = await run(['lexical']);
    expect(lexical.divergence.bits).toBeCloseTo(0, 12);
    expect(lexical.divergence.types).toBe(1);
    const numeral = await run(['numeral']);
    expect(numeral.divergence).toEqual({
      method: 'jsd-log2/1',
      bits: 1,
      types: 2,
    });
  });

  it('carries a 95% interval that brackets every published effect size', async () => {
    const world = await fixture([
      ['a', 'apple apple apple apple common common common common common common'],
      ['b', 'apple common common common common common common common common common'],
    ]);
    const a = await resolveSelection(world.snapshot, { docs: ['a' as ProjectDocId] });
    const b = await resolveSelection(world.snapshot, { docs: ['b' as ProjectDocId] });
    const result = await keyness(
      world.snapshot,
      a,
      b,
      inputsFor(world, a),
      inputsFor(world, b),
      REQUEST,
      async () => {},
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.logRatioLow).toBeLessThan(row.logRatio);
      expect(row.logRatioHigh).toBeGreaterThan(row.logRatio);
      expect(row.logRatio - row.logRatioLow).toBeCloseTo(
        row.logRatioHigh - row.logRatio,
        12,
      );
    }
  });
});
