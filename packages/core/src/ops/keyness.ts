/**
 * keyness-g2-2x2/1 — a bounded two-selection comparison.
 *
 * Both sides fold the Slice-3 sparse per-document count vectors once for totals
 * and term ranges, then (when at least two positive parts exist) make one more
 * linear pass over those same materialized sparse vectors for dispersion. The
 * two sorted side vectors are merged linearly; no second counting kernel and no
 * dense type×document matrix is introduced.
 *
 * Three measurements ride along with the ranked table because they are exactly
 * as bounded as it is and answer questions the ranking cannot:
 *
 * - `divergence` (`jsd-log2/1`) sums over the SAME linear merge, before the
 *   filter and before paging, so it describes the two full class-filtered
 *   distributions rather than the visible page. It is the one number for "how
 *   far apart are these two selections", which no per-term row provides.
 * - `dpA`/`dpB` are Gries' deviation of proportions per side, folded in one
 *   extra pass over the already-materialized sparse vectors — no dense
 *   type×document matrix, keeping the bound in the paragraph above true. They
 *   separate a term spread through a side from one clumped in a single
 *   document, which is the classic keyness false positive.
 * - `logRatioLow`/`logRatioHigh` bound the effect size, separating a large
 *   ratio built on thousands of occurrences from one built on three.
 */

import { CapError, type ProjectDocId } from '../contract/brands.ts';
import { TOKEN_CLASS } from '../contract/recipes.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type {
  ResolvedSelection,
  TokenRangeSpan,
} from '../snapshot/selection.ts';
import { jsdContribution } from '../stats/divergence.ts';
import { g2Keyness, logRatioInterval } from '../stats/keyness.ts';
import {
  FREQUENCY_PAGE_MAX,
  type FrequencyTokenClassV1,
} from './frequency.ts';
import {
  INVENTORY_MAX_VOCAB_TYPES,
  type InventoryDocumentInputV1,
} from './inventory.ts';

export const KEYNESS_SCAN_CHUNK = 65_536;

export type KeynessSortFieldV1 = 'logRatio' | 'g2' | 'countA' | 'countB';
export type KeynessSideV1 = 'a' | 'b' | 'both';

export interface KeynessTableRequestV1 {
  readonly method: 'keyness-g2-2x2/1';
  readonly effect: 'log-ratio-halves/1';
  readonly filter: {
    readonly minCountTotal: number;
    readonly minDocFreqTotal: number;
    readonly classes: readonly FrequencyTokenClassV1[];
  };
  readonly sort: {
    readonly by: KeynessSortFieldV1;
    readonly dir: 1 | -1;
  };
  readonly page: {
    readonly offset: number;
    readonly limit: number;
  };
  readonly side: KeynessSideV1;
}

export interface KeynessSideTotalsV1 {
  readonly tokens: number;
  /** Every selected document, including one with zero tokens in the classes. */
  readonly documents: number;
  /**
   * Documents holding at least one class-filtered token — the parts Gries' DP
   * is measured over. Below two, per-term dispersion on this side is `null`
   * rather than a number, because one part has no proportions to deviate.
   */
  readonly positiveParts: number;
}

export interface KeynessRowV1 {
  readonly key: string;
  readonly typeId: number;
  readonly class: FrequencyTokenClassV1;
  readonly countA: number;
  readonly countB: number;
  readonly rateAper10k: number;
  readonly rateBper10k: number;
  readonly logRatio: number;
  /** Two-sided 95% Wald bounds on `logRatio`, same log₂ units. */
  readonly logRatioLow: number;
  readonly logRatioHigh: number;
  /** Signed in A's direction. */
  readonly g2: number;
  /** Per-side document frequency (“range” in corpus linguistics). */
  readonly rangeA: number;
  readonly rangeB: number;
  /**
   * Gries' DP over the side's documents: 0 spread exactly in proportion to
   * document sizes, →1 confined to one document. Null when the term is absent
   * from that side, or when the side has fewer than two positive-token parts
   * (a single-document side, where dispersion between documents is undefined
   * rather than zero).
   */
  readonly dpA: number | null;
  readonly dpB: number | null;
}

export interface KeynessDivergenceV1 {
  readonly method: 'jsd-log2/1';
  /** Jensen–Shannon divergence in bits, 0 identical … 1 fully disjoint. */
  readonly bits: number;
  /** Types summed over — every merged type, before filter and paging. */
  readonly types: number;
}

