import { describe, expect, it, vi } from 'vitest';
import { extractEpub, StandardEbooksClient, StandardEbooksError } from '../src/index.js';
import {
  chapterXhtml,
  endnotesXhtml,
  fixtureEpub,
  packageXml,
  titlepageXhtml,
} from './fixtures.js';

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

describe('ebook downloads', () => {
  it('uses the official EPUB and joins body matter by default', async () => {
    const epub = fixtureEpub();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('raw.test')) return textResponse(packageXml);
      if (url.includes('/downloads/')) {
        expect(url).toBe(
          'https://ebooks.test/ebooks/test-author/test-book/downloads/test-author_test-book_test-translator.epub?source=download',
        );
        return new Response(epub as unknown as BodyInit, {
          headers: {
            'content-type': 'application/epub+zip',
            'content-length': String(epub.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new StandardEbooksClient({
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      standardEbooksBase: 'https://ebooks.test',
    });

    const book = await client.downloadEbookText('test-author_test-book_test-translator');

    expect(book.source.kind).toBe('release');
    expect(book.warnings).toEqual([]);
    expect(book.metadata.fullTitle).toBe('Test Book: A Tale');
    expect(book.repository.author).toBe('Test Author');
    expect(book.sections).toHaveLength(3);
    expect(book.sections.map(({ partition }) => partition)).toEqual([
      'frontmatter',
      'bodymatter',
      'backmatter',
    ]);
    expect(book.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');
    expect(book.sections[0]!.range).toBeNull();
    expect(book.sections[1]!.range).toEqual({ start: 0, end: book.text.length });
    expect(book.sections[2]!.range).toBeNull();
  });

  it('downloadEpubArchive builds an EPUB-shaped ingestion archive from GitHub-raw source (no standardebooks.org)', async () => {
    // Serve ONLY raw.githubusercontent-style URLs (the CORS-accessible origin);
    // any standardebooks.org request would throw, proving the archive is built
    // entirely from GitHub source.
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (!url.includes('raw.test')) throw new Error(`non-GitHub fetch not allowed: ${url}`);
      if (url.endsWith('content.opf')) return textResponse(packageXml);
      if (url.endsWith('titlepage.xhtml')) return textResponse(titlepageXhtml);
      if (url.endsWith('chapter-1.xhtml')) return textResponse(chapterXhtml);
      if (url.endsWith('endnotes.xhtml')) return textResponse(endnotesXhtml);
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new StandardEbooksClient({ fetch: fetchMock, githubRawBase: 'https://raw.test' });

    const archive = await client.downloadEpubArchive('test-author_test-book_test-translator');
    expect(archive.metadata.title).toBe('Test Book');
    // The archive parses + extracts through this library's ingest path exactly
    // as the fetched source would (it is an ingestion archive, not a
    // general-purpose EPUB — OPF + spine XHTML only).
    const extracted = extractEpub(archive.bytes);
    expect(extracted.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');
    expect(extracted.sections.map((s) => s.partition)).toEqual(['frontmatter', 'bodymatter', 'backmatter']);
    // No standardebooks.org origin was ever contacted.
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain('raw.test');
  });

  it('can include every partition', async () => {
    const epub = fixtureEpub();
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('raw.test')
        ? textResponse(packageXml)
        : new Response(epub as unknown as BodyInit),
    );
    const client = new StandardEbooksClient({
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      standardEbooksBase: 'https://ebooks.test',
    });
    const book = await client.downloadEbookText('test-author_test-book_test-translator', {
      partitions: ['frontmatter', 'bodymatter', 'backmatter'],
    });
    expect(book.text).toContain('By Test Author.');
    expect(book.text).toContain('First emphasized line.');
    expect(book.text).toContain('A note.');
    expect(book.sections.every(({ range }) => range !== null)).toBe(true);
  });

  it('falls back to current repository XHTML', async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith('/src/epub/content.opf')) return textResponse(packageXml);
      if (url.includes('/downloads/')) return textResponse('not found', 404);
      if (url.endsWith('/src/epub/text/titlepage.xhtml')) return textResponse(titlepageXhtml);
      if (url.endsWith('/src/epub/text/chapter-1.xhtml')) return textResponse(chapterXhtml);
      if (url.endsWith('/src/epub/text/endnotes.xhtml')) return textResponse(endnotesXhtml);
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new StandardEbooksClient({
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      standardEbooksBase: 'https://ebooks.test',
    });

    const book = await client.downloadEbookText('test-author_test-book_test-translator');

    expect(book.source.kind).toBe('repository');
    expect(book.warnings).toHaveLength(1);
    expect(book.warnings[0]!.code).toBe('release-fallback');
    expect(book.text).toContain('First emphasized line.');
    expect(fetched.some((url) => url.endsWith('/src/epub/text/chapter-1.xhtml'))).toBe(true);
  });

  it('does not evade caller size caps by falling back', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('raw.test')) return textResponse(packageXml);
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        headers: { 'content-length': '1000' },
      });
    });
    const client = new StandardEbooksClient({
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      standardEbooksBase: 'https://ebooks.test',
    });

    await expect(
      client.downloadEbookText('test-author_test-book_test-translator', { maxDownloadBytes: 10 }),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' } satisfies Partial<StandardEbooksError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe repository names before fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new StandardEbooksClient({ fetch: fetchMock });
    await expect(client.downloadEbookText('../private')).rejects.toMatchObject({
      code: 'INVALID_REPOSITORY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid runtime partition values', async () => {
    const client = new StandardEbooksClient({ fetch: vi.fn<typeof fetch>() });
    await expect(
      client.downloadEbookText('test-author_test-book', {
        partitions: ['appendix' as never],
      }),
    ).rejects.toThrow('unsupported value');
  });
});
