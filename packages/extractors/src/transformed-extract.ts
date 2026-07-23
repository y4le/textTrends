/**
 * Shared error for the transformed (container/markup) extractors. A malformed
 * archive/markup is a parse failure and a size overrun a cap breach — the
 * engine maps `cap` to CAP_EXCEEDED vs PARSE_FAILED, never DECODE_FAILED (a
 * transformed format never decodes whole-file bytes to text).
 */
export class TransformedExtractionError extends Error {
  constructor(message: string, readonly cap: boolean) {
    super(message);
    this.name = 'TransformedExtractionError';
  }
}
