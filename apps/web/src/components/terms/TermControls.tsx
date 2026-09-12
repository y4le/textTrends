/** Term buttons, long-press gestures, and actions; QuerySurface owns the rail and editor. */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { SeriesLineSample } from '../chrome.tsx';
import { formatAliasAlternatives } from '../../lib/notebook.ts';
import { DEFAULT_SERIES_STYLE } from '../../lib/series-style.ts';
import { termFocusControlId, termToggleControlId } from '../../lib/query-surface.ts';
import { notebookCountLabel, type NotebookRowVM } from '../../lib/notebook-view.ts';
import { shortcutAria, shortcutMatches } from '../../lib/shortcuts.ts';

const TERM_LONG_PRESS_MS = 500;

const TERM_LONG_PRESS_MOVEMENT_PX = 10;

const TERM_MENU_FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function termMenuId(groupId: string): string {
  return `term-menu-${encodeURIComponent(groupId)}`;
}

export function TermBucket({
  row,
  aliases,
  menuOpen,
  onToggle,
  onEdit,
  onOpenMenu,
  onNavigate,
  onDelete,
  onAddInline,
  onExit,
}: {
  readonly row: NotebookRowVM;
  readonly aliases: readonly string[];
  readonly menuOpen: boolean;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onOpenMenu: () => void;
  readonly onNavigate: (delta: -1 | 1) => void;
  readonly onDelete: () => void;
  readonly onAddInline: () => void;
  readonly onExit: () => void;
}) {
  const longPress = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClickUntil = useRef(0);

  const clearLongPress = () => {
    const pending = longPress.current;
    if (pending !== null) clearTimeout(pending.timer);
    longPress.current = null;
  };

  useEffect(() => clearLongPress, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    clearLongPress();
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return;
    const { pointerId, clientX: x, clientY: y } = event;
    const timer = setTimeout(() => {
      const pending = longPress.current;
      if (pending === null || pending.pointerId !== pointerId) return;
      longPress.current = null;
      suppressClickUntil.current = Date.now() + 1_000;
      onOpenMenu();
    }, TERM_LONG_PRESS_MS);
    longPress.current = { pointerId, x, y, timer };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const pending = longPress.current;
    if (
      pending === null
      || pending.pointerId !== event.pointerId
      || Math.hypot(event.clientX - pending.x, event.clientY - pending.y)
        <= TERM_LONG_PRESS_MOVEMENT_PX
    ) return;
    clearLongPress();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction = shortcutMatches(event, 'term-previous')
      ? -1
      : shortcutMatches(event, 'term-next') ? 1 : 0;
    if (direction !== 0) {
      event.preventDefault();
      onNavigate(direction);
      return;
    }
    if (shortcutMatches(event, 'term-toggle')) {
      event.preventDefault();
      onToggle();
      return;
    }
    if (shortcutMatches(event, 'term-delete')) {
      event.preventDefault();
      onDelete();
      return;
    }
    if (shortcutMatches(event, 'term-add-inline')) {
      event.preventDefault();
      onAddInline();
      return;
    }
    if (shortcutMatches(event, 'term-open-menu')) {
      event.preventDefault();
      onOpenMenu();
      return;
    }
    if (shortcutMatches(event, 'term-exit')) {
      event.preventDefault();
      onExit();
    }
  };

  return (
    <span
      className="term-bucket"
      data-active={row.active || undefined}
      data-solo={row.solo || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onClickCapture={(event) => {
        if (Date.now() >= suppressClickUntil.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntil.current = 0;
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        clearLongPress();
        onOpenMenu();
      }}
    >
      <button
        id={termFocusControlId(row.id)}
        type="button"
        className="term-bucket-summary"
        data-term-focus
        data-term-id={row.id}
        data-projected={row.projected || undefined}
        aria-label={[
          `${row.name}, ${row.active ? 'shown' : 'hidden'} in analysis`,
          aliases.length > 1 ? `Matches ${formatAliasAlternatives(aliases)}` : null,
        ].filter(Boolean).join('. ')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? termMenuId(row.id) : undefined}
        aria-keyshortcuts={shortcutAria([
          'term-previous',
          'term-next',
          'term-toggle',
          'term-delete',
          'term-add-inline',
          'term-open-menu',
          'term-exit',
        ])}
        onKeyDown={onKeyDown}
        onClick={onOpenMenu}
        title={aliases.length > 1
          ? `Matches ${formatAliasAlternatives(aliases)} · Open actions`
          : `Open actions for ${row.name}`}
      >
        <SeriesLineSample style={row.style ?? DEFAULT_SERIES_STYLE} emphasized={row.projected} />
        <span className="term-bucket-name">{row.name}</span>
        <span className="term-bucket-count">{notebookCountLabel(row.count, row.active)}</span>
      </button>
      <button
        id={termToggleControlId(row.id)}
        type="button"
        className="term-bucket-toggle"
        data-term-toggle
        data-term-id={row.id}
        aria-label={`Shown in analysis: ${row.name}`}
        aria-pressed={row.active}
        onClick={onToggle}
        title={row.active ? 'Hide from analysis' : 'Show in analysis'}
      >
        <span aria-hidden="true">{row.active ? '✓' : '○'}</span>
      </button>
      <button
        type="button"
        id={`term-edit-${row.id}`}
        className="term-bucket-edit"
        aria-label={`Edit term: ${row.name}`}
        onClick={onEdit}
      >
        edit
      </button>
    </span>
  );
}

export function TermActionMenu({
  row,
  onClose,
  onSelectOnly,
  onDelete,
  onManage,
}: {
  readonly row: NotebookRowVM;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onSelectOnly: () => void;
  readonly onDelete: () => void;
  readonly onManage: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const anchorId = termFocusControlId(row.id);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const placeMenu = () => {
      const anchor = document.getElementById(anchorId);
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gutter = 8;
      const gap = 5;
      const left = Math.max(
        gutter,
        Math.min(anchorRect.left, window.innerWidth - menuRect.width - gutter),
      );
      const above = anchorRect.top - menuRect.height - gap;
      const top = above >= gutter ? above : anchorRect.bottom + gap;
      setPosition({ left, top, visibility: 'visible' });
    };
    placeMenu();
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [anchorId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({
        preventScroll: true,
      });
    });
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node
        && (
          menuRef.current?.contains(target)
          || document.getElementById(anchorId)?.contains(target)
        )
      ) return;
      onCloseRef.current(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOutside, true);
    };
  }, [anchorId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const anchor = document.getElementById(anchorId);
      const controls = [...document.querySelectorAll<HTMLElement>(TERM_MENU_FOCUSABLE)]
        .filter((control) => (
          !menuRef.current?.contains(control)
          && control.getClientRects().length > 0
        ));
      const anchorIndex = anchor instanceof HTMLElement ? controls.indexOf(anchor) : -1;
      const target = anchorIndex < 0
        ? anchor
        : controls[anchorIndex + (event.shiftKey ? -1 : 1)] ?? anchor;
      onClose(false);
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === null || items.length === 0) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={menuRef}
      id={termMenuId(row.id)}
      className="term-action-menu"
      role="menu"
      aria-label={`Manage ${row.name}`}
      style={position}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" tabIndex={-1} onClick={onSelectOnly}>
        {row.solo ? 'Show all selected items' : 'Select only this item'}
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-danger="true"
        onClick={onDelete}
      >
        Delete this item
      </button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={onManage}>
        Manage this item
      </button>
    </div>,
    document.body,
  );
}
