/** Internal bounded OPF/spine acquisition shared by text and archive downloads. */
import {
  DEFAULT_MAX_EXTRACTED_BYTES,
  decodeUtf8,
  EpubError,
  parsePackage,
  type ParsedPackage,
} from '@texttrends/epub';
import { StandardEbooksError } from './errors.js';
import { mapConcurrent } from './concurrency.js';
import { fetchChecked, readResponseBytes, type ByteBudget } from './http.js';
import { validateRepositoryName } from './repository-name.js';
import type { DownloadEbookArchiveOptions } from './archive.js';
const DEFAULT_REPOSITORY_CONCURRENCY = 6;
const RAW_DOCUMENT_LIMIT = 8 * 1024 * 1024;
const MIMETYPE_ARCHIVE_PATH = 'mimetype';
const CONTAINER_ARCHIVE_PATH = 'META-INF/container.xml';
const OPF_ARCHIVE_PATH = 'content.opf';

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


export async function acquireEbookSources(
  repositoryName: string, options: DownloadEbookArchiveOptions = {},
  existing?: { readonly url: string; readonly bytes: Uint8Array; readonly parsed: ParsedPackage },
) {
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
  const cached = existing?.url === opfUrl ? existing : undefined;
  const opfBytes = cached?.bytes ?? await readResponseBytes(
    await fetchChecked(fetchImpl, opfUrl, { method: 'GET', signal: signal ?? null }),
    RAW_DOCUMENT_LIMIT, 'Source OPF', { signal },
  );
  if (opfBytes.byteLength > maximumExtracted) {
    throw new EpubError(
      'CAP_EXCEEDED',
      `Repository OPF is ${opfBytes.byteLength} bytes; the limit is ${maximumExtracted} bytes`,
    );
  }
  // Decoded ONCE, for parsing only — the ORIGINAL bytes are what gets archived.
  const parsed = cached?.parsed ?? parsePackage(decodeUtf8(opfBytes, 'Source OPF'), 'Source OPF');

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

  return { parsed, opfBytes, spineTargets, spineBytes, source: { repository: `${organization}/${name}`, ref } };
}
