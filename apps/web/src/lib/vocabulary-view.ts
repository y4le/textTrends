import {
  FREQUENCY_REGEX_MAX_UNITS,
  type FrequencyListRowV1,
  type FrequencySortFieldV1,
} from '@texttrends/core';
import type { FrequencyState } from './store.ts';

export interface VocabularyRowTarget {
  readonly surface: 'vocab-row';
  readonly typeId: number;
  readonly key: string;
}

export type VocabularyTarget = VocabularyRowTarget;

export function vocabularyTarget(value: unknown): VocabularyTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
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

export function frequencyRegexError(pattern: string): string | null {
  if (pattern.length > FREQUENCY_REGEX_MAX_UNITS) {
    return `Regular expression must be ${FREQUENCY_REGEX_MAX_UNITS} characters or fewer.`;
  }
  if (pattern === '') return null;
  try {
    new RegExp(pattern.normalize('NFC'), 'u');
    return null;
  } catch {
    return 'Invalid regular expression; showing the previous results.';
  }
}
