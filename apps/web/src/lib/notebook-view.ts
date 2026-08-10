/**
 * Pure view-model for the notebook panel (slice-1 commit C). Rendering rules
 * live here, testable without a DOM; the panel component only lays them out.
 *
 * Count qualification (ruling §3): a displayed total is never stale or
 * ambiguously partial — the states are explicit and distinguishable:
 * - 'not-run'  — the group is not in the effective comparison (muted, or
 *                solo excludes it), or there is no corpus yet;
 * - 'pending'  — its trend query is in flight;
 * - 'error'    — its trend query failed;
 * - 'ready'    — a total under the CURRENT semantics (zero is a real total,
 *                rendered as the number 0, never as a missing state), with
 *                `partial: true` when the snapshot is missing documents.
 */

import { groupTitle, type NumericTrend } from '@texttrends/core';
import type { SeriesTrendState } from './store.ts';
import type { NotebookGroupV1 } from './notebook.ts';

export type GroupCountVM =
  | { readonly kind: 'not-run' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly total: number; readonly partial: boolean }
  | {
      readonly kind: 'selected';
      readonly total: number;
      readonly partial: boolean;
      readonly selected:
        | { readonly kind: 'pending' }
        | { readonly kind: 'error'; readonly message: string }
        | { readonly kind: 'ready'; readonly total: number };
    };

export interface NotebookRowVM {
  readonly id: string;
  readonly name: string;
  /** Membership in the comparison ("Shown in analysis"). */
  readonly active: boolean;
  readonly solo: boolean;
  /** Style slot while the group owns one; null renders neutral. */
  readonly slot: number | null;
  /** In the EFFECTIVE projection (active ∩ solo) — rows outside it dim. */
  readonly projected: boolean;
  readonly count: GroupCountVM;
}

/** Total occurrences a trend result carries (sum over every doc/bin). */
export function trendTotal(trend: NumericTrend): number {
  let total = 0;
  for (let i = 0; i < trend.count.length; i++) total += trend.count[i] as number;
  return total;
}

export function countFor(
  projected: boolean,
  hasSnapshot: boolean,
  trendState: SeriesTrendState | undefined,
  partialCorpus: boolean,
  selectedTrendState?: SeriesTrendState,
  hasSelection = false,
): GroupCountVM {
  if (!projected || !hasSnapshot || trendState === undefined) return { kind: 'not-run' };
  switch (trendState.status) {
    case 'pending': return { kind: 'pending' };
    case 'error': return { kind: 'error', message: trendState.message };
    default: {
      const total = trendTotal(trendState.trend);
      if (!hasSelection) return { kind: 'ready', total, partial: partialCorpus };
      if (!selectedTrendState || selectedTrendState.status === 'pending') {
        return { kind: 'selected', total, partial: partialCorpus, selected: { kind: 'pending' } };
      }
      if (selectedTrendState.status === 'error') {
        return {
          kind: 'selected',
          total,
          partial: partialCorpus,
          selected: { kind: 'error', message: selectedTrendState.message },
        };
      }
      return {
        kind: 'selected',
        total,
        partial: partialCorpus,
        selected: { kind: 'ready', total: trendTotal(selectedTrendState.trend) },
      };
    }
  }
}

export function notebookRows(args: {
  readonly groups: readonly NotebookGroupV1[];
  readonly activeGroupIds: ReadonlySet<string>;
  readonly soloGroupId: string | null;
  readonly styleSlots: ReadonlyMap<string, number>;
  readonly trends: ReadonlyMap<string, SeriesTrendState>;
  readonly selectedTrends?: ReadonlyMap<string, SeriesTrendState>;
  readonly hasSelection?: boolean;
  readonly hasSnapshot: boolean;
  readonly partialCorpus: boolean;
}): NotebookRowVM[] {
  return args.groups.map((g) => {
    const active = args.activeGroupIds.has(g.id);
    const projected = active && (args.soloGroupId === null || args.soloGroupId === g.id);
    return {
      id: g.id,
      name: groupTitle(g),
      active,
      solo: args.soloGroupId === g.id,
      slot: args.styleSlots.get(g.id) ?? null,
      projected,
      count: countFor(
        projected,
        args.hasSnapshot,
        args.trends.get(g.id),
        args.partialCorpus,
        args.selectedTrends?.get(g.id),
        args.hasSelection ?? false,
      ),
    };
  });
}
