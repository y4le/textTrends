/**
 * Lexical diversity — MATTR (method id `mattr/1`) and MTLD (`mtld/1`).
 * Spec: docs/design/statistics.md. Inputs are normalized token keys (the same keys
 * the index vocabulary uses), not raw surfaces.
 */

/** Numeric diversity uses a dense count table; this is its explicit memory
 * ceiling (2,000,000 Uint32 counters ≈ 8 MiB). */
export const MATTR_MAX_TYPES = 2_000_000;

function validateWindow(window: number): void {
  if (!Number.isInteger(window) || window <= 0) {
    throw new RangeError('window must be a positive integer');
  }
}

/**
 * Numeric moving-average type/token ratio. Inventory already holds integer
 * type ids; this path avoids materializing vocabulary strings merely to call
 * MATTR. Public inputs are admitted completely before allocation.
 */
export function mattrIds(tokens: ArrayLike<number>, window: number): number {
  validateWindow(window);
  const n = tokens.length;
  if (n === 0) return 0;
  let max = -1;
  for (let i = 0; i < n; i++) {
    const id = tokens[i];
    if (
      !Number.isSafeInteger(id) ||
      (id as number) < 0 ||
      (id as number) >= MATTR_MAX_TYPES
    ) {
      throw new RangeError(
        `tokens[${i}] must be an integer in [0, ${MATTR_MAX_TYPES})`,
      );
    }
    if ((id as number) > max) max = id as number;
  }

  const counts = new Uint32Array(max + 1);
  let types = 0;
  const initial = Math.min(window, n);
  for (let i = 0; i < initial; i++) {
    const id = tokens[i] as number;
    if (counts[id] === 0) types++;
    counts[id] = (counts[id] as number) + 1;
  }
  if (n <= window) return types / n;

  let sum = types / window;
  let windows = 1;
  for (let i = window; i < n; i++) {
    const incoming = tokens[i] as number;
    const outgoing = tokens[i - window] as number;
    if (counts[incoming] === 0) types++;
    counts[incoming] = (counts[incoming] as number) + 1;
    const outC = counts[outgoing] as number;
    if (outC === 1) {
      types--;
      counts[outgoing] = 0;
    } else {
      counts[outgoing] = outC - 1;
    }
    sum += types / window;
    windows++;
  }
  return sum / windows;
}

/**
 * Moving-average type/token ratio over every sliding window of size `window`
 * (step 1). Sequences shorter than `window` return plain TTR — callers label it.
 * The string surface delegates to the numeric kernel so there is one window
 * implementation.
 */
export function mattr(tokens: readonly string[], window: number): number {
  validateWindow(window);
  const ids = new Uint32Array(tokens.length);
  const byKey = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i] as string;
    let id = byKey.get(key);
    if (id === undefined) {
      id = byKey.size;
      byKey.set(key, id);
    }
    ids[i] = id;
  }
  return mattrIds(ids, window);
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
