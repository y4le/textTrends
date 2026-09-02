import { unzipSync } from 'fflate';
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

function requiredFile(files: Record<string, Uint8Array>, name: string, label: string): Uint8Array {
  const value = files[name];
  if (value === undefined) throw new EpubError('INVALID_EPUB', `EPUB is missing ${label}: ${name}`);
  return value;
}

export function parseEpub(bytes: Uint8Array, maximumExtractedBytes: number): ParsedEpub {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new EpubError('INVALID_EPUB', 'File is not a ZIP/EPUB');
  }
  if (!Number.isSafeInteger(maximumExtractedBytes) || maximumExtractedBytes <= 0) {
    throw new RangeError('maximumExtractedBytes must be a positive safe integer');
  }

  let files: Record<string, Uint8Array>;
  let declaredExtractedSize = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const selected =
          file.name === 'META-INF/container.xml'
          || file.name.endsWith('.opf')
          || file.name.endsWith('.xhtml');
        if (!selected) return false;
        declaredExtractedSize += file.originalSize;
        if (declaredExtractedSize > maximumExtractedBytes) {
          throw new EpubError(
            'CAP_EXCEEDED',
            `EPUB text exceeds the ${maximumExtractedBytes}-byte extraction limit`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof EpubError) throw error;
    throw new EpubError('INVALID_EPUB', 'Could not decompress EPUB', { cause: error });
  }
  const totalSize = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
  if (totalSize > maximumExtractedBytes) {
    throw new EpubError(
      'CAP_EXCEEDED',
      `Extracted EPUB text is ${totalSize} bytes; the limit is ${maximumExtractedBytes} bytes`,
    );
  }

  const containerXml = decodeUtf8(
    requiredFile(files, 'META-INF/container.xml', 'container descriptor'),
    'EPUB container descriptor',
  );
  const container = parseXml(containerXml, 'EPUB container descriptor');
  const rootfile = firstDescendant(container, 'rootfile');
  const packagePath = rootfile?.getAttribute('full-path');
  if (packagePath === null || packagePath === undefined || packagePath === '') {
    throw new EpubError('INVALID_EPUB', 'EPUB container has no root package path');
  }

  const packageXml = decodeUtf8(requiredFile(files, packagePath, 'package document'), 'EPUB package');
  const parsedPackage = parsePackage(packageXml, 'EPUB package');
  const documents = parsedPackage.spine.map((spineItem) => {
    const archivePath = resolveArchivePath(packagePath, spineItem.item.href);
    return {
      idref: spineItem.idref,
      href: archivePath,
      linear: spineItem.linear,
      source: decodeUtf8(requiredFile(files, archivePath, 'spine document'), archivePath),
    };
  });
  return { package: parsedPackage, documents };
}
