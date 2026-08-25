import { useSyncExternalStore } from 'react';
import {
  getDisplayPreference,
  getServerDisplayPreference,
  patchDisplayPreference,
  resetDisplayPreference,
  subscribeDisplayPreference,
} from '../../lib/display-store.ts';
import { DISPLAY_THEMES, type Theme } from '../../lib/display-preference.ts';

const THEME_LABEL: Readonly<Record<Theme, string>> = Object.freeze({
  system: 'System',
  dark: 'Dark',
  light: 'Light',
});

export function DisplaySettings() {
  const preference = useSyncExternalStore(
    subscribeDisplayPreference,
    getDisplayPreference,
    getServerDisplayPreference,
  );

  return (
    <div className="display-settings">
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
