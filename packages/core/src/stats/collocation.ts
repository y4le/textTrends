/**
 * Collocation association scores — method id `collocates/1`.
 * Spec: docs/design/statistics.md.
 *
 * All scores use a UNIT event space (sentence units): fx = units containing the
 * node, fy = units containing the collocate, fxy = units containing both, n =
 * total units. This guarantees fxy <= min(fx, fy), which the logDice <= 14 bound
 * requires — pair-based window counting cannot satisfy it (round-2 review).
 */

function checkUnitCounts(fxy: number, fx: number, fy: number, n?: number): void {
  for (const v of n === undefined ? [fxy, fx, fy] : [fxy, fx, fy, n]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError('counts must be non-negative integers');
  }
  if (fxy > fx || fxy > fy) throw new RangeError('fxy must not exceed min(fx, fy) in unit space');
  if (fx === 0 || fy === 0) throw new RangeError('marginals must be positive');
  if (n !== undefined && (fx > n || fy > n)) throw new RangeError('marginals must not exceed n');
}

/** log-Dice (Rychlý 2008): 14 + log₂(2·fxy / (fx + fy)); ≤ 14 by construction. */
export function logDice(fxy: number, fx: number, fy: number): number {
  checkUnitCounts(fxy, fx, fy);
  return 14 + Math.log2((2 * fxy) / (fx + fy));
}

/** Pointwise mutual information over unit co-occurrence counts. */
export function pmi(fxy: number, fx: number, fy: number, n: number): number {
  checkUnitCounts(fxy, fx, fy, n);
  return Math.log2((fxy * n) / (fx * fy));
}

/** t-score over unit co-occurrence counts. */
export function tScore(fxy: number, fx: number, fy: number, n: number): number {
  checkUnitCounts(fxy, fx, fy, n);
  if (fxy === 0) throw new RangeError('t-score undefined for fxy = 0');
  const expected = (fx * fy) / n;
  return (fxy - expected) / Math.sqrt(fxy);
}
