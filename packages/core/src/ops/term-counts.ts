/**
 * Selection-scoped per-document term counts — the shared aggregation
 * primitive for inventory, frequency lists, and keyness.
 *
 * Whole-document execution reads posting-run lengths and therefore costs
 * O(local vocabulary), not O(tokens). Ranged execution scans only the
 * canonical selected token runs. Results are sparse, ordered by corpus type
 * id, and own fresh buffers suitable for a bounded executor cache (but never
 * for direct transfer).
 */

import { TOKEN_CLASS } from '../contract/recipes.ts';
import type { CorpusDocRef, CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { TokenRangeSpan } from '../snapshot/selection.ts';
import type { DocumentIndexV1 } from '../index/build.ts';

/** The dual hard bounds for the generation-scoped executor LRU. */
export const TERM_COUNT_CACHE_MAX_ENTRIES = 96;
export const TERM_COUNT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface DocTermCountsV1 {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly doc: CorpusDocRef['doc'];
  /** `*` for the whole document, otherwise canonical JSON of merged ranges. */
  readonly rangeKey: string;
  /** Strictly ascending corpus type ids present in this selected document. */
  readonly typeIds: Uint32Array;
  readonly counts: Uint32Array;
  readonly tokens: number;
  readonly lexicalTokens: number;
  readonly numeralTokens: number;
}

/** Payload bytes governed by the cache byte budget (keys/object headers are
 * bounded separately by the entry cap). */
export function termCountPayloadBytes(value: DocTermCountsV1): number {
  return value.typeIds.byteLength + value.counts.byteLength;
}

function validateRanges(
  ranges: readonly TokenRangeSpan[] | null,
  tokenCount: number,
): void {
  if (ranges === null) return;
  if (ranges.length === 0) {
    throw new RangeError('token-count ranges must be nonempty when present');
  }
  let previousEnd = -1;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) throw new RangeError(`ranges[${i}] is missing`);
    const { start, end } = range;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= end ||
      end > tokenCount
    ) {
      throw new RangeError(`invalid token-count range [${start}, ${end})`);
    }
    // ResolvedSelection merges overlap AND adjacency. Accepting either here
    // would admit a second noncanonical cache spelling for the same intent.
    if (start <= previousEnd) {
      throw new RangeError('token-count ranges must be canonical and non-adjacent');
    }
    previousEnd = end;
  }
}

export function termCountRangeKey(
  ranges: readonly TokenRangeSpan[] | null,
  tokenCount: number,
): string {
  validateRanges(ranges, tokenCount);
  return ranges === null
    ? '*'
    : JSON.stringify(ranges.map(({ start, end }) => [start, end]));
}

function validateBinding(
  snapshot: CorpusSnapshotV1,
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
): void {
  const resident = snapshot.docs.find((candidate) => candidate.doc === ref.doc);
  if (!resident) throw new RangeError(`document '${ref.doc}' is not in the snapshot`);
  if (
    resident.index !== ref.index ||
    resident.tokenCount !== ref.tokenCount ||
    resident.localToCorpusType !== ref.localToCorpusType
  ) {
    throw new RangeError(`document ref for '${ref.doc}' is not the snapshot's resident ref`);
  }
  if (
    shard.tokenTypeIds.length !== ref.tokenCount ||
    shard.vocabulary.length !== ref.localToCorpusType.length ||
    shard.postings.offsets.length !== shard.vocabulary.length + 1
  ) {
    throw new RangeError(`shard for '${ref.doc}' disagrees with its snapshot ref`);
  }
}

function wholeDocumentCounts(
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
): Omit<DocTermCountsV1, 'snapshot' | 'doc' | 'rangeKey'> {
  const rows: { typeId: number; count: number }[] = [];
  let lexicalTokens = 0;
  let numeralTokens = 0;
  const offsets = shard.postings.offsets;
  const positions = shard.postings.positions;
  for (let local = 0; local < shard.vocabulary.length; local++) {
    const from = offsets[local] as number;
    const to = offsets[local + 1] as number;
    const count = to - from;
    if (count === 0) continue;
    const firstPosition = positions[from] as number;
    const tokenClass = shard.tokenClasses[firstPosition] as number;
    if (tokenClass === TOKEN_CLASS.lexical) lexicalTokens += count;
    else if (tokenClass === TOKEN_CLASS.numeral) numeralTokens += count;
    else throw new RangeError(`unknown token class ${tokenClass} for local type ${local}`);
    rows.push({
      typeId: ref.localToCorpusType[local] as number,
      count,
    });
  }
  rows.sort((a, b) => a.typeId - b.typeId);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1]!.typeId === rows[i]!.typeId) {
      throw new RangeError(`snapshot translation for '${ref.doc}' aliases local types`);
    }
  }
  return {
    typeIds: Uint32Array.from(rows, (row) => row.typeId),
    counts: Uint32Array.from(rows, (row) => row.count),
    tokens: ref.tokenCount,
    lexicalTokens,
    numeralTokens,
  };
}

function rangedDocumentCounts(
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
  ranges: readonly TokenRangeSpan[],
): Omit<DocTermCountsV1, 'snapshot' | 'doc' | 'rangeKey'> {
  const byType = new Map<number, number>();
  let tokens = 0;
  let lexicalTokens = 0;
  let numeralTokens = 0;
  for (const { start, end } of ranges) {
    tokens += end - start;
    for (let position = start; position < end; position++) {
      const local = shard.tokenTypeIds[position] as number;
      const corpus = ref.localToCorpusType[local] as number;
      byType.set(corpus, (byType.get(corpus) ?? 0) + 1);
      const tokenClass = shard.tokenClasses[position] as number;
      if (tokenClass === TOKEN_CLASS.lexical) lexicalTokens++;
      else if (tokenClass === TOKEN_CLASS.numeral) numeralTokens++;
      else throw new RangeError(`unknown token class ${tokenClass} at token ${position}`);
    }
  }
  const ids = [...byType.keys()].sort((a, b) => a - b);
  return {
    typeIds: Uint32Array.from(ids),
    counts: Uint32Array.from(ids, (id) => byType.get(id) as number),
    tokens,
    lexicalTokens,
    numeralTokens,
  };
}

export function documentTermCounts(
  snapshot: CorpusSnapshotV1,
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
  ranges: readonly TokenRangeSpan[] | null,
): DocTermCountsV1 {
  validateBinding(snapshot, ref, shard);
  const rangeKey = termCountRangeKey(ranges, ref.tokenCount);
  const counts = ranges === null
    ? wholeDocumentCounts(ref, shard)
    : rangedDocumentCounts(ref, shard, ranges);
  return {
    snapshot: snapshot.id,
    doc: ref.doc,
    rangeKey,
    ...counts,
  };
}
