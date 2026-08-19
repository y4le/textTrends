/**
 * Catalog-independent EPUB extraction — the `@texttrends/standard-ebooks/extract`
 * subpath. This entry point deliberately re-exports ONLY the pure, network-free
 * extraction surface: turning EPUB bytes (or a single XHTML document) into
 * analysis-ready text, reading-order sections, and metadata. It never imports
 * the catalog client, GitHub, or the HTTP module, so a consumer (for example a
 * browser Web Worker) can bundle EPUB reading without pulling in any networking.
 */

export {
  assertValidPartitions,
  DEFAULT_MAX_EXTRACTED_BYTES,
  extractEpub,
  selectEbookSections,
  type ExtractEpubOptions,
  type ExtractedEbook,
} from './ebook-text.js';
export { parseEpub, type EpubDocument, type ParsedEpub } from './epub.js';
export { StandardEbooksError, type StandardEbooksErrorCode } from './errors.js';
export { parsePackage, type ManifestItem, type ParsedPackage, type SpineItem } from './opf.js';
export { extractXhtml, type ExtractedXhtml } from './xhtml.js';
export { decodeUtf8 } from './text.js';
export type {
  EbookContributor,
  EbookMetadata,
  EbookPartition,
  EbookSection,
  TextRange,
} from './types.js';
