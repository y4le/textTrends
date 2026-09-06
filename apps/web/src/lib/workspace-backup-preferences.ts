/** Named portable settings, never an arbitrary browser-storage key dump. */
import { exactRecord } from '@texttrends/core';
import { DISPLAY_PREFERENCE } from './display-storage.ts';
import { RSVP_PACING_PREFERENCE } from './rsvp-storage.ts';
import { READER_ATLAS_PREFERENCE } from './reader-atlas-storage.ts';
import { TREND_ROW_PITCH_PREFERENCE } from './trend-row-storage.ts';
import { MATCHES_COLUMN_PREFERENCE } from './matches-column-storage.ts';
import { VOCABULARY_COLUMN_PREFERENCE } from './vocabulary-column-storage.ts';
import type { Preference, PreferenceScope } from './preference-store.ts';

// Include authored ratios and contextual row sizing, never measured viewport
// pixels. Guide progress, retired keys, and interaction state do not travel.
export const BACKUP_PREFERENCES = {
  display: DISPLAY_PREFERENCE,
  speed: RSVP_PACING_PREFERENCE,
  atlas: READER_ATLAS_PREFERENCE,
  trendRows: TREND_ROW_PITCH_PREFERENCE,
  matchesColumns: MATCHES_COLUMN_PREFERENCE,
  vocabularyColumns: VOCABULARY_COLUMN_PREFERENCE,
} as const;
export type BackupPreferenceName = keyof typeof BACKUP_PREFERENCES;
export type BackupPreferences = Readonly<Record<BackupPreferenceName, unknown>>;
export type BackupPreferenceStores = Readonly<Record<PreferenceScope, Storage | null>>;
const names = Object.keys(BACKUP_PREFERENCES) as BackupPreferenceName[];

function codec(name: BackupPreferenceName): Preference<unknown> {
  return BACKUP_PREFERENCES[name] as Preference<unknown>;
}

export function parseBackupPreferences(value: unknown): BackupPreferences {
  if (!exactRecord(value, names)) throw new Error('The backup settings are invalid or incompatible.');
  const result = {} as Record<BackupPreferenceName, unknown>;
  for (const name of names) {
    const raw = value[name];
    if (raw === null) { result[name] = null; continue; }
    const preference = codec(name);
    const parsed = preference.parse(raw);
    if (parsed === null) throw new Error(`The backup contains invalid ${name} settings.`);
    result[name] = preference.serialize(parsed);
  }
  return result;
}

export function captureBackupPreferences(
  stores: BackupPreferenceStores,
  live: Partial<BackupPreferences> = {},
): BackupPreferences {
  const result = {} as Record<BackupPreferenceName, unknown>;
  for (const name of names) {
    const preference = codec(name);
    const current = preference.load(stores[preference.scope]);
    result[name] = current === null ? null : preference.serialize(current);
  }
  return parseBackupPreferences({ ...result, ...live });
}

/** Unlike routine preference saves, this must report failure. The durable
 * pending record stays in IndexedDB until every write has been verified;
 * replay after interruption is idempotent. */
export function applyBackupPreferences(value: unknown, stores: BackupPreferenceStores): void {
  const settings = parseBackupPreferences(value);
  for (const name of names) {
    const preference = codec(name);
    const storage = stores[preference.scope];
    if (storage === null) throw new Error('Browser settings storage is unavailable. Allow browser storage and reload to finish loading the workspace.');
    const raw = settings[name] === null ? null : JSON.stringify(settings[name]);
    if (raw === null) storage.removeItem(preference.key);
    else storage.setItem(preference.key, raw);
    for (const key of preference.legacyKeys) storage.removeItem(key);
    if (storage.getItem(preference.key) !== raw) throw new Error(`Could not restore ${name} settings. Reload to retry.`);
  }
}
