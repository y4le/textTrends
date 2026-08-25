import {
  isDensity,
  isTheme,
  type DisplayPreference,
} from './display-preference.ts';

export const DISPLAY_PREFERENCE_STORAGE_KEY = 'texttrends/display/1';

const DISPLAY_PREFERENCE_KEYS = Object.freeze(['density', 'theme']);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function loadDisplayPreference(storage: StorageReader | null): DisplayPreference | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(DISPLAY_PREFERENCE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\u001f') !== DISPLAY_PREFERENCE_KEYS.join('\u001f')
      || !isDensity(record.density)
      || !isTheme(record.theme)
    ) return null;
    return { density: record.density, theme: record.theme };
  } catch {
    return null;
  }
}

export function saveDisplayPreference(
  storage: StorageWriter | null,
  preference: DisplayPreference,
): void {
  if (storage === null || !isDensity(preference.density) || !isTheme(preference.theme)) return;
  try {
    storage.setItem(DISPLAY_PREFERENCE_STORAGE_KEY, JSON.stringify({
      density: preference.density,
      theme: preference.theme,
    }));
  } catch {
    // Storage can be disabled or full; the preference remains live for this page.
  }
}

export function browserDisplayLocalStorage(
  target: Pick<Window, 'localStorage'>,
): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}
