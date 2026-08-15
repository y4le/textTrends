/** Safe source-text presentation helpers for occurrence marks. */

export interface MarkSegment<Value> {
  readonly start: number;
  readonly end: number;
  readonly values: readonly Value[];
}

/** Replace display-breaking whitespace one UTF-16 code unit at a time so
 * worker-provided mark offsets remain valid. Source text is never mutated. */
export function displaySourceText(text: string): string {
  return text.replace(/[\n\r\t\u0085\u2028\u2029]/g, ' ');
}

/** Build non-overlapping segments from possibly overlapping mark spans. */
export function segmentMarks<Value>(
  length: number,
  marks: readonly {
    readonly value: Value;
    readonly start: number;
    readonly end: number;
  }[],
  extraBoundaries: readonly number[] = [],
): MarkSegment<Value>[] {
  const bounds = new Set<number>([0, length, ...extraBoundaries]);
  for (const mark of marks) {
    bounds.add(Math.max(0, Math.min(length, mark.start)));
    bounds.add(Math.max(0, Math.min(length, mark.end)));
  }
  const sorted = [...bounds]
    .filter((boundary) => boundary >= 0 && boundary <= length)
    .sort((a, b) => a - b);
  const out: MarkSegment<Value>[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const start = sorted[index]!;
    const end = sorted[index + 1]!;
    if (start === end) continue;
    const covering = marks.filter((mark) => mark.start <= start && mark.end >= end);
    out.push({
      start,
      end,
      values: covering.map((mark) => mark.value),
    });
  }
  return out;
}
