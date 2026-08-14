import { describe, expect, it } from 'vitest';
import { pendingAnalysisCount } from '../src/lib/pending-analyses.ts';

describe('pendingAnalysisCount', () => {
  it('counts an independent full-corpus baseline while a range result is ready', () => {
    expect(pendingAnalysisCount({
      inventory: { status: 'ready' },
      corpusInventory: { status: 'pending' },
      other: [],
      maps: [],
    })).toBe(1);
  });

  it('does not double-count the shared inventory object outside a range', () => {
    const pending = { status: 'pending' };
    expect(pendingAnalysisCount({
      inventory: pending,
      corpusInventory: pending,
      other: [],
      maps: [],
    })).toBe(1);
  });

  it('includes other direct and mapped analysis intents', () => {
    expect(pendingAnalysisCount({
      inventory: null,
      corpusInventory: null,
      other: [{ status: 'pending' }, { status: 'ready' }],
      maps: [new Map([
        ['a', { status: 'pending' }],
        ['b', { status: 'error' }],
      ])],
    })).toBe(2);
  });
});
