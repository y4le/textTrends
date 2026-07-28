/**
 * Main-thread service for ADDING a Standard Ebooks book. The catalog itself
 * is a baked snapshot (standard-ebooks-catalog.ts, fetched on demand as a
 * hashed same-origin asset) — browsing makes no external requests and
 * nothing here lists anything. A book's SOURCE is
 * downloaded by repository name from raw.githubusercontent.com (a
 * CORS-accessible origin, unlike the standardebooks.org release download)
 * and repackaged into a `.epub` in the browser, ready to ingest exactly like
 * an uploaded file — through a cache-first IndexedDB layer
 * (standard-ebooks-cache.ts): a verified fresh hit answers from storage with
 * NO network traffic at all. Only the `@texttrends/standard-ebooks/archive`
 * subpath is imported — never the root client, whose catalog/release
 * machinery the app has no use for — and dynamically, ONLY on a cache
 * miss/refresh, so the archive assembly (+ zip/xml libraries) stays out of
 * the initial bundle AND out of a cache-served add; the cache module itself
 * is also a lazy chunk, loaded on first add. The build-shape and cached-add
 * e2e tests (catalog.spec.ts) hold all of these properties.
 */

export class CatalogError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

function mapError(e: unknown): CatalogError {
  const code = (e as { code?: string })?.code ?? 'ERROR';
  return new CatalogError(e instanceof Error ? e.message : String(e), code);
}

/**
 * Download a catalog book's source and repackage it into `.epub` bytes ready
 * to ingest exactly like an uploaded file — cache-first, CORS-clean end to
 * end. Library/cache errors surface as coded CatalogErrors (ABORTED,
 * NETWORK_ERROR, HTTP_ERROR, RATE_LIMITED, CAP_EXCEEDED, INVALID_*).
 */
export async function downloadEbookArchive(
  name: string,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly title: string }> {
  try {
    const cache = await import('./standard-ebooks-cache.ts');
    return await cache.downloadEbookArchiveCached(name, signal);
  } catch (e) {
    throw mapError(e);
  }
}
