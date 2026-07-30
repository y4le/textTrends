/**
 * The user-data lane (contract §12.5/§12.6), extracted from the engine: it
 * shares the worker's job/cancellation infrastructure but NOT generation
 * state, snapshots, progress, or the analysis error channel — it emits ONLY
 * user-data acknowledgements/errors. Extraction is safe precisely because of
 * that isolation: the handler owns load/save/source-persist policy over an
 * injected durable provider, a cancellation predicate, and a narrow emitter,
 * while the engine keeps job bookkeeping and dispatch.
 */

import {
  hashSourceBytes,
  parseResearchState,
  reconcileResearchState,
  upgradeStoredManifest,
  upgradeStoredResearchState,
  validateProjectManifest,
} from '@texttrends/core';
import type { FromWorkerV4, ToWorkerV4, UserDataErrorCodeV4 } from './protocol-v4.ts';
import { PROTOCOL_VERSION_V4 } from './protocol-v4.ts';
import { UserDataError, type StoredSourceV1, type UserDataStore } from './user-data-store.ts';
import type { StorageOpen } from '../shared/storage-contract.ts';

/**
 * The durable user-data access seam (engine-v4 consult §Q2). The engine never
 * requires a durable store to CONSTRUCT — analysis must start without it. Only
 * a user-data command awaits the provider; the provider memoizes the (single,
 * bounded) open so repeated commands do not re-open.
 */
export type UserDataAccess = StorageOpen<UserDataStore>;
export type UserDataProvider = () => Promise<UserDataAccess>;

export type UserDataMessage = Extract<
  ToWorkerV4,
  {
    t:
      | 'project-load'
      | 'project-save'
      | 'research-load'
      | 'research-save'
      | 'source-persist';
  }
>;

/** Map a caught user-data failure to its precise code (storage faults keep
 *  their UserDataError code; anything else is a request/persistence fault). */
function mapUserDataCode(e: unknown): UserDataErrorCodeV4 {
  if (e instanceof UserDataError) return e.code as UserDataErrorCodeV4;
  return 'PERSISTENCE_UNAVAILABLE';
}

export class UserDataHandler {
  constructor(
    private readonly deps: {
      readonly provider: UserDataProvider;
      readonly maxSourceBytesPerFile: number;
      /** True if this job was cancelled (the engine owns the job set). */
      readonly isCancelled: (job: number) => boolean;
      readonly emit: (message: FromWorkerV4) => void;
    },
  ) {}

  /**
   * Reads and pre-write CPU work are cancellable; a durable write is
   * cancellable only BEFORE its transaction starts — once it commits, a
   * truthful acknowledgement wins over a late cancel (else the main thread
   * sits at revision N while storage is at N+1, producing a misleading
   * conflict on retry).
   */
  async handle(message: UserDataMessage): Promise<void> {
    const job = message.job;
    // Tracks whether an IRREVERSIBLE durable write has begun. A failure from a
    // cancellable PRE-WRITE await (provider, read, hash, validation) on a
    // cancelled job must surface as `cancelled`, not as a storage error — but
    // once a write has started the truthful ack/error rule takes over.
    let writeStarted = false;
    try {
      if (message.t === 'project-load') {
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return;
        const read = await access.getProject(message.project);
        if (this.checkCancelled(job)) return;
        if (read.kind === 'miss') {
          this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'project-missing', job, project: message.project });
          return;
        }
        if (read.kind === 'corrupt') {
          this.emitUserDataError(job, 'DATA_CORRUPT', `stored project is corrupt: ${read.reason}`);
          return;
        }
        let manifest;
        try {
          // Lazily migrate a manifest saved by an older build (pre-container
          // source discriminant / candidateReconstruction) BEFORE durable
          // admission — this is the worker's own validation gate, so the upgrade
          // must happen here (not only main-thread) or an old project is rejected
          // as DATA_CORRUPT before it can reopen. A genuinely-corrupt record is
          // left unchanged by the upgrader and still fails validation below.
          manifest = await validateProjectManifest(await upgradeStoredManifest(read.value));
        } catch (e) {
          if (this.checkCancelled(job)) return; // cancelled during recipe/hash recomputation
          this.emitUserDataError(job, 'DATA_CORRUPT', `stored project failed validation: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (this.checkCancelled(job)) return; // deep validation recomputes hashes — recheck before publishing
        this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'project-loaded', job, project: message.project, manifest });
        return;
      }

      if (message.t === 'project-save') {
        let next;
        try {
          next = await validateProjectManifest(message.manifest);
        } catch (e) {
          if (this.checkCancelled(job)) return;
          this.emitUserDataError(job, 'REQUEST_INVALID', `manifest failed validation: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (this.checkCancelled(job)) return; // recheck after the (awaited) deep validation, before the write
        if (next.id !== message.project) {
          this.emitUserDataError(job, 'REQUEST_INVALID', 'manifest id does not match the save target');
          return;
        }
        if (next.revision !== message.expectedRevision + 1) {
          this.emitUserDataError(job, 'REQUEST_INVALID', `manifest revision ${next.revision} must be expectedRevision + 1 (${message.expectedRevision + 1})`);
          return;
        }
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return; // last cancellable point before the durable write
        writeStarted = true;
        const { committed } = await access.putProject(next, message.expectedRevision);
        this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'project-saved', job, project: message.project, revision: committed.revision });
        return;
      }

