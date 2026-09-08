/** Shared Trends issuance. The runtime owns lanes, guards, pending publication,
 * and cross-domain refresh ordering; writers choose baseline or range storage. */
import { DISPERSION_BUCKET_BUDGET, DISPERSION_EXACT_MAX, termGroupIdentity, type TermGroupSpec, type TrendBinsSpecV1 } from '@texttrends/core';
import type { SeriesIntent, SeriesTrendState, DispersionState } from './app-state.ts';
import type { KwicTrack, WireSelectionV4 } from '../shared/analysis-contract.ts';
import type { OperationLease } from './operation-lease.ts';
import type { QueryIssuer, QueryLane } from './query-lane.ts';

export function issueTrendSeries(
  lane: QueryLane,
  intent: {
    readonly snapshot: string;
    readonly selection: WireSelectionV4;
    readonly series: readonly SeriesIntent[];
    readonly bins: TrendBinsSpecV1;
  },
  lease: OperationLease,
  deps: {
    readonly issue: QueryIssuer;
    specFor(id: string): TermGroupSpec | null;
    identityOf(id: string): string | null;
  },
  write: (id: string, state: SeriesTrendState) => void,
): void {
  for (const series of intent.series) {
    const group = deps.specFor(series.id);
    if (group === null) continue;
    const identity = termGroupIdentity(group);
    const deliver = (state: SeriesTrendState) => {
      if (deps.identityOf(series.id) === identity) write(series.id, state);
    };
    deps.issue(lane, intent.snapshot, {
      op: 'trend', selection: intent.selection, group,
      request: { coordinate: 'declared-sequence', bins: intent.bins },
    }, lease,
    (data) => deliver({ status: 'ready', trend: data.trend }),
    (message) => deliver({ status: 'error', message }));
  }
}

export function issueDispersion(
  issue: QueryIssuer,
  lane: QueryLane,
  snapshot: string,
  selection: WireSelectionV4,
  tracks: readonly KwicTrack[],
  lease: OperationLease,
  write: (state: DispersionState['state']) => void,
): void {
  issue(lane, snapshot, {
    op: 'dispersion', selection, tracks,
    request: { method: 'dispersion/1', exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET },
  }, lease,
  (data) => write({ status: 'ready', result: data.dispersion }),
  (message) => write({ status: 'error', message }));
}
