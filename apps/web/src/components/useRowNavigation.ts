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
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';

interface RowNavigationOptions {
  readonly keys: readonly string[];
  readonly label: string;
  readonly preferredKey?: string | null;
  readonly fallbackIndex?: number;
  readonly portRef?: RefObject<HTMLDivElement | null>;
  readonly onExit?: (key: string) => boolean;
  readonly onFocusKey?: (key: string) => void;
  readonly onActivateIndex?: (index: number, key: string) => void;
  readonly resolveTarget?: (input: {
    readonly key: string;
    readonly index: number;
    readonly shortcut: Exclude<ReturnType<typeof rowNavigationShortcut>, 'row-exit' | null>;
    readonly pageSize: number;
  }) => number;
  readonly formatStatus?: (input: {
    readonly key: string;
    readonly index: number;
    readonly boundary: boolean;
  }) => string;
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
  fallbackIndex,
  portRef: providedPortRef,
  onExit,
  onFocusKey,
  onActivateIndex,
  resolveTarget,
  formatStatus,
}: RowNavigationOptions) {
  const internalPortRef = useRef<HTMLDivElement | null>(null);
  const portRef = providedPortRef ?? internalPortRef;
  const controlsRef = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusKeyRef = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const resolvedActiveKey = activeKey !== null && keys.includes(activeKey)
    ? activeKey
    : null;
  const boundedFallbackIndex = fallbackIndex === undefined
    ? 0
    : Math.max(0, Math.min(keys.length - 1, Math.floor(fallbackIndex)));
  const tabStopKey = resolvedActiveKey
    ?? (preferredKey !== null && keys.includes(preferredKey)
      ? preferredKey
      : keys[boundedFallbackIndex] ?? null);

  useEffect(() => {
    const live = new Set(keys);
    for (const key of controlsRef.current.keys()) {
      if (!live.has(key)) controlsRef.current.delete(key);
    }
    setActiveKey((current) => current !== null && live.has(current) ? current : null);
  }, [keys]);

  const activateIndex = useCallback((index: number, focus = true) => {
    const key = keys[index];
    if (key === undefined) return;
    setActiveKey(key);
    onActivateIndex?.(index, key);
    const control = controlsRef.current.get(key);
    control?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus && control) {
      pendingFocusKeyRef.current = null;
      control.focus({ preventScroll: true });
    }
    else if (focus) pendingFocusKeyRef.current = key;
    else onFocusKey?.(key);
  }, [keys, onActivateIndex, onFocusKey]);

  const controlProps = (key: string): RowControlProps => ({
    ref: (element) => {
      if (element) {
        controlsRef.current.set(key, element);
        if (pendingFocusKeyRef.current === key) {
          pendingFocusKeyRef.current = null;
          requestAnimationFrame(() => {
            if (controlsRef.current.get(key) !== element) return;
            element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            element.focus({ preventScroll: true });
          });
        }
      } else {
        controlsRef.current.delete(key);
      }
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
      const target = resolveTarget?.({
        key,
        index: current,
        shortcut,
        pageSize,
      }) ?? rowNavigationTarget(keys.length, current, shortcut, pageSize);
      if (target === current) {
        setStatus(formatStatus?.({ key, index: current, boundary: true })
          ?? `${label}: ${current === 0 ? 'first' : 'last'} row`);
        return;
      }
      activateIndex(target);
      const targetKey = keys[target]!;
      setStatus(formatStatus?.({ key: targetKey, index: target, boundary: false })
        ?? `${label}: row ${target + 1} of ${keys.length}`);
    },
    'aria-keyshortcuts': ROW_ARIA_KEYS,
  });

  const portProps = {
    'aria-keyshortcuts': ROW_ARIA_KEYS,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (shortcutMatches(event, 'row-open')) {
        const key = resolvedActiveKey ?? tabStopKey;
        const control = key === null ? null : controlsRef.current.get(key);
        if (!control) return;
        event.preventDefault();
        control.focus({ preventScroll: true });
        control.click();
        return;
      }
      const shortcut = rowNavigationShortcut(event);
      if (shortcut === null) return;
      event.preventDefault();
      if (shortcut === 'row-exit') {
        event.currentTarget.blur();
        setStatus(`${label} navigation paused`);
        return;
      }
      const firstControl = tabStopKey === null ? null : controlsRef.current.get(tabStopKey);
      const row = firstControl?.closest<HTMLElement>('tr, [data-row-navigation-row]');
      const pageSize = visibleRowPageSize(
        event.currentTarget.clientHeight,
        window.innerHeight,
        row?.getBoundingClientRect().height ?? firstControl?.getBoundingClientRect().height ?? 1,
      );
      const target = resolvedActiveKey === null
        ? (fallbackIndex === undefined
          ? (
            shortcut === 'row-previous'
            || shortcut === 'row-page-previous'
            || shortcut === 'row-half-page-previous'
            || shortcut === 'row-last'
              ? keys.length - 1
              : 0
            )
          : boundedFallbackIndex)
        : (resolveTarget?.({
            key: resolvedActiveKey,
            index: keys.indexOf(resolvedActiveKey),
            shortcut,
            pageSize,
          }) ?? rowNavigationTarget(
            keys.length,
            keys.indexOf(resolvedActiveKey),
            shortcut,
            pageSize,
          ));
      if (target < 0) return;
      activateIndex(target);
      const targetKey = keys[target]!;
      setStatus(formatStatus?.({ key: targetKey, index: target, boundary: false })
        ?? `${label}: row ${target + 1} of ${keys.length}`);
    },
  } as const;

  return {
    activeKey: resolvedActiveKey,
    activateIndex,
    controlProps,
    portRef,
    portProps,
    status,
  } as const;
}
