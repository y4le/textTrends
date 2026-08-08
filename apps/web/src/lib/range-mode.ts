import {
  commitRange,
  type SelectionPoint,
  type TokenRangeSelectionSpanV1,
  type TokenRangeSelectionV1,
} from './selection.ts';

export type RangePoint = SelectionPoint;
export type RangeHandle = 'start' | 'end';

export interface RangeDraft {
  readonly start: RangePoint;
  readonly end: RangePoint;
}

export function armRange(point: RangePoint): RangeDraft {
  return { start: point, end: point };
}

export function cancelRange(): null {
  return null;
}

export function moveRangeHandle(
  draft: RangeDraft,
  handle: RangeHandle,
  point: RangePoint,
): RangeDraft {
  return {
    ...draft,
    [handle]: { doc: point.doc, token: point.token },
  };
}

export function setRangeEnd(draft: RangeDraft, point: RangePoint): RangeDraft {
  return moveRangeHandle(draft, 'end', point);
}

function stepPoint(
  point: RangePoint,
  delta: number,
  docs: readonly string[],
  docTokenCounts: readonly number[],
): RangePoint {
  let ordinal = docs.indexOf(point.doc);
  if (ordinal < 0) return point;
  let token = point.token;
  let remaining = Math.abs(delta);
  const direction = Math.sign(delta);
  while (remaining > 0) {
    const count = docTokenCounts[ordinal] ?? 0;
    if (direction < 0) {
      if (token > 0) {
        const moved = Math.min(remaining, token);
        token -= moved;
        remaining -= moved;
      } else {
        let previous = ordinal - 1;
        while (previous >= 0 && (docTokenCounts[previous] ?? 0) <= 0) previous--;
        if (previous < 0) break;
        ordinal = previous;
        token = (docTokenCounts[ordinal] ?? 1) - 1;
        remaining--;
      }
    } else if (direction > 0) {
      if (token < count - 1) {
        const moved = Math.min(remaining, count - 1 - token);
        token += moved;
        remaining -= moved;
      } else {
        let next = ordinal + 1;
        while (next < docs.length && (docTokenCounts[next] ?? 0) <= 0) next++;
        if (next >= docs.length) break;
        ordinal = next;
        token = 0;
        remaining--;
      }
    } else {
      break;
    }
  }
  return { doc: docs[ordinal] ?? point.doc, token };
}

export function stepRangeHandle(
  draft: RangeDraft,
  handle: RangeHandle,
  delta: number,
  docs: readonly string[],
  docTokenCounts: readonly number[],
): RangeDraft {
  if (!Number.isSafeInteger(delta)) return draft;
  return {
    ...draft,
    [handle]: stepPoint(draft[handle], delta, docs, docTokenCounts),
  };
}

export function draftRanges(
  draft: RangeDraft,
  docs: readonly string[],
  docTokenCounts: readonly number[],
): readonly TokenRangeSelectionSpanV1[] {
  return commitRange('', draft.start, draft.end, docs, docTokenCounts)?.ranges ?? [];
}

export function commitRangeDraft(
  snapshot: string,
  draft: RangeDraft,
  docs: readonly string[],
  docTokenCounts: readonly number[],
): TokenRangeSelectionV1 | null {
  return commitRange(snapshot, draft.start, draft.end, docs, docTokenCounts);
}
