import { useColumnPointerDrag } from '../useColumnPointerDrag.ts';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { AppState } from '../../lib/app-state.ts';
import {
  matchesColumnWidthFromDrag,
  matchesColumnWidthFromKey,
  MATCHES_COLUMN_PADDING_CH,
  type MatchesColumn,
  type MatchesColumnSettings,
  type ResolvedMatchesColumns,
} from '../../lib/matches-columns.ts';
import { proportionalPairFromPixels } from '../../lib/column-layout.ts';

interface ColumnDrag {
  readonly column: MatchesColumn;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startWidth: number;
  readonly restoreSettings: MatchesColumnSettings;
  readonly startLeftPx: number;
  readonly startRightPx: number;
  readonly chPx: number;
  readonly handle: HTMLDivElement;
  currentWidth: number;
  currentSettings: MatchesColumnSettings;
  moved: boolean;
}

interface MatchesColumnResizeOptions {
  readonly portRef: RefObject<HTMLDivElement | null>;
  readonly columns: MatchesColumnSettings;
  readonly displayedColumns: ResolvedMatchesColumns;
  readonly chPx: number;
  readonly resolveFor: (settings: MatchesColumnSettings) => ResolvedMatchesColumns;
  readonly templateFor: (settings: MatchesColumnSettings) => string;
  readonly announce: (text: string) => void;
  readonly setColumnWidth: AppState['setMatchesColumnWidth'];
  readonly setContextWeights: AppState['setMatchesContextWeights'];
  readonly resetColumn: AppState['resetMatchesColumn'];
  readonly resetColumns: AppState['resetMatchesColumns'];
}

/** Owns resize gestures and their temporary DOM preview; markup and ARIA
 * descriptions remain with the grid that renders the handles. */
