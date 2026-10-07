import { describe, expect, it } from 'vitest';
import {
  SHORT_VIEWPORT_MAX_PX,
  SHORT_VIEWPORT_QUERY,
  workbenchFooterFits,
  widthClassFor,
} from '../src/lib/presentation.ts';

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

  it('shares the short viewport threshold with CSS layout', () => {
    expect(SHORT_VIEWPORT_MAX_PX).toBe(520);
    expect(SHORT_VIEWPORT_QUERY).toBe('(max-height: 520px)');
  });

  it.each([
    ['wide', true, true],
    ['regular', true, false],
    ['compact', true, false],
    ['wide', false, true],
    ['regular', false, true],
    ['compact', false, true],
  ] as const)('fits the footer at %s width with shortLandscape=%s: %s', (width, shortLandscape, fits) => {
    expect(workbenchFooterFits({ width, shortLandscape })).toBe(fits);
  });
});
