export const RANGE_CLEAR_SUPPRESSION_MS = 500;
export const SYNTHESIZED_CLICK_WINDOW_MS = 700;

export type RangeClearZone = 'graph' | 'barcode' | 'outside';

export interface RangeClearInput {
  readonly zone: RangeClearZone;
  readonly interactiveTarget: boolean;
  readonly now: number;
  readonly suppressedUntil: number;
  readonly lastDirectPointerAt: number;
}

export type RangeClearDecision =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'ignore';
      readonly reason: 'synthesized' | 'interactive' | 'suppressed' | 'not-graph';
    };

/** Decide whether a native double-click belongs to the graph range-clear
 * gesture. Suppression precedes zone dispatch so a trailing double-click
 * after any completed drag cannot fall through to a barcode Reader action. */
export function rangeClearDecision(input: RangeClearInput): RangeClearDecision {
  if (input.now - input.lastDirectPointerAt < SYNTHESIZED_CLICK_WINDOW_MS) {
    return { kind: 'ignore', reason: 'synthesized' };
  }
  if (input.interactiveTarget) return { kind: 'ignore', reason: 'interactive' };
  if (input.now < input.suppressedUntil) return { kind: 'ignore', reason: 'suppressed' };
  if (input.zone !== 'graph') return { kind: 'ignore', reason: 'not-graph' };
  return { kind: 'clear' };
}
