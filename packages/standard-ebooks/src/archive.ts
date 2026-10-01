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

import type { EbookMetadata } from '@texttrends/epub';
import { acquireEbookSources } from './source-download.js';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { StandardEbooksError } from './errors.js';
import { yieldToEventLoop } from './task-yield.js';
import type { FetchLike } from './types.js';

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
  const { parsed, opfBytes, spineTargets, spineBytes, source } = await acquireEbookSources(repositoryName, options);
  const signal = options.signal;
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
    source,
  };
}