      if (message.t === 'research-load') {
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return;
        const read = await access.getResearch(message.project);
        if (this.checkCancelled(job)) return;
        if (read.kind === 'miss') {
          this.deps.emit({
            v: PROTOCOL_VERSION_V4,
            t: 'research-missing',
            job,
            project: message.project,
          });
          return;
        }
        if (read.kind === 'corrupt') {
          this.emitUserDataError(
            job,
            'DATA_CORRUPT',
            `stored research state is corrupt: ${read.reason}`,
          );
          return;
        }
        let state;
        try {
          state = reconcileResearchState(
            parseResearchState(upgradeStoredResearchState(read.value)),
          );
        } catch (e) {
          this.emitUserDataError(
            job,
            'DATA_CORRUPT',
            `stored research state failed validation: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        if (this.checkCancelled(job)) return;
        this.deps.emit({
          v: PROTOCOL_VERSION_V4,
          t: 'research-loaded',
          job,
          project: message.project,
          state,
        });
        return;
      }

      if (message.t === 'research-save') {
        let next;
        try {
          next = parseResearchState(message.state);
        } catch (e) {
          this.emitUserDataError(
            job,
            'REQUEST_INVALID',
            `research state failed validation: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        if (next.project !== message.project) {
          this.emitUserDataError(
            job,
            'REQUEST_INVALID',
            'research project does not match the save target',
          );
          return;
        }
        if (next.revision !== message.expectedRevision + 1) {
          this.emitUserDataError(
            job,
            'REQUEST_INVALID',
            `research revision ${next.revision} must be expectedRevision + 1 (${message.expectedRevision + 1})`,
          );
          return;
        }
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return;
        writeStarted = true;
        const { committed } = await access.putResearch(
          next,
          message.expectedRevision,
        );
        this.deps.emit({
          v: PROTOCOL_VERSION_V4,
          t: 'research-saved',
          job,
          project: message.project,
          revision: committed.revision,
        });
        return;
      }

      // source-persist: cap → hash → verify → durable put → ack.
      if (message.bytes.byteLength > this.deps.maxSourceBytesPerFile) {
        this.emitUserDataError(job, 'REQUEST_INVALID', `source of ${message.bytes.byteLength} bytes exceeds the per-file cap`);
        return;
      }
      const hash = await hashSourceBytes(new Uint8Array(message.bytes));
      if (this.checkCancelled(job)) return;
      if (hash !== message.sourceHash) {
        this.emitUserDataError(job, 'SOURCE_MISMATCH', `bytes hashed to ${hash.slice(0, 16)}… but the claim was ${message.sourceHash.slice(0, 16)}…`);
        return;
      }
      const access = await this.access(job);
      if (!access) return;
      if (this.checkCancelled(job)) return; // last cancellable point before the durable write
      writeStarted = true;
      const record: StoredSourceV1 = { schema: 'texttrends/source/1', hash, byteLength: message.bytes.byteLength, bytes: message.bytes };
      await access.putSource(record);
      this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'source-persisted', job, sourceHash: hash });
    } catch (e) {
      // A pre-write failure on a cancelled job is a cancellation, not a storage
      // error — cancellation wins until an irreversible write has begun.
      if (!writeStarted && this.checkCancelled(job)) return;
      this.emitUserDataError(job, mapUserDataCode(e), e instanceof Error ? e.message : String(e), e instanceof UserDataError ? e.currentRevision : undefined);
    }
  }

  /** Await the durable provider for a user-data command; emit a precise
   *  user-data error (never an analysis error) when it is not available. */
  private async access(job: number): Promise<UserDataStore | null> {
    const access = await this.deps.provider();
    if (this.checkCancelled(job)) return null;
    if (access.kind === 'ok') return access.store;
    this.emitUserDataError(job, 'PERSISTENCE_UNAVAILABLE', access.message);
    return null;
  }

  /** True if the job was cancelled — emits `cancelled` and returns true so the
   *  caller stops BEFORE an irreversible write. */
  private checkCancelled(job: number): boolean {
    if (this.deps.isCancelled(job)) {
      this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'cancelled', job });
      return true;
    }
    return false;
  }

  private emitUserDataError(job: number, code: UserDataErrorCodeV4, message: string, currentRevision?: number): void {
    this.deps.emit({ v: PROTOCOL_VERSION_V4, t: 'user-data-error', job, code, message, ...(currentRevision === undefined ? {} : { currentRevision }) });
  }
}
