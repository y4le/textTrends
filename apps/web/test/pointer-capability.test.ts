import { describe, expect, it } from 'vitest';
import { pointerIntentFor } from '../src/lib/pointer-capability.ts';

describe('pointer interaction capability', () => {
  it.each([
    ['mouse', 'precise'],
    ['pen', 'precise'],
    ['touch', 'direct'],
    ['', 'direct'],
    ['unknown', 'direct'],
  ] as const)('classifies %j as %s', (pointerType, expected) => {
    expect(pointerIntentFor(pointerType)).toBe(expected);
  });
});
