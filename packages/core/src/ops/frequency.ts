/**
 * freq-list/1 — chunked, selection-scoped ranked vocabulary.
 *
 * Counts come exclusively from the shared sparse per-document vectors.
 * Dispersion uses selected documents as parts without retaining a dense
 * types×documents matrix: a second sparse pass accumulates each present
 * cell's correction to the all-absent DP baseline.
 */

import { CapError } from '../contract/brands.ts';
import { TOKEN_CLASS } from '../contract/recipes.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import {
  INVENTORY_MAX_VOCAB_TYPES,
  type InventoryDocumentInputV1,
} from './inventory.ts';

export const FREQUENCY_PAGE_MAX = 200;
export const FREQUENCY_WINDOW_MAX = 5_000;
export const FREQUENCY_PREFIX_MAX_UNITS = 64;
export const FREQUENCY_SCAN_CHUNK = 65_536;

export type FrequencyTokenClassV1 = 'lexical' | 'numeral';
export type FrequencySortFieldV1 =
  | 'count'
  | 'docFreq'
  | 'dp'
  | 'dpNorm'
  | 'ratePer10k'
  | 'class'
  | 'key';

export interface FrequencyListRequestV1 {
  readonly method: 'freq-list/1';
  readonly filter: {
    readonly minCount: number;
    readonly minDocFreq: number;
    readonly classes: readonly FrequencyTokenClassV1[];
    readonly prefixNfc?: string;
  };
  readonly sort: {
    readonly by: FrequencySortFieldV1;
    readonly dir: 1 | -1;
  };
  readonly page: {
    readonly offset: number;
    readonly limit: number;
  };
  readonly dispersion: boolean;
}

export interface FrequencyListRowV1 {
  readonly key: string;
  readonly typeId: number;
  readonly class: FrequencyTokenClassV1;
  readonly count: number;
  readonly ratePer10k: number;
  readonly docFreq: number;
  readonly dp: number | null;
  readonly dpNorm: number | null;
}

export interface FrequencyListResultV1 {
  readonly method: 'freq-list/1';
  readonly selection: ResolvedSelection['hash'];
  readonly total: number;
  readonly totalTokens: number;
  /** Number of selected document parts (including zero-token parts). */
  readonly parts: number;
  readonly rows: readonly FrequencyListRowV1[];
}

export type FrequencyCheckpoint = () => Promise<void>;

function validateRequest(request: FrequencyListRequestV1): void {
  if (request.method !== 'freq-list/1') {
    throw new RangeError(`unknown frequency method '${String(request.method)}'`);
  }
  if (
    !Number.isSafeInteger(request.filter.minCount) ||
    request.filter.minCount < 1 ||
    !Number.isSafeInteger(request.filter.minDocFreq) ||
    request.filter.minDocFreq < 1
  ) {
    throw new RangeError('frequency minimum counts must be positive safe integers');
  }
  if (
    !Array.isArray(request.filter.classes) ||
    request.filter.classes.length < 1 ||
    request.filter.classes.length > 2 ||
    new Set(request.filter.classes).size !== request.filter.classes.length ||
    request.filter.classes.some((value) => value !== 'lexical' && value !== 'numeral')
  ) {
    throw new RangeError('frequency classes must be a nonempty unique class list');
  }
  const prefix = request.filter.prefixNfc;
  if (
    prefix !== undefined &&
    (
      typeof prefix !== 'string' ||
      prefix.length < 1 ||
      prefix.length > FREQUENCY_PREFIX_MAX_UNITS ||
      prefix.normalize('NFC') !== prefix
    )
  ) {
    throw new RangeError(
      `prefixNfc must be NFC with 1..${FREQUENCY_PREFIX_MAX_UNITS} UTF-16 units`,
    );
  }
  if (
    !['count', 'docFreq', 'dp', 'dpNorm', 'ratePer10k', 'class', 'key']
      .includes(request.sort.by) ||
    (request.sort.dir !== 1 && request.sort.dir !== -1) ||
    (
      !request.dispersion &&
      (request.sort.by === 'dp' || request.sort.by === 'dpNorm')
    )
  ) {
    throw new RangeError('invalid frequency sort');
  }
  if (
    !Number.isSafeInteger(request.page.offset) ||
    request.page.offset < 0 ||
    !Number.isSafeInteger(request.page.limit) ||
    request.page.limit < 1 ||
    request.page.limit > FREQUENCY_PAGE_MAX ||
    !Number.isSafeInteger(request.page.offset + request.page.limit)
  ) {
    throw new RangeError(
      `frequency page must have limit 1..${FREQUENCY_PAGE_MAX} and a safe offset`,
    );
  }
  if (typeof request.dispersion !== 'boolean') {
    throw new RangeError('dispersion must be boolean');
  }
}

