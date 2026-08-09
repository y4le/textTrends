/**
 * Durable, browser-local acquisition library.
 *
 * This is intentionally separate from both the disposable Standard Ebooks
 * download cache and the saved-project source store. A library item is the
 * user's reusable copy of an acquired file; deleting it must not silently
 * damage a separately saved project, and clearing a cache must not delete it.
 */

import {
  hashSourceBytes,
  INGEST_CAPS_V0,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  sourceFormatForFilename,
  type SourceFormat,
} from '@texttrends/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FileLike } from './project-session.ts';

export const LOCAL_LIBRARY_DB_NAME = 'texttrends-local-library';
export const LOCAL_LIBRARY_DB_VERSION = 1;

const LEGACY_LOCAL_FILE_SCHEMA = 'texttrends/local-file/1' as const;
const LOCAL_FILE_SCHEMA = 'texttrends/local-file/2' as const;
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

interface StoredLocalFileV2 extends LocalLibraryItem {
  readonly schema: typeof LOCAL_FILE_SCHEMA;
  readonly bytes: ArrayBuffer;
}

interface StoredLocalFileV1 extends Omit<LocalLibraryItem, 'format' | 'contentHash'> {
  readonly schema: typeof LEGACY_LOCAL_FILE_SCHEMA;
  readonly bytes: ArrayBuffer;
}

interface LocalLibraryDb extends DBSchema {
  files: {
    key: string;
    value: StoredLocalFileV1 | StoredLocalFileV2;
    indexes: { addedAt: number };
  };
}

export type LocalFileInput = FileLike & {
  readonly type?: string;
  readonly lastModified?: number;
};

export interface LocalLibraryAddResult {
  readonly item: LocalLibraryItem;
  /** False means the same format + byte hash was already in the library. */
  readonly added: boolean;
}

/** Source bytes can legitimately be interpreted under different formats, so
 * dedupe exact content within a format rather than collapsing those recipes. */
export function localFileIdentity(format: SourceFormat, contentHash: string): string {
  return `${format}:${contentHash}`;
}

function recordId(format: SourceFormat, contentHash: string): string {
  return `source/${localFileIdentity(format, contentHash)}`;
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

function validSharedRecord(value: unknown): value is StoredLocalFileV1 | StoredLocalFileV2 {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<StoredLocalFileV1 | StoredLocalFileV2>;
  return (
    (record.schema === LEGACY_LOCAL_FILE_SCHEMA || record.schema === LOCAL_FILE_SCHEMA) &&
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.name === 'string' && record.name.length > 0 &&
    typeof record.type === 'string' &&
    typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0 &&
    typeof record.lastModified === 'number' && Number.isFinite(record.lastModified) && record.lastModified >= 0 &&
    typeof record.addedAt === 'number' && Number.isFinite(record.addedAt) && record.addedAt >= 0 &&
    record.bytes instanceof ArrayBuffer && record.bytes.byteLength === record.size
  );
}

function validCurrentRecord(value: unknown): value is StoredLocalFileV2 {
  if (!validSharedRecord(value) || value.schema !== LOCAL_FILE_SCHEMA) return false;
  return (
    SOURCE_FORMAT_IDS.includes(value.format as SourceFormat) &&
    SOURCE_HASH.test(value.contentHash) &&
    value.id === recordId(value.format, value.contentHash)
  );
}

function itemFromRecord(record: StoredLocalFileV2): LocalLibraryItem {
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

  /** Upgrade version-1 records outside the IDB upgrade transaction because
   * hashing uses Web Crypto. Deterministic v2 keys collapse legacy duplicates;
   * the oldest acquisition supplies the retained display metadata. */
  private async currentRecords(database: IDBPDatabase<LocalLibraryDb>): Promise<readonly StoredLocalFileV2[]> {
    const raw: unknown[] = await database.getAll('files');
    const current = new Map<string, StoredLocalFileV2>();
    const legacyIds: string[] = [];
    for (const value of raw) {
      if (!validSharedRecord(value)) throw new Error('a saved local file is damaged');
      let record: StoredLocalFileV2;
      if (value.schema === LOCAL_FILE_SCHEMA) {
        if (!validCurrentRecord(value)) throw new Error('a saved local file is damaged');
        record = value;
      } else {
        const format = sourceFormatForFilename(value.name);
        if (format === null) throw new Error('a saved local file has an unsupported type');
        const contentHash = await hashSourceBytes(new Uint8Array(value.bytes));
        record = {
          ...value,
          schema: LOCAL_FILE_SCHEMA,
          id: recordId(format, contentHash),
          format,
          contentHash,
        };
        legacyIds.push(value.id);
      }
      const existing = current.get(record.id);
      if (existing === undefined || record.addedAt < existing.addedAt) current.set(record.id, record);
    }
    if (legacyIds.length > 0) {
      const tx = database.transaction('files', 'readwrite');
      await Promise.all(legacyIds.map((id) => tx.store.delete(id)));
      await Promise.all([...current.values()].map((record) => tx.store.put(record)));
      await tx.done;
    }
    return [...current.values()];
  }

  async list(): Promise<readonly LocalLibraryItem[]> {
    const items = (await this.currentRecords(await this.open())).map(itemFromRecord);
    return items.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
  }

  async add(files: readonly LocalFileInput[]): Promise<readonly LocalLibraryAddResult[]> {
    const formats = supportedFiles(files);
    const db = await this.open();
    await this.currentRecords(db);
    const results: LocalLibraryAddResult[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const format = formats[index]!;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size) {
        throw new Error(`'${file.name}' changed while it was being saved`);
      }
      const contentHash = await hashSourceBytes(new Uint8Array(bytes));
      const id = recordId(format, contentHash);
      const existing: unknown = await db.get('files', id);
      if (existing !== undefined) {
        if (!validCurrentRecord(existing)) throw new Error('a saved local file is damaged');
        results.push({ item: itemFromRecord(existing), added: false });
        continue;
      }
      const record: StoredLocalFileV2 = {
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

  async file(id: string): Promise<LocalFileInput> {
    const db = await this.open();
    await this.currentRecords(db);
    const record: unknown = await db.get('files', id);
    if (!validCurrentRecord(record) || record.id !== id) {
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
