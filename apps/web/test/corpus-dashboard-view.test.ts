import { describe, expect, it } from 'vitest';
import {
  frequencyFilterError,
  frequencyPageView,
  rhythmBinsForDocument,
  rhythmDescription,
} from '../src/lib/corpus-dashboard-view.ts';

describe('corpus dashboard view model', () => {
  it('selects rhythm bins by snapshot document ordinal and describes empty bins honestly', () => {
    const bins = rhythmBinsForDocument({
      binsPerDoc: 2,
      docOrdinal: Uint32Array.from([0, 0, 1, 1]),
      binIndex: Uint32Array.from([0, 1, 0, 1]),
      binStartToken: Uint32Array.from([0, 10, 0, 8]),
      binTokens: Uint32Array.from([10, 0, 8, 2]),
      sentences: Uint32Array.from([2, 0, 1, 1]),
      sentenceMean: Float64Array.from([5, Number.NaN, 8, 2]),
      sentenceMedian: Float64Array.from([5, Number.NaN, 8, 2]),
    }, 0);
    expect(bins).toEqual([
      { mean: 5, tokens: 10, sentences: 2 },
      { mean: Number.NaN, tokens: 0, sentences: 0 },
    ]);
    expect(rhythmDescription(bins, (value) => Number.isFinite(value) ? String(value) : '—'))
      .toBe('bin 1: 2 sentences, mean 5, 10 selected tokens; bin 2: 0 sentences, mean —, 0 selected tokens');
  });

  it('validates integer filter drafts before a no-op store action', () => {
    expect(frequencyFilterError(Number.NaN, 1)).toMatch(/Minimum count/);
    expect(frequencyFilterError(1, 0)).toMatch(/Minimum documents/);
    expect(frequencyFilterError(2, 3)).toBeNull();
  });

  it('labels empty and populated pages and stops with disclosure at the 5,000-row window', () => {
    expect(frequencyPageView(0, 0, 100, 0)).toEqual({
      label: '0 rows',
      canNext: false,
      atWindow: false,
    });
    expect(frequencyPageView(10_000, 4_800, 200, 200)).toEqual({
      label: 'rows 4,801–5,000',
      canNext: false,
      atWindow: true,
    });
    expect(frequencyPageView(450, 200, 200, 200)).toEqual({
      label: 'rows 201–400',
      canNext: true,
      atWindow: false,
    });
  });
});
