import { type InventoryRhythmV1 } from '@texttrends/core';

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
