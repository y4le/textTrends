export type ReaderTapIntent =
  | 'mark'
  | 'page-previous'
  | 'page-next'
  | 'cursor'
  | 'none';

export interface ReaderTapFacts {
  readonly primary: boolean;
  readonly movedPx: number;
  readonly elapsedMs: number;
  readonly selectionOpen: boolean;
  readonly onInteractiveTarget: boolean;
  readonly onMarkTarget: boolean;
  readonly onSourceToken: boolean;
  readonly edgePaging: boolean;
  readonly xWithinPane: number;
  readonly paneWidth: number;
  readonly canPagePrevious: boolean;
  readonly canPageNext: boolean;
  readonly geometrySettled: boolean;
}

export const READER_TAP_MOVE_MAX_PX = 8;
export const READER_TAP_TIME_MAX_MS = 500;
export const READER_EDGE_MIN_PX = 44;
export const READER_EDGE_MAX_PX = 120;
export const READER_EDGE_RATIO = 0.18;

export function readerEdgeWidth(paneWidth: number): number {
  return Math.max(
    READER_EDGE_MIN_PX,
    Math.min(READER_EDGE_MAX_PX, Math.max(0, paneWidth) * READER_EDGE_RATIO),
  );
}

export function readerTapIntent(facts: ReaderTapFacts): ReaderTapIntent {
  if (
    !facts.primary
    || facts.movedPx > READER_TAP_MOVE_MAX_PX
    || facts.elapsedMs > READER_TAP_TIME_MAX_MS
    || facts.selectionOpen
    || !facts.geometrySettled
    || facts.xWithinPane < 0
    || facts.xWithinPane > facts.paneWidth
  ) return 'none';

  if (facts.onMarkTarget || facts.onInteractiveTarget) return 'mark';

  const edge = readerEdgeWidth(facts.paneWidth);
  if (
    facts.edgePaging
    && !facts.onSourceToken
    && facts.xWithinPane <= edge
    && facts.canPagePrevious
  ) return 'page-previous';
  if (
    facts.edgePaging
    && !facts.onSourceToken
    && facts.xWithinPane >= facts.paneWidth - edge
    && facts.canPageNext
  ) return 'page-next';
  return facts.onSourceToken ? 'cursor' : 'none';
}
