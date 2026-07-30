/**
 * Pure notebook-panel view-model (slice-1 commit C): count qualification and
 * row projection. DOM behavior is proven in the Playwright acceptance spec.
 */
import { describe, expect, it } from 'vitest';
import { countFor, notebookRows, trendTotal } from '../src/lib/notebook-view.ts';
import { FOLDED_MATCH, type NotebookGroupV1 } from '../src/lib/notebook.ts';
import type { NumericTrend } from '@texttrends/core';
import type { SeriesTrendState } from '../src/lib/store.ts';

function fakeTrend(counts: readonly number[]): NumericTrend {
  return {
    coordinate: 'declared-sequence',
    docOrdinal: new Uint32Array(counts.length),
    binIndex: new Uint32Array(counts.length),
    binStartToken: new Uint32Array(counts.length),
    binTokens: new Uint32Array(counts.length).fill(100),
    count: new Uint32Array(counts),
    ratePer10k: new Float64Array(counts.length),
    order: ['a'],
    sequenceBases: [0],
    docTokenCount: new Uint32Array([100]),
  } as unknown as NumericTrend;
}

const g = (id: string, name: string): NotebookGroupV1 => ({
  id,
  name,
  members: [{ id: `${id}:m`, kind: 'token', surface: name, match: FOLDED_MATCH }],
  countOverlaps: false,
});

describe('countFor — explicit, never-ambiguous count states', () => {
  const ready: SeriesTrendState = { status: 'ready', trend: fakeTrend([2, 3, 0]) };

  it('not-run for unprojected groups or before any corpus, regardless of result state', () => {
    expect(countFor(false, true, ready, false)).toEqual({ kind: 'not-run' });
    expect(countFor(true, false, ready, false)).toEqual({ kind: 'not-run' });
    expect(countFor(true, true, undefined, false)).toEqual({ kind: 'not-run' });
  });

  it('pending and error are distinct states', () => {
    expect(countFor(true, true, { status: 'pending' }, false)).toEqual({ kind: 'pending' });
    expect(countFor(true, true, { status: 'error', message: 'boom' }, false))
      .toEqual({ kind: 'error', message: 'boom' });
  });

  it('ready totals sum every bin; ZERO is a real ready total, and partial corpora are labeled', () => {
    expect(countFor(true, true, ready, false)).toEqual({ kind: 'ready', total: 5, partial: false });
    expect(countFor(true, true, { status: 'ready', trend: fakeTrend([0, 0]) }, false))
      .toEqual({ kind: 'ready', total: 0, partial: false }); // zero-hit is READY, not missing
    expect(countFor(true, true, ready, true)).toEqual({ kind: 'ready', total: 5, partial: true });
  });

  it('qualifies a range count as selected over the intact corpus total', () => {
    expect(countFor(
      true,
      true,
      ready,
      false,
      { status: 'ready', trend: fakeTrend([1, 2]) },
      true,
    )).toEqual({
      kind: 'selected',
      total: 5,
      partial: false,
      selected: { kind: 'ready', total: 3 },
    });
    expect(countFor(true, true, ready, false, { status: 'pending' }, true))
      .toEqual({ kind: 'selected', total: 5, partial: false, selected: { kind: 'pending' } });
    expect(countFor(
      true,
      true,
      ready,
      false,
      { status: 'error', message: 'selected query failed' },
      true,
    )).toEqual({
      kind: 'selected',
      total: 5,
      partial: false,
      selected: { kind: 'error', message: 'selected query failed' },
    });
  });

  it('trendTotal sums the count array exactly', () => {
    expect(trendTotal(fakeTrend([1, 2, 3, 4]))).toBe(10);
    expect(trendTotal(fakeTrend([]))).toBe(0);
  });
});

describe('notebookRows — projection flags', () => {
  it('marks active/solo/projected/slot per group; solo dims every other row', () => {
    const rows = notebookRows({
      groups: [g('a', 'wolf'), g('b', 'bear'), g('c', 'fox')],
      activeGroupIds: new Set(['a', 'b']),
      soloGroupId: 'b',
      styleSlots: new Map([['a', 0], ['b', 1]]),
      trends: new Map([['b', { status: 'pending' }]]),
      hasSnapshot: true,
      partialCorpus: false,
    });
    expect(rows.map((r) => ({ id: r.id, active: r.active, solo: r.solo, projected: r.projected, slot: r.slot }))).toEqual([
      { id: 'a', active: true, solo: false, projected: false, slot: 0 }, // solo'd out
      { id: 'b', active: true, solo: true, projected: true, slot: 1 },
      { id: 'c', active: false, solo: false, projected: false, slot: null }, // muted
    ]);
    expect(rows[0]!.count).toEqual({ kind: 'not-run' }); // solo'd out ⇒ not in the comparison
    expect(rows[1]!.count).toEqual({ kind: 'pending' });
  });
});
