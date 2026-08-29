import type { WidthClass } from './presentation.ts';
import {
  trendRowSizing,
  type TrendRowPhase,
  type TrendRowSizing,
} from './trend-row-size.ts';

export const TREND_ROW_PITCH_STORAGE_KEY = 'texttrends/trend-rows/2';
export const LEGACY_TREND_ROW_PITCH_STORAGE_KEY = 'texttrends/trend-rows/1';
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
  /** Legacy v1 records have no context and are clamped without reprojection. */
  readonly context: TrendRowPitchContext | null;
}

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

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

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(record).sort().join('\u001f') === [...expected].sort().join('\u001f');
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

/** Read a durable device-local viewing-density preference. V1 is accepted as
 * context-unknown and is migrated only on the next explicit commit. */
export function loadTrendRowPitch(
  storage: StorageReader | null,
): TrendRowPitchPreference | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(TREND_ROW_PITCH_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (
        !exactKeys(record, ['pitch', 'tracks', 'width', 'coarse'])
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

    const legacyRaw = storage.getItem(LEGACY_TREND_ROW_PITCH_STORAGE_KEY);
    if (legacyRaw === null) return null;
    const legacyParsed: unknown = JSON.parse(legacyRaw);
    if (
      typeof legacyParsed !== 'object'
      || legacyParsed === null
      || Array.isArray(legacyParsed)
    ) return null;
    const legacy = legacyParsed as Record<string, unknown>;
    if (!exactKeys(legacy, ['pitch']) || !validPitch(legacy.pitch)) return null;
    return Object.freeze({ pitch: legacy.pitch, context: null });
  } catch {
    return null;
  }
}

/** Persist an explicit request; null restores automatic sizing and removes
 * both current and legacy keys so an old preference cannot reappear. */
export function saveTrendRowPitch(
  storage: StorageWriter | null,
  preference: TrendRowPitchPreference | null,
): void {
  if (storage === null) return;
  try {
    if (preference === null) {
      storage.removeItem(TREND_ROW_PITCH_STORAGE_KEY);
      storage.removeItem(LEGACY_TREND_ROW_PITCH_STORAGE_KEY);
      return;
    }
    if (preference.context === null) return;
    const valid = trendRowPitchPreference(preference.pitch, preference.context);
    if (valid === null) return;
    storage.setItem(TREND_ROW_PITCH_STORAGE_KEY, JSON.stringify({
      pitch: valid.pitch,
      tracks: valid.context!.tracks,
      width: valid.context!.width,
      coarse: valid.context!.coarse,
    }));
    storage.removeItem(LEGACY_TREND_ROW_PITCH_STORAGE_KEY);
  } catch {
    // Storage can be disabled or full; resizing remains live for this page.
  }
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
 * Zero-track and legacy contexts clamp only because neither has an honest
 * barcode phase to map. The final sizing pass also normalizes legacy gap values. */
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
    sourceContext === null
    || sourceContext.tracks === 0
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

export function browserTrendRowStorage(
  target: Pick<Window, 'localStorage'>,
): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}
