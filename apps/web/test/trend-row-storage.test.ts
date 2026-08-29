import { describe, expect, it } from 'vitest';
import {
  browserTrendRowStorage,
  loadTrendRowPitch,
  saveTrendRowPitch,
  TREND_ROW_PITCH_STORAGE_KEY,
} from '../src/lib/trend-row-storage.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const keys: string[] = [];
  return {
    getItem: (key: string) => { keys.push(key); return value; },
    setItem: (key: string, next: string) => { keys.push(key); value = next; },
    removeItem: (key: string) => { keys.push(key); value = null; },
    value: () => value,
    keys: () => keys,
  };
}

describe('trend row-pitch storage', () => {
  it('round-trips one explicit integer request', () => {
    const storage = memoryStorage();
    saveTrendRowPitch(storage, 58);
    expect(storage.value()).toBe('{"pitch":58}');
    expect(loadTrendRowPitch(storage)).toBe(58);
    expect(TREND_ROW_PITCH_STORAGE_KEY).toBe('texttrends/trend-rows/1');
    expect(storage.keys()).toEqual([
      TREND_ROW_PITCH_STORAGE_KEY,
      TREND_ROW_PITCH_STORAGE_KEY,
    ]);
  });

  it('removes the request when sizing returns to automatic', () => {
    const storage = memoryStorage('{"pitch":58}');
    saveTrendRowPitch(storage, null);
    expect(storage.value()).toBeNull();
    expect(loadTrendRowPitch(storage)).toBeNull();
    expect(storage.keys()).toEqual([
      TREND_ROW_PITCH_STORAGE_KEY,
      TREND_ROW_PITCH_STORAGE_KEY,
    ]);
  });

  it.each([1, 58, 512])('accepts inclusive storage-envelope pitch %s', (pitch) => {
    const storage = memoryStorage();
    saveTrendRowPitch(storage, pitch);
    expect(loadTrendRowPitch(storage)).toBe(pitch);
  });

  it.each([
    '{broken',
    'null',
    '[]',
    '{"pitch":0}',
    '{"pitch":513}',
    '{"pitch":58.5}',
    '{"pitch":"58"}',
    '{"pitch":58,"extra":true}',
  ])('rejects malformed or out-of-contract value %s', (raw) => {
    expect(loadTrendRowPitch(memoryStorage(raw))).toBeNull();
  });

  it('ignores invalid writes and keeps storage failures non-fatal', () => {
    const storage = memoryStorage('{"pitch":58}');
    saveTrendRowPitch(storage, Number.NaN);
    expect(storage.value()).toBe('{"pitch":58}');

    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      removeItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadTrendRowPitch(unavailable)).toBeNull();
    expect(() => saveTrendRowPitch(unavailable, 58)).not.toThrow();
    expect(() => saveTrendRowPitch(unavailable, null)).not.toThrow();
  });

  it('guards access to browser local storage', () => {
    const storage = memoryStorage() as unknown as Storage;
    expect(browserTrendRowStorage({ localStorage: storage })).toBe(storage);
    expect(browserTrendRowStorage({
      get localStorage(): Storage { throw new DOMException('disabled', 'SecurityError'); },
    })).toBeNull();
  });
});
