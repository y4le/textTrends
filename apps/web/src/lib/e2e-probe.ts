/**
 * E2E-only chart commit counters (Phase B ruling): the scrub-isolation
 * regression test needs to prove the chart SVGs do NOT re-commit while the
 * cursor moves. Guarded by compile-time `__TT_E2E__` at every call site, so
 * production builds dead-code-eliminate both the calls and this module.
 * A separate window global (not the frozen `__ttE2E` trace facade): the
 * facade is sealed at bootstrap, and these counters belong to the component
 * layer, not the protocol trace.
 */

export function recordChartCommit(view: 'series' | 'by-book'): void {
  const w = window as unknown as { __ttChartCommits?: Record<string, number> };
  const counts = (w.__ttChartCommits ??= {});
  counts[view] = (counts[view] ?? 0) + 1;
}
