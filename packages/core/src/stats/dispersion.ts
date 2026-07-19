/**
 * Dispersion — Gries' deviation of proportions, method id `dispersion-dp/1`.
 * Spec: docs/design/statistics.md. 0 = perfectly even; 1 (normalized) = maximally
 * clumped.
 */

/**
 * @param occurrences per-part occurrence counts of the term (Σ must be > 0)
 * @param partSizes   per-part token counts (Σ must be > 0), same length
 */
export function dp(occurrences: readonly number[], partSizes: readonly number[]): number {
  if (occurrences.length !== partSizes.length) {
    throw new RangeError('occurrences and partSizes must be parallel');
  }
  const totalOcc = occurrences.reduce((s, v) => s + v, 0);
  const totalSize = partSizes.reduce((s, v) => s + v, 0);
  if (totalOcc <= 0 || totalSize <= 0) {
    throw new RangeError('totals must be positive');
  }
  let sum = 0;
  for (let i = 0; i < occurrences.length; i++) {
    sum += Math.abs((occurrences[i] ?? 0) / totalOcc - (partSizes[i] ?? 0) / totalSize);
  }
  return 0.5 * sum;
}

export function dpNorm(occurrences: readonly number[], partSizes: readonly number[]): number {
  if (partSizes.length < 2) {
    // A one-part corpus has no dispersion to normalize (min share = 1 → 0/0).
    throw new RangeError('dpNorm requires at least two parts');
  }
  const totalSize = partSizes.reduce((s, v) => s + v, 0);
  const minShare = Math.min(...partSizes.map((s) => s / totalSize));
  return dp(occurrences, partSizes) / (1 - minShare);
}
