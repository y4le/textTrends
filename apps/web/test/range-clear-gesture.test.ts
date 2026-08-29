import { describe, expect, it } from 'vitest';
import {
  SYNTHESIZED_CLICK_WINDOW_MS,
  rangeClearDecision,
} from '../src/lib/range-clear-gesture.ts';

const decide = (overrides: Partial<Parameters<typeof rangeClearDecision>[0]> = {}) =>
  rangeClearDecision({
    zone: 'graph',
    interactiveTarget: false,
    now: 1_000,
    suppressedUntil: 0,
    lastDirectPointerAt: 0,
    ...overrides,
  });

describe('range-clear double-click decision', () => {
  it('accepts only an unsuppressed graph double-click', () => {
    expect(decide()).toEqual({ kind: 'clear' });
    expect(decide({ zone: 'barcode' })).toEqual({ kind: 'ignore', reason: 'not-graph' });
    expect(decide({ zone: 'outside' })).toEqual({ kind: 'ignore', reason: 'not-graph' });
    expect(decide({ interactiveTarget: true }))
      .toEqual({ kind: 'ignore', reason: 'interactive' });
    expect(decide({ suppressedUntil: 1_001 }))
      .toEqual({ kind: 'ignore', reason: 'suppressed' });
  });

  it('rejects a native double-click synthesized after direct touch', () => {
    expect(decide({
      lastDirectPointerAt: 1_000 - SYNTHESIZED_CLICK_WINDOW_MS + 1,
    })).toEqual({ kind: 'ignore', reason: 'synthesized' });
    expect(decide({
      lastDirectPointerAt: 1_000 - SYNTHESIZED_CLICK_WINDOW_MS,
    })).toEqual({ kind: 'clear' });
  });

  it('lets drag suppression block a barcode Reader fall-through', () => {
    expect(decide({ zone: 'barcode', suppressedUntil: 1_001 }))
      .toEqual({ kind: 'ignore', reason: 'suppressed' });
  });
});
