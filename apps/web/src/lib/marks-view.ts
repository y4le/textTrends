/** Safe source-text presentation helpers for occurrence marks. */

export interface MarkSegment<Value> {
  readonly start: number;
  readonly end: number;
  readonly values: readonly Value[];
}

export interface TextMark<Value> {
  readonly value: Value;
  readonly start: number;
  readonly end: number;
}

export interface CollapsedMarkedText<Value> {
  readonly text: string;
  readonly marks: readonly TextMark<Value>[];
}

const WHITE_SPACE = /\s/u;

/** Replace display-breaking whitespace one UTF-16 code unit at a time so
 * worker-provided mark offsets remain valid. Source text is never mutated. */
export function displaySourceText(text: string): string {
  return text.replace(/[\n\r\t\u0085\u2028\u2029]/g, ' ');
}

/** Apply the Matches one-line whitespace collapse and remap mark boundaries
 * in the same pass. This is the sole authority for trimming/collapse offsets. */
export function collapseTextWithMarks<Value>(
  source: string,
  marks: readonly TextMark<Value>[],
): CollapsedMarkedText<Value> {
  let first = 0;
  while (first < source.length && WHITE_SPACE.test(source[first]!)) first++;
  let last = source.length;
  while (last > first && WHITE_SPACE.test(source[last - 1]!)) last--;

  const boundary = new Uint32Array(source.length + 1);
  let text = '';
  let sourceIndex = first;
  let outputIndex = 0;
  while (sourceIndex < last) {
    boundary[sourceIndex] = outputIndex;
    if (!WHITE_SPACE.test(source[sourceIndex]!)) {
      text += source[sourceIndex]!;
      sourceIndex++;
      outputIndex++;
      boundary[sourceIndex] = outputIndex;
      continue;
    }

    const runStart = sourceIndex;
    while (sourceIndex < last && WHITE_SPACE.test(source[sourceIndex]!)) sourceIndex++;
    text += ' ';
    outputIndex++;
    for (let index = runStart + 1; index <= sourceIndex; index++) {
      boundary[index] = outputIndex;
    }
  }
  for (let index = last; index <= source.length; index++) boundary[index] = outputIndex;

  const remapped: TextMark<Value>[] = [];
  for (const mark of marks) {
    if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) continue;
    const sourceStart = Math.max(0, Math.min(source.length, Math.trunc(mark.start)));
    const sourceEnd = Math.max(0, Math.min(source.length, Math.trunc(mark.end)));
    const start = boundary[sourceStart] as number;
    const end = boundary[sourceEnd] as number;
    if (start >= end) continue;
    remapped.push({ value: mark.value, start, end });
  }
  remapped.sort((left, right) => left.start - right.start || left.end - right.end);
  return { text, marks: remapped };
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
