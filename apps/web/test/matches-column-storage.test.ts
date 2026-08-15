import { describe, expect, it } from 'vitest';
import {
  loadMatchesColumnSettings,
  saveMatchesColumnSettings,
} from '../src/lib/matches-column-storage.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('Matches column session storage', () => {
  it('round-trips ratios, manual widths, and auto intent', () => {
    const storage = memoryStorage();
    const settings = { left: 33, node: 'auto' as const, right: 67, book: 28 };
    saveMatchesColumnSettings(storage, settings);
    expect(loadMatchesColumnSettings(storage)).toEqual(settings);
  });

  it('ignores malformed, unknown-sentinel, or out-of-range geometry', () => {
    expect(loadMatchesColumnSettings(memoryStorage('{broken'))).toBeNull();
    expect(loadMatchesColumnSettings(memoryStorage(JSON.stringify({
      left: 52,
      node: 'automatic',
      right: 37,
      book: 3,
    })))).toBeNull();
    expect(loadMatchesColumnSettings(memoryStorage(JSON.stringify({
      left: 52,
      node: 49,
      right: 37,
      book: 3,
    })))).toBeNull();
    expect(loadMatchesColumnSettings(memoryStorage(JSON.stringify({
      left: 52,
      node: 'auto',
      right: 37,
      book: 3,
      pixels: 900,
    })))).toBeNull();
  });

  it('keeps storage failures non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadMatchesColumnSettings(unavailable)).toBeNull();
    expect(() => saveMatchesColumnSettings(unavailable, {
      left: 1,
      node: 'auto',
      right: 1,
      book: 'auto',
    })).not.toThrow();
  });
});
