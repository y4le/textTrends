import { describe, expect, it } from 'vitest';
import {
  LEGACY_TREND_ROW_PITCH_STORAGE_KEY,
  loadTrendRowPitch,
  resolveTrendRowPitch,
  saveTrendRowPitch,
  TREND_ROW_PITCH_STORAGE_KEY,
  trendRowPitchPreference,
  type TrendRowPitchContext,
} from '../src/lib/trend-row-storage.ts';
import { trendRowSizing } from '../src/lib/trend-row-size.ts';

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    getItem: (key: string) => {
      calls.push(`get:${key}`);
      return values.get(key) ?? null;
    },
    setItem: (key: string, next: string) => {
      calls.push(`set:${key}`);
      values.set(key, next);
    },
    removeItem: (key: string) => {
      calls.push(`remove:${key}`);
      values.delete(key);
    },
    value: (key: string) => values.get(key) ?? null,
    calls: () => calls,
  };
}

const regularOne = Object.freeze({
  tracks: 1,
  width: 'regular',
  coarse: false,
} satisfies TrendRowPitchContext);

describe('trend row-pitch storage', () => {
  it('round-trips one contextual v2 request and removes the legacy key', () => {
    const storage = memoryStorage({
      [LEGACY_TREND_ROW_PITCH_STORAGE_KEY]: '{"pitch":58}',
    });
    const preference = trendRowPitchPreference(58, regularOne);
    saveTrendRowPitch(storage, preference);
    expect(storage.value(TREND_ROW_PITCH_STORAGE_KEY))
      .toBe('{"pitch":58,"tracks":1,"width":"regular","coarse":false}');
    expect(storage.value(LEGACY_TREND_ROW_PITCH_STORAGE_KEY)).toBeNull();
    expect(loadTrendRowPitch(storage)).toEqual(preference);
    expect(TREND_ROW_PITCH_STORAGE_KEY).toBe('texttrends/trend-rows/2');
  });

  it('removes current and legacy requests when sizing returns to automatic', () => {
    const storage = memoryStorage({
      [TREND_ROW_PITCH_STORAGE_KEY]: '{"pitch":58,"tracks":1,"width":"regular","coarse":false}',
      [LEGACY_TREND_ROW_PITCH_STORAGE_KEY]: '{"pitch":58}',
    });
    saveTrendRowPitch(storage, null);
    expect(storage.value(TREND_ROW_PITCH_STORAGE_KEY)).toBeNull();
    expect(storage.value(LEGACY_TREND_ROW_PITCH_STORAGE_KEY)).toBeNull();
  });

  it('does not read the pre-alpha v1 record', () => {
    const storage = memoryStorage({
      [LEGACY_TREND_ROW_PITCH_STORAGE_KEY]: '{"pitch":58}',
    });
    expect(loadTrendRowPitch(storage)).toBeNull();
    expect(storage.calls()).toEqual([`get:${TREND_ROW_PITCH_STORAGE_KEY}`]);
  });

  it.each([
    '{broken',
    'null',
    '[]',
    '{"pitch":0,"tracks":1,"width":"regular","coarse":false}',
    '{"pitch":8193,"tracks":1,"width":"regular","coarse":false}',
    '{"pitch":58.5,"tracks":1,"width":"regular","coarse":false}',
    '{"pitch":58,"tracks":-1,"width":"regular","coarse":false}',
    '{"pitch":58,"tracks":1.5,"width":"regular","coarse":false}',
    '{"pitch":58,"tracks":1,"width":"other","coarse":false}',
    '{"pitch":58,"tracks":1,"width":"regular","coarse":"false"}',
    '{"pitch":58,"tracks":1,"width":"regular","coarse":false,"extra":true}',
  ])('rejects malformed or out-of-contract v2 value %s', (raw) => {
    expect(loadTrendRowPitch(memoryStorage({
      [TREND_ROW_PITCH_STORAGE_KEY]: raw,
    }))).toBeNull();
  });

  it('rejects invalid constructors and writes without disturbing valid storage', () => {
    const storage = memoryStorage({
      [TREND_ROW_PITCH_STORAGE_KEY]: '{"pitch":58,"tracks":1,"width":"regular","coarse":false}',
    });
    expect(trendRowPitchPreference(Number.NaN, regularOne)).toBeNull();
    expect(trendRowPitchPreference(58, { ...regularOne, tracks: -1 })).toBeNull();
    saveTrendRowPitch(storage, { pitch: Number.NaN, context: regularOne });
    expect(storage.value(TREND_ROW_PITCH_STORAGE_KEY))
      .toBe('{"pitch":58,"tracks":1,"width":"regular","coarse":false}');
  });

  it('keeps storage failures non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      removeItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadTrendRowPitch(unavailable)).toBeNull();
    expect(() => saveTrendRowPitch(unavailable, trendRowPitchPreference(58, regularOne)))
      .not.toThrow();
    expect(() => saveTrendRowPitch(unavailable, null)).not.toThrow();
  });
});

