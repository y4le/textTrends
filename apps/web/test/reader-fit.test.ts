import { describe, expect, it } from 'vitest';
import {
  advanceReaderFit,
  readerProbeRange,
  startReaderFit,
} from '../src/lib/reader-fit.ts';

describe('reader visual fit search', () => {
  it('grows exponentially, bisects, and returns the maximal fitting count', () => {
    let search = startReaderFit(4_096, 64);
    const probes: number[] = [];
    for (;;) {
      probes.push(search.probe);
      const result = advanceReaderFit(search, search.probe <= 347);
      if (result.done) {
        expect(result).toEqual({ done: true, count: 347, saturated: false });
        break;
      }
      search = result.search;
    }
    expect(probes.slice(0, 4)).toEqual([64, 128, 256, 512]);
    expect(probes.length).toBeLessThan(16);
  });

  it('reports reservoir saturation and clamps an over-tall single token', () => {
    let saturated = startReaderFit(8, 4);
    let outcome = advanceReaderFit(saturated, true);
    expect(outcome.done).toBe(false);
    if (!outcome.done) saturated = outcome.search;
    outcome = advanceReaderFit(saturated, true);
    expect(outcome).toEqual({ done: true, count: 8, saturated: true });

    const single = advanceReaderFit(startReaderFit(10, 1), false);
    expect(single).toEqual({ done: true, count: 1, saturated: false });
  });

  it('builds nested forward, backward, and anchor-retaining probe ranges', () => {
    const source = { tokens: { start: 100, end: 120 } };
    expect(readerProbeRange(source, { kind: 'from', token: 104 }, 5))
      .toEqual({ start: 104, end: 109 });
    expect(readerProbeRange(source, { kind: 'before', token: 116 }, 5))
      .toEqual({ start: 111, end: 116 });
    expect(readerProbeRange(source, { kind: 'around', token: 110 }, 1))
      .toEqual({ start: 110, end: 111 });
    expect(readerProbeRange(source, { kind: 'around', token: 110 }, 2))
      .toEqual({ start: 110, end: 112 });
    expect(readerProbeRange(source, { kind: 'around', token: 110 }, 3))
      .toEqual({ start: 109, end: 112 });
    expect(readerProbeRange(source, { kind: 'around', token: 119 }, 5))
      .toEqual({ start: 115, end: 120 });
  });
});
