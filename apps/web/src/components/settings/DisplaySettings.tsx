import { useSyncExternalStore } from 'react';
import {
  getDisplayPreference,
  getServerDisplayPreference,
  patchDisplayPreference,
  resetDisplayPreference,
  subscribeDisplayPreference,
} from '../../lib/display-store.ts';
import {
  DISPLAY_DENSITIES,
  DISPLAY_THEMES,
  type Density,
  type Theme,
} from '../../lib/display-preference.ts';

const THEME_LABEL: Readonly<Record<Theme, string>> = Object.freeze({
  system: 'System',
  dark: 'Dark',
  light: 'Light',
});

const DENSITY_LABEL: Readonly<Record<Density, string>> = Object.freeze({
  compact: 'Compact',
  standard: 'Standard',
  comfortable: 'Comfortable',
});

export function DisplaySettings() {
  const preference = useSyncExternalStore(
    subscribeDisplayPreference,
    getDisplayPreference,
    getServerDisplayPreference,
  );

  return (
    <div className="display-settings">
      <fieldset className="density-settings">
        <legend>UI density</legend>
        <div className="density-setting-heading">
          <label htmlFor="display-density">Size and spacing</label>
          <output htmlFor="display-density">
            {DENSITY_LABEL[preference.density]}
          </output>
        </div>
        <input
          id="display-density"
          type="range"
          min={0}
          max={DISPLAY_DENSITIES.length - 1}
          step={1}
          value={DISPLAY_DENSITIES.indexOf(preference.density)}
          aria-valuetext={DENSITY_LABEL[preference.density]}
          onChange={(event) => patchDisplayPreference({
            density: DISPLAY_DENSITIES[event.currentTarget.valueAsNumber] ?? 'standard',
          })}
        />
        <div className="density-stop-labels" aria-hidden="true">
          {DISPLAY_DENSITIES.map((density) => (
            <span key={density}>{DENSITY_LABEL[density]}</span>
          ))}
        </div>
        <p>Changes UI type and data-row spacing. Reader text and chart encodings stay fixed.</p>
      </fieldset>
      <fieldset>
        <legend>Theme</legend>
        <div className="settings-choice-row">
          {DISPLAY_THEMES.map((theme) => (
            <label key={theme}>
              <input
                type="radio"
                name="display-theme"
                value={theme}
                checked={preference.theme === theme}
                onChange={() => patchDisplayPreference({ theme })}
              />
              {THEME_LABEL[theme]}
            </label>
          ))}
        </div>
        <p>System follows this device's light or dark appearance.</p>
      </fieldset>
      <p>Reduced motion follows this device's accessibility preference.</p>
      <button type="button" onClick={resetDisplayPreference}>Reset display</button>
    </div>
  );
}
