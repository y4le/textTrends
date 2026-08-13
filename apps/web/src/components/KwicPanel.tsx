/**
 * Continuous, corpus-order Concordance. The native scrollbar owns one capped
 * physical plane; a bounded fixed-height row overlay stays centered on the
 * shared reading cursor.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import { fullTokenCountsForDocs } from '../lib/doc-tokens.ts';
import {
  concordanceRows,
  nodeCenterOffset,
  type ConcordanceRowVM,
} from '../lib/concordance-view.ts';
import {
  concordanceColumnWidthFromDrag,
  concordanceColumnWidthFromKey,
  CONCORDANCE_COLUMN_DEFAULTS,
  CONCORDANCE_COLUMN_LIMITS,
  CONCORDANCE_COLUMN_PADDING_CH,
  nodeVisibleScrollLeft,
  type ConcordanceColumn,
} from '../lib/concordance-columns.ts';
import {
  CONCORDANCE_ROW_HEIGHT,
  concordanceLogicalAtScroll,
  concordancePhysicalExtent,
  concordancePrefetchRank,
  concordanceScrollTop,
  concordanceTargetAtLogical,
  concordanceVisibleRanks,
  concordanceWindowSize,
  globalTokenForTarget,
  logicalForGlobalToken,
} from '../lib/concordance-scroll.ts';
import { sequenceLayoutFor } from '../lib/footer-view.ts';
import {
  ROW_NAVIGATION_SHORTCUT_IDS,
  rowNavigationShortcut,
  rowNavigationTarget,
  visibleRowPageSize,
} from '../lib/row-navigation.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import { selectionContains } from '../lib/selection.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';

const SCROLL_TOLERANCE_PX = 0.75;
const ANNOUNCEMENT_INTERVAL_MS = 250;
const ROW_ARIA_KEYS = shortcutAria(ROW_NAVIGATION_SHORTCUT_IDS);

interface SelfPublishedCursor {
  readonly doc: string;
  readonly token: number;
  readonly logical: number;
}

interface ColumnDrag {
  readonly column: ConcordanceColumn;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startWidth: number;
  readonly chPx: number;
  readonly handle: HTMLDivElement;
  currentWidth: number;
}

type ConcordanceGridStyle = CSSProperties & {
  '--kwic-left-width': string;
  '--kwic-node-width': string;
  '--kwic-right-width': string;
  '--kwic-book-width': string;
};

const COLUMN_WIDTH_PROPERTY: Readonly<Record<ConcordanceColumn, string>> = Object.freeze({
  left: '--kwic-left-width',
  node: '--kwic-node-width',
  right: '--kwic-right-width',
  book: '--kwic-book-width',
});

export function KwicPanel({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const kwic = useApp((state) => state.kwic);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const scrub = useApp((state) => state.scrub);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const series = useApp((state) => state.series);
  const view = useApp((state) => state.concordanceView);
  const requestWindow = useApp((state) => state.requestConcordanceWindow);
  const setColumnWidth = useApp((state) => state.setConcordanceColumnWidth);
  const resetColumns = useApp((state) => state.resetConcordanceColumns);
  const setScrub = useApp((state) => state.setScrub);
  const openReader = useApp((state) => state.openReader);

  const portRef = useRef<HTMLDivElement | null>(null);
  const nodeHeadingRef = useRef<HTMLDivElement | null>(null);
  const adjustButtonRef = useRef<HTMLButtonElement | null>(null);
  const columnDragRef = useRef<ColumnDrag | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef<number | null>(null);
  const logicalRef = useRef(0);
  const selfPublishedRef = useRef<SelfPublishedCursor | null>(null);
  const appliedRevealRef = useRef<object | null>(null);
  const pendingRankRef = useRef<number | null>(null);
  const identityRef = useRef('');
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementPendingRef = useRef('');
  const announcementAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [logical, setLogical] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [columnsAdjustable, setColumnsAdjustable] = useState(false);

  const seriesById = useMemo(
    () => new Map(series.map((item) => [item.id, item])),
    [series],
  );
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const labelOf = useCallback(
    (id: string) => seriesById.get(id)?.label ?? id,
    [seriesById],
  );
  const styleOf = useCallback(
    (id: string) => seriesById.get(id)?.style ?? DEFAULT_SERIES_STYLE,
    [seriesById],
  );
  const titleOf = useCallback(
    (doc: string) => titleByDoc.get(doc) ?? doc,
    [titleByDoc],
  );

  const docs = snapshot?.readyDocs ?? [];
  const tokenCounts = useMemo(
    () => fullTokenCountsForDocs(docs, { corpusTokenCounts, inventory, trends }),
    [corpusTokenCounts, docs, inventory, trends],
  );
  const layout = useMemo(() => tokenCounts === null
    ? null
    : sequenceLayoutFor(docs, (doc) => tokenCounts[docs.indexOf(doc)]),
  [docs, tokenCounts]);
  const tokenCountsByDoc = useMemo(
    () => new Map(docs.map((doc, ordinal) => [doc, tokenCounts?.[ordinal] ?? null])),
    [docs, tokenCounts],
  );
  const bookOrdinalByDoc = useMemo(
    () => new Map(docs.map((doc, ordinal) => [doc, ordinal + 1])),
    [docs],
  );

  const resident = kwic?.resident ?? null;
  const hasGrid = resident !== null && resident.total > 0;
  const total = resident?.total ?? 0;
  const readyRows = resident?.rows ?? [];
  const rows = useMemo(
    () => concordanceRows(readyRows, labelOf, styleOf, titleOf),
    [readyRows, labelOf, styleOf, titleOf],
  );
  const rankedRows = useMemo(
    () => rows.map((row, index) => ({ row, rank: (resident?.firstRank ?? 0) + index })),
    [resident?.firstRank, rows],
  );
  const rowAtRank = useCallback(
    (rank: number) => rankedRows.find((item) => item.rank === rank)?.row ?? null,
    [rankedRows],
  );

  const multipleBooks = docs.length > 1;
  const tokenPosition = useCallback((row: ConcordanceRowVM) => {
    const count = tokenCountsByDoc.get(row.doc);
    return `${(row.pos + 1).toLocaleString()} / ${count?.toLocaleString() ?? '—'}`;
  }, [tokenCountsByDoc]);
  const bookLabel = useCallback((row: ConcordanceRowVM) =>
    `(${bookOrdinalByDoc.get(row.doc) ?? '—'}) ${row.title}`,
  [bookOrdinalByDoc]);

  const announce = useCallback((text: string) => {
    announcementPendingRef.current = text;
    const elapsed = performance.now() - announcementAtRef.current;
    if (elapsed >= ANNOUNCEMENT_INTERVAL_MS && announcementTimerRef.current === null) {
      announcementAtRef.current = performance.now();
      setAnnouncement(text);
      return;
    }
    if (announcementTimerRef.current !== null) return;
    announcementTimerRef.current = setTimeout(() => {
      announcementTimerRef.current = null;
      announcementAtRef.current = performance.now();
      setAnnouncement(announcementPendingRef.current);
    }, Math.max(0, ANNOUNCEMENT_INTERVAL_MS - elapsed));
  }, []);

  const announceRank = useCallback((rank: number, target: { readonly doc: string; readonly token: number }) => {
    announce(
      `Occurrence ${(rank + 1).toLocaleString()} of ${total.toLocaleString()}, `
      + `${titleOf(target.doc)}, token ${(target.token + 1).toLocaleString()}`,
    );
  }, [announce, titleOf, total]);

  const setLogicalPosition = useCallback((next: number, moveScroll: boolean) => {
    const bounded = Math.max(0, Math.min(total, next));
    logicalRef.current = bounded;
    setLogical(bounded);
    if (!moveScroll) return;
    const port = portRef.current;
    if (!port) return;
    const top = concordanceScrollTop(bounded, total);
    if (Math.abs(port.scrollTop - top) <= SCROLL_TOLERANCE_PX) return;
    programmaticScrollRef.current = top;
    port.scrollTop = top;
  }, [total]);

  const requestRank = useCallback((rank: number, direction: -1 | 0 | 1) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const size = concordanceWindowSize(viewport.height);
    const prefetchRank = concordancePrefetchRank(
      bounded + 0.5,
      total,
      viewport.height,
      resident,
      direction,
    );
    if (prefetchRank === null) return;
    const request = kwic?.request;
    if (
      kwic?.state.status === 'pending'
      && request?.anchor.kind === 'rank'
      && request.before === size.before
      && request.after === size.after
      && prefetchRank >= request.anchor.rank - request.before
      && prefetchRank <= request.anchor.rank + request.after
    ) return;
    requestWindow({ kind: 'rank', rank: prefetchRank }, size);
  }, [kwic?.request, kwic?.state.status, requestWindow, resident, total, viewport.height]);

  const publishLogicalCursor = useCallback((nextLogical: number) => {
    const target = concordanceTargetAtLogical(nextLogical, resident);
    if (!target) return null;
    const cursor = { doc: target.doc, token: target.token };
    selfPublishedRef.current = { ...cursor, logical: nextLogical };
    if (scrub?.doc !== cursor.doc || scrub.token !== cursor.token) setScrub(cursor);
    return cursor;
  }, [resident, scrub, setScrub]);

  const moveToRank = useCallback((rank: number) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const nextLogical = bounded + 0.5;
    const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
    pendingRankRef.current = rowAtRank(bounded) ? null : bounded;
    setLogicalPosition(nextLogical, true);
    const target = publishLogicalCursor(nextLogical);
    if (target) announceRank(bounded, target);
    requestRank(bounded, direction);
  }, [announceRank, publishLogicalCursor, requestRank, rowAtRank, setLogicalPosition, total]);

  useLayoutEffect(() => {
    const port = portRef.current;
    if (!port || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      resizeFrameRef.current = null;
      const next = { width: port.clientWidth, height: port.clientHeight };
      setViewport((current) => current.width === next.width && current.height === next.height
        ? current
        : next);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current === null) resizeFrameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(port);
    measure();
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [hasGrid]);

  useEffect(() => {
    const identity = kwic ? `${kwic.snapshot}\u001f${kwic.trackKey}` : '';
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    selfPublishedRef.current = null;
    appliedRevealRef.current = null;
    pendingRankRef.current = null;
    setLogicalPosition(0, true);
  }, [kwic?.snapshot, kwic?.trackKey, setLogicalPosition]);

  useEffect(() => {
    if (!layout || total <= 0 || !kwic) return;
    const size = concordanceWindowSize(viewport.height);
    const pendingRank = pendingRankRef.current;
    if (pendingRank !== null) {
      const row = rowAtRank(pendingRank);
      if (row) {
        const target = { doc: row.doc, token: row.pos };
        pendingRankRef.current = null;
        selfPublishedRef.current = { ...target, logical: pendingRank + 0.5 };
        if (scrub?.doc !== target.doc || scrub.token !== target.token) setScrub(target);
        setLogicalPosition(pendingRank + 0.5, true);
        announceRank(pendingRank, target);
        return;
      }
      // Hold the last exact scrub value only while some replacement window is
      // in flight. A settled error or superseding window that omitted this
      // rank must release the fence so authoritative scrub state can recover.
      if (kwic.state.status === 'pending') return;
      pendingRankRef.current = null;
    }

    if (resident?.revealRank !== null
      && resident?.revealRank !== undefined
      && appliedRevealRef.current !== resident) {
      appliedRevealRef.current = resident;
      setLogicalPosition(resident.revealRank + 0.5, true);
      return;
    }
    if (!scrub) {
      requestWindow({ kind: 'rank', rank: 0 }, size);
      return;
    }
    const selfPublished = selfPublishedRef.current;
    const nextLogical = selfPublished?.doc === scrub.doc && selfPublished.token === scrub.token
      ? selfPublished.logical
      : (() => {
          const globalToken = globalTokenForTarget(docs, layout, scrub);
          return globalToken === null ? logicalRef.current : logicalForGlobalToken({
            docs,
            layout,
            totalRows: total,
            globalToken,
            axis: kwic.axis,
            resident,
          });
        })();
    setLogicalPosition(nextLogical, true);
    if (selfPublished?.doc !== scrub.doc || selfPublished.token !== scrub.token) {
      requestWindow({ kind: 'position', doc: scrub.doc, token: scrub.token }, size);
    }
  }, [
    announceRank,
    docs,
    kwic,
    layout,
    requestWindow,
    resident,
    rowAtRank,
    scrub,
    setLogicalPosition,
    setScrub,
    total,
    viewport.height,
  ]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    if (announcementTimerRef.current !== null) clearTimeout(announcementTimerRef.current);
  }, []);

  const onScroll = useCallback(() => {
    const port = portRef.current;
    if (!port) return;
    const expected = programmaticScrollRef.current;
    if (expected !== null && Math.abs(port.scrollTop - expected) <= SCROLL_TOLERANCE_PX) {
      programmaticScrollRef.current = null;
      lastScrollTopRef.current = port.scrollTop;
      return;
    }
    programmaticScrollRef.current = null;
    if (Math.abs(port.scrollTop - lastScrollTopRef.current) <= SCROLL_TOLERANCE_PX) return;
    lastScrollTopRef.current = port.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const livePort = portRef.current;
      if (!livePort || total <= 0) return;
      const nextLogical = concordanceLogicalAtScroll(livePort.scrollTop, total);
      const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
      setLogicalPosition(nextLogical, false);
      const rank = Math.max(0, Math.min(total - 1, Math.floor(nextLogical)));
      const target = publishLogicalCursor(nextLogical);
      pendingRankRef.current = target === null ? rank : null;
      if (target) announceRank(rank, target);
      requestRank(rank, direction);
    });
  }, [announceRank, publishLogicalCursor, requestRank, setLogicalPosition, total]);

  const activeRank = total > 0
    ? Math.max(0, Math.min(total - 1, Math.floor(logical)))
    : -1;
  const visible = concordanceVisibleRanks(logical, total, viewport.height);
  const renderedRows = rankedRows.filter(({ rank }) =>
    (rank >= visible.start && rank < visible.end) || rank === activeRank);
  const activeRowRendered = renderedRows.some(({ rank }) => rank === activeRank);
  const physicalTop = concordanceScrollTop(logical, total);
  const planeHeight = concordancePhysicalExtent(total) + viewport.height;

  const readerId = (row: ConcordanceRowVM) =>
    `kwic-reader-${encodeURIComponent(row.key)}`;
  const rowId = (rank: number) => `concordance-row-${rank}`;
  const openRowReader = (row: ConcordanceRowVM, rank: number) => {
    if (!kwic) return;
    moveToRank(rank);
    openReader(
      { snapshot: kwic.snapshot, doc: row.doc, token: row.pos, from: 'kwic' },
      'concordance-grid',
    );
  };

  const recenter = useCallback(() => {
    const port = portRef.current;
    const node = nodeHeadingRef.current;
    if (!port || !node) return;
    const portRect = port.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeLeftInContent = nodeRect.left - portRect.left + port.scrollLeft;
    port.scrollLeft = nodeCenterOffset(port.clientWidth, nodeLeftInContent, nodeRect.width);
  }, []);

  const ensureNodeVisible = useCallback(() => {
    const port = portRef.current;
    const node = nodeHeadingRef.current;
    if (!port || !node) return;
    const portRect = port.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeLeftInContent = nodeRect.left - portRect.left + port.scrollLeft;
    port.scrollLeft = nodeVisibleScrollLeft(
      port.clientWidth,
      port.scrollLeft,
      port.scrollWidth - port.clientWidth,
      nodeLeftInContent,
      nodeRect.width,
    );
  }, []);

  useLayoutEffect(() => {
    recenter();
  }, [hasGrid, multipleBooks, recenter]);

  const gridStyle: ConcordanceGridStyle = {
    '--kwic-left-width': `${view.columns.left}ch`,
    '--kwic-node-width': `${view.columns.node}ch`,
    '--kwic-right-width': `${view.columns.right}ch`,
    '--kwic-book-width': `${view.columns.book}ch`,
  };
  const columnsAtDefault = (Object.keys(CONCORDANCE_COLUMN_DEFAULTS) as ConcordanceColumn[])
    .every((column) => view.columns[column] === CONCORDANCE_COLUMN_DEFAULTS[column]);

  const writeColumnWidth = useCallback((column: ConcordanceColumn, width: number) => {
    portRef.current?.style.setProperty(COLUMN_WIDTH_PROPERTY[column], `${width}ch`);
  }, []);

  const cancelActiveColumnDrag = useCallback(() => {
    const drag = columnDragRef.current;
    if (!drag) return false;
    columnDragRef.current = null;
    writeColumnWidth(drag.column, drag.startWidth);
    drag.handle.setAttribute('aria-valuenow', String(drag.startWidth));
    drag.handle.setAttribute('aria-valuetext', `${drag.startWidth} characters`);
    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Synthetic PointerEvents do not always establish native capture.
    }
    return true;
  }, [writeColumnWidth]);

  const beginColumnDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    column: ConcordanceColumn,
  ) => {
    if (!columnsAdjustable || !event.isPrimary || event.button !== 0) {
      if (columnDragRef.current && event.pointerId !== columnDragRef.current.pointerId) {
        cancelActiveColumnDrag();
        announce('Column resize cancelled');
      }
      return;
    }
    if (columnDragRef.current) return;
    const heading = event.currentTarget.parentElement;
    if (!heading) return;
    const startWidth = view.columns[column];
    const trackWidth = heading.getBoundingClientRect().width;
    const chPx = trackWidth / (startWidth + CONCORDANCE_COLUMN_PADDING_CH);
    if (!(chPx > 0)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic PointerEvents do not always establish native capture.
    }
    columnDragRef.current = {
      column,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth,
      chPx,
      handle: event.currentTarget,
      currentWidth: startWidth,
    };
  };

  const moveColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = concordanceColumnWidthFromDrag(
      drag.column,
      drag.startWidth,
      event.clientX - drag.startClientX,
      drag.chPx,
    );
    if (next === drag.currentWidth) return;
    drag.currentWidth = next;
    writeColumnWidth(drag.column, next);
    event.currentTarget.setAttribute('aria-valuenow', String(next));
    event.currentTarget.setAttribute('aria-valuetext', `${next} characters`);
  };

  const endColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    columnDragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Synthetic PointerEvents do not always establish native capture.
    }
    setColumnWidth(drag.column, drag.currentWidth);
    announce(`${drag.column} column width ${drag.currentWidth} characters`);
    requestAnimationFrame(ensureNodeVisible);
  };

  const cancelColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelActiveColumnDrag();
    announce('Column resize cancelled');
  };

  const onColumnKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    column: ConcordanceColumn,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (cancelActiveColumnDrag()) announce('Column resize cancelled');
      else {
        setColumnsAdjustable(false);
        announce('Column widths locked');
        requestAnimationFrame(() => adjustButtonRef.current?.focus({ preventScroll: true }));
      }
      return;
    }
    const next = concordanceColumnWidthFromKey(
      column,
      view.columns[column],
      event.key,
      event.shiftKey,
    );
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setColumnWidth(column, next);
    announce(`${column} column width ${next} characters`);
    requestAnimationFrame(ensureNodeVisible);
  };

  const resizeHandle = (column: ConcordanceColumn, label: string) => {
    const limits = CONCORDANCE_COLUMN_LIMITS[column];
    const width = view.columns[column];
    return (
      <div
        className="kwic-column-resizer"
        role="separator"
        aria-label={`${label} width`}
        aria-orientation="vertical"
        aria-valuemin={limits.min}
        aria-valuemax={limits.max}
        aria-valuenow={width}
        aria-valuetext={`${width} characters`}
        tabIndex={columnsAdjustable ? 0 : -1}
        onKeyDown={(event) => onColumnKeyDown(event, column)}
        onPointerDown={(event) => beginColumnDrag(event, column)}
        onPointerMove={moveColumnDrag}
        onPointerUp={endColumnDrag}
        onPointerCancel={cancelColumnDrag}
        onLostPointerCapture={cancelColumnDrag}
      />
    );
  };

  const toggleColumnsAdjustable = () => {
    const next = !columnsAdjustable;
    if (!next) cancelActiveColumnDrag();
    setColumnsAdjustable(next);
    announce(next ? 'Column widths adjustable' : 'Column widths locked');
    if (next) {
      requestAnimationFrame(() => {
        portRef.current?.querySelector<HTMLElement>('.kwic-column-resizer')
          ?.focus({ preventScroll: true });
      });
    }
  };

  const resetColumnWidths = () => {
    cancelActiveColumnDrag();
    resetColumns();
    announce('Column widths reset');
    requestAnimationFrame(recenter);
  };

  useEffect(() => () => {
    cancelActiveColumnDrag();
  }, [cancelActiveColumnDrag]);

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shortcutMatches(event, 'row-open')) {
      const row = rowAtRank(activeRank);
      if (row) {
        event.preventDefault();
        openRowReader(row, activeRank);
      }
      return;
    }
    const shortcut = rowNavigationShortcut(event);
    if (shortcut === null) return;
    event.preventDefault();
    if (shortcut === 'row-exit') {
      event.currentTarget.blur();
      announce('Concordance row navigation paused');
      return;
    }
    const pageSize = visibleRowPageSize(
      event.currentTarget.clientHeight,
      window.innerHeight,
      CONCORDANCE_ROW_HEIGHT,
    );
    const target = rowNavigationTarget(total, activeRank, shortcut, pageSize);
    if (target >= 0) moveToRank(target);
  };

  const status = kwic?.state.status ?? 'pending';
  let body: React.ReactNode;
  if (series.length === 0) {
    body = <p className="kwic-message">No terms shown in analysis.</p>;
  } else if (status === 'error' && resident === null) {
    const message = kwic?.state.status === 'error' ? kwic.state.message : 'unknown error';
    body = <p className="kwic-message kwic-error">concordance failed: {message}</p>;
  } else if (status === 'pending' && resident === null) {
    body = (
      <div aria-hidden="true" className="kwic-skeleton">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} style={{ maxWidth: `${70 - index * 4}%` }} />
        ))}
      </div>
    );
  } else if (resident && total === 0) {
    body = <p className="kwic-message">No occurrences of the enabled terms.</p>;
  } else {
    body = (
      <div
        className="kwic-grid-shell"
        data-columns-adjustable={columnsAdjustable || undefined}
      >
        <div
          ref={portRef}
          id="concordance-grid"
          className="kwic-virtual-grid horizontal-data-port"
          role="grid"
          tabIndex={0}
          aria-label="Concordance"
          aria-rowcount={total + 1}
          aria-activedescendant={activeRowRendered ? rowId(activeRank) : undefined}
          aria-keyshortcuts={ROW_ARIA_KEYS}
          data-logical-position={logical.toFixed(3)}
          data-multiple-books={multipleBooks || undefined}
          style={gridStyle}
          onScroll={onScroll}
          onKeyDown={onGridKeyDown}
        >
          <div className="kwic-grid-header" role="row">
            <div className="kwic-left-heading" role="columnheader">
              <span className="kwic-column-heading-label">left context</span>
              {resizeHandle('left', 'Left context')}
            </div>
            <div ref={nodeHeadingRef} className="kwic-node-heading" role="columnheader">
              <span className="kwic-column-heading-label">node</span>
              {resizeHandle('node', 'Node')}
            </div>
            <div className="kwic-right-heading" role="columnheader">
              <span className="kwic-column-heading-label">right context</span>
              {resizeHandle('right', 'Right context')}
            </div>
            {multipleBooks && (
              <div className="kwic-book-heading" role="columnheader">
                <span className="kwic-column-heading-label">book</span>
                {resizeHandle('book', 'Book')}
              </div>
            )}
            <div className="kwic-token-heading" role="columnheader">
              <span className="kwic-column-heading-label">token</span>
            </div>
          </div>
          <div
            className="kwic-scroll-plane"
            role="rowgroup"
            style={{ height: `${Math.max(1, planeHeight)}px` }}
          >
            {renderedRows.map(({ row, rank }) => {
              const top = physicalTop
                + viewport.height / 2
                + (rank + 0.5 - logical) * CONCORDANCE_ROW_HEIGHT
                - CONCORDANCE_ROW_HEIGHT / 2;
              return (
                <div
                  key={row.key}
                  id={rowId(rank)}
                  className="kwic-virtual-row"
                  role="row"
                  aria-rowindex={rank + 2}
                  aria-selected={rank === activeRank || undefined}
                  data-series-label={row.label}
                  data-concordance-rank={rank}
                  data-linked-selection={selectionContains(linkedSelection, row.doc, row.pos) || undefined}
                  style={{ transform: `translate3d(0, ${top}px, 0)` }}
                  onPointerDown={(event) => {
                    if ((event.target as Element).closest('button, .source-text')) return;
                    portRef.current?.focus({ preventScroll: true });
                    moveToRank(rank);
                  }}
                >
                  <div className="kwic-left-context source-text" role="gridcell">
                    <span>{row.leftFull}</span>
                  </div>
                  <div className="kwic-node source-text" role="gridcell">
                    <button
                      id={readerId(row)}
                      type="button"
                      tabIndex={-1}
                      onClick={() => openRowReader(row, rank)}
                      title="Open this occurrence in the reader"
                      style={{ color: seriesColor(row.style) }}
                    >
                      {row.nodeText}
                    </button>
                  </div>
                  <div className="kwic-right-context source-text" role="gridcell">
                    <span>{row.rightFull}</span>
                  </div>
                  {multipleBooks && (
                    <div className="kwic-book" role="gridcell" title={bookLabel(row)}>
                      <span className="kwic-book-content">{bookLabel(row)}</span>
                    </div>
                  )}
                  <div className="kwic-token" role="gridcell" title={tokenPosition(row)}>
                    <span className="kwic-token-position">{tokenPosition(row)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="kwic-column-toolbar" role="toolbar" aria-label="Concordance columns">
          {columnsAdjustable && (
            <button
              key="reset-columns"
              type="button"
              aria-label="Reset column widths"
              title="Reset column widths"
              disabled={columnsAtDefault}
              onClick={resetColumnWidths}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M16 7a7 7 0 1 0 1 6M16 3v4h-4" />
              </svg>
            </button>
          )}
          <button
            key="toggle-columns"
            ref={adjustButtonRef}
            type="button"
            aria-controls="concordance-grid"
            aria-label={columnsAdjustable ? 'Lock column widths' : 'Adjust column widths'}
            aria-pressed={columnsAdjustable}
            title={columnsAdjustable ? 'Lock column widths' : 'Adjust column widths'}
            onClick={toggleColumnsAdjustable}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 3v14M8 3v14M13 3v14M18 3v14" />
              <path d={columnsAdjustable ? 'M1 6h4M6 13h4M11 8h4M16 11h3' : 'M1 9h4M6 6h4M11 11h4M16 7h3'} />
            </svg>
          </button>
        </div>
        <div
          className="kwic-now-line"
          aria-hidden="true"
          style={{ insetBlockStart: `${viewport.height / 2}px` }}
        />
      </div>
    );
  }

  return (
    <section
      aria-labelledby={showHeading ? 'concordance-heading' : undefined}
      aria-label={showHeading ? undefined : 'Concordance results'}
      className="kwic-panel"
    >
      {showHeading && <h2 id="concordance-heading">Concordance</h2>}
      {body}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
