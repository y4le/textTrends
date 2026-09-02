import { strToU8, unzipSync, Zip } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { downloadEbookArchive } from '../src/archive.js';
import { extractEpub } from '@texttrends/epub';
import { StandardEbooksClient, StandardEbooksError } from '../src/index.js';
import { yieldToEventLoop } from '../src/task-yield.js';
import {
  chapterXhtml,
  endnotesXhtml,
  fixtureEpub,
  packageXml,
  titlepageXhtml,
} from './fixtures.js';

vi.mock(import('../src/task-yield.js'), { spy: true });

const REPOSITORY = 'test-author_test-book_test-translator';
const ALL_PARTITIONS = ['frontmatter', 'bodymatter', 'backmatter'] as const;
const CHUNK_BYTES = 64 * 1024;

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** Fetch stub serving raw-GitHub URLs by suffix; anything else is an error. */
function rawFetch(files: Record<string, Uint8Array | string>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    for (const [suffix, body] of Object.entries(files)) {
      if (url.endsWith(suffix)) {
        const bytes = typeof body === 'string' ? strToU8(body) : body.slice();
        return new Response(bytes as unknown as BodyInit, { status: 200 });
      }
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function standardFiles(): Record<string, Uint8Array | string> {
  return {
    '/master/src/epub/content.opf': packageXml,
    '/master/src/epub/text/titlepage.xhtml': titlepageXhtml,
    '/master/src/epub/text/chapter-1.xhtml': chapterXhtml,
    '/master/src/epub/text/endnotes.xhtml': endnotesXhtml,
  };
}

/** Minimal parseable OPF whose spine hrefs are exactly `hrefs`. */
function minimalOpf(hrefs: readonly string[]): string {
  const items = hrefs
    .map((href, i) => `<item href="${href}" id="item-${i}" media-type="application/xhtml+xml"/>`)
    .join('');
  const itemrefs = hrefs.map((_, i) => `<itemref idref="item-${i}"/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">https://standardebooks.org/ebooks/test-author/test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest>${items}</manifest>
  <spine>${itemrefs}</spine>
</package>`;
}

/**
 * An OK streaming Response whose body delivers one chunk and then fails on the
 * next read — the fetch itself has RESOLVED, so the failure surfaces from the
 * body-read path, not from `fetch()`.
 */
function failingBodyResponse(firstChunk: Uint8Array, failure: Error, onFail?: () => void): Response {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(streamController): void {
      pulls += 1;
      if (pulls === 1) {
        streamController.enqueue(firstChunk);
        return;
      }
      onFail?.();
      streamController.error(failure);
    },
  });
  return new Response(body, { status: 200 });
}

/** A spine document several 64 KiB chunks long, to exercise chunked assembly. */
function bigChapterBytes(): Uint8Array {
  return strToU8(
    '<?xml version="1.0" encoding="utf-8"?>' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
      '<head><title>Chapter I</title></head>' +
      `<body epub:type="bodymatter"><section epub:type="chapter"><p>${'lorem ipsum '.repeat(20_000)}</p></section></body>` +
      '</html>',
  );
}

/** Central-directory entries in the order they were written to the archive. */
function centralDirectoryEntries(bytes: Uint8Array): readonly { name: string; method: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('archive has no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: { name: string; method: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central-directory header');
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      method,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('downloadEbookArchive', () => {
  it('archives the fetched OPF and spine bytes byte-for-byte, never decode/re-encoded', async () => {
    // A byte sequence a decode/re-encode round trip would alter: a non-NFC
    // sequence plus a UTF-8-encoded lone surrogate and stray invalid bytes in
    // a comment (TextDecoder replaces them with U+FFFD; a fatal decoder throws).
    const trickyChapterBytes = concatBytes(
      strToU8(
        '<?xml version="1.0" encoding="utf-8"?>' +
          '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
          '<head><title>Chapter I</title></head>' +
          '<body epub:type="bodymatter"><section epub:type="chapter"><p>café</p><!-- ',
      ),
      new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xfe]),
      strToU8(' --></section></body></html>'),
    );
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(trickyChapterBytes));
    expect(roundTripped).not.toEqual(trickyChapterBytes);
    const opfBytes = strToU8(packageXml);
    const files = standardFiles();
    files['/master/src/epub/content.opf'] = opfBytes;
    files['/master/src/epub/text/chapter-1.xhtml'] = trickyChapterBytes;
    const fetchMock = rawFetch(files);

    const archive = await downloadEbookArchive(REPOSITORY, {
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
    });

    const unarchived = unzipSync(archive.bytes);
    expect(unarchived['content.opf']).toEqual(opfBytes);
    expect(unarchived['text/chapter-1.xhtml']).toEqual(trickyChapterBytes);
    expect(unarchived['text/titlepage.xhtml']).toEqual(strToU8(titlepageXhtml));
    expect(unarchived['text/endnotes.xhtml']).toEqual(strToU8(endnotesXhtml));
    expect(archive.metadata.title).toBe('Test Book');
    expect(archive.source).toEqual({
      repository: `standardebooks/${REPOSITORY}`,
      ref: 'master',
    });
  });

  it('is deterministic — mimetype first and STORED, stable member order, identical bytes across runs — and extracts through the ingest path', async () => {
    const first = await downloadEbookArchive(REPOSITORY, {
      fetch: rawFetch(standardFiles()),
      githubRawBase: 'https://raw.test',
    });
    const second = await downloadEbookArchive(REPOSITORY, {
      fetch: rawFetch(standardFiles()),
      githubRawBase: 'https://raw.test',
    });
    expect(second.bytes).toEqual(first.bytes);

    // The first local file header is the STORED mimetype, its content
    // immediately after the header so the archive type is sniffable.
    const view = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // compression method: STORED
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(new TextDecoder().decode(first.bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    const dataStart = 30 + nameLength + extraLength;
    expect(new TextDecoder().decode(first.bytes.subarray(dataStart, dataStart + 20))).toBe(
      'application/epub+zip',
    );

    // Member order: mimetype, container, OPF, then spine order; spine members deflated.
    const entries = centralDirectoryEntries(first.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'content.opf',
      'text/titlepage.xhtml',
      'text/chapter-1.xhtml',
      'text/endnotes.xhtml',
    ]);
    expect(entries.map((entry) => entry.method)).toEqual([0, 8, 8, 8, 8, 8]);

    // The archive extracts through this library's ingest path identically to a
    // release EPUB built from the same documents.
    const viaArchive = extractEpub(first.bytes, { partitions: ALL_PARTITIONS });
    const viaRelease = extractEpub(fixtureEpub(), { partitions: ALL_PARTITIONS });
    expect(viaArchive.text).toBe(viaRelease.text);
    expect(viaArchive.metadata).toEqual(viaRelease.metadata);
  });

  it('rejects invalid repository names before any fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(downloadEbookArchive('../private', { fetch: fetchMock })).rejects.toMatchObject({
      code: 'INVALID_REPOSITORY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['absolute URL', 'https://evil.test/x.xhtml'],
    ['protocol-relative cross-origin URL', '//evil.test/x.xhtml'],
    ['absolute path', '/etc/x.xhtml'],
    ['path traversal', '../../x.xhtml'],
    ['encoded path traversal', '%2e%2e/x.xhtml'],
    ['encoded backslash traversal', '%2e%2e%5c%2e%2e%5csecret.xhtml'],
    ['encoded control character', 'text/%00.xhtml'],
    ['encoded absolute URL', '%68ttps://evil.test/x.xhtml'],
    ['fragment alias', 'text/chapter-1.xhtml#alias'],
    ['query alias', 'text/chapter-1.xhtml?alias=1'],
  ])('fails closed on an unsafe spine href (%s) without fetching it', async (_kind, href) => {
    const fetchMock = rawFetch({ '/master/src/epub/content.opf': minimalOpf([href]) });
    await expect(
      downloadEbookArchive(REPOSITORY, { fetch: fetchMock, githubRawBase: 'https://raw.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the OPF
  });

  it.each([
    ['normalized duplicates', ['text/a.xhtml', 'text/./a.xhtml']],
    ['collision with a reserved member', ['content.opf']],
  ])('fails closed on duplicate normalized member names (%s)', async (_kind, hrefs) => {
    const fetchMock = rawFetch({ '/master/src/epub/content.opf': minimalOpf(hrefs) });
    await expect(
      downloadEbookArchive(REPOSITORY, { fetch: fetchMock, githubRawBase: 'https://raw.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trips the aggregate byte cap while responses are read and launches no further spine requests', async () => {
    // A hostile OPF naming many individually-valid files must not defeat the
    // total bound: the shared budget trips during acquisition, so only the
    // OPF plus the bounded in-flight set is ever requested — never all 12.
    const hrefs = Array.from({ length: 12 }, (_, index) => `text/c-${index}.xhtml`);
    const opf = minimalOpf(hrefs);
    const files: Record<string, Uint8Array | string> = { '/master/src/epub/content.opf': opf };
    for (const href of hrefs) files[`/master/src/epub/${href}`] = 'x'.repeat(64);
    const fetchMock = rawFetch(files);

    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: fetchMock,
        githubRawBase: 'https://raw.test',
        repositoryConcurrency: 2,
        maxExtractedTextBytes: strToU8(opf).byteLength + 8,
      }),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
    // 1 OPF request + at most the 2 concurrent spine requests already in flight.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('enforces the source byte caps', async () => {
    // The OPF alone over the cap.
    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: rawFetch(standardFiles()),
        githubRawBase: 'https://raw.test',
        maxExtractedTextBytes: 16,
      }),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
    // OPF within the cap, OPF + spine XHTML over it.
    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: rawFetch(standardFiles()),
        githubRawBase: 'https://raw.test',
        maxExtractedTextBytes: strToU8(packageXml).byteLength + 16,
      }),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });

  it('propagates non-OK and malformed responses', async () => {
    const notFound = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }));
    await expect(
      downloadEbookArchive(REPOSITORY, { fetch: notFound, githubRawBase: 'https://raw.test' }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });

    // The OPF itself must be strict UTF-8 (it is parsed); invalid bytes fail.
    const invalidOpf = rawFetch({ '/master/src/epub/content.opf': new Uint8Array([0xff, 0xfe, 0x00]) });
    await expect(
      downloadEbookArchive(REPOSITORY, { fetch: invalidOpf, githubRawBase: 'https://raw.test' }),
    ).rejects.toMatchObject({ code: 'INVALID_EPUB' });
  });

  it('maps a fetch abort mid-download to ABORTED', async () => {
    const controller = new AbortController();
    const files = standardFiles();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('chapter-1.xhtml')) {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      for (const [suffix, body] of Object.entries(files)) {
        if (url.endsWith(suffix)) {
          return new Response(strToU8(body as string) as unknown as BodyInit, { status: 200 });
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: fetchMock,
        githubRawBase: 'https://raw.test',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('maps an abort landing during the OPF body read to ABORTED', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      failingBodyResponse(
        strToU8('<?xml version="1.0"?>'),
        new DOMException('The operation was aborted.', 'AbortError'),
        () => controller.abort(),
      ),
    );
    const promise = downloadEbookArchive(REPOSITORY, {
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      signal: controller.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(StandardEbooksError);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('maps an abort landing during a spine body read to ABORTED', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('content.opf')) {
        return new Response(strToU8(minimalOpf(['text/chapter-1.xhtml'])) as unknown as BodyInit, {
          status: 200,
        });
      }
      return failingBodyResponse(
        strToU8('<html'),
        new DOMException('The operation was aborted.', 'AbortError'),
        () => controller.abort(),
      );
    });
    const promise = downloadEbookArchive(REPOSITORY, {
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      signal: controller.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(StandardEbooksError);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('classifies a custom abort reason surfacing from a body read as ABORTED', async () => {
    // abort(reason) propagates the caller's arbitrary reason into the body
    // stream — the thrown error is a plain TypeError, so classification must
    // consult the governing signal, not just the error's shape.
    const controller = new AbortController();
    const reason = new TypeError('custom cancel reason');
    const fetchMock = vi.fn<typeof fetch>(async () =>
      failingBodyResponse(strToU8('<?xml version="1.0"?>'), reason, () => controller.abort(reason)),
    );
    const promise = downloadEbookArchive(REPOSITORY, {
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
      signal: controller.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(StandardEbooksError);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('surfaces the original worker failure, not the sibling aborts it triggers', async () => {
    // Two spine files in flight: file a's body fails with a transport error;
    // the resulting internal abort errors file b's still-pending body read
    // with the abort reason. The caller must see a's NETWORK_ERROR — never
    // b's consequential ABORTED.
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('content.opf')) {
        return new Response(
          strToU8(minimalOpf(['text/a.xhtml', 'text/b.xhtml'])) as unknown as BodyInit,
          { status: 200 },
        );
      }
      if (url.endsWith('a.xhtml')) {
        return failingBodyResponse(strToU8('<html'), new TypeError('terminated'));
      }
      // b.xhtml: one chunk, then pends until the governing signal aborts it.
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(streamController): void {
          streamController.enqueue(strToU8('<html'));
          signal.addEventListener('abort', () => streamController.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: fetchMock,
        githubRawBase: 'https://raw.test',
        repositoryConcurrency: 2,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(3); // OPF + both spine files, nothing more
  });

  it('maps a non-abort body transport failure to NETWORK_ERROR', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('content.opf')) {
        return new Response(strToU8(minimalOpf(['text/chapter-1.xhtml'])) as unknown as BodyInit, {
          status: 200,
        });
      }
      return failingBodyResponse(strToU8('<html'), new TypeError('terminated'));
    });
    await expect(
      downloadEbookArchive(REPOSITORY, { fetch: fetchMock, githubRawBase: 'https://raw.test' }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('aborts assembly when the signal fires after all downloads complete', async () => {
    const controller = new AbortController();
    const files = standardFiles();
    let served = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      for (const [suffix, body] of Object.entries(files)) {
        if (url.endsWith(suffix)) {
          served += 1;
          if (served === Object.keys(files).length) controller.abort();
          return new Response(strToU8(body as string) as unknown as BodyInit, { status: 200 });
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(
      downloadEbookArchive(REPOSITORY, {
        fetch: fetchMock,
        githubRawBase: 'https://raw.test',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    // Every download completed: the abort was honored at assembly time.
    expect(fetchMock).toHaveBeenCalledTimes(Object.keys(files).length);
  });

  it('feeds large documents in bounded chunks, yielding between them', async () => {
    const chapterBytes = bigChapterBytes();
    expect(chapterBytes.byteLength).toBeGreaterThan(CHUNK_BYTES);
    const fetchMock = rawFetch({
      '/master/src/epub/content.opf': minimalOpf(['text/chapter-1.xhtml']),
      '/master/src/epub/text/chapter-1.xhtml': chapterBytes,
    });
    const yieldSpy = vi.mocked(yieldToEventLoop);
    yieldSpy.mockClear();

    const archive = await downloadEbookArchive(REPOSITORY, {
      fetch: fetchMock,
      githubRawBase: 'https://raw.test',
    });

    // One yield per fed chunk: at least the big document's chunk count.
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(
      Math.ceil(chapterBytes.byteLength / CHUNK_BYTES),
    );
    // Chunked feeding still reassembles the member byte-for-byte.
    expect(unzipSync(archive.bytes)['text/chapter-1.xhtml']).toEqual(chapterBytes);
  });

  it('honors an abort raised mid-assembly between chunks and terminates the zip stream', async () => {
    const chapterBytes = bigChapterBytes();
    const chapterChunks = Math.ceil(chapterBytes.byteLength / CHUNK_BYTES);
    expect(chapterChunks).toBeGreaterThanOrEqual(2);
    const fetchMock = rawFetch({
      '/master/src/epub/content.opf': minimalOpf(['text/chapter-1.xhtml']),
      '/master/src/epub/text/chapter-1.xhtml': chapterBytes,
    });
    const controller = new AbortController();
    const yieldSpy = vi.mocked(yieldToEventLoop);
    const terminateSpy = vi.spyOn(Zip.prototype, 'terminate');
    try {
      // The three fixed members (mimetype, container, OPF) yield once each;
      // yield 5 falls between the multi-chunk chapter's chunks — abort THERE,
      // exercising the after-push/after-yield checks mid-member.
      const abortAtYield = 5;
      let yields = 0;
      yieldSpy.mockImplementation(() => {
        yields += 1;
        if (yields === abortAtYield) controller.abort();
        return Promise.resolve();
      });

      await expect(
        downloadEbookArchive(REPOSITORY, {
          fetch: fetchMock,
          githubRawBase: 'https://raw.test',
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'ABORTED' });

      // Assembly stopped at the aborting yield, before the member finished...
      expect(yields).toBe(abortAtYield);
      expect(abortAtYield).toBeLessThan(3 + chapterChunks);
      // ...and the streaming zip was terminated.
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    } finally {
      terminateSpy.mockRestore();
      yieldSpy.mockRestore();
    }
  });

  it('produces bytes and metadata equivalent to the legacy client method', async () => {
    const viaFunction = await downloadEbookArchive(REPOSITORY, {
      fetch: rawFetch(standardFiles()),
      githubRawBase: 'https://raw.test',
    });
    const client = new StandardEbooksClient({
      fetch: rawFetch(standardFiles()),
      githubRawBase: 'https://raw.test',
    });
    const viaClient = await client.downloadEpubArchive(REPOSITORY);
    expect(viaClient.bytes).toEqual(viaFunction.bytes);
    expect(viaClient.metadata).toEqual(viaFunction.metadata);
    expect(viaClient.repository.title).toBe(viaFunction.metadata.title);
  });
});
