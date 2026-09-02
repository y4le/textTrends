/**
 * Deterministic EPUB-shaped INGESTION ARCHIVE downloads — the
 * `@texttrends/standard-ebooks/archive` subpath.
 *
 * Fetches an ebook's source from GitHub (the OPF and every spine XHTML, all
 * from raw.githubusercontent.com — a CORS-accessible origin) and packages the
 * fetched bytes into a ZIP laid out like an EPUB. The output is NOT a
 * general-purpose EPUB: it contains only the OPF and spine XHTML (no CSS,
 * images, or fonts). Its contract is narrower and stronger — this library's
 * own ingest path (`parseEpub` / `extractEpub`) parses it and extracts text
 * identically to the fetched source, and identical inputs always produce
 * byte-identical archives:
 *
 * - Source bytes are archived RAW, end to end. The OPF is decoded once for
 *   parsing, but the ORIGINAL bytes are archived; spine XHTML is never
 *   decoded or re-encoded.
 * - Member order is fixed: `mimetype` first and STORED (uncompressed), then
 *   `META-INF/container.xml`, the OPF at `content.opf`, then the spine
 *   documents in spine order at their OPF-relative paths.
 * - Timestamps are fixed, the container bytes are a stable constant, and the
 *   result is an exact-size `Uint8Array` — so the construction recipe can be
 *   versioned into a cache key.
 */

import {
  DEFAULT_MAX_EXTRACTED_BYTES,
  decodeUtf8,
  EpubError,
  parsePackage,
  type EbookMetadata,
} from '@texttrends/epub';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { mapConcurrent } from './concurrency.js';
import { StandardEbooksError } from './errors.js';
import { fetchChecked, readResponseBytes, type ByteBudget } from './http.js';
import { validateRepositoryName } from './repository-name.js';
import { yieldToEventLoop } from './task-yield.js';
import type { FetchLike } from './types.js';

const DEFAULT_REPOSITORY_CONCURRENCY = 6;
const RAW_DOCUMENT_LIMIT = 8 * 1024 * 1024;
/** Bounded feed size so assembly can yield between chunks of large documents. */
const ARCHIVE_CHUNK_BYTES = 64 * 1024;
/**
 * Fixed archive timestamp. ZIP timestamps are local-time DOS fields and fflate
 * reads them with local-time getters, so a local-time `Date` constructor makes
 * the stored bytes identical regardless of the host timezone. Any change to
 * this value changes archive bytes and must be treated as a recipe change.
 */
const FIXED_ZIP_TIMESTAMP = new Date(2020, 0, 1, 0, 0, 0);

const MIMETYPE_ARCHIVE_PATH = 'mimetype';
const CONTAINER_ARCHIVE_PATH = 'META-INF/container.xml';
const OPF_ARCHIVE_PATH = 'content.opf';
/** Stable container bytes pointing at the OPF at the archive root. */
const CONTAINER_XML =
  '<?xml version="1.0"?>' +
  '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
  '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
  '</container>';

export interface DownloadEbookArchiveOptions {
  readonly signal?: AbortSignal;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Defaults to `standardebooks`. */
  readonly githubOrganization?: string;
  /** Defaults to `https://raw.githubusercontent.com`. */
  readonly githubRawBase?: string;
  /** Git ref the source is fetched at. Defaults to `master`. */
  readonly ref?: string;
  /** Concurrent raw XHTML requests. Defaults to 6. */
  readonly repositoryConcurrency?: number;
  /** Maximum total source OPF/XHTML bytes. Defaults to 32 MiB. */
  readonly maxExtractedTextBytes?: number;
}

export interface EbookArchiveSource {
  /** Canonical `organization/name` of the GitHub source repository. */
  readonly repository: string;
  readonly ref: string;
}

export interface DownloadedEbookArchive {
  /** The exact-size ingestion-archive ZIP bytes. */
  readonly bytes: Uint8Array;
  readonly metadata: EbookMetadata;
  readonly source: EbookArchiveSource;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function unsafeHref(href: string, reason: string): StandardEbooksError {
  return new StandardEbooksError(
    'INVALID_RESPONSE',
    `Unsafe OPF spine href ${JSON.stringify(href)}: ${reason}`,
  );
}

/**
 * Structural rejections that must hold for BOTH the encoded source href and
 * its percent-decoded form — otherwise an encoded byte (`%5c`, `%2f`, `%00`,
 * `%68ttps:` …) could smuggle a shape past checks that only saw the encoded
 * text and still reach the emitted ZIP member name.
 */
function assertSafeHrefShape(href: string, value: string, phase: 'href' | 'decoded href'): void {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value)) throw unsafeHref(href, `${phase} is an absolute URL`);
  if (value.startsWith('//')) {
    throw unsafeHref(href, `${phase} is a protocol-relative (cross-origin) URL`);
  }
  if (value.startsWith('/')) throw unsafeHref(href, `${phase} is an absolute path`);
  if (value.includes('\\')) throw unsafeHref(href, `${phase} contains a backslash separator`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw unsafeHref(href, `${phase} contains a control character`);
  }
}

