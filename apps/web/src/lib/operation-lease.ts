/**
 * A tiny "latest owner" fence for main-thread async operations, replacing the
 * hand-rolled counter + captured-epoch + bespoke stale-check that the project
 * session and store each reimplemented per operation.
 *
 * The one guarantee: a lease `isCurrent()` only while it is still the latest
 * operation of its lane AND every captured guard/scope still holds. It is
 * purely a LOCAL ownership authority — it never cancels transport, writes UI
 * state, or classifies errors (cancellation is orthogonal, best-effort cleanup).
 *
 * Three narrowly-defined issuers:
 * - `OperationScope` — a shared invalidation scope (e.g. one project lifetime);
 *   its `lease()` captures scope-only fences (no latest-wins lane, no id).
 * - `LatestOperation` — the latest UNKEYED operation of a lane wins (save, load,
 *   a store query intent). `begin()` mints an `OwnedOperationLease`.
 * - `KeyedLatestOperation<K>` — the latest operation PER KEY wins, keys
 *   independent (a per-document correction / persist / reattach). `begin()`
 *   mints an `OwnedOperationLease`.
 *
 * Guards stay visible at the call site so the evidence identity (snapshot key,
 * focused doc, …) is auditable rather than hidden in a generic context object.
 * A guard that throws surfaces as an invariant fault; it is never swallowed as
 * "stale".
 */

export interface OperationLease {
  /** True only while every ownership/scope/guard condition still holds. */
  isCurrent(): boolean;
}

/** A lease minted by a latest-wins lane (`begin()`). Only those leases carry an
 *  id: the lane counter is monotonic per issuance, so captured ids are safe to
 *  compare for correlation (e.g. "is the posted save still THE save"). A plain
 *  scope lease has no id — the scope revision is shared by every lease of that
 *  revision and must not masquerade as a correlation id. */
export interface OwnedOperationLease extends OperationLease {
  /** Opaque monotonic correlation id (a caller may surface it in its state). */
  readonly id: number;
}

/** A shared invalidation scope. `invalidate()` supersedes every lease captured
 *  from the previous revision (ownership actually changed); `close()`
 *  permanently supersedes current and future leases (disposal). */
export class OperationScope {
  private revision = 0;
  private closed = false;

  /** Capture the current scope revision as a lease — for operations whose only
   *  fence is "this scope has not changed / closed" plus any extra guards.
   *  Deliberately NOT an `OwnedOperationLease`: every lease of one revision
   *  would share the same number, which is not a correlation id. */
  lease(...guards: readonly (() => boolean)[]): OperationLease {
    const at = this.revision;
    return {
      isCurrent: () => !this.closed && this.revision === at && guards.every((g) => g()),
    };
  }

  invalidate(): void {
    this.revision++;
  }

  close(): void {
    this.closed = true;
  }
}

/** The latest unkeyed operation of this lane wins. */
export class LatestOperation {
  private counter = 0;
  private current = 0;

  constructor(private readonly scope?: OperationScope) {}

  begin(...guards: readonly (() => boolean)[]): OwnedOperationLease {
    const token = ++this.counter;
    this.current = token;
    const scopeLease = this.scope?.lease();
    return {
      id: token,
      isCurrent: () => this.current === token && (scopeLease?.isCurrent() ?? true) && guards.every((g) => g()),
    };
  }

  /** Supersede the current owner WITHOUT starting another async operation. */
  invalidate(): void {
    this.current = ++this.counter;
  }
}

/** The latest operation per key wins; distinct keys are independent. */
export class KeyedLatestOperation<K> {
  private counter = 0;
  private readonly current = new Map<K, number>();

  constructor(private readonly scope?: OperationScope) {}

  begin(key: K, ...guards: readonly (() => boolean)[]): OwnedOperationLease {
    const token = ++this.counter;
    this.current.set(key, token);
    const scopeLease = this.scope?.lease();
    return {
      id: token,
      isCurrent: () => this.current.get(key) === token && (scopeLease?.isCurrent() ?? true) && guards.every((g) => g()),
    };
  }

  invalidate(key: K): void {
    this.current.set(key, ++this.counter);
  }

  /** Supersede EVERY key immediately. The counter is monotonic (never reset), so
   *  a cleared key that is later reused mints a strictly-higher token and an old
   *  lease can never revive. */
  clear(): void {
    this.current.clear();
  }
}
