import type { SourceFormat } from '@texttrends/core';

/** Source bytes can legitimately be interpreted under different formats, so
 * dedupe exact content within a format rather than collapsing those recipes. */
export function localFileIdentity(format: SourceFormat, contentHash: string): string {
  return `${format}:${contentHash}`;
}
