import type { BarcodeTrackVM } from './barcode-view.ts';

export interface BarcodeStepperVM {
  readonly track: BarcodeTrackVM | null;
  readonly label: string;
  readonly unit: 'occurrence' | 'bucket';
  readonly enabled: boolean;
  readonly fellBack: boolean;
}

/**
 * A coarse pointer gets one honest navigation control, owned by chart focus.
 * The dense canvas remains analytical ink rather than pretending each 7px row
 * is a touch target.
 */
export function barcodeStepperFor(
  tracks: readonly BarcodeTrackVM[],
  focusedSeries: string | null,
  labelOf: (seriesId: string) => string,
): BarcodeStepperVM {
  const focused = focusedSeries === null
    ? null
    : tracks.find((track) => track.seriesId === focusedSeries) ?? null;
  const track = focused ?? tracks[0] ?? null;
  if (!track) {
    return {
      track: null,
      label: 'No occurrence track',
      unit: 'occurrence',
      enabled: false,
      fellBack: false,
    };
  }

  const occurrenceLabel = `${track.total.toLocaleString()} occurrence${track.total === 1 ? '' : 's'}`;
  return {
    track,
    label: `${labelOf(track.seriesId)} · ${occurrenceLabel}${track.representation === 'density' ? ' in density buckets' : ''}`,
    unit: track.representation === 'exact' ? 'occurrence' : 'bucket',
    enabled: track.total > 0 && track.segments.length > 0,
    fellBack: focused === null,
  };
}
