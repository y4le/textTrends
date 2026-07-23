/**
 * Structure candidates — the format-neutral evidence a parser emits for the
 * structure phase to turn into a section table. Split out of `markdown.ts`
 * (where only the Markdown heading scan lived) so EPUB and HTML extractors can
 * contribute candidates of their own kinds without importing a Markdown module.
 *
 * A candidate is a char-anchored span in the extracted text (UTF-16 offsets,
 * text order). The per-candidate hash projection is FIXED across kinds — every
 * kind serializes as {kind, level, title, start, end} — so adding a kind never
 * disturbs another kind's candidate-set hash.
 */

import { canonicalJson, sha256Hex } from '../contract/hash.ts';

/** The candidate kinds. Markdown headings come from a text scan; an
 *  `epub-section` is a spine/nav document boundary the container yields (not
 *  recoverable from the joined text, hence a source-reconstructed recipe). */
export type StructureCandidateKind = 'md-heading-atx' | 'md-heading-setext' | 'epub-section';

export const STRUCTURE_CANDIDATE_KINDS: ReadonlySet<string> = new Set<StructureCandidateKind>([
  'md-heading-atx',
  'md-heading-setext',
  'epub-section',
]);

export interface StructureCandidateV1 {
  readonly kind: StructureCandidateKind;
  readonly level: number; // 1–6 as authored
  readonly title: string;
  readonly chars: { readonly start: number; readonly end: number };
}

/**
 * The deep ABI a single candidate must satisfy against the final extracted
 * text: a known kind, an integer level in 1–6, a string title, and a non-empty
 * in-range char span. Shared so the transformed-extraction builder enforces
 * EXACTLY what admission (`validate.ts`) later re-checks — a builder can never
 * mint an artifact its own validator would reject. Operates on `unknown` so
 * both a typed producer and an untrusted store record use one authority.
 */
export function isValidCandidate(v: unknown, textLength: number): v is StructureCandidateV1 {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (!STRUCTURE_CANDIDATE_KINDS.has(c.kind as string)) return false;
  if (typeof c.level !== 'number' || !Number.isSafeInteger(c.level) || c.level < 1 || c.level > 6) return false;
  if (typeof c.title !== 'string') return false;
  const chars = c.chars as Record<string, unknown> | null | undefined;
  if (chars === null || typeof chars !== 'object') return false;
  const { start, end } = chars as { start: unknown; end: unknown };
  return (
    typeof start === 'number' && typeof end === 'number' &&
    Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end > start && end <= textLength
  );
}

/**
 * Assert a candidate set is deeply well-formed AND in non-decreasing text
 * order against the final text. Cold literal extraction gets this for free (the
 * scanner emits ordered in-range spans); the transformed path applies it to an
 * adapter's externally-produced candidates before core hashes them. Throws
 * RangeError on the first violation.
 */
export function assertValidCandidates(
  candidates: readonly StructureCandidateV1[],
  textLength: number,
): void {
  let previousStart = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (!isValidCandidate(c, textLength)) {
      throw new RangeError(`candidate ${i} is not a well-formed in-range candidate (text length ${textLength})`);
    }
    if (c.chars.start < previousStart) {
      throw new RangeError(`candidate ${i} starts at ${c.chars.start}, before candidate ${i - 1} at ${previousStart} (must be text order)`);
    }
    previousStart = c.chars.start;
  }
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
