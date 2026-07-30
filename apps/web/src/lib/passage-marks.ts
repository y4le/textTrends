/**
 * Safe source-text presentation helpers shared by the transient passage line,
 * immutable pins, and the full reader. The whitespace transform is exactly
 * one UTF-16 code unit to one code unit, so worker-provided offsets survive.
 */

export interface PassageSegment {
  readonly start: number;
  readonly end: number;
  readonly seriesIds: readonly string[];
}

/** Non-overlapping segments from possibly-overlapping mark spans. Extra
 * boundaries let a caller isolate an anchor or selection without changing
 * which marks cover the resulting pieces. */
export function segmentPassageMarks(
  length: number,
  marks: readonly {
    readonly seriesId: string;
    readonly start: number;
    readonly end: number;
  }[],
  extraBoundaries: readonly number[] = [],
): PassageSegment[] {
  const bounds = new Set<number>([0, length, ...extraBoundaries]);
  for (const mark of marks) {
    bounds.add(Math.max(0, Math.min(length, mark.start)));
    bounds.add(Math.max(0, Math.min(length, mark.end)));
  }
  const sorted = [...bounds]
    .filter((boundary) => boundary >= 0 && boundary <= length)
    .sort((a, b) => a - b);
  const out: PassageSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start === end) continue;
    const covering = marks.filter((mark) => mark.start <= start && mark.end >= end);
    out.push({
      start,
      end,
      // Worker mark order is track order; retain it so first-track tinting is
      // deterministic everywhere this evidence is rendered.
      seriesIds: covering.map((mark) => mark.seriesId),
    });
  }
  return out;
}

/** Every Unicode line break handled by the source segmenter, plus tabs. */
const DISPLAY_WHITESPACE = /[\n\r\t\u0085\u2028\u2029]/g;

export function displayPassageText(text: string): string {
  return text.replace(DISPLAY_WHITESPACE, ' ');
}
