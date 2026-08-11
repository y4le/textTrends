import type { BarcodeTrackVM } from './barcode-view.ts';

export interface BarcodeStepperVM {
  readonly track: BarcodeTrackVM | null;
  readonly unit: 'occurrence' | 'bucket';
  readonly enabled: boolean;
}

/**
 * A coarse pointer gets one honest navigation control, owned by chart focus.
 * The dense canvas remains analytical ink rather than pretending each 7px row
 * is a touch target.
 */
export function barcodeStepperFor(
  tracks: readonly BarcodeTrackVM[],
  focusedSeries: string | null,
): BarcodeStepperVM {
  const focused = focusedSeries === null
    ? null
    : tracks.find((track) => track.seriesId === focusedSeries) ?? null;
  const track = focused ?? tracks[0] ?? null;
  if (!track) {
    return {
      track: null,
      unit: 'occurrence',
      enabled: false,
    };
  }

  return {
    track,
    unit: track.representation === 'exact' ? 'occurrence' : 'bucket',
    enabled: track.total > 0 && track.segments.length > 0,
  };
}
