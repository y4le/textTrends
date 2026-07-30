import { describe, expect, it } from 'vitest';
import { widthClassFor } from '../src/lib/presentation.ts';

describe('presentation width classes', () => {
  it.each([
    [319, 'compact'],
    [320, 'compact'],
    [599, 'compact'],
    [599.98, 'compact'],
    [600, 'regular'],
    [1023, 'regular'],
    [1024, 'wide'],
    [1440, 'wide'],
  ] as const)('classifies %d CSS pixels as %s', (width, expected) => {
    expect(widthClassFor(width)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid width %s', (width) => {
    expect(() => widthClassFor(width)).toThrow(RangeError);
  });
});
