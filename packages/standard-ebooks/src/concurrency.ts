/**
 * Map `values` through an async `operation` with at most `concurrency` calls
 * in flight, preserving input order in the result. Once any operation fails,
 * no further operations are launched; already-running operations settle, and
 * then the FIRST-recorded failure is rethrown. That selection matters: a
 * caller may cancel its siblings in reaction to one operation's failure (the
 * archive downloader aborts outstanding fetches), and the caller must see the
 * original error — never a sibling's abort fallout. Shared by the catalog
 * client's repository-text path and the archive downloader.
 */
export async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result = new Array<U>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= values.length) return;
      try {
        result[index] = await operation(values[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failed) throw failure;
  return result;
}
