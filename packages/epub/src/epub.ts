import { EPUB_PARSE_LIMITS, type EpubParseLimits } from './limits.js';
import { BoundedZip } from './zip.js';
import { EpubError } from './errors.js';
import { parsePackage, type ParsedPackage } from './opf.js';
import { decodeUtf8 } from './text.js';
import { firstDescendant, parseXml } from './xml.js';

export interface EpubDocument {
  readonly idref: string;
  readonly href: string;
  readonly linear: boolean;
  readonly source: string;
}

export interface ParsedEpub {
  readonly package: ParsedPackage;
  readonly documents: readonly EpubDocument[];
}

function resolveArchivePath(baseFile: string, relativeReference: string): string {
  const cleanReference = relativeReference.split('#', 1)[0]!.split('?', 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleanReference);
  } catch (error) {
    throw new EpubError('INVALID_EPUB', `Invalid percent escape in ${relativeReference}`, { cause: error });
  }
  if (decoded.startsWith('/') || decoded.includes('\\') || /^[a-z][a-z0-9+.-]*:/iu.test(decoded)) {
    throw new EpubError('INVALID_EPUB', `Path is not relative to the EPUB root: ${relativeReference}`);
  }
  const segments = baseFile.split('/');
  segments.pop();
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new EpubError('INVALID_EPUB', `Path escapes the EPUB root: ${relativeReference}`);
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

export function openEpub(bytes: Uint8Array, maximumExtractedBytes: number, limits: EpubParseLimits = {}) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new EpubError('INVALID_EPUB', 'File is not a ZIP/EPUB');
  }
  if (!Number.isSafeInteger(maximumExtractedBytes) || maximumExtractedBytes <= 0) {
    throw new RangeError('maximumExtractedBytes must be a positive safe integer');
  }

  const bound = {
    maxDocumentBytes: limits.maxDocumentBytes ?? EPUB_PARSE_LIMITS.maxDocumentBytes,
    maxMarkupPerDocument: limits.maxMarkupPerDocument ?? EPUB_PARSE_LIMITS.maxMarkupPerDocument,
    maxMarkupTotal: limits.maxMarkupTotal ?? EPUB_PARSE_LIMITS.maxMarkupTotal,
  };
  if (Object.entries(bound).some(([key, value]) => !Number.isSafeInteger(value) || value <= 0 || value > EPUB_PARSE_LIMITS[key as keyof typeof EPUB_PARSE_LIMITS])) throw new RangeError('EPUB parse limits may only reduce the positive default bounds');
  const archive = new BoundedZip(bytes, maximumExtractedBytes);
  let markupTotal = 0;
  const readMarkup = (name: string): string => {
    const source = archive.read(name, bound.maxDocumentBytes);
    if (source.byteLength > bound.maxDocumentBytes) throw new EpubError('CAP_EXCEEDED', `EPUB document exceeds ${bound.maxDocumentBytes} bytes: ${name}`);
    let count = 0;
    for (const byte of source) if (byte === 0x3c) count++;
    markupTotal += count;
    if (count > bound.maxMarkupPerDocument || markupTotal > bound.maxMarkupTotal) throw new EpubError('CAP_EXCEEDED', `EPUB markup exceeds its parsing budget: ${name}`);
    return decodeUtf8(source, name);
  };
  const containerXml = readMarkup('META-INF/container.xml');
  const container = parseXml(containerXml, 'EPUB container descriptor');
  const rootfile = firstDescendant(container, 'rootfile');
  const packageReference = rootfile?.getAttribute('full-path');
  if (packageReference === null || packageReference === undefined || packageReference === '') {
    throw new EpubError('INVALID_EPUB', 'EPUB container has no root package path');
  }

  const packagePath = resolveArchivePath('', packageReference);
  const packageXml = readMarkup(packagePath);
  const parsedPackage = parsePackage(packageXml, 'EPUB package');

  if (parsedPackage.spine.length > 4096) throw new EpubError('CAP_EXCEEDED', 'EPUB spine exceeds 4096 documents');
  const paths = parsedPackage.spine.map((item) => resolveArchivePath(packagePath, item.item.href));
  if (new Set(paths).size !== paths.length) throw new EpubError('INVALID_EPUB', 'EPUB spine repeats a resolved archive path');
  const documents = parsedPackage.spine.map((spineItem) => {
    const archivePath = resolveArchivePath(packagePath, spineItem.item.href);
    return {
      idref: spineItem.idref,
      href: archivePath,
      linear: spineItem.linear,
    };
  });
  return { package: parsedPackage, documents,
    readDocument: (document: (typeof documents)[number]): EpubDocument => ({ ...document, source: readMarkup(document.href) }),
  };
}

/** Eager public parser retained for archive-client consumers. Extraction uses
 * the internal lazy reader so only one chapter's DOM/source is resident. */
export function parseEpub(bytes: Uint8Array, maximumExtractedBytes: number): ParsedEpub {
  const reader = openEpub(bytes, maximumExtractedBytes);
  return { package: reader.package, documents: reader.documents.map(reader.readDocument) };
}
