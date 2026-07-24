import { describe, expect, it } from 'vitest';
import {
  KeyedLatestOperation,
  LatestOperation,
  OperationScope,
} from '../src/lib/operation-lease.ts';

describe('LatestOperation — unkeyed latest-wins', () => {
  it('supersedes an earlier lease when a newer one begins', () => {
    const ops = new LatestOperation();
    const a = ops.begin();
    expect(a.isCurrent()).toBe(true);
    const b = ops.begin();
    expect(a.isCurrent()).toBe(false); // superseded
    expect(b.isCurrent()).toBe(true);
  });

  it('invalidate() supersedes the current owner without a new lease', () => {
    const ops = new LatestOperation();
    const a = ops.begin();
    ops.invalidate();
    expect(a.isCurrent()).toBe(false);
    // a subsequent begin is current again
    expect(ops.begin().isCurrent()).toBe(true);
  });

  it('ids are monotonic', () => {
    const ops = new LatestOperation();
    const a = ops.begin();
    const b = ops.begin();
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('a guard that is false makes the lease not current even as the latest', () => {
    const ops = new LatestOperation();
    let ok = true;
    const a = ops.begin(() => ok);
    expect(a.isCurrent()).toBe(true);
    ok = false;
    expect(a.isCurrent()).toBe(false); // evidence identity moved
  });

  it('composes multiple guards (all must hold)', () => {
    const ops = new LatestOperation();
    let g1 = true;
    let g2 = true;
    const a = ops.begin(() => g1, () => g2);
    expect(a.isCurrent()).toBe(true);
    g2 = false;
    expect(a.isCurrent()).toBe(false);
  });

  it('lets a guard exception surface rather than swallowing it as stale', () => {
    const ops = new LatestOperation();
    const a = ops.begin(() => { throw new Error('bad guard'); });
    expect(() => a.isCurrent()).toThrow('bad guard');
  });
});

describe('KeyedLatestOperation — latest-per-key', () => {
  it('keeps distinct keys independent', () => {
    const ops = new KeyedLatestOperation<string>();
    const a1 = ops.begin('a');
    const b1 = ops.begin('b');
    expect(a1.isCurrent()).toBe(true);
    expect(b1.isCurrent()).toBe(true);
    const a2 = ops.begin('a'); // only supersedes key 'a'
    expect(a1.isCurrent()).toBe(false);
    expect(a2.isCurrent()).toBe(true);
    expect(b1.isCurrent()).toBe(true); // untouched
  });

  it('invalidate(key) supersedes only that key without a new lease', () => {
    const ops = new KeyedLatestOperation<string>();
    const a = ops.begin('a');
    const b = ops.begin('b');
    ops.invalidate('a');
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
  });

  it('clear() makes every prior lease false immediately, with NO revival after key reuse', () => {
    const ops = new KeyedLatestOperation<string>();
    const a = ops.begin('a');
    ops.clear();
    expect(a.isCurrent()).toBe(false); // cleared
    const a2 = ops.begin('a'); // same key reused
    expect(a2.isCurrent()).toBe(true);
    expect(a.isCurrent()).toBe(false); // the OLD lease must not revive
    expect(a2.id).toBeGreaterThan(a.id); // monotonic across clear
  });
});

describe('OperationScope — shared invalidation', () => {
  it('a scope lease is current until the scope is invalidated', () => {
    const scope = new OperationScope();
    const l = scope.lease();
    expect(l.isCurrent()).toBe(true);
    scope.invalidate();
    expect(l.isCurrent()).toBe(false);
  });

  it('a scope lease carries NO id — the shared revision is not a correlation id', () => {
    const scope = new OperationScope();
    expect('id' in scope.lease()).toBe(false);
  });

  it('close() permanently supersedes current and future leases', () => {
    const scope = new OperationScope();
    scope.close();
    expect(scope.lease().isCurrent()).toBe(false); // future lease also dead
  });

  it('propagates scope invalidation to a LatestOperation lease', () => {
    const scope = new OperationScope();
    const ops = new LatestOperation(scope);
    const a = ops.begin();
    expect(a.isCurrent()).toBe(true);
    scope.invalidate(); // e.g. the project was replaced
    expect(a.isCurrent()).toBe(false);
    // a NEW operation under the invalidated (but not closed) scope is current
    expect(ops.begin().isCurrent()).toBe(true);
  });

  it('propagates scope invalidation to a KeyedLatestOperation lease', () => {
    const scope = new OperationScope();
    const ops = new KeyedLatestOperation<string>(scope);
    const a = ops.begin('doc');
    expect(a.isCurrent()).toBe(true);
    scope.invalidate();
    expect(a.isCurrent()).toBe(false);
  });

  it('close() on the scope kills scoped latest-operation leases (disposal)', () => {
    const scope = new OperationScope();
    const ops = new LatestOperation(scope);
    const a = ops.begin();
    scope.close();
    expect(a.isCurrent()).toBe(false);
    expect(ops.begin().isCurrent()).toBe(false); // nothing revives after close
  });
});
