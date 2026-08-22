import { describe, expect, it } from 'vitest';
import { loadRsvpWpm, saveRsvpWpm } from '../src/lib/rsvp-storage.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('RSVP pace session storage', () => {
  it('round-trips a bounded integer pace', () => {
    const storage = memoryStorage();
    saveRsvpWpm(storage, 425);
    expect(loadRsvpWpm(storage)).toBe(425);
  });

  it('rejects malformed, extended, fractional, and out-of-range values', () => {
    expect(loadRsvpWpm(memoryStorage('{broken'))).toBeNull();
    expect(loadRsvpWpm(memoryStorage(JSON.stringify({ wpm: 425, extra: true })))).toBeNull();
    expect(loadRsvpWpm(memoryStorage(JSON.stringify({ wpm: 425.5 })))).toBeNull();
    expect(loadRsvpWpm(memoryStorage(JSON.stringify({ wpm: 99 })))).toBeNull();
    expect(loadRsvpWpm(memoryStorage(JSON.stringify({ wpm: 901 })))).toBeNull();
  });

  it('keeps unavailable storage non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadRsvpWpm(unavailable)).toBeNull();
    expect(() => saveRsvpWpm(unavailable, 300)).not.toThrow();
  });
});
