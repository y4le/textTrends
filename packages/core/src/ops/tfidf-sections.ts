/**
 * tfidf-sections/1 — distinctive labels for one document's structure.
 *
 * This is deliberately selection-independent. Eligible section document
 * frequency is established in one pass; a second pass computes only bounded
 * top-k labels, so no sections×types matrix is retained.
 */

import { CapError, V1_CAPS } from '../contract/brands.ts';
import type { DocumentIndexV1 } from '../index/build.ts';
import type { CorpusDocRef, CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { TokenRangeSpan } from '../snapshot/selection.ts';
import { INVENTORY_MAX_VOCAB_TYPES } from './inventory.ts';

export const TFIDF_MAX_SECTIONS = 2_048;
export const TFIDF_MAX_TOP_K = 10;
export const TFIDF_MAX_MIN_SECTION_TOKENS = V1_CAPS.maxDocTokens;
export const TFIDF_SCAN_CHUNK = 65_536;
export const TFIDF_MAX_VOCAB_TYPES = INVENTORY_MAX_VOCAB_TYPES;

export interface TfidfSectionsRequestV1 {
  readonly method: 'tfidf-sections/1';
  readonly doc: string;
  readonly level: number;
  readonly minSectionTokens: number;
  readonly topK: number;
}

export interface TfidfSectionInputV1 {
  readonly id: string;
  readonly doc: string;
  readonly level: number;
  readonly title?: string;
  readonly tokens: TokenRangeSpan;
}

export interface TfidfLabelV1 {
  readonly key: string;
  readonly typeId: number;
  readonly count: number;
  readonly weight: number;
}

export interface TfidfSectionResultRowV1 extends TfidfSectionInputV1 {
  readonly eligible: boolean;
  readonly labels: readonly TfidfLabelV1[];
}

export interface TfidfSectionsResultV1 {
  readonly method: 'tfidf-sections/1';
  readonly doc: string;
  readonly structure: CorpusDocRef['structure'];
  readonly index: CorpusDocRef['index'];
  readonly eligibleSections: number;
  readonly sections: readonly TfidfSectionResultRowV1[];
}

export type TfidfCheckpoint = () => Promise<void>;

function validateRequest(request: TfidfSectionsRequestV1): void {
  if (request.method !== 'tfidf-sections/1') {
    throw new RangeError(`unknown TF-IDF method '${String(request.method)}'`);
  }
  if (
    typeof request.doc !== 'string' ||
    request.doc === '' ||
    !Number.isSafeInteger(request.minSectionTokens) ||
    request.minSectionTokens < 1 ||
    request.minSectionTokens > TFIDF_MAX_MIN_SECTION_TOKENS ||
    !Number.isSafeInteger(request.topK) ||
    request.topK < 1 ||
    request.topK > TFIDF_MAX_TOP_K ||
    !Number.isSafeInteger(request.level) ||
    request.level < 0
  ) {
    throw new RangeError('invalid TF-IDF section request');
  }
}

function validateSection(
  section: TfidfSectionInputV1,
  doc: string,
  tokenCount: number,
): void {
  const { start, end } = section.tokens;
  if (
    section.doc !== doc ||
    typeof section.id !== 'string' ||
    section.id === '' ||
    !Number.isSafeInteger(section.level) ||
    section.level < 0 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end > tokenCount
  ) {
    throw new RangeError(`invalid TF-IDF section '${section.id}'`);
  }
}

export async function tfidfSections(
  snapshot: CorpusSnapshotV1,
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
  sections: readonly TfidfSectionInputV1[],
  request: TfidfSectionsRequestV1,
  checkpoint: TfidfCheckpoint,
): Promise<TfidfSectionsResultV1> {
  validateRequest(request);
  if (ref.doc !== request.doc || !snapshot.docs.includes(ref)) {
    throw new RangeError(`TF-IDF document '${request.doc}' is outside the snapshot`);
  }
  if (
    shard.tokenTypeIds.length !== ref.tokenCount ||
    shard.vocabulary.length !== ref.localToCorpusType.length
  ) {
    throw new RangeError(`TF-IDF shard for '${request.doc}' disagrees with its snapshot ref`);
  }
  if (snapshot.vocabulary.keys.length > TFIDF_MAX_VOCAB_TYPES) {
    throw new CapError(`TF-IDF vocabulary exceeds ${TFIDF_MAX_VOCAB_TYPES} types`);
  }
  if (sections.length > TFIDF_MAX_SECTIONS) {
    throw new CapError(`TF-IDF sections exceed ${TFIDF_MAX_SECTIONS}`);
  }
  for (const section of sections) validateSection(section, request.doc, ref.tokenCount);
  const selected = sections.filter((section) => section.level === request.level);
  const eligible = selected.map(
    (section) => section.tokens.end - section.tokens.start >= request.minSectionTokens,
  );
  const eligibleSections = eligible.filter(Boolean).length;

  const documentFrequency = new Uint32Array(snapshot.vocabulary.keys.length);
  const seenStamp = new Uint32Array(snapshot.vocabulary.keys.length);
  let stamp = 0;
  let scanned = 0;
  for (let sectionIndex = 0; sectionIndex < selected.length; sectionIndex++) {
    if (!eligible[sectionIndex]) continue;
    stamp++;
    const section = selected[sectionIndex]!;
    for (let position = section.tokens.start; position < section.tokens.end; position++) {
      const local = shard.tokenTypeIds[position] as number;
      const corpus = ref.localToCorpusType[local] as number;
      if (seenStamp[corpus] !== stamp) {
        seenStamp[corpus] = stamp;
        documentFrequency[corpus] = (documentFrequency[corpus] as number) + 1;
      }
      if (++scanned >= TFIDF_SCAN_CHUNK) {
        scanned = 0;
        await checkpoint();
      }
    }
    await checkpoint();
  }

  const termCounts = new Uint32Array(snapshot.vocabulary.keys.length);
  const rows: TfidfSectionResultRowV1[] = [];
  for (let sectionIndex = 0; sectionIndex < selected.length; sectionIndex++) {
    const section = selected[sectionIndex]!;
    if (!eligible[sectionIndex]) {
      rows.push({ ...section, eligible: false, labels: [] });
      continue;
    }
    const touched: number[] = [];
    for (let position = section.tokens.start; position < section.tokens.end; position++) {
      const local = shard.tokenTypeIds[position] as number;
      const corpus = ref.localToCorpusType[local] as number;
      if (termCounts[corpus] === 0) touched.push(corpus);
      termCounts[corpus] = (termCounts[corpus] as number) + 1;
      if (++scanned >= TFIDF_SCAN_CHUNK) {
        scanned = 0;
        await checkpoint();
      }
    }
    const labels: TfidfLabelV1[] = [];
    for (const typeId of touched) {
      const count = termCounts[typeId] as number;
      const df = documentFrequency[typeId] as number;
      const weight = count * Math.log(eligibleSections / df);
      // A corpus-ubiquitous term has exactly zero weight. Excluding it is the
      // language/rights-neutral self-stop-list property of TF-IDF.
      if (weight > 0) {
        labels.push({
          key: snapshot.vocabulary.keys[typeId] as string,
          typeId,
          count,
          weight,
        });
      }
      termCounts[typeId] = 0;
    }
    labels.sort((a, b) =>
      b.weight - a.weight ||
      b.count - a.count ||
      a.typeId - b.typeId);
    rows.push({
      ...section,
      eligible: true,
      labels: labels.slice(0, request.topK),
    });
    await checkpoint();
  }

  return {
    method: 'tfidf-sections/1',
    doc: request.doc,
    structure: ref.structure,
    index: ref.index,
    eligibleSections,
    sections: rows,
  };
}
