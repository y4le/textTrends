/**
 * Main-thread service for the Standard Ebooks catalog SOURCE. Everything here is
 * CORS-clean: the catalog is the GitHub API (api.github.com) and a book is
 * downloaded as its SOURCE from raw.githubusercontent.com and repackaged into a
 * `.epub` in the browser (never the standardebooks.org release download, which
 * a browser cannot fetch cross-origin). The heavy client (+ zip/xml libraries)
 * is dynamically imported so it stays out of the initial bundle until the user
 * opens the catalog.
 */

import type { EbookRepository } from '@texttrends/standard-ebooks';

export type CatalogBook = {
  readonly name: string;
  readonly title: string;
  readonly author: string;
};

export interface RateLimit {
  readonly remaining: number | null;
  readonly resetAt: string | null;
}

export class CatalogError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

async function makeClient(token: string | null) {
  const { StandardEbooksClient } = await import('@texttrends/standard-ebooks');
  return new StandardEbooksClient(token ? { githubToken: token } : {});
}

function toBook(r: EbookRepository): CatalogBook {
  return { name: r.name, title: r.title || r.name, author: r.author };
}

function mapError(e: unknown): CatalogError {
  const code = (e as { code?: string })?.code ?? 'ERROR';
  return new CatalogError(e instanceof Error ? e.message : String(e), code);
}

/**
 * List the whole catalog (paged over the GitHub API). Unauthenticated this is a
 * handful of requests against the 60/hour limit; a user token raises it. Calls
 * `onProgress` after each page with the running count + rate-limit state.
 */
export async function listCatalog(
  token: string | null,
  onProgress: (count: number, rateLimit: RateLimit) => void,
  signal?: AbortSignal,
): Promise<CatalogBook[]> {
  try {
    const client = await makeClient(token);
    const onPage = (page: { repositoriesSeen: number; rateLimit: RateLimit }) => onProgress(page.repositoriesSeen, page.rateLimit);
    const catalog = await client.listEbooks(signal ? { signal, onPage } : { onPage });
    return catalog.books.map(toBook);
  } catch (e) {
    throw mapError(e);
  }
}

/**
 * Download a catalog book's source from GitHub and repackage it into `.epub`
 * bytes ready to ingest exactly like an uploaded file. CORS-clean end to end.
 */
export async function downloadEbookArchive(
  name: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly title: string }> {
  try {
    const client = await makeClient(token);
    const { bytes, metadata } = await client.downloadEpubArchive(name, signal ? { signal } : {});
    return { bytes, title: metadata.title };
  } catch (e) {
    throw mapError(e);
  }
}
