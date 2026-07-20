/**
 * UserDataStore — class-1 DURABLE storage (ingest/structure plan §(c);
 * contract §12.5/§12.6). Projects and opted-in source bytes live in a
 * SEPARATE database from the disposable artifact cache: its contract is
 * migration, not abandonment, and its writes may FAIL but must never
 * pretend to succeed.
 *
 * Two capabilities the class-3 ArtifactStore deliberately lacks:
 * - putProject is a COMPARE-AND-SWAP on a monotonic revision — two tabs
 *   cannot silently last-write-win over metadata or chapter corrections
 *   (a mismatch is REVISION_CONFLICT, surfaced, never swallowed);
 * - writes report typed failure (PERSISTENCE_UNAVAILABLE / QUOTA_EXCEEDED)
 *   instead of degrading to memory, so the UI can stay visibly unsaved.
 */

import type { CacheRead } from './store.ts';

export type UserDataErrorCode =
  | 'PERSISTENCE_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'REVISION_CONFLICT';

export class UserDataError extends Error {
  readonly code: UserDataErrorCode;
  /** For a conflict, the revision actually stored (so the caller can rebase). */
  readonly currentRevision?: number;
  constructor(code: UserDataErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = 'UserDataError';
    this.code = code;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

/** A stored project record — the manifest plus its committed revision. */
export interface StoredProjectV1 {
  readonly schema: 'texttrends/project/1';
  readonly id: string;
  readonly revision: number;
  /** The full ProjectManifestV1 payload (validated by the caller/engine). */
  readonly manifest: unknown;
}

/** A stored source record — opted-in raw bytes, content-addressed. */
export interface StoredSourceV1 {
  readonly schema: 'texttrends/source/1';
  readonly hash: string;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

export interface UserDataStore {
  getProject(id: string): Promise<CacheRead<StoredProjectV1>>;
  /**
   * COMPARE-AND-SWAP: commit succeeds only if the stored revision equals
   * `expectedRevision` (use 0 for a first create). Returns the NEW committed
   * revision. Throws UserDataError('REVISION_CONFLICT', …, currentRevision)
   * on a mismatch, and the typed failure codes on storage errors.
   */
  putProject(manifest: unknown, id: string, expectedRevision: number): Promise<{ readonly revision: number }>;

  getSource(hash: string): Promise<CacheRead<StoredSourceV1>>;
  putSource(source: StoredSourceV1): Promise<void>;
  deleteSource(hash: string): Promise<void>;

  close(): void;
}

/** In-memory UserDataStore for tests and the persistence-unavailable
 *  fallback path. Enforces the SAME CAS semantics as the durable store so
 *  conflict handling is exercised without IndexedDB. */
export class InMemoryUserDataStore implements UserDataStore {
  private readonly projects = new Map<string, StoredProjectV1>();
  private readonly sources = new Map<string, StoredSourceV1>();

  getProject(id: string): Promise<CacheRead<StoredProjectV1>> {
    const value = this.projects.get(id);
    return Promise.resolve(value === undefined ? { kind: 'miss' } : { kind: 'hit', value });
  }

  putProject(manifest: unknown, id: string, expectedRevision: number): Promise<{ readonly revision: number }> {
    const current = this.projects.get(id);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      return Promise.reject(
        new UserDataError('REVISION_CONFLICT', `expected revision ${expectedRevision}, stored ${currentRevision}`, currentRevision),
      );
    }
    const revision = currentRevision + 1;
    this.projects.set(id, { schema: 'texttrends/project/1', id, revision, manifest });
    return Promise.resolve({ revision });
  }

  getSource(hash: string): Promise<CacheRead<StoredSourceV1>> {
    const value = this.sources.get(hash);
    return Promise.resolve(value === undefined ? { kind: 'miss' } : { kind: 'hit', value });
  }
  putSource(source: StoredSourceV1): Promise<void> {
    this.sources.set(source.hash, source);
    return Promise.resolve();
  }
  deleteSource(hash: string): Promise<void> {
    this.sources.delete(hash);
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release.
  }
}
