export const TREND_ROW_PITCH_STORAGE_KEY = 'texttrends/trend-rows/1';
/** Loose storage sanity bounds; runtime sizing owns tighter contextual limits. */
export const TREND_ROW_PITCH_STORAGE_MIN = 1;
export const TREND_ROW_PITCH_STORAGE_MAX = 512;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

function validPitch(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TREND_ROW_PITCH_STORAGE_MIN
    && value <= TREND_ROW_PITCH_STORAGE_MAX;
}

/** Read a durable device-local viewing-density preference. Unlike per-tab
 * column geometry, row density should outlive the tab that set it, but it
 * remains rendered geometry and is never admitted into a portable workspace. */
export function loadTrendRowPitch(storage: StorageReader | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(TREND_ROW_PITCH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).join('\u001f') !== 'pitch' || !validPitch(record.pitch)) {
      return null;
    }
    return record.pitch;
  } catch {
    return null;
  }
}

/** Persist an explicit request; null restores automatic sizing and removes it. */
export function saveTrendRowPitch(
  storage: StorageWriter | null,
  pitch: number | null,
): void {
  if (storage === null) return;
  try {
    if (pitch === null) {
      storage.removeItem(TREND_ROW_PITCH_STORAGE_KEY);
    } else if (validPitch(pitch)) {
      storage.setItem(TREND_ROW_PITCH_STORAGE_KEY, JSON.stringify({ pitch }));
    }
  } catch {
    // Storage can be disabled or full; resizing remains live for this page.
  }
}

export function browserTrendRowStorage(
  target: Pick<Window, 'localStorage'>,
): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}
