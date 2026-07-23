/**
 * Structure candidates — the format-neutral evidence a parser emits for the
 * structure phase to turn into a section table. Split out of `markdown.ts`
 * (where only the Markdown heading scan lived) so EPUB and HTML extractors can
 * contribute candidates of their own kinds without importing a Markdown module.
 *
 * A candidate is a char-anchored span in the extracted text (UTF-16 offsets,
 * text order). Today only the Markdown heading kinds exist; new kinds (EPUB
 * spine/nav sections, HTML headings) are added alongside these and MUST hash
 * without disturbing the existing kinds' identity — the hash serialization per
 * kind is fixed, so a Markdown candidate set keeps its exact hash.
 */

import { canonicalJson, sha256Hex } from '../contract/hash.ts';

export interface StructureCandidateV1 {
  readonly kind: 'md-heading-atx' | 'md-heading-setext';
  readonly level: number; // 1–6 as authored
  readonly title: string;
  readonly chars: { readonly start: number; readonly end: number };
}

/** Canonical identity of a candidate set (order is text order, so the array
 *  itself is canonical). The per-candidate projection is FIXED — extending the
 *  candidate union with new kinds must serialize those kinds here without
 *  altering the projection of the existing kinds. */
export async function hashStructureCandidates(
  candidates: readonly StructureCandidateV1[],
): Promise<string> {
  return sha256Hex(
    canonicalJson(
      candidates.map((c) => ({
        kind: c.kind,
        level: c.level,
        title: c.title,
        start: c.chars.start,
        end: c.chars.end,
      })),
    ),
  );
}
