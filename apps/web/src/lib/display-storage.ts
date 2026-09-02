import {
  isDensity,
  isTheme,
  type DisplayPreference,
} from './display-preference.ts';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import { DISPLAY_PREFERENCE_DESCRIPTOR } from './preferences.ts';

export const DISPLAY_PREFERENCE_STORAGE_KEY = DISPLAY_PREFERENCE_DESCRIPTOR.key;

const DISPLAY_PREFERENCE_KEYS = Object.freeze(['density', 'theme']);

export const DISPLAY_PREFERENCE = definePreference<DisplayPreference>({
  key: DISPLAY_PREFERENCE_STORAGE_KEY,
  scope: DISPLAY_PREFERENCE_DESCRIPTOR.scope,
  parse(value) {
    const record = recordOf(value);
    if (
      record === null
      || !exactKeys(record, DISPLAY_PREFERENCE_KEYS)
      || !isDensity(record.density)
      || !isTheme(record.theme)
    ) return null;
    return { density: record.density, theme: record.theme };
  },
  serialize(preference) {
    return isDensity(preference.density) && isTheme(preference.theme)
      ? { density: preference.density, theme: preference.theme }
      : null;
  },
});

export function loadDisplayPreference(storage: PreferenceReader | null): DisplayPreference | null {
  return DISPLAY_PREFERENCE.load(storage);
}

export function saveDisplayPreference(
  storage: PreferenceWriter | null,
  preference: DisplayPreference,
): void {
  DISPLAY_PREFERENCE.save(storage, preference);
}
