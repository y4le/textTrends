import {
  Fragment,
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
import {
  FREQUENCY_FILTER_MAX_UNITS,
  type FrequencyListRowV1,
} from '@texttrends/core';
import { useDisplayPreference, usePresentation } from '../PresentationProvider.tsx';
import { DENSITY_METRICS } from '../../lib/display-preference.ts';
import {
  firstFullyVisibleFrequencyRow,
  frequencyRowTop,
} from '../../lib/frequency-scroll.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  frequencyMeasure,
  frequencyFilterError,
  vocabularyRowControlId,
  vocabularyTarget,
  vocabularyTargetIsStale,
  type VocabularyTarget,
} from '../../lib/vocabulary-view.ts';
import { useApp } from '../../lib/store-instance.ts';
import { useRowNavigation } from '../useRowNavigation.ts';
import { formatRate } from '../../lib/rate-format.ts';
import {
  DataGridColumnToolbar,
  DataGridHeader,
  ColumnResizeHandle,
  type DataGridColumn,
} from '../data-grid/DataGridHeader.tsx';
import {
  isDefaultVocabularyColumns,
  resetVocabularyColumnBoundary,
  vocabularyColumnBoundaryFromDrag,
  vocabularyColumnBoundaryFromKey,
  vocabularyGridTemplate,
  VOCABULARY_COLUMNS,
  VOCABULARY_COLUMN_DEFAULTS,
  type VocabularyColumn,
  type VocabularyColumnSettings,
} from '../../lib/vocabulary-columns.ts';
import {
  loadVocabularyColumnSettings,
  saveVocabularyColumnSettings,
  vocabularySessionStorage,
} from '../../lib/vocabulary-column-storage.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? 'unavailable' : decimal.format(input);

const SORTS = [
  { by: 'key', label: 'term' },
  { by: 'count', label: 'count' },
  { by: 'docFreq', label: 'docs' },
  { by: 'dp', label: 'DP' },
  { by: 'dpNorm', label: 'DPnorm' },
  { by: 'ratePer10k', label: 'rate/10k' },
] as const;

const COLUMN_EXPLANATIONS: Readonly<Partial<Record<VocabularyColumn, string>>> = Object.freeze({
  docFreq: 'Document frequency: the number of selected documents in which the term occurs at least once.',
  dp: 'Deviation of proportions (DP): how unevenly the term is distributed across selected documents. Zero is even; values nearer one are more concentrated.',
  dpNorm: 'Normalized DP adjusts deviation of proportions for the smallest selected document share, making results from unequal document sizes easier to compare.',
  ratePer10k: 'Occurrences per 10,000 selected tokens in the enabled lexical and numeral classes whose terms contain a Unicode letter or number.',
});
const vocabularyColumnLabel = (column: VocabularyColumn) =>
  SORTS.find((candidate) => candidate.by === column)?.label ?? column;

interface FrequencyColumnDrag {
  readonly column: VocabularyColumn;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startFirstPx: number;
  readonly startSecondPx: number;
  readonly restoreSettings: VocabularyColumnSettings;
  readonly handle: HTMLDivElement;
  currentSettings: VocabularyColumnSettings;
  moved: boolean;
}

type FrequencyGridStyle = CSSProperties & {
  '--frequency-template': string;
  '--frequency-row-height': string;
};

const FREQUENCY_DETAIL_HEIGHT_ESTIMATE = 220;

