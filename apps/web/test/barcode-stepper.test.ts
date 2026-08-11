import { describe, expect, it } from 'vitest';
import type { BarcodeTrackVM } from '../src/lib/barcode-view.ts';
import { barcodeStepperFor } from '../src/lib/barcode-stepper.ts';

const exact = (seriesId: string, total = 2): BarcodeTrackVM => ({
  seriesId,
  groupId: `group-${seriesId}`,
  representation: 'exact',
  total,
  docOrder: ['book'],
  segments: total > 0
    ? [{ kind: 'tick', doc: 'book', t0: 1, t1: 2, ordinal: 0 }]
    : [],
  segmentsByDocOrdinal: total > 0
    ? [[{ kind: 'tick', doc: 'book', t0: 1, t1: 2, ordinal: 0 }]]
    : [[]],
});

describe('barcodeStepperFor', () => {
  it('selects the focused exact track', () => {
    const view = barcodeStepperFor(
      [exact('holmes'), exact('moriarty', 1)],
      'moriarty',
    );
    expect(view.track?.seriesId).toBe('moriarty');
    expect(view).toMatchObject({
      unit: 'occurrence',
      enabled: true,
    });
  });

  it('falls back to the first delivered track when focus has no track', () => {
    const view = barcodeStepperFor([exact('holmes')], 'missing');
    expect(view.track?.seriesId).toBe('holmes');
  });

  it('names density buckets without presenting them as exact hits', () => {
    const dense: BarcodeTrackVM = {
      ...exact('holmes', 12),
      representation: 'density',
      segments: [{
        kind: 'cell',
        doc: 'book',
        t0: 0,
        t1: 10,
        count: 12,
        intensity: 1,
        midToken: 5,
      }],
      segmentsByDocOrdinal: [[{
        kind: 'cell',
        doc: 'book',
        t0: 0,
        t1: 10,
        count: 12,
        intensity: 1,
        midToken: 5,
      }]],
    };
    expect(barcodeStepperFor([dense], 'holmes')).toMatchObject({
      unit: 'bucket',
      enabled: true,
    });
  });

  it('disables empty and absent tracks', () => {
    expect(barcodeStepperFor([exact('holmes', 0)], 'holmes').enabled).toBe(false);
    expect(barcodeStepperFor([], null)).toEqual({
      track: null,
      unit: 'occurrence',
      enabled: false,
    });
  });
});
