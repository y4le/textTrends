import { describe, expect, it } from 'vitest';
import { readerProgress } from '../src/lib/reader-progress.ts';

describe('reader progress', () => {
  it('maps the first and final token to exact endpoints', () => {
    expect(readerProgress(0, 101, 'Study')).toEqual({
      token: 0,
      tokenCount: 101,
      fraction: 0,
      percent: 0,
      label: 'Study, 0 percent',
    });
    expect(readerProgress(100, 101, 'Study')).toEqual({
      token: 100,
      tokenCount: 101,
      fraction: 1,
      percent: 100,
      label: 'Study, 100 percent',
    });
  });

  it('clamps out-of-range tokens and rounds only the accessible percentage', () => {
    expect(readerProgress(-4, 11, 'Study')?.fraction).toBe(0);
    expect(readerProgress(4, 11, 'Study')).toMatchObject({
      token: 4,
      fraction: 0.4,
      percent: 40,
    });
    expect(readerProgress(99, 11, 'Study')?.fraction).toBe(1);
  });

  it('keeps a single-token text at its only endpoint', () => {
    expect(readerProgress(0, 1, 'Only')).toMatchObject({
      token: 0,
      fraction: 0,
      percent: 0,
    });
  });

  it.each([
    [0, 0],
    [0, -1],
    [0.5, 10],
    [0, 2.5],
    [Number.NaN, 10],
  ])('rejects an invalid token/count pair (%s, %s)', (token, count) => {
    expect(readerProgress(token, count, 'Invalid')).toBeNull();
  });
});
