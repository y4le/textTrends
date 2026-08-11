/** Captured query-track presentation for Reader highlights. */

import type { SeriesStyleV1 } from '@texttrends/core';

export interface CapturedTrack {
  readonly seriesId: string;
  readonly groupId: string;
  readonly identity: string;
  readonly label: string;
  readonly style: SeriesStyleV1;
}

export interface TrackLegendEntry {
  readonly seriesId: string;
  readonly label: string;
  readonly style: SeriesStyleV1;
  readonly stale: boolean;
}

/** Use live presentation while a captured matching identity remains current.
 * After a semantic edit/removal, preserve the captured label and colour so
 * recycled styles cannot silently relabel Reader marks. */
export function trackLegend(
  captured: readonly CapturedTrack[],
  liveIdentityOf: (seriesId: string) => string | null,
  liveSeries: readonly {
    readonly id: string;
    readonly label: string;
    readonly style: SeriesStyleV1;
  }[],
): readonly TrackLegendEntry[] {
  const live = new Map(liveSeries.map((series) => [series.id, series]));
  return captured.map((track) => {
    const current = live.get(track.seriesId);
    const stale = liveIdentityOf(track.seriesId) !== track.identity || current === undefined;
    return {
      seriesId: track.seriesId,
      label: stale ? track.label : current.label,
      style: stale ? track.style : current.style,
      stale,
    };
  });
}
