/**
 * UserDataStore — class-1 DURABLE storage (ingest/structure plan §(c);
 * contract §12.5/§12.6). Projects and opted-in source bytes live in a
 * SEPARATE database from the disposable artifact cache: its contract is
 * migration, not abandonment, and its writes may FAIL but must never
 * pretend to succeed.
 *
 * SINGLE REVISION AUTHORITY (engine-v4 consult §Q3): the durable project
 * record IS the canonical `ProjectManifestV1`, whose own `revision` is the
 * sole compare-and-swap authority. There is no wrapper carrying a second
 * id/revision — that dual authority is exactly what §E rejected. `putProject`
 * receives an ALREADY-VALIDATED manifest whose `revision` the caller set to
 * `expectedRevision + 1`; the store never stamps a revision into an unvalidated
 * blob (and never runs async validation inside a live IndexedDB transaction).
 *
 * Two capabilities the class-3 ArtifactStore deliberately lacks:
 * - putProject is a COMPARE-AND-SWAP on the manifest's monotonic revision —
 *   two tabs cannot silently last-write-win over metadata or chapter
 *   corrections (a mismatch is REVISION_CONFLICT, surfaced, never swallowed);
 * - reads and writes report typed failure (PERSISTENCE_UNAVAILABLE /
 *   QUOTA_EXCEEDED) instead of degrading to memory, so the UI can stay
 *   visibly unsaved. A CLOSED store rejects rather than masquerading as a
 *   miss — "no durable connection" is not "no project".
 */

import type { ProjectManifestV1 } from '@texttrends/core';
import type { CacheRead } from './store.ts';

export type UserDataErrorCode =
  | 'PERSISTENCE_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'REVISION_CONFLICT'
  // An existing durable project record fails the shallow envelope check: a CAS
  // must REFUSE rather than treat unusable data as "no record" and overwrite
  // the only recoverable copy. The record is retained, never auto-replaced.
  | 'DATA_CORRUPT';

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

/** A stored source record — opted-in raw bytes, content-addressed. */
export interface StoredSourceV1 {
  readonly schema: 'texttrends/source/1';
  readonly hash: string;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

export interface UserDataStore {
  /**
   * A hit is the raw persisted manifest, returned as `unknown` — durable input
   * is never more trusted than wire input, so the caller deep-validates it
   * (validateProjectManifest) before use. `corrupt` means the storage envelope
   * failed a shallow schema/id/revision check; a CLOSED/unavailable store
   * REJECTS with PERSISTENCE_UNAVAILABLE rather than reporting a miss.
   */
  getProject(id: string): Promise<CacheRead<unknown>>;
  /**
   * COMPARE-AND-SWAP on the manifest's own revision. `next` is an
   * already-validated canonical manifest whose `revision` MUST equal
   * `expectedRevision + 1` (use expectedRevision 0 for a first create). Commits
   * only if the stored revision equals `expectedRevision`; returns the
   * committed manifest. Throws UserDataError('REVISION_CONFLICT', …,
   * currentRevision) on a stale expectation, and the typed failure codes on
   * storage errors.
   */
  putProject(next: ProjectManifestV1, expectedRevision: number): Promise<{ readonly committed: ProjectManifestV1 }>;

  getSource(hash: string): Promise<CacheRead<StoredSourceV1>>;
  putSource(source: StoredSourceV1): Promise<void>;
  deleteSource(hash: string): Promise<void>;

  close(): void;
}

/** The store-side CAS precondition: `next` is a validated manifest, but the
 *  store still refuses a caller that violates the monotonic-revision contract
 *  (a programming fault, distinct from a runtime storage failure — thrown
 *  before any transaction so it is never remapped to a storage code). */
export function assertRevisionContract(nextRevision: number, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError(`expectedRevision ${expectedRevision} must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(nextRevision) || nextRevision !== expectedRevision + 1) {
    throw new RangeError(`next manifest revision ${nextRevision} must equal expectedRevision + 1 (${expectedRevision + 1})`);
  }
}

/** Shallow envelope check for a stored manifest — the store validates only
 *  identity/CAS fields; the caller performs deep validation. A hit that fails
 *  this is corrupt storage, not a valid project. */
export function projectEnvelopeReason(record: unknown, id: string): string | null {
  if (record === null || typeof record !== 'object') return 'stored project is not an object';
  const r = record as Record<string, unknown>;
  if (r.schema !== 'texttrends/project/1') return `unknown stored-project schema '${String(r.schema)}'`;
  if (r.id !== id) return 'stored project id disagreement';
  if (typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) || r.revision < 1) {
    return 'stored project revision is not a positive safe integer';
  }
  return null;
}

/** In-memory UserDataStore for tests and the persistence-unavailable
 *  fallback path. Enforces the SAME CAS and closed-store semantics as the
 *  durable store so conflict/unavailability handling is exercised without
 *  IndexedDB. */
export class InMemoryUserDataStore implements UserDataStore {
  private readonly projects = new Map<string, ProjectManifestV1>();
  private readonly sources = new Map<string, StoredSourceV1>();
  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new UserDataError('PERSISTENCE_UNAVAILABLE', 'the durable store is closed');
  }

  // The methods are async so a synchronous guard throw (closed store, revision
  // contract) surfaces as a REJECTED promise — the same shape callers see from
  // the IndexedDB store, never a synchronous exception on the happy interface.
  async getProject(id: string): Promise<CacheRead<unknown>> {
    this.assertOpen();
    const value = this.projects.get(id);
    if (value === undefined) return { kind: 'miss' };
    const reason = projectEnvelopeReason(value, id);
    return reason === null ? { kind: 'hit', value } : { kind: 'corrupt', reason };
  }

  async putProject(next: ProjectManifestV1, expectedRevision: number): Promise<{ readonly committed: ProjectManifestV1 }> {
    assertRevisionContract(next.revision, expectedRevision);
    this.assertOpen();
    const current = this.projects.get(next.id);
    // A corrupt existing record must not be silently treated as "no record"
    // (revision 0) and overwritten — that would destroy the only recoverable
    // copy exactly when it needs reporting.
    if (current !== undefined) {
      const reason = projectEnvelopeReason(current, next.id);
      if (reason !== null) throw new UserDataError('DATA_CORRUPT', `existing durable project is corrupt: ${reason}`);
    }
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new UserDataError('REVISION_CONFLICT', `expected revision ${expectedRevision}, stored ${currentRevision}`, currentRevision);
    }
    this.projects.set(next.id, next);
    return { committed: next };
  }

  async getSource(hash: string): Promise<CacheRead<StoredSourceV1>> {
    this.assertOpen();
    const value = this.sources.get(hash);
    return value === undefined ? { kind: 'miss' } : { kind: 'hit', value };
  }
  async putSource(source: StoredSourceV1): Promise<void> {
    this.assertOpen();
    this.sources.set(source.hash, source);
  }
  async deleteSource(hash: string): Promise<void> {
    this.assertOpen();
    this.sources.delete(hash);
  }

  close(): void {
    this.closed = true;
  }
}
