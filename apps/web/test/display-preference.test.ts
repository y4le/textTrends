import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_PREFERENCE,
  DENSITY_METRICS,
  DISPLAY_DENSITIES,
} from '../src/lib/display-preference.ts';

describe('display density metrics', () => {
  it('keeps Compact as the exact legacy geometry and Standard as default', () => {
    expect(DEFAULT_DISPLAY_PREFERENCE.density).toBe('standard');
    expect(DISPLAY_DENSITIES).toEqual(['compact', 'standard', 'comfortable']);
    expect(DENSITY_METRICS.compact).toMatchObject({
      cssVars: {
        '--text-xs': '0.6875rem',
        '--text-sm': '0.8125rem',
        '--text-md': '0.9375rem',
        '--text-lg': '1.25rem',
      },
      matchesRowHeight: 32,
      frequencyRowHeight: 34,
      frequencyCompactRowHeight: 44,
      dock: {
        railBlockSize: 48,
        compactRailBlockSize: 50,
        termTargetBlockSize: 34,
        compactTermTargetBlockSize: 36,
        readerTermTargetBlockSize: 24,
      },
    });
  });

  it('increases every governed metric monotonically at semantic stops', () => {
    const ordered = DISPLAY_DENSITIES.map((density) => DENSITY_METRICS[density]);
    for (const key of [
      'matchesRowHeight',
      'frequencyRowHeight',
      'frequencyCompactRowHeight',
    ] as const) {
      expect(ordered.map((metrics) => metrics[key]))
        .toEqual([...ordered.map((metrics) => metrics[key])].sort((a, b) => a - b));
    }
    for (const key of Object.keys(ordered[0]!.dock) as Array<keyof typeof ordered[0]['dock']>) {
      expect(ordered.map((metrics) => metrics.dock[key]))
        .toEqual([...ordered.map((metrics) => metrics.dock[key])].sort((a, b) => a - b));
    }
  });
});
