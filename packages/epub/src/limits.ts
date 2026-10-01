export interface EpubParseLimits {
  readonly maxDocumentBytes?: number;
  readonly maxMarkupPerDocument?: number;
  readonly maxMarkupTotal?: number;
}

/** Defaults bound DOM allocation and cumulative synchronous parsing work. */
export const EPUB_PARSE_LIMITS = { maxDocumentBytes: 8 * 1024 * 1024, maxMarkupPerDocument: 100_000, maxMarkupTotal: 400_000 } as const;

/** Bound xmldom's per-element attribute lookup and metadata allocations. */
export const EPUB_XML_LIMITS = {
  maxTagUtf16: 65_536,
  maxAttributesPerTag: 256,
  maxAttributesPerDocument: 50_000,
} as const;
