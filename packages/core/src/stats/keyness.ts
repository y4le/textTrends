/**
 * Keyness statistics — method ids `keyness-g2-2x2/1` and `log-ratio-halves/1`.
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
 * Log₂ ratio effect size with 0.5 continuity correction on all four cells,
 * so each corpus's adjusted total is N+1.
 */
export function logRatio(a: number, n1: number, b: number, n2: number): number {
  validateTable(a, n1, b, n2);
  return Math.log2((a + 0.5) / (n1 + 1) / ((b + 0.5) / (n2 + 1)));
}

/** Two-sided 95% normal quantile. */
export const LOG_RATIO_Z_95 = 1.959963984540054;

export interface LogRatioIntervalV1 {
  readonly low: number;
  readonly centre: number;
  readonly high: number;
  /** The normal quantile the half-width was built from. */
  readonly z: number;
}

/**
 * Wald confidence interval around `logRatio`, in the same log₂ units.
 *
 * This is the piece the effect size alone cannot supply: a log₂ ratio of +4 is
 * the same number whether it came from 3 occurrences against 0 or from 3,000
 * against 200, and only the interval separates them. The variance is the
 * standard log-risk-ratio form carrying the SAME 0.5/1 continuity correction
 * `logRatio` applies, so the interval and point estimate describe one estimand:
 *
 *   Var(ln ratio) = 1/(a+0.5) − 1/(n1+1) + 1/(b+0.5) − 1/(n2+1)
 *
 * Each pair is non-negative because `a ≤ n1` forces `a + 0.5 < n1 + 1`, so the
 * variance cannot go negative on real inputs; it is clamped as a defensive
 * guard against any future change to that arithmetic.
 *
 * It is a per-term interval with no multiplicity correction. Reading the whole
 * ranked table and keeping only the terms whose intervals exclude zero would
 * be exactly the selection effect that correction exists for — so callers
 * present it as one term's precision, never as a table-wide filter.
 */
export function logRatioInterval(
  a: number,
  n1: number,
  b: number,
  n2: number,
  z: number = LOG_RATIO_Z_95,
): LogRatioIntervalV1 {
  validateTable(a, n1, b, n2);
  if (!Number.isFinite(z) || z <= 0) {
    throw new RangeError('z must be a positive finite number');
  }
  const variance = Math.max(
    0,
    1 / (a + 0.5) - 1 / (n1 + 1) + 1 / (b + 0.5) - 1 / (n2 + 1),
  );
  const halfWidth = (z * Math.sqrt(variance)) / Math.LN2;
  const centre = logRatio(a, n1, b, n2);
  return {
    low: centre - halfWidth,
    centre,
    high: centre + halfWidth,
    z,
  };
}