/**
 * Canonical OPF-relative archive path for a spine href. Fails closed: absolute
 * and protocol-relative (cross-origin) URLs, absolute paths, path traversal,
 * backslashes and control characters (encoded or decoded), fragment/query
 * aliases, and duplicate normalized member names are rejected, never repaired.
 */
function spineArchivePath(href: string, taken: Set<string>): string {
  if (href === '') throw unsafeHref(href, 'empty href');
  assertSafeHrefShape(href, href, 'href');
  if (href.includes('#')) throw unsafeHref(href, 'fragment would alias another member');
  if (href.includes('?')) throw unsafeHref(href, 'query would alias another member');
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch (error) {
    throw new StandardEbooksError(
      'INVALID_RESPONSE',
      `Unsafe OPF spine href ${JSON.stringify(href)}: invalid percent escape`,
      { cause: error },
    );
  }
  // Reapply every structural check to the DECODED value BEFORE normalization:
  // the decoded string is what the archive member name is built from.
  assertSafeHrefShape(href, decoded, 'decoded href');
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw unsafeHref(href, 'path traversal');
    segments.push(segment);
  }
  if (segments.length === 0) throw unsafeHref(href, 'resolves to no file');
  const archivePath = segments.join('/');
  if (taken.has(archivePath)) {
    throw unsafeHref(href, `duplicate archive member ${JSON.stringify(archivePath)}`);
  }
  taken.add(archivePath);
  return archivePath;
}

/**
 * Aggregate acquisition budget shared by every concurrent spine download,
 * charged chunk-by-chunk while responses are read. Trips as soon as the total
 * would exceed what remains of `maxExtractedTextBytes` after the OPF.
 */
function acquisitionBudget(remainingBytes: number, totalLimit: number): ByteBudget {
  let used = 0;
  return {
    charge(byteCount: number): void {
      used += byteCount;
      if (used > remainingBytes) {
        throw new EpubError(
          'CAP_EXCEEDED',
          `Repository OPF/XHTML exceeds the ${totalLimit}-byte limit`,
        );
      }
    },
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new StandardEbooksError('ABORTED', 'Ebook archive assembly aborted');
  }
}

interface ArchiveMember {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** STORED (uncompressed) rather than deflated — required for `mimetype`. */
  readonly stored: boolean;
}

/**
 * Assemble the archive with fflate's streaming `Zip` (never the `zip`/`zipSync`
 * wrappers, which compress whole inputs on the caller's stack): each member is
 * fed in bounded chunks, the task yields between chunks and files, and the
 * abort signal is checked before and after every push and yield so a caller
 * can cancel mid-assembly.
 */
