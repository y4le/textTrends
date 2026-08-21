/** Pure generator logic for the bundled English common-word reference. */

export const STOPLIST_SIZE = 2_000;

// Keep these defaults aligned with the index recipe in
// packages/core/src/index/build.ts and numeral classification in
// packages/core/src/segment/intl.ts. The reference targets the default English
// recipe, including apostrophe normalization; other recipes may match less.
const NUMERAL_RE = /^\p{N}+(?:[.,\u00b7]\p{N}+)*$/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });

function normalizeRankedEntry(value) {
  return value
    .trim()
    .normalize('NFC')
    .replaceAll(/[’ʼ]/gu, "'")
    .toLocaleLowerCase('en')
    .normalize('NFC');
}

function parseRanking(contents) {
  if (typeof contents !== 'string') {
    throw new TypeError('ranked source contents must be a string');
  }
  const ranks = new Map();
  let rankedEntries = 0;
  let duplicateEntries = 0;
  for (const line of contents.split(/\r?\n/gu)) {
    const word = normalizeRankedEntry(line);
    if (word === '') continue;
    rankedEntries++;
    if (ranks.has(word)) duplicateEntries++;
    else ranks.set(word, rankedEntries);
  }
  return { ranks, rankedEntries, duplicateEntries };
}

/** True when the default index can emit the entire entry as one lexical key. */
export function isMatchableReferenceWord(value) {
  if (typeof value !== 'string' || value === '' || NUMERAL_RE.test(value)) return false;
  const parts = [...segmenter.segment(value)];
  return parts.length === 1
    && parts[0].isWordLike
    && parts[0].segment === value;
}

/** Select a bounded, unique, matchable prefix from an existing ranked list. */
export function stoplistFromRanking(contents, { size = STOPLIST_SIZE } = {}) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('stoplist size must be a positive safe integer');
  }
  const source = parseRanking(contents);
  const candidates = [];
  const skipped = [];
  for (const [word, rank] of source.ranks) {
    if (isMatchableReferenceWord(word)) candidates.push({ word, rank });
    else skipped.push({ word, rank });
  }
  if (candidates.length < size) {
    throw new RangeError(
      `only ${candidates.length} matchable reference words are available; need ${size}`,
    );
  }
  const selected = candidates.slice(0, size);
  const boundarySourceRank = selected.at(-1).rank;
  return {
    entries: selected.map(({ word }) => word),
    rankedEntries: source.rankedEntries,
    uniqueEntries: source.ranks.size,
    duplicateEntries: source.duplicateEntries,
    candidateCount: candidates.length,
    skippedEntries: skipped.length,
    skippedBeforeBoundary: skipped.filter(({ rank }) => rank <= boundarySourceRank).length,
    boundarySourceRank,
  };
}

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function renderStoplistModule(result) {
  const entries = result.entries.map((entry) => `  ${tsString(entry)},`).join('\n');
  return `/**
 * Generated English common-word reference; do not edit by hand.
 *
 * Locked ranked source: text/other/wordlists/common_words.txt
 * This module contains the first ${result.entries.length.toLocaleString('en-US')} entries that the default
 * English word segmenter emits as one lexical token. ${result.skippedBeforeBoundary} unmatchable entries
 * were skipped through source rank ${result.boundarySourceRank.toLocaleString('en-US')}.
 * Source status is documented in docs/design/corpus-inventory.md.
 * Refresh with \`pnpm update:stoplist\`.
 */
export const STOPLIST_EN_WORDS: readonly string[] = Object.freeze([
${entries}
]);
`;
}
