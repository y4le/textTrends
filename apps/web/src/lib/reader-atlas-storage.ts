import {
  isAtlasNormalization,
  type AtlasNormalization,
} from './reader-view.ts';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import { READER_ATLAS_PREFERENCE_DESCRIPTOR } from './preferences.ts';

export const READER_ATLAS_STORAGE_KEY = READER_ATLAS_PREFERENCE_DESCRIPTOR.key;

const READER_ATLAS_KEYS = Object.freeze(['normalization']);

export const READER_ATLAS_PREFERENCE = definePreference<AtlasNormalization>({
  key: READER_ATLAS_STORAGE_KEY,
  scope: READER_ATLAS_PREFERENCE_DESCRIPTOR.scope,
  parse(value) {
    const record = recordOf(value);
    return record !== null
      && exactKeys(record, READER_ATLAS_KEYS)
      && isAtlasNormalization(record.normalization)
      ? record.normalization
      : null;
  },
  serialize(normalization) {
    return isAtlasNormalization(normalization) ? { normalization } : null;
  },
});

export function loadAtlasNormalization(storage: PreferenceReader | null): AtlasNormalization | null {
  return READER_ATLAS_PREFERENCE.load(storage);
}

export function saveAtlasNormalization(
  storage: PreferenceWriter | null,
  normalization: AtlasNormalization,
): void {
  READER_ATLAS_PREFERENCE.save(storage, normalization);
}
