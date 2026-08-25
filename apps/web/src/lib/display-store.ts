import {
  DEFAULT_DISPLAY_PREFERENCE,
  type DisplayPreference,
} from './display-preference.ts';
import {
  browserDisplayLocalStorage,
  loadDisplayPreference,
  saveDisplayPreference,
} from './display-storage.ts';

type DisplayListener = () => void;

const storage = typeof window === 'undefined' ? null : browserDisplayLocalStorage(window);
let preference = loadDisplayPreference(storage) ?? DEFAULT_DISPLAY_PREFERENCE;
const listeners = new Set<DisplayListener>();

function applyTheme(next: DisplayPreference): void {
  if (typeof document === 'undefined') return;
  if (next.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = next.theme;
}

applyTheme(preference);

export function getDisplayPreference(): DisplayPreference {
  return preference;
}

export function getServerDisplayPreference(): DisplayPreference {
  return DEFAULT_DISPLAY_PREFERENCE;
}

export function subscribeDisplayPreference(listener: DisplayListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDisplayPreference(next: DisplayPreference): void {
  if (next.density === preference.density && next.theme === preference.theme) return;
  preference = Object.freeze({ ...next });
  applyTheme(preference);
  saveDisplayPreference(storage, preference);
  for (const listener of listeners) listener();
}

export function patchDisplayPreference(next: Partial<DisplayPreference>): void {
  setDisplayPreference({ ...preference, ...next });
}

export function resetDisplayPreference(): void {
  setDisplayPreference(DEFAULT_DISPLAY_PREFERENCE);
}
