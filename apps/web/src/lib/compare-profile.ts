/**
 * The Compare header's two-sided text profile.
 *
 * Every number here is folded from the two per-side `inventory/1` results the
 * Compare place already issues; nothing is estimated and no extra pass over
 * the corpus happens. Raw corpus totals provide context, while rates and means
 * make the two texts easier to compare despite differences in length.
 */

import {
  automatedReadabilityIndex,
  type InventoryDocumentRowV1,
  type InventoryResultV1,
} from '@texttrends/core';

export type CompareProfileFormat = 'count' | 'rate' | 'index';

export interface CompareProfileMetricV1 {
  readonly key: string;
  readonly label: string;
  readonly a: number | null;
  readonly b: number | null;
  readonly format: CompareProfileFormat;
  readonly explanation: string;
}

/**
 * MATTR across a multi-document side: the token-weighted mean of the
 * per-document values, never a MATTR over concatenated documents. Sliding a
 * diversity window across a book boundary would invent adjacency between the
 * last words of one text and the first of the next, and score that invention.
 * `inventory/1` already token-weights this way across the contiguous runs
 * inside one document; this is the same rule one level up.
 *
 * Documents whose MATTR degraded to a plain TTR (shorter than the window) are
 * excluded — mixing the two would silently average different measurements.
 */
export function sideMattr(
  documents: readonly InventoryDocumentRowV1[],
): number | null {
  let weighted = 0;
  let tokens = 0;
  for (const row of documents) {
    if (row.mattr === null || row.mattrIsPlainTtr || row.selectedTokens <= 0) {
      continue;
    }
    weighted += row.mattr * row.selectedTokens;
    tokens += row.selectedTokens;
  }
  return tokens === 0 ? null : weighted / tokens;
}

/** Hapax types per 1,000 types — a rate, unlike the raw hapax total. */
export function hapaxShare(result: InventoryResultV1): number | null {
  const { types, hapax } = result.totals;
  return types === 0 ? null : (hapax / types) * 1_000;
}

export function meanSentenceTokens(result: InventoryResultV1): number | null {
  const { tokens, sentences } = result.totals;
  return sentences === 0 ? null : tokens / sentences;
}

export function meanParagraphTokens(result: InventoryResultV1): number | null {
  const { tokens, paragraphs } = result.totals;
  return paragraphs === 0 ? null : tokens / paragraphs;
}

/**
 * ARI over the side's exact counts. `readabilityCharacters` counts Unicode
 * letters and decimal digits in normalized selected token keys; the sibling
 * `charsUtf16` is a source-span extent that includes separators and UTF-16
 * encoding width, so it cannot feed the formula.
 */
export function sideReadability(result: InventoryResultV1): number | null {
  const { tokens, sentences, readabilityCharacters } = result.totals;
  if (tokens === 0 || sentences === 0 || readabilityCharacters < tokens) return null;
  return automatedReadabilityIndex(readabilityCharacters, tokens, sentences);
}

const pick = (
  result: InventoryResultV1 | null,
  read: (value: InventoryResultV1) => number | null,
): number | null => (result === null ? null : read(result));

export function compareProfile(
  a: InventoryResultV1 | null,
  b: InventoryResultV1 | null,
): readonly CompareProfileMetricV1[] {
  return [
    {
      key: 'tokens',
      label: 'tokens',
      a: pick(a, (value) => value.totals.tokens),
      b: pick(b, (value) => value.totals.tokens),
      format: 'count',
      explanation: 'Word-like tokens selected on this side. Shown as context: it is the size of the text, so the two sides are not competing on it.',
    },
    {
      key: 'sentences',
      label: 'sentences',
      a: pick(a, (value) => value.totals.sentences),
      b: pick(b, (value) => value.totals.sentences),
      format: 'count',
      explanation: 'Sentence units found by the Unicode sentence segmenter. Context only, since a longer text has more of them.',
    },
    {
      key: 'paragraphs',
      label: 'paragraphs',
      a: pick(a, (value) => value.totals.paragraphs),
      b: pick(b, (value) => value.totals.paragraphs),
      format: 'count',
      explanation: 'Blank-line separated paragraphs. Context only, for the same reason as sentences.',
    },
    {
      key: 'types',
      label: 'distinct words',
      a: pick(a, (value) => value.totals.types),
      b: pick(b, (value) => value.totals.types),
      format: 'count',
      explanation: 'Distinct indexed forms. Vocabulary size grows with length and never levels off, so a longer text almost always shows more — read it as context, and use MATTR below to compare vocabulary richness.',
    },
    {
      key: 'mattr',
      label: 'MATTR',
      a: a === null ? null : sideMattr(a.documents),
      b: b === null ? null : sideMattr(b.documents),
      format: 'rate',
      explanation: 'Moving-average type/token ratio: vocabulary variety measured inside a fixed window and averaged, which removes the length dependence that makes a raw type/token ratio unusable across texts of different sizes. Higher means more varied.',
    },
    {
      key: 'hapax',
      label: 'hapax / 1k types',
      a: pick(a, hapaxShare),
      b: pick(b, hapaxShare),
      format: 'rate',
      explanation: 'How many out of every 1,000 distinct words occur exactly once. A high share points to a wide, lightly reused vocabulary.',
    },
    {
      key: 'sentence-length',
      label: 'tokens / sentence',
      a: pick(a, meanSentenceTokens),
      b: pick(b, meanSentenceTokens),
      format: 'rate',
      explanation: 'Mean sentence length in tokens. Dialogue-heavy fiction runs short here; the segmenter treats each quoted line as its own sentence.',
    },
    {
      key: 'paragraph-length',
      label: 'tokens / paragraph',
      a: pick(a, meanParagraphTokens),
      b: pick(b, meanParagraphTokens),
      format: 'rate',
      explanation: 'Mean paragraph length in tokens, from blank-line paragraph breaks in the source.',
    },
    {
      key: 'ari',
      label: 'ARI grade',
      a: pick(a, sideReadability),
      b: pick(b, sideReadability),
      format: 'index',
      explanation: 'Automated Readability Index, a US grade level from characters per word and words per sentence. It carries no syllable estimate, unlike the Flesch scores, but it is calibrated on expository prose — treat it as a rough register signal on fiction, not a reading age.',
    },
  ];
}
