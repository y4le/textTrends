import {
  RSVP_DEFAULT_FRAME_CHAR_LIMIT,
  RSVP_MAX_FRAME_CHAR_LIMIT,
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WORDS_PER_FRAME,
  RSVP_MAX_WPM,
  RSVP_MIN_WORDS_PER_FRAME,
  RSVP_MIN_FRAME_CHAR_LIMIT,
  RSVP_MIN_WPM,
  RSVP_PACING_DEFAULTS,
  type RsvpPacing,
} from '@texttrends/rsvp';

export const RSVP_WPM_STORAGE_KEY = 'texttrends/rsvp-pace/1';
export const RSVP_PACING_V2_STORAGE_KEY = 'texttrends/rsvp-rhythm/2';
export const RSVP_PACING_STORAGE_KEY = 'texttrends/rsvp-rhythm/3';

const PACING_KEYS = Object.freeze([
  'frameCharLimit',
  'lengthEmphasis',
  'paragraphPauseMs',
  'sentencePauseMs',
  'wordsPerFrame',
  'wpm',
]);
const PACING_V2_KEYS = Object.freeze(PACING_KEYS.filter((key) => key !== 'frameCharLimit'));

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
    const currentRaw = storage.getItem(RSVP_PACING_STORAGE_KEY);
    const legacyV2 = currentRaw === null;
    const record = parseRecord(
      currentRaw ?? storage.getItem(RSVP_PACING_V2_STORAGE_KEY),
    );
    const expectedKeys = legacyV2 ? PACING_V2_KEYS : PACING_KEYS;
    if (
      record === null
      || Object.keys(record).sort().join('\u001f') !== expectedKeys.join('\u001f')
    ) return null;
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
      || (!legacyV2 && !integerBetween(
        record.frameCharLimit,
        RSVP_MIN_FRAME_CHAR_LIMIT,
        RSVP_MAX_FRAME_CHAR_LIMIT,
      ))
    ) return null;
    return {
      wpm: record.wpm,
      wordsPerFrame: record.wordsPerFrame,
      frameCharLimit: legacyV2
        ? RSVP_DEFAULT_FRAME_CHAR_LIMIT
        : record.frameCharLimit as number,
      sentencePauseMs: record.sentencePauseMs,
      paragraphPauseMs: record.paragraphPauseMs,
      lengthEmphasis: record.lengthEmphasis,
    };
  } catch {
    return null;
  }
}

export function hasRsvpPacingV3(storage: StorageReader | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(RSVP_PACING_STORAGE_KEY) !== null;
  } catch {
    return false;
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
