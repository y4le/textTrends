import { describe, expect, it } from 'vitest';
import { automatedReadabilityIndex, colemanLiauIndex, dp, dpNorm, g2Keyness, jensenShannon, jsdContribution, logDice, logRatio, logRatioInterval, LOG_RATIO_Z_95, MATTR_MAX_TYPES, mattr, mattrIds, mtld, pmi, tScore } from '../src/index.ts';

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

  it('rejects malformed 2×2 scalar inputs before calculating either method', () => {
    for (const args of [
      [1.5, 10, 1, 10],
      [1, 0, 1, 10],
      [1, 10, 1, 0],
      [-1, 10, 1, 10],
      [11, 10, 1, 10],
      [1, 10, 11, 10],
      [1, Number.POSITIVE_INFINITY, 1, 10],
    ] as readonly (readonly [number, number, number, number])[]) {
      expect(() => g2Keyness(...args)).toThrow(RangeError);
      expect(() => logRatio(...args)).toThrow(RangeError);
    }
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

  it('numeric MATTR shares the string semantics without materializing keys', () => {
    expect(mattrIds(Uint32Array.from([7, 9, 7, 9]), 3)).toBeCloseTo(2 / 3, 9);
    expect(mattrIds(Uint32Array.from([100, 100, 200]), 10)).toBeCloseTo(2 / 3, 9);
    expect(mattrIds(new Uint32Array(), 3)).toBe(0);
  });

  it('numeric MATTR rejects invalid ids and sparse ArrayLikes', () => {
    expect(() => mattrIds([0, -1], 2)).toThrow(RangeError);
    expect(() => mattrIds([0, 1.5], 2)).toThrow(RangeError);
    expect(() => mattrIds({ 0: 0, length: 2 }, 2)).toThrow(RangeError);
    expect(() => mattrIds([MATTR_MAX_TYPES], 1)).toThrow(RangeError);
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

describe('log-ratio confidence interval', () => {
  it('brackets the point estimate symmetrically in log₂ units', () => {
    const interval = logRatioInterval(10, 1000, 2, 2000);
    const centre = logRatio(10, 1000, 2, 2000);
    expect(interval.low).toBeCloseTo(1.0828, 3);
    expect(interval.high).toBeCloseTo(5.0565, 3);
    expect(interval.centre).toBeCloseTo(centre, 12);
    expect(centre - interval.low).toBeCloseTo(interval.high - centre, 12);
    expect(interval.z).toBeCloseTo(LOG_RATIO_Z_95, 12);
  });

  it('separates a thin effect from a thick one at the same effect size', () => {
    // Both sit near +2.8..+3.9 log₂, and only the interval tells them apart:
    // 3-vs-0 cannot exclude "no difference", 3000-vs-200 easily can.
    const thin = logRatioInterval(3, 1000, 0, 1000);
    const thick = logRatioInterval(3000, 100_000, 200, 100_000);
    expect(thin.low).toBeLessThan(0);
    expect(thin.high).toBeGreaterThan(0);
    expect(thick.low).toBeCloseTo(3.6977, 3);
    expect(thick.high).toBeCloseTo(4.1094, 3);
    expect(thick.high - thick.low).toBeLessThan(thin.high - thin.low);
  });

  it('rejects a malformed table or quantile before calculating', () => {
    expect(() => logRatioInterval(11, 10, 1, 10)).toThrow(RangeError);
    expect(() => logRatioInterval(1, 10, 1, 10, 0)).toThrow(RangeError);
    expect(() => logRatioInterval(1, 10, 1, 10, Number.NaN)).toThrow(RangeError);
  });

  it('scales the half-width with a caller-supplied positive quantile', () => {
    const standard = logRatioInterval(10, 1_000, 2, 2_000);
    const doubled = logRatioInterval(10, 1_000, 2, 2_000, 2 * LOG_RATIO_Z_95);
    expect(doubled.high - doubled.centre).toBeCloseTo(
      2 * (standard.high - standard.centre),
      12,
    );
  });
});

describe('Jensen–Shannon divergence', () => {
  it('is 0 for identical distributions and 1 for disjoint ones', () => {
    expect(jensenShannon([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(0, 12);
    expect(jensenShannon([1, 0], [0, 1])).toBeCloseTo(1, 12);
  });

  it('is exactly 0.5 bits when the distributions share exactly half their mass', () => {
    expect(jensenShannon([0.5, 0.5, 0], [0, 0.5, 0.5])).toBeCloseTo(0.5, 12);
  });

  it('is symmetric', () => {
    const p = [0.9, 0.1];
    const q = [0.1, 0.9];
    expect(jensenShannon(p, q)).toBeCloseTo(0.5310, 4);
    expect(jensenShannon(q, p)).toBeCloseTo(jensenShannon(p, q), 12);
  });

  it('sums the same value from per-type contributions', () => {
    const p = [0.6, 0.4, 0];
    const q = [0, 0.5, 0.5];
    const summed = p.reduce(
      (total, share, index) => total + jsdContribution(share, q[index] as number),
      0,
    );
    expect(summed).toBeCloseTo(jensenShannon(p, q), 12);
  });

  it('rejects non-distributions and malformed shares', () => {
    expect(() => jensenShannon([0.5, 0.4], [0.5, 0.5])).toThrow(RangeError);
    expect(() => jensenShannon([0.5, 0.5], [0.5])).toThrow(RangeError);
    expect(() => jsdContribution(-0.1, 0.5)).toThrow(RangeError);
    expect(() => jsdContribution(Number.NaN, 0.5)).toThrow(RangeError);
    expect(() => jensenShannon([0.5, 0.5], [0.5, 0.5], -1)).toThrow(RangeError);
    expect(() => jensenShannon([0.5, 0.5], [0.5, 0.5], Number.NaN))
      .toThrow(RangeError);
    expect(jsdContribution(0, 0)).toBe(0);
  });
});

describe('readability', () => {
  it('computes ARI and Coleman–Liau from exact counts', () => {
    expect(automatedReadabilityIndex(500, 100, 10)).toBeCloseTo(7.12, 6);
    expect(colemanLiauIndex(500, 100, 10)).toBeCloseTo(10.64, 6);
  });

  it('rises with longer words and longer sentences', () => {
    const base = automatedReadabilityIndex(500, 100, 10);
    expect(automatedReadabilityIndex(700, 100, 10)).toBeGreaterThan(base);
    expect(automatedReadabilityIndex(500, 100, 5)).toBeGreaterThan(base);
    const colemanBase = colemanLiauIndex(500, 100, 10);
    expect(colemanLiauIndex(700, 100, 10)).toBeGreaterThan(colemanBase);
    expect(colemanLiauIndex(500, 100, 5)).toBeGreaterThan(colemanBase);
  });

  it('rejects counts that cannot describe real text', () => {
    expect(() => automatedReadabilityIndex(500, 0, 10)).toThrow(RangeError);
    expect(() => automatedReadabilityIndex(500, 100, 0)).toThrow(RangeError);
    expect(() => automatedReadabilityIndex(50, 100, 10)).toThrow(RangeError);
    expect(() => automatedReadabilityIndex(500, 1, 10)).toThrow(RangeError);
    expect(() => automatedReadabilityIndex(500.5, 100, 10)).toThrow(RangeError);
    expect(() => colemanLiauIndex(-1, 100, 10)).toThrow(RangeError);
    expect(colemanLiauIndex(0, 100, 10)).toBeCloseTo(-18.76, 12);
    expect(automatedReadabilityIndex(100, 100, 100)).toBeCloseTo(-16.22, 12);
  });
});
