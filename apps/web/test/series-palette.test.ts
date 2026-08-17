import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAXIMIN_SERIES_PALETTE,
  SERIES_COLOR_AVOID_DISTANCE,
  maximinSeriesPalette,
  maximinSeriesPaletteForSlots,
  seriesColorDistance,
} from '../src/lib/series-palette.ts';

describe('maximin series palette', () => {
  it('ports GraphTV\'s stable, theme-aware maximin prefix', () => {
    expect(DEFAULT_MAXIMIN_SERIES_PALETTE.dark).toEqual([
      '#30aff8',
      '#fcb442',
      '#d740a2',
      '#5c9932',
      '#fa9ff2',
    ]);
    expect(DEFAULT_MAXIMIN_SERIES_PALETTE.light).toEqual([
      '#1f68bc',
      '#5c9932',
      '#d740a2',
      '#743b1f',
      '#6213ab',
    ]);
    for (const scheme of ['dark', 'light'] as const) {
      const colors = maximinSeriesPalette(scheme);
      expect(new Set(colors)).toHaveLength(5);
      expect(maximinSeriesPalette(scheme)).toEqual(colors);
    }
  });

  it.each(['dark', 'light'] as const)(
    'keeps every %s automatic color clear of manual overrides',
    (scheme) => {
      const manual = [DEFAULT_MAXIMIN_SERIES_PALETTE[scheme][0]!, '#6a5acd'];
      const colors = maximinSeriesPalette(scheme, manual);

      expect(colors).toHaveLength(5);
      for (const color of colors) {
        for (const override of manual) {
          expect(seriesColorDistance(color, override))
            .toBeGreaterThanOrEqual(SERIES_COLOR_AVOID_DISTANCE);
        }
      }
    },
  );

  it('returns null distance for values outside the durable custom-color grammar', () => {
    expect(seriesColorDistance('#123456', '#abcdef')).toBeTypeOf('number');
    expect(seriesColorDistance('#123456', 'blue')).toBeNull();
    expect(seriesColorDistance('#123', '#abcdef')).toBeNull();
  });

  it('keeps all automatic CSS slots valid when five manual colors crowd the finite grid', () => {
    const colors = maximinSeriesPalette('dark', [
      '#79acc9',
      '#fc7e69',
      '#b488c9',
      '#9eb073',
      '#e729ee',
    ]);
    expect(colors).toHaveLength(5);
    expect(new Set(colors)).toHaveLength(5);
    expect(colors.every((color) => /^#[0-9a-f]{6}$/u.test(color))).toBe(true);
  });

  it('prioritizes strict clearance for the automatic slot active beside four manual colors', () => {
    const manual = ['#5c58c0', '#129160', '#7b2835', '#c73484'];
    const colors = maximinSeriesPaletteForSlots('light', manual, [4]);

    expect(colors).toHaveLength(5);
    expect(new Set(colors)).toHaveLength(5);
    for (const override of manual) {
      expect(seriesColorDistance(colors[4]!, override))
        .toBeGreaterThanOrEqual(SERIES_COLOR_AVOID_DISTANCE);
    }
  });

  it.each(['dark', 'light'] as const)(
    'keeps active %s automatic slots mutually clear and clear of active overrides',
    (scheme) => {
      const manual = ['#6a5acd', '#c73484'];
      const activeSlots = [0, 2, 4];
      const palette = maximinSeriesPaletteForSlots(scheme, manual, activeSlots);
      const automatic = activeSlots.map((slot) => palette[slot]!);

      for (let index = 0; index < automatic.length; index++) {
        for (const override of manual) {
          expect(seriesColorDistance(automatic[index]!, override))
            .toBeGreaterThanOrEqual(SERIES_COLOR_AVOID_DISTANCE);
        }
        for (let other = index + 1; other < automatic.length; other++) {
          expect(seriesColorDistance(automatic[index]!, automatic[other]!))
            .toBeGreaterThanOrEqual(SERIES_COLOR_AVOID_DISTANCE);
        }
      }
    },
  );
});
