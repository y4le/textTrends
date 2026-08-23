import { describe, expect, it } from 'vitest';
import { RSVP_PACING_DEFAULTS } from '../src/lib/rsvp.ts';
import {
  RSVP_PACING_STORAGE_KEY,
  RSVP_WPM_STORAGE_KEY,
  browserLocalStorage,
  loadRsvpPacing,
  loadRsvpWpm,
  pacingFromLegacyWpm,
  saveRsvpPacing,
  saveRsvpWpm,
} from '../src/lib/rsvp-storage.ts';

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    value: (key: string) => values.get(key) ?? null,
  };
}

describe('RSVP rhythm local storage', () => {
  it('round-trips the complete bounded preference record', () => {
    const storage = memoryStorage();
    const pacing = {
      wpm: 425,
      wordsPerFrame: 2,
      sentencePauseMs: 250,
      paragraphPauseMs: 800,
      lengthEmphasis: 50,
    };
    saveRsvpPacing(storage, pacing);
    expect(loadRsvpPacing(storage)).toEqual(pacing);
    expect(storage.value(RSVP_PACING_STORAGE_KEY)).not.toBeNull();
  });

  it('rejects malformed, extended, fractional, inverted, and out-of-range records', () => {
    const read = (value: unknown) => loadRsvpPacing(memoryStorage({
      [RSVP_PACING_STORAGE_KEY]: typeof value === 'string' ? value : JSON.stringify(value),
    }));
    expect(read('{broken')).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, extra: true })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 425.5 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wordsPerFrame: 4 })).toBeNull();
    expect(read({
      ...RSVP_PACING_DEFAULTS,
      sentencePauseMs: 750,
      paragraphPauseMs: 500,
    })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, lengthEmphasis: 101 })).toBeNull();
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 1_200 })).toMatchObject({ wpm: 1_200 });
    expect(read({ ...RSVP_PACING_DEFAULTS, wpm: 1_201 })).toBeNull();
  });

  it('reads the v1 session pace and seeds all new fields from Natural', () => {
    const legacy = memoryStorage();
    saveRsvpWpm(legacy, 425);
    const wpm = loadRsvpWpm(legacy);
    expect(wpm).toBe(425);
    expect(legacy.value(RSVP_WPM_STORAGE_KEY)).not.toBeNull();
    expect(wpm === null ? null : pacingFromLegacyWpm(wpm)).toEqual({
      ...RSVP_PACING_DEFAULTS,
      wpm: 425,
    });
  });

  it('keeps unavailable storage non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadRsvpPacing(unavailable)).toBeNull();
    expect(loadRsvpWpm(unavailable)).toBeNull();
    expect(() => saveRsvpPacing(unavailable, RSVP_PACING_DEFAULTS)).not.toThrow();
    expect(() => saveRsvpWpm(unavailable, 300)).not.toThrow();
    expect(browserLocalStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    })).toBeNull();
  });
});
