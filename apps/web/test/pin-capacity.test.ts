import { describe, expect, it } from 'vitest';
import { pinCapacity } from '../src/lib/pin-capacity.ts';

describe('pinCapacity', () => {
  it.each(Array.from({ length: 9 }, (_, used) => used))(
    'describes %d of 8 retained passages',
    (used) => {
      const view = pinCapacity(used);
      expect(view.label).toBe(`${used} of 8 pinned`);
      expect(view.enabled).toBe(used < 8);
      expect(view.reason).toBe(used === 8
        ? 'Pin limit reached — remove pinned evidence before retaining another passage.'
        : null);
      expect(view.route).toBe(used === 8 ? 'findings' : null);
    },
  );

  it.each([-1, 9, 1.5, Number.NaN])('refuses an invalid used count: %s', (used) => {
    expect(() => pinCapacity(used)).toThrow(RangeError);
  });
});
