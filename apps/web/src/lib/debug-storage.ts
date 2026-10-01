import { LOCAL_LIBRARY_DB_NAME } from './local-library.ts';
import { ARTIFACT_DB_NAMES, SUPERSEDED_DURABLE_DB_NAMES } from '../shared/storage-schema.ts';
import { preferenceKeys } from './preferences.ts';

export const OWNED_SESSION_STORAGE_KEYS = Object.freeze(preferenceKeys('session'));

export const OWNED_LOCAL_STORAGE_KEYS = Object.freeze(preferenceKeys('local'));

export type DatabaseBlockedHandler = (name: string) => void;

export function deleteDatabase(
  factory: IDBFactory,
  name: string,
  onBlocked?: DatabaseBlockedHandler,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(name);
    } catch (error) {
      reject(error);
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`could not delete ${name}`));
    // The request remains pending and completes automatically when the other
    // connection closes; report the reason without claiming a false success.
    request.onblocked = () => onBlocked?.(name);
  });
}

export async function clearArtifactDatabase(
  factory: IDBFactory = indexedDB,
  onBlocked?: DatabaseBlockedHandler,
): Promise<void> {
  await Promise.all(ARTIFACT_DB_NAMES.map((name) => deleteDatabase(factory, name, onBlocked)));
}

export async function clearAllApplicationStorage(
  factory: IDBFactory = indexedDB,
  session: Pick<Storage, 'removeItem'> | null = null,
  onBlocked?: DatabaseBlockedHandler,
  local: Pick<Storage, 'removeItem'> | null = null,
): Promise<void> {
  await Promise.all([
    ...ARTIFACT_DB_NAMES.map((name) => deleteDatabase(factory, name, onBlocked)),
    deleteDatabase(factory, LOCAL_LIBRARY_DB_NAME, onBlocked),
    ...SUPERSEDED_DURABLE_DB_NAMES.map((name) => deleteDatabase(factory, name, onBlocked)),
  ]);
  if (session !== null) {
    for (const key of OWNED_SESSION_STORAGE_KEYS) session.removeItem(key);
  }
  if (local !== null) {
    for (const key of OWNED_LOCAL_STORAGE_KEYS) local.removeItem(key);
  }
}
