import {
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  type FrequencyListRowV1,
  type FrequencySortFieldV1,
  type FrequencyTokenClassV1,
} from '@texttrends/core';
import type {
  FrequencyState,
  FrequencyViewInputV1,
  FrequencyViewV1,
} from './store.ts';

export interface VocabularyFilterTarget {
  readonly surface: 'vocab-filter';
}

export interface VocabularyRowTarget {
  readonly surface: 'vocab-row';
  readonly typeId: number;
  readonly key: string;
}

export type VocabularyTarget = VocabularyFilterTarget | VocabularyRowTarget;

export function vocabularyTarget(value: unknown): VocabularyTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.surface === 'vocab-filter') return { surface: 'vocab-filter' };
  if (
    candidate.surface !== 'vocab-row'
    || !Number.isSafeInteger(candidate.typeId)
    || (candidate.typeId as number) < 0
    || typeof candidate.key !== 'string'
    || candidate.key === ''
  ) return null;
  return {
    surface: 'vocab-row',
    typeId: candidate.typeId as number,
    key: candidate.key,
  };
}

export const vocabularyFilterControlId = 'vocabulary-filter';
export const vocabularyRowControlId = (typeId: number): string =>
  `vocabulary-row-${typeId}`;

/** Pending/error results cannot prove a target stale; only snapshot loss or a
 * complete ready page that omits the exact row identity can do so. */
export function vocabularyTargetIsStale(
  target: VocabularyTarget,
  hasSnapshot: boolean,
  frequency: Pick<FrequencyState, 'state'> | null,
): boolean {
  if (!hasSnapshot) return true;
  if (target.surface === 'vocab-filter') return false;
  return frequency?.state.status === 'ready'
    && !frequency.state.result.rows.some(
      (row) => row.typeId === target.typeId && row.key === target.key,
    );
}

export type FrequencyMeasureField = Exclude<FrequencySortFieldV1, 'key'>;

export function frequencyMeasureField(
  sort: FrequencySortFieldV1,
): FrequencyMeasureField {
  return sort === 'key' ? 'count' : sort;
}

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function frequencyMeasure(
  row: FrequencyListRowV1,
  sort: FrequencySortFieldV1,
): { readonly field: FrequencyMeasureField; readonly label: string; readonly value: string } {
  const field = frequencyMeasureField(sort);
  switch (field) {
    case 'count': return { field, label: 'count', value: number.format(row.count) };
    case 'docFreq': return { field, label: 'docs', value: number.format(row.docFreq) };
    case 'dp': return {
      field,
      label: 'DP',
      value: row.dp === null || !Number.isFinite(row.dp) ? 'unavailable' : decimal.format(row.dp),
    };
    case 'dpNorm': return {
      field,
      label: 'DPnorm',
      value: row.dpNorm === null || !Number.isFinite(row.dpNorm)
        ? 'unavailable'
        : decimal.format(row.dpNorm),
    };
    case 'ratePer10k': return {
      field,
      label: 'rate/10k',
      value: decimal.format(row.ratePer10k),
    };
    case 'class': return { field, label: 'class', value: row.class };
  }
}

export function frequencyViewInput(view: FrequencyViewV1): FrequencyViewInputV1 {
  return {
    minCount: view.minCount,
    minDocFreq: view.minDocFreq,
    classes: [...view.classes],
    prefix: view.prefixNfc ?? '',
    sort: { ...view.sort },
    pageLimit: view.page.limit,
  };
}

export function frequencyFilterError(input: FrequencyViewInputV1): string | null {
  if (!Number.isSafeInteger(input.minCount) || input.minCount < 1) {
    return 'Minimum count must be a whole number of at least 1.';
  }
  if (!Number.isSafeInteger(input.minDocFreq) || input.minDocFreq < 1) {
    return 'Minimum documents must be a whole number of at least 1.';
  }
  if (input.prefix.length > FREQUENCY_PREFIX_MAX_UNITS) {
    return `Prefix must be ${FREQUENCY_PREFIX_MAX_UNITS} characters or fewer.`;
  }
  if (input.classes.length === 0) return 'Select at least one token class.';
  if (
    !Number.isSafeInteger(input.pageLimit)
    || input.pageLimit < 1
    || input.pageLimit > FREQUENCY_PAGE_MAX
  ) return `Rows per page must be between 1 and ${FREQUENCY_PAGE_MAX}.`;
  return null;
}

export function toggleFrequencyClass(
  classes: readonly FrequencyTokenClassV1[],
  tokenClass: FrequencyTokenClassV1,
): readonly FrequencyTokenClassV1[] {
  return classes.includes(tokenClass)
    ? classes.filter((item) => item !== tokenClass)
    : [...classes, tokenClass];
}
