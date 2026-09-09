import { useCallback, useRef, useState, type RefObject } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import { globalSettingsEntry, type SettingsContext, type SettingsEntry } from '../../lib/settings-entry.ts';
import type { ShortcutHelpContext } from '../../lib/shortcuts.ts';

type OpenUtilityPane =
  | { readonly kind: 'settings'; readonly entry: SettingsEntry }
  | { readonly kind: 'debug' }
  | { readonly kind: 'reader-controls' }
  | { readonly kind: 'speed-settings'; readonly restSummary: string }
  | { readonly kind: 'help'; readonly context: ShortcutHelpContext };

interface CloseUtilityPaneOptions {
  readonly restoreFocus?: boolean;
  readonly onSettled?: (interactive: boolean) => void;
}

/** Utility pane state and focus-return lifetime. Find retains its own focus
 * origin; opening a utility pane borrows it before exiting the interaction. */
export function useUtilityPanes({ onOpen, findReturnFocus }: {
  readonly onOpen: () => void;
  readonly findReturnFocus: RefObject<HTMLElement | null>;
}) {
  const place = useApp((s) => s.place);
  const interaction = useApp((s) => s.interaction);
  const exitInteraction = useApp((s) => s.exitInteraction);
  const setRsvpPlaying = useApp((s) => s.setRsvpPlaying);
  const [utilityPane, setUtilityPane] = useState<OpenUtilityPane | null>(null);
  const utilityPaneReturnFocus = useRef<HTMLElement | null>(null);
  const openHelp = (context: ShortcutHelpContext, fromUtilityPane = false) => {
    onOpen();
    if (!fromUtilityPane) {
      utilityPaneReturnFocus.current = interaction.kind === 'find'
        ? findReturnFocus.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    if (interaction.kind === 'find') exitInteraction();
    if (interaction.kind === 'rsvp') setRsvpPlaying(false);
    setUtilityPane({ kind: 'help', context });
  };
  const openSettingsEntry = useCallback((
    entry: SettingsEntry,
    returnFocus: HTMLElement | null = null,
    fromUtilityPane = false,
  ) => {
    onOpen();
    if (!fromUtilityPane) {
      utilityPaneReturnFocus.current = returnFocus ?? (interaction.kind === 'find'
        ? findReturnFocus.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
    }
    if (interaction.kind === 'find') exitInteraction();
    if (interaction.kind === 'rsvp') setRsvpPlaying(false);
    setUtilityPane({ kind: 'settings', entry });
  }, [onOpen, exitInteraction, findReturnFocus, interaction.kind, setRsvpPlaying]);
  const openSettings = (
    context: SettingsContext = place,
    returnFocus: HTMLElement | null = null,
  ) => openSettingsEntry(globalSettingsEntry(context), returnFocus);
  const openDebug = (fromUtilityPane = false) => {
    onOpen();
    if (!fromUtilityPane) {
      utilityPaneReturnFocus.current = interaction.kind === 'find'
        ? findReturnFocus.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    if (interaction.kind === 'find') exitInteraction();
    if (interaction.kind === 'rsvp') setRsvpPlaying(false);
    setUtilityPane({ kind: 'debug' });
  };
  const openReaderControls = (returnFocus: HTMLElement) => {
    onOpen();
    utilityPaneReturnFocus.current = returnFocus;
    setUtilityPane({ kind: 'reader-controls' });
  };
  const openSpeedSettings = (returnFocus: HTMLElement, restSummary: string) => {
    if (interaction.kind !== 'rsvp') return;
    onOpen();
    utilityPaneReturnFocus.current = returnFocus;
    setRsvpPlaying(false);
    setUtilityPane({ kind: 'speed-settings', restSummary });
  };
  const closeUtilityPane = (options: CloseUtilityPaneOptions = {}) => {
    const target = utilityPaneReturnFocus.current;
    const targetId = target?.id ?? '';
    setUtilityPane(null);
    const restore = (attempt: number) => {
      const root = document.getElementById('root');
      if (root?.inert && attempt < 3) {
        requestAnimationFrame(() => restore(attempt + 1));
        return;
      }
      const interactive = root?.inert !== true;
      if (options.restoreFocus !== false && interactive) {
        const connectedTarget = target?.isConnected
          ? target
          : targetId === ''
            ? null
            : document.getElementById(targetId);
        connectedTarget?.focus({ preventScroll: true });
      }
      options.onSettled?.(interactive);
    };
    requestAnimationFrame(() => restore(0));
  };
  return {
    utilityPane, utilityPaneReturnFocus, openHelp, openSettingsEntry, openSettings,
    openDebug, openReaderControls, openSpeedSettings, closeUtilityPane,
    dismissForFind: () => setUtilityPane(null),
  };
}
