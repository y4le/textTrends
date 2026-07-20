/**
 * UserDataStore — the DURABLE class-1 store (contract §12.5/§12.6): CAS
 * revisions, typed write failures that never fake success, corruption
 * reads, and same-name migration. In-memory and IndexedDB implementations
 * are held to the SAME semantics.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import {
  InMemoryUserDataStore,
  type StoredSourceV1,
  type UserDataStore,
} from '../src/worker/user-data-store.ts';
import {
  IdbUserDataStore,
  USER_DATA_DB_NAME,
  USER_DATA_DB_VERSION,
  openUserDataStore,
} from '../src/worker/idb-user-data-store.ts';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory() as unknown as typeof indexedDB;
});

const source = (hash: string, n: number): StoredSourceV1 => ({
  schema: 'texttrends/source/1',
  hash,
  byteLength: n,
  bytes: new ArrayBuffer(n),
});

/** Both implementations must satisfy this contract. */
function contractSuite(name: string, make: () => Promise<UserDataStore>) {
  describe(name, () => {
    it('creates a project at revision 1 from expectedRevision 0', async () => {
      const store = await make();
      expect((await store.getProject('p')).kind).toBe('miss');
      const { revision } = await store.putProject({ title: 'v1' }, 'p', 0);
      expect(revision).toBe(1);
      const read = await store.getProject('p');
      expect(read.kind).toBe('hit');
      if (read.kind === 'hit') {
        expect(read.value.revision).toBe(1);
        expect(read.value.manifest).toEqual({ title: 'v1' });
      }
      store.close();
    });

    it('CAS: a save with a stale expected revision is REVISION_CONFLICT and does NOT overwrite', async () => {
      const store = await make();
      await store.putProject({ title: 'v1' }, 'p', 0); // → rev 1
      await store.putProject({ title: 'v2' }, 'p', 1); // → rev 2
      // A second tab still thinks it holds rev 1.
      await expect(store.putProject({ title: 'stale' }, 'p', 1)).rejects.toMatchObject({
        name: 'UserDataError',
        code: 'REVISION_CONFLICT',
        currentRevision: 2,
      });
      const read = await store.getProject('p');
      if (read.kind === 'hit') {
        expect(read.value.revision).toBe(2);
        expect(read.value.manifest).toEqual({ title: 'v2' }); // NOT clobbered
      }
      store.close();
    });

    it('round-trips and deletes opted-in sources', async () => {
      const store = await make();
      expect((await store.getSource('h')).kind).toBe('miss');
      await store.putSource(source('h', 8));
      const read = await store.getSource('h');
      expect(read.kind).toBe('hit');
      if (read.kind === 'hit') expect(read.value.byteLength).toBe(8);
      await store.deleteSource('h');
      expect((await store.getSource('h')).kind).toBe('miss');
      store.close();
    });
  });
}

contractSuite('InMemoryUserDataStore', () => Promise.resolve(new InMemoryUserDataStore()));
contractSuite('IdbUserDataStore', async () => {
  const opened = await openUserDataStore();
  if (opened.kind !== 'ok') throw new Error(`open failed: ${opened.kind}`);
  return opened.store;
});

describe('IdbUserDataStore durability specifics', () => {
  it('persists a project across store instances (same database)', async () => {
    const first = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    await first.store.putProject({ title: 'kept' }, 'p', 0);
    first.store.close();
    const second = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const read = await second.store.getProject('p');
    expect(read.kind).toBe('hit');
    if (read.kind === 'hit') expect(read.value.manifest).toEqual({ title: 'kept' });
    second.store.close();
  });

  it('reports a corrupt project envelope rather than a hit', async () => {
    await openUserDataStore().then((o) => o.kind === 'ok' && o.store.close());
    const db = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    await db.put('projects', { schema: 'texttrends/project/1', id: 'p', revision: 'not-a-number', manifest: {} } as never);
    db.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    expect((await opened.store.getProject('p')).kind).toBe('corrupt');
    opened.store.close();
  });

  it('interleaved two-connection CAS: exactly one create commits, the other conflicts', async () => {
    // The property a sequential test cannot prove — two tabs both starting
    // at expectedRevision 0. One transaction must win; the other must see
    // REVISION_CONFLICT with the committed revision.
    const a = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const b = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const results = await Promise.allSettled([
      a.store.putProject({ tab: 'a' }, 'p', 0),
      b.store.putProject({ tab: 'b' }, 'p', 0),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 1 });
    a.store.close();
    b.store.close();
  });

  it('EVERY durable write path surfaces a typed error, never a false success', async () => {
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: IdbUserDataStore };
    await opened.store.putSource(source('h', 4)); // seed for delete
    const internal = opened.store as unknown as {
      db: { transaction: (...a: unknown[]) => unknown; put: (...a: unknown[]) => unknown; delete: (...a: unknown[]) => unknown };
    };
    const quota = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    internal.db.transaction = quota;
    internal.db.put = quota;
    internal.db.delete = quota;
    await expect(opened.store.putProject({ title: 'x' }, 'p', 0)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(opened.store.putSource(source('h2', 4))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(opened.store.deleteSource('h')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' }); // NOT a silent success
    opened.store.close();
  });

  it('deleteSource on a closed store throws PERSISTENCE_UNAVAILABLE, never fake success', async () => {
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: IdbUserDataStore };
    opened.store.close();
    await expect(opened.store.deleteSource('h')).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });

  it('rejects malformed durable envelopes: bad revision and mismatched byte length', async () => {
    await openUserDataStore().then((o) => o.kind === 'ok' && o.store.close());
    const db = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    await db.put('projects', { schema: 'texttrends/project/1', id: 'frac', revision: 1.5, manifest: {} } as never);
    await db.put('projects', { schema: 'texttrends/project/1', id: 'zero', revision: 0, manifest: {} } as never);
    await db.put('sources', { schema: 'texttrends/source/1', hash: 'bad', byteLength: 99, bytes: new ArrayBuffer(8) } as never);
    db.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    expect((await opened.store.getProject('frac')).kind).toBe('corrupt');
    expect((await opened.store.getProject('zero')).kind).toBe('corrupt'); // rev must be >= 1
    expect((await opened.store.getSource('bad')).kind).toBe('corrupt');
    opened.store.close();
  });

  it('a blocked migration resolves PROMPTLY as blocked; a late connection is closed', async () => {
    // The injectable opener seam produces the blocked race deterministically.
    let releaseOpen: ((db: never) => void) | null = null;
    let closed = 0;
    const lateDb = { close: () => void closed++ } as never;
    const opened = await openUserDataStore((onBlocked) => {
      onBlocked(); // the open is blocked right away
      return new Promise((resolve) => {
        releaseOpen = resolve;
      });
    });
    expect(opened.kind).toBe('blocked'); // did NOT hang on the pending open
    // The real database arriving later must be closed, not installed.
    (releaseOpen as unknown as (db: never) => void)(lateDb);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(1);
  });

  it('openUserDataStore reports unavailable when IndexedDB is absent — NOT a silent success', async () => {
    globalThis.indexedDB = undefined as never;
    const opened = await openUserDataStore();
    expect(opened.kind).toBe('unavailable');
  });
});
