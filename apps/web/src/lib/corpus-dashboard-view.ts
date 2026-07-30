import { FREQUENCY_WINDOW_MAX, type InventoryRhythmV1 } from '@texttrends/core';

export interface RhythmBinView {
  readonly mean: number;
  readonly tokens: number;
  readonly sentences: number;
}

export function rhythmBinsForDocument(
  rhythm: InventoryRhythmV1,
  docOrdinal: number,
): readonly RhythmBinView[] {
  const bins: RhythmBinView[] = [];
  for (let index = 0; index < rhythm.docOrdinal.length; index++) {
    if ((rhythm.docOrdinal[index] as number) !== docOrdinal) continue;
    bins.push({
      mean: rhythm.sentenceMean[index] as number,
      tokens: rhythm.binTokens[index] as number,
      sentences: rhythm.sentences[index] as number,
    });
  }
  return bins;
}

export function rhythmDescription(
  bins: readonly RhythmBinView[],
  format: (value: number) => string,
): string {
  return bins.map((bin, index) =>
    `bin ${index + 1}: ${bin.sentences} sentences, mean ${format(bin.mean)}, ${bin.tokens} selected tokens`,
  ).join('; ');
}

export function frequencyFilterError(
  minCount: number,
  minDocFreq: number,
): string | null {
  if (!Number.isSafeInteger(minCount) || minCount < 1) {
    return 'Minimum count must be a whole number of at least 1.';
  }
  if (!Number.isSafeInteger(minDocFreq) || minDocFreq < 1) {
    return 'Minimum documents must be a whole number of at least 1.';
  }
  return null;
}

export interface FrequencyPageView {
  readonly label: string;
  readonly canNext: boolean;
  readonly atWindow: boolean;
}

export function frequencyPageView(
  total: number,
  offset: number,
  limit: number,
  rowCount: number,
): FrequencyPageView {
  if (total === 0) return { label: '0 rows', canNext: false, atWindow: false };
  const nextOffset = offset + limit;
  const atWindow = nextOffset >= FREQUENCY_WINDOW_MAX && nextOffset < total;
  return {
    label: `rows ${(offset + 1).toLocaleString('en-US')}–${Math.min(total, offset + rowCount).toLocaleString('en-US')}`,
    canNext: nextOffset < total && nextOffset + limit <= FREQUENCY_WINDOW_MAX,
    atWindow,
  };
}
