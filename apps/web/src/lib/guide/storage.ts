import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from '../preference-store.ts';
import { GUIDE_PROGRESS_PREFERENCE_DESCRIPTOR } from '../preferences.ts';

export const GUIDE_PROGRESS_STORAGE_KEY = GUIDE_PROGRESS_PREFERENCE_DESCRIPTOR.key;

export interface GuideProgressV1 {
  readonly v: 1;
  readonly tourSeenVersion: number | null;
  readonly dismissedInvitationVersion: number | null;
}

export type GuideProgressField =
  | 'tourSeenVersion'
  | 'dismissedInvitationVersion';

const GUIDE_PROGRESS_KEYS = Object.freeze([
  'dismissedInvitationVersion',
  'tourSeenVersion',
  'v',
]);

const EMPTY_GUIDE_PROGRESS: GuideProgressV1 = Object.freeze({
  v: 1,
  tourSeenVersion: null,
  dismissedInvitationVersion: null,
});

function isVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isVersionOrNull(value: unknown): value is number | null {
  return value === null || isVersion(value);
}

function isGuideProgress(value: unknown): value is GuideProgressV1 {
  const record = recordOf(value);
  return record !== null
    && exactKeys(record, GUIDE_PROGRESS_KEYS)
    && record.v === 1
    && isVersionOrNull(record.tourSeenVersion)
    && isVersionOrNull(record.dismissedInvitationVersion);
}

export const GUIDE_PROGRESS_PREFERENCE = definePreference<GuideProgressV1>({
  key: GUIDE_PROGRESS_STORAGE_KEY,
  scope: GUIDE_PROGRESS_PREFERENCE_DESCRIPTOR.scope,
  parse(value) {
    if (!isGuideProgress(value)) return null;
    return {
      v: 1,
      tourSeenVersion: value.tourSeenVersion,
      dismissedInvitationVersion: value.dismissedInvitationVersion,
    };
  },
  serialize(value) {
    return isGuideProgress(value) ? value : null;
  },
});

export function emptyGuideProgress(): GuideProgressV1 {
  return EMPTY_GUIDE_PROGRESS;
}

export function parseGuideProgress(raw: string | null): GuideProgressV1 {
  return GUIDE_PROGRESS_PREFERENCE.load({ getItem: () => raw }) ?? EMPTY_GUIDE_PROGRESS;
}

export function loadGuideProgress(storage: PreferenceReader | null): GuideProgressV1 {
  return GUIDE_PROGRESS_PREFERENCE.load(storage) ?? EMPTY_GUIDE_PROGRESS;
}

export function saveGuideProgress(
  storage: PreferenceWriter | null,
  progress: GuideProgressV1,
): void {
  GUIDE_PROGRESS_PREFERENCE.save(storage, progress);
}

export function advanceGuideProgress(
  progress: GuideProgressV1,
  field: GuideProgressField,
  version: number,
): GuideProgressV1 {
  if (!isVersion(version) || (progress[field] ?? -1) >= version) return progress;
  return { ...progress, [field]: version };
}

export function guideProgressCovers(
  progress: GuideProgressV1,
  field: GuideProgressField,
  version: number,
): boolean {
  return isVersion(version) && (progress[field] ?? -1) >= version;
}
