/**
 * Main-thread service for ADDING a Standard Ebooks book. The catalog itself
 * is a baked snapshot (standard-ebooks-catalog.ts) — browsing costs zero
 * network requests and nothing here lists anything. A book's SOURCE is
 * downloaded by repository name from raw.githubusercontent.com (a
 * CORS-accessible origin, unlike the standardebooks.org release download)
 * and repackaged into a `.epub` in the browser, ready to ingest exactly like
 * an uploaded file. The heavy client (+ zip/xml libraries) is dynamically
 * imported so it stays out of the initial bundle until the user adds a book.
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
 * Download a catalog book's source from GitHub and repackage it into `.epub`
 * bytes ready to ingest exactly like an uploaded file. CORS-clean end to end.
 */
export async function downloadEbookArchive(
  name: string,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly title: string }> {
  try {
    const { StandardEbooksClient } = await import('@texttrends/standard-ebooks');
    const client = new StandardEbooksClient();
    const { bytes, metadata } = await client.downloadEpubArchive(name, signal ? { signal } : {});
    return { bytes, title: metadata.title };
  } catch (e) {
    throw mapError(e);
  }
}
