/**
 * The main-thread add-a-book service glue. Browsing is the baked catalog
 * (standard-ebooks-catalog.test.ts proves the artifact); this service only
 * downloads one book's source and returns repackaged .epub bytes ready to
 * ingest. The CORS-free GitHub-source → .epub round trip itself is proven in
 * the @texttrends/standard-ebooks package; here we prove the app wraps the
 * ARCHIVE SUBPATH (never the root client — the streaming, yield-between-chunks
 * assembly lives behind `@texttrends/standard-ebooks/archive`) and classifies
 * failures for the UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const libraryDownload = vi.fn();

vi.mock('@texttrends/standard-ebooks/archive', () => ({
  downloadEbookArchive: libraryDownload,
}));

import { CatalogError, downloadEbookArchive } from '../src/lib/standard-ebooks.ts';

describe('standard-ebooks add service', () => {
  beforeEach(() => {
    libraryDownload.mockReset();
  });

  it('returns repackaged .epub bytes + title for ingest via the archive subpath', async () => {
    libraryDownload.mockResolvedValue({
      bytes: new Uint8Array([80, 75, 3, 4]),
      metadata: { title: 'Frankenstein' },
      source: { repository: 'standardebooks/mary-shelley_frankenstein', ref: 'master' },
    });
    const { bytes, title } = await downloadEbookArchive('mary-shelley_frankenstein');
    expect(title).toBe('Frankenstein');
    expect(Array.from(bytes)).toEqual([80, 75, 3, 4]); // "PK\x03\x04" zip signature
    expect(libraryDownload).toHaveBeenCalledWith('mary-shelley_frankenstein', {});
  });

  it('classifies a download failure as a coded CatalogError for the UI', async () => {
    libraryDownload.mockRejectedValue(Object.assign(new Error('missing'), { code: 'HTTP_ERROR' }));
    await expect(downloadEbookArchive('gone_book')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    libraryDownload.mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }));
    const offline = downloadEbookArchive('gone_book');
    await expect(offline).rejects.toBeInstanceOf(CatalogError);
    await expect(offline).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'offline' });
    libraryDownload.mockRejectedValue(new Error('boom'));
    const bare = downloadEbookArchive('gone_book');
    await expect(bare).rejects.toBeInstanceOf(CatalogError);
    await expect(bare).rejects.toMatchObject({ code: 'ERROR' });
  });

  it('threads an abort signal through to the archive download', async () => {
    libraryDownload.mockResolvedValue({
      bytes: new Uint8Array(),
      metadata: { title: 't' },
      source: { repository: 'standardebooks/a_b', ref: 'master' },
    });
    const controller = new AbortController();
    await downloadEbookArchive('a_b', controller.signal);
    expect(libraryDownload).toHaveBeenCalledWith('a_b', { signal: controller.signal });
  });
});
