/** Safe source-text presentation helpers for Reader occurrence marks. */

export interface ReaderSegment {
  readonly start: number;
  readonly end: number;
  readonly seriesIds: readonly string[];
}

/** Replace display-breaking whitespace one UTF-16 code unit at a time so
 * worker-provided mark offsets remain valid. Source text is never mutated. */
export function displayReaderText(text: string): string {
  return text.replace(/[\n\r\t\u0085\u2028\u2029]/g, ' ');
}

/** Build non-overlapping segments from possibly overlapping mark spans. */
export function segmentReaderMarks(
  length: number,
  marks: readonly {
    readonly seriesId: string;
    readonly start: number;
    readonly end: number;
  }[],
  extraBoundaries: readonly number[] = [],
): ReaderSegment[] {
  const bounds = new Set<number>([0, length, ...extraBoundaries]);
  for (const mark of marks) {
    bounds.add(Math.max(0, Math.min(length, mark.start)));
    bounds.add(Math.max(0, Math.min(length, mark.end)));
  }
  const sorted = [...bounds]
    .filter((boundary) => boundary >= 0 && boundary <= length)
    .sort((a, b) => a - b);
  const out: ReaderSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start === end) continue;
    const covering = marks.filter((mark) => mark.start <= start && mark.end >= end);
    out.push({
      start,
      end,
      seriesIds: covering.map((mark) => mark.seriesId),
    });
  }
  return out;
}