describe('trend row-pitch reprojection', () => {
  const contexts: readonly TrendRowPitchContext[] = [
    { width: 'compact', coarse: false, tracks: 1 },
    { width: 'compact', coarse: true, tracks: 3 },
    { width: 'regular', coarse: false, tracks: 2 },
    { width: 'wide', coarse: true, tracks: 5 },
  ];

  it('keeps titles and barcode visibility stable across nonzero contexts', () => {
    for (const sourceContext of contexts) {
      const sourceBounds = trendRowSizing({
        width: sourceContext.width,
        coarse: sourceContext.coarse,
        trackCount: sourceContext.tracks,
        targetPitch: null,
      });
      for (let pitch = sourceBounds.minPitch; pitch <= sourceBounds.maxPitch; pitch++) {
        const source = trendRowSizing({
          width: sourceContext.width,
          coarse: sourceContext.coarse,
          trackCount: sourceContext.tracks,
          targetPitch: pitch,
        });
        const preference = trendRowPitchPreference(source.rowPitch, sourceContext)!;
        for (const liveContext of contexts) {
          const resolved = resolveTrendRowPitch(preference, liveContext);
          const live = trendRowSizing({
            width: liveContext.width,
            coarse: liveContext.coarse,
            trackCount: liveContext.tracks,
            targetPitch: resolved,
          });
          expect(live.titlesPainted).toBe(source.titlesPainted);
          expect(live.barcodeVisible).toBe(source.barcodeVisible);
          expect(resolved === live.minPitch || resolved! >= live.inkPitch).toBe(true);
        }
      }
    }
  });

  it.each([
    { pitch: 14, targetTracks: 5, expected: 14 },
    { pitch: 18, targetTracks: 2, expected: 21 },
    { pitch: 40, targetTracks: 3, expected: 52 },
    { pitch: 61, targetTracks: 3, expected: 77 },
  ])('round-trips treatment $pitch through $targetTracks tracks', ({
    pitch,
    targetTracks,
    expected,
  }) => {
    const source = trendRowPitchPreference(pitch, regularOne)!;
    const targetContext = { ...regularOne, tracks: targetTracks };
    const projected = resolveTrendRowPitch(source, targetContext);
    expect(projected).toBe(expected);
    const target = trendRowPitchPreference(projected!, targetContext)!;
    expect(resolveTrendRowPitch(target, regularOne)).toBe(pitch);
  });

  it('clamps zero-track pitches without reprojection', () => {
    expect(resolveTrendRowPitch(
      trendRowPitchPreference(58, { ...regularOne, tracks: 0 }),
      regularOne,
    )).toBe(58);
    expect(resolveTrendRowPitch(
      trendRowPitchPreference(58, regularOne),
      { ...regularOne, tracks: 0 },
    )).toBe(58);
  });
});
