import {
  FREQUENCY_PAGE_MAX,
  type FrequencyTokenClassV1,
  type KeynessRowV1,
  type KeynessSortFieldV1,
} from '@texttrends/core';
import type {
  KeynessSettingsInputV1,
  KeynessTableState,
  KeynessViewV1,
} from './store.ts';

export interface CompareSettingsTarget {
  readonly surface: 'compare-settings';
}

export interface CompareRowTarget {
  readonly surface: 'compare-row';
  readonly side: 'a' | 'b';
  readonly typeId: number;
  readonly key: string;
}

export type CompareTarget = CompareSettingsTarget | CompareRowTarget;

export function compareTarget(value: unknown): CompareTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.surface === 'compare-settings') {
    return { surface: 'compare-settings' };
  }
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
  if (target.surface === 'compare-settings') return false;
  const state = sideState(target.side, stateA, stateB);
  return state?.state.status === 'ready'
    && !state.state.result.rows.some(
      (row) => row.typeId === target.typeId && row.key === target.key,
    );
}

export function compareSideLabel(
  side: 'a' | 'b',
  view: KeynessViewV1,
  titleOf: (doc: string) => string,
): string {
  if (view.mode === 'documents') {
    const doc = side === 'a' ? view.documentA : view.documentB;
    return doc ? titleOf(doc) : 'unavailable';
  }
  if (view.restOn === side) {
    const excluded = side === 'a' ? view.documentB : view.documentA;
    return `all books except ${excluded ? titleOf(excluded) : 'the focus book'}`;
  }
  const doc = side === 'a' ? view.documentA : view.documentB;
  return doc ? titleOf(doc) : 'unavailable';
}

export const compareSortLabel = (sort: KeynessSortFieldV1): string => {
  switch (sort) {
    case 'countA': return 'A count';
    case 'countB': return 'B count';
    case 'logRatio': return 'log₂ ratio';
    case 'g2': return 'signed G²';
  }
};

const directionLabel = (direction: 1 | -1): string =>
  direction === 1 ? 'ascending' : 'descending';

export function compareViewSummary(view: KeynessViewV1): string {
  return [
    `${compareSortLabel(view.sort.by)} shared order`,
    `A ${directionLabel(view.sort.dirA)}`,
    `B ${directionLabel(view.sort.dirB)}`,
    `count ≥ ${view.minCountTotal}`,
    `documents ≥ ${view.minDocFreqTotal}`,
    view.classes.join(' + '),
    `${view.pageLimit} rows/page`,
  ].join(' · ');
}

export function compareSettingsInput(
  view: KeynessViewV1,
): KeynessSettingsInputV1 {
  return {
    minCountTotal: view.minCountTotal,
    minDocFreqTotal: view.minDocFreqTotal,
    classes: [...view.classes],
    sortBy: view.sort.by,
    pageLimit: view.pageLimit,
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
  if (!['logRatio', 'g2', 'countA', 'countB'].includes(input.sortBy)) {
    return 'Choose an available shared sort field.';
  }
  if (
    !Number.isSafeInteger(input.pageLimit)
    || input.pageLimit < 1
    || input.pageLimit > FREQUENCY_PAGE_MAX
  ) {
    return `Rows per page must be between 1 and ${FREQUENCY_PAGE_MAX}.`;
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
  const ready = [stateA, stateB].filter(
    (state): state is KeynessTableState & {
      readonly state: Extract<KeynessTableState['state'], { readonly status: 'ready' }>;
    } => state?.state.status === 'ready',
  );
  const maximum = Math.max(
    1,
    ...ready.flatMap((state) =>
      state.state.result.rows.map((row) => Math.abs(row.logRatio))),
  );
  return {
    maximum,
    provisional: ready.length === 1,
  };
}

/** Width within one half of the signed axis, expressed as 0..50 percent. */
export function compareBarPercent(effect: number, maximum: number): number {
  if (!Number.isFinite(effect) || !Number.isFinite(maximum) || maximum <= 0) {
    return 0;
  }
  return Math.min(50, Math.max(0, Math.abs(effect) / maximum * 50));
}

export function compareRowForTarget(
  target: CompareRowTarget,
  stateA: KeynessTableState | null,
  stateB: KeynessTableState | null,
): KeynessRowV1 | null {
  const state = sideState(target.side, stateA, stateB);
  if (state?.state.status !== 'ready') return null;
  return state.state.result.rows.find(
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