function FrequencyRowDetail({
  row,
  rank,
  total,
  totalTokens,
  parts,
  onAdd,
  onMatches,
  onClose,
}: {
  readonly row: FrequencyListRowV1;
  readonly rank: number;
  readonly total: number;
  readonly totalTokens: number;
  readonly parts: number;
  readonly onAdd: () => void;
  readonly onMatches: () => void;
  readonly onClose: () => void;
}) {
  const documentCoverage = parts > 0 ? row.docFreq / parts : 0;
  const corpusShare = totalTokens > 0 ? row.count / totalTokens : 0;
  const oneEvery = row.count > 0 ? totalTokens / row.count : null;
  const meanWhenPresent = row.docFreq > 0 ? row.count / row.docFreq : null;
  return (
    <section
      id={`vocabulary-detail-${row.typeId}`}
      className="frequency-row-detail"
      aria-label={`Vocabulary detail: ${row.key}`}
    >
      <dl className="frequency-row-stats">
        <div><dt>filtered rank</dt><dd className="selectable-stat">{number.format(rank)} / {number.format(total)}</dd></div>
        <div><dt>occurrences</dt><dd className="selectable-stat">{number.format(row.count)}</dd></div>
        <div><dt>corpus share</dt><dd className="selectable-stat">{percent.format(corpusShare)}</dd></div>
        <div><dt>token interval</dt><dd className="selectable-stat">{oneEvery === null ? 'unavailable' : `1 in ${decimal.format(oneEvery)}`}</dd></div>
        <div><dt>document coverage</dt><dd className="selectable-stat">{number.format(row.docFreq)} / {number.format(parts)} · {percent.format(documentCoverage)}</dd></div>
        <div><dt>mean where present</dt><dd className="selectable-stat">{meanWhenPresent === null ? 'unavailable' : decimal.format(meanWhenPresent)}</dd></div>
        <div><dt>rate / 10k</dt><dd className="selectable-stat">{formatRate(row.ratePer10k)}</dd></div>
        <div><dt>DP</dt><dd className="selectable-stat">{value(row.dp)}</dd></div>
        <div><dt>DPnorm</dt><dd className="selectable-stat">{value(row.dpNorm)}</dd></div>
        <div><dt>token class</dt><dd>{row.class}</dd></div>
      </dl>
      <footer className="frequency-row-footer">
        <p className="frequency-row-note">
          Coverage and per-document mean use the selected documents as parts.
        </p>
        <div className="frequency-row-actions">
          <button
            type="button"
            onClick={onAdd}
            title="Add this exact, case-sensitive term"
          >
            add exact
          </button>
          <button
            type="button"
            onClick={onMatches}
            title="Show exact, case-sensitive matches for this term"
          >
            matches
          </button>
          <button type="button" onClick={onClose}>close</button>
        </div>
      </footer>
    </section>
  );
}

