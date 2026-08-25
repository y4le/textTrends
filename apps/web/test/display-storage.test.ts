import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFERENCE } from '../src/lib/display-preference.ts';
import {
  DISPLAY_PREFERENCE_STORAGE_KEY,
  browserDisplayLocalStorage,
  loadDisplayPreference,
  saveDisplayPreference,
} from '../src/lib/display-storage.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

describe('display preference local storage', () => {
  it('round-trips the strict device-local record', () => {
    const storage = memoryStorage();
    saveDisplayPreference(storage, { density: 'compact', theme: 'light' });
    expect(loadDisplayPreference(storage)).toEqual({ density: 'compact', theme: 'light' });
    expect(JSON.parse(storage.value()!)).toEqual({ density: 'compact', theme: 'light' });
    expect(DISPLAY_PREFERENCE_STORAGE_KEY).toBe('texttrends/display/1');
  });

  it('rejects malformed, extended, and unknown records', () => {
    const read = (value: unknown) => loadDisplayPreference(memoryStorage(
      typeof value === 'string' ? value : JSON.stringify(value),
    ));
    expect(read('{broken')).toBeNull();
    expect(read({ ...DEFAULT_DISPLAY_PREFERENCE, extra: true })).toBeNull();
    expect(read({ density: 'dense', theme: 'system' })).toBeNull();
    expect(read({ density: 'standard', theme: 'sepia' })).toBeNull();
  });

  it('keeps unavailable storage non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadDisplayPreference(unavailable)).toBeNull();
    expect(() => saveDisplayPreference(unavailable, DEFAULT_DISPLAY_PREFERENCE)).not.toThrow();
    expect(browserDisplayLocalStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    })).toBeNull();
  });
});
