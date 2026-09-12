/**
 * Continuous, corpus-order Matches. The native scrollbar owns one capped
 * physical plane; a bounded fixed-height row overlay follows the shared
 * reading cursor near the leading edge of roomy viewports.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import { findScope } from '../lib/interaction.ts';
import { fullTokenCountsForDocs } from '../lib/doc-tokens.ts';
import {
  matchesRows,
  type MatchesContextPart,
  type MatchesRowVM,
} from '../lib/matches-view.ts';
import {
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
import { matchesWindowSize, globalTokenForTarget } from '../lib/matches-scroll.ts';
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
import { useMatchesScroll } from './matches/useMatchesScroll.ts';
import { useMatchesColumnResize } from './matches/useMatchesColumnResize.ts';

const CONTEXT_ESCALATION_DELAY_MS = 250;
const ROW_ARIA_KEYS = shortcutAria(ROW_NAVIGATION_SHORTCUT_IDS);

function tokenDistance(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'token' : 'tokens'}`;
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

  const nodeHeadingRef = useRef<HTMLDivElement | null>(null);

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

  const {
    portRef, chRulerRef, viewport, anchor, logical, activeRank, visible,
    physicalTop, physicalExtent, planeHeight, announcement, announce,
    onScroll, moveToRank,
  } = useMatchesScroll({
    kwic, docs, layout, scrub, rowHeight, currentContextTokens,
    rowAtRank, titleOf, requestWindow, setScrub,
  });

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

  const renderedRows = rankedRows.filter(({ rank }) =>
    (rank >= visible.start && rank < visible.end) || rank === activeRank);
  const activeRowRendered = renderedRows.some(({ rank }) => rank === activeRank);
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
    const timer = setTimeout(() => {
      requestWindow(anchor, {
        before: kwic.request?.before ?? size.before,
        after: kwic.request?.after ?? size.after,
        contextTokens: nextContextTokens,
      });
    }, CONTEXT_ESCALATION_DELAY_MS);
    return () => clearTimeout(timer);
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

  const {
    leftHeadingRef, rightHeadingRef, adjustButtonRef, columnsAdjustable,
    beginColumnDrag, moveColumnDrag, endColumnDrag, cancelColumnDrag,
    onColumnKeyDown, toggleColumnsAdjustable, resetColumnWidths,
  } = useMatchesColumnResize({
    portRef, columns: view.columns, displayedColumns, chPx: viewport.chPx,
    resolveFor, templateFor, announce, setColumnWidth, setContextWeights,
    resetColumn, resetColumns,
  });

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
                style={{ blockSize: `${anchor}px` }}
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
                  insetBlockStart: `${physicalExtent + anchor}px`,
                  blockSize: `${Math.max(0, viewport.height - anchor)}px`,
                }}
              >
                <span>{endEdgeLabel}</span>
              </div>
            )}
            {renderedRows.map(({ row, rank }) => {
              const top = physicalTop
                + anchor
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
          className="kwic-now-mark"
          aria-hidden="true"
          style={{
            insetBlockStart: `${anchor}px`,
            blockSize: `${rowHeight}px`,
            marginBlockStart: `${-rowHeight / 2}px`,
          }}
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
