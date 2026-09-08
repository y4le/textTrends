import { LatestOperation, type OperationScope, type OperationLease } from './operation-lease.ts';
import type { QueryOpV4, QueryResultDataV4 } from '../shared/analysis-contract.ts';

/** One query-intent lane: latest-wins ownership plus the in-flight transport
 *  cancels it may best-effort clean up. Superseding is ONE operation, so no
 *  call site can cancel without invalidating or invalidate without cancelling. */
export class QueryLane {
  private readonly cancels = new Set<() => void>();
  readonly ops: LatestOperation;
  constructor(scope: OperationScope) {
    this.ops = new LatestOperation(scope);
  }
  /** Cancel + drop every tracked request and supersede outstanding leases.
   *  Cancellation is best-effort by contract — one throwing cancel must not
   *  abort the supersession (or teardown) of its peers. */
  supersede(): void {
    for (const c of this.cancels) {
      try {
        c();
      } catch {
        // The request either settles normally or its lease is already dead.
      }
    }
    this.cancels.clear();
    this.ops.invalidate();
  }
  track(cancel: () => void): () => void {
    this.cancels.add(cancel);
    return () => this.cancels.delete(cancel);
  }
}

export type QueryIssuer = (
  lane: QueryLane,
  snapshotId: string,
  op: QueryOpV4,
  lease: OperationLease,
  onReady: (data: QueryResultDataV4) => void,
  onError: (message: string) => void,
  errorMessage?: (error: unknown) => string,
) => void;
