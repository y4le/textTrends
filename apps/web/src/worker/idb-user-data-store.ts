/**
 * IndexedDB UserDataStore — class-1 DURABLE storage (contract §12.5/§12.6).
 *
 * SAME-NAME MIGRATION contract, opposite of the disposable artifact cache:
 * additive changes bump the IndexedDB version under `texttrends-user-data`
 * and run explicit migrations; the database is never abandoned. A blocked
 * upgrade surfaces "close the other tab and retry" — it must NOT silently
 * fall back and claim a project was saved.
 *
 * SINGLE REVISION AUTHORITY (engine-v4 consult §Q3): the project record IS the
 * canonical `ProjectManifestV1`, keyed by its own `id`, and its own `revision`
 * is the sole CAS authority. Version 2 migrates the version-1 wrapper record
 * ({id, revision, manifest}) into its inner manifest when the two agree, and
 * leaves anything inconsistent for the deep validator to reject as corrupt —
 * never inventing a project from an ambiguous record.
 *
 * putProject is a real COMPARE-AND-SWAP inside one readwrite transaction: the
 * stored revision is read and checked against the caller's expected revision
 * in the same transaction that writes, so two tabs cannot lose an update. The
 * pre-validated `next` manifest is written unchanged — no async validation runs
 * inside the live transaction (a transaction can go inactive while a Web Crypto
 * promise settles). A CLOSED connection rejects PERSISTENCE_UNAVAILABLE rather
 * than masquerading as a miss.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProjectManifestV1 } from '@texttrends/core';
import type { CacheRead } from './store.ts';
import {
  UserDataError,
  assertRevisionContract,
  projectEnvelopeReason,
  type StoredSourceV1,
  type UserDataStore,
} from './user-data-store.ts';

export const USER_DATA_DB_NAME = 'texttrends-user-data';
/** v2: the project record became the canonical manifest (single revision
 *  authority). The version-1 wrapper is migrated in place, not abandoned. */
export const USER_DATA_DB_VERSION = 2;

interface UserDataDb extends DBSchema {
  projects: { key: string; value: ProjectManifestV1 };
  sources: { key: string; value: StoredSourceV1 };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
}

export class IdbUserDataStore implements UserDataStore {
  constructor(private db: IDBPDatabase<UserDataDb> | null) {}

  private requireOpen(): IDBPDatabase<UserDataDb> {
    if (!this.db) throw new UserDataError('PERSISTENCE_UNAVAILABLE', 'the durable store is closed or unavailable');
    return this.db;
  }

