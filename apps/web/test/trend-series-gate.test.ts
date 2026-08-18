import { describe, expect, it } from 'vitest';
import { trendSeriesGate } from '../src/lib/trend-series-gate.ts';

describe('trend series gate', () => {
  it('holds while foreground or shared-scale context is unresolved', () => {
    expect(trendSeriesGate([{ status: 'ready' }], [{ status: 'pending' }])).toBe('pending');
    expect(trendSeriesGate([{ status: 'pending' }], [{ status: 'ready' }])).toBe('pending');
    expect(trendSeriesGate([{ status: 'ready' }], [undefined])).toBe('pending');
  });

  it('does not paint context without a ready foreground', () => {
    expect(trendSeriesGate([{ status: 'error' }], [{ status: 'ready' }])).toBe('unavailable');
  });

  it('omits failed context after the foreground and remaining context settle', () => {
    expect(trendSeriesGate(
      [{ status: 'ready' }],
      [{ status: 'ready' }, { status: 'error' }],
    )).toBe('ready');
  });

  it('allows the normal foreground-only path once it is ready', () => {
    expect(trendSeriesGate([{ status: 'ready' }], [])).toBe('ready');
  });
});
