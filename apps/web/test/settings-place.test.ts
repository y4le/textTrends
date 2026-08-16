import { describe, expect, it } from 'vitest';
import { isSettingsPlace, SETTINGS_PLACES } from '../src/lib/settings-place.ts';
import { PLACES } from '../src/lib/places.ts';

describe('Settings utility places', () => {
  it('allowlists only Trends', () => {
    expect(SETTINGS_PLACES).toEqual(['trends']);
    expect(PLACES.filter(isSettingsPlace)).toEqual(SETTINGS_PLACES);
    expect(isSettingsPlace('inputs')).toBe(false);
    expect(isSettingsPlace('matches')).toBe(false);
    expect(isSettingsPlace('vocabulary')).toBe(false);
    expect(isSettingsPlace('compare')).toBe(false);
  });
});
