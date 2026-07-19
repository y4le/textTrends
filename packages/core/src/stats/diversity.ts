/**
 * Lexical diversity — MATTR (method id `mattr/1`) and MTLD (`mtld/1`).
 * Spec: docs/design/statistics.md. Inputs are normalized token keys (the same keys
 * the index vocabulary uses), not raw surfaces.
 */

/**
 * Moving-average type/token ratio over every sliding window of size `window`
 * (step 1). Sequences shorter than `window` return plain TTR — callers label it.
 */
export function mattr(tokens: readonly string[], window: number): number {
  if (!Number.isInteger(window) || window <= 0) {
    throw new RangeError('window must be a positive integer');
  }
  const n = tokens.length;
  if (n === 0) return 0;
  if (n <= window) return new Set(tokens).size / n;

  // Incremental multiset over the sliding window.
  const counts = new Map<string, number>();
  let types = 0;
  for (let i = 0; i < window; i++) {
    const t = tokens[i] as string;
    const c = counts.get(t) ?? 0;
    if (c === 0) types++;
    counts.set(t, c + 1);
  }
  let sum = types / window;
  let windows = 1;
  for (let i = window; i < n; i++) {
    const incoming = tokens[i] as string;
    const outgoing = tokens[i - window] as string;
    const inC = counts.get(incoming) ?? 0;
    if (inC === 0) types++;
    counts.set(incoming, inC + 1);
    const outC = counts.get(outgoing) as number;
    if (outC === 1) {
      types--;
      counts.delete(outgoing);
    } else {
      counts.set(outgoing, outC - 1);
    }
    sum += types / window;
    windows++;
  }
  return sum / windows;
}

/** One directional MTLD pass (McCarthy & Jarvis 2010), threshold default 0.72. */
function mtldPass(tokens: readonly string[], threshold: number): number {
  let factors = 0;
  let seen = new Map<string, true>();
  let tokenCount = 0;
  let ttr = 1;
  for (const t of tokens) {
    tokenCount++;
    seen.set(t, true);
    ttr = seen.size / tokenCount;
    if (ttr < threshold) {
      factors++;
      seen = new Map();
      tokenCount = 0;
      ttr = 1;
    }
  }
  if (tokenCount > 0) {
    // Partial factor: how far TTR has fallen toward the threshold.
    factors += (1 - ttr) / (1 - threshold);
  }
  return factors === 0 ? tokens.length : tokens.length / factors;
}

export function mtld(tokens: readonly string[], threshold = 0.72): number {
  if (!(threshold > 0 && threshold < 1)) {
    throw new RangeError('threshold must be in (0, 1)');
  }
  if (tokens.length === 0) return 0;
  const forward = mtldPass(tokens, threshold);
  const backward = mtldPass([...tokens].reverse(), threshold);
  return (forward + backward) / 2;
}