export function useMatchesColumnResize({
  portRef, columns, displayedColumns, chPx, resolveFor, templateFor,
  announce, setColumnWidth, setContextWeights, resetColumn, resetColumns,
}: MatchesColumnResizeOptions) {
  const leftHeadingRef = useRef<HTMLDivElement | null>(null);
  const rightHeadingRef = useRef<HTMLDivElement | null>(null);
  const adjustButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const [columnsAdjustable, setColumnsAdjustable] = useState(false);

  const scheduleFocus = (focus: () => void) => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      focus();
    });
  };

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const writeSettings = useCallback((settings: MatchesColumnSettings) => {
    portRef.current?.style.setProperty('--kwic-template', templateFor(settings));
  }, [portRef, templateFor]);

  const {
    cancel: cancelActiveColumnDrag,
    begin: beginColumnDrag,
    move: moveColumnDrag,
    end: endColumnDrag,
    cancelEvent: cancelColumnDrag,
  } = useColumnPointerDrag<ColumnDrag, MatchesColumn>({
    enabled: columnsAdjustable,
    announce,
    restore: (drag) => {
      writeSettings(drag.restoreSettings);
      if (drag.column === 'left' || drag.column === 'right') {
        const pair = proportionalPairFromPixels(
          drag.restoreSettings.left,
          drag.restoreSettings.right,
        );
        const restored = drag.column === 'left' ? pair.first : pair.second;
        drag.handle.setAttribute('aria-valuenow', String(restored));
        drag.handle.setAttribute('aria-valuetext', `${restored}% of context space`);
      } else {
        const restored = resolveFor(drag.restoreSettings)[drag.column];
        const automatic = drag.restoreSettings[drag.column] === 'auto';
        drag.handle.setAttribute('aria-valuenow', String(restored));
        drag.handle.setAttribute(
          'aria-valuetext',
          `${restored} characters${automatic ? ', automatic' : ''}`,
        );
      }
    },
    create: (event, column) => {
      const heading = event.currentTarget.parentElement;
      if (!heading) return null;
      if (!(chPx > 0)) return null;
      const leftPx = leftHeadingRef.current?.getBoundingClientRect().width ?? 0;
      const rightPx = rightHeadingRef.current?.getBoundingClientRect().width ?? 0;
      const startWidth = column === 'left'
        ? Math.max(0, leftPx / chPx - MATCHES_COLUMN_PADDING_CH)
        : column === 'right'
          ? Math.max(0, rightPx / chPx - MATCHES_COLUMN_PADDING_CH)
          : displayedColumns[column];
      return {
        column,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        restoreSettings: columns,
        startLeftPx: leftPx,
        startRightPx: rightPx,
        chPx,
        handle: event.currentTarget,
        currentWidth: startWidth,
        currentSettings: columns,
        moved: false,
      };
    },
    preview: (drag, event) => {
      const delta = event.clientX - drag.startClientX;
      if (drag.column === 'left' || drag.column === 'right') {
        const total = drag.startLeftPx + drag.startRightPx;
        if (!(total > 2)) return;
        const selected = drag.column === 'left' ? drag.startLeftPx : drag.startRightPx;
        const target = Math.max(1, Math.min(total - 1, selected + delta));
        const pair = drag.column === 'left'
          ? proportionalPairFromPixels(target, total - target)
          : proportionalPairFromPixels(total - target, target);
        drag.currentSettings = {
          ...drag.restoreSettings,
          left: pair.first,
          right: pair.second,
        };
        drag.currentWidth = drag.column === 'left' ? pair.first : pair.second;
        event.currentTarget.setAttribute('aria-valuenow', String(drag.currentWidth));
        event.currentTarget.setAttribute('aria-valuetext', `${drag.currentWidth}% of context space`);
      } else {
        const next = matchesColumnWidthFromDrag(
          drag.column,
          drag.startWidth,
          delta,
          drag.chPx,
        );
        if (next === drag.currentWidth) return;
        drag.currentWidth = next;
        drag.currentSettings = { ...drag.restoreSettings, [drag.column]: next };
        event.currentTarget.setAttribute('aria-valuenow', String(next));
        event.currentTarget.setAttribute('aria-valuetext', `${next} characters`);
      }
      drag.moved = true;
      writeSettings(drag.currentSettings);
    },
    commit: (drag) => {
      if (drag.column === 'left' || drag.column === 'right') {
        setContextWeights(drag.currentSettings.left, drag.currentSettings.right);
        announce(`${drag.column} context share ${drag.currentWidth}%`);
      } else {
        setColumnWidth(drag.column, drag.currentWidth);
        announce(`${drag.column} column width ${drag.currentWidth} characters`);
      }
    },
  });

  const onColumnKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    column: MatchesColumn,
  ) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (cancelActiveColumnDrag()) announce('Column resize cancelled');
      else {
        setColumnsAdjustable(false);
        announce('Column widths locked');
        scheduleFocus(() => adjustButtonRef.current?.focus({ preventScroll: true }));
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (column === 'left' || column === 'right') setContextWeights(1, 1);
      else resetColumn(column);
      announce(`${column} column reset`);
      return;
    }
    if (column === 'left' || column === 'right') {
      const pair = proportionalPairFromPixels(columns.left, columns.right);
      const current = column === 'left' ? pair.first : pair.second;
      const next = matchesColumnWidthFromKey(
        column,
        current,
        event.key,
        event.shiftKey,
      );
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      setContextWeights(
        column === 'left' ? next : 100 - next,
        column === 'right' ? next : 100 - next,
      );
      announce(`${column} context share ${next}%`);
      return;
    }
    const next = matchesColumnWidthFromKey(
      column,
      displayedColumns[column],
      event.key,
      event.shiftKey,
    );
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setColumnWidth(column, next);
    announce(`${column} column width ${next} characters`);
  };

  const toggleColumnsAdjustable = () => {
    const next = !columnsAdjustable;
    if (!next) cancelActiveColumnDrag();
    setColumnsAdjustable(next);
    announce(next ? 'Column widths adjustable' : 'Column widths locked');
    if (next) {
      scheduleFocus(() => {
        portRef.current?.querySelector<HTMLElement>('.kwic-column-resizer')
          ?.focus({ preventScroll: true });
      });
    }
  };

  const resetColumnWidths = () => {
    cancelActiveColumnDrag();
    resetColumns();
    announce('Column widths reset');
  };

  return {
    leftHeadingRef,
    rightHeadingRef,
    adjustButtonRef,
    columnsAdjustable,
    beginColumnDrag,
    moveColumnDrag,
    endColumnDrag,
    cancelColumnDrag,
    onColumnKeyDown,
    toggleColumnsAdjustable,
    resetColumnWidths,
  };
}