export interface KeynessResultV1 {
  readonly method: 'keyness-g2-2x2/1';
  readonly effect: 'log-ratio-halves/1';
  readonly selectionA: ResolvedSelection['hash'];
  readonly selectionB: ResolvedSelection['hash'];
  readonly totalsA: KeynessSideTotalsV1;
  readonly totalsB: KeynessSideTotalsV1;
  /** Whole-distribution distance; independent of filter, side, and paging. */
  readonly divergence: KeynessDivergenceV1;
  /** Passing rows after side projection, before paging. */
  readonly total: number;
  readonly rows: readonly KeynessRowV1[];
}

export type KeynessCheckpoint = () => Promise<void>;

function validateRequest(request: KeynessTableRequestV1): void {
  if (
    request.method !== 'keyness-g2-2x2/1' ||
    request.effect !== 'log-ratio-halves/1'
  ) {
    throw new RangeError('unknown keyness method');
  }
  if (
    !Number.isSafeInteger(request.filter.minCountTotal) ||
    request.filter.minCountTotal < 1 ||
    !Number.isSafeInteger(request.filter.minDocFreqTotal) ||
    request.filter.minDocFreqTotal < 1
  ) {
    throw new RangeError('keyness minimums must be positive safe integers');
  }
  if (
    !Array.isArray(request.filter.classes) ||
    request.filter.classes.length < 1 ||
    request.filter.classes.length > 2 ||
    new Set(request.filter.classes).size !== request.filter.classes.length ||
    request.filter.classes.some(
      (value) => value !== 'lexical' && value !== 'numeral',
    )
  ) {
    throw new RangeError('keyness classes must be a nonempty unique class list');
  }
  if (
    !['logRatio', 'g2', 'countA', 'countB'].includes(request.sort.by) ||
    (request.sort.dir !== 1 && request.sort.dir !== -1)
  ) {
    throw new RangeError('invalid keyness sort');
  }
  if (
    !Number.isSafeInteger(request.page.offset) ||
    request.page.offset < 0 ||
    !Number.isSafeInteger(request.page.limit) ||
    request.page.limit < 1 ||
    request.page.limit > FREQUENCY_PAGE_MAX ||
    !Number.isSafeInteger(request.page.offset + request.page.limit)
  ) {
    throw new RangeError('invalid keyness page');
  }
  if (request.side !== 'a' && request.side !== 'b' && request.side !== 'both') {
    throw new RangeError('invalid keyness side');
  }
}

function rangesFor(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  doc: ProjectDocId,
): readonly TokenRangeSpan[] {
  const ranged = selection.rangesByDoc.get(doc);
  if (ranged) return ranged;
  const ref = snapshot.docs.find((candidate) => candidate.doc === doc);
  if (!ref || ref.tokenCount === 0) return [];
  return [{ start: 0, end: ref.tokenCount }];
}

/**
 * Return the first overlapping document in snapshot order. Touching half-open
 * boundaries are disjoint. Whole-document selections are expanded only as a
 * view over the snapshot ref; no arrays proportional to token count are made.
 */
export function firstSelectionOverlap(
  snapshot: CorpusSnapshotV1,
  a: ResolvedSelection,
  b: ResolvedSelection,
): string | null {
  if (a.snapshot !== snapshot.id || b.snapshot !== snapshot.id) {
    throw new RangeError('keyness selections are bound to a different snapshot');
  }
  for (const ref of snapshot.docs) {
    if (!a.docSet.has(ref.doc) || !b.docSet.has(ref.doc)) continue;
    const left = rangesFor(snapshot, a, ref.doc);
    const right = rangesFor(snapshot, b, ref.doc);
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      const x = left[i]!;
      const y = right[j]!;
      if (x.start < y.end && y.start < x.end) return ref.doc;
      if (x.end <= y.start) i++;
      else j++;
    }
  }
  return null;
}

interface SideTerm {
  count: number;
  range: number;
  tokenClass: number;
  /** Σ|v_i − s_i| across the side's parts; halved to become Gries' DP. */
  dpSum: number;
}

interface SideFold {
  readonly terms: ReadonlyMap<number, SideTerm>;
  readonly ids: readonly number[];
  readonly tokens: number;
  readonly documents: number;
  readonly positiveParts: number;
}

function className(value: number): FrequencyTokenClassV1 {
  if (value === TOKEN_CLASS.lexical) return 'lexical';
  if (value === TOKEN_CLASS.numeral) return 'numeral';
  throw new RangeError(`unknown token class ${value}`);
}

