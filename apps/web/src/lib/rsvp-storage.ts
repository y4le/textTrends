import {
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WORDS_PER_FRAME,
  RSVP_MAX_WPM,
  RSVP_MIN_WORDS_PER_FRAME,
  RSVP_MIN_WPM,
  RSVP_PACING_DEFAULTS,
  type RsvpPacing,
} from '@texttrends/rsvp';

export const RSVP_WPM_STORAGE_KEY = 'texttrends/rsvp-pace/1';
export const RSVP_PACING_STORAGE_KEY = 'texttrends/rsvp-rhythm/2';

const PACING_KEYS = Object.freeze([
  'lengthEmphasis',
  'paragraphPauseMs',
  'sentencePauseMs',
  'wordsPerFrame',
  'wpm',
]);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function integerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= min
    && value <= max;
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export function loadRsvpPacing(storage: StorageReader | null): RsvpPacing | null {
  if (storage === null) return null;
  try {
    const record = parseRecord(storage.getItem(RSVP_PACING_STORAGE_KEY));
    if (record === null || Object.keys(record).sort().join('\u001f') !== PACING_KEYS.join('\u001f')) {
      return null;
    }
    if (
      !integerBetween(record.wpm, RSVP_MIN_WPM, RSVP_MAX_WPM)
      || !integerBetween(
        record.wordsPerFrame,
        RSVP_MIN_WORDS_PER_FRAME,
        RSVP_MAX_WORDS_PER_FRAME,
      )
      || !integerBetween(record.sentencePauseMs, 0, RSVP_MAX_SENTENCE_PAUSE_MS)
      || !integerBetween(record.paragraphPauseMs, 0, RSVP_MAX_PARAGRAPH_PAUSE_MS)
      || record.paragraphPauseMs < record.sentencePauseMs
      || !integerBetween(record.lengthEmphasis, 0, RSVP_MAX_LENGTH_EMPHASIS)
    ) return null;
    return {
      wpm: record.wpm,
      wordsPerFrame: record.wordsPerFrame,
      sentencePauseMs: record.sentencePauseMs,
      paragraphPauseMs: record.paragraphPauseMs,
      lengthEmphasis: record.lengthEmphasis,
    };
  } catch {
    return null;
  }
}

export function saveRsvpPacing(storage: StorageWriter | null, pacing: RsvpPacing): void {
  if (storage === null) return;
  const validated = loadRsvpPacing({
    getItem: () => JSON.stringify(pacing),
  });
  if (validated === null) return;
  try {
    storage.setItem(RSVP_PACING_STORAGE_KEY, JSON.stringify(validated));
  } catch {
    // Storage can be disabled or full; rhythm remains live for this page.
  }
}

export function loadRsvpWpm(storage: StorageReader | null): number | null {
  if (storage === null) return null;
  try {
    const record = parseRecord(storage.getItem(RSVP_WPM_STORAGE_KEY));
    if (record === null || Object.keys(record).join('\u001f') !== 'wpm') return null;
    return integerBetween(record.wpm, RSVP_MIN_WPM, RSVP_MAX_WPM) ? record.wpm : null;
  } catch {
    return null;
  }
}

export function pacingFromLegacyWpm(wpm: number): RsvpPacing {
  return { ...RSVP_PACING_DEFAULTS, wpm };
}

/** Retained only so old-format fixtures and external callers can author the
 * migration source. New production writes use `saveRsvpPacing`. */
export function saveRsvpWpm(storage: StorageWriter | null, wpm: number): void {
  if (storage === null || !integerBetween(wpm, RSVP_MIN_WPM, RSVP_MAX_WPM)) return;
  try {
    storage.setItem(RSVP_WPM_STORAGE_KEY, JSON.stringify({ wpm }));
  } catch {
    // Storage can be disabled or full; pace remains live for this page.
  }
}

export function browserLocalStorage(target: Pick<Window, 'localStorage'>): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}
