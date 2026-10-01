import type { EpubParseLimits } from './limits.js';
import { openEpub, type EpubDocument } from './epub.js';
import { EpubError } from './errors.js';
import type { EbookMetadata, EbookPartition, EbookSection } from './types.js';
import { extractXhtml } from './xhtml.js';

/** Default ceiling on total decompressed OPF/XHTML bytes for one EPUB. */
export const DEFAULT_MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;

const EBOOK_PARTITIONS: ReadonlySet<string> = new Set([
  'frontmatter',
  'bodymatter',
  'backmatter',
  'unknown',
]);

export interface ExtractedEbook {
  readonly metadata: EbookMetadata;
  /** Every spine document, including unselected front/back matter. */
  readonly sections: readonly EbookSection[];
  /** Selected sections joined with blank lines. */
  readonly text: string;
  readonly selectedPartitions: readonly EbookPartition[];
}

export interface ExtractEpubOptions extends EpubParseLimits {
  /** Selected output cap, enforced while collecting. Defaults to 32M UTF-16. */
  readonly maxTextUtf16?: number;
  /** False avoids retaining a second copy of chapter text in metadata. */
  readonly retainSectionText?: boolean;
  /** Reading-order partitions to include in `text`. Defaults to `['bodymatter']`. */
  readonly partitions?: readonly EbookPartition[];
  /** Maximum total decompressed OPF/XHTML bytes. Defaults to 32 MiB. */
  readonly maxExtractedBytes?: number;
}

/** Join selected parsed spine documents and record their UTF-16 ranges. */
export function selectEbookSections(
  documents: Iterable<EpubDocument>,
  partitions: readonly EbookPartition[],
  options: Pick<ExtractEpubOptions, 'maxTextUtf16' | 'retainSectionText'> = {},
): { readonly sections: readonly EbookSection[]; readonly text: string } {
  const cap = options.maxTextUtf16 ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError('maxTextUtf16 must be a positive safe integer');
  const selected = new Set(partitions);
  const sections: EbookSection[] = [];
  const definite = new Map<number, string>();
  const pending = new Map<number, string>();
  let definiteLength = 0;
  let pendingLength = 0;
  let pendingOverflow = false;
  let hasBodyMatter = false;
  for (const document of documents) {
    const order = sections.length;
    const extracted = extractXhtml(document.source, document.href);
    if (extracted.partition === 'bodymatter') {
      hasBodyMatter = true;
      pending.clear(); pendingLength = 0; pendingOverflow = false;
    }
    if (selected.has(extracted.partition)) {
      definiteLength += extracted.text.length + (definite.size > 0 ? 2 : 0);
      if (definiteLength > cap) throw new EpubError('CAP_EXCEEDED', `Selected EPUB text exceeds ${cap} UTF-16 units`);
      definite.set(order, extracted.text);
    } else if (!hasBodyMatter && selected.has('bodymatter') && extracted.partition === 'unknown' && document.linear && !pendingOverflow) {
      pendingLength += extracted.text.length + (pending.size > 0 ? 2 : 0);
      if (pendingLength > cap) { pending.clear(); pendingOverflow = true; }
      else pending.set(order, extracted.text);
    }
    sections.push({ order, id: document.idref, href: document.href, title: extracted.title,
      partition: extracted.partition, semanticTypes: extracted.semanticTypes, linear: document.linear,
      text: options.retainSectionText === false ? '' : extracted.text, includedInText: false, range: null });
  }
  if (!hasBodyMatter && pendingOverflow) throw new EpubError('CAP_EXCEEDED', `Fallback EPUB text exceeds ${cap} UTF-16 units`);
  if (!hasBodyMatter) for (const [order, text] of pending) definite.set(order, text);
  const chunks: string[] = [];
  let length = 0;
  const ranged = sections.map((section) => {
    const text = definite.get(section.order);
    if (text === undefined) return section;
    if (chunks.length > 0) { chunks.push('\n\n'); length += 2; }
    const start = length;
    length += text.length;
    if (length > cap) throw new EpubError('CAP_EXCEEDED', `Selected EPUB text exceeds ${cap} UTF-16 units`);
    chunks.push(text);
    return { ...section, includedInText: true, range: { start, end: length } };
  });
  return { sections: ranged, text: chunks.join('') };
}

export function assertValidPartitions(partitions: readonly EbookPartition[]): void {
  if (partitions.length === 0) throw new RangeError('partitions must not be empty');
  if (partitions.some((partition) => !EBOOK_PARTITIONS.has(partition))) {
    throw new RangeError('partitions contains an unsupported value');
  }
}

/** Extract deterministic, analysis-ready text and metadata from EPUB bytes. */
export function extractEpub(bytes: Uint8Array, options: ExtractEpubOptions = {}): ExtractedEbook {
  const partitions = options.partitions ?? ['bodymatter'];
  assertValidPartitions(partitions);
  const maxExtractedBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  const epub = openEpub(bytes, maxExtractedBytes, options);
  function* documents() {
    for (const document of epub.documents) yield epub.readDocument(document);
  }
  const { sections, text } = selectEbookSections(documents(), partitions, options);
  return {
    metadata: epub.package.metadata,
    sections,
    text,
    selectedPartitions: [...partitions],
  };
}
