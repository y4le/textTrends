import { kwicRowKey, type KwicRowView } from './store.ts';
import type { SeriesStyleV1 } from '@texttrends/core';

export interface MatchesRowVM {
  readonly key: string;
  readonly seriesId: string;
  readonly label: string;
  readonly style: SeriesStyleV1;
  readonly doc: string;
  readonly title: string;
  readonly pos: number;
  readonly leftFull: string;
  readonly nodeText: string;
  readonly rightFull: string;
  readonly source: KwicRowView;
}

/** Collapse source whitespace for one-line display without changing the
 * underlying result or its complete accessible string. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function matchesRows(
  rows: readonly KwicRowView[],
  labelOf: (seriesId: string) => string,
  styleOf: (seriesId: string) => SeriesStyleV1,
  titleOf: (doc: string) => string,
): readonly MatchesRowVM[] {
  return rows.map((source) => {
    const leftFull = oneLine(source.left);
    const rightFull = oneLine(source.right);
    return {
      key: kwicRowKey(source),
      seriesId: source.seriesId,
      label: labelOf(source.seriesId),
      style: styleOf(source.seriesId),
      doc: source.doc,
      title: titleOf(source.doc),
      pos: source.pos,
      leftFull,
      nodeText: oneLine(source.nodeText),
      rightFull,
      source,
    };
  });
}
