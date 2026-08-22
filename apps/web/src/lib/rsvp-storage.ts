import { RSVP_MAX_WPM, RSVP_MIN_WPM } from './rsvp.ts';

export const RSVP_WPM_STORAGE_KEY = 'texttrends/rsvp-pace/1';

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function loadRsvpWpm(storage: StorageReader | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(RSVP_WPM_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).join('\u001f') !== 'wpm') return null;
    const wpm = record.wpm;
    if (
      typeof wpm !== 'number'
      || !Number.isInteger(wpm)
      || wpm < RSVP_MIN_WPM
      || wpm > RSVP_MAX_WPM
    ) return null;
    return wpm;
  } catch {
    return null;
  }
}

export function saveRsvpWpm(
  storage: StorageWriter | null,
  wpm: number,
): void {
  if (
    storage === null
    || !Number.isInteger(wpm)
    || wpm < RSVP_MIN_WPM
    || wpm > RSVP_MAX_WPM
  ) return;
  try {
    storage.setItem(RSVP_WPM_STORAGE_KEY, JSON.stringify({ wpm }));
  } catch {
    // Storage can be disabled or full; pace remains live for this page.
  }
}