  async getProject(id: string): Promise<CacheRead<unknown>> {
    // A CLOSED durable connection is NOT a miss — the caller must learn that
    // persistence is impaired rather than conclude "no project exists".
    const db = this.requireOpen();
    let record: unknown;
    try {
      record = await db.get('projects', id);
    } catch (e) {
      throw new UserDataError('PERSISTENCE_UNAVAILABLE', `project read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (record === undefined) return { kind: 'miss' };
    const reason = projectEnvelopeReason(record, id);
    // A hit is returned as raw `unknown`; the caller deep-validates it.
    return reason === null ? { kind: 'hit', value: record } : { kind: 'corrupt', reason };
  }

  async putProject(next: ProjectManifestV1, expectedRevision: number): Promise<{ readonly committed: ProjectManifestV1 }> {
    // Contract precondition (programming fault) BEFORE any transaction, so it
    // is never remapped to a storage failure code.
    assertRevisionContract(next.revision, expectedRevision);
    const db = this.requireOpen();
    try {
      // CAS inside ONE transaction: read the stored revision and write only
      // if it still matches, so a concurrent tab cannot be clobbered.
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const current = await store.get(next.id);
      // A corrupt existing record is NOT "no record": treating its unusable
      // revision as 0 would overwrite the only recoverable copy and report
      // success. Shallow-check it inside the transaction and refuse — never
      // auto-replace or delete (the DATA_CORRUPT path reports and retains it).
      // A bail-out must ABORT the readwrite transaction, not let it auto-commit
      // an empty write: an explicit abort documents "no mutation happened" and
      // forecloses any future partial commit. tx.abort() makes tx.done reject,
      // which we consume before throwing the typed error.
      const abortAndThrow = async (error: UserDataError): Promise<never> => {
        tx.abort();
        await tx.done.catch(() => undefined);
        throw error;
      };
      let currentRevision = 0;
      if (current !== undefined) {
        const reason = projectEnvelopeReason(current, next.id);
        if (reason !== null) {
          await abortAndThrow(new UserDataError('DATA_CORRUPT', `existing durable project is corrupt: ${reason}`));
        }
        currentRevision = (current as { revision: number }).revision;
      }
      if (currentRevision !== expectedRevision) {
        await abortAndThrow(
          new UserDataError('REVISION_CONFLICT', `expected revision ${expectedRevision}, stored ${currentRevision}`, currentRevision),
        );
      }
      await store.put(next);
      await tx.done;
      return { committed: next };
    } catch (e) {
      if (e instanceof UserDataError) throw e;
      throw new UserDataError(
        isQuota(e) ? 'QUOTA_EXCEEDED' : 'PERSISTENCE_UNAVAILABLE',
        `project write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async getSource(hash: string): Promise<CacheRead<StoredSourceV1>> {
    const db = this.requireOpen();
    let record: unknown;
    try {
      record = await db.get('sources', hash);
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
    const db = this.requireOpen();
    try {
      await db.put('sources', source);
    } catch (e) {
      throw new UserDataError(
        isQuota(e) ? 'QUOTA_EXCEEDED' : 'PERSISTENCE_UNAVAILABLE',
        `source write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** versionchange from another context (a newer-version upgrade elsewhere):
   *  close so that context can proceed. Subsequent operations reject
   *  PERSISTENCE_UNAVAILABLE — never a silent miss or false success. */
  handleVersionChange(): void {
    this.close();
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
 * the blocked callback settles a `blocked` result immediately. Separately, an
 * opener that neither resolves nor fires `blocked` is bounded by a timeout and
 * settles `unavailable`, so a hung durable open can never wedge worker startup
 * (analysis must proceed without it). Any database that arrives after the race
 * is already settled is CLOSED — it must never leak or become authoritative
 * under a caller that already saw `blocked`/`unavailable`.
 *
 * `opener` is an injection seam for the blocked/timeout races (which cannot be
 * produced deterministically with a real IndexedDB in-process): it receives
 * an `onBlocked` callback it must invoke when the open is blocked.
 */
export type UserDataOpener = (onBlocked: () => void) => Promise<IDBPDatabase<UserDataDb>>;

export async function openUserDataStore(
  opener: UserDataOpener = defaultUserDataOpen,
  openTimeoutMs = 2000,
): Promise<UserDataOpen> {
  if (typeof indexedDB === 'undefined') {
    return { kind: 'unavailable', message: 'IndexedDB is not available; projects cannot be saved' };
  }
  let settled = false;
  return new Promise<UserDataOpen>((resolve) => {
    const settle = (result: UserDataOpen): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A hung open (no resolve, no blocked event) must not wedge startup.
    const timer = setTimeout(
      () => settle({ kind: 'unavailable', message: 'durable storage open timed out; projects cannot be saved this session' }),
      openTimeoutMs,
    );
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
          db.close(); // a blocked/timeout result already won — never install this late db
          return;
        }
        const store = new IdbUserDataStore(db);
        // Another context upgrading the database must not be blocked by this
        // connection: close and invalidate the adapter on versionchange.
        db.addEventListener('versionchange', () => store.handleVersionChange());
        settle({ kind: 'ok', store });
      },
      (e) => settle({ kind: 'unavailable', message: `durable storage unavailable: ${e instanceof Error ? e.message : String(e)}` }),
    );
  });
}

const defaultUserDataOpen: UserDataOpener = (onBlocked) =>
  openDB<UserDataDb>(USER_DATA_DB_NAME, USER_DATA_DB_VERSION, {
    async upgrade(database, oldVersion, _newVersion, tx) {
      // Same-name MIGRATION: create missing stores idempotently.
      if (oldVersion < 1) {
        database.createObjectStore('projects', { keyPath: 'id' });
        database.createObjectStore('sources', { keyPath: 'hash' });
      }
      // v1 → v2: unwrap the old { schema, id, revision, manifest } wrapper into
      // its canonical inner manifest — but ONLY when BOTH the outer wrapper is
      // itself a valid v1 envelope (correct schema, a positive-safe-integer
      // revision, a string id) AND its inner manifest agrees on schema, id, and
      // revision. Anything else — a foreign outer schema, a bad outer revision,
      // a disagreeing inner — is left as-is for the deep validator to reject as
      // corrupt; it is never deleted or invented into a valid project (the
      // durable contract is migration, not fabrication).
      if (oldVersion >= 1 && oldVersion < 2) {
        const store = tx.objectStore('projects');
        let cursor = await store.openCursor();
        while (cursor) {
          const rec = cursor.value as unknown as Record<string, unknown>;
          if (rec && typeof rec === 'object' && 'manifest' in rec) {
            const inner = rec.manifest as Record<string, unknown> | null;
            const outerValid =
              rec.schema === 'texttrends/project/1' && typeof rec.id === 'string' &&
              Number.isSafeInteger(rec.revision) && (rec.revision as number) >= 1;
            const innerAgrees =
              inner !== null && typeof inner === 'object' &&
              inner.schema === 'texttrends/project/1' && inner.id === rec.id && inner.revision === rec.revision;
            if (outerValid && innerAgrees) {
              await cursor.update(inner as unknown as ProjectManifestV1);
            }
          }
          cursor = await cursor.continue();
        }
      }
    },
    blocked() {
      onBlocked();
    },
  });
