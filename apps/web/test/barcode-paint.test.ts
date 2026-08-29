import { describe, expect, it } from 'vitest';
import { barcodeTrackRect } from '../src/lib/barcode-paint.ts';

describe('barcode track painting', () => {
  it.each([1, 1.5, 2, 2.5, 3])('snaps miniature tracks to device pixels at DPR %s', (dpr) => {
    const rows = [0, 1, 2, 3].map((row) => barcodeTrackRect(row, 2.25, 1, dpr));
    for (const rect of rows) {
      expect(rect.top * dpr).toBeCloseTo(Math.round(rect.top * dpr), 10);
      expect(rect.height * dpr).toBeCloseTo(Math.round(rect.height * dpr), 10);
      expect(rect.height).toBeGreaterThanOrEqual(1 / dpr);
    }
    for (let row = 1; row < rows.length; row++) {
      const previous = rows[row - 1]!;
      expect(rows[row]!.top).toBeGreaterThanOrEqual(previous.top + previous.height);
    }
  });

  it('keeps authored integer geometry byte-exact at DPR 1', () => {
    expect(barcodeTrackRect(3, 7, 2, 1)).toEqual({ top: 27, height: 7 });
    expect(barcodeTrackRect(2, 5, 2, 1)).toEqual({ top: 14, height: 5 });
  });

  it('keeps a positive sub-pixel track visible as one device pixel', () => {
    expect(barcodeTrackRect(0, 0.2, 1, 1)).toEqual({ top: 0, height: 1 });
    expect(barcodeTrackRect(0, 0.2, 1, 2.5)).toEqual({ top: 0, height: 0.4 });
  });

  it('sanitizes hostile values and never fabricates ink for a hidden track', () => {
    expect(barcodeTrackRect(Number.NaN, Number.NaN, -2, 0))
      .toEqual({ top: 0, height: 0 });
    expect(barcodeTrackRect(0, 0, 1, 2)).toEqual({ top: 0, height: 0 });
  });
});