async function assembleArchive(
  members: readonly ArchiveMember[],
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let failure: unknown = null;
  let failed = false;
  const zip = new Zip((error, chunk) => {
    if (error !== null) {
      failed = true;
      failure = error;
      return;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  });
  try {
    for (const member of members) {
      const entry = member.stored ? new ZipPassThrough(member.path) : new ZipDeflate(member.path);
      entry.mtime = FIXED_ZIP_TIMESTAMP;
      zip.add(entry);
      let offset = 0;
      do {
        const end = Math.min(offset + ARCHIVE_CHUNK_BYTES, member.bytes.byteLength);
        assertNotAborted(signal);
        entry.push(member.bytes.subarray(offset, end), end === member.bytes.byteLength);
        if (failed) throw failure;
        assertNotAborted(signal);
        await yieldToEventLoop();
        assertNotAborted(signal);
        offset = end;
      } while (offset < member.bytes.byteLength);
    }
    zip.end();
    if (failed) throw failure;
  } catch (error) {
    zip.terminate();
    if (error instanceof StandardEbooksError || error instanceof RangeError) throw error;
    throw new StandardEbooksError('INVALID_RESPONSE', 'Ebook archive assembly failed', { cause: error });
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Download an ebook's GitHub source and package it as a deterministic
 * EPUB-shaped ingestion archive. See the module doc for the exact contract;
 * fetched file bodies are never exposed — only the finished archive bytes,
 * the parsed metadata, and the canonical source coordinates.
 */
export async function downloadEbookArchive(
  repositoryName: string,
  options: DownloadEbookArchiveOptions = {},
): Promise<DownloadedEbookArchive> {
  const name = validateRepositoryName(repositoryName);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A Fetch API implementation is required');
  }
  const organization = options.githubOrganization ?? 'standardebooks';
  const rawBase = (options.githubRawBase ?? 'https://raw.githubusercontent.com').replace(/\/$/u, '');
  const ref = options.ref ?? 'master';
  const concurrency = positiveInteger(
    options.repositoryConcurrency,
    DEFAULT_REPOSITORY_CONCURRENCY,
    'repositoryConcurrency',
  );
  const maximumExtracted = positiveInteger(
    options.maxExtractedTextBytes,
    DEFAULT_MAX_EXTRACTED_BYTES,
    'maxExtractedTextBytes',
  );
  const signal = options.signal;

  const opfUrl = `${rawBase}/${encodeURIComponent(organization)}/${encodeURIComponent(name)}/${encodeURIComponent(ref)}/src/epub/content.opf`;
  const opfResponse = await fetchChecked(fetchImpl, opfUrl, { method: 'GET', signal: signal ?? null });
  const opfBytes = await readResponseBytes(opfResponse, RAW_DOCUMENT_LIMIT, 'Source OPF', { signal });
  if (opfBytes.byteLength > maximumExtracted) {
    throw new EpubError(
      'CAP_EXCEEDED',
      `Repository OPF is ${opfBytes.byteLength} bytes; the limit is ${maximumExtracted} bytes`,
    );
  }
  // Decoded ONCE, for parsing only — the ORIGINAL bytes are what gets archived.
  const parsed = parsePackage(decodeUtf8(opfBytes, 'Source OPF'), 'Source OPF');

  const taken = new Set([MIMETYPE_ARCHIVE_PATH, CONTAINER_ARCHIVE_PATH, OPF_ARCHIVE_PATH]);
  const opfOrigin = new URL(opfUrl).origin;
  const spineTargets = parsed.spine.map((spineItem) => {
    const archivePath = spineArchivePath(spineItem.item.href, taken);
    const url = new URL(archivePath.split('/').map(encodeURIComponent).join('/'), opfUrl);
    if (url.origin !== opfOrigin) throw unsafeHref(spineItem.item.href, 'cross-origin URL');
    return { archivePath, url: url.href };
  });

  // The aggregate budget is an ACQUISITION cap, charged while each response
  // body is read — a hostile OPF naming many individually-small files cannot
  // download past the total bound. The internal controller fails the whole
  // stage closed: the first worker error (budget trip, HTTP error, caller
  // abort) aborts every outstanding fetch, and `mapConcurrent` stops
  // launching new operations after any failure.
  const budget = acquisitionBudget(maximumExtracted - opfBytes.byteLength, maximumExtracted);
  const internal = new AbortController();
  const forwardAbort = (): void => internal.abort();
  if (signal?.aborted === true) internal.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let spineBytes: readonly Uint8Array[];
  try {
    spineBytes = await mapConcurrent(spineTargets, concurrency, async (target) => {
      try {
        const response = await fetchChecked(fetchImpl, target.url, {
          method: 'GET',
          signal: internal.signal,
        });
        // NEVER decoded or re-encoded: the exact fetched bytes become the member.
        // The internal signal governs this read — it is what the fetch observes.
        return await readResponseBytes(response, RAW_DOCUMENT_LIMIT, target.archivePath, {
          budget,
          signal: internal.signal,
        });
      } catch (error) {
        internal.abort();
        throw error;
      }
    });
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }

  const members: readonly ArchiveMember[] = [
    { path: MIMETYPE_ARCHIVE_PATH, bytes: strToU8('application/epub+zip'), stored: true },
    { path: CONTAINER_ARCHIVE_PATH, bytes: strToU8(CONTAINER_XML), stored: false },
    { path: OPF_ARCHIVE_PATH, bytes: opfBytes, stored: false },
    ...spineTargets.map((target, index) => ({
      path: target.archivePath,
      bytes: spineBytes[index]!,
      stored: false,
    })),
  ];
  const bytes = await assembleArchive(members, signal);
  return {
    bytes,
    metadata: parsed.metadata,
    source: { repository: `${organization}/${name}`, ref },
  };
}
