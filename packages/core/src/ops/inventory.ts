/**
 * inventory/1 — selection-scoped corpus and document overview.
 *
 * This operation folds the shared sparse per-document term-count vectors. It
 * never resolves vocabulary terms or caches an operation result. Sentences
 * and paragraphs use start-token ownership while retaining their full
 * canonical lengths; ranged MATTR is computed independently per contiguous
 * run and token-weighted, so gaps never invent adjacency.
 */

import { CapError } from '../contract/brands.ts';
import { tokenEndChar, type DocumentIndexV1 } from '../index/build.ts';
import { MATTR_MAX_TYPES, mattrIds } from '../stats/diversity.ts';
import type { CorpusDocRef, CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection, TokenRangeSpan } from '../snapshot/selection.ts';
import type { DocTermCountsV1 } from './term-counts.ts';
import { termCountRangeKey } from './term-counts.ts';

export const INVENTORY_MAX_RHYTHM_BINS_PER_DOC = 256;
export const INVENTORY_MAX_MATTR_WINDOW = 2_000;
export const INVENTORY_SCAN_CHUNK = 65_536;
/** One dense Uint32 count table is at most ~8 MiB. */
export const INVENTORY_MAX_VOCAB_TYPES = MATTR_MAX_TYPES;

export interface InventoryRequestV1 {
  readonly method: 'inventory/1';
  readonly rhythmBinsPerDoc: number;
  readonly mattrWindow: number;
}

export interface InventoryTotalsV1 {
  readonly selectedDocs: number;
  readonly expectedDocs: number;
  readonly missingDocs: number;
  readonly tokens: number;
  readonly lexicalTokens: number;
  readonly numeralTokens: number;
  readonly types: number;
  readonly hapax: number;
  readonly sentences: number;
  readonly paragraphs: number;
  /** Sum of each selected run's first-token-to-last-token source extent. */
  readonly charsUtf16: number;
  /** Unicode letters or decimal digits in normalized selected token keys. */
  readonly readabilityCharacters: number;
  /** Unicode letters in normalized selected token keys. */
  readonly readabilityLetters: number;
}

export interface InventoryDocumentRowV1 {
  readonly doc: string;
  readonly selectedTokens: number;
  readonly fullTokens: number;
  readonly lexicalTokens: number;
  readonly numeralTokens: number;
  readonly types: number;
  readonly hapax: number;
  readonly sentences: number;
  readonly paragraphs: number;
  readonly sentenceMean: number | null;
  readonly sentenceMedian: number | null;
  readonly sentenceP90: number | null;
  readonly paragraphMean: number | null;
  readonly ttr: number | null;
  readonly mattr: number | null;
  readonly mattrIsPlainTtr: boolean;
  readonly charsUtf16: number;
  readonly readabilityCharacters: number;
  readonly readabilityLetters: number;
}

export interface InventoryRhythmV1 {
  readonly binsPerDoc: number;
  readonly docOrdinal: Uint32Array;
  readonly binIndex: Uint32Array;
  readonly binStartToken: Uint32Array;
  readonly binTokens: Uint32Array;
  readonly sentences: Uint32Array;
  readonly sentenceMean: Float64Array;
  readonly sentenceMedian: Float64Array;
}

export interface InventoryDocumentInputV1 {
  readonly ref: CorpusDocRef;
  readonly shard: DocumentIndexV1;
  readonly counts: DocTermCountsV1;
}

export interface InventoryResultV1 {
  readonly method: 'inventory/1';
  readonly selection: ResolvedSelection['hash'];
  readonly order: readonly string[];
  readonly totals: InventoryTotalsV1;
  readonly documents: readonly InventoryDocumentRowV1[];
  readonly rhythm: InventoryRhythmV1 | null;
  readonly missingDocs: readonly string[];
  readonly mattrWindow: number;
}

export type InventoryCheckpoint = () => Promise<void>;

