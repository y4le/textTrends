import type { WidthClass } from './presentation.ts';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import { TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR } from './preferences.ts';
import {
  trendRowSizing,
  type TrendRowPhase,
  type TrendRowSizing,
} from './trend-row-size.ts';

export const TREND_ROW_PITCH_STORAGE_KEY = TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR.key;
export const LEGACY_TREND_ROW_PITCH_STORAGE_KEY = TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR.legacyKeys[0]!;
/** Loose storage sanity bounds; runtime sizing owns tighter contextual limits. */
export const TREND_ROW_PITCH_STORAGE_MIN = 1;
export const TREND_ROW_PITCH_STORAGE_MAX = 8192;

export interface TrendRowPitchContext {
  readonly tracks: number;
  readonly width: WidthClass;
  readonly coarse: boolean;
}

export interface TrendRowPitchPreference {
  readonly pitch: number;
  readonly context: TrendRowPitchContext;
}

function validPitch(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TREND_ROW_PITCH_STORAGE_MIN
    && value <= TREND_ROW_PITCH_STORAGE_MAX;
}

function validTracks(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= TREND_ROW_PITCH_STORAGE_MAX;
}

function validWidth(value: unknown): value is WidthClass {
  return value === 'compact' || value === 'regular' || value === 'wide';
}

export function trendRowPitchPreference(
  pitch: number,
  context: TrendRowPitchContext,
): TrendRowPitchPreference | null {
  if (
    !validPitch(pitch)
    || !validTracks(context.tracks)
    || !validWidth(context.width)
    || typeof context.coarse !== 'boolean'
  ) return null;
  return Object.freeze({
    pitch,
    context: Object.freeze({ ...context }),
  });
}

function parseTrendRowPitch(value: unknown): TrendRowPitchPreference | null {
  const record = recordOf(value);
  if (
    record === null
    || !exactKeys(record, ['pitch', 'tracks', 'width', 'coarse'])
    || !validPitch(record.pitch)
    || !validTracks(record.tracks)
    || !validWidth(record.width)
    || typeof record.coarse !== 'boolean'
  ) return null;
  return Object.freeze({
    pitch: record.pitch,
    context: Object.freeze({
      tracks: record.tracks,
      width: record.width,
      coarse: record.coarse,
    }),
  });
}

export const TREND_ROW_PITCH_PREFERENCE = definePreference<TrendRowPitchPreference>({
  key: TREND_ROW_PITCH_STORAGE_KEY,
  scope: TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR.scope,
  legacyKeys: TREND_ROW_PITCH_PREFERENCE_DESCRIPTOR.legacyKeys,
  parse: parseTrendRowPitch,
  serialize(preference) {
    const valid = trendRowPitchPreference(preference.pitch, preference.context);
    return valid === null ? null : {
      pitch: valid.pitch,
      tracks: valid.context.tracks,
      width: valid.context.width,
      coarse: valid.context.coarse,
    };
  },
});

/** Read a durable device-local viewing-density preference. */
export function loadTrendRowPitch(
  storage: PreferenceReader | null,
): TrendRowPitchPreference | null {
  return TREND_ROW_PITCH_PREFERENCE.load(storage);
}

/** Persist an explicit request; null restores automatic sizing and removes
 * both current and legacy keys so an old preference cannot reappear. */
export function saveTrendRowPitch(
  storage: PreferenceWriter | null,
  preference: TrendRowPitchPreference | null,
): void {
  if (preference === null) TREND_ROW_PITCH_PREFERENCE.clear(storage);
  else TREND_ROW_PITCH_PREFERENCE.save(storage, preference);
}

function phaseProgress(sizing: TrendRowSizing): {
  readonly phase: TrendRowPhase;
  readonly progress: number;
} {
  const ratio = (distance: number, capacity: number) =>
    capacity > 0 ? Math.max(0, Math.min(1, distance / capacity)) : 0;
  switch (sizing.phase) {
    case 'grow':
      return {
        phase: sizing.phase,
        progress: ratio(
          sizing.rowPitch - sizing.basePitch,
          sizing.maxPitch - sizing.basePitch,
        ),
      };
    case 'lane':
      return {
        phase: sizing.phase,
        progress: ratio(
          sizing.basePitch - sizing.rowPitch,
          sizing.basePitch - sizing.titlePitch,
        ),
      };
    case 'band-space':
      return {
        phase: sizing.phase,
        progress: ratio(
          sizing.titlePitch - sizing.rowPitch,
          sizing.titlePitch - sizing.tightPitch,
        ),
      };
    case 'hide':
      return {
        phase: sizing.phase,
        progress: ratio(
          sizing.tightPitch - sizing.rowPitch,
          sizing.tightPitch - sizing.plotPitch,
        ),
      };
    case 'ink':
      return {
        phase: sizing.phase,
        progress: ratio(
          sizing.plotPitch - sizing.rowPitch,
          sizing.plotPitch - sizing.inkPitch,
        ),
      };
    case 'drop':
      return { phase: sizing.phase, progress: 1 };
  }
}

function pitchForPhase(
  phase: TrendRowPhase,
  progress: number,
  live: TrendRowSizing,
): number {
  const between = (start: number, end: number) =>
    Math.round(start + progress * (end - start));
  switch (phase) {
    case 'grow':
      return between(live.basePitch, live.maxPitch);
    case 'lane':
      return between(live.basePitch, live.titlePitch);
    case 'band-space':
      return between(live.titlePitch, live.tightPitch);
    case 'hide':
      return between(live.tightPitch, live.plotPitch);
    case 'ink':
      return between(live.plotPitch, live.inkPitch);
    case 'drop':
      return live.minPitch;
  }
}

/** Preserve the user's compression treatment as tracks or presentation change.
 * Zero-track contexts clamp because they have no honest barcode phase to map. */
export function resolveTrendRowPitch(
  preference: TrendRowPitchPreference | null,
  liveContext: TrendRowPitchContext,
): number | null {
  if (preference === null) return null;
  const live = trendRowSizing({
    width: liveContext.width,
    coarse: liveContext.coarse,
    trackCount: liveContext.tracks,
    targetPitch: preference.pitch,
  });
  const sourceContext = preference.context;
  if (
    sourceContext.tracks === 0
    || liveContext.tracks === 0
    || (
      sourceContext.tracks === liveContext.tracks
      && sourceContext.width === liveContext.width
      && sourceContext.coarse === liveContext.coarse
    )
  ) return live.rowPitch;

  const source = trendRowSizing({
    width: sourceContext.width,
    coarse: sourceContext.coarse,
    trackCount: sourceContext.tracks,
    targetPitch: preference.pitch,
  });
  const treatment = phaseProgress(source);
  return trendRowSizing({
    width: liveContext.width,
    coarse: liveContext.coarse,
    trackCount: liveContext.tracks,
    targetPitch: pitchForPhase(treatment.phase, treatment.progress, live),
  }).rowPitch;
}
