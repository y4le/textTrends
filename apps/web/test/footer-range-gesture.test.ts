import { describe, expect, it } from 'vitest';
import {
  footerRangeDown,
  footerRangeMove,
  footerRangeUp,
  footerStripZone,
  idleFooterRangeGesture,
  primeFooterRangeGesture,
  resetFooterRangeGesture,
} from '../src/lib/footer-range-gesture.ts';

const point = (token: number) => ({ doc: 'a', token });
const down = (
  state = primeFooterRangeGesture(100, 20, 5),
  overrides: Partial<Parameters<typeof footerRangeDown>[1]> = {},
) => footerRangeDown(state, {
  zone: 'graph',
  pointerId: 2,
  point: point(2),
  clientX: 22,
  clientY: 6,
  at: 200,
  suppressed: false,
  recentDirectPointer: false,
  ...overrides,
});

describe('footer range gesture', () => {
  it('arms only a nearby timely second graph press', () => {
    expect(down()).toMatchObject({ state: { phase: 'armed' }, effect: { kind: 'clear' } });
    expect(down(undefined, { at: 601 }).state.phase).toBe('idle');
    expect(down(undefined, { clientX: 27 }).state.phase).toBe('idle');
    expect(down(undefined, { zone: 'outside' }).state.phase).toBe('idle');
    expect(down(undefined, { recentDirectPointer: true }).state.phase).toBe('idle');
    expect(down(idleFooterRangeGesture()).state.phase).toBe('idle');
  });

  it('clears on a stationary double press and commits only after four pixels', () => {
    const armed = down().state;
    expect(footerRangeMove(armed, {
      pointerId: 2,
      point: point(3),
      clientX: 25,
      clientY: 6,
    }).state.phase).toBe('armed');
    expect(footerRangeUp(armed, 2)).toEqual({
      state: { phase: 'idle' },
      effect: { kind: 'none' },
    });
    const preview = footerRangeMove(armed, {
      pointerId: 2,
      point: point(8),
      clientX: 30,
      clientY: 6,
    });
    expect(preview).toMatchObject({
      state: { phase: 'brushing', head: point(8) },
      effect: { kind: 'preview', head: point(8), clearsCommitted: false },
    });
    expect(footerRangeUp(preview.state, 2)).toMatchObject({
      state: { phase: 'idle' },
      effect: { kind: 'commit', origin: point(2), head: point(8) },
    });
  });

  it('arms a barcode silently and clears the committed range only when brushing starts', () => {
    const armed = down(undefined, { zone: 'barcode' });
    expect(armed).toMatchObject({
      state: { phase: 'armed', zone: 'barcode', pendingClear: true },
      effect: { kind: 'none' },
    });
    expect(footerRangeUp(armed.state, 2)).toEqual({
      state: { phase: 'idle' },
      effect: { kind: 'none' },
    });
    const firstMove = footerRangeMove(armed.state, {
      pointerId: 2,
      point: point(8),
      clientX: 30,
      clientY: 6,
    });
    expect(firstMove).toMatchObject({
      state: { phase: 'brushing', head: point(8) },
      effect: { kind: 'preview', head: point(8), clearsCommitted: true },
    });
    expect(footerRangeMove(firstMove.state, {
      pointerId: 2,
      point: point(10),
      clientX: 34,
      clientY: 6,
    })).toMatchObject({
      effect: { kind: 'preview', head: point(10), clearsCommitted: false },
    });
  });

  it('updates and cancels a live preview without priming a third click', () => {
    const armed = down().state;
    const brushing = footerRangeMove(armed, {
      pointerId: 2,
      point: point(8),
      clientX: 30,
      clientY: 6,
    }).state;
    expect(footerRangeMove(brushing, {
      pointerId: 2,
      point: point(10),
      clientX: 34,
      clientY: 6,
    })).toMatchObject({ effect: { kind: 'preview', head: point(10) } });
    expect(resetFooterRangeGesture(brushing)).toEqual({
      state: { phase: 'idle' },
      effect: { kind: 'cancel' },
    });
  });

  it('assigns padding and the barcode gap to the graph lane', () => {
    const geometry = {
      stripHeight: 40,
      stripTop: 6,
      seriesHeight: 12,
      barcodeBandGap: 4,
      trackCount: 3,
    };
    expect(footerStripZone(0, geometry)).toBe('graph');
    expect(footerStripZone(21.9, geometry)).toBe('graph');
    expect(footerStripZone(22, geometry)).toBe('barcode');
    expect(footerStripZone(-1, geometry)).toBe('outside');
    expect(footerStripZone(40, geometry)).toBe('outside');
    expect(footerStripZone(39, { ...geometry, trackCount: 0 })).toBe('graph');
  });
});
