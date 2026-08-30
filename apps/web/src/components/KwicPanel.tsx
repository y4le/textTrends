/**
 * Continuous, corpus-order Matches. The native scrollbar owns one capped
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
import type { ScrubIntent } from '../lib/store.ts';
import { findScope } from '../lib/interaction.ts';
import { fullTokenCountsForDocs } from '../lib/doc-tokens.ts';
import {
  matchesRows,
  type MatchesContextPart,
  type MatchesRowVM,
} from '../lib/matches-view.ts';
import {
  matchesColumnWidthFromDrag,
  matchesColumnWidthFromKey,
  matchesGridTemplate,
  matchesTokenLabel,
  MATCHES_COLUMN_LIMITS,
  MATCHES_COLUMN_PADDING_CH,
  MATCHES_CONTEXT_TOKENS,
  MATCHES_CONTEXT_TOKENS_MAX,
  isDefaultMatchesColumns,
  resolvedMatchesColumns,
  type MatchesColumn,
  type MatchesColumnSettings,
} from '../lib/matches-columns.ts';
import { proportionalPairFromPixels } from '../lib/column-layout.ts';
import {
  matchesLogicalAtScroll,
  matchesPhysicalExtent,
  matchesPrefetchRank,
  matchesScrollTop,
  matchesTargetAtLogical,
  matchesVisibleRanks,
  matchesWindowSize,
  globalTokenForTarget,
  logicalForGlobalToken,
} from '../lib/matches-scroll.ts';
import { DENSITY_METRICS } from '../lib/display-preference.ts';
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
import { widthClassFor } from '../lib/presentation.ts';
import { useDisplayPreference, usePresentation } from './PresentationProvider.tsx';
import {
  ColumnResizeHandle,
  DataGridColumnToolbar,
  DataGridHeader,
  type DataGridColumn,
} from './data-grid/DataGridHeader.tsx';
import { GuideLink } from './guide/GuideLink.tsx';

const SCROLL_TOLERANCE_PX = 0.75;
const ANNOUNCEMENT_INTERVAL_MS = 250;
const CONTEXT_ESCALATION_DELAY_MS = 250;
const ROW_ARIA_KEYS = shortcutAria(ROW_NAVIGATION_SHORTCUT_IDS);

function tokenDistance(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'token' : 'tokens'}`;
}

interface SelfPublishedCursor {
  readonly doc: string;
  readonly token: number;
  readonly logical: number;
}

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

type MatchesGridStyle = CSSProperties & {
  '--kwic-template': string;
  '--kwic-row-height': string;
};

export function KwicPanel({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const presentation = usePresentation();
  const displayPreference = useDisplayPreference();
  const rowHeight = DENSITY_METRICS[displayPreference.density].matchesRowHeight;
  const kwic = useApp((state) => state.kwic);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const scrub = useApp((state) => state.scrub);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const series = useApp((state) => state.series);
  const interaction = useApp((state) => state.interaction);
  const view = useApp((state) => state.matchesView);
  const requestWindow = useApp((state) => state.requestMatchesWindow);
  const setColumnWidth = useApp((state) => state.setMatchesColumnWidth);
  const setContextWeights = useApp((state) => state.setMatchesContextWeights);
  const resetColumn = useApp((state) => state.resetMatchesColumn);
  const resetColumns = useApp((state) => state.resetMatchesColumns);
  const setScrub = useApp((state) => state.setScrub);
  const openReader = useApp((state) => state.openReader);

  const portRef = useRef<HTMLDivElement | null>(null);
  const leftHeadingRef = useRef<HTMLDivElement | null>(null);
  const nodeHeadingRef = useRef<HTMLDivElement | null>(null);
  const rightHeadingRef = useRef<HTMLDivElement | null>(null);
  const chRulerRef = useRef<HTMLSpanElement | null>(null);
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
  const contextEscalationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementPendingRef = useRef('');
  const announcementAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const previousRowHeightRef = useRef(rowHeight);
  const [viewport, setViewport] = useState({ width: 0, height: 0, chPx: 0 });
  const [logical, setLogical] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [columnsAdjustable, setColumnsAdjustable] = useState(false);

  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const findQuery = scopedFind?.find?.query ?? null;
  const displayedSeries = useMemo(
    () => findMode
      ? findQuery === null
        ? []
        : [{ id: findQuery.seriesId, label: findQuery.label, style: findQuery.style }]
      : series,
    [findMode, findQuery, series],
  );

  const seriesById = useMemo(
    () => new Map(displayedSeries.map((item) => [item.id, item])),
    [displayedSeries],
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
  const currentContextTokens = kwic?.request?.contextTokens
    ?? resident?.contextTokens
    ?? MATCHES_CONTEXT_TOKENS;
  const hasGrid = resident !== null && resident.total > 0;
  const total = resident?.total ?? 0;
  const readyRows = resident?.rows ?? [];
  const rows = useMemo(
    () => matchesRows(readyRows, labelOf, styleOf, titleOf),
    [readyRows, labelOf, styleOf, titleOf],
  );
  const contextMentionStyle = useCallback((part: MatchesContextPart): CSSProperties | undefined => {
    const ordinal = part.trackOrdinals[0];
    if (!part.marked || ordinal === undefined) return undefined;
    const color = seriesColor(displayedSeries[ordinal]?.style ?? DEFAULT_SERIES_STYLE);
    return {
      color: 'var(--fg)',
      background: `color-mix(in srgb, ${color} 20%, transparent)`,
      borderBottom: `2px solid ${color}`,
    };
  }, [displayedSeries]);
  const rankedRows = useMemo(
    () => rows.map((row, index) => ({ row, rank: (resident?.firstRank ?? 0) + index })),
    [resident?.firstRank, rows],
  );
  const rowAtRank = useCallback(
    (rank: number) => rankedRows.find((item) => item.rank === rank)?.row ?? null,
    [rankedRows],
  );

  const multipleBooks = docs.length > 1;
  const layoutWidth = viewport.width > 0 ? widthClassFor(viewport.width) : presentation.width;
  const tokenPosition = useCallback((row: MatchesRowVM) => {
    const count = tokenCountsByDoc.get(row.doc);
    return `${(row.pos + 1).toLocaleString()} / ${count?.toLocaleString() ?? '—'}`;
  }, [tokenCountsByDoc]);
  const displayedTokenPosition = useCallback(
    (row: MatchesRowVM) => matchesTokenLabel(tokenPosition(row), layoutWidth),
    [layoutWidth, tokenPosition],
  );
  const bookLabel = useCallback((row: MatchesRowVM) =>
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
    const top = matchesScrollTop(bounded, total, rowHeight);
    if (Math.abs(port.scrollTop - top) <= SCROLL_TOLERANCE_PX) return;
    port.scrollTop = top;
    // Browsers may clamp or round a requested edge coordinate. Fence the
    // value the port actually accepted so that its ensuing scroll event is
    // not mistaken for user input and allowed to rewrite an external cursor.
    programmaticScrollRef.current = port.scrollTop;
    lastScrollTopRef.current = port.scrollTop;
  }, [rowHeight, total]);

  const requestRank = useCallback((rank: number, direction: -1 | 0 | 1) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const size = matchesWindowSize(viewport.height, rowHeight);
    const prefetchRank = matchesPrefetchRank(
      bounded + 0.5,
      total,
      viewport.height,
      resident,
      direction,
      rowHeight,
    );
    if (prefetchRank === null) return;
    const request = kwic?.request;
    if (
      kwic?.state.status === 'pending'
      && request?.anchor.kind === 'rank'
      && request.before === size.before
      && request.after === size.after
      && request.contextTokens === currentContextTokens
      && prefetchRank >= request.anchor.rank - request.before
      && prefetchRank <= request.anchor.rank + request.after
    ) return;
    requestWindow(
      { kind: 'rank', rank: prefetchRank },
      { ...size, contextTokens: currentContextTokens },
    );
  }, [
    currentContextTokens,
    kwic?.request,
    kwic?.state.status,
    requestWindow,
    resident,
    rowHeight,
    total,
    viewport.height,
  ]);

  const publishLogicalCursor = useCallback((
    nextLogical: number,
    intent: ScrubIntent = { kind: 'drift', origin: 'matches' },
  ) => {
    const target = matchesTargetAtLogical(nextLogical, resident);
    if (!target) return null;
    const cursor = { doc: target.doc, token: target.token };
    selfPublishedRef.current = { ...cursor, logical: nextLogical };
    if (scrub?.doc !== cursor.doc || scrub.token !== cursor.token) {
      setScrub(cursor, intent);
    }
    return cursor;
  }, [resident, scrub, setScrub]);

  const moveToRank = useCallback((rank: number, intent?: ScrubIntent) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const nextLogical = bounded + 0.5;
    const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
    pendingRankRef.current = rowAtRank(bounded) ? null : bounded;
    setLogicalPosition(nextLogical, true);
    const target = publishLogicalCursor(nextLogical, intent);
    if (target) announceRank(bounded, target);
    requestRank(bounded, direction);
  }, [announceRank, publishLogicalCursor, requestRank, rowAtRank, setLogicalPosition, total]);

  useLayoutEffect(() => {
    const port = portRef.current;
    if (!port || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      resizeFrameRef.current = null;
      const rulerWidth = chRulerRef.current?.getBoundingClientRect().width ?? 0;
      const next = {
        width: port.clientWidth,
        height: port.clientHeight,
        chPx: rulerWidth > 0 ? rulerWidth / 10 : 0,
      };
      setViewport((current) => current.width === next.width
        && current.height === next.height
        && Math.abs(current.chPx - next.chPx) < 0.001
        ? current
        : next);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current === null) resizeFrameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(port);
    if (chRulerRef.current) observer.observe(chRulerRef.current);
    measure();
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [hasGrid]);

  useLayoutEffect(() => {
    const previous = previousRowHeightRef.current;
    previousRowHeightRef.current = rowHeight;
    if (previous === rowHeight) return;
    const port = portRef.current;
    if (port === null || total <= 0) return;
    const top = matchesScrollTop(logicalRef.current, total, rowHeight);
    port.scrollTop = top;
    programmaticScrollRef.current = port.scrollTop;
    lastScrollTopRef.current = port.scrollTop;
  }, [rowHeight, total]);

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
    const size = matchesWindowSize(viewport.height, rowHeight);
    const pendingRank = pendingRankRef.current;
    if (pendingRank !== null) {
      const row = rowAtRank(pendingRank);
      if (row) {
        const target = { doc: row.doc, token: row.pos };
        pendingRankRef.current = null;
        selfPublishedRef.current = { ...target, logical: pendingRank + 0.5 };
        if (scrub?.doc !== target.doc || scrub.token !== target.token) {
          setScrub(target, { kind: 'drift', origin: 'matches' });
        }
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
      requestWindow(
        { kind: 'rank', rank: 0 },
        { ...size, contextTokens: currentContextTokens },
      );
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
      requestWindow(
        { kind: 'position', doc: scrub.doc, token: scrub.token },
        { ...size, contextTokens: currentContextTokens },
      );
    }
  }, [
    announceRank,
    currentContextTokens,
    docs,
    kwic,
    layout,
    requestWindow,
    resident,
    rowAtRank,
    rowHeight,
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
    if (contextEscalationTimerRef.current !== null) {
      clearTimeout(contextEscalationTimerRef.current);
    }
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
      const nextLogical = matchesLogicalAtScroll(livePort.scrollTop, total, rowHeight);
      const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
      setLogicalPosition(nextLogical, false);
      const rank = Math.max(0, Math.min(total - 1, Math.floor(nextLogical)));
      const target = publishLogicalCursor(nextLogical);
      pendingRankRef.current = target === null ? rank : null;
      if (target) announceRank(rank, target);
      requestRank(rank, direction);
    });
  }, [announceRank, publishLogicalCursor, requestRank, rowHeight, setLogicalPosition, total]);

  const activeRank = total > 0
    ? Math.max(0, Math.min(total - 1, Math.floor(logical)))
    : -1;
  const visible = matchesVisibleRanks(logical, total, viewport.height, rowHeight);
  const renderedRows = rankedRows.filter(({ rank }) =>
    (rank >= visible.start && rank < visible.end) || rank === activeRank);
  const activeRowRendered = renderedRows.some(({ rank }) => rank === activeRank);
  const physicalTop = matchesScrollTop(logical, total, rowHeight);
  const physicalExtent = matchesPhysicalExtent(total, rowHeight);
  const planeHeight = physicalExtent + viewport.height;
  const firstRow = rowAtRank(0);
  const lastRow = rowAtRank(total - 1);
  const firstMatchToken = layout && firstRow
    ? globalTokenForTarget(docs, layout, { doc: firstRow.doc, token: firstRow.pos })
    : null;
  const lastMatchToken = layout && lastRow
    ? globalTokenForTarget(docs, layout, { doc: lastRow.doc, token: lastRow.pos })
    : null;
  const startEdgeLabel = firstMatchToken === null
    ? null
    : firstMatchToken === 0
      ? 'Corpus start · first match begins at the first token'
      : `Corpus start · ${tokenDistance(firstMatchToken)} before the first match`;
  const endDistance = layout && lastMatchToken !== null
    ? layout.totalTokens - 1 - lastMatchToken
    : null;
  const endEdgeLabel = endDistance === null
    ? null
    : endDistance === 0
      ? 'Corpus end · last match begins at the final token'
      : `Corpus end · last match begins ${tokenDistance(endDistance)} before the end`;
  const edgeDescriptionIds = [
    startEdgeLabel ? 'matches-corpus-start-description' : null,
    endEdgeLabel ? 'matches-corpus-end-description' : null,
  ].filter((id): id is string => id !== null).join(' ') || undefined;

  const readerId = (row: MatchesRowVM) =>
    `kwic-reader-${encodeURIComponent(row.key)}`;
  const rowId = (rank: number) => `matches-row-${rank}`;
  const openRowReader = (row: MatchesRowVM, rank: number) => {
    if (!kwic) return;
    moveToRank(rank, { kind: 'jump', origin: 'matches' });
    openReader(
      {
        snapshot: kwic.snapshot,
        doc: row.doc,
        token: row.pos,
        from: 'kwic',
        anchor: 'occurrence',
      },
      'matches-grid',
    );
  };

  const columnContent = useMemo(() => {
    const visibleNodes = rows.map((row) => row.nodeText);
    return {
      nodes: visibleNodes.length > 0 ? visibleNodes : displayedSeries.map((item) => item.label),
      books: docs.map((doc, index) => `(${index + 1}) ${titleByDoc.get(doc) ?? doc}`),
      tokens: [
        'token',
        ...docs.map((doc) => {
          const count = tokenCountsByDoc.get(doc);
          if (count === null || count === undefined) return '— / —';
          return `${count.toLocaleString()} / ${count.toLocaleString()}`;
        }),
      ],
    };
  }, [displayedSeries, docs, rows, titleByDoc, tokenCountsByDoc]);
  const displayedColumns = useMemo(() => resolvedMatchesColumns(
    view.columns,
    columnContent,
    layoutWidth,
  ), [columnContent, layoutWidth, view.columns]);
  const layoutOptions = useMemo(
    () => ({ book: multipleBooks }),
    [multipleBooks],
  );
  const resolveFor = useCallback((settings: MatchesColumnSettings) =>
    resolvedMatchesColumns(settings, columnContent, layoutWidth),
  [columnContent, layoutWidth]);
  const templateFor = useCallback((settings: MatchesColumnSettings): string =>
    matchesGridTemplate(resolveFor(settings), layoutOptions),
  [layoutOptions, resolveFor]);
  const gridStyle: MatchesGridStyle = {
    '--kwic-template': matchesGridTemplate(displayedColumns, layoutOptions),
    '--kwic-row-height': `${rowHeight}px`,
  };

  useEffect(() => {
    if (contextEscalationTimerRef.current !== null) {
      clearTimeout(contextEscalationTimerRef.current);
      contextEscalationTimerRef.current = null;
    }
    if (
      kwic?.state.status !== 'ready'
      || resident === null
      || resident.contextTokens !== currentContextTokens
      || currentContextTokens >= MATCHES_CONTEXT_TOKENS_MAX
    ) return undefined;
    if (!(viewport.width > 0) || !(viewport.chPx > 0)) return undefined;
    const fixed = displayedColumns.node + displayedColumns.token
      + (multipleBooks ? displayedColumns.book : 0);
    const fixedCount = 2 + Number(multipleBooks);
    const contextPoolPx = Math.max(
      0,
      viewport.width - (fixed + fixedCount * MATCHES_COLUMN_PADDING_CH) * viewport.chPx,
    );
    const totalWeight = displayedColumns.left + displayedColumns.right;
    const widestContextCells = Math.max(displayedColumns.left, displayedColumns.right)
      / totalWeight * contextPoolPx / viewport.chPx;
    const neededContextTokens = Math.ceil(widestContextCells / 2);
    if (neededContextTokens <= currentContextTokens) return undefined;
    const nextContextTokens = Math.min(
      MATCHES_CONTEXT_TOKENS_MAX,
      Math.max(currentContextTokens * 2, neededContextTokens),
    );
    const anchor = kwic.request?.anchor
      ?? { kind: 'rank' as const, rank: Math.max(0, activeRank) };
    const size = matchesWindowSize(viewport.height, rowHeight);
    contextEscalationTimerRef.current = setTimeout(() => {
      contextEscalationTimerRef.current = null;
      requestWindow(anchor, {
        before: kwic.request?.before ?? size.before,
        after: kwic.request?.after ?? size.after,
        contextTokens: nextContextTokens,
      });
    }, CONTEXT_ESCALATION_DELAY_MS);
    return () => {
      if (contextEscalationTimerRef.current !== null) {
        clearTimeout(contextEscalationTimerRef.current);
        contextEscalationTimerRef.current = null;
      }
    };
  }, [
    activeRank,
    currentContextTokens,
    displayedColumns,
    kwic?.request,
    kwic?.state.status,
    multipleBooks,
    requestWindow,
    resident,
    rowHeight,
    viewport.chPx,
    viewport.height,
    viewport.width,
  ]);
  const columnsAtDefault = isDefaultMatchesColumns(view.columns);

  const writeSettings = useCallback((settings: MatchesColumnSettings) => {
    portRef.current?.style.setProperty('--kwic-template', templateFor(settings));
  }, [templateFor]);

  const cancelActiveColumnDrag = useCallback(() => {
    const drag = columnDragRef.current;
    if (!drag) return false;
    columnDragRef.current = null;
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
    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Synthetic PointerEvents do not always establish native capture.
    }
    return true;
  }, [resolveFor, writeSettings]);

  const beginColumnDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    column: MatchesColumn,
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
    const chPx = viewport.chPx;
    if (!(chPx > 0)) return;
    const leftPx = leftHeadingRef.current?.getBoundingClientRect().width ?? 0;
    const rightPx = rightHeadingRef.current?.getBoundingClientRect().width ?? 0;
    const startWidth = column === 'left'
      ? Math.max(0, leftPx / chPx - MATCHES_COLUMN_PADDING_CH)
      : column === 'right'
        ? Math.max(0, rightPx / chPx - MATCHES_COLUMN_PADDING_CH)
        : displayedColumns[column];
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
      restoreSettings: view.columns,
      startLeftPx: leftPx,
      startRightPx: rightPx,
      chPx,
      handle: event.currentTarget,
      currentWidth: startWidth,
      currentSettings: view.columns,
      moved: false,
    };
  };

  const moveColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
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
    if (!drag.moved) return;
    if (drag.column === 'left' || drag.column === 'right') {
      setContextWeights(drag.currentSettings.left, drag.currentSettings.right);
      announce(`${drag.column} context share ${drag.currentWidth}%`);
    } else {
      setColumnWidth(drag.column, drag.currentWidth);
      announce(`${drag.column} column width ${drag.currentWidth} characters`);
    }
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
    column: MatchesColumn,
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
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (column === 'left' || column === 'right') setContextWeights(1, 1);
      else resetColumn(column);
      announce(`${column} column reset`);
      return;
    }
    if (column === 'left' || column === 'right') {
      const pair = proportionalPairFromPixels(view.columns.left, view.columns.right);
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

  const resizeHandle = (column: MatchesColumn, label: string) => {
    const context = column === 'left' || column === 'right';
    const pair = proportionalPairFromPixels(view.columns.left, view.columns.right);
    const width = context
      ? (column === 'left' ? pair.first : pair.second)
      : displayedColumns[column];
    const limits = context ? { min: 1, max: 99 } : MATCHES_COLUMN_LIMITS[column];
    const automatic = !context && view.columns[column] === 'auto';
    return (
      <ColumnResizeHandle
        label={label}
        valueMin={limits.min}
        valueMax={limits.max}
        valueNow={width}
        valueText={context
          ? `${width}% of context space`
          : `${width} characters${automatic ? ', automatic' : ''}`}
        adjustable={columnsAdjustable}
        className="kwic-column-resizer"
        onKeyDown={(event) => onColumnKeyDown(event, column)}
        onPointerDown={(event) => beginColumnDrag(event, column)}
        onPointerMove={moveColumnDrag}
        onPointerUp={endColumnDrag}
        onPointerCancel={cancelColumnDrag}
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
  };

  useEffect(() => () => {
    cancelActiveColumnDrag();
  }, [cancelActiveColumnDrag]);

  type MatchesHeaderColumn = MatchesColumn | 'token';
  const headerColumns: readonly DataGridColumn<MatchesHeaderColumn>[] = [
    {
      key: 'left',
      label: 'left context',
      className: 'kwic-left-heading',
      headingRef: leftHeadingRef,
    },
    {
      key: 'node',
      label: 'match',
      className: 'kwic-node-heading',
      headingRef: nodeHeadingRef,
      explanation: 'The matched word or phrase (the KWIC node).',
    },
    {
      key: 'right',
      label: 'right context',
      className: 'kwic-right-heading',
      headingRef: rightHeadingRef,
    },
    ...(multipleBooks
      ? [{ key: 'book' as const, label: 'text', className: 'kwic-book-heading' }]
      : []),
    {
      key: 'token',
      label: 'position',
      className: 'kwic-token-heading',
      explanation: 'Corpus position shown as token number / total tokens.',
    },
  ];

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
      announce('Match navigation paused');
      return;
    }
    const pageSize = visibleRowPageSize(
      event.currentTarget.clientHeight,
      window.innerHeight,
      rowHeight,
    );
    const target = rowNavigationTarget(total, activeRank, shortcut, pageSize);
    if (target >= 0) moveToRank(target);
  };

  const status = kwic?.state.status ?? 'pending';
  let body: React.ReactNode;
  if (displayedSeries.length === 0) {
    body = findMode
      ? <p className="kwic-message">Type a Find query.</p>
      : (
          <div className="kwic-message kwic-empty-guide">
            <p>No terms shown in analysis.</p>
            <GuideLink guideId="terms-and-notebook" place="matches">
              Guide: Terms and the notebook
            </GuideLink>
          </div>
        );
  } else if (status === 'error' && resident === null) {
    const message = kwic?.state.status === 'error' ? kwic.state.message : 'unknown error';
    body = <p className="kwic-message kwic-error">matches failed: {message}</p>;
  } else if (status === 'pending' && resident === null) {
    body = (
      <div aria-hidden="true" className="kwic-skeleton">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} style={{ maxWidth: `${70 - index * 4}%` }} />
        ))}
      </div>
    );
  } else if (resident && total === 0) {
    body = <p className="kwic-message">{findMode ? 'No occurrences of the Find query.' : 'No occurrences of the enabled terms.'}</p>;
  } else {
    body = (
      <div
        className="kwic-grid-shell"
        data-columns-adjustable={columnsAdjustable || undefined}
      >
        <span ref={chRulerRef} className="kwic-ch-ruler" aria-hidden="true">
          0000000000
        </span>
        {startEdgeLabel && (
          <span id="matches-corpus-start-description" className="visually-hidden">
            {startEdgeLabel}
          </span>
        )}
        {endEdgeLabel && (
          <span id="matches-corpus-end-description" className="visually-hidden">
            {endEdgeLabel}
          </span>
        )}
        <div
          ref={portRef}
          id="matches-grid"
          className="kwic-virtual-grid"
          role="grid"
          tabIndex={0}
          aria-label="Matches"
          aria-rowcount={total + 1}
          aria-colcount={4 + Number(multipleBooks)}
          aria-activedescendant={activeRowRendered ? rowId(activeRank) : undefined}
          aria-describedby={edgeDescriptionIds}
          aria-keyshortcuts={ROW_ARIA_KEYS}
          data-logical-position={logical.toFixed(3)}
          style={gridStyle}
          onScroll={onScroll}
          onKeyDown={onGridKeyDown}
        >
          <DataGridHeader
            columns={headerColumns}
            kind="grid"
            className="kwic-grid-header"
            tooltipIdBase="matches-column"
            tooltipsDisabled={columnsAdjustable}
            renderResizeHandle={(column) => column.key === 'token'
              ? null
              : resizeHandle(column.key, column.label)}
          />
          <div
            className="kwic-scroll-plane"
            role="rowgroup"
            style={{ height: `${Math.max(1, planeHeight)}px` }}
          >
            {startEdgeLabel && (
              <div
                className="kwic-edge-band"
                data-corpus-edge="start"
                aria-hidden="true"
                style={{ blockSize: `${viewport.height / 2}px` }}
              >
                <span>{startEdgeLabel}</span>
              </div>
            )}
            {endEdgeLabel && (
              <div
                className="kwic-edge-band"
                data-corpus-edge="end"
                aria-hidden="true"
                style={{
                  insetBlockStart: `${physicalExtent + viewport.height / 2}px`,
                  blockSize: `${viewport.height / 2}px`,
                }}
              >
                <span>{endEdgeLabel}</span>
              </div>
            )}
            {renderedRows.map(({ row, rank }) => {
              const top = physicalTop
                + viewport.height / 2
                + (rank + 0.5 - logical) * rowHeight
                - rowHeight / 2;
              return (
                <div
                  key={row.key}
                  id={rowId(rank)}
                  className="kwic-virtual-row"
                  role="row"
                  aria-rowindex={rank + 2}
                  aria-selected={rank === activeRank || undefined}
                  data-series-label={row.label}
                  data-matches-rank={rank}
                  data-linked-selection={selectionContains(linkedSelection, row.doc, row.pos) || undefined}
                  style={{ transform: `translate3d(0, ${top}px, 0)` }}
                  onPointerDown={(event) => {
                    if ((event.target as Element).closest('button, .source-text')) return;
                    portRef.current?.focus({ preventScroll: true });
                    moveToRank(rank, { kind: 'jump', origin: 'matches' });
                  }}
                >
                  <div
                    className="kwic-left-context source-text"
                    role="gridcell"
                    aria-colindex={1}
                    data-marks-truncated={row.source.leftMarksTruncated || undefined}
                  >
                    <span>{row.leftParts.map((part, index) => (
                      <span
                        key={index}
                        className={part.marked ? 'kwic-context-mention' : undefined}
                        style={contextMentionStyle(part)}
                      >
                        {part.text}
                      </span>
                    ))}</span>
                  </div>
                  <div className="kwic-node source-text" role="gridcell" aria-colindex={2}>
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
                  <div
                    className="kwic-right-context source-text"
                    role="gridcell"
                    aria-colindex={3}
                    data-marks-truncated={row.source.rightMarksTruncated || undefined}
                  >
                    <span>{row.rightParts.map((part, index) => (
                      <span
                        key={index}
                        className={part.marked ? 'kwic-context-mention' : undefined}
                        style={contextMentionStyle(part)}
                      >
                        {part.text}
                      </span>
                    ))}</span>
                  </div>
                  {multipleBooks && (
                    <div className="kwic-book" role="gridcell" aria-colindex={4} title={bookLabel(row)}>
                      <span className="kwic-book-content">{bookLabel(row)}</span>
                    </div>
                  )}
                  <div
                    className="kwic-token"
                    role="gridcell"
                    aria-colindex={4 + Number(multipleBooks)}
                    title={tokenPosition(row)}
                  >
                    <span className="kwic-token-position">{displayedTokenPosition(row)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <DataGridColumnToolbar
          label="Match"
          controls="matches-grid"
          adjustable={columnsAdjustable}
          toggleButtonRef={adjustButtonRef}
          onToggle={toggleColumnsAdjustable}
          atDefault={columnsAtDefault}
          onReset={resetColumnWidths}
          className="kwic-column-toolbar"
        />
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
      aria-labelledby={showHeading ? 'matches-heading' : undefined}
      aria-label={showHeading ? undefined : 'Match results'}
      className="kwic-panel"
    >
      {showHeading && <h2 id="matches-heading">Matches</h2>}
      {body}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
