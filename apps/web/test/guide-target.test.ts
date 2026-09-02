import type {
  DispersionGeometryV1,
  DispersionResultV1,
  DispersionTrackV1,
} from '@texttrends/core';
import { describe, expect, it } from 'vitest';
import { barcodeTracks } from '../src/lib/barcode-view.ts';
import {
  resolveGuideTarget,
  type GuideTargetInput,
  type GuideTermFacts,
} from '../src/lib/guide/target.ts';

const TERMS: readonly GuideTermFacts[] = [
  { seriesId: 'alpha', label: 'Alpha' },
  { seriesId: 'beta', label: 'Beta' },
];

function exactTrack(
  seriesId: string,
  offsets: readonly number[],
  starts: readonly number[],
  total = starts.length,
): DispersionTrackV1 {
  return {
    seriesId,
    groupId: `${seriesId}-group`,
    total,
    data: {
      kind: 'exact',
      docOffsets: Uint32Array.from(offsets),
      starts: Uint32Array.from(starts),
      spanTokens: Uint32Array.from(starts, () => 1),
    },
  };
}

function geometry(
  order: readonly string[],
  extents: readonly number[],
  offsets: readonly number[],
  starts: readonly number[],
): DispersionGeometryV1 {
  return {
    order,
    docTokenCount: Uint32Array.from(extents),
    bucketOffsets: Uint32Array.from(offsets),
    bucketStartToken: Uint32Array.from(starts),
  };
}

function densityTrack(
  seriesId: string,
  counts: readonly number[],
  total = counts.reduce((sum, count) => sum + count, 0),
): DispersionTrackV1 {
  return {
    seriesId,
    groupId: `${seriesId}-group`,
    total,
    data: { kind: 'density', counts: Uint32Array.from(counts) },
  };
}

function result(
  tracks: readonly DispersionTrackV1[],
  sharedGeometry: DispersionGeometryV1 | null = null,
): DispersionResultV1 {
  return { method: 'dispersion/1', geometry: sharedGeometry, tracks };
}

function input({
  docs = ['a', 'b', 'c'],
  extents = { a: 10, b: 20, c: 30 },
  terms = TERMS,
  dispersion = result([exactTrack('alpha', [0, 1, 1, 3], [1, 3, 16])]),
  snapshotId = 'snapshot-1',
  dispersionSnapshotId = snapshotId ?? 'snapshot-1',
  status = 'ready',
}: {
  readonly docs?: readonly string[];
  readonly extents?: Readonly<Record<string, number | undefined>>;
  readonly terms?: readonly GuideTermFacts[];
  readonly dispersion?: DispersionResultV1;
  readonly snapshotId?: string | null;
  readonly dispersionSnapshotId?: string;
  readonly status?: 'pending' | 'ready' | 'error';
} = {}): GuideTargetInput {
  return {
    snapshotId,
    readyDocs: docs,
    shownTerms: terms,
    dispersion: status === 'pending'
      ? { snapshotId: dispersionSnapshotId, state: { status: 'pending' } }
      : status === 'error'
        ? {
            snapshotId: dispersionSnapshotId,
            state: { status: 'error', message: 'worker failed' },
          }
        : {
            snapshotId: dispersionSnapshotId,
            state: { status: 'ready', result: dispersion },
          },
    tokenCountOf: (doc) => extents[doc],
  };
}

describe('resolveGuideTarget prerequisites', () => {
  it('distinguishes missing corpus, term, work, supersession, and failure', () => {
    expect(resolveGuideTarget(input({ snapshotId: null, docs: [] })))
      .toEqual({ status: 'unavailable', reason: 'no-corpus' });
    expect(resolveGuideTarget(input({ terms: [] })))
      .toEqual({ status: 'unavailable', reason: 'no-shown-term' });
    expect(resolveGuideTarget({ ...input(), dispersion: null }))
      .toEqual({ status: 'pending', reason: 'dispersion' });
    expect(resolveGuideTarget(input({ status: 'pending' })))
      .toEqual({ status: 'pending', reason: 'dispersion' });
    expect(resolveGuideTarget(input({ dispersionSnapshotId: 'older' })))
      .toEqual({ status: 'pending', reason: 'superseded' });
    expect(resolveGuideTarget(input({ status: 'error' })))
      .toEqual({ status: 'unavailable', reason: 'failed' });
  });

  it('reports zero shown-track occurrences and ignores a foreign track', () => {
    expect(resolveGuideTarget(input({
      dispersion: result([
        exactTrack('foreign', [0, 0, 0, 1], [2]),
        exactTrack('alpha', [0, 0, 0, 0], []),
      ]),
    }))).toEqual({ status: 'unavailable', reason: 'no-occurrences' });
  });
});