function className(value: number): FrequencyTokenClassV1 {
  if (value === TOKEN_CLASS.lexical) return 'lexical';
  if (value === TOKEN_CLASS.numeral) return 'numeral';
  throw new RangeError(`unknown token class ${value}`);
}

function selectedClassTokens(
  input: InventoryDocumentInputV1,
  lexical: boolean,
  numeral: boolean,
): number {
  return (
    (lexical ? input.counts.lexicalTokens : 0) +
    (numeral ? input.counts.numeralTokens : 0)
  );
}

export async function frequencyList(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  inputs: readonly InventoryDocumentInputV1[],
  request: FrequencyListRequestV1,
  checkpoint: FrequencyCheckpoint,
): Promise<FrequencyListResultV1> {
  validateRequest(request);
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  if (snapshot.vocabulary.keys.length > INVENTORY_MAX_VOCAB_TYPES) {
    throw new CapError(
      `frequency vocabulary exceeds ${INVENTORY_MAX_VOCAB_TYPES} types`,
    );
  }
  if (
    inputs.length !== selection.spec.docs.length ||
    inputs.some((input, i) => input.ref.doc !== selection.spec.docs[i])
  ) {
    throw new RangeError('frequency inputs must follow exact selection order');
  }

  const vocabularySize = snapshot.vocabulary.keys.length;
  const counts = new Uint32Array(vocabularySize);
  const docFreq = new Uint32Array(vocabularySize);
  const classes = new Uint8Array(vocabularySize);
  let scanned = 0;
  for (const input of inputs) {
    if (
      input.counts.snapshot !== snapshot.id ||
      input.counts.doc !== input.ref.doc ||
      input.counts.typeIds.length !== input.counts.counts.length
    ) {
      throw new RangeError(`frequency counts for '${input.ref.doc}' are inconsistent`);
    }
    // Establish the corpus type's one admitted token class from local posting
    // runs. validateShardStructure pins class uniformity within each type.
    for (let local = 0; local < input.shard.vocabulary.length; local++) {
      const from = input.shard.postings.offsets[local] as number;
      const first = input.shard.postings.positions[from] as number;
      const cls = input.shard.tokenClasses[first] as number;
      const corpus = input.ref.localToCorpusType[local] as number;
      if (classes[corpus] !== 0 && classes[corpus] !== cls) {
        throw new RangeError(`corpus type ${corpus} mixes token classes`);
      }
      classes[corpus] = cls;
    }
    for (let i = 0; i < input.counts.typeIds.length; i++) {
      const typeId = input.counts.typeIds[i] as number;
      const count = input.counts.counts[i] as number;
      if (typeId >= vocabularySize || count === 0) {
        throw new RangeError(`invalid sparse frequency count for '${input.ref.doc}'`);
      }
      const next = (counts[typeId] as number) + count;
      if (next > 0xffff_ffff) throw new RangeError('frequency count exceeds Uint32');
      counts[typeId] = next;
      docFreq[typeId] = (docFreq[typeId] as number) + 1;
      if (++scanned >= FREQUENCY_SCAN_CHUNK) {
        scanned = 0;
        await checkpoint();
      }
    }
    await checkpoint();
  }

  const wantLexical = request.filter.classes.includes('lexical');
  const wantNumeral = request.filter.classes.includes('numeral');
  const partSizes = inputs.map((input) =>
    selectedClassTokens(input, wantLexical, wantNumeral));
  const totalTokens = partSizes.reduce((sum, value) => sum + value, 0);
  const partShares = totalTokens === 0
    ? []
    : partSizes.map((value) => value / totalTokens);
  const positiveShares = partShares.filter((value) => value > 0);

  const dpCorrection = request.dispersion
    ? new Float64Array(vocabularySize)
    : null;
  if (dpCorrection && positiveShares.length >= 2) {
    for (let doc = 0; doc < inputs.length; doc++) {
      const input = inputs[doc]!;
      const sizeShare = (partSizes[doc] as number) / totalTokens;
      for (let i = 0; i < input.counts.typeIds.length; i++) {
        const typeId = input.counts.typeIds[i] as number;
        const cls = className(classes[typeId] as number);
        if (
          (cls === 'lexical' && !wantLexical) ||
          (cls === 'numeral' && !wantNumeral)
        ) {
          continue;
        }
        const occurrenceShare =
          (input.counts.counts[i] as number) / (counts[typeId] as number);
        // Baseline is the absent contribution sizeShare. Replace it with the
        // present cell's |occurrenceShare-sizeShare|.
        dpCorrection[typeId] =
          (dpCorrection[typeId] as number) +
          Math.abs(occurrenceShare - sizeShare) -
          sizeShare;
        if (++scanned >= FREQUENCY_SCAN_CHUNK) {
          scanned = 0;
          await checkpoint();
        }
      }
      await checkpoint();
    }
  }

  const minPartShare = partShares.length === 0
    ? 0
    : Math.min(...partShares);
  const candidates: FrequencyListRowV1[] = [];
  for (let typeId = 0; typeId < vocabularySize; typeId++) {
    if ((typeId + 1) % FREQUENCY_SCAN_CHUNK === 0) await checkpoint();
    const count = counts[typeId] as number;
    if (
      count < request.filter.minCount ||
      (docFreq[typeId] as number) < request.filter.minDocFreq
    ) {
      continue;
    }
    const cls = className(classes[typeId] as number);
    if (
      (cls === 'lexical' && !wantLexical) ||
      (cls === 'numeral' && !wantNumeral)
    ) {
      continue;
    }
    const key = snapshot.vocabulary.keys[typeId] as string;
    if (request.filter.prefixNfc !== undefined && !key.startsWith(request.filter.prefixNfc)) {
      continue;
    }
    let dispersion: number | null = null;
    let normalized: number | null = null;
    if (request.dispersion) {
      if (positiveShares.length < 2) {
        dispersion = 0;
      } else {
        dispersion = Math.max(0, Math.min(1, 0.5 * (1 + (dpCorrection![typeId] as number))));
        normalized = dispersion / (1 - minPartShare);
      }
    }
    candidates.push({
      key,
      typeId,
      class: cls,
      count,
      ratePer10k: totalTokens === 0 ? 0 : count / totalTokens * 10_000,
      docFreq: docFreq[typeId] as number,
      dp: dispersion,
      dpNorm: normalized,
    });
  }

  const value = (row: FrequencyListRowV1): number => {
    switch (request.sort.by) {
      case 'count': return row.count;
      case 'docFreq': return row.docFreq;
      case 'dp': return row.dp ?? Number.NEGATIVE_INFINITY;
      case 'dpNorm': return row.dpNorm ?? Number.NEGATIVE_INFINITY;
      case 'ratePer10k': return row.ratePer10k;
      case 'class': return row.class === 'lexical' ? 0 : 1;
      case 'key': return 0;
    }
  };
  candidates.sort((a, b) => {
    let primary: number;
    if (request.sort.by === 'key') {
      const left = a.key.toLowerCase();
      const right = b.key.toLowerCase();
      primary = (left < right ? -1 : left > right ? 1 : 0) * request.sort.dir;
    } else {
      primary = (value(a) - value(b)) * request.sort.dir;
    }
    if (primary !== 0) return primary;
    if (a.count !== b.count) return b.count - a.count;
    return a.typeId - b.typeId;
  });
  await checkpoint();

  return {
    method: 'freq-list/1',
    selection: selection.hash,
    total: candidates.length,
    totalTokens,
    parts: inputs.length,
    rows: candidates.slice(
      request.page.offset,
      request.page.offset + request.page.limit,
    ),
  };
}
