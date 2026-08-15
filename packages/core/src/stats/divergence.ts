/**
 * Distributional divergence — method id `jsd-log2/1`.
 * Spec: docs/design/statistics.md.
 *
 * Jensen–Shannon divergence between two relative-frequency distributions over
 * a shared type space. Base-2 logs make it bounded in [0, 1] bits: 0 when the
 * two distributions are identical, 1 when they share no type at all. Unlike
 * Kullback–Leibler it is symmetric and finite when a type is absent from one
 * side, so a two-selection comparison needs no smoothing and no reference
 * corpus — the pair alone determines the number.
 *
 * The hot path is `jsdContribution`, one call per merged type, because the
 * only caller (keyness) already walks the union of both type spaces linearly
 * and must not build a second dense vector to compute this.
 */

const LOG2 = Math.LN2;

/**
 * One type's contribution, in bits, to the summed divergence.
 *
 * @param p share of this type on side A (its count / A's class-filtered total)
 * @param q share of this type on side B
 *
 * A zero share contributes zero — the `x·log(x/m)` limit as `x → 0` — so a
 * type present on one side only contributes exactly its own half-term.
 */
export function jsdContribution(p: number, q: number): number {
  if (!(p >= 0) || !(q >= 0) || !Number.isFinite(p) || !Number.isFinite(q)) {
    throw new RangeError('shares must be finite and non-negative');
  }
  const m = (p + q) / 2;
  if (m === 0) return 0;
  const left = p === 0 ? 0 : p * Math.log(p / m);
  const right = q === 0 ? 0 : q * Math.log(q / m);
  return (0.5 * (left + right)) / LOG2;
}

/**
 * Jensen–Shannon divergence in bits over two parallel share vectors. The
 * validating array form: the keyness kernel accumulates `jsdContribution`
 * instead, and this exists for callers holding both distributions already
 * (and for the published test vectors).
 *
 * Vectors are treated as distributions, so each must sum to 1 within
 * `tolerance`; that check is what makes the [0, 1] bound meaningful rather
 * than assumed.
 */
export function jensenShannon(
  p: readonly number[],
  q: readonly number[],
  tolerance = 1e-9,
): number {
  if (p.length !== q.length) {
    throw new RangeError('share vectors must be parallel');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a non-negative finite number');
  }
  let sumP = 0;
  let sumQ = 0;
  let bits = 0;
  for (let i = 0; i < p.length; i++) {
    const left = p[i] as number;
    const right = q[i] as number;
    bits += jsdContribution(left, right);
    sumP += left;
    sumQ += right;
  }
  if (Math.abs(sumP - 1) > tolerance || Math.abs(sumQ - 1) > tolerance) {
    throw new RangeError('each share vector must sum to 1');
  }
  // Rounding can push an identical-distribution sum a hair below zero, and a
  // disjoint pair a hair above one. Clamping keeps the published bound true.
  return Math.min(1, Math.max(0, bits));
}
