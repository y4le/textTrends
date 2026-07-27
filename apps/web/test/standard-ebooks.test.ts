/**
 * The main-thread add-a-book service glue. Browsing is the baked catalog
 * (standard-ebooks-catalog.test.ts proves the artifact); this service only
 * downloads one book's source and returns repackaged .epub bytes ready to
 * ingest. The CORS-free GitHub-source → .epub round trip itself is proven in
 * the @texttrends/standard-ebooks package; here we prove the app wraps it
 * correctly and classifies failures for the UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloadEpubArchive = vi.fn();

vi.mock('@texttrends/standard-ebooks', () => ({
  StandardEbooksClient: class {
    downloadEpubArchive = downloadEpubArchive;
  },
}));

import { CatalogError, downloadEbookArchive } from '../src/lib/standard-ebooks.ts';

describe('standard-ebooks add service', () => {
  beforeEach(() => {
    downloadEpubArchive.mockReset();
  });

  it('returns repackaged .epub bytes + title for ingest', async () => {
    downloadEpubArchive.mockResolvedValue({ bytes: new Uint8Array([80, 75, 3, 4]), metadata: { title: 'Frankenstein' } });
    const { bytes, title } = await downloadEbookArchive('mary-shelley_frankenstein');
    expect(title).toBe('Frankenstein');
    expect(Array.from(bytes)).toEqual([80, 75, 3, 4]); // "PK\x03\x04" zip signature
    expect(downloadEpubArchive).toHaveBeenCalledWith('mary-shelley_frankenstein', {});
  });

  it('classifies a download failure as a coded CatalogError for the UI', async () => {
    downloadEpubArchive.mockRejectedValue(Object.assign(new Error('missing'), { code: 'HTTP_ERROR' }));
    await expect(downloadEbookArchive('gone_book')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    downloadEpubArchive.mockRejectedValue(new Error('boom'));
    const bare = downloadEbookArchive('gone_book');
    await expect(bare).rejects.toBeInstanceOf(CatalogError);
    await expect(bare).rejects.toMatchObject({ code: 'ERROR' });
  });

  it('threads an abort signal through to the client', async () => {
    downloadEpubArchive.mockResolvedValue({ bytes: new Uint8Array(), metadata: { title: 't' } });
    const controller = new AbortController();
    await downloadEbookArchive('a_b', controller.signal);
    expect(downloadEpubArchive).toHaveBeenCalledWith('a_b', { signal: controller.signal });
  });
});