async function foldSide(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  inputs: readonly InventoryDocumentInputV1[],
  wanted: ReadonlySet<FrequencyTokenClassV1>,
  checkpoint: KeynessCheckpoint,
): Promise<SideFold> {
  if (
    inputs.length !== selection.spec.docs.length ||
    inputs.some((input, index) => input.ref.doc !== selection.spec.docs[index])
  ) {
    throw new RangeError('keyness inputs must follow exact selection order');
  }
  const terms = new Map<number, SideTerm>();
  const partSizes: number[] = [];
  let tokens = 0;
  let scanned = 0;
  for (const input of inputs) {
    if (
      input.counts.snapshot !== snapshot.id ||
      input.counts.doc !== input.ref.doc ||
      input.counts.typeIds.length !== input.counts.counts.length
    ) {
      throw new RangeError(`keyness counts for '${input.ref.doc}' are inconsistent`);
    }
    const classByCorpus = new Map<number, number>();
    for (let local = 0; local < input.shard.vocabulary.length; local++) {
      const from = input.shard.postings.offsets[local] as number;
      const first = input.shard.postings.positions[from] as number;
      const typeId = input.ref.localToCorpusType[local] as number;
      classByCorpus.set(typeId, input.shard.tokenClasses[first] as number);
      if (++scanned >= KEYNESS_SCAN_CHUNK) {
        scanned = 0;
        await checkpoint();
      }
    }
    const partSize =
      (wanted.has('lexical') ? input.counts.lexicalTokens : 0) +
      (wanted.has('numeral') ? input.counts.numeralTokens : 0);
    partSizes.push(partSize);
    tokens += partSize;
    for (let i = 0; i < input.counts.typeIds.length; i++) {
      const typeId = input.counts.typeIds[i] as number;
      const count = input.counts.counts[i] as number;
      const tokenClass = classByCorpus.get(typeId);
      if (tokenClass === undefined || count < 1) {
        throw new RangeError(`invalid sparse keyness count for '${input.ref.doc}'`);
      }
      const cls = className(tokenClass);
      if (!wanted.has(cls)) continue;
      const current = terms.get(typeId);
      if (current) {
        if (current.tokenClass !== tokenClass) {
          throw new RangeError(`corpus type ${typeId} mixes token classes`);
        }
        current.count += count;
        current.range++;
      } else {
        terms.set(typeId, { count, range: 1, tokenClass, dpSum: 0 });
      }
      if (++scanned >= KEYNESS_SCAN_CHUNK) {
        scanned = 0;
        await checkpoint();
      }
    }
    await checkpoint();
  }

  let positiveParts = 0;
  for (const size of partSizes) if (size > 0) positiveParts++;

  // Second pass — Gries' DP, now that every term's side total is known. A
  // term's dpSum starts at Σ s_i = 1, the value it would have if it occurred
  // in no part at all (each part contributing |0 − s_i|); each part where it
  // DOES occur then swaps that absent contribution for the real one. Only
  // present entries are visited, so this stays a walk over the same sparse
  // vectors rather than a type×document matrix.
  if (positiveParts >= 2 && tokens > 0) {
    for (const term of terms.values()) term.dpSum = 1;
    for (let part = 0; part < inputs.length; part++) {
      const input = inputs[part]!;
      const share = (partSizes[part] as number) / tokens;
      for (let i = 0; i < input.counts.typeIds.length; i++) {
        const typeId = input.counts.typeIds[i] as number;
        const term = terms.get(typeId);
        // Absent means a class this request filtered out, not a missing count.
        if (term === undefined) continue;
        const proportion = (input.counts.counts[i] as number) / term.count;
        term.dpSum += Math.abs(proportion - share) - share;
        if (++scanned >= KEYNESS_SCAN_CHUNK) {
          scanned = 0;
          await checkpoint();
        }
      }
      await checkpoint();
    }
  }

  return {
    terms,
    ids: [...terms.keys()].sort((x, y) => x - y),
    tokens,
    documents: inputs.length,
    positiveParts,
  };
}

/** Halve the folded deviation sum into DP, clamped against rounding drift. */
function dispersionOf(term: SideTerm | undefined, positiveParts: number): number | null {
  if (term === undefined || positiveParts < 2) return null;
  return Math.min(1, Math.max(0, term.dpSum / 2));
}

function primary(row: KeynessRowV1, by: KeynessSortFieldV1): number {
  switch (by) {
    case 'logRatio': return row.logRatio;
    case 'g2': return row.g2;
    case 'countA': return row.countA;
    case 'countB': return row.countB;
  }
}

