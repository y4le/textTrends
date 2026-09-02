import {
  isAtlasNormalization,
  type AtlasNormalization,
} from './reader-view.ts';

export const READER_ATLAS_STORAGE_KEY = 'texttrends/reader-atlas/1';

const READER_ATLAS_KEYS = Object.freeze(['normalization']);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function loadAtlasNormalization(storage: StorageReader | null): AtlasNormalization | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(READER_ATLAS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\u001f') !== READER_ATLAS_KEYS.join('\u001f')
      || !isAtlasNormalization(record.normalization)
    ) return null;
    return record.normalization;
  } catch {
    return null;
  }
}

export function saveAtlasNormalization(
  storage: StorageWriter | null,
  normalization: AtlasNormalization,
): void {
  if (storage === null || !isAtlasNormalization(normalization)) return;
  try {
    storage.setItem(READER_ATLAS_STORAGE_KEY, JSON.stringify({ normalization }));
  } catch {
    // Storage can be disabled or full; the preference remains live for this page.
  }
}
