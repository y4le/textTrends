/**
 * Keyness statistics — method ids `keyness-g2-2x2/2` and `log-ratio-proportional/1`.
 * Spec: docs/design/statistics.md. The full 2×2 likelihood-ratio G² (Dunning 1993),
 * not the two-cell Rayson–Garside shorthand, which understates the statistic.
 */

/** One observed/expected cell's contribution; zero observed contributes zero. */
function cell(observed: number, expected: number): number {
  return observed === 0 ? 0 : observed * Math.log(observed / expected);
}

function validateTable(a: number, n1: number, b: number, n2: number): void {
  if (
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(n1) ||
    !Number.isSafeInteger(b) ||
    !Number.isSafeInteger(n2) ||
    n1 <= 0 ||
    n2 <= 0 ||
    a < 0 ||
    b < 0 ||
    a > n1 ||
    b > n2
  ) {
    throw new RangeError(
      'keyness counts must be safe integers with 0 <= a <= n1, 0 <= b <= n2, and positive totals',
    );
  }
}

/**
 * Signed log-likelihood G² over the full 2×2 table (term/non-term × corpus).
 * Positive when the term is relatively more frequent in corpus A.
 *
 * @param a  term count in corpus A
 * @param n1 corpus A token total
 * @param b  term count in corpus B
 * @param n2 corpus B token total
 */
export function g2Keyness(a: number, n1: number, b: number, n2: number): number {
  validateTable(a, n1, b, n2);
  const e1 = (n1 * (a + b)) / (n1 + n2);
  const e2 = (n2 * (a + b)) / (n1 + n2);
  const g2 =
    2 *
    (cell(a, e1) +
      cell(b, e2) +
      cell(n1 - a, n1 - e1) +
      cell(n2 - b, n2 - e2));
  return a / n1 >= b / n2 ? g2 : -g2;
}

/**
 * Log₂ ratio with one pseudo-count allocated proportionally to side sizes
 * in each term/non-term row. Both sides receive the same pseudo-rate, so
 * smoothing cannot reverse the observed direction on unequal-size inputs.
 */
export function logRatio(a: number, n1: number, b: number, n2: number): number {
  validateTable(a, n1, b, n2);
  const qa = n1 / (n1 + n2);
  const qb = n2 / (n1 + n2);
  return Math.log2((a + qa) / (n1 + 2 * qa) / ((b + qb) / (n2 + 2 * qb)));
}

/** Two-sided 95% normal quantile. */
export const LOG_RATIO_Z_95 = 1.959963984540054;

/** chi-square(2k) 0.025 quantiles, k=1..3, for the BCD small-count correction. */
const CHI_SQUARE_LOW_95 = [0, 0.05063561596857975, 0.4844185570879299, 1.2373442457912027] as const;

export interface LogRatioIntervalV1 {
  readonly low: number;
  readonly centre: number;
  readonly high: number;
  /** The normal quantile the half-width was built from. */
  readonly z: number;
}

/**
 * Conditional modified Wilson interval for the unsmoothed rate ratio.
 * Under independent Poisson counts, a given a+b is binomial with odds equal
 * to the rate ratio times n1/n2. Invert the binomial score test and transform
 * its odds into log2 rate units. This interval is asymmetric and can be open
 * ended on the absent side; it is separate from the regularized point estimate.
 * At the default 95% quantile, apply Brown-Cai-DasGupta's modification for
 * one to three events on either side. Other quantiles use plain Wilson bounds.
 * It assumes independent events, without multiplicity or burstiness correction.
 * Reference: docs/design/statistics.md.
 */
export function logRatioInterval(
  a: number,
  n1: number,
  b: number,
  n2: number,
  z: number = LOG_RATIO_Z_95,
): LogRatioIntervalV1 {
  validateTable(a, n1, b, n2);
  if (!Number.isFinite(z) || z <= 0 || !Number.isFinite(z * z)) {
    throw new RangeError('z must be a positive finite number');
  }
  const events = a + b;
  const centre = logRatio(a, n1, b, n2);
  if (events === 0) return { low: Number.NEGATIVE_INFINITY, centre, high: Number.POSITIVE_INFINITY, z };
  const z2 = z * z;
  const radius = z * Math.sqrt(a * b / events + z2 / 4);
  const centreA = a + z2 / 2;
  const centreB = b + z2 / 2;
  const exposure = Math.log2(n2 / n1);
  const smallA = z === LOG_RATIO_Z_95 && a >= 1 && a <= 3 ? CHI_SQUARE_LOW_95[a]! / 2 : null;
  const smallB = z === LOG_RATIO_Z_95 && b >= 1 && b <= 3 ? CHI_SQUARE_LOW_95[b]! / 2 : null;
  return {
    low: a === 0 ? Number.NEGATIVE_INFINITY : smallA !== null
      ? Math.log2(smallA / (events - smallA)) + exposure
      : Math.log2(Math.max(0, centreA - radius) / (centreB + radius)) + exposure,
    centre,
    high: b === 0 ? Number.POSITIVE_INFINITY : smallB !== null
      ? Math.log2((events - smallB) / smallB) + exposure
      : Math.log2((centreA + radius) / Math.max(0, centreB - radius)) + exposure,
    z,
  };
}
