/**
 * Keyness statistics — method ids `keyness-g2-2x2/1` and `log-ratio-halves/1`.
 * Spec: docs/design/statistics.md. The full 2×2 likelihood-ratio G² (Dunning 1993),
 * not the two-cell Rayson–Garside shorthand, which understates the statistic.
 */

/** One observed/expected cell's contribution; zero observed contributes zero. */
function cell(observed: number, expected: number): number {
  return observed === 0 ? 0 : observed * Math.log(observed / expected);
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
  return Math.log2((a + 0.5) / (n1 + 1) / ((b + 0.5) / (n2 + 1)));
}
