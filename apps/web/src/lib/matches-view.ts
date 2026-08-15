import { kwicRowKey, type KwicRowView } from './store.ts';
import type { SeriesStyleV1 } from '@texttrends/core';
import { collapseTextWithMarks, segmentMarks } from './marks-view.ts';

export interface MatchesContextPart {
  readonly text: string;
  readonly marked: boolean;
  readonly trackOrdinals: readonly number[];
}

export interface MatchesRowVM {
  readonly key: string;
  readonly seriesId: string;
  readonly label: string;
  readonly style: SeriesStyleV1;
  readonly doc: string;
  readonly title: string;
  readonly pos: number;
  readonly leftFull: string;
  readonly leftParts: readonly MatchesContextPart[];
  readonly nodeText: string;
  readonly rightFull: string;
  readonly rightParts: readonly MatchesContextPart[];
  readonly source: KwicRowView;
}

/** Collapse source whitespace for one-line display without changing the
 * underlying result or its complete accessible string. */
export function oneLine(value: string): string {
  return collapseTextWithMarks(value, []).text;
}

function contextDisplay(
  value: string,
  marks: KwicRowView['leftMarks'],
): { readonly text: string; readonly parts: readonly MatchesContextPart[] } {
  const collapsed = collapseTextWithMarks(
    value,
    marks.map((mark) => ({
      value: mark.trackOrdinals,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
  );
  const parts = segmentMarks(collapsed.text.length, collapsed.marks).map((segment) => {
    const trackOrdinals = [...new Set(segment.values.flat())].sort((left, right) => left - right);
    return {
      text: collapsed.text.slice(segment.start, segment.end),
      marked: trackOrdinals.length > 0,
      trackOrdinals,
    };
  });
  return { text: collapsed.text, parts };
}

export function matchesRows(
  rows: readonly KwicRowView[],
  labelOf: (seriesId: string) => string,
  styleOf: (seriesId: string) => SeriesStyleV1,
  titleOf: (doc: string) => string,
): readonly MatchesRowVM[] {
  return rows.map((source) => {
    const left = contextDisplay(source.left, source.leftMarks);
    const right = contextDisplay(source.right, source.rightMarks);
    return {
      key: kwicRowKey(source),
      seriesId: source.seriesId,
      label: labelOf(source.seriesId),
      style: styleOf(source.seriesId),
      doc: source.doc,
      title: titleOf(source.doc),
      pos: source.pos,
      leftFull: left.text,
      leftParts: left.parts,
      nodeText: oneLine(source.nodeText),
      rightFull: right.text,
      rightParts: right.parts,
      source,
    };
  });
}