export async function keyness(
  snapshot: CorpusSnapshotV1,
  selectionA: ResolvedSelection,
  selectionB: ResolvedSelection,
  inputsA: readonly InventoryDocumentInputV1[],
  inputsB: readonly InventoryDocumentInputV1[],
  request: KeynessTableRequestV1,
  checkpoint: KeynessCheckpoint,
): Promise<KeynessResultV1> {
  validateRequest(request);
  if (
    selectionA.snapshot !== snapshot.id ||
    selectionB.snapshot !== snapshot.id
  ) {
    throw new RangeError('keyness selections are bound to a different snapshot');
  }
  const overlap = firstSelectionOverlap(snapshot, selectionA, selectionB);
  if (overlap !== null) {
    throw new RangeError(`keyness sides overlap in document '${overlap}'`);
  }
  if (snapshot.vocabulary.keys.length > INVENTORY_MAX_VOCAB_TYPES) {
    throw new CapError(
      `keyness vocabulary exceeds ${INVENTORY_MAX_VOCAB_TYPES} types`,
    );
  }
  const wanted = new Set(request.filter.classes);
  const a = await foldSide(snapshot, selectionA, inputsA, wanted, checkpoint);
  const b = await foldSide(snapshot, selectionB, inputsB, wanted, checkpoint);
  if (a.tokens === 0 || b.tokens === 0) {
    throw new RangeError('each keyness side must contain class-filtered tokens');
  }

  const rows: KeynessRowV1[] = [];
  let i = 0;
  let j = 0;
  let scanned = 0;
  let divergenceBits = 0;
  let divergenceTypes = 0;
  while (i < a.ids.length || j < b.ids.length) {
    const aid = a.ids[i] ?? Number.POSITIVE_INFINITY;
    const bid = b.ids[j] ?? Number.POSITIVE_INFINITY;
    const typeId = Math.min(aid, bid);
    const left = aid === typeId ? a.terms.get(typeId)! : undefined;
    const right = bid === typeId ? b.terms.get(typeId)! : undefined;
    if (left && right && left.tokenClass !== right.tokenClass) {
      throw new RangeError(`corpus type ${typeId} mixes token classes`);
    }
    const countA = left?.count ?? 0;
    const countB = right?.count ?? 0;
    const rangeA = left?.range ?? 0;
    const rangeB = right?.range ?? 0;
    // Every merged type, before the filter and before the side projection —
    // the divergence describes the distributions, not the visible table.
    divergenceBits += jsdContribution(countA / a.tokens, countB / b.tokens);
    divergenceTypes++;
    if (
      countA + countB >= request.filter.minCountTotal &&
      rangeA + rangeB >= request.filter.minDocFreqTotal
    ) {
      const interval = logRatioInterval(countA, a.tokens, countB, b.tokens);
      const effect = interval.centre;
      const evidence = g2Keyness(countA, a.tokens, countB, b.tokens);
      if (
        request.side === 'both' ||
        (request.side === 'a' && effect > 0) ||
        (request.side === 'b' && effect < 0)
      ) {
        rows.push({
          key: snapshot.vocabulary.keys[typeId] as string,
          typeId,
          class: className((left ?? right)!.tokenClass),
          countA,
          countB,
          rateAper10k: countA / a.tokens * 10_000,
          rateBper10k: countB / b.tokens * 10_000,
          logRatio: effect,
          logRatioLow: interval.low,
          logRatioHigh: interval.high,
          g2: evidence,
          rangeA,
          rangeB,
          dpA: dispersionOf(left, a.positiveParts),
          dpB: dispersionOf(right, b.positiveParts),
        });
      }
    }
    if (aid === typeId) i++;
    if (bid === typeId) j++;
    if (++scanned >= KEYNESS_SCAN_CHUNK) {
      scanned = 0;
      await checkpoint();
    }
  }

  rows.sort((x, y) => {
    const byRequested =
      (primary(x, request.sort.by) - primary(y, request.sort.by)) *
      request.sort.dir;
    if (byRequested !== 0) return byRequested;
    if (x.g2 !== y.g2) return y.g2 - x.g2;
    const combinedX = x.countA + x.countB;
    const combinedY = y.countA + y.countB;
    if (combinedX !== combinedY) return combinedY - combinedX;
    return x.typeId - y.typeId;
  });
  await checkpoint();

  return {
    method: 'keyness-g2-2x2/1',
    effect: 'log-ratio-halves/1',
    selectionA: selectionA.hash,
    selectionB: selectionB.hash,
    totalsA: {
      tokens: a.tokens,
      documents: a.documents,
      positiveParts: a.positiveParts,
    },
    totalsB: {
      tokens: b.tokens,
      documents: b.documents,
      positiveParts: b.positiveParts,
    },
    divergence: {
      method: 'jsd-log2/1',
      bits: Math.min(1, Math.max(0, divergenceBits)),
      types: divergenceTypes,
    },
    total: rows.length,
    rows: rows.slice(request.page.offset, request.page.offset + request.page.limit),
  };
}
