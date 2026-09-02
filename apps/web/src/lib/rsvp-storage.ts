import {
  RSVP_MAX_FRAME_CHAR_LIMIT,
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WORDS_PER_FRAME,
  RSVP_MAX_WPM,
  RSVP_MIN_WORDS_PER_FRAME,
  RSVP_MIN_FRAME_CHAR_LIMIT,
  RSVP_MIN_WPM,
  type RsvpPacing,
} from '@texttrends/rsvp';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import {
  RETIRED_RSVP_WPM_PREFERENCE_DESCRIPTOR,
  RSVP_PACING_PREFERENCE_DESCRIPTOR,
} from './preferences.ts';

export const RSVP_WPM_STORAGE_KEY = RETIRED_RSVP_WPM_PREFERENCE_DESCRIPTOR.key;
export const RSVP_PACING_V2_STORAGE_KEY = RSVP_PACING_PREFERENCE_DESCRIPTOR.legacyKeys[0]!;
export const RSVP_PACING_STORAGE_KEY = RSVP_PACING_PREFERENCE_DESCRIPTOR.key;

const PACING_KEYS = Object.freeze([
  'frameCharLimit',
  'lengthEmphasis',
  'paragraphPauseMs',
  'sentencePauseMs',
  'wordsPerFrame',
  'wpm',
]);
function integerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= min
    && value <= max;
}

function parseRsvpPacing(value: unknown): RsvpPacing | null {
  const record = recordOf(value);
  if (record === null || !exactKeys(record, PACING_KEYS)) return null;
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
    || !integerBetween(
      record.frameCharLimit,
      RSVP_MIN_FRAME_CHAR_LIMIT,
      RSVP_MAX_FRAME_CHAR_LIMIT,
    )
  ) return null;
  return {
    wpm: record.wpm,
    wordsPerFrame: record.wordsPerFrame,
    frameCharLimit: record.frameCharLimit,
    sentencePauseMs: record.sentencePauseMs,
    paragraphPauseMs: record.paragraphPauseMs,
    lengthEmphasis: record.lengthEmphasis,
  };
}

export const RSVP_PACING_PREFERENCE = definePreference<RsvpPacing>({
  key: RSVP_PACING_STORAGE_KEY,
  scope: RSVP_PACING_PREFERENCE_DESCRIPTOR.scope,
  legacyKeys: RSVP_PACING_PREFERENCE_DESCRIPTOR.legacyKeys,
  parse: parseRsvpPacing,
  serialize: parseRsvpPacing,
});

export function loadRsvpPacing(storage: PreferenceReader | null): RsvpPacing | null {
  return RSVP_PACING_PREFERENCE.load(storage);
}

export function saveRsvpPacing(storage: PreferenceWriter | null, pacing: RsvpPacing): void {
  RSVP_PACING_PREFERENCE.save(storage, pacing);
}
