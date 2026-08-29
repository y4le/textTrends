import { describe, expect, it } from 'vitest';
import {
  beginTrendRowDetent,
  moveTrendRowDetent,
  stepTrendRowPitch,
  trendRowBreakaway,
} from '../src/lib/trend-row-detent.ts';

describe('trend row collapse detent', () => {
  it.each([
    { extent: 4, coarse: false, expected: 6 },
    { extent: 10, coarse: false, expected: 10 },
    { extent: 37, coarse: false, expected: 16 },
    { extent: 5, coarse: true, expected: 10 },
    { extent: 13, coarse: true, expected: 13 },
    { extent: 49, coarse: true, expected: 24 },
  ])('bounds a $extent pixel consequence to $expected pixels', ({ extent, coarse, expected }) => {
    expect(trendRowBreakaway(extent, coarse)).toBe(expected);
  });

  it('holds at miniature, breaks upward to hidden, and restores symmetrically', () => {
    let state = beginTrendRowDetent(24, 14, 100);
    let moved = moveTrendRowDetent(state, {
      clientY: 97, requestedPitch: 21, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moved).toMatchObject({ pitch: 24, hint: 'hide', state: { mode: 'held' } });
    state = moved.state;
    moved = moveTrendRowDetent(state, {
      clientY: 91, requestedPitch: 15, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moved).toMatchObject({ pitch: 24, hint: 'hide', state: { mode: 'held' } });
    state = moved.state;
    moved = moveTrendRowDetent(state, {
      clientY: 90, requestedPitch: 14, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moved).toMatchObject({ pitch: 14, hint: null, state: { mode: 'below' } });
    state = moved.state;
    moved = moveTrendRowDetent(state, {
      clientY: 95, requestedPitch: 19, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moved).toMatchObject({ pitch: 14, hint: 'restore', state: { mode: 'below' } });
    moved = moveTrendRowDetent(moved.state, {
      clientY: 100, requestedPitch: 24, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moved).toMatchObject({ pitch: 24, hint: null, state: { mode: 'above' } });
  });

  it('absorbs tremor around the miniature boundary without flapping', () => {
    let state = beginTrendRowDetent(24, 14, 100);
    const pitches: number[] = [];
    for (const clientY of [99, 101, 98, 100, 97, 99]) {
      const moved = moveTrendRowDetent(state, {
        clientY,
        requestedPitch: 24 + clientY - 100,
        minPitch: 14,
        inkPitch: 24,
        coarse: false,
      });
      state = moved.state;
      pitches.push(moved.pitch);
    }
    expect(pitches).toEqual([24, 25, 24, 24, 24, 24]);
    expect(pitches).not.toContain(14);
  });

  it('holds a clamped one-frame flick and re-arms on each gesture', () => {
    const start = beginTrendRowDetent(18, 14, 100);
    expect(moveTrendRowDetent(start, {
      clientY: 80, requestedPitch: 14, minPitch: 14, inkPitch: 18, coarse: false,
    })).toMatchObject({ pitch: 18, hint: 'hide', state: { mode: 'held' } });
    expect(beginTrendRowDetent(18, 14, 80)).toMatchObject({ mode: 'above', anchorY: 80 });
  });

  it('restores when a new gesture starts from the collapsed floor', () => {
    const start = beginTrendRowDetent(14, 14, 100);
    expect(moveTrendRowDetent(start, {
      clientY: 105, requestedPitch: 19, minPitch: 14, inkPitch: 24, coarse: false,
    })).toMatchObject({ pitch: 14, hint: 'restore', state: { mode: 'below' } });
    expect(moveTrendRowDetent(start, {
      clientY: 110, requestedPitch: 24, minPitch: 14, inkPitch: 24, coarse: false,
    })).toMatchObject({ pitch: 24, hint: null, state: { mode: 'above' } });
  });

  it('passes ordinary pitches through before the miniature boundary', () => {
    const start = beginTrendRowDetent(40, 14, 100);
    expect(moveTrendRowDetent(start, {
      clientY: 96, requestedPitch: 36, minPitch: 14, inkPitch: 24, coarse: false,
    })).toMatchObject({ pitch: 36, hint: null, state: { mode: 'above' } });
  });

  it('does not re-arm collapse while continuing downward after restore', () => {
    const restored = moveTrendRowDetent(beginTrendRowDetent(14, 14, 100), {
      clientY: 110, requestedPitch: 24, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moveTrendRowDetent(restored.state, {
      clientY: 112, requestedPitch: 16, minPitch: 14, inkPitch: 24, coarse: false,
    })).toMatchObject({ pitch: 24, hint: null, state: { mode: 'above' } });
  });

  it('can collapse the seven-pixel fine miniature in one deliberate move', () => {
    const start = beginTrendRowDetent(21, 14, 100);
    expect(moveTrendRowDetent(start, {
      clientY: 93, requestedPitch: 14, minPitch: 14, inkPitch: 21, coarse: false,
    })).toMatchObject({ pitch: 14, hint: null, state: { mode: 'below' } });
  });

  it('stays collapsed while a pointer below the detent keeps moving upward', () => {
    const below = moveTrendRowDetent(beginTrendRowDetent(24, 14, 100), {
      clientY: 90, requestedPitch: 14, minPitch: 14, inkPitch: 24, coarse: false,
    });
    expect(moveTrendRowDetent(below.state, {
      clientY: 86, requestedPitch: 14, minPitch: 14, inkPitch: 24, coarse: false,
    })).toMatchObject({ pitch: 14, hint: null, state: { mode: 'below' } });
  });

  it('becomes a pass-through when no barcode gap exists', () => {
    const state = beginTrendRowDetent(14, 14, 100);
    expect(moveTrendRowDetent(state, {
      clientY: 90, requestedPitch: 9, minPitch: 14, inkPitch: 14, coarse: false,
    }).pitch).toBe(9);
  });
});

describe('trend row keyboard stops', () => {
  const stops = { minPitch: 14, inkPitch: 24, maxPitch: 100 };

  it('lands on miniature before collapsing and uses a second squeeze action', () => {
    expect(stepTrendRowPitch(27, -1, 8, stops)).toBe(24);
    expect(stepTrendRowPitch(24, -1, 1, stops)).toBe(14);
  });

  it('restores the miniature band in one expansion action', () => {
    expect(stepTrendRowPitch(14, 1, 1, stops)).toBe(24);
    expect(stepTrendRowPitch(14, 1, 32, stops)).toBe(24);
  });

  it('clamps ordinary steps and stays contiguous without a gap', () => {
    expect(stepTrendRowPitch(80, 1, 32, stops)).toBe(100);
    expect(stepTrendRowPitch(40, -1, 8, stops)).toBe(32);
    expect(stepTrendRowPitch(24, 1, 8, stops)).toBe(32);
    expect(stepTrendRowPitch(14, -1, 8, stops)).toBe(14);
  });
});
