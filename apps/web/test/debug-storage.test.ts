import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  clearAllApplicationStorage,
  clearArtifactDatabase,
  deleteDatabase,
  OWNED_LOCAL_STORAGE_KEYS,
  OWNED_SESSION_STORAGE_KEYS,
} from '../src/lib/debug-storage.ts';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { ARTIFACT_DB_NAMES } from '../src/shared/storage-schema.ts';
import {
  LEGACY_TREND_ROW_PITCH_STORAGE_KEY,
  TREND_ROW_PITCH_STORAGE_KEY,
} from '../src/lib/trend-row-storage.ts';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../src/lib/guide/storage.ts';

function open(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('debug storage recovery', () => {
  it('owns the durable trend row-pitch preference', () => {
    expect(OWNED_LOCAL_STORAGE_KEYS).toContain(TREND_ROW_PITCH_STORAGE_KEY);
    expect(OWNED_LOCAL_STORAGE_KEYS).toContain(LEGACY_TREND_ROW_PITCH_STORAGE_KEY);
    expect(OWNED_LOCAL_STORAGE_KEYS).toContain(GUIDE_PROGRESS_STORAGE_KEY);
  });

  it('deletes current and superseded app databases and only allowlisted web-storage keys', async () => {
    const factory = new FakeIDBFactory();
    await Promise.all([
      open(factory as unknown as IDBFactory, LOCAL_LIBRARY_DB_NAME),
      ...ARTIFACT_DB_NAMES.map((name) => open(factory as unknown as IDBFactory, name)),
      open(factory as unknown as IDBFactory, 'unrelated-owner'),
    ]);
    const sessionValues = new Map([
      ...OWNED_SESSION_STORAGE_KEYS.map((key) => [key, 'owned'] as const),
      ['unrelated-owner-key', 'keep'] as const,
    ]);
    const localValues = new Map([
      ...OWNED_LOCAL_STORAGE_KEYS.map((key) => [key, 'owned'] as const),
      ['unrelated-local-key', 'keep'] as const,
    ]);

    await clearAllApplicationStorage(
      factory as unknown as IDBFactory,
      { removeItem: (key) => { sessionValues.delete(key); } },
      undefined,
      { removeItem: (key) => { localValues.delete(key); } },
    );

    expect((await factory.databases()).map(({ name }) => name).sort()).toEqual(['unrelated-owner']);
    expect(sessionValues).toEqual(new Map([['unrelated-owner-key', 'keep']]));
    expect(localValues).toEqual(new Map([['unrelated-local-key', 'keep']]));
  });

  it('cache clear removes older layouts without touching the source library or another owner', async () => {
    const factory = new FakeIDBFactory() as unknown as IDBFactory;
    await Promise.all([
      ...ARTIFACT_DB_NAMES.map((name) => open(factory, name)),
      open(factory, LOCAL_LIBRARY_DB_NAME),
      open(factory, 'texttrends-artifacts-unrelated-owner'),
    ]);
    await clearArtifactDatabase(factory);
    expect((await factory.databases()).map(({ name }) => name).sort())
      .toEqual(['texttrends-artifacts-unrelated-owner', LOCAL_LIBRARY_DB_NAME].sort());
  });

  it('turns a synchronous IndexedDB refusal into a rejected promise', async () => {
    const refusal = new Error('storage disabled');
    const factory = {
      deleteDatabase: vi.fn(() => { throw refusal; }),
    } as unknown as IDBFactory;

    await expect(deleteDatabase(factory, 'blocked')).rejects.toBe(refusal);
  });
});
