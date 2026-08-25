import {
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import type { SettingsEntry } from '../lib/settings-entry.ts';

export type OpenSettingsEntry = (
  entry: SettingsEntry,
  returnFocus?: HTMLElement | null,
) => void;

const SettingsEntryContext = createContext<OpenSettingsEntry | null>(null);

export function SettingsEntryProvider({
  openSettings,
  children,
}: {
  readonly openSettings: OpenSettingsEntry;
  readonly children: ReactNode;
}) {
  return (
    <SettingsEntryContext.Provider value={openSettings}>
      {children}
    </SettingsEntryContext.Provider>
  );
}

export function useOpenSettings(): OpenSettingsEntry {
  const openSettings = useContext(SettingsEntryContext);
  if (openSettings === null) {
    throw new Error('Settings controls require a SettingsEntryProvider.');
  }
  return openSettings;
}
