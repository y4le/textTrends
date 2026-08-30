import { describe, expect, it, vi } from 'vitest';
import {
  GUIDE_PROGRESS_STORAGE_KEY,
  advanceGuideProgress,
  browserGuideLocalStorage,
  emptyGuideProgress,
  guideProgressCovers,
  loadGuideProgress,
  parseGuideProgress,
  saveGuideProgress,
  type GuideProgressV1,
} from '../src/lib/guide/storage.ts';

const VALID: GuideProgressV1 = {
  v: 1,
  tourSeenVersion: 3,
  dismissedInvitationVersion: 2,
};

describe('versioned guide progress', () => {
  it('accepts only the exact v1 key set and safe nonnegative versions', () => {
    expect(parseGuideProgress(JSON.stringify(VALID))).toEqual(VALID);
    for (const value of [
      null,
      '',
      'null',
      '[]',
      '{}',
      '{',
      JSON.stringify({ ...VALID, v: 0 }),
      JSON.stringify({ ...VALID, legacy: true }),
      JSON.stringify({ v: 1, tourSeenVersion: -1, dismissedInvitationVersion: null }),
      JSON.stringify({ v: 1, tourSeenVersion: 1.5, dismissedInvitationVersion: null }),
      JSON.stringify({
        v: 1,
        tourSeenVersion: Number.MAX_SAFE_INTEGER + 1,
        dismissedInvitationVersion: null,
      }),
    ]) {
      expect(parseGuideProgress(value)).toBe(emptyGuideProgress());
    }
  });

  it('advances one stamp monotonically and treats a future stamp as covered', () => {
    const empty = emptyGuideProgress();
    const dismissed = advanceGuideProgress(empty, 'dismissedInvitationVersion', 1);
    expect(dismissed).toEqual({
      v: 1,
      tourSeenVersion: null,
      dismissedInvitationVersion: 1,
    });
    expect(advanceGuideProgress(dismissed, 'dismissedInvitationVersion', 0))
      .toBe(dismissed);
    expect(guideProgressCovers(dismissed, 'dismissedInvitationVersion', 1)).toBe(true);
    expect(guideProgressCovers(dismissed, 'dismissedInvitationVersion', 2)).toBe(false);
    expect(guideProgressCovers({ ...dismissed, tourSeenVersion: 9 }, 'tourSeenVersion', 2))
      .toBe(true);
  });

  it('loads and saves one privacy-bounded record without throwing on refusal', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
    saveGuideProgress(storage, VALID);
    expect([...values.keys()]).toEqual([GUIDE_PROGRESS_STORAGE_KEY]);
    expect(loadGuideProgress(storage)).toEqual(VALID);
    expect(Object.keys(JSON.parse(values.get(GUIDE_PROGRESS_STORAGE_KEY)!)).sort())
      .toEqual(['dismissedInvitationVersion', 'tourSeenVersion', 'v']);

    expect(() => saveGuideProgress({ setItem: () => { throw new Error('quota'); } }, VALID))
      .not.toThrow();
    expect(loadGuideProgress({ getItem: () => { throw new Error('disabled'); } }))
      .toBe(emptyGuideProgress());
  });

  it('handles a window that refuses localStorage access', () => {
    expect(browserGuideLocalStorage({ localStorage: {} as Storage })).toEqual({});
    expect(browserGuideLocalStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    })).toBeNull();
  });
});
