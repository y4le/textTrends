/**
 * IndexedDB UserDataStore — class-1 DURABLE storage (contract §12.5/§12.6).
 *
 * SAME-NAME MIGRATION contract, opposite of the disposable artifact cache:
 * additive changes bump the IndexedDB version under `texttrends-user-data`
 * and run explicit migrations; the database is never abandoned. A blocked
 * upgrade surfaces "close the other tab and retry" — it must NOT silently
 * fall back and claim a project was saved.
 *
 * putProject is a real COMPARE-AND-SWAP inside one readwrite transaction:
 * the stored revision is read and checked against the caller's expected
 * revision in the same transaction that writes, so two tabs cannot lose an
 * update. Writes report typed failure (never a false success).
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CacheRead } from './store.ts';
import {
  UserDataError,
  type StoredProjectV1,
  type StoredSourceV1,
  type UserDataStore,
} from './user-data-store.ts';

export const USER_DATA_DB_NAME = 'texttrends-user-data';
export const USER_DATA_DB_VERSION = 1;

interface UserDataDb extends DBSchema {
  projects: { key: string; value: StoredProjectV1 };
  sources: { key: string; value: StoredSourceV1 };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
}

export class IdbUserDataStore implements UserDataStore {
  constructor(private db: IDBPDatabase<UserDataDb> | null) {}

  async getProject(id: string): Promise<CacheRead<StoredProjectV1>> {
    if (!this.db) return { kind: 'miss' };
    let record: unknown;
    try {
      record = await this.db.get('projects', id);
    } catch (e) {
      // A read failure on DURABLE data is not silently a miss — the caller
      // must know persistence is impaired rather than assume "no project".
      throw new UserDataError('PERSISTENCE_UNAVAILABLE', `project read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (record === undefined) return { kind: 'miss' };
    // A monotonic CAS record demands a positive SAFE integer revision — a
    // fractional/negative/NaN/unsafe value would corrupt the swap arithmetic.
    if (
      !isRecord(record) || record.schema !== 'texttrends/project/1' || record.id !== id ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    ) {
      return { kind: 'corrupt', reason: 'stored project envelope invalid' };
    }
    return { kind: 'hit', value: record as unknown as StoredProjectV1 };
  }

  async putProject(manifest: unknown, id: string, expectedRevision: number): Promise<{ readonly revision: number }> {
    if (!this.db) throw new UserDataError('PERSISTENCE_UNAVAILABLE', 'no durable storage');
    try {
      // CAS inside ONE transaction: read the stored revision and write only
      // if it still matches, so a concurrent tab cannot be clobbered.
      const tx = this.db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const current = (await store.get(id)) as StoredProjectV1 | undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        await tx.done.catch(() => undefined);
        throw new UserDataError(
          'REVISION_CONFLICT',
          `expected revision ${expectedRevision}, stored ${currentRevision}`,
          currentRevision,
        );
      }
      const revision = currentRevision + 1;
      const record: StoredProjectV1 = { schema: 'texttrends/project/1', id, revision, manifest };
      await store.put(record);
      await tx.done;
      return { revision };
    } catch (e) {
      if (e instanceof UserDataError) throw e;
      throw new UserDataError(
        isQuota(e) ? 'QUOTA_EXCEEDED' : 'PERSISTENCE_UNAVAILABLE',
        `project write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async getSource(hash: string): Promise<CacheRead<StoredSourceV1>> {
    if (!this.db) return { kind: 'miss' };
    let record: unknown;
    try {
      record = await this.db.get('sources', hash);
    } catch (e) {
      throw new UserDataError('PERSISTENCE_UNAVAILABLE', `source read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (record === undefined) return { kind: 'miss' };
    if (
      !isRecord(record) || record.schema !== 'texttrends/source/1' || record.hash !== hash ||
      !(record.bytes instanceof ArrayBuffer) ||
      !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0 ||
      record.byteLength !== record.bytes.byteLength // declared length must equal the buffer
    ) {
      return { kind: 'corrupt', reason: 'stored source envelope invalid' };
    }
    return { kind: 'hit', value: record as unknown as StoredSourceV1 };
  }

  async putSource(source: StoredSourceV1): Promise<void> {
    if (!this.db) throw new UserDataError('PERSISTENCE_UNAVAILABLE', 'no durable storage');
    try {
      await this.db.put('sources', source);
    } catch (e) {
      throw new UserDataError(
        isQuota(e) ? 'QUOTA_EXCEEDED' : 'PERSISTENCE_UNAVAILABLE',
        `source write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async deleteSource(hash: string): Promise<void> {
    // DURABLE deletion is NOT best-effort (unlike class-3 repair deletes):
    // the UI must not acknowledge a deletion that did not persist.
    if (!this.db) throw new UserDataError('PERSISTENCE_UNAVAILABLE', 'no durable storage');
    try {
      await this.db.delete('sources', hash);
    } catch (e) {
      throw new UserDataError(
        isQuota(e) ? 'QUOTA_EXCEEDED' : 'PERSISTENCE_UNAVAILABLE',
        `source delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export type UserDataOpen =
  | { readonly kind: 'ok'; readonly store: UserDataStore }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/**
 * Open the durable store. UNLIKE the artifact cache, a blocked upgrade is
 * NOT silently swapped for memory — the caller must surface it so a project
 * is never falsely reported saved. Returns a discriminated result the worker
 * maps to typed protocol acknowledgements.
 *
 * A `blocked` IndexedDB event does NOT reject the open request: while
 * another tab holds an older connection the open stays pending forever. So
 * the blocked callback settles a `blocked` result immediately, and any
 * database that arrives afterward is CLOSED — it must never leak or become
 * authoritative under a caller that already saw `blocked`.
 *
 * `opener` is an injection seam for the blocked race (which cannot be
 * produced deterministically with a real IndexedDB in-process): it receives
 * an `onBlocked` callback it must invoke when the open is blocked.
 */
