import { describe, expect, it } from 'vitest';
import {
  browserStorage,
  definePreference,
  exactKeys,
  recordOf,
} from '../src/lib/preference-store.ts';
import { PREFERENCES, preferenceKeys } from '../src/lib/preferences.ts';

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    value: (key: string) => values.get(key) ?? null,
  };
}

describe('preference storage mechanics', () => {
  const preference = definePreference<number>({
    key: 'current',
    scope: 'local',
    legacyKeys: ['old'],
    parse: (value) => typeof value === 'number' && Number.isInteger(value) ? value : null,
    serialize: (value) => typeof value === 'number' && Number.isInteger(value) ? value : null,
  });

  it('loads JSON, saves validated values, and cleans legacy keys', () => {
    const storage = memoryStorage({ current: '4', old: '3', unrelated: 'keep' });
    expect(preference.load(storage)).toBe(4);
    preference.save(storage, 5);
    expect(storage.value('current')).toBe('5');
    expect(storage.value('old')).toBeNull();
    expect(storage.value('unrelated')).toBe('keep');
  });

  it('rejects malformed and invalid values without disturbing storage', () => {
    const malformed = memoryStorage({ current: '{' });
    expect(preference.load(malformed)).toBeNull();
    const invalid = memoryStorage({ current: '4', old: '3' });
    preference.save(invalid, 1.5);
    expect(invalid.value('current')).toBe('4');
    expect(invalid.value('old')).toBe('3');
  });

  it('clears only owned keys and makes storage failures non-fatal', () => {
    const storage = memoryStorage({ current: '4', old: '3', unrelated: 'keep' });
    preference.clear(storage);
    expect(storage.value('current')).toBeNull();
    expect(storage.value('old')).toBeNull();
    expect(storage.value('unrelated')).toBe('keep');
    const unavailable = {
      getItem: () => { throw new Error('disabled'); },
      setItem: () => { throw new Error('disabled'); },
      removeItem: () => { throw new Error('disabled'); },
    };
    expect(preference.load(unavailable)).toBeNull();
    expect(() => preference.save(unavailable, 5)).not.toThrow();
    expect(() => preference.clear(unavailable)).not.toThrow();
  });

  it('selects the requested browser scope and handles denied access', () => {
    const local = memoryStorage() as unknown as Storage;
    const session = memoryStorage() as unknown as Storage;
    expect(browserStorage({ localStorage: local }, 'local')).toBe(local);
    expect(browserStorage({ sessionStorage: session }, 'session')).toBe(session);
    expect(browserStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    }, 'local')).toBeNull();
  });

  it('provides shared strict-record helpers', () => {
    const record = recordOf({ two: 2, one: 1 });
    expect(record).not.toBeNull();
    expect(exactKeys(record!, ['one', 'two'])).toBe(true);
    expect(recordOf([])).toBeNull();
  });
});

describe('preference ownership registry', () => {
  it('owns each current and retired key exactly once in its real scope', () => {
    const allKeys = PREFERENCES.flatMap((preference) => [preference.key, ...preference.legacyKeys]);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(preferenceKeys('local')).toEqual([
      'texttrends/display/1',
      'texttrends/guide/1',
      'texttrends/reader-atlas/1',
      'texttrends/rsvp-rhythm/3',
      'texttrends/rsvp-rhythm/2',
      'texttrends/trend-rows/2',
      'texttrends/trend-rows/1',
    ]);
    expect(preferenceKeys('session')).toEqual([
      'texttrends/matches-columns/3',
      'texttrends/rsvp-pace/1',
      'texttrends/vocabulary-columns/1',
    ]);
  });
});
