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

export const LOCAL_LIBRARY_DB_NAME = 'texttrends-library';
export const LOCAL_LIBRARY_DB_VERSION = 1;

const LOCAL_FILE_SCHEMA = 'texttrends/library-file/1' as const;
const CURRENT_WORKSPACE = 'current' as const;
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

interface StoredLocalFileV1 extends LocalLibraryItem {
  readonly schema: typeof LOCAL_FILE_SCHEMA;
  readonly bytes: ArrayBuffer;
}

interface LocalLibraryDb extends DBSchema {
  files: {
    key: string;
    value: StoredLocalFileV1;
    indexes: { addedAt: number };
  };
  workspace: {
    key: typeof CURRENT_WORKSPACE;
    value: WorkspaceV1;
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
  /** True when clear() discarded an unreadable workspace while resetting. */
  readonly workspaceReset: boolean;
}

export class LocalLibraryWorkspaceCorruptError extends Error {
  constructor(readonly reason: string) {
    super(`the current workspace is damaged: ${reason}`);
    this.name = 'LocalLibraryWorkspaceCorruptError';
  }
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

function validCurrentRecord(value: unknown): value is StoredLocalFileV1 {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<StoredLocalFileV1>;
  return (
    record.schema === LOCAL_FILE_SCHEMA &&
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.name === 'string' && record.name.length > 0 &&
    typeof record.type === 'string' &&
    typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0 &&
    typeof record.lastModified === 'number' && Number.isFinite(record.lastModified) && record.lastModified >= 0 &&
    typeof record.addedAt === 'number' && Number.isFinite(record.addedAt) && record.addedAt >= 0 &&
    record.bytes instanceof ArrayBuffer && record.bytes.byteLength === record.size &&
    SOURCE_FORMAT_IDS.includes(record.format as SourceFormat) &&
    typeof record.contentHash === 'string' && SOURCE_HASH.test(record.contentHash) &&
    record.id === localFileIdentity(record.format as SourceFormat, record.contentHash)
  );
}

function itemFromRecord(record: StoredLocalFileV1): LocalLibraryItem {
  const { id, name, size, type, lastModified, addedAt, format, contentHash } = record;
  return { id, name, size, type, lastModified, addedAt, format, contentHash };
}

export class BrowserLocalLibrary {
  private database: Promise<IDBPDatabase<LocalLibraryDb>> | null = null;

  constructor(private readonly name = LOCAL_LIBRARY_DB_NAME) {}

  private open(): Promise<IDBPDatabase<LocalLibraryDb>> {
    if (this.database !== null) return this.database;
    const opening = openDB<LocalLibraryDb>(this.name, LOCAL_LIBRARY_DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('files')) {
          const store = database.createObjectStore('files', { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
        if (!database.objectStoreNames.contains('workspace')) {
          database.createObjectStore('workspace');
        }
      },
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

  private async currentRecords(database: IDBPDatabase<LocalLibraryDb>): Promise<readonly StoredLocalFileV1[]> {
    const raw: unknown[] = await database.getAll('files');
    const records: StoredLocalFileV1[] = [];
    for (const value of raw) {
      if (!validCurrentRecord(value)) throw new Error('a saved local file is damaged');
      records.push(value);
    }
    return records;
  }

  async list(): Promise<readonly LocalLibraryItem[]> {
    const items = (await this.currentRecords(await this.open())).map(itemFromRecord);
    return items.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
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
      const existing: unknown = await db.get('files', id);
      if (existing !== undefined) {
        if (!validCurrentRecord(existing)) throw new Error('a saved local file is damaged');
        results.push({ item: itemFromRecord(existing), added: false });
        continue;
      }
      const record: StoredLocalFileV1 = {
        schema: LOCAL_FILE_SCHEMA,
        id,
        name: file.name,
        size: file.size,
        type: file.type ?? '',
        lastModified: file.lastModified ?? 0,
        addedAt: Date.now(),
        format,
        contentHash,
        bytes: bytes.slice(0),
      };
      await db.put('files', record);
      results.push({ item: itemFromRecord(record), added: true });
    }
    return results;
  }

  async file(id: string): Promise<LocalLibraryFile> {
    const db = await this.open();
    const record: unknown = await db.get('files', id);
    if (!validCurrentRecord(record) || record.id !== id) {
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
      arrayBuffer: async () => record.bytes.slice(0),
    };
  }

  async delete(id: string): Promise<LocalLibraryDeleteResult> {
    const db = await this.open();
    const tx = db.transaction(['files', 'workspace'], 'readwrite');
    // idb creates tx.done eagerly. Observe its rejection even when this method
    // aborts before reaching the normal await below.
    void tx.done.catch(() => {});
    let removedDocuments: readonly string[] = [];
    try {
      const storedWorkspace: unknown = await tx.objectStore('workspace').get(CURRENT_WORKSPACE);
      if (storedWorkspace !== undefined) {
        let workspace: WorkspaceV1;
        try {
          workspace = parseWorkspace(storedWorkspace);
        } catch (error) {
          throw new LocalLibraryWorkspaceCorruptError(
            error instanceof Error ? error.message : String(error),
          );
        }
        if (workspace.corpus.kind === 'library') {
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
            await tx.objectStore('workspace').put(parseWorkspace(reconciled), CURRENT_WORKSPACE);
          }
        }
      }
      await tx.objectStore('files').delete(id);
      await tx.done;
    } catch (error) {
      abortQuietly(tx);
      throw error;
    }
    return { removedDocuments, workspaceReset: false };
  }

  async clear(): Promise<LocalLibraryDeleteResult> {
    const db = await this.open();
    const tx = db.transaction(['files', 'workspace'], 'readwrite');
    void tx.done.catch(() => {});
    let removedDocuments: readonly string[] = [];
    let workspaceReset = false;
    try {
      const workspaceStore = tx.objectStore('workspace');
      const storedWorkspace: unknown = await workspaceStore.get(CURRENT_WORKSPACE);
      if (storedWorkspace !== undefined) {
        let workspace: WorkspaceV1 | null;
        try {
          workspace = parseWorkspace(storedWorkspace);
        } catch {
          workspace = null;
          workspaceReset = true;
          await workspaceStore.delete(CURRENT_WORKSPACE);
        }
        if (workspace?.corpus.kind === 'library') {
          removedDocuments = [...workspace.corpus.order];
          const corpus = { kind: 'library' as const, order: [], docs: [] };
          const reconciled = reconcileWorkspaceDocuments({ ...workspace, corpus }, new Set<string>());
          await workspaceStore.put(parseWorkspace(reconciled), CURRENT_WORKSPACE);
        }
      }
      await tx.objectStore('files').clear();
      await tx.done;
    } catch (error) {
      abortQuietly(tx);
      throw error;
    }
    return { removedDocuments, workspaceReset };
  }

  async loadWorkspace(): Promise<WorkspaceReadResult> {
    const value: unknown = await (await this.open()).get('workspace', CURRENT_WORKSPACE);
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
    await (await this.open()).put('workspace', admitted, CURRENT_WORKSPACE);
  }

  async close(): Promise<void> {
    if (this.database === null) return;
    const db = await this.database;
    db.close();
    this.database = null;
  }
}

export const localLibrary = new BrowserLocalLibrary();
