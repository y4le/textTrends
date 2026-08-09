/**
 * Main-thread service for ADDING a Standard Ebooks book. The catalog itself
 * is a baked snapshot (standard-ebooks-catalog.ts, fetched on demand as a
 * hashed same-origin asset) — browsing makes no external requests and
 * nothing here lists anything. A book's SOURCE is
 * downloaded by repository name from raw.githubusercontent.com (a
 * CORS-accessible origin, unlike the standardebooks.org release download)
 * and repackaged into a `.epub` in the browser, ready to ingest exactly like
 * an uploaded file. Only the `@texttrends/standard-ebooks/archive` subpath is
 * imported — never the root client, whose catalog/release machinery the app
 * has no use for — and dynamically, so archive assembly (+ zip/xml libraries)
 * stays out of the initial bundle. The resulting source is stored in the
 * canonical local library, which owns durable storage and content-hash
 * deduplication.
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
 * to ingest exactly like an uploaded file, CORS-clean end to end. Library
 * errors surface as coded CatalogErrors (ABORTED,
 * NETWORK_ERROR, HTTP_ERROR, RATE_LIMITED, CAP_EXCEEDED, INVALID_*).
 */
export async function downloadEbookArchive(
  name: string,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly title: string }> {
  try {
    if (signal?.aborted) {
      throw Object.assign(new Error('Standard Ebooks download aborted'), { code: 'ABORTED' });
    }
    const archive = await import('@texttrends/standard-ebooks/archive');
    const { bytes, metadata } = await archive.downloadEbookArchive(
      name,
      signal ? { signal } : {},
    );
    return { bytes, title: metadata.title };
  } catch (e) {
    throw mapError(e);
  }
}
