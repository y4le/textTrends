import { describe, expect, it } from 'vitest';
import { rangeClearDecision } from '../src/lib/range-clear-gesture.ts';

describe('range-clear double-click decision', () => {
  it.each([
    {
      name: 'accepts an unsuppressed graph hit',
      input: { zone: 'plot' as const, interactiveTarget: false, now: 10, suppressedUntil: 10 },
      expected: { kind: 'clear' },
    },
    {
      name: 'rejects a barcode hit',
      input: { zone: 'barcode' as const, interactiveTarget: false, now: 10, suppressedUntil: 0 },
      expected: { kind: 'ignore', reason: 'not-graph' },
    },
    {
      name: 'rejects a label or gap hit',
      input: { zone: null, interactiveTarget: false, now: 10, suppressedUntil: 0 },
      expected: { kind: 'ignore', reason: 'not-graph' },
    },
    {
      name: 'rejects an interactive target over the graph',
      input: { zone: 'plot' as const, interactiveTarget: true, now: 10, suppressedUntil: 0 },
      expected: { kind: 'ignore', reason: 'interactive' },
    },
    {
      name: 'rejects the native double-click synthesized after a drag',
      input: { zone: 'plot' as const, interactiveTarget: false, now: 9, suppressedUntil: 10 },
      expected: { kind: 'ignore', reason: 'suppressed' },
    },
  ])('$name', ({ input, expected }) => {
    expect(rangeClearDecision(input)).toEqual(expected);
  });
});
