import { describe, expect, it } from 'vitest';
import {
  seriesColor,
  seriesColorContrastWarning,
  seriesColorFromNativeInput,
  seriesColorLabel,
  seriesDash,
  seriesLinecap,
} from '../src/lib/series-style.ts';

describe('series style rendering', () => {
  it('keeps legacy colors theme-aware and passes authored hex through unchanged', () => {
    expect(seriesColor({ color: 'blue', line: 'solid' })).toBe('var(--series-1)');
    expect(seriesColor({ color: '#a1b2c3', line: 'dash' })).toBe('#a1b2c3');
    expect(seriesColorLabel('violet')).toBe('Automatic 4');
    expect(seriesColorLabel('gold')).toBe('Automatic 5');
    expect(seriesColorLabel('#a1b2c3')).toBe('#a1b2c3');
  });

  it('derives dash and cap from the authored line id', () => {
    expect(seriesDash({ color: '#a1b2c3', line: 'dash-dot' })).toBe('8 2 2 2');
    expect(seriesLinecap({ color: '#a1b2c3', line: 'fine-dot' })).toBe('round');
    expect(seriesLinecap({ color: '#a1b2c3', line: 'dot' })).toBe('butt');
  });

  it('does not convert an untouched legacy color through the native hex input', () => {
    expect(seriesColorFromNativeInput('blue', '#3b98d4', '#3b98d4')).toBe('blue');
    expect(seriesColorFromNativeInput('blue', '#6A5ACD', '#3b98d4')).toBe('#6a5acd');
    expect(seriesColorFromNativeInput('#6a5acd', '#3b98d4', '#6a5acd')).toBe('#3b98d4');
    expect(seriesColorFromNativeInput('blue', 'not-a-color', '#3b98d4')).toBe('blue');
    expect(seriesColorFromNativeInput('blue', 'orange', '#3b98d4')).toBe('blue');
  });

  it('warns without refusing colors that miss the established 3:1 theme contrast', () => {
    expect(seriesColorContrastWarning('#000000')).toBe('dark');
    expect(seriesColorContrastWarning('#ffffff')).toBe('light');
    expect(seriesColorContrastWarning('#777777')).toBeNull();
    expect(seriesColorContrastWarning('blue')).toBeNull();
  });
});