describe('resolveGuideTarget exact tracks', () => {
  it('chooses the midpoint-nearest occurrence in the longest text with a hit', () => {
    const resolved = resolveGuideTarget(input({
      dispersion: result([exactTrack('alpha', [0, 1, 1, 3], [1, 3, 16])]),
    }));
    expect(resolved).toEqual({
      status: 'ready',
      target: {
        kind: 'exact',
        seriesId: 'alpha',
        label: 'Alpha',
        doc: 'c',
        token: 16,
        intent: {
          snapshot: 'snapshot-1',
          doc: 'c',
          token: 16,
          from: 'barcode',
          anchor: 'occurrence',
        },
      },
    });
  });

  it('breaks equal totals by notebook order rather than result order', () => {
    const resolved = resolveGuideTarget(input({
      terms: [TERMS[1]!, TERMS[0]!],
      dispersion: result([
        exactTrack('alpha', [0, 1, 1, 1], [1]),
        exactTrack('beta', [0, 0, 1, 1], [9]),
      ]),
    }));
    expect(resolved.status === 'ready' && resolved.target.seriesId).toBe('beta');
  });

  it('breaks equal midpoint distance toward the lower token', () => {
    const resolved = resolveGuideTarget(input({
      docs: ['a'],
      extents: { a: 10 },
      dispersion: result([exactTrack('alpha', [0, 2], [4, 6])]),
    }));
    expect(resolved.status === 'ready' && resolved.target.token).toBe(4);
  });

  it('skips a longer text with no occurrence', () => {
    const resolved = resolveGuideTarget(input({
      docs: ['long', 'hit'],
      extents: { long: 100, hit: 40 },
      dispersion: result([exactTrack('alpha', [0, 0, 1], [19])]),
    }));
    expect(resolved.status === 'ready' && resolved.target.doc).toBe('hit');
  });

  it('waits when every occurrence-bearing text lacks an extent', () => {
    expect(resolveGuideTarget(input({ extents: {} })))
      .toEqual({ status: 'pending', reason: 'extents' });
  });

  it('makes exact representation beat a much larger density track', () => {
    const shared = geometry(['a', 'b', 'c'], [10, 20, 30], [0, 1, 2, 3], [0, 0, 0]);
    const resolved = resolveGuideTarget(input({
      dispersion: result([
        densityTrack('alpha', [300_000, 300_000, 300_000]),
        exactTrack('beta', [0, 0, 1, 3], [10, 14, 16]),
      ], shared),
    }));
    expect(resolved.status === 'ready' && resolved.target.kind).toBe('exact');
    expect(resolved.status === 'ready' && resolved.target.seriesId).toBe('beta');
  });

  it('rejects a broken CSR result instead of guessing', () => {
    expect(resolveGuideTarget(input({
      dispersion: result([exactTrack('alpha', [0, 1], [1])]),
    }))).toEqual({ status: 'unavailable', reason: 'failed' });
  });

  it('agrees with the shipped barcode tick projection', () => {
    const packed = result([exactTrack('alpha', [0, 1, 1, 3], [1, 3, 16])]);
    const resolved = resolveGuideTarget(input({ dispersion: packed }));
    const tick = barcodeTracks(packed, ['a', 'b', 'c'])[0]!.segmentsByDocOrdinal[2]!
      .find((segment) => segment.kind === 'tick' && segment.t0 === 16);
    expect(tick?.kind === 'tick' ? tick.t0 : null)
      .toBe(resolved.status === 'ready' ? resolved.target.token : null);
  });
});

describe('resolveGuideTarget density tracks', () => {
  it('chooses the midpoint-nearest nonzero bucket in the longest text', () => {
    const shared = geometry(['a', 'b'], [10, 20], [0, 2, 4], [0, 5, 0, 10]);
    const resolved = resolveGuideTarget(input({
      docs: ['a', 'b'],
      extents: { a: 10, b: 20 },
      dispersion: result([densityTrack('alpha', [0, 1, 1, 2])], shared),
    }));
    expect(resolved).toMatchObject({
      status: 'ready',
      target: {
        kind: 'density',
        doc: 'b',
        token: 5,
        bucketCount: 1,
        intent: { anchor: 'position', from: 'barcode' },
      },
    });
  });

  it('ends a document’s final bucket at its own token extent', () => {
    const shared = geometry(['a', 'b'], [9, 100], [0, 2, 3], [0, 4, 0]);
    const resolved = resolveGuideTarget(input({
      docs: ['a', 'b'],
      extents: { a: 9, b: 100 },
      dispersion: result([densityTrack('alpha', [0, 2, 0])], shared),
    }));
    expect(resolved.status === 'ready' && resolved.target.token).toBe(6);
  });

  it('rejects density without valid shared geometry', () => {
    expect(resolveGuideTarget(input({
      dispersion: result([densityTrack('alpha', [1])]),
    }))).toEqual({ status: 'unavailable', reason: 'failed' });
  });

  it('rejects a density axis that differs from ready-text order', () => {
    const shared = geometry(['b', 'a', 'c'], [20, 10, 30], [0, 1, 2, 3], [0, 0, 0]);
    expect(resolveGuideTarget(input({
      dispersion: result([densityTrack('alpha', [1, 0, 0])], shared),
    }))).toEqual({ status: 'unavailable', reason: 'failed' });
  });

  it('agrees with barcode-view midpoint arithmetic', () => {
    const shared = geometry(['a', 'b'], [9, 100], [0, 2, 3], [0, 4, 0]);
    const packed = result([densityTrack('alpha', [0, 2, 0])], shared);
    const resolved = resolveGuideTarget(input({
      docs: ['a', 'b'],
      extents: { a: 9, b: 100 },
      dispersion: packed,
    }));
    const cell = barcodeTracks(packed, ['a', 'b'])[0]!.segments.find(
      (segment) => segment.kind === 'cell' && segment.count === 2,
    );
    expect(cell?.kind === 'cell' ? cell.midToken : null)
      .toBe(resolved.status === 'ready' ? resolved.target.token : null);
  });
});
