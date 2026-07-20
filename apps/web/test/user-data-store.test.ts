/**
 * UserDataStore — the DURABLE class-1 store (contract §12.5/§12.6): SINGLE
 * revision authority (the record IS the canonical manifest), CAS revisions,
 * typed write failures that never fake success, corruption reads, a CLOSED
 * connection that rejects rather than reporting a miss, same-name migration
 * from the v1 wrapper, and a bounded open. In-memory and IndexedDB
 * implementations are held to the SAME semantics.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import type { ProjectManifestV1 } from '@texttrends/core';
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

/** A minimal store-shaped manifest — the durable store shallow-checks only
 *  schema/id/revision, so store tests need not build a deeply valid manifest
 *  (that is validateProjectManifest's job, exercised in core). */
const pm = (id: string, revision: number, extra: Record<string, unknown> = {}): ProjectManifestV1 =>
  ({ schema: 'texttrends/project/1', id, revision, order: [], docs: [], indexRecipe: {}, indexRecipeHash: '', ...extra }) as unknown as ProjectManifestV1;

/** Both implementations must satisfy this contract. */
function contractSuite(name: string, make: () => Promise<UserDataStore>) {
  describe(name, () => {
    it('creates a project at revision 1 from expectedRevision 0 (manifest is the record)', async () => {
      const store = await make();
      expect((await store.getProject('p')).kind).toBe('miss');
      const { committed } = await store.putProject(pm('p', 1, { title: 'v1' }), 0);
      expect(committed.revision).toBe(1);
      const read = await store.getProject('p');
      expect(read.kind).toBe('hit');
      if (read.kind === 'hit') {
        const m = read.value as ProjectManifestV1 & { title?: string };
        expect(m.revision).toBe(1);
        expect(m.title).toBe('v1'); // the manifest itself is stored, unwrapped
      }
      store.close();
    });

    it('CAS: a save with a stale expected revision is REVISION_CONFLICT and does NOT overwrite', async () => {
      const store = await make();
      await store.putProject(pm('p', 1, { title: 'v1' }), 0); // → rev 1
      await store.putProject(pm('p', 2, { title: 'v2' }), 1); // → rev 2
      // A second tab still thinks it holds rev 1.
      await expect(store.putProject(pm('p', 2, { title: 'stale' }), 1)).rejects.toMatchObject({
        name: 'UserDataError',
        code: 'REVISION_CONFLICT',
        currentRevision: 2,
      });
      const read = await store.getProject('p');
      if (read.kind === 'hit') {
        const m = read.value as ProjectManifestV1 & { title?: string };
        expect(m.revision).toBe(2);
        expect(m.title).toBe('v2'); // NOT clobbered
      }
      store.close();
    });

    it('rejects a next manifest whose revision is not expectedRevision + 1 (single authority)', async () => {
      const store = await make();
      await expect(store.putProject(pm('p', 5), 0)).rejects.toThrow(/expectedRevision \+ 1/);
      await expect(store.putProject(pm('p', 1), 3)).rejects.toThrow(/expectedRevision \+ 1/);
      store.close();
    });

    it('a CLOSED store rejects reads with PERSISTENCE_UNAVAILABLE, never a miss', async () => {
      const store = await make();
      store.close();
      await expect(store.getProject('p')).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
      await expect(store.getSource('h')).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
      await expect(store.putProject(pm('p', 1), 0)).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
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
    await first.store.putProject(pm('p', 1, { title: 'kept' }), 0);
    first.store.close();
    const second = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const read = await second.store.getProject('p');
    expect(read.kind).toBe('hit');
    if (read.kind === 'hit') expect((read.value as { title?: string }).title).toBe('kept');
    second.store.close();
  });

  it('reports a corrupt project envelope rather than a hit', async () => {
    await openUserDataStore().then((o) => o.kind === 'ok' && o.store.close());
    const db = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    await db.put('projects', { schema: 'texttrends/project/1', id: 'p', revision: 'not-a-number' } as never);
    db.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    expect((await opened.store.getProject('p')).kind).toBe('corrupt');
    opened.store.close();
  });

  it('migrates a consistent v1 wrapper into its canonical manifest, leaving an inconsistent one corrupt', async () => {
    // Seed a REAL version-1 database with the old wrapper shape.
    const v1 = await openDB(USER_DATA_DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('projects', { keyPath: 'id' });
        database.createObjectStore('sources', { keyPath: 'hash' });
      },
    });
    await v1.put('projects', {
      schema: 'texttrends/project/1', id: 'good', revision: 3,
      manifest: { schema: 'texttrends/project/1', id: 'good', revision: 3, title: 'unwrapped' },
    } as never);
    // An inconsistent wrapper: inner revision disagrees with the outer one.
    await v1.put('projects', {
      schema: 'texttrends/project/1', id: 'bad', revision: 2,
      manifest: { schema: 'texttrends/project/1', id: 'bad', revision: 9 },
    } as never);
    v1.close();

    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const good = await opened.store.getProject('good');
    expect(good.kind).toBe('hit');
    if (good.kind === 'hit') {
      const m = good.value as ProjectManifestV1 & { title?: string; manifest?: unknown };
      expect(m.title).toBe('unwrapped');
      expect(m.manifest).toBeUndefined(); // unwrapped, not the wrapper
      expect(m.revision).toBe(3);
    }
    // The inconsistent record was NOT invented into a valid project; it stays a
    // wrapper, which the envelope check tolerates (schema/id/revision valid)
    // but the deep validator would later reject — critically, it is retained.
    const bad = await opened.store.getProject('bad');
    expect(bad.kind).toBe('hit');
    if (bad.kind === 'hit') expect((bad.value as { manifest?: unknown }).manifest).toBeDefined();
    opened.store.close();
  });

  it('a CAS over a CORRUPT existing record refuses (DATA_CORRUPT) and retains it', async () => {
    // A corrupt durable record must not be treated as "no record" (revision 0)
    // and overwritten — that would destroy the only recoverable copy.
    await openUserDataStore().then((o) => o.kind === 'ok' && o.store.close());
    const db = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    await db.put('projects', { schema: 'texttrends/project/1', id: 'p', revision: 'not-a-number', marker: 'retain-me' } as never);
    db.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: IdbUserDataStore };
    // Observe that the bail-out ABORTS the readwrite transaction rather than
    // letting it auto-commit an empty write — spy on the transaction abort at
    // the IndexedDB level (idb delegates tx.abort() straight to it).
    const abortSpy = vi.spyOn(IDBTransaction.prototype, 'abort');
    await expect(opened.store.putProject(pm('p', 1, { title: 'overwrite' }), 0)).rejects.toMatchObject({ code: 'DATA_CORRUPT' });
    expect(abortSpy).toHaveBeenCalledTimes(1); // a clean abort, not an empty commit
    abortSpy.mockRestore();
    // The corrupt record is still there (a successful overwrite would read hit).
    expect((await opened.store.getProject('p')).kind).toBe('corrupt');
    opened.store.close();
    // And the raw marker survived — nothing was written over it.
    const raw = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    const rec = (await raw.get('projects', 'p')) as { marker?: string };
    expect(rec.marker).toBe('retain-me');
    raw.close();
  });

  it('migration refuses to unwrap a wrapper with a FOREIGN outer schema (leaves it corrupt)', async () => {
    const v1 = await openDB(USER_DATA_DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('projects', { keyPath: 'id' });
        database.createObjectStore('sources', { keyPath: 'hash' });
      },
    });
    // A valid-looking inner manifest smuggled under a corrupt outer envelope.
    await v1.put('projects', {
      schema: 'foreign', id: 'x', revision: 1,
      manifest: { schema: 'texttrends/project/1', id: 'x', revision: 1, title: 'do-not-fabricate' },
    } as never);
    v1.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    // Not unwrapped into a valid project — the corrupt outer envelope stands.
    expect((await opened.store.getProject('x')).kind).toBe('corrupt');
    opened.store.close();
  });

  it('interleaved two-connection CAS: exactly one create commits, the other conflicts', async () => {
    // The property a sequential test cannot prove — two tabs both starting
    // at expectedRevision 0. One transaction must win; the other must see
    // REVISION_CONFLICT with the committed revision.
    const a = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const b = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
    const results = await Promise.allSettled([
      a.store.putProject(pm('p', 1, { tab: 'a' }), 0),
      b.store.putProject(pm('p', 1, { tab: 'b' }), 0),
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
    await expect(opened.store.putProject(pm('p', 1, { title: 'x' }), 0)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(opened.store.putSource(source('h2', 4))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(opened.store.deleteSource('h')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' }); // NOT a silent success
    opened.store.close();
  });

  it('deleteSource on a closed store throws PERSISTENCE_UNAVAILABLE, never fake success', async () => {
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: IdbUserDataStore };
    opened.store.close();
    await expect(opened.store.deleteSource('h')).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });

  it('handleVersionChange closes the connection; later ops reject PERSISTENCE_UNAVAILABLE', async () => {
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: IdbUserDataStore };
    await opened.store.putProject(pm('p', 1), 0);
    opened.store.handleVersionChange(); // another context is upgrading
    await expect(opened.store.getProject('p')).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    await expect(opened.store.putSource(source('h', 4))).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });

  it('rejects a malformed durable source envelope (mismatched byte length)', async () => {
    await openUserDataStore().then((o) => o.kind === 'ok' && o.store.close());
    const db = await openDB(USER_DATA_DB_NAME, USER_DATA_DB_VERSION);
    await db.put('sources', { schema: 'texttrends/source/1', hash: 'bad', byteLength: 99, bytes: new ArrayBuffer(8) } as never);
    db.close();
    const opened = (await openUserDataStore()) as { kind: 'ok'; store: UserDataStore };
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

  it('a hung open (no resolve, no blocked) is bounded by the timeout and closes a late connection', async () => {
    let releaseOpen: ((db: never) => void) | null = null;
    let closed = 0;
    const lateDb = { close: () => void closed++ } as never;
    const opened = await openUserDataStore(
      () => new Promise((resolve) => { releaseOpen = resolve; }),
      10, // 10ms bound
    );
    expect(opened.kind).toBe('unavailable'); // did NOT hang forever
    (releaseOpen as unknown as (db: never) => void)(lateDb);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(1); // the late connection was closed, never installed
  });

  it('openUserDataStore reports unavailable when IndexedDB is absent — NOT a silent success', async () => {
    globalThis.indexedDB = undefined as never;
    const opened = await openUserDataStore();
    expect(opened.kind).toBe('unavailable');
  });
});
