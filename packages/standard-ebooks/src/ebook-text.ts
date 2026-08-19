import { parseEpub, type EpubDocument } from './epub.js';
import type { EbookMetadata, EbookPartition, EbookSection } from './types.js';
import { extractXhtml } from './xhtml.js';

/** Default ceiling on total decompressed OPF/XHTML bytes for a single EPUB.
 *  Shared by the catalog download path and the standalone {@link extractEpub}. */
export const DEFAULT_MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;

const EBOOK_PARTITIONS: ReadonlySet<string> = new Set([
  'frontmatter',
  'bodymatter',
  'backmatter',
  'unknown',
]);

/** Analysis-ready text extracted from an EPUB, independent of the Standard
 *  Ebooks catalog. Mirrors the text-bearing fields of {@link EbookText} without
 *  the catalog `repository`/`source`/`warnings`, so any EPUB — a user upload,
 *  not only a catalog release — can be turned into text plus reading-order
 *  sections and their half-open UTF-16 ranges into `text`. */
export interface ExtractedEbook {
  readonly metadata: EbookMetadata;
  /** Every spine document, including unselected front/back matter. */
  readonly sections: readonly EbookSection[];
  /** Selected sections joined with blank lines. */
  readonly text: string;
  readonly selectedPartitions: readonly EbookPartition[];
}

export interface ExtractEpubOptions {
  /** Reading-order partitions to include in `text`. Defaults to `['bodymatter']`. */
  readonly partitions?: readonly EbookPartition[];
  /** Maximum total decompressed OPF/XHTML bytes. Defaults to 32 MiB. */
  readonly maxExtractedBytes?: number;
}

/** Join the requested partitions of a parsed spine into one text string and
 *  record every section (selected or not) with its half-open UTF-16 range into
 *  that string (`null` when excluded). Selected sections are separated by a
 *  blank line. Pure over the parsed documents — the single place both the
 *  catalog client and {@link extractEpub} assemble sectioned text. */
export function selectEbookSections(
  documents: readonly EpubDocument[],
  partitions: readonly EbookPartition[],
): { readonly sections: readonly EbookSection[]; readonly text: string } {
  const selected = new Set(partitions);
  const sections: EbookSection[] = [];
  const chunks: string[] = [];
  let length = 0;
  for (let order = 0; order < documents.length; order++) {
    const document = documents[order]!;
    const extracted = extractXhtml(document.source, document.href);
    const included = selected.has(extracted.partition);
    let range = null;
    if (included) {
      if (chunks.length > 0) {
        chunks.push('\n\n');
        length += 2;
      }
      const start = length;
      chunks.push(extracted.text);
      length += extracted.text.length;
      range = { start, end: length };
    }
    sections.push({
      order,
      id: document.idref,
      href: document.href,
      title: extracted.title,
      partition: extracted.partition,
      semanticTypes: extracted.semanticTypes,
      linear: document.linear,
      text: extracted.text,
      includedInText: included,
      range,
    });
  }
  return { sections, text: chunks.join('') };
}

/** Reject an empty or out-of-vocabulary partition list before any expensive
 *  work. Shared so the catalog download path fails fast on the same rule the
 *  standalone extractor enforces. */
export function assertValidPartitions(partitions: readonly EbookPartition[]): void {
  if (partitions.length === 0) throw new RangeError('partitions must not be empty');
  if (partitions.some((partition) => !EBOOK_PARTITIONS.has(partition))) {
    throw new RangeError('partitions contains an unsupported value');
  }
}

/**
 * Extract analysis-ready text from raw EPUB bytes, with no catalog or network
 * involvement — the general reader behind {@link StandardEbooksClient} exposed
 * for arbitrary EPUBs (for example a file a user drops into a static webapp).
 *
 * Deterministic: identical bytes and options always yield identical text,
 * sections, and ranges, so a caller may persist only the source bytes and
 * reproduce the extraction later.
 */
export function extractEpub(bytes: Uint8Array, options: ExtractEpubOptions = {}): ExtractedEbook {
  const partitions = options.partitions ?? ['bodymatter'];
  assertValidPartitions(partitions);
  const maxExtractedBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  const epub = parseEpub(bytes, maxExtractedBytes);
  const { sections, text } = selectEbookSections(epub.documents, partitions);
  return {
    metadata: epub.package.metadata,
    sections,
    text,
    selectedPartitions: [...partitions],
  };
}
