import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  ROW_NAVIGATION_SHORTCUT_IDS,
  rowNavigationShortcut,
  rowNavigationTarget,
  visibleRowPageSize,
} from '../lib/row-navigation.ts';
import { shortcutAria } from '../lib/shortcuts.ts';

interface RowNavigationOptions {
  readonly keys: readonly string[];
  readonly label: string;
  readonly preferredKey?: string | null;
  readonly portRef?: RefObject<HTMLDivElement | null>;
  readonly onExit?: (key: string) => boolean;
  readonly onFocusKey?: (key: string) => void;
}

export interface RowControlProps {
  readonly ref: (element: HTMLButtonElement | null) => void;
  readonly tabIndex: 0 | -1;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly 'aria-keyshortcuts': string;
}

const ROW_ARIA_KEYS = shortcutAria(ROW_NAVIGATION_SHORTCUT_IDS);

export function useRowNavigation({
  keys,
  label,
  preferredKey = null,
  portRef: providedPortRef,
  onExit,
  onFocusKey,
}: RowNavigationOptions) {
  const internalPortRef = useRef<HTMLDivElement | null>(null);
  const portRef = providedPortRef ?? internalPortRef;
  const controlsRef = useRef(new Map<string, HTMLButtonElement>());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const identity = keys.join('\u001f');
  const resolvedActiveKey = activeKey !== null && keys.includes(activeKey)
    ? activeKey
    : null;
  const tabStopKey = resolvedActiveKey
    ?? (preferredKey !== null && keys.includes(preferredKey)
      ? preferredKey
      : keys[0] ?? null);

  useEffect(() => {
    const live = new Set(keys);
    for (const key of controlsRef.current.keys()) {
      if (!live.has(key)) controlsRef.current.delete(key);
    }
    setActiveKey((current) => current !== null && live.has(current) ? current : null);
  }, [identity]);

  const activateIndex = useCallback((index: number, focus = true) => {
    const key = keys[index];
    if (key === undefined) return;
    setActiveKey(key);
    const control = controlsRef.current.get(key);
    control?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) control?.focus({ preventScroll: true });
    else onFocusKey?.(key);
  }, [identity, onFocusKey]);

  const controlProps = (key: string): RowControlProps => ({
    ref: (element) => {
      if (element) controlsRef.current.set(key, element);
      else controlsRef.current.delete(key);
    },
    tabIndex: tabStopKey === key ? 0 : -1,
    onFocus: () => {
      setActiveKey(key);
      onFocusKey?.(key);
    },
    onKeyDown: (event) => {
      const shortcut = rowNavigationShortcut(event);
      if (shortcut === null) return;
      event.preventDefault();
      if (shortcut === 'row-exit') {
        const closed = onExit?.(key) ?? false;
        if (closed) {
          setStatus(`${label} detail closed`);
        } else {
          setStatus(`${label} navigation paused`);
          requestAnimationFrame(() => portRef.current?.focus({ preventScroll: true }));
        }
        return;
      }
      const current = Math.max(0, keys.indexOf(key));
      const portHeight = portRef.current?.clientHeight ?? window.innerHeight;
      const row = event.currentTarget.closest<HTMLElement>(
        'tr, [data-row-navigation-row]',
      );
      const pageSize = visibleRowPageSize(
        portHeight,
        window.innerHeight,
        row?.getBoundingClientRect().height ?? event.currentTarget.getBoundingClientRect().height,
      );
      const target = rowNavigationTarget(keys.length, current, shortcut, pageSize);
      if (target === current) {
        setStatus(`${label}: ${current === 0 ? 'first' : 'last'} row`);
        return;
      }
      activateIndex(target);
      setStatus(`${label}: row ${target + 1} of ${keys.length}`);
    },
    'aria-keyshortcuts': ROW_ARIA_KEYS,
  });

  return {
    activeKey: resolvedActiveKey,
    activateIndex,
    controlProps,
    portRef,
    status,
  } as const;
}
