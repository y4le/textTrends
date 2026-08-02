import { describe, expect, it } from 'vitest';
import { pinCapacity } from '../src/lib/pin-capacity.ts';

describe('pinCapacity', () => {
  it.each(Array.from({ length: 9 }, (_, used) => used))(
    'describes %d of 8 retained passages',
    (used) => {
      const view = pinCapacity(used);
      expect(view.label).toBe(`${used} of 8 saved excerpts`);
      expect(view.enabled).toBe(used < 8);
      expect(view.reason).toBe(used === 8
        ? 'Saved excerpts are limited to 8 — remove one from Findings first.'
        : null);
      expect(view.route).toBe(used === 8 ? 'findings' : null);
    },
  );

  it.each([-1, 9, 1.5, Number.NaN])('refuses an invalid used count: %s', (used) => {
    expect(() => pinCapacity(used)).toThrow(RangeError);
  });
});
