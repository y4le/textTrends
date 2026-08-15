/**
 * Readability — character-based indices only (`readability-chars/1`).
 * Spec: docs/design/statistics.md §Readability.
 *
 * ARI and Coleman–Liau are implemented here and the syllable-based Flesch
 * family deliberately is NOT. Flesch and Flesch–Kincaid need a per-word
 * syllable count, which is a heuristic with a language pack and an error band;
 * the spec already argues (statistics.md §Readability) that the
 * character-based indices carry no syllable error and are the ones to prefer
 * for cross-document comparison.
 *
 * The two formulas deliberately do not share a character-count parameter:
 * this version of ARI uses Unicode letters and decimal digits, while
 * Coleman–Liau uses Unicode letters only. Punctuation, separators, and UTF-16
 * encoding width are outside both counts. Callers must measure the appropriate
 * quantity rather than feeding either formula a raw source-span length.
 *
 * Both scales are reported in US grade levels and both are calibrated on
 * expository prose. Neither is meaningful on a handful of sentences, so the
 * callers publish them only alongside the sentence count they were built from.
 */

function validateCounts(
  characters: number,
  words: number,
  sentences: number,
  requireOnePerWord: boolean,
): void {
  for (const value of [characters, words, sentences]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('readability counts must be non-negative safe integers');
    }
  }
  if (words <= 0 || sentences <= 0) {
    throw new RangeError('readability needs at least one word and one sentence');
  }
  if (requireOnePerWord && characters < words) {
    throw new RangeError('character count cannot be below the word count');
  }
  if (sentences > words) {
    throw new RangeError('sentence count cannot exceed the word count');
  }
}

/**
 * Automated Readability Index: `4.71·(chars/words) + 0.5·(words/sentences) − 21.43`.
 *
 * @param characters Unicode letters and decimal digits; no punctuation,
 *                   separators, or UTF-16 encoding width
 * @param words     word-like tokens
 * @param sentences sentence units
 */
export function automatedReadabilityIndex(
  characters: number,
  words: number,
  sentences: number,
): number {
  validateCounts(characters, words, sentences, true);
  return 4.71 * (characters / words) + 0.5 * (words / sentences) - 21.43;
}

/**
 * Coleman–Liau index: `0.0588·L − 0.296·S − 15.8`, where `L` is Unicode
 * letters per 100 words and `S` is sentences per 100 words. It shares ARI's
 * character-length signal but responds differently to sentence length.
 */
export function colemanLiauIndex(
  letters: number,
  words: number,
  sentences: number,
): number {
  validateCounts(letters, words, sentences, false);
  const lettersPerHundred = (letters / words) * 100;
  const sentencesPerHundred = (sentences / words) * 100;
  return 0.0588 * lettersPerHundred - 0.296 * sentencesPerHundred - 15.8;
}
