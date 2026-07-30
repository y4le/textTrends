import { commitRange, type TokenRangeSelectionV1 } from './selection.ts';

export interface RangePoint {
  readonly doc: string;
  readonly token: number;
}

export type RangeHandle = 'start' | 'end';

export interface RangeDraft {
  readonly doc: string;
  readonly start: number;
  readonly end: number;
  readonly message: string | null;
}

export function armRange(point: RangePoint): RangeDraft {
  return {
    doc: point.doc,
    start: point.token,
    end: point.token,
    message: null,
  };
}

export function cancelRange(): null {
  return null;
}

export function moveRangeHandle(
  draft: RangeDraft,
  handle: RangeHandle,
  point: RangePoint,
): RangeDraft {
  if (point.doc !== draft.doc) {
    return {
      ...draft,
      message: 'A range must stay within one book; the endpoint was not moved.',
    };
  }
  return {
    ...draft,
    [handle]: point.token,
    message: null,
  };
}

export function setRangeEnd(draft: RangeDraft, point: RangePoint): RangeDraft {
  return moveRangeHandle(draft, 'end', point);
}

export function stepRangeHandle(
  draft: RangeDraft,
  handle: RangeHandle,
  delta: number,
  docTokenCount: number,
): RangeDraft {
  if (
    !Number.isSafeInteger(delta)
    || !Number.isSafeInteger(docTokenCount)
    || docTokenCount <= 0
  ) {
    return draft;
  }
  const value = Math.max(
    0,
    Math.min(docTokenCount - 1, draft[handle] + delta),
  );
  return {
    ...draft,
    [handle]: value,
    message: null,
  };
}

export function draftRangeTokens(
  draft: RangeDraft,
): { readonly start: number; readonly end: number } {
  return {
    start: Math.min(draft.start, draft.end),
    end: Math.max(draft.start, draft.end) + 1,
  };
}

export function commitRangeDraft(
  snapshot: string,
  draft: RangeDraft,
  docTokenCount: number,
): TokenRangeSelectionV1 | null {
  return commitRange(snapshot, draft.doc, draft.start, draft.end, docTokenCount);
}