export function FrequencyTable({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const presentation = usePresentation();
  const displayPreference = useDisplayPreference();
  const compact = presentation.width === 'compact';
  const densityMetrics = DENSITY_METRICS[displayPreference.density];
  const rowHeight = compact
    ? densityMetrics.frequencyCompactRowHeight
    : densityMetrics.frequencyRowHeight;
  const state = useApp((store) => store.frequency);
  const snapshot = useApp((store) => store.snapshot);
  const view = useApp((store) => store.frequencyView);
  const layers = useApp((store) => store.layers);
  const setSort = useApp((store) => store.setFrequencySort);
  const setFrequencyFilter = useApp((store) => store.setFrequencyFilter);
  const loadMore = useApp((store) => store.loadMoreFrequency);
  const addTerm = useApp((store) => store.addTerm);
  const showInKwic = useApp((store) => store.showFrequencyTermInKwic);
  const pushLayer = useApp((store) => store.pushLayer);
  const replaceLayer = useApp((store) => store.replaceLayer);
  const popLayer = useApp((store) => store.popLayer);
  const [filterDraft, setFilterDraft] = useState(() => ({
    mode: view.filter?.mode ?? 'literal' as const,
    query: view.filter?.query ?? '',
  }));
  const [columns, setColumns] = useState<VocabularyColumnSettings>(() =>
    loadVocabularyColumnSettings(vocabularySessionStorage(window))
      ?? VOCABULARY_COLUMN_DEFAULTS);
  const [columnsAdjustable, setColumnsAdjustable] = useState(false);
  const [columnAnnouncement, setColumnAnnouncement] = useState('');
  const [tableViewport, setTableViewport] = useState({
    scrollTop: 0,
    height: 0,
    headerHeight: 0,
  });
  const [detailHeight, setDetailHeight] = useState(FREQUENCY_DETAIL_HEIGHT_ESTIMATE);
  const portRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const detailRowRef = useRef<HTMLTableRowElement | null>(null);
  const adjustButtonRef = useRef<HTMLButtonElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const refocusFilterAfterModeChangeRef = useRef(false);
  const columnDragRef = useRef<FrequencyColumnDrag | null>(null);
  const initialNavigationClaimedRef = useRef(false);
  const previousRowHeightRef = useRef(rowHeight);
  const topLayer = layers.at(-1);
  const renderedLayer = useMemo(
    () => renderedRowDetailLayer(layers),
    [layers],
  );
  const target = useMemo(
    () => renderedLayer
      ? vocabularyTarget(renderedLayer.target)
      : null,
    [renderedLayer],
  );
  const rowTarget = target;
  const stalePopRequested = useRef(false);

  const cancelActiveColumnDrag = useCallback(() => {
    const drag = columnDragRef.current;
    if (!drag) return false;
    columnDragRef.current = null;
    setColumns(drag.restoreSettings);
    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Synthetic PointerEvents do not always establish native capture.
    }
    return true;
  }, []);

  const beginColumnDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    column: VocabularyColumn,
  ) => {
    if (!columnsAdjustable || !event.isPrimary || event.button !== 0) return;
    if (columnDragRef.current) return;
    const heading = event.currentTarget.parentElement;
    const nextHeading = heading?.nextElementSibling;
    if (!(heading instanceof HTMLElement) || !(nextHeading instanceof HTMLElement)) return;
    const firstPx = heading.getBoundingClientRect().width;
    const secondPx = nextHeading.getBoundingClientRect().width;
    if (!(firstPx + secondPx > 2)) return;
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
      startFirstPx: firstPx,
      startSecondPx: secondPx,
      restoreSettings: columns,
      handle: event.currentTarget,
      currentSettings: columns,
      moved: false,
    };
  };

  const moveColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = vocabularyColumnBoundaryFromDrag(
      drag.restoreSettings,
      drag.column,
      event.clientX - drag.startClientX,
      drag.startFirstPx,
      drag.startSecondPx,
    );
    if (next[drag.column] === drag.currentSettings[drag.column]) return;
    drag.currentSettings = next;
    drag.moved = true;
    setColumns(next);
    event.currentTarget.setAttribute('aria-valuenow', String(next[drag.column]));
    event.currentTarget.setAttribute('aria-valuetext', `${next[drag.column]}% relative width`);
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
    if (drag.moved) {
      saveVocabularyColumnSettings(
        vocabularySessionStorage(window),
        drag.currentSettings,
      );
      setColumnAnnouncement(
        `${vocabularyColumnLabel(drag.column)} column width ${drag.currentSettings[drag.column]}%`,
      );
    }
  };

  const cancelColumnDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = columnDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelActiveColumnDrag();
    setColumnAnnouncement('Column resize cancelled');
  };

  const onColumnKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    column: VocabularyColumn,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (cancelActiveColumnDrag()) setColumnAnnouncement('Column resize cancelled');
      else {
        setColumnsAdjustable(false);
        setColumnAnnouncement('Column widths locked');
        requestAnimationFrame(() => adjustButtonRef.current?.focus({ preventScroll: true }));
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      setColumns((current) => resetVocabularyColumnBoundary(current, column));
      setColumnAnnouncement(`${vocabularyColumnLabel(column)} column reset`);
      return;
    }
    const next = vocabularyColumnBoundaryFromKey(columns, column, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setColumns(next);
    setColumnAnnouncement(`${vocabularyColumnLabel(column)} column width ${next[column]}%`);
  };

  const resizeHandle = (column: VocabularyColumn, label: string) => {
    const next = VOCABULARY_COLUMNS[VOCABULARY_COLUMNS.indexOf(column) + 1];
    if (next === undefined) return null;
    return (
      <ColumnResizeHandle
        label={label}
        valueMin={1}
        valueMax={columns[column] + columns[next] - 1}
        valueNow={columns[column]}
        valueText={`${columns[column]}% relative width`}
        adjustable={columnsAdjustable}
        className="frequency-column-resizer"
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
    setColumnAnnouncement(next ? 'Column widths adjustable' : 'Column widths locked');
    if (next) {
      requestAnimationFrame(() => {
        portRef.current?.querySelector<HTMLElement>('.frequency-column-resizer')
          ?.focus({ preventScroll: true });
      });
    }
  };

  const resetColumnWidths = () => {
    cancelActiveColumnDrag();
    setColumns(VOCABULARY_COLUMN_DEFAULTS);
    setColumnAnnouncement('Column widths reset');
  };

  useEffect(() => {
    setFilterDraft((current) => ({
      mode: view.filter?.mode ?? current.mode,
      query: view.filter?.query ?? '',
    }));
  }, [view.filter]);

  const filterError = frequencyFilterError(filterDraft.mode, filterDraft.query);
  useEffect(() => {
    if (filterError !== null) return undefined;
    const normalized = filterDraft.query.normalize('NFC');
    const next = normalized === ''
      ? null
      : { mode: filterDraft.mode, query: normalized } as const;
    if (
      view.filter?.mode === next?.mode
      && view.filter?.query === next?.query
    ) return undefined;
    const timer = window.setTimeout(() => setFrequencyFilter(next), 150);
    return () => window.clearTimeout(timer);
  }, [filterDraft, filterError, setFrequencyFilter, view.filter]);

  useEffect(() => {
    if (columnDragRef.current !== null) return;
    saveVocabularyColumnSettings(vocabularySessionStorage(window), columns);
  }, [columns]);

  useEffect(() => {
    stalePopRequested.current = false;
  }, [renderedLayer?.id]);

  useEffect(() => {
    if (target === null || stalePopRequested.current) return;
    if (!vocabularyTargetIsStale(target, snapshot !== null, state)) return;
    const index = renderedLayer ? layers.indexOf(renderedLayer) : -1;
    stalePopRequested.current = popLayer(
      index < 0 ? 1 : layers.length - index,
      'place-vocabulary-heading',
    );
  }, [layers, popLayer, renderedLayer, snapshot, state, target]);

  const writeTarget = (next: VocabularyTarget, returnFocusTo: string): boolean => {
    if (
      (renderedLayer && topLayer?.id !== renderedLayer.id)
      || topLayer?.kind === 'reader'
    ) {
      return false;
    }
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      next.surface,
    );
    if (write === 'replace') replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    else pushLayer('row-detail', Object.freeze(next), returnFocusTo);
    return true;
  };
  const addAndManage = (key: string, typeId: number) => {
    const groupId = addTerm({ aliases: [key], exactMatch: true });
    if (groupId === null) return;
    const next = Object.freeze({
      surface: 'query-editor' as const,
      mode: 'manage' as const,
      groupId,
    });
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      'query-editor',
    );
    if (write === 'replace') replaceLayer('row-detail', next, vocabularyRowControlId(typeId));
    else pushLayer('row-detail', next, vocabularyRowControlId(typeId));
  };
  const openRow = (row: FrequencyListRowV1) => {
    if (rowTarget?.typeId === row.typeId && rowTarget.key === row.key) {
      if (topLayer?.id === renderedLayer?.id) popLayer();
      return;
    }
    writeTarget(
      { surface: 'vocab-row', typeId: row.typeId, key: row.key },
      vocabularyRowControlId(row.typeId),
    );
  };

  const readyResult = state?.resident
    ?? (state?.state.status === 'ready' ? state.state.result : null);
  const navigationKeys = useMemo(
    () => readyResult?.rows.map((row) => String(row.typeId)) ?? [],
    [readyResult],
  );
  const loadingMore = readyResult !== null && state?.state.status === 'pending';
  const headerHeight = tableViewport.headerHeight;
  const expandedIndex = readyResult === null || rowTarget === null
    ? -1
    : readyResult.rows.findIndex(
        (row) => row.typeId === rowTarget.typeId && row.key === rowTarget.key,
      );
  const rowTop = useCallback((index: number) => frequencyRowTop(
    index,
    rowHeight,
    expandedIndex,
    detailHeight,
  ),
  [detailHeight, expandedIndex, rowHeight]);
  const bodyHeight = (readyResult?.rows.length ?? 0) * rowHeight
    + (expandedIndex >= 0 ? detailHeight : 0);
  const bodyViewportTop = Math.max(0, tableViewport.scrollTop - headerHeight);
  const overscan = Math.max(tableViewport.height, rowHeight * 8);
  const rowIndexAtOffset = (offset: number): number => {
    if (readyResult === null || readyResult.rows.length === 0) return 0;
    let adjusted = Math.max(0, offset);
    if (expandedIndex >= 0) {
      const detailTop = (expandedIndex + 1) * rowHeight;
      if (adjusted >= detailTop && adjusted < detailTop + detailHeight) {
        return expandedIndex;
      }
      if (adjusted >= detailTop + detailHeight) adjusted -= detailHeight;
    }
    return Math.max(
      0,
      Math.min(readyResult.rows.length - 1, Math.floor(adjusted / rowHeight)),
    );
  };
  const virtualStart = readyResult === null || readyResult.rows.length === 0
    ? 0
    : rowIndexAtOffset(bodyViewportTop - overscan);
  const virtualEnd = readyResult === null || readyResult.rows.length === 0
    ? 0
    : Math.min(
        readyResult.rows.length,
        rowIndexAtOffset(bodyViewportTop + tableViewport.height + overscan) + 1,
      );
  const topSpacerHeight = rowTop(virtualStart);
  const bottomSpacerHeight = Math.max(0, bodyHeight - rowTop(virtualEnd));
  const renderedRows = readyResult?.rows.slice(virtualStart, virtualEnd) ?? [];

  const updateTableViewport = useCallback(() => {
    const port = portRef.current;
    if (port === null) return;
    setTableViewport((current) => {
      const next = {
        scrollTop: port.scrollTop,
        height: port.clientHeight,
        headerHeight: port.querySelector<HTMLElement>('.frequency-grid-header')
          ?.getBoundingClientRect().height ?? 0,
      };
      return current.scrollTop === next.scrollTop
        && current.height === next.height
        && Math.abs(current.headerHeight - next.headerHeight) < 0.01
        ? current
        : next;
    });
  }, []);
  const maybeLoadMore = useCallback(() => {
    const port = portRef.current;
    if (
      port === null
      || readyResult === null
      || state?.state.status !== 'ready'
      || readyResult.rows.length >= readyResult.total
    ) {
      return;
    }
    const preloadDistance = Math.max(port.clientHeight * 2, 400);
    if (port.scrollTop + port.clientHeight >= port.scrollHeight - preloadDistance) {
      loadMore();
    }
  }, [loadMore, readyResult, state?.state.status]);
  const onTableScroll = useCallback(() => {
    maybeLoadMore();
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateTableViewport();
    });
  }, [maybeLoadMore, updateTableViewport]);
  useLayoutEffect(() => {
    const previousRowHeight = previousRowHeightRef.current;
    previousRowHeightRef.current = rowHeight;
    if (previousRowHeight === rowHeight) return;
    const port = portRef.current;
    const rowCount = readyResult?.rows.length ?? 0;
    if (port === null || rowCount === 0) return;
    const header = port.querySelector<HTMLElement>('.frequency-grid-header');
    const stickyHeader = header === null || getComputedStyle(header).position === 'sticky';
    const anchorScrollTop = stickyHeader
      ? port.scrollTop
      : Math.max(0, port.scrollTop - tableViewport.headerHeight);
    const anchor = firstFullyVisibleFrequencyRow({
      scrollTop: anchorScrollTop,
      rowCount,
      rowHeight: previousRowHeight,
      expandedIndex,
      detailHeight,
    });
    const anchoredRowTop = frequencyRowTop(anchor, rowHeight, expandedIndex, detailHeight);
    port.scrollTop = stickyHeader
      ? anchoredRowTop
      : (header?.getBoundingClientRect().height ?? 0) + anchoredRowTop;
    updateTableViewport();
  }, [
    detailHeight,
    expandedIndex,
    readyResult?.rows.length,
    rowHeight,
    tableViewport.headerHeight,
    updateTableViewport,
  ]);
  useEffect(() => {
    maybeLoadMore();
    updateTableViewport();
    const port = portRef.current;
    if (port === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      updateTableViewport();
      maybeLoadMore();
    });
    observer.observe(port);
    return () => observer.disconnect();
  }, [maybeLoadMore, updateTableViewport]);
  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);
  useEffect(() => {
    setDetailHeight(FREQUENCY_DETAIL_HEIGHT_ESTIMATE);
  }, [compact, rowTarget?.key, rowTarget?.typeId]);
  useEffect(() => {
    const detail = detailRowRef.current;
    if (detail === null) return;
    const measure = () => {
      const next = detail.getBoundingClientRect().height;
      if (next > 0) setDetailHeight((current) => Math.abs(current - next) < 0.5 ? current : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(detail);
    return () => observer.disconnect();
  }, [expandedIndex, virtualEnd, virtualStart]);
  const revealVirtualIndex = useCallback((index: number) => {
    const port = portRef.current;
    if (port === null) return;
    const top = headerHeight + rowTop(index);
    const bottom = top + rowHeight;
    const visibleTop = port.scrollTop + headerHeight;
    const visibleBottom = port.scrollTop + port.clientHeight;
    if (top < visibleTop) port.scrollTop = Math.max(0, top - headerHeight);
    else if (bottom > visibleBottom) port.scrollTop = bottom - port.clientHeight;
    updateTableViewport();
  }, [headerHeight, rowHeight, rowTop, updateTableViewport]);
  const rowNavigation = useRowNavigation({
    keys: navigationKeys,
    label: 'Vocabulary',
    portRef,
    preferredKey: rowTarget === null ? null : String(rowTarget.typeId),
    fallbackIndex: virtualStart,
    onActivateIndex: revealVirtualIndex,
    onExit: () => {
      if (rowTarget === null || topLayer?.id !== renderedLayer?.id) return false;
      popLayer();
      return true;
    },
  });
  useEffect(() => {
    if (initialNavigationClaimedRef.current || navigationKeys.length === 0) return undefined;
    const frame = requestAnimationFrame(() => {
      if (initialNavigationClaimedRef.current) return;
      const active = document.activeElement;
      const vocabularyEntryFocus = active instanceof HTMLElement
        && (
          active.id === 'place-vocabulary-heading'
          || active.matches('[data-workbench-tab="vocabulary"]')
        );
      if (active === null || active === document.body || vocabularyEntryFocus) {
        rowNavigation.portRef.current?.focus({ preventScroll: true });
      }
      initialNavigationClaimedRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationKeys.length, rowNavigation.portRef]);
  const gridColumns: readonly DataGridColumn<VocabularyColumn>[] = SORTS.map(
    ({ by, label }) => ({
      key: by,
      label,
      className: `frequency-${by}-heading`,
      sort: view.sort.by === by
        ? (view.sort.dir === 1 ? 'ascending' : 'descending')
        : 'none',
      onSort: () => setSort(by),
      ...(COLUMN_EXPLANATIONS[by] === undefined
        ? {}
        : { explanation: COLUMN_EXPLANATIONS[by] }),
    }),
  );
  const gridStyle: FrequencyGridStyle = {
    '--frequency-template': vocabularyGridTemplate(columns),
    '--frequency-row-height': `${rowHeight}px`,
  };
  const normalizedFilterDraft = filterDraft.query.normalize('NFC');
  const filterApplied = filterError === null
    && (normalizedFilterDraft === ''
      ? view.filter === undefined
      : view.filter?.mode === filterDraft.mode
        && view.filter.query === normalizedFilterDraft);
  const filtersPending = !filterApplied || state?.state.status === 'pending';

  return (
    <section
      aria-labelledby={showHeading ? 'frequency-heading' : undefined}
      aria-label={showHeading ? undefined : 'Vocabulary frequency'}
      className="frequency-panel"
    >
      {showHeading && (
        <h2 id="frequency-heading" style={{ fontSize: 'var(--text-md)' }}>
          Vocabulary
        </h2>
      )}
      <form
        className="frequency-filter"
        role="search"
        aria-label="Filter vocabulary"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="frequency-filter-label" htmlFor="vocabulary-filter">filter</label>
        <div className="frequency-filter-control">
          <input
            ref={filterInputRef}
            id="vocabulary-filter"
            className="exact-input"
            type="search"
            value={filterDraft.query}
            maxLength={FREQUENCY_FILTER_MAX_UNITS}
            aria-invalid={filterError !== null || undefined}
            aria-describedby={filterDraft.mode === 'regex'
              ? 'vocabulary-regex-note vocabulary-filter-status'
              : 'vocabulary-filter-status'}
            placeholder={filterDraft.mode === 'regex' ? 'term pattern' : 'contains text'}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              const query = event.currentTarget.value;
              setFilterDraft((current) => ({ ...current, query }));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || filterDraft.query === '') return;
              event.preventDefault();
              setFilterDraft((current) => ({ ...current, query: '' }));
              setFrequencyFilter(null);
            }}
          />
          {filterDraft.query !== '' && (
            <button
              type="button"
              className="frequency-filter-clear"
              aria-label="Clear vocabulary filter"
              title="Clear filter"
              onClick={() => {
                setFilterDraft((current) => ({ ...current, query: '' }));
                setFrequencyFilter(null);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
        <label
          className="frequency-regex-mode"
          onPointerDown={() => {
            refocusFilterAfterModeChangeRef.current = true;
          }}
        >
          <input
            type="checkbox"
            checked={filterDraft.mode === 'regex'}
            aria-label="regex"
            aria-describedby={filterDraft.mode === 'regex' ? 'vocabulary-regex-note' : undefined}
            onKeyDown={() => {
              refocusFilterAfterModeChangeRef.current = false;
            }}
            onChange={(event) => {
              const mode = event.currentTarget.checked ? 'regex' : 'literal';
              const shouldRefocusFilter = refocusFilterAfterModeChangeRef.current;
              refocusFilterAfterModeChangeRef.current = false;
              const input = filterInputRef.current;
              const selectionStart = input?.selectionStart ?? null;
              const selectionEnd = input?.selectionEnd ?? null;
              setFilterDraft((current) => ({
                ...current,
                mode,
              }));
              if (shouldRefocusFilter) {
                requestAnimationFrame(() => {
                  input?.focus({ preventScroll: true });
                  if (selectionStart !== null && selectionEnd !== null) {
                    input?.setSelectionRange(selectionStart, selectionEnd);
                  }
                });
              }
            }}
          />
          <span>regex</span>
          {filterDraft.mode === 'regex' && (
            <small id="vocabulary-regex-note">case-sensitive</small>
          )}
        </label>
        <span
          id="vocabulary-filter-status"
          className={filterError === null ? 'visually-hidden' : 'frequency-filter-status'}
          role="status"
          aria-live="polite"
        >
          {filterError
            ?? (filtersPending
              ? 'Filtering vocabulary.'
              : `${readyResult?.total ?? 0} matching vocabulary rows.`)}
        </span>
      </form>
      {state?.state.status === 'pending' && readyResult === null && <p>ranking vocabulary…</p>}
      {state?.state.status === 'error' && (
        <p style={{ color: 'var(--accent-text)' }}>{state.state.message}</p>
      )}
      {readyResult !== null && readyResult.total === 0 && (
        <p className="frequency-empty-state">
          {filtersPending
            ? 'Filtering vocabulary…'
            : readyResult.stoplist && readyResult.stoplist.removedRows > 0
            ? `The common-word filter removed all ${readyResult.stoplist.removedRows} matching rows. Lower it to see terms.`
            : 'No vocabulary rows meet the filters.'}
        </p>
      )}
      {readyResult !== null && readyResult.total > 0 && (
        <>
          <div
            className="frequency-table-shell"
            data-columns-adjustable={columnsAdjustable || undefined}
          >
            <div
              {...rowNavigation.portProps}
              ref={rowNavigation.portRef}
              id="vocabulary-grid-port"
              className="frequency-table-port"
              role="region"
              aria-label="Scrollable Vocabulary frequency list"
              tabIndex={0}
              data-short-table={tableViewport.height < headerHeight + rowHeight || undefined}
              onScroll={onTableScroll}
            >
              <table
                id="vocabulary-grid"
                className="frequency-table"
                role="table"
                aria-label="Vocabulary frequency list"
                aria-colcount={6}
                aria-rowcount={readyResult.total + 1}
                data-loaded-rows={readyResult.rows.length}
                style={gridStyle}
              >
                <DataGridHeader
                  columns={gridColumns}
                  kind="table"
                  className="frequency-grid-header"
                  tooltipIdBase="vocabulary-column"
                  tooltipsDisabled={columnsAdjustable}
                  renderResizeHandle={(column) => resizeHandle(column.key, column.label)}
                />
                <tbody role="rowgroup">
                  {topSpacerHeight > 0 && (
                    <tr
                      className="frequency-virtual-spacer"
                      aria-hidden="true"
                      style={{ height: `${topSpacerHeight}px` }}
                    >
                      <td colSpan={6} />
                    </tr>
                  )}
                  {renderedRows.map((row, localIndex) => {
                    const index = virtualStart + localIndex;
                    const key = String(row.typeId);
                    const expanded =
                      rowTarget?.typeId === row.typeId && rowTarget.key === row.key;
                    const selected = rowNavigation.activeKey === key;
                    const measures = {
                      count: frequencyMeasure(row, 'count'),
                      docFreq: frequencyMeasure(row, 'docFreq'),
                      dp: frequencyMeasure(row, 'dp'),
                      dpNorm: frequencyMeasure(row, 'dpNorm'),
                    } as const;
                    return (
                      <Fragment key={row.typeId}>
                        <tr
                          className="frequency-primary-row"
                          role="row"
                          aria-rowindex={index + 2}
                          aria-selected={selected || undefined}
                          data-frequency-row
                          data-row-navigation-row
                          data-expanded={expanded || undefined}
                          onClick={() => openRow(row)}
                        >
                          <th
                            className="frequency-term"
                            role="rowheader"
                            aria-colindex={1}
                            scope="row"
                          >
                            <button
                              {...rowNavigation.controlProps(key)}
                              id={vocabularyRowControlId(row.typeId)}
                              type="button"
                              aria-expanded={expanded}
                              aria-controls={expanded ? `vocabulary-detail-${row.typeId}` : undefined}
                              title={row.key}
                            >
                              <span className="frequency-row-chevron" aria-hidden="true">›</span>
                              <span className="frequency-term-label">{row.key}</span>
                            </button>
                          </th>
                          <td className="frequency-count selectable-stat" role="cell" aria-colindex={2} title={measures.count.value}>
                            {measures.count.value}
                          </td>
                          <td className="frequency-docs selectable-stat" role="cell" aria-colindex={3} title={measures.docFreq.value}>
                            {measures.docFreq.value}
                          </td>
                          <td className="frequency-dp selectable-stat" role="cell" aria-colindex={4} title={measures.dp.value}>
                            {measures.dp.value}
                          </td>
                          <td className="frequency-dpnorm selectable-stat" role="cell" aria-colindex={5} title={measures.dpNorm.value}>
                            {measures.dpNorm.value}
                          </td>
                          <td className="frequency-rate selectable-stat" role="cell" aria-colindex={6} title={formatRate(row.ratePer10k)}>
                            {formatRate(row.ratePer10k)}
                          </td>
                        </tr>
                        {expanded && (
                          <tr
                            ref={detailRowRef}
                            className="frequency-detail-row"
                            role="row"
                          >
                            <td role="cell" aria-colindex={1} colSpan={6}>
                              <FrequencyRowDetail
                                row={row}
                                rank={view.page.offset + index + 1}
                                total={readyResult.total}
                                totalTokens={readyResult.totalTokens}
                                parts={readyResult.parts}
                                onAdd={() => addAndManage(row.key, row.typeId)}
                                onMatches={() => showInKwic(row.key)}
                                onClose={() => openRow(row)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {bottomSpacerHeight > 0 && (
                    <tr
                      className="frequency-virtual-spacer"
                      aria-hidden="true"
                      style={{ height: `${bottomSpacerHeight}px` }}
                    >
                      <td colSpan={6} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <DataGridColumnToolbar
              label="Vocabulary"
              controls="vocabulary-grid"
              adjustable={columnsAdjustable}
              toggleButtonRef={adjustButtonRef}
              onToggle={toggleColumnsAdjustable}
              atDefault={isDefaultVocabularyColumns(columns)}
              onReset={resetColumnWidths}
              className="frequency-column-toolbar"
            />
          </div>
          <span className="visually-hidden" role="status" aria-live="polite">
            {loadingMore
              ? `Loading more vocabulary rows; ${readyResult.rows.length} available`
              : readyResult.rows.length < readyResult.total
                ? `${readyResult.rows.length} vocabulary rows available`
                : `All ${readyResult.total} vocabulary rows available`}
          </span>
          <span className="visually-hidden" role="status" aria-live="polite">
            {rowNavigation.status}
          </span>
          <span className="visually-hidden" role="status" aria-live="polite">
            {columnAnnouncement}
          </span>
        </>
      )}
    </section>
  );
}
