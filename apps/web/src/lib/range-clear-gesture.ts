export const RANGE_CLEAR_SUPPRESSION_MS = 500;

export interface RangeClearInput {
  readonly zone: 'plot' | 'barcode' | null;
  readonly interactiveTarget: boolean;
  readonly now: number;
  readonly suppressedUntil: number;
}

export type RangeClearDecision =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'ignore';
      readonly reason: 'not-graph' | 'interactive' | 'suppressed';
    };

/** Decide whether a native double-click belongs to the graph's range-clear
 * gesture. DOM hit-testing stays in the component; the precedence is pure and
 * explicit so barcode, label, handle, and post-drag behavior cannot drift. */
export function rangeClearDecision(input: RangeClearInput): RangeClearDecision {
  if (input.interactiveTarget) return { kind: 'ignore', reason: 'interactive' };
  if (input.zone !== 'plot') return { kind: 'ignore', reason: 'not-graph' };
  if (input.now < input.suppressedUntil) {
    return { kind: 'ignore', reason: 'suppressed' };
  }
  return { kind: 'clear' };
}
