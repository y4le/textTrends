import { describe, expect, it } from 'vitest';
import { RSVP_PACING_DEFAULTS } from '@texttrends/rsvp';
import {
  RSVP_PACING_STORAGE_KEY,
  RSVP_PACING_V2_STORAGE_KEY,
  RSVP_WPM_STORAGE_KEY,
  browserLocalStorage,
  loadRsvpPacing,
  saveRsvpPacing,
} from '../src/lib/rsvp-storage.ts';

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    value: (key: string) => values.get(key) ?? null,
  };
}

describe('RSVP rhythm local storage', () => {
  it('round-trips the complete bounded preference record', () => {
    const storage = memoryStorage();
    const pacing = {
      wpm: 425,
      wordsPerFrame: 2,
      frameCharLimit: 24,
      sentencePauseMs: 250,
      paragraphPauseMs: 800,
      lengthEmphasis: 50,
    };
    saveRsvpPacing(storage, pacing);
    expect(loadRsvpPacing(storage)).toEqual(pacing);
    expect(storage.value(RSVP_PACING_STORAGE_KEY)).not.toBeNull();
  });

  it('accepts every in-range integer independently of the UI increment', () => {
    const storage = memoryStorage();
    const pacing = { ...RSVP_PACING_DEFAULTS, frameCharLimit: 13 };
    saveRsvpPacing(storage, pacing);
    expect(loadRsvpPacing(storage)).toEqual(pacing);
  });

  it('rejects malformed, extended, fractional, inverted, and out-of-range records', () => {
    const read = (value: unknown) => loadRsvpPacing(memoryStorage({
      [RSVP_PACING_STORAGE_KEY]: typeof value === 'string' ? value : JSON.stringify(value),
    }));
    expect(read('{broken')).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, extra: true })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 425.5 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wordsPerFrame: 4 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, frameCharLimit: 10 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, frameCharLimit: 41 })).toBeNull();
    expect(read({
      ...RSVP_PACING_DEFAULTS,
      sentencePauseMs: 750,
      paragraphPauseMs: 500,
    })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, lengthEmphasis: 101 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 2_000 })).toMatchObject({ wpm: 2_000 });
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 2_001 })).toBeNull();
  });

  it('ignores pre-alpha records and removes the old local record on save', () => {
    const storage = memoryStorage({
      [RSVP_PACING_V2_STORAGE_KEY]: JSON.stringify({
        wpm: 425,
        wordsPerFrame: 2,
        sentencePauseMs: 250,
        paragraphPauseMs: 800,
        lengthEmphasis: 50,
      }),
      [RSVP_WPM_STORAGE_KEY]: JSON.stringify({ wpm: 425 }),
    });
    expect(loadRsvpPacing(storage)).toBeNull();
    saveRsvpPacing(storage, RSVP_PACING_DEFAULTS);
    expect(storage.value(RSVP_PACING_V2_STORAGE_KEY)).toBeNull();
    expect(storage.value(RSVP_WPM_STORAGE_KEY)).not.toBeNull();
    expect(loadRsvpPacing(storage)).toEqual(RSVP_PACING_DEFAULTS);
  });

  it('keeps unavailable storage non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      removeItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadRsvpPacing(unavailable)).toBeNull();
    expect(() => saveRsvpPacing(unavailable, RSVP_PACING_DEFAULTS)).not.toThrow();
    expect(browserLocalStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    })).toBeNull();
  });
});
