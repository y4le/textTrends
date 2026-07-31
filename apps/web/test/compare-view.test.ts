import { describe, expect, it } from 'vitest';
import {
  compareBarPercent,
  compareRowControlId,
  compareRowForTarget,
  compareScale,
  compareSettingsControlId,
  compareSettingsError,
  compareSettingsInput,
  compareSideLabel,
  compareTarget,
  compareTargetIsStale,
  compareViewSummary,
} from '../src/lib/compare-view.ts';
import type {
  KeynessTableState,
  KeynessViewV1,
} from '../src/lib/store.ts';

const view: KeynessViewV1 = {
  schema: 'texttrends/keyness-view/1',
  mode: 'documents',
  documentA: 'a',
  documentB: 'b',
  restOn: 'b',
  minCountTotal: 5,
  minDocFreqTotal: 2,
  classes: ['lexical'],
  sort: { by: 'logRatio', dirA: -1, dirB: 1 },
  pageLimit: 100,
  offsetA: 0,
  offsetB: 100,
};

const row = {
  key: 'moor',
  typeId: 7,
  class: 'lexical' as const,
  countA: 12,
  countB: 1,
  rateAper10k: 10,
  rateBper10k: 1,
  logRatio: 3,
  g2: 4,
  rangeA: 2,
  rangeB: 1,
};

const state = (
  side: 'a' | 'b',
  status: 'pending' | 'error' | 'ready',
  rows = [row],
): KeynessTableState => ({
  snapshot: 's1',
  side,
  view,
  state: status === 'pending'
    ? { status }
    : status === 'error'
      ? { status, message: 'failed' }
      : {
          status,
          result: {
            method: 'keyness-g2-2x2/1',
            effect: 'log-ratio-halves/1',
            selectionA: 'a' as never,
            selectionB: 'b' as never,
            totalsA: { tokens: 10, documents: 1 },
            totalsB: { tokens: 10, documents: 1 },
            total: rows.length,
            rows,
          },
        },
});

describe('Compare view law', () => {
  it('totally guards settings and row targets with key-free ids', () => {
    expect(compareTarget({ surface: 'compare-settings' })).toEqual({
      surface: 'compare-settings',
    });
    expect(compareTarget({
      surface: 'compare-row',
      side: 'b',
      typeId: 7,
      key: 'moor',
    })).toEqual({
      surface: 'compare-row',
      side: 'b',
      typeId: 7,
      key: 'moor',
    });
    for (const value of [
      null,
      [],
      { surface: 'foreign' },
      { surface: 'compare-row', side: 'c', typeId: 7, key: 'x' },
      { surface: 'compare-row', side: 'a', typeId: -1, key: 'x' },
      { surface: 'compare-row', side: 'a', typeId: 1.5, key: 'x' },
      { surface: 'compare-row', side: 'a', typeId: Number.MAX_SAFE_INTEGER + 1, key: 'x' },
      { surface: 'compare-row', side: 'a', typeId: 1, key: '' },
    ]) expect(compareTarget(value)).toBeNull();
    expect(compareSettingsControlId).toBe('compare-settings');
    expect(compareRowControlId('b', 7)).toBe('compare-row-b-7');
    expect(compareRowControlId('b', 7)).not.toContain('moor');
  });

  it('retains provisional targets until a ready same-side result proves omission', () => {
    const target = {
      surface: 'compare-row' as const,
      side: 'a' as const,
      typeId: 7,
      key: 'moor',
    };
    expect(compareTargetIsStale(target, true, true, state('a', 'pending'), null))
      .toBe(false);
    expect(compareTargetIsStale(target, true, true, state('a', 'error'), null))
      .toBe(false);
    expect(compareTargetIsStale(target, true, true, state('a', 'ready'), null))
      .toBe(false);
    expect(compareTargetIsStale(target, true, true, state('a', 'ready', []), null))
      .toBe(true);
    expect(compareTargetIsStale(target, false, true, state('a', 'pending'), null))
      .toBe(true);
    expect(compareTargetIsStale(target, true, false, state('a', 'pending'), null))
      .toBe(true);
    expect(compareTargetIsStale(
      { surface: 'compare-settings' },
      true,
      true,
      state('a', 'ready', []),
      state('b', 'ready', []),
    )).toBe(false);
    expect(compareTargetIsStale(
      { surface: 'compare-settings' },
      true,
      false,
      null,
      null,
    )).toBe(true);
  });

  it('names both comparison modes and every durable setting', () => {
    const title = (doc: string) => ({ a: 'Alpha', b: 'Beta' })[doc] ?? doc;
    expect(compareSideLabel('a', view, title)).toBe('Alpha');
    expect(compareSideLabel('b', view, title)).toBe('Beta');
    const rest = { ...view, mode: 'document-rest' as const, restOn: 'b' as const };
    expect(compareSideLabel('a', rest, title)).toBe('Alpha');
    expect(compareSideLabel('b', rest, title)).toBe('all books except Alpha');
    const inverted = { ...rest, restOn: 'a' as const };
    expect(compareSideLabel('a', inverted, title)).toBe('all books except Beta');
    expect(compareSideLabel('b', inverted, title)).toBe('Beta');
    expect(compareViewSummary(view)).toBe(
      'log₂ ratio shared order · A descending · B ascending · count ≥ 5 · documents ≥ 2 · lexical · 100 rows/page',
    );
    expect(compareSettingsInput(view)).toEqual({
      minCountTotal: 5,
      minDocFreqTotal: 2,
      classes: ['lexical'],
      sortBy: 'logRatio',
      pageLimit: 100,
    });
  });

  it('validates shared settings and computes one clamped page-local scale', () => {
    const draft = compareSettingsInput(view);
    expect(compareSettingsError(draft)).toBeNull();
    expect(compareSettingsError({ ...draft, minCountTotal: Number.NaN }))
      .toMatch(/combined count/);
    expect(compareSettingsError({ ...draft, minDocFreqTotal: 0 }))
      .toMatch(/combined documents/);
    expect(compareSettingsError({ ...draft, classes: [] }))
      .toMatch(/token class/);
    expect(compareSettingsError({ ...draft, sortBy: 'foreign' as never }))
      .toMatch(/sort field/);
    expect(compareSettingsError({ ...draft, pageLimit: 201 }))
      .toMatch(/Rows per page/);

    expect(compareScale(null, null)).toEqual({ maximum: 1, provisional: false });
    expect(compareScale(state('a', 'ready'), state('b', 'pending')))
      .toEqual({ maximum: 3, provisional: true });
    const negative = { ...row, typeId: 8, key: 'Watson', logRatio: -6 };
    expect(compareScale(state('a', 'ready'), state('b', 'ready', [negative])))
      .toEqual({ maximum: 6, provisional: false });
    expect(compareBarPercent(3, 6)).toBe(25);
    expect(compareBarPercent(-9, 6)).toBe(50);
    expect(compareBarPercent(Number.NaN, 6)).toBe(0);
  });

  it('resolves a row only from its own ready side', () => {
    const target = {
      surface: 'compare-row' as const,
      side: 'a' as const,
      typeId: 7,
      key: 'moor',
    };
    expect(compareRowForTarget(target, state('a', 'ready'), null)).toEqual(row);
    expect(compareRowForTarget(target, state('a', 'pending'), state('b', 'ready')))
      .toBeNull();
  });
});