function validateRequest(request: InventoryRequestV1): void {
  if (request.method !== 'inventory/1') {
    throw new RangeError(`unknown inventory method '${String(request.method)}'`);
  }
  if (
    !Number.isSafeInteger(request.rhythmBinsPerDoc) ||
    request.rhythmBinsPerDoc < 0 ||
    request.rhythmBinsPerDoc > INVENTORY_MAX_RHYTHM_BINS_PER_DOC
  ) {
    throw new RangeError(
      `rhythmBinsPerDoc must be 0 or an integer in [1, ${INVENTORY_MAX_RHYTHM_BINS_PER_DOC}]`,
    );
  }
  if (
    !Number.isSafeInteger(request.mattrWindow) ||
    request.mattrWindow < 1 ||
    request.mattrWindow > INVENTORY_MAX_MATTR_WINDOW
  ) {
    throw new RangeError(
      `mattrWindow must be an integer in [1, ${INVENTORY_MAX_MATTR_WINDOW}]`,
    );
  }
}

function runsFor(
  selection: ResolvedSelection,
  ref: CorpusDocRef,
  clip?: TokenRangeSpan,
): readonly TokenRangeSpan[] {
  const base = selection.rangesByDoc.get(ref.doc) ??
    (ref.tokenCount === 0 ? [] : [{ start: 0, end: ref.tokenCount }]);
  if (!clip) return base;
  const runs: TokenRangeSpan[] = [];
  for (const range of base) {
    const start = Math.max(range.start, clip.start);
    const end = Math.min(range.end, clip.end);
    if (start < end) runs.push({ start, end });
  }
  return runs;
}

function containsStart(runs: readonly TokenRangeSpan[], token: number): boolean {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = runs[mid]!;
    if (token < range.start) hi = mid - 1;
    else if (token >= range.end) lo = mid + 1;
    else return true;
  }
  return false;
}

interface UnitHistogram {
  count: number;
  totalLength: number;
  readonly lengths: Map<number, number>;
}

function collectUnits(
  bounds: Uint32Array,
  runs: readonly TokenRangeSpan[],
  onOwned?: (start: number, length: number) => void,
): UnitHistogram {
  const histogram: UnitHistogram = {
    count: 0,
    totalLength: 0,
    lengths: new Map(),
  };
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i] as number;
    if (!containsStart(runs, start)) continue;
    const length = (bounds[i + 1] as number) - start;
    histogram.count++;
    histogram.totalLength += length;
    histogram.lengths.set(length, (histogram.lengths.get(length) ?? 0) + 1);
    onOwned?.(start, length);
  }
  return histogram;
}

function orderStatistic(histogram: UnitHistogram, rank: number): number {
  let cumulative = 0;
  for (const [length, count] of [...histogram.lengths].sort((a, b) => a[0] - b[0])) {
    cumulative += count;
    if (cumulative >= rank) return length;
  }
  throw new Error('unit histogram rank invariant failed');
}

function quantile(histogram: UnitHistogram, proportion: number): number | null {
  if (histogram.count === 0) return null;
  const rank = Math.max(1, Math.ceil(histogram.count * proportion));
  return orderStatistic(histogram, rank);
}

function median(histogram: UnitHistogram): number | null {
  if (histogram.count === 0) return null;
  const left = Math.floor((histogram.count + 1) / 2);
  const right = Math.ceil((histogram.count + 1) / 2);
  return (
    orderStatistic(histogram, left) +
    orderStatistic(histogram, right)
  ) / 2;
}

function mean(histogram: UnitHistogram): number | null {
  return histogram.count === 0 ? null : histogram.totalLength / histogram.count;
}

function selectedChars(shard: DocumentIndexV1, runs: readonly TokenRangeSpan[]): number {
  let total = 0;
  for (const { start, end } of runs) {
    total += tokenEndChar(shard, end - 1) - (shard.startsUtf16[start] as number);
  }
  return total;
}

