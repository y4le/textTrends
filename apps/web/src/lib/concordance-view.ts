import { kwicRowKey, type KwicRowView } from './store.ts';
import type { SeriesStyleV1 } from '@texttrends/core';

export interface ConcordanceRowVM {
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

export function concordanceRows(
  rows: readonly KwicRowView[],
  labelOf: (seriesId: string) => string,
  styleOf: (seriesId: string) => SeriesStyleV1,
  titleOf: (doc: string) => string,
): readonly ConcordanceRowVM[] {
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

/** Scroll offset that puts an aligned node's midpoint at the port midpoint. */
export function nodeCenterOffset(
  portWidth: number,
  nodeLeft: number,
  nodeWidth: number,
): number {
  if (![portWidth, nodeLeft, nodeWidth].every(Number.isFinite)) return 0;
  return Math.max(0, nodeLeft + nodeWidth / 2 - portWidth / 2);
}
