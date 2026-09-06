/**
 * Durable, browser-local acquisition library.
 *
 * Source files and the one current workspace share a database so later
 * deletion can update both atomically. Worker artifacts remain disposable.
 */

import {
  hashSourceBytes,
  INGEST_CAPS_V0,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  parseWorkspace,
  reconcileWorkspaceDocuments,
  sourceFormatForFilename,
  type SourceFormat,
  type WorkspaceV1,
} from '@texttrends/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PreparedBackup } from './workspace-backup.ts';

export const LOCAL_LIBRARY_DB_NAME = 'texttrends-library';
export const LOCAL_LIBRARY_DB_VERSION = 2;

const LOCAL_FILE_SCHEMA = 'texttrends/library-file/1' as const;
const CURRENT_WORKSPACE = 'current' as const;
const WORKSPACE_EPOCH = 'restore-epoch';
const PENDING_SETTINGS = 'pending-backup-settings';
const SOURCE_HASH = /^[0-9a-f]{64}$/u;

export interface LocalLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  readonly addedAt: number;
  readonly format: SourceFormat;
  readonly contentHash: string;
}

interface StoredLocalMetadataV1 extends LocalLibraryItem {
  readonly schema: typeof LOCAL_FILE_SCHEMA;
}

// Reads stay unknown because existing databases can contain damaged records.
interface LocalLibraryDb extends DBSchema {
  files: {
    key: IDBValidKey;
    value: unknown;
    indexes: { addedAt: number };
  };
  bodies: {
    key: IDBValidKey;
    value: unknown;
  };
  workspace: {
    key: string;
    value: unknown;
  };
}

export interface LocalFileInput {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly type?: string;
  readonly lastModified?: number;
}

export interface LocalLibraryFile extends LocalFileInput {
  readonly library: string;
  readonly format: SourceFormat;
  readonly contentHash: string;
}

export interface LocalLibraryAddResult {
  readonly item: LocalLibraryItem;
  /** False means the same format + byte hash was already in the library. */
  readonly added: boolean;
}

export type WorkspaceReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly workspace: WorkspaceV1 }
  | { readonly kind: 'corrupt'; readonly reason: string };

export interface LocalLibraryDeleteResult {
  /** Every active workspace document that referenced the deleted source. */
  readonly removedDocuments: readonly string[];
}

/** Source bytes can legitimately be interpreted under different formats, so
 * dedupe exact content within a format rather than collapsing those recipes. */
export function localFileIdentity(format: SourceFormat, contentHash: string): string {
  return `${format}:${contentHash}`;
}

function abortQuietly(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have failed or completed; preserve the
    // operation's original error rather than replacing it with InvalidStateError.
  }
}

function supportedFiles(files: readonly LocalFileInput[]): readonly SourceFormat[] {
  const supported = SOURCE_FORMAT_IDS.flatMap((id) => SOURCE_FORMATS[id].extensions).join(', ');
  const formats: SourceFormat[] = [];
  for (const file of files) {
    const format = sourceFormatForFilename(file.name);
    if (format === null) {
      throw new Error(`unsupported file type: '${file.name}' (${supported})`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`'${file.name}' has an invalid file size`);
    }
    if (file.size > INGEST_CAPS_V0.maxSourceBytesPerFile) {
      throw new Error(`'${file.name}' exceeds the ${INGEST_CAPS_V0.maxSourceBytesPerFile}-byte per-file cap`);
    }
    formats.push(format);
  }
  return formats;
}

function validMetadata(value: unknown): value is StoredLocalMetadataV1 {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<StoredLocalMetadataV1>;
  return (
    record.schema === LOCAL_FILE_SCHEMA &&
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.name === 'string' && record.name.length > 0 &&
    typeof record.type === 'string' &&
    typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0 &&
    typeof record.lastModified === 'number' && Number.isFinite(record.lastModified) && record.lastModified >= 0 &&
    typeof record.addedAt === 'number' && Number.isFinite(record.addedAt) && record.addedAt >= 0 &&
    SOURCE_FORMAT_IDS.includes(record.format as SourceFormat) &&
    typeof record.contentHash === 'string' && SOURCE_HASH.test(record.contentHash) &&
    record.id === localFileIdentity(record.format as SourceFormat, record.contentHash)
  );
}

export interface DamagedLibraryItem {
  readonly key: IDBValidKey;
  readonly name: string;
  readonly message: string;
}

export interface LibraryInspection {
  readonly items: readonly LocalLibraryItem[];
  readonly damaged: readonly DamagedLibraryItem[];
}

