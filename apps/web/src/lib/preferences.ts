import type { PreferenceDescriptor, PreferenceScope } from './preference-store.ts';

function descriptor(
  key: string,
  scope: PreferenceScope,
  legacyKeys: readonly string[] = [],
): PreferenceDescriptor {
  return Object.freeze({ key, scope, legacyKeys: Object.freeze([...legacyKeys]) });
}

export const DISPLAY_PREFERENCE_DESCRIPTOR = descriptor('texttrends/display/1', 'local');
export const GUIDE_PROGRESS_PREFERENCE_DESCRIPTOR = descriptor('texttrends/guide/1', 'local');
export const MATCHES_COLUMN_PREFERENCE_DESCRIPTOR = descriptor('texttrends/matches-columns/3', 'session');
export const READER_ATLAS_PREFERENCE_DESCRIPTOR = descriptor('texttrends/reader-atlas/1', 'local');
export const RSVP_PACING_PREFERENCE_DESCRIPTOR = descriptor(
  'texttrends/rsvp-rhythm/3',
  'local',
  ['texttrends/rsvp-rhythm/2'],
);
export const RETIRED_RSVP_WPM_PREFERENCE_DESCRIPTOR = descriptor('texttrends/rsvp-pace/1', 'session');
export const TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR = descriptor(
  'texttrends/trend-rows/2',
  'local',
  ['texttrends/trend-rows/1'],
);
export const VOCABULARY_COLUMN_PREFERENCE_DESCRIPTOR = descriptor('texttrends/vocabulary-columns/1', 'session');

/** The single ownership registry for browser-stored preferences. */
export const PREFERENCES: readonly PreferenceDescriptor[] = Object.freeze([
  DISPLAY_PREFERENCE_DESCRIPTOR,
  GUIDE_PROGRESS_PREFERENCE_DESCRIPTOR,
  MATCHES_COLUMN_PREFERENCE_DESCRIPTOR,
  READER_ATLAS_PREFERENCE_DESCRIPTOR,
  RETIRED_RSVP_WPM_PREFERENCE_DESCRIPTOR,
  RSVP_PACING_PREFERENCE_DESCRIPTOR,
  TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR,
  VOCABULARY_COLUMN_PREFERENCE_DESCRIPTOR,
]);

export function preferenceKeys(scope: PreferenceScope): readonly string[] {
  return PREFERENCES
    .filter((preference) => preference.scope === scope)
    .flatMap((preference) => [preference.key, ...preference.legacyKeys]);
}