const READABILITY_LETTER_RE = /\p{L}/u;
const READABILITY_DECIMAL_RE = /\p{Nd}/u;

function readabilityCounts(value: string): {
  readonly characters: number;
  readonly letters: number;
} {
  let characters = 0;
  let letters = 0;
  for (const point of value) {
    if (READABILITY_LETTER_RE.test(point)) {
      characters++;
      letters++;
    } else if (READABILITY_DECIMAL_RE.test(point)) {
      characters++;
    }
  }
  return { characters, letters };
}

function diversityForRuns(
  shard: DocumentIndexV1,
  runs: readonly TokenRangeSpan[],
  window: number,
): { value: number | null; isPlainTtr: boolean } {
  let tokens = 0;
  let weighted = 0;
  let isPlainTtr = false;
  for (const { start, end } of runs) {
    const length = end - start;
    if (length === 0) continue;
    tokens += length;
    weighted += mattrIds(shard.tokenTypeIds.subarray(start, end), window) * length;
    if (length <= window) isPlainTtr = true;
  }
  return {
    value: tokens === 0 ? null : weighted / tokens,
    isPlainTtr,
  };
}

function validateInput(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  input: InventoryDocumentInputV1,
): void {
  const { ref, shard, counts } = input;
  if (!selection.docSet.has(ref.doc)) {
    throw new RangeError(`inventory input '${ref.doc}' is outside the selection`);
  }
  if (
    counts.snapshot !== snapshot.id ||
    counts.doc !== ref.doc ||
    counts.rangeKey !== termCountRangeKey(
      selection.rangesByDoc.get(ref.doc) ?? null,
      ref.tokenCount,
    )
  ) {
    throw new RangeError(`term counts for '${ref.doc}' do not match the selection`);
  }
  if (
    counts.typeIds.length !== counts.counts.length ||
    shard.tokenTypeIds.length !== ref.tokenCount
  ) {
    throw new RangeError(`inventory input '${ref.doc}' has inconsistent arrays`);
  }
}

function selectedTokensIn(
  runs: readonly TokenRangeSpan[],
  start: number,
  end: number,
): number {
  let total = 0;
  for (const range of runs) {
    total += Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
  }
  return total;
}