export type UserDataOpener = (onBlocked: () => void) => Promise<IDBPDatabase<UserDataDb>>;

export async function openUserDataStore(opener: UserDataOpener = defaultUserDataOpen): Promise<UserDataOpen> {
  if (typeof indexedDB === 'undefined') {
    return { kind: 'unavailable', message: 'IndexedDB is not available; projects cannot be saved' };
  }
  let settled = false;
  return new Promise<UserDataOpen>((resolve) => {
    const settle = (result: UserDataOpen): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // The blocked callback settles IMMEDIATELY — a blocked open never
    // rejects, so waiting on the open promise would hang forever.
    const onBlocked = (): void =>
      settle({ kind: 'blocked', message: 'a project database upgrade is blocked — close other tabs and retry' });
    let opening: Promise<IDBPDatabase<UserDataDb>>;
    try {
      opening = opener(onBlocked);
    } catch (e) {
      settle({ kind: 'unavailable', message: `durable storage unavailable: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    opening.then(
      (db) => {
        if (settled) {
          db.close(); // a blocked result already won — never install this late db
          return;
        }
        settle({ kind: 'ok', store: new IdbUserDataStore(db) });
      },
      (e) => settle({ kind: 'unavailable', message: `durable storage unavailable: ${e instanceof Error ? e.message : String(e)}` }),
    );
  });
}

const defaultUserDataOpen: UserDataOpener = (onBlocked) =>
  openDB<UserDataDb>(USER_DATA_DB_NAME, USER_DATA_DB_VERSION, {
    upgrade(database, oldVersion) {
      // Same-name MIGRATION: create missing stores idempotently. Future
      // versions extend this switch; records are migrated, never dropped.
      if (oldVersion < 1) {
        database.createObjectStore('projects', { keyPath: 'id' });
        database.createObjectStore('sources', { keyPath: 'hash' });
      }
    },
    blocked() {
      onBlocked();
    },
  });
