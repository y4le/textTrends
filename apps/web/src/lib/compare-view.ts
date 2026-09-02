import {
  STOPLIST_MAX_TOP_N,
  type FrequencyTokenClassV1,
  type KeynessDivergenceV1,
  type KeynessRowV1,
  type KeynessSortFieldV1,
} from '@texttrends/core';
import type {
  KeynessSettingsInputV1,
  KeynessTableState,
  KeynessViewV1,
} from './store.ts';

export interface CompareRowTarget {
  readonly surface: 'compare-row';
  readonly side: 'a' | 'b';
  readonly typeId: number;
  readonly key: string;
}

export type CompareTarget = CompareRowTarget;

export function compareTarget(value: unknown): CompareTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.surface !== 'compare-row'
    || (candidate.side !== 'a' && candidate.side !== 'b')
    || !Number.isSafeInteger(candidate.typeId)
    || (candidate.typeId as number) < 0
    || typeof candidate.key !== 'string'
    || candidate.key === ''
  ) {
    return null;
  }
  return {
    surface: 'compare-row',
    side: candidate.side,
    typeId: candidate.typeId as number,
    key: candidate.key,
  };
}

export const compareSettingsControlId = 'compare-settings';
export const compareRowControlId = (
  side: 'a' | 'b',
  typeId: number,
): string => `compare-row-${side}-${typeId}`;

const sideState = (
  side: 'a' | 'b',
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
) => side === 'a' ? stateA : stateB;

export function compareResidentResult(
  state: KeynessTableState | null,
) {
  return state?.resident
    ?? (state?.state.status === 'ready' ? state.state.result : null);
}

/** Pending/error results cannot prove a row stale. Snapshot or comparison
 * loss invalidates every target; only a ready result can prove row omission. */
export function compareTargetIsStale(
  target: CompareTarget,
  hasSnapshot: boolean,
  hasComparison: boolean,
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
): boolean {
  if (!hasSnapshot || !hasComparison) return true;
  const state = sideState(target.side, stateA, stateB);
  const result = compareResidentResult(state);
  return result !== null
    && state?.state.status === 'ready'
    && !result.rows.some(
      (row) => row.typeId === target.typeId && row.key === target.key,
    );
}

export function compareSideLabel(
  side: 'a' | 'b',
  view: KeynessViewV1,
  titleOf: (doc: string) => string,
): string {
  if (view.mode === 'selection-rest') {
    return side === 'a' ? 'selected range' : 'rest of corpus';
  }
  if (view.mode === 'documents') {
    const doc = side === 'a' ? view.documentA : view.documentB;
    return doc ? titleOf(doc) : 'unavailable';
  }
  if (view.restOn === side) {
    const excluded = side === 'a' ? view.documentB : view.documentA;
    return `all texts except ${excluded ? titleOf(excluded) : 'the focus text'}`;
  }
  const doc = side === 'a' ? view.documentA : view.documentB;
  return doc ? titleOf(doc) : 'unavailable';
}

export const compareSortLabel = (sort: KeynessSortFieldV1): string => {
  switch (sort) {
    case 'countA': return 'A count';
    case 'countB': return 'B count';
    case 'logRatio': return 'log₂ ratio';
    case 'logRatioLow': return 'lower 95% bound';
    case 'g2': return 'signed G²';
  }
};

const directionLabel = (direction: 1 | -1): string =>
  direction === 1 ? 'ascending' : 'descending';

export function compareSettingsInput(
  view: KeynessViewV1,
): KeynessSettingsInputV1 {
  return {
    minCountTotal: view.minCountTotal,
    minDocFreqTotal: view.minDocFreqTotal,
    classes: [...view.classes],
    stoplistTopN: view.stoplistTopN,
    sortBy: view.sort.by,
    dirA: view.sort.dirA,
    dirB: view.sort.dirB,
    showConfidenceIntervals: view.showConfidenceIntervals,
  };
}

export function compareSettingsError(
  input: KeynessSettingsInputV1,
): string | null {
  if (!Number.isSafeInteger(input.minCountTotal) || input.minCountTotal < 1) {
    return 'Minimum combined count must be a whole number of at least 1.';
  }
  if (
    !Number.isSafeInteger(input.minDocFreqTotal)
    || input.minDocFreqTotal < 1
  ) {
    return 'Minimum combined documents must be a whole number of at least 1.';
  }
  if (
    input.classes.length === 0
    || input.classes.length > 2
    || new Set(input.classes).size !== input.classes.length
    || input.classes.some(
      (value) => value !== 'lexical' && value !== 'numeral',
    )
  ) {
    return 'Select at least one unique token class.';
  }
  if (
    !Number.isSafeInteger(input.stoplistTopN)
    || input.stoplistTopN < 0
    || input.stoplistTopN > STOPLIST_MAX_TOP_N
  ) {
    return `Common-word depth must be a whole number from 0 to ${STOPLIST_MAX_TOP_N}.`;
  }
  if (
    !['logRatio', 'logRatioLow', 'g2', 'countA', 'countB']
      .includes(input.sortBy)
  ) {
    return 'Choose an available shared sort field.';
  }
  if (
    (input.dirA !== 1 && input.dirA !== -1)
    || (input.dirB !== 1 && input.dirB !== -1)
  ) {
    return 'Choose an available ranking direction for each side.';
  }
  if (typeof input.showConfidenceIntervals !== 'boolean') {
    return 'Choose whether to show confidence intervals.';
  }
  return null;
}

export function toggleCompareClass(
  classes: readonly FrequencyTokenClassV1[],
  tokenClass: FrequencyTokenClassV1,
): readonly FrequencyTokenClassV1[] {
  return classes.includes(tokenClass)
    ? classes.filter((value) => value !== tokenClass)
    : [...classes, tokenClass];
}

export interface CompareScale {
  readonly maximum: number;
  readonly provisional: boolean;
}

export function compareScale(
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
): CompareScale {
  const ready = [compareResidentResult(stateA), compareResidentResult(stateB)]
    .filter((result): result is NonNullable<typeof result> => result !== null);
  let maximum = 1;
  for (const result of ready) {
    for (const row of result.rows) {
      maximum = Math.max(maximum, Math.abs(row.logRatio));
    }
  }
  return {
    maximum,
    provisional: ready.length === 1,
  };
}

/**
 * The pair's whole-distribution divergence. Both side requests measure the
 * same two selections, and the divergence is computed before side projection,
 * filtering, and paging — so either ready result carries the identical number
 * and the first one available is enough.
 */
export function compareDivergence(
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
): KeynessDivergenceV1 | null {
  return compareResidentResult(stateA)?.divergence
    ?? compareResidentResult(stateB)?.divergence
    ?? null;
}

/** Width within one side of the population pyramid, expressed as 0..100 percent. */
export function compareBarPercent(effect: number, maximum: number): number {
  if (!Number.isFinite(effect) || !Number.isFinite(maximum) || maximum <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.abs(effect) / maximum * 100));
}

export function compareRowForTarget(
  target: CompareRowTarget,
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
): KeynessRowV1 | null {
  const result = compareResidentResult(sideState(target.side, stateA, stateB));
  if (result === null) return null;
  return result.rows.find(
    (row) => row.typeId === target.typeId && row.key === target.key,
  ) ?? null;
}

export function compareSortDescription(
  view: KeynessViewV1,
  side: 'a' | 'b',
): string {
  const direction = side === 'a' ? view.sort.dirA : view.sort.dirB;
  return `${compareSortLabel(view.sort.by)} ${directionLabel(direction)}`;
}
