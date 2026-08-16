import { partitionedGridTemplate } from './column-layout.ts';

export const VOCABULARY_COLUMNS = [
  'key',
  'count',
  'docFreq',
  'dp',
  'dpNorm',
  'ratePer10k',
] as const;

export type VocabularyColumn = typeof VOCABULARY_COLUMNS[number];
export type VocabularyColumnSettings = Readonly<Record<VocabularyColumn, number>>;

export const VOCABULARY_COLUMN_DEFAULTS: VocabularyColumnSettings = Object.freeze({
  key: 32,
  count: 15,
  docFreq: 11,
  dp: 11,
  dpNorm: 14,
  ratePer10k: 17,
});

export function vocabularyGridTemplate(settings: VocabularyColumnSettings): string {
  return partitionedGridTemplate(VOCABULARY_COLUMNS.map((column) => ({
    kind: 'elastic' as const,
    weight: settings[column],
  })));
}

export function vocabularyColumnBoundaryFromDrag(
  settings: VocabularyColumnSettings,
  column: VocabularyColumn,
  deltaPx: number,
  firstPx: number,
  secondPx: number,
): VocabularyColumnSettings {
  const index = VOCABULARY_COLUMNS.indexOf(column);
  const next = VOCABULARY_COLUMNS[index + 1];
  if (next === undefined) return settings;
  const pixelTotal = firstPx + secondPx;
  const weightTotal = settings[column] + settings[next];
  if (!(pixelTotal > 2) || !(weightTotal >= 2) || !Number.isFinite(deltaPx)) return settings;
  const firstTarget = Math.max(1, Math.min(pixelTotal - 1, firstPx + deltaPx));
  const firstWeight = Math.max(
    1,
    Math.min(weightTotal - 1, Math.round(weightTotal * firstTarget / pixelTotal)),
  );
  return {
    ...settings,
    [column]: firstWeight,
    [next]: weightTotal - firstWeight,
  };
}

export function vocabularyColumnBoundaryFromKey(
  settings: VocabularyColumnSettings,
  column: VocabularyColumn,
  key: string,
  shiftKey = false,
): VocabularyColumnSettings | null {
  const index = VOCABULARY_COLUMNS.indexOf(column);
  const next = VOCABULARY_COLUMNS[index + 1];
  if (next === undefined) return null;
  const total = settings[column] + settings[next];
  const step = shiftKey ? 5 : 1;
  let first: number;
  switch (key) {
    case 'ArrowLeft': first = settings[column] - step; break;
    case 'ArrowRight': first = settings[column] + step; break;
    case 'Home': first = 1; break;
    case 'End': first = total - 1; break;
    default: return null;
  }
  first = Math.max(1, Math.min(total - 1, first));
  return { ...settings, [column]: first, [next]: total - first };
}

export function resetVocabularyColumnBoundary(
  settings: VocabularyColumnSettings,
  column: VocabularyColumn,
): VocabularyColumnSettings {
  const index = VOCABULARY_COLUMNS.indexOf(column);
  const next = VOCABULARY_COLUMNS[index + 1];
  if (next === undefined) return settings;
  const total = settings[column] + settings[next];
  const defaultTotal = VOCABULARY_COLUMN_DEFAULTS[column]
    + VOCABULARY_COLUMN_DEFAULTS[next];
  const first = Math.max(1, Math.min(total - 1, Math.round(
    total * VOCABULARY_COLUMN_DEFAULTS[column] / defaultTotal,
  )));
  return { ...settings, [column]: first, [next]: total - first };
}

export function isDefaultVocabularyColumns(settings: VocabularyColumnSettings): boolean {
  return VOCABULARY_COLUMNS.every(
    (column) => settings[column] === VOCABULARY_COLUMN_DEFAULTS[column],
  );
}
