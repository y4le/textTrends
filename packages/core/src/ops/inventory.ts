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
export const INVENTORY_MIN_GROWTH_POINTS = 16;
export const INVENTORY_MAX_GROWTH_POINTS = 1_024;
export const INVENTORY_MAX_SECTIONS = 2_048;
export const INVENTORY_MAX_MATTR_WINDOW = 2_000;
export const INVENTORY_SCAN_CHUNK = 65_536;
/** One dense Uint32 count table is at most ~8 MiB. */
export const INVENTORY_MAX_VOCAB_TYPES = MATTR_MAX_TYPES;

export interface InventoryRequestV1 {
  readonly method: 'inventory/1';
  readonly rhythmBinsPerDoc: number;
  readonly growthPoints: number;
  readonly sections: boolean;
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
  readonly charsUtf16: number;
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

export interface InventoryGrowthV1 {
  readonly tokens: Uint32Array;
  readonly types: Uint32Array;
  /** Cumulative selected-token boundary after each document in `order`. */
  readonly documentEnds: readonly number[];
}

export interface InventorySectionInputV1 {
  readonly id: string;
  readonly doc: string;
  readonly level: number;
  readonly title?: string;
  readonly tokens: TokenRangeSpan;
}

export interface InventorySectionRowV1 extends InventorySectionInputV1 {
  readonly selectedTokens: number;
  readonly sentences: number;
  readonly sentenceMean: number | null;
  readonly types: number;
}

export interface InventorySectionsV1 {
  readonly rows: readonly InventorySectionRowV1[];
  /** True when more declared-order rows existed than the result cap admits. */
  readonly truncated: boolean;
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
  readonly growth: InventoryGrowthV1 | null;
  readonly sections: InventorySectionsV1 | null;
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
    request.growthPoints !== 0 &&
    (
      !Number.isSafeInteger(request.growthPoints) ||
      request.growthPoints < INVENTORY_MIN_GROWTH_POINTS ||
      request.growthPoints > INVENTORY_MAX_GROWTH_POINTS
    )
  ) {
    throw new RangeError(
      `growthPoints must be 0 or an integer in [${INVENTORY_MIN_GROWTH_POINTS}, ${INVENTORY_MAX_GROWTH_POINTS}]`,
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
  if (typeof request.sections !== 'boolean') {
    throw new RangeError('sections must be boolean');
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

async function buildGrowth(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  inputs: readonly InventoryDocumentInputV1[],
  requestedPoints: number,
  checkpoint: InventoryCheckpoint,
): Promise<InventoryGrowthV1> {
  const totalTokens = inputs.reduce((sum, input) => sum + input.counts.tokens, 0);
  const targets = new Set<number>([0, totalTokens]);
  for (let i = 1; i <= requestedPoints; i++) {
    targets.add(Math.ceil(totalTokens * i / requestedPoints));
  }
  const documentEnds: number[] = [];
  let boundary = 0;
  for (const input of inputs) {
    boundary += input.counts.tokens;
    documentEnds.push(boundary);
    targets.add(boundary);
  }
  const orderedTargets = [...targets].sort((a, b) => a - b);
  const outTokens: number[] = [];
  const outTypes: number[] = [];
  const seen = new Uint8Array(snapshot.vocabulary.keys.length);
  let types = 0;
  let consumed = 0;
  let targetCursor = 0;
  const emitReached = (): void => {
    while (
      targetCursor < orderedTargets.length &&
      (orderedTargets[targetCursor] as number) <= consumed
    ) {
      outTokens.push(orderedTargets[targetCursor] as number);
      outTypes.push(types);
      targetCursor++;
    }
  };
  emitReached();
  let sinceCheckpoint = 0;
  for (const input of inputs) {
    const runs = runsFor(selection, input.ref);
    for (const { start, end } of runs) {
      for (let position = start; position < end; position++) {
        const local = input.shard.tokenTypeIds[position] as number;
        const corpus = input.ref.localToCorpusType[local] as number;
        if (seen[corpus] === 0) {
          seen[corpus] = 1;
          types++;
        }
        consumed++;
        emitReached();
        if (++sinceCheckpoint >= INVENTORY_SCAN_CHUNK) {
          sinceCheckpoint = 0;
          await checkpoint();
        }
      }
    }
  }
  if (consumed !== totalTokens || targetCursor !== orderedTargets.length) {
    throw new Error('vocabulary-growth accounting invariant failed');
  }
  return {
    tokens: Uint32Array.from(outTokens),
    types: Uint32Array.from(outTypes),
    documentEnds,
  };
}

async function buildSections(
  selection: ResolvedSelection,
  byDoc: ReadonlyMap<string, InventoryDocumentInputV1>,
  sectionInputs: readonly InventorySectionInputV1[],
  reusableCounts: Uint32Array,
  checkpoint: InventoryCheckpoint,
): Promise<InventorySectionsV1> {
  const truncated = sectionInputs.length > INVENTORY_MAX_SECTIONS;
  const admittedInputs = sectionInputs.slice(0, INVENTORY_MAX_SECTIONS);
  reusableCounts.fill(0);
  let stamp = 0;
  const rows: InventorySectionRowV1[] = [];
  for (const section of admittedInputs) {
    const input = byDoc.get(section.doc);
    if (!input || !selection.docSet.has(input.ref.doc)) continue;
    const { start, end } = section.tokens;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      end > input.ref.tokenCount
    ) {
      throw new RangeError(`invalid section range [${start}, ${end}) for '${section.doc}'`);
    }
    const runs = runsFor(selection, input.ref, section.tokens);
    const selectedTokens = runs.reduce((sum, run) => sum + run.end - run.start, 0);
    const sentences = collectUnits(input.shard.sentenceBounds, runs);
    stamp++;
    if (stamp === 0xffff_ffff) {
      reusableCounts.fill(0);
      stamp = 1;
    }
    let types = 0;
    for (const run of runs) {
      for (let position = run.start; position < run.end; position++) {
        const local = input.shard.tokenTypeIds[position] as number;
        const corpus = input.ref.localToCorpusType[local] as number;
        if (reusableCounts[corpus] !== stamp) {
          reusableCounts[corpus] = stamp;
          types++;
        }
      }
    }
    rows.push({
      ...section,
      selectedTokens,
      sentences: sentences.count,
      sentenceMean: mean(sentences),
      types,
    });
    await checkpoint();
  }
  return { rows, truncated };
}

export async function inventory(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  inputs: readonly InventoryDocumentInputV1[],
  request: InventoryRequestV1,
  sectionInputs: readonly InventorySectionInputV1[],
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
  const byDoc = new Map<string, InventoryDocumentInputV1>();
  for (const input of inputs) {
    validateInput(snapshot, selection, input);
    byDoc.set(input.ref.doc, input);
  }

  const totalCounts = new Uint32Array(snapshot.vocabulary.keys.length);
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
    for (let i = 0; i < input.counts.typeIds.length; i++) {
      const typeId = input.counts.typeIds[i] as number;
      const count = input.counts.counts[i] as number;
      if (typeId >= totalCounts.length || count === 0) {
        throw new RangeError(`invalid sparse term count for '${input.ref.doc}'`);
      }
      const next = (totalCounts[typeId] as number) + count;
      if (next > 0xffff_ffff) throw new CapError('inventory term count exceeds Uint32');
      totalCounts[typeId] = next;
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
    });
    totalSentences += sentences.count;
    totalParagraphs += paragraphs.count;
    totalChars += charsUtf16;

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

  const growth = request.growthPoints === 0
    ? null
    : await buildGrowth(snapshot, selection, inputs, request.growthPoints, checkpoint);
  const sections = request.sections
    ? await buildSections(
        selection,
        byDoc,
        sectionInputs,
        // `types`/`hapax` were finalized above, so the section pass may reuse
        // and clear this otherwise-dead dense buffer as a generation stamp.
        totalCounts,
        checkpoint,
      )
    : null;
  await checkpoint();

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
    growth,
    sections,
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
  if (result.growth) {
    for (const view of [result.growth.tokens, result.growth.types]) {
      if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
    }
  }
  return [...buffers];
}
