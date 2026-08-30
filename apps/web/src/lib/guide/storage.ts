export const GUIDE_PROGRESS_STORAGE_KEY = 'texttrends/guide/1';

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

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function isVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isVersionOrNull(value: unknown): value is number | null {
  return value === null || isVersion(value);
}

function isGuideProgress(value: unknown): value is GuideProgressV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join('\u001f') === GUIDE_PROGRESS_KEYS.join('\u001f')
    && record.v === 1
    && isVersionOrNull(record.tourSeenVersion)
    && isVersionOrNull(record.dismissedInvitationVersion);
}

export function emptyGuideProgress(): GuideProgressV1 {
  return EMPTY_GUIDE_PROGRESS;
}

export function parseGuideProgress(raw: string | null): GuideProgressV1 {
  if (raw === null) return EMPTY_GUIDE_PROGRESS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGuideProgress(parsed)) return EMPTY_GUIDE_PROGRESS;
    return {
      v: 1,
      tourSeenVersion: parsed.tourSeenVersion,
      dismissedInvitationVersion: parsed.dismissedInvitationVersion,
    };
  } catch {
    return EMPTY_GUIDE_PROGRESS;
  }
}

export function loadGuideProgress(storage: StorageReader | null): GuideProgressV1 {
  if (storage === null) return EMPTY_GUIDE_PROGRESS;
  try {
    return parseGuideProgress(storage.getItem(GUIDE_PROGRESS_STORAGE_KEY));
  } catch {
    return EMPTY_GUIDE_PROGRESS;
  }
}

export function saveGuideProgress(
  storage: StorageWriter | null,
  progress: GuideProgressV1,
): void {
  if (storage === null || !isGuideProgress(progress)) return;
  try {
    storage.setItem(GUIDE_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage can be disabled or full; the invitation remains dismissed in memory.
  }
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

export function browserGuideLocalStorage(
  target: Pick<Window, 'localStorage'>,
): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}
