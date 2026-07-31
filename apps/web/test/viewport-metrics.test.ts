import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_INSET_MAX_RATIO,
  keyboardInsetFor,
} from '../src/lib/viewport-metrics.ts';

describe('keyboardInsetFor', () => {
  it('measures the visual-only occluded band without double-applying layout resize', () => {
    expect(keyboardInsetFor({
      innerHeight: 844,
      visualHeight: 560,
      offsetTop: 0,
      scale: 1,
    })).toBe(284);
    expect(keyboardInsetFor({
      innerHeight: 560,
      visualHeight: 560,
      offsetTop: 0,
      scale: 1,
    })).toBe(0);
  });

  it('accounts for visual viewport offset', () => {
    expect(keyboardInsetFor({
      innerHeight: 844,
      visualHeight: 500,
      offsetTop: 60,
      scale: 1,
    })).toBe(284);
  });

  it('ignores pinch zoom without disabling page-zoom keyboard compensation', () => {
    expect(keyboardInsetFor({
      innerHeight: 844,
      visualHeight: 300,
      offsetTop: 0,
      scale: 2,
    })).toBe(0);
    expect(keyboardInsetFor({
      innerHeight: 422,
      visualHeight: 300,
      offsetTop: 0,
      scale: 1,
    })).toBe(122);
  });

  it('filters browser-chrome noise and clamps transient zero-height samples', () => {
    expect(keyboardInsetFor({
      innerHeight: 844,
      visualHeight: 832,
      offsetTop: 0,
      scale: 1,
    })).toBe(0);
    expect(keyboardInsetFor({
      innerHeight: 844,
      visualHeight: 0,
      offsetTop: 0,
      scale: 1,
    })).toBe(Math.round(844 * KEYBOARD_INSET_MAX_RATIO));
  });

  it.each([
    { innerHeight: Number.NaN, visualHeight: 560, offsetTop: 0, scale: 1 },
    { innerHeight: 844, visualHeight: Number.POSITIVE_INFINITY, offsetTop: 0, scale: 1 },
    { innerHeight: 844, visualHeight: 560, offsetTop: -1, scale: 1 },
    { innerHeight: 844, visualHeight: 560, offsetTop: 0, scale: -1 },
  ])('turns hostile sample $innerHeight/$visualHeight/$offsetTop/$scale into zero', (sample) => {
    expect(keyboardInsetFor(sample)).toBe(0);
  });
});
