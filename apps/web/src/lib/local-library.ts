/**
 * Durable, browser-local acquisition library.
 *
 * This is intentionally separate from both the disposable Standard Ebooks
 * download cache and the saved-project source store. A library item is the
 * user's reusable copy of an acquired file; deleting it must not silently
 * damage a separately saved project, and clearing a cache must not delete it.
 */

import { INGEST_CAPS_V0, SOURCE_FORMATS, SOURCE_FORMAT_IDS, sourceFormatForFilename } from '@texttrends/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FileLike } from './project-session.ts';

export const LOCAL_LIBRARY_DB_NAME = 'texttrends-local-library';
export const LOCAL_LIBRARY_DB_VERSION = 1;

const LOCAL_FILE_SCHEMA = 'texttrends/local-file/1' as const;

export interface LocalLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  readonly addedAt: number;
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
}

export type LocalFileInput = FileLike & {
  readonly type?: string;
  readonly lastModified?: number;
};

function supportedFiles(files: readonly LocalFileInput[]): void {
  const supported = SOURCE_FORMAT_IDS.flatMap((id) => SOURCE_FORMATS[id].extensions).join(', ');
  for (const file of files) {
    if (sourceFormatForFilename(file.name) === null) {
      throw new Error(`unsupported file type: '${file.name}' (${supported})`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`'${file.name}' has an invalid file size`);
    }
    if (file.size > INGEST_CAPS_V0.maxSourceBytesPerFile) {
      throw new Error(`'${file.name}' exceeds the ${INGEST_CAPS_V0.maxSourceBytesPerFile}-byte per-file cap`);
    }
  }
}

function validRecord(value: unknown): value is StoredLocalFileV1 {
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
    record.bytes instanceof ArrayBuffer && record.bytes.byteLength === record.size
  );
}

function itemFromRecord(record: StoredLocalFileV1): LocalLibraryItem {
  const { id, name, size, type, lastModified, addedAt } = record;
  return { id, name, size, type, lastModified, addedAt };
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

  async list(): Promise<readonly LocalLibraryItem[]> {
    const records: unknown[] = await (await this.open()).getAll('files');
    const items = records.map((record) => {
      if (!validRecord(record)) throw new Error('a saved local file is damaged');
      return itemFromRecord(record);
    });
    return items.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
  }

  async add(files: readonly LocalFileInput[]): Promise<readonly LocalLibraryItem[]> {
    supportedFiles(files);
    const db = await this.open();
    const added: LocalLibraryItem[] = [];
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size) {
        throw new Error(`'${file.name}' changed while it was being saved`);
      }
      const record: StoredLocalFileV1 = {
        schema: LOCAL_FILE_SCHEMA,
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type ?? '',
        lastModified: file.lastModified ?? 0,
        addedAt: Date.now(),
        bytes: bytes.slice(0),
      };
      await db.put('files', record);
      added.push(itemFromRecord(record));
    }
    return added;
  }

  async file(id: string): Promise<LocalFileInput> {
    const record: unknown = await (await this.open()).get('files', id);
    if (!validRecord(record) || record.id !== id) {
      throw new Error(record === undefined ? 'that saved file no longer exists' : 'that saved local file is damaged');
    }
    return {
      name: record.name,
      size: record.size,
      type: record.type,
      lastModified: record.lastModified,
      arrayBuffer: async () => record.bytes.slice(0),
    };
  }

  async delete(id: string): Promise<void> {
    await (await this.open()).delete('files', id);
  }

  async clear(): Promise<void> {
    await (await this.open()).clear('files');
  }

  async close(): Promise<void> {
    if (this.database === null) return;
    const db = await this.database;
    db.close();
    this.database = null;
  }
}

export const localLibrary = new BrowserLocalLibrary();
