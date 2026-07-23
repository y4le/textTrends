/**
 * The main-thread catalog service glue: it maps the Standard Ebooks client's
 * repositories to compact catalog books, surfaces rate-limit progress, and
 * returns repackaged .epub bytes ready to ingest. The CORS-free GitHub-source →
 * .epub round trip itself is proven in the @texttrends/standard-ebooks package;
 * here we prove the app wraps it correctly (and that a rate-limit error is
 * classified for the UI).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listEbooks = vi.fn();
const downloadEpubArchive = vi.fn();

vi.mock('@texttrends/standard-ebooks', () => ({
  StandardEbooksClient: class {
    listEbooks = listEbooks;
    downloadEpubArchive = downloadEpubArchive;
  },
}));

import { CatalogError, downloadEbookArchive, listCatalog } from '../src/lib/standard-ebooks.ts';

describe('standard-ebooks catalog service', () => {
  beforeEach(() => {
    listEbooks.mockReset();
    downloadEpubArchive.mockReset();
  });

  it('lists + maps catalog books and reports page progress', async () => {
    listEbooks.mockImplementation(async (opts: { onPage?: (p: unknown) => void }) => {
      opts.onPage?.({ repositoriesSeen: 2, rateLimit: { remaining: 58, resetAt: null } });
      return {
        books: [
          { name: 'mary-shelley_frankenstein', title: 'Frankenstein', author: 'Mary Shelley' },
          { name: 'no-title', title: '', author: '' },
        ],
      };
    });
    const progress: [number, number | null][] = [];
    const books = await listCatalog(null, (count, rl) => progress.push([count, rl.remaining]));
    expect(books).toEqual([
      { name: 'mary-shelley_frankenstein', title: 'Frankenstein', author: 'Mary Shelley' },
      { name: 'no-title', title: 'no-title', author: '' }, // falls back to the repo name
    ]);
    expect(progress).toEqual([[2, 58]]);
  });

  it('classifies a rate-limit failure so the UI can advise a token', async () => {
    listEbooks.mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }));
    await expect(listCatalog(null, () => undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(listCatalog(null, () => undefined)).rejects.toBeInstanceOf(CatalogError);
  });

  it('returns repackaged .epub bytes + title for ingest', async () => {
    downloadEpubArchive.mockResolvedValue({ bytes: new Uint8Array([80, 75, 3, 4]), metadata: { title: 'Frankenstein' } });
    const { bytes, title } = await downloadEbookArchive('mary-shelley_frankenstein', null);
    expect(title).toBe('Frankenstein');
    expect(Array.from(bytes)).toEqual([80, 75, 3, 4]); // "PK\x03\x04" zip signature
  });
});
