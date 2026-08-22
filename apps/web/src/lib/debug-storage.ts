import { LOCAL_LIBRARY_DB_NAME } from './local-library.ts';
import { MATCHES_COLUMN_STORAGE_KEY } from './matches-column-storage.ts';
import { VOCABULARY_COLUMN_STORAGE_KEY } from './vocabulary-column-storage.ts';
import { RSVP_WPM_STORAGE_KEY } from './rsvp-storage.ts';
import { ARTIFACT_DB_NAME } from '../shared/storage-schema.ts';

export const OWNED_SESSION_STORAGE_KEYS = Object.freeze([
  MATCHES_COLUMN_STORAGE_KEY,
  VOCABULARY_COLUMN_STORAGE_KEY,
  RSVP_WPM_STORAGE_KEY,
]);

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
  await deleteDatabase(factory, ARTIFACT_DB_NAME, onBlocked);
}

export async function clearAllApplicationStorage(
  factory: IDBFactory = indexedDB,
  session: Pick<Storage, 'removeItem'> | null = null,
  onBlocked?: DatabaseBlockedHandler,
): Promise<void> {
  await Promise.all([
    deleteDatabase(factory, ARTIFACT_DB_NAME, onBlocked),
    deleteDatabase(factory, LOCAL_LIBRARY_DB_NAME, onBlocked),
  ]);
  if (session !== null) {
    for (const key of OWNED_SESSION_STORAGE_KEYS) session.removeItem(key);
  }
}
