/**
 * windows1252TableHash memoization (Phase D / D3, part 1): the constant table
 * is digested ONCE per module lifetime and the promise is shared among
 * concurrent callers; a REJECTED digest clears the memo so a transient
 * failure is retryable and never becomes a cached permanent disproof.
 *
 * Each test imports a FRESH module instance (vi.resetModules + dynamic
 * import) so the module-level memo starts unprimed, and instruments the
 * digest by spying on the global crypto.subtle.digest the hasher calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshTableHash(): Promise<() => Promise<string>> {
  vi.resetModules();
  const mod = await import('../src/extract/decode.ts');
  return mod.windows1252TableHash;
}

describe('windows1252TableHash memoization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('concurrent callers perform ONE table digest and all receive the same hash', async () => {
    const windows1252TableHash = await freshTableHash();
    const spy = vi.spyOn(crypto.subtle, 'digest');
    const results = await Promise.all([
      windows1252TableHash(),
      windows1252TableHash(),
      windows1252TableHash(),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    // A later call after resolution is a memo hit — still one digest.
    expect(await windows1252TableHash()).toBe(results[0]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns the same recipe-identity hash the default recipes embed', async () => {
    vi.resetModules();
    const { windows1252TableHash } = await import('../src/extract/decode.ts');
    const { defaultExtractionRecipes } = await import('../src/extract/extraction.ts');
    const hash = await windows1252TableHash();
    const { txt } = await defaultExtractionRecipes();
    expect(txt.decoder.windows1252TableHash).toBe(hash);
  });

  it('a rejected digest is NOT memoized — the next call retries and succeeds', async () => {
    const windows1252TableHash = await freshTableHash();
    const spy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('transient digest failure'));
    // First call: the forced transient failure surfaces to the caller…
    await expect(windows1252TableHash()).rejects.toThrow('transient digest failure');
    // …and was not cached: the retry digests again and resolves the true hash.
    const hash = await windows1252TableHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(2);
    // The SUCCESS is memoized for the module lifetime.
    expect(await windows1252TableHash()).toBe(hash);
    expect(spy).toHaveBeenCalledTimes(2);
    // The retried hash agrees with an untouched module instance's hash.
    spy.mockRestore();
    const pristine = await freshTableHash();
    expect(await pristine()).toBe(hash);
  });

  it('concurrent callers of a failing digest ALL observe the rejection, then a shared retry succeeds', async () => {
    const windows1252TableHash = await freshTableHash();
    const spy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('transient digest failure'));
    const [a, b] = await Promise.allSettled([windows1252TableHash(), windows1252TableHash()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(spy).toHaveBeenCalledTimes(1); // the failing attempt was still shared
    await expect(windows1252TableHash()).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
