export {
  assertValidPartitions,
  DEFAULT_MAX_EXTRACTED_BYTES,
  extractEpub,
  selectEbookSections,
  type ExtractEpubOptions,
  type ExtractedEbook,
} from './ebook-text.js';
export { parseEpub, type EpubDocument, type ParsedEpub } from './epub.js';
export { EpubError, type EpubErrorCode } from './errors.js';
export { parsePackage, type ManifestItem, type ParsedPackage, type SpineItem } from './opf.js';
export { decodeUtf8 } from './text.js';
export type * from './types.js';
export { extractXhtml, type ExtractedXhtml } from './xhtml.js';
