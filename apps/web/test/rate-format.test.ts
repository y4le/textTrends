import { describe, expect, it } from 'vitest';
import { formatRate } from '../src/lib/rate-format.ts';

describe('rate formatting', () => {
  it('keeps the ordinary one-decimal grammar for rates of at least one', () => {
    expect(formatRate(1)).toBe('1');
    expect(formatRate(12.34)).toBe('12.3');
    expect(formatRate(1_234.56)).toBe('1,234.6');
  });

  it('preserves three significant decimal digits for rare non-zero rates', () => {
    expect(formatRate(0.5)).toBe('0.5');
    expect(formatRate(0.05432)).toBe('0.0543');
    expect(formatRate(0.004567)).toBe('0.00457');
    expect(formatRate(0.000_000_123_4)).toBe('0.000000123');
    expect(formatRate(-0.05432)).toBe('-0.0543');
    expect(formatRate(0.9999)).toBe('1');
  });

  it('uses scientific notation below the Intl fractional-digit limit', () => {
    expect(formatRate(1e-18)).toBe('0.000000000000000001');
    expect(formatRate(1e-19)).toBe('1.00e-19');
    expect(formatRate(Number.MIN_VALUE)).toBe('4.94e-324');
  });

  it('normalizes zero and labels non-finite input honestly', () => {
    expect(formatRate(0)).toBe('0');
    expect(formatRate(-0)).toBe('0');
    expect(formatRate(Number.NaN)).toBe('unavailable');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('unavailable');
  });
});