function itemFromRecord(record: StoredLocalMetadataV1): LocalLibraryItem {
  const { id, name, size, type, lastModified, addedAt, format, contentHash } = record;
  return { id, name, size, type, lastModified, addedAt, format, contentHash };
}

export class BrowserLocalLibrary {
  private database: Promise<IDBPDatabase<LocalLibraryDb>> | null = null;
  private epoch: string | null = null;

  constructor(private readonly name = LOCAL_LIBRARY_DB_NAME) {}

  /** Ordinary tabs retain last-write-wins semantics. A restore changes the
   * epoch so a tab opened before replacement cannot write the old setup back. */
  private async checkEpoch(store: { get(key: string): Promise<unknown> }): Promise<string> {
    const stored = await store.get(WORKSPACE_EPOCH);
    if (stored !== undefined && typeof stored !== 'string') throw new Error('The saved workspace epoch is damaged.');
    const epoch = stored ?? 'initial';
    if (this.epoch === null) this.epoch = epoch;
    if (epoch !== this.epoch) throw new Error('This workspace was replaced in another tab. Reload to continue.');
    return epoch;
  }

  private open(): Promise<IDBPDatabase<LocalLibraryDb>> {
    if (this.database !== null) return this.database;
    let abandoned = false;
    let upgrading = false;
    let rejectBlocked!: (error: Error) => void;
    const blocked = new Promise<never>((_resolve, reject) => { rejectBlocked = reject; });
    const request = openDB<LocalLibraryDb>(this.name, LOCAL_LIBRARY_DB_VERSION, {
      blocked() {
        abandoned = true;
        rejectBlocked(new Error('Close other textTrends tabs, then retry opening the local library.'));
      },
      upgrade(database, oldVersion, _newVersion, transaction) {
        upgrading = oldVersion === 1;
        void transaction.done.catch(() => {});
        if (!database.objectStoreNames.contains('files')) {
          const store = database.createObjectStore('files', { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
        if (!database.objectStoreNames.contains('workspace')) {
          database.createObjectStore('workspace');
        }
        if (!database.objectStoreNames.contains('bodies')) database.createObjectStore('bodies');
        if (oldVersion === 1) {
          // Split storage without interpreting or repairing old values. Even a
          // malformed body is preserved at its original primary key. Only IDB
          // requests are awaited so the upgrade transaction remains alive.
          void (async () => {
            let cursor = await transaction.objectStore('files').openCursor();
            while (cursor) {
              const value: unknown = cursor.value;
              if (value !== null && typeof value === 'object' && 'bytes' in value) {
                const { bytes, ...metadata } = value;
                await transaction.objectStore('bodies').put(bytes, cursor.primaryKey);
                await cursor.update(metadata);
              }
              cursor = await cursor.continue();
            }
          })().catch(() => abortQuietly(transaction));
        }
      },
    });
    // A blocked open can eventually succeed after its caller has already been
    // told to retry. Close that abandoned connection instead of leaking it.
    void request.then((database) => { if (abandoned) database.close(); }, () => {});
    const opening = Promise.race([request, blocked]).catch((error: unknown) => {
      if (upgrading && !abandoned) {
        throw new Error('The local library could not be upgraded. Your saved files are unchanged. Check available browser storage and reload to retry.', { cause: error });
      }
      throw error;
    });
    this.database = opening;
    void opening.then(
      (database) => {
        database.addEventListener('versionchange', () => {
          database.close();
          if (this.database === opening) this.database = null;
        });
      },
      () => {
        // A transient open failure may be retried by the next user action.
        if (this.database === opening) this.database = null;
      },
    );
    return opening;
  }

  async inspect(): Promise<LibraryInspection> {
    const database = await this.open();
    const transaction = database.transaction(['files', 'bodies', 'workspace'], 'readonly');
    void transaction.done.catch(() => {});
    await this.checkEpoch(transaction.objectStore('workspace'));
    const [keys, values, bodyKeys] = await Promise.all([
      transaction.objectStore('files').getAllKeys(), transaction.objectStore('files').getAll(),
      transaction.objectStore('bodies').getAllKeys(),
    ]);
    const bodies = new Set(bodyKeys);
    await transaction.done;
    const items: LocalLibraryItem[] = [];
    const damaged: DamagedLibraryItem[] = [];
    for (let index = 0; index < keys.length; index++) {
      const value: unknown = values[index];
      if (validMetadata(value) && value.id === keys[index] && bodies.has(value.id)) items.push(itemFromRecord(value));
      else {
        const name = value !== null && typeof value === 'object' && 'name' in value
          && typeof value.name === 'string' && value.name !== '' ? value.name : `Saved text ${index + 1}`;
        damaged.push({ key: keys[index]!, name, message: 'Reimport the original file to repair it, or remove this item.' });
      }
    }
    items.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
    return { items, damaged };
  }

  async list(): Promise<readonly LocalLibraryItem[]> {
    return (await this.inspect()).items;
  }

  async add(files: readonly LocalFileInput[]): Promise<readonly LocalLibraryAddResult[]> {
    const formats = supportedFiles(files);
    const db = await this.open();
    const results: LocalLibraryAddResult[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const format = formats[index]!;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size) {
        throw new Error(`'${file.name}' changed while it was being saved`);
      }
      const contentHash = await hashSourceBytes(new Uint8Array(bytes));
      const id = localFileIdentity(format, contentHash);
      const tx = db.transaction(['files', 'bodies', 'workspace'], 'readwrite');
      void tx.done.catch(() => {});
      try {
        await this.checkEpoch(tx.objectStore('workspace'));
        const [existing, body] = await Promise.all([
          tx.objectStore('files').get(id), tx.objectStore('bodies').get(id),
        ]);
        if (validMetadata(existing) && existing.id === id && body instanceof ArrayBuffer && body.byteLength === existing.size) {
          await tx.done;
          results.push({ item: itemFromRecord(existing), added: false });
          continue;
        }
        const record: StoredLocalMetadataV1 = {
          schema: LOCAL_FILE_SCHEMA, id, name: file.name, size: file.size,
          type: file.type ?? '', lastModified: file.lastModified ?? 0,
          addedAt: Date.now(), format, contentHash,
        };
        await tx.objectStore('files').put(record);
        await tx.objectStore('bodies').put(bytes, id);
        await tx.done;
        results.push({ item: itemFromRecord(record), added: true });
      } catch (error) {
        abortQuietly(tx);
        throw error;
      }
    }
    return results;
  }

  async file(id: string): Promise<LocalLibraryFile> {
    const db = await this.open();
    const tx = db.transaction(['files', 'bodies', 'workspace'], 'readonly');
    void tx.done.catch(() => {});
    await this.checkEpoch(tx.objectStore('workspace'));
    const [record, bytes] = await Promise.all([
      tx.objectStore('files').get(id), tx.objectStore('bodies').get(id),
    ]);
    await tx.done;
    if (!validMetadata(record) || record.id !== id || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== record.size) {
      throw new Error(record === undefined ? 'that saved file no longer exists' : 'that saved local file is damaged');
    }
    return {
      library: record.id,
      format: record.format,
      contentHash: record.contentHash,
      name: record.name,
      size: record.size,
      type: record.type,
      lastModified: record.lastModified,
      arrayBuffer: async () => bytes.slice(0),
    };
  }

  async delete(id: IDBValidKey): Promise<LocalLibraryDeleteResult> {
    const db = await this.open();
    const tx = db.transaction(['files', 'bodies', 'workspace'], 'readwrite');
    // idb creates tx.done eagerly. Observe its rejection even when this method
    // aborts before reaching the normal await below.
    void tx.done.catch(() => {});
    let removedDocuments: readonly string[] = [];
    try {
      const workspaceStore = tx.objectStore('workspace');
      await this.checkEpoch(workspaceStore);
      const storedWorkspace: unknown = await workspaceStore.get(CURRENT_WORKSPACE);
      if (storedWorkspace !== undefined) {
        let workspace: WorkspaceV1 | null;
        try {
          workspace = parseWorkspace(storedWorkspace);
        } catch {
          workspace = null;
          await workspaceStore.delete(CURRENT_WORKSPACE);
        }
        if (workspace !== null) {
          removedDocuments = workspace.corpus.docs
            .filter((doc) => doc.library === id)
            .map((doc) => doc.doc);
          if (removedDocuments.length > 0) {
            const removed = new Set(removedDocuments);
            const corpus = {
              kind: 'library' as const,
              order: workspace.corpus.order.filter((doc) => !removed.has(doc)),
              docs: workspace.corpus.docs.filter((doc) => !removed.has(doc.doc)),
            };
            const reconciled = reconcileWorkspaceDocuments(
              { ...workspace, corpus },
              new Set(corpus.order),
            );
            await workspaceStore.put(parseWorkspace(reconciled), CURRENT_WORKSPACE);
          }
        }
      }
      await tx.objectStore('files').delete(id);
      await tx.objectStore('bodies').delete(id);
      await tx.done;
    } catch (error) {
      abortQuietly(tx);
      throw error;
    }
    return { removedDocuments };
  }

  async clear(): Promise<LocalLibraryDeleteResult> {
    const db = await this.open();
    const tx = db.transaction(['files', 'bodies', 'workspace'], 'readwrite');
    void tx.done.catch(() => {});
    let removedDocuments: readonly string[] = [];
    try {
      const workspaceStore = tx.objectStore('workspace');
      await this.checkEpoch(workspaceStore);
      const storedWorkspace: unknown = await workspaceStore.get(CURRENT_WORKSPACE);
      if (storedWorkspace !== undefined) {
        let workspace: WorkspaceV1 | null;
        try {
          workspace = parseWorkspace(storedWorkspace);
        } catch {
          workspace = null;
          await workspaceStore.delete(CURRENT_WORKSPACE);
        }
        if (workspace !== null) {
          removedDocuments = [...workspace.corpus.order];
          const corpus = { kind: 'library' as const, order: [], docs: [] };
          const reconciled = reconcileWorkspaceDocuments({ ...workspace, corpus }, new Set<string>());
          await workspaceStore.put(parseWorkspace(reconciled), CURRENT_WORKSPACE);
        }
      }
      await tx.objectStore('files').clear();
      await tx.objectStore('bodies').clear();
      await tx.done;
    } catch (error) {
      abortQuietly(tx);
      throw error;
    }
    return { removedDocuments };
  }

  async loadWorkspace(): Promise<WorkspaceReadResult> {
    const tx = (await this.open()).transaction('workspace', 'readonly');
    void tx.done.catch(() => {});
    await this.checkEpoch(tx.store);
    const value: unknown = await tx.store.get(CURRENT_WORKSPACE);
    await tx.done;
    if (value === undefined) return { kind: 'absent' };
    try {
      return { kind: 'ready', workspace: parseWorkspace(value) };
    } catch (error) {
      return {
        kind: 'corrupt',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async saveWorkspace(workspace: WorkspaceV1): Promise<void> {
    const admitted = parseWorkspace(workspace);
    const tx = (await this.open()).transaction('workspace', 'readwrite');
    void tx.done.catch(() => {});
    try {
      await this.checkEpoch(tx.store);
      await tx.store.put(admitted, CURRENT_WORKSPACE);
      await tx.done;
    } catch (error) { abortQuietly(tx); throw error; }
  }

  /** Accept the fully validated archive plan. Only IDB requests occur inside
   * the all-or-nothing commit. Unrelated
   * saved texts remain; imported identities take their archived metadata. */
  async restoreBackup(backup: PreparedBackup, signal?: AbortSignal): Promise<void> {
    const manifest = backup.manifest;
    const workspace = parseWorkspace(manifest.workspace);
    const nextEpoch = crypto.randomUUID();
    const database = await this.open();
    signal?.throwIfAborted();
    const tx = database.transaction(['files', 'bodies', 'workspace'], 'readwrite');
    void tx.done.catch(() => {});
    try {
      await this.checkEpoch(tx.objectStore('workspace'));
      for (const item of manifest.sources) {
        const bytes = backup.bodies.get(item.id);
        if (bytes === undefined || bytes.byteLength !== item.size) throw new Error(`The source for “${item.name}” is missing.`);
        await tx.objectStore('files').put({ ...item, schema: LOCAL_FILE_SCHEMA });
        await tx.objectStore('bodies').put(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer, item.id);
      }
      await tx.objectStore('workspace').put(workspace, CURRENT_WORKSPACE);
      await tx.objectStore('workspace').put(manifest.settings, PENDING_SETTINGS);
      await tx.objectStore('workspace').put(nextEpoch, WORKSPACE_EPOCH);
      await tx.done;
      this.epoch = nextEpoch;
    } catch (error) { abortQuietly(tx); throw error; }
  }

  async pendingBackupSettings(): Promise<unknown> {
    const tx = (await this.open()).transaction('workspace', 'readonly');
    void tx.done.catch(() => {});
    await this.checkEpoch(tx.store);
    const settings = await tx.store.get(PENDING_SETTINGS);
    await tx.done;
    return settings;
  }

  async finishBackupSettings(): Promise<void> {
    const tx = (await this.open()).transaction('workspace', 'readwrite');
    void tx.done.catch(() => {});
    try {
      await this.checkEpoch(tx.store);
      await tx.store.delete(PENDING_SETTINGS);
      await tx.done;
    } catch (error) { abortQuietly(tx); throw error; }
  }

  async close(): Promise<void> {
    if (this.database === null) return;
    const opening = this.database;
    const db = await opening.catch(() => null);
    db?.close();
    if (this.database === opening) this.database = null;
  }
}

export const localLibrary = new BrowserLocalLibrary();
