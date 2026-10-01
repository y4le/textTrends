import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { advanceShortcutSequence, type ShortcutHelpContext, type ShortcutId, type ShortcutSequenceState } from '../../lib/shortcuts.ts';

/** Owns workbench prefix timing and announcements. Command meaning remains
 * with the app's navigation and interaction handlers. */
export function useWorkbenchShortcuts(readerOpen: boolean) {
  const shortcutSequence = useRef<ShortcutSequenceState | null>(null);
  const shortcutSequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardNavigationStatus, setKeyboardNavigationStatus] = useState('');
  const clearShortcutSequence = useCallback(() => {
    shortcutSequence.current = null;
    if (shortcutSequenceTimer.current !== null) {
      clearTimeout(shortcutSequenceTimer.current);
      shortcutSequenceTimer.current = null;
    }
  }, []);
  const dispatchSequence = (
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
    context: ShortcutHelpContext,
    onMatched: (id: ShortcutId) => boolean,
  ) => {
    const advanced = advanceShortcutSequence(
      shortcutSequence.current,
      event,
      context,
      performance.now(),
    );
    if (advanced.kind === 'none') {
      if (shortcutSequence.current !== null) {
        clearShortcutSequence();
        setKeyboardNavigationStatus('');
      }
      return;
    }
    event.preventDefault();
    if (advanced.kind === 'matched') {
      clearShortcutSequence();
      onMatched(advanced.id);
      return;
    }
    clearShortcutSequence();
    shortcutSequence.current = advanced.state;
    setKeyboardNavigationStatus(`${advanced.state.prefix}…`);
    shortcutSequenceTimer.current = setTimeout(() => {
      if (shortcutSequence.current?.expiresAt === advanced.state.expiresAt) {
        shortcutSequence.current = null;
        shortcutSequenceTimer.current = null;
        setKeyboardNavigationStatus('');
      }
    }, Math.max(0, advanced.state.expiresAt - performance.now()));
  };
  const dispatchPendingSequence = (
    event: globalThis.KeyboardEvent,
    context: ShortcutHelpContext,
    onMatched: (id: ShortcutId) => boolean,
  ) => {
    if (shortcutSequence.current === null) return;
    const advanced = advanceShortcutSequence(shortcutSequence.current, event, context, performance.now());
    if (advanced.kind === 'matched') dispatchSequence(event, context, onMatched);
  };
  useEffect(() => () => {
    if (shortcutSequenceTimer.current !== null) clearTimeout(shortcutSequenceTimer.current);
  }, []);

  useEffect(() => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
  }, [clearShortcutSequence, readerOpen]);

  return { shortcutSequence, clearShortcutSequence, dispatchSequence, dispatchPendingSequence, keyboardNavigationStatus, setKeyboardNavigationStatus };
}
