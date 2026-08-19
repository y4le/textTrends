/**
 * Bounded contrast between two observed rates (`rate-contrast/1`).
 *
 * This is the monotone transform `(r - 1) / (r + 1)` of the raw rate ratio,
 * where `r = rateA / rateB`. Its sign therefore always agrees with the
 * observed-rate difference, while one-sided zeroes land at the fixed axis
 * endpoints instead of requiring a continuity correction.
 */
export function rateContrast(
  countA: number,
  tokensA: number,
  countB: number,
  tokensB: number,
): number | null {
  if (
    !Number.isSafeInteger(countA)
    || !Number.isSafeInteger(tokensA)
    || !Number.isSafeInteger(countB)
    || !Number.isSafeInteger(tokensB)
    || countA < 0
    || countB < 0
    || tokensA <= 0
    || tokensB <= 0
    || countA + countB === 0
  ) {
    return null;
  }
  const rateA = countA / tokensA;
  const rateB = countB / tokensB;
  const contrast = (rateA - rateB) / (rateA + rateB);
  return Math.max(-1, Math.min(1, contrast));
}