export async function inventory(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  inputs: readonly InventoryDocumentInputV1[],
  request: InventoryRequestV1,
  checkpoint: InventoryCheckpoint,
): Promise<InventoryResultV1> {
  validateRequest(request);
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  if (snapshot.vocabulary.keys.length > INVENTORY_MAX_VOCAB_TYPES) {
    throw new CapError(
      `inventory vocabulary exceeds ${INVENTORY_MAX_VOCAB_TYPES} types`,
    );
  }
  if (
    inputs.length !== selection.spec.docs.length ||
    inputs.some((input, i) => input.ref.doc !== selection.spec.docs[i])
  ) {
    throw new RangeError('inventory inputs must follow exact selection order');
  }
  for (const input of inputs) {
    validateInput(snapshot, selection, input);
  }

  const totalCounts = new Uint32Array(snapshot.vocabulary.keys.length);
  const readabilityCharactersByType = new Uint32Array(
    snapshot.vocabulary.keys.length,
  );
  const readabilityLettersByType = new Uint32Array(
    snapshot.vocabulary.keys.length,
  );
  const readabilityMeasured = new Uint8Array(snapshot.vocabulary.keys.length);
  const documents: InventoryDocumentRowV1[] = [];
  const rhythmBins = request.rhythmBinsPerDoc;
  const rhythmDocOrdinal: number[] = [];
  const rhythmBinIndex: number[] = [];
  const rhythmBinStartToken: number[] = [];
  const rhythmBinTokens: number[] = [];
  const rhythmSentences: number[] = [];
  const rhythmSentenceMean: number[] = [];
  const rhythmSentenceMedian: number[] = [];
  let totalSentences = 0;
  let totalParagraphs = 0;
  let totalChars = 0;
  let totalReadabilityCharacters = 0;
  let totalReadabilityLetters = 0;
  let scannedTypes = 0;

  for (let docOrdinal = 0; docOrdinal < inputs.length; docOrdinal++) {
    const input = inputs[docOrdinal]!;
    const snapshotDocOrdinal = snapshot.docs.indexOf(input.ref);
    if (snapshotDocOrdinal < 0) {
      throw new RangeError(`inventory input '${input.ref.doc}' is not the snapshot's resident ref`);
    }
    const runs = runsFor(selection, input.ref);
    const sentenceBins: UnitHistogram[] = Array.from(
      { length: rhythmBins },
      () => ({ count: 0, totalLength: 0, lengths: new Map() }),
    );
    const width = input.ref.tokenCount === 0 || rhythmBins === 0
      ? 0
      : Math.ceil(input.ref.tokenCount / rhythmBins);
    const sentences = collectUnits(
      input.shard.sentenceBounds,
      runs,
      rhythmBins === 0
        ? undefined
        : (start, length) => {
            const bin = width === 0
              ? 0
              : Math.min(rhythmBins - 1, Math.floor(start / width));
            const histogram = sentenceBins[bin]!;
            histogram.count++;
            histogram.totalLength += length;
            histogram.lengths.set(
              length,
              (histogram.lengths.get(length) ?? 0) + 1,
            );
          },
    );
    const paragraphs = collectUnits(input.shard.paragraphBounds, runs);
    const charsUtf16 = selectedChars(input.shard, runs);
    const diversity = diversityForRuns(input.shard, runs, request.mattrWindow);
    let hapax = 0;
    let readabilityCharacters = 0;
    let readabilityLetters = 0;
    for (let i = 0; i < input.counts.typeIds.length; i++) {
      const typeId = input.counts.typeIds[i] as number;
      const count = input.counts.counts[i] as number;
      if (typeId >= totalCounts.length || count === 0) {
        throw new RangeError(`invalid sparse term count for '${input.ref.doc}'`);
      }
      const next = (totalCounts[typeId] as number) + count;
      if (next > 0xffff_ffff) throw new CapError('inventory term count exceeds Uint32');
      totalCounts[typeId] = next;
      if ((readabilityMeasured[typeId] as number) === 0) {
        const measured = readabilityCounts(
          snapshot.vocabulary.keys[typeId] as string,
        );
        readabilityCharactersByType[typeId] = measured.characters;
        readabilityLettersByType[typeId] = measured.letters;
        readabilityMeasured[typeId] = 1;
      }
      readabilityCharacters += count
        * (readabilityCharactersByType[typeId] as number);
      readabilityLetters += count
        * (readabilityLettersByType[typeId] as number);
      if (
        !Number.isSafeInteger(readabilityCharacters)
        || !Number.isSafeInteger(readabilityLetters)
      ) {
        throw new CapError('inventory readability count exceeds safe integer');
      }
      if (count === 1) hapax++;
      if (++scannedTypes >= INVENTORY_SCAN_CHUNK) {
        scannedTypes = 0;
        await checkpoint();
      }
    }
    const types = input.counts.typeIds.length;
    documents.push({
      doc: input.ref.doc,
      selectedTokens: input.counts.tokens,
      fullTokens: input.ref.tokenCount,
      lexicalTokens: input.counts.lexicalTokens,
      numeralTokens: input.counts.numeralTokens,
      types,
      hapax,
      sentences: sentences.count,
      paragraphs: paragraphs.count,
      sentenceMean: mean(sentences),
      sentenceMedian: median(sentences),
      sentenceP90: quantile(sentences, 0.9),
      paragraphMean: mean(paragraphs),
      ttr: input.counts.tokens === 0 ? null : types / input.counts.tokens,
      mattr: diversity.value,
      mattrIsPlainTtr: diversity.isPlainTtr,
      charsUtf16,
      readabilityCharacters,
      readabilityLetters,
    });
    totalSentences += sentences.count;
    totalParagraphs += paragraphs.count;
    totalChars += charsUtf16;
    totalReadabilityCharacters += readabilityCharacters;
    totalReadabilityLetters += readabilityLetters;
    if (
      !Number.isSafeInteger(totalReadabilityCharacters)
      || !Number.isSafeInteger(totalReadabilityLetters)
    ) {
      throw new CapError('inventory readability total exceeds safe integer');
    }

    for (let bin = 0; bin < rhythmBins; bin++) {
      const start = width === 0 ? 0 : Math.min(bin * width, input.ref.tokenCount);
      const end = width === 0
        ? 0
        : Math.min((bin + 1) * width, input.ref.tokenCount);
      const histogram = sentenceBins[bin]!;
      // Match trend/1 exactly: ordinals address snapshot.docs, even when the
      // selection contains only a later document.
      rhythmDocOrdinal.push(snapshotDocOrdinal);
      rhythmBinIndex.push(bin);
      rhythmBinStartToken.push(start);
      rhythmBinTokens.push(selectedTokensIn(runs, start, end));
      rhythmSentences.push(histogram.count);
      rhythmSentenceMean.push(mean(histogram) ?? Number.NaN);
      rhythmSentenceMedian.push(median(histogram) ?? Number.NaN);
    }
    await checkpoint();
  }

  let types = 0;
  let hapax = 0;
  for (let i = 0; i < totalCounts.length; i++) {
    const count = totalCounts[i] as number;
    if (count > 0) types++;
    if (count === 1) hapax++;
    if ((i + 1) % INVENTORY_SCAN_CHUNK === 0) await checkpoint();
  }

  const totals: InventoryTotalsV1 = {
    selectedDocs: inputs.length,
    expectedDocs: snapshot.expectedDocs.length,
    missingDocs: snapshot.missingDocs.length,
    tokens: inputs.reduce((sum, input) => sum + input.counts.tokens, 0),
    lexicalTokens: inputs.reduce((sum, input) => sum + input.counts.lexicalTokens, 0),
    numeralTokens: inputs.reduce((sum, input) => sum + input.counts.numeralTokens, 0),
    types,
    hapax,
    sentences: totalSentences,
    paragraphs: totalParagraphs,
    charsUtf16: totalChars,
    readabilityCharacters: totalReadabilityCharacters,
    readabilityLetters: totalReadabilityLetters,
  };
  return {
    method: 'inventory/1',
    selection: selection.hash,
    order: [...selection.spec.docs],
    totals,
    documents,
    rhythm: rhythmBins === 0
      ? null
      : {
          binsPerDoc: rhythmBins,
          docOrdinal: Uint32Array.from(rhythmDocOrdinal),
          binIndex: Uint32Array.from(rhythmBinIndex),
          binStartToken: Uint32Array.from(rhythmBinStartToken),
          binTokens: Uint32Array.from(rhythmBinTokens),
          sentences: Uint32Array.from(rhythmSentences),
          sentenceMean: Float64Array.from(rhythmSentenceMean),
          sentenceMedian: Float64Array.from(rhythmSentenceMedian),
        },
    missingDocs: [...snapshot.missingDocs],
    mattrWindow: request.mattrWindow,
  };
}

/** Explicit enumeration: cached term-count buffers never appear here. */
export function inventoryTransferBuffers(result: InventoryResultV1): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  if (result.rhythm) {
    for (const view of [
      result.rhythm.docOrdinal,
      result.rhythm.binIndex,
      result.rhythm.binStartToken,
      result.rhythm.binTokens,
      result.rhythm.sentences,
      result.rhythm.sentenceMean,
      result.rhythm.sentenceMedian,
    ]) {
      if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
    }
  }
  return [...buffers];
}
