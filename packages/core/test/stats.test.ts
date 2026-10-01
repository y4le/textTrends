import { describe, expect, it } from 'vitest';
import { automatedReadabilityIndex, colemanLiauIndex, dp, dpNorm, g2Keyness, jensenShannon, jsdContribution, logDice, logRatio, logRatioInterval, LOG_RATIO_Z_95, MATTR_MAX_TYPES, mattr, mattrIds, mtld, pmi, rateContrast, tScore } from '../src/index.ts';

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

  it('logRatio allocates pseudo-counts proportionally to side size', () => {
    expect(logRatio(10, 1000, 2, 2000)).toBeCloseTo(2.9542, 3);
  });

  it('preserves direction, symmetry and equal rates on unequal-size sides', () => {
    const interval = logRatioInterval(0, 2000, 5, 500000);
    expect(interval.centre).toBeCloseTo(-2.589763487, 8);
    expect(interval.low).toBeLessThan(0);
    expect(interval.high).toBeGreaterThan(0);
    expect(logRatio(5, 500000, 0, 2000)).toBeCloseTo(-interval.centre, 12);
    expect(logRatio(0, 2000, 0, 500000)).toBeCloseTo(0, 12);
    expect(logRatio(2, 2000, 500, 500000)).toBeCloseTo(0, 12);
    for (const a of [0, 1, 2, 3, 10, 2000]) {
      for (const b of [0, 1, 5, 250, 500, 500000]) {
        const direction = Math.sign(a / 2000 - b / 500000);
        const effect = logRatio(a, 2000, b, 500000);
        if (direction === 0) expect(effect).toBeCloseTo(0, 12);
        else expect(Math.sign(effect)).toBe(direction);
      }
    }
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

describe('rate contrast', () => {
  it('is a bounded monotone transform of the raw rate ratio', () => {
    for (const ratio of [0.5, 2, 10, 100]) {
      const contrast = rateContrast(ratio * 10, 1_000, 10, 1_000);
      expect(contrast).not.toBeNull();
      expect(contrast).toBeCloseTo(Math.tanh(0.5 * Math.log(ratio)), 12);
    }
  });

  it('pins one-sided zeroes to the observed direction', () => {
    expect(rateContrast(0, 21, 8, 1_923)).toBe(-1);
    expect(rateContrast(1, 21, 0, 1_923)).toBe(1);
  });

  it('keeps its sign aligned with observed rates over a scalar grid', () => {
    for (const tokensA of [1, 21, 100, 5_000]) {
      for (const tokensB of [1, 100, 1_923, 100_000]) {
        for (const countA of [0, 1, 5, 100]) {
          for (const countB of [0, 1, 8, 100]) {
            const contrast = rateContrast(countA, tokensA, countB, tokensB);
            if (countA + countB === 0) {
              expect(contrast).toBeNull();
              continue;
            }
            expect(Math.sign(contrast!)).toBe(Math.sign(countA / tokensA - countB / tokensB));
          }
        }
      }
    }
  });

  it('permits overlap counts above token totals and returns null for invalid sides', () => {
    expect(rateContrast(5, 2, 1, 10)).toBeCloseTo(12 / 13, 12);
    expect(rateContrast(1, 0, 1, 10)).toBeNull();
    expect(rateContrast(0, 10, 0, 10)).toBeNull();
    expect(rateContrast(Number.NaN, 10, 1, 10)).toBeNull();
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
  it('reports conditional Wilson bounds separately from the regularized point', () => {
    const interval = logRatioInterval(10, 1000, 2, 2000);
    const centre = logRatio(10, 1000, 2, 2000);
    expect(interval.low).toBeCloseTo(1.3010, 3);
    expect(interval.high).toBeCloseTo(6.6012, 3);
    expect(interval.centre).toBeCloseTo(centre, 12);
    expect(interval.low).toBeLessThan(centre);
    expect(interval.high).toBeGreaterThan(centre);
    expect(interval.z).toBeCloseTo(LOG_RATIO_Z_95, 12);
  });

  it('separates a thin effect from a thick one at the same effect size', () => {
    // Both sit near +2.8..+3.9 log₂, and only the interval tells them apart:
    // 3-vs-0 cannot exclude "no difference", 3000-vs-200 easily can.
    const thin = logRatioInterval(3, 1000, 0, 1000);
    const thick = logRatioInterval(3000, 100_000, 200, 100_000);
    expect(thin.low).toBeLessThan(0);
    expect(thin.high).toBeGreaterThan(0);
    expect(thick.low).toBeCloseTo(3.7006, 3);
    expect(thick.high).toBeCloseTo(4.1132, 3);
    expect(thick.high - thick.low).toBeLessThan(thin.high - thin.low);
  });

  it('rejects a malformed table or quantile before calculating', () => {
    expect(() => logRatioInterval(11, 10, 1, 10)).toThrow(RangeError);
    expect(() => logRatioInterval(1, 10, 1, 10, 0)).toThrow(RangeError);
    expect(() => logRatioInterval(1, 10, 1, 10, Number.NaN)).toThrow(RangeError);
  });

  it('widens bounds with a larger positive quantile', () => {
    const standard = logRatioInterval(10, 1_000, 2, 2_000);
    const doubled = logRatioInterval(10, 1_000, 2, 2_000, 2 * LOG_RATIO_Z_95);
    expect(doubled.low).toBeLessThan(standard.low);
    expect(doubled.high).toBeGreaterThan(standard.high);
  });

  it('distinguishes weak and strong evidence on unequal zero-hit sides', () => {
    const weak = logRatioInterval(0, 2000, 500, 500000);
    const strong = logRatioInterval(0, 2000, 5000, 500000);
    expect(weak.low).toBe(Number.NEGATIVE_INFINITY);
    expect(weak.high).toBeCloseTo(0.9416542885, 8);
    expect(strong.high).toBeCloseTo(-2.3802738064, 8);
    const swapped = logRatioInterval(5000, 500000, 0, 2000);
    expect(swapped.low).toBeCloseTo(-strong.high, 12);
    expect(swapped.high).toBe(Number.POSITIVE_INFINITY);
    expect(logRatioInterval(0, 2000, 0, 500000)).toMatchObject({
      low: Number.NEGATIVE_INFINITY, centre: 0, high: Number.POSITIVE_INFINITY,
    });
  });

  it('keeps one-event evidence conservative and mirrors small-count bounds', () => {
    const weak = logRatioInterval(1, 2000, 40, 500000);
    expect(weak.low).toBeCloseTo(-2.6945802579, 8);
    expect(weak.high).toBeGreaterThan(0);
    const one = logRatioInterval(1, 2000, 4, 500000);
    expect(one.low).toBeCloseTo(0.3474762346, 8);
    const mirrored = logRatioInterval(4, 500000, 1, 2000);
    expect(mirrored.high).toBeCloseTo(-one.low, 12);
    expect(logRatioInterval(2, 2000, 3, 500000).low).toBeCloseTo(3.6698185085, 8);
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
