import { describe, expect, it } from 'vitest';
import { dp, dpNorm, g2Keyness, logDice, logRatio, mattr, mtld, pmi, tScore } from '../src/index.ts';

// Published-value fixtures from docs/design/statistics.md — each vector is
// hand-computed there and verified numerically; these tests pin the formulas.

describe('keyness', () => {
  it('g2Keyness computes the full 2×2 likelihood ratio (not the two-cell shorthand)', () => {
    expect(g2Keyness(10, 1000, 2, 2000)).toBeCloseTo(12.8349, 3);
  });

  it('g2Keyness is signed by direction', () => {
    expect(g2Keyness(2, 2000, 10, 1000)).toBeCloseTo(-12.8349, 3);
  });

  it('g2Keyness is 0 for identical relative frequencies', () => {
    expect(g2Keyness(10, 1000, 20, 2000)).toBeCloseTo(0, 9);
  });

  it('logRatio applies 0.5 correction on all four cells (totals N+1)', () => {
    expect(logRatio(10, 1000, 2, 2000)).toBeCloseTo(3.0697, 3);
  });

  it('logRatio handles zero counts via the correction', () => {
    expect(Number.isFinite(logRatio(0, 1000, 5, 1000))).toBe(true);
    expect(logRatio(0, 1000, 5, 1000)).toBeLessThan(0);
  });
});

describe('collocation (unit event space)', () => {
  it('logDice matches the fixture and hits exactly 14 at perfect association', () => {
    expect(logDice(5, 20, 30)).toBeCloseTo(11.6781, 3);
    expect(logDice(10, 10, 10)).toBeCloseTo(14, 9);
  });

  it('rejects fxy exceeding a marginal — the case pair-counting produced', () => {
    expect(() => logDice(2, 1, 2)).toThrow(RangeError);
  });

  it('PMI matches the spec vector', () => {
    expect(pmi(4, 10, 20, 1000)).toBeCloseTo(4.3219, 3);
  });

  it('t-score matches the spec vector', () => {
    expect(tScore(4, 10, 20, 1000)).toBeCloseTo(1.9, 4);
  });

  it('rejects non-integer or inconsistent unit counts', () => {
    expect(() => pmi(1.5, 10, 20, 1000)).toThrow(RangeError);
    expect(() => pmi(4, 10, 2000, 1000)).toThrow(RangeError);
  });
});

describe('dispersion', () => {
  it('DP is 2/3 and DPnorm exactly 1 for a fully clumped term over 3 equal parts', () => {
    expect(dp([9, 0, 0], [100, 100, 100])).toBeCloseTo(2 / 3, 9);
    expect(dpNorm([9, 0, 0], [100, 100, 100])).toBeCloseTo(1, 9);
  });

  it('DP is 0 for a perfectly even term', () => {
    expect(dp([3, 3, 3], [100, 100, 100])).toBeCloseTo(0, 9);
    expect(dpNorm([3, 3, 3], [100, 100, 100])).toBeCloseTo(0, 9);
  });

  it('rejects mismatched, empty, or one-part inputs', () => {
    expect(() => dp([1], [1, 2])).toThrow(RangeError);
    expect(() => dp([0, 0], [1, 1])).toThrow(RangeError);
    expect(() => dpNorm([3], [100])).toThrow(RangeError); // one part: min share = 1 → 0/0
  });
});

describe('diversity', () => {
  it('MATTR window 3 over "a b a b" is exactly 2/3', () => {
    expect(mattr(['a', 'b', 'a', 'b'], 3)).toBeCloseTo(2 / 3, 9);
  });

  it('MATTR falls back to plain TTR for short sequences', () => {
    expect(mattr(['a', 'b', 'a'], 500)).toBeCloseTo(2 / 3, 9);
  });

  it('MATTR of an all-distinct sequence is 1', () => {
    expect(mattr(['a', 'b', 'c', 'd', 'e'], 2)).toBeCloseTo(1, 9);
  });

  it('rejects invalid method parameters', () => {
    expect(() => mattr(['a', 'b'], 2.5)).toThrow(RangeError);   // fractional window
    expect(() => mattr(['a', 'b'], 0)).toThrow(RangeError);
    expect(() => mtld(['a', 'b'], 1.2)).toThrow(RangeError);    // threshold outside (0,1)
    expect(() => mtld(['a', 'b'], 0)).toThrow(RangeError);
  });

  it('MTLD of an all-distinct sequence equals its length (no full factor completes)', () => {
    // TTR never drops below 0.72, so the whole text is one partial factor of 0 —
    // by the spec the value is N/((1-1)/(1-0.72)) guarded to N when factors = 0.
    expect(mtld(['a', 'b', 'c', 'd'])).toBe(4);
  });

  it('MTLD counts factors on a constructed repetitive sequence', () => {
    // "a a a a": after token 2 TTR = 0.5 < 0.72 -> factor, reset; repeats.
    // Forward: factors at positions 2 and 4 => 2 factors exactly, no partial.
    // Backward identical. MTLD = 4/2 = 2.
    expect(mtld(['a', 'a', 'a', 'a'])).toBe(2);
  });
});
