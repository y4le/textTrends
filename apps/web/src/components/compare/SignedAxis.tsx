import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { KeynessRowV1 } from '@texttrends/core';
import {
  compareBarPercent,
  compareResidentResult,
  compareRowControlId,
  type CompareRowTarget,
  type CompareScale,
} from '../../lib/compare-view.ts';
import type {
  KeynessTableState,
  KeynessViewV1,
} from '../../lib/store.ts';
import { CompareRowDetail } from './CompareRowDetail.tsx';
import {
  useRowNavigation,
  type RowControlProps,
} from '../useRowNavigation.ts';
import { rowNavigationTarget } from '../../lib/row-navigation.ts';
import {
  COMPARE_MAX_RESIDENT_ROWS,
  COMPARE_ROW_HEIGHT_ESTIMATE,
  compareRowTop,
  compareVirtualLayout,
} from '../../lib/compare-scroll.ts';

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('en-US');
const rowNavigationKey = (side: 'a' | 'b', typeId: number) => `${side}:${typeId}`;
const COMPARE_DETAIL_HEIGHT_ESTIMATE = 320;

function readyRows(state: KeynessTableState | null): readonly KeynessRowV1[] {
  return compareResidentResult(state)?.rows ?? [];
}

function SideHalf({
  row,
  side,
  sideLabel,
  scale,
  showConfidenceIntervals,
  expanded,
  onOpen,
  navigation,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly sideLabel: string;
  readonly scale: CompareScale;
  readonly showConfidenceIntervals: boolean;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly navigation: RowControlProps;
}) {
  const width = compareBarPercent(row.logRatio, scale.maximum);
  // The whisker spans the row's 95% interval on the same axis as the bar. The
  // bar plots the effect's MAGNITUDE, so the whisker plots the magnitude range
  // the interval allows. When the interval spans zero that range starts at
  // zero — the whisker reaches back to the centre line, which is what "the
  // evidence does not settle which side favours this word" looks like.
  const spansZero = row.logRatioLow <= 0 && row.logRatioHigh >= 0;
  const farBound = Math.max(
    Math.abs(row.logRatioLow),
    Math.abs(row.logRatioHigh),
  );
  const nearBound = spansZero
    ? 0
    : Math.min(Math.abs(row.logRatioLow), Math.abs(row.logRatioHigh));
  const low = compareBarPercent(nearBound, scale.maximum);
  const high = compareBarPercent(farBound, scale.maximum);
  const barStyle = {
    '--compare-bar-width': `${width}%`,
    '--compare-interval-start': `${low}%`,
    '--compare-interval-width': `${Math.max(0, high - low)}%`,
  } as CSSProperties;
  const intervalNote = showConfidenceIntervals
    ? `, 95% interval ${decimal.format(row.logRatioLow)} to ${
        decimal.format(row.logRatioHigh)
      } log₂${spansZero ? ', consistent with no difference' : ''}`
    : '';
  return (
    <button
      {...navigation}
      id={compareRowControlId(side, row.typeId)}
      className="compare-pyramid-button"
      type="button"
      aria-label={`${row.key}, ${decimal.format(Math.abs(row.logRatio))} log₂ lift for ${sideLabel}${intervalNote}`}
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <span className="compare-pyramid-value selectable-stat">
        {decimal.format(Math.abs(row.logRatio))}
      </span>
      <span className="compare-pyramid-term" title={row.key}>{row.key}</span>
      <span className="compare-pyramid-plot" aria-hidden="true">
        <span className="compare-pyramid-bar" style={barStyle} />
        {showConfidenceIntervals && (
          <span
            className="compare-pyramid-interval"
            style={barStyle}
            data-spans-zero={spansZero || undefined}
          />
        )}
      </span>
    </button>
  );
}

function SideStatus({
  state,
  side,
}: {
  readonly state: KeynessTableState | null;
  readonly side: 'a' | 'b';
}) {
  const result = compareResidentResult(state);
  const message = !state || state.state.status === 'pending'
    ? 'ranking…'
    : state.state.status === 'error'
      ? state.state.message
      : result?.stoplist && result.stoplist.removedRows > 0
        ? `The common-word filter removed all ${result.stoplist.removedRows} matching rows. Lower it to see terms.`
        : 'No terms meet the filters.';
  return (
    <p className="compare-pyramid-status" data-error={state?.state.status === 'error' || undefined}>
      <span className="visually-hidden">Side {side.toUpperCase()}: </span>
      {message}
    </p>
  );
}

export function SignedAxis({
  stateA,
  stateB,
  view,
  scale,
  rowTarget,
  sideLabelA,
  sideLabelB,
  profileOpen,
  profileContent,
  onRow,
  onLoadMore,
  onCloseRow,
}: {
  readonly stateA: KeynessTableState | null;
  readonly stateB: KeynessTableState | null;
  readonly view: KeynessViewV1;
  readonly scale: CompareScale;
  readonly rowTarget: CompareRowTarget | null;
  readonly sideLabelA: string;
  readonly sideLabelB: string;
  readonly profileOpen: boolean;
  readonly profileContent: ReactNode;
  readonly onRow: (side: 'a' | 'b', row: KeynessRowV1) => void;
  readonly onLoadMore: (side: 'a' | 'b') => void;
  readonly onCloseRow: () => boolean;
}) {
  const rowsA = readyRows(stateA);
  const rowsB = readyRows(stateB);
  const resultA = compareResidentResult(stateA);
  const resultB = compareResidentResult(stateB);
  const loadedPairCount = Math.max(rowsA.length, rowsB.length);
  const totalPairCount = Math.max(resultA?.total ?? 0, resultB?.total ?? 0);
  const pairs = useMemo(
    () => Array.from({ length: loadedPairCount }, (_, index) => ({
      a: rowsA[index] ?? null,
      b: rowsB[index] ?? null,
    })),
    [loadedPairCount, rowsA, rowsB],
  );
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const [profileHeight, setProfileHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(COMPARE_ROW_HEIGHT_ESTIMATE);
  const [detailHeight, setDetailHeight] = useState(COMPARE_DETAIL_HEIGHT_ESTIMATE);
  const portRef = useRef<HTMLDivElement | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const measuredRowRef = useRef<HTMLTableRowElement | null>(null);
  const detailRowRef = useRef<HTMLTableRowElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const expandedIndex = rowTarget === null
    ? -1
    : (rowTarget.side === 'a' ? rowsA : rowsB).findIndex(
        (row) => row.typeId === rowTarget.typeId && row.key === rowTarget.key,
      );
  const rowTop = useCallback((index: number) => compareRowTop(
    index,
    rowHeight,
    expandedIndex,
    detailHeight,
  ), [detailHeight, expandedIndex, rowHeight]);
  const bodyViewportTop = Math.max(0, viewport.scrollTop - profileHeight);
  const overscan = Math.max(viewport.height, rowHeight * 8);
  const virtual = compareVirtualLayout({
    rowCount: loadedPairCount,
    rowHeight,
    detailIndex: expandedIndex,
    detailHeight,
    bodyViewportTop,
    viewportHeight: viewport.height,
    overscan,
  });
  const virtualStart = virtual.start;
  const virtualEnd = virtual.end;
  const renderedPairs = pairs.slice(virtualStart, virtualEnd);
  const measurementIdentity = [
    renderedPairs[0]?.a?.typeId ?? '',
    renderedPairs[0]?.b?.typeId ?? '',
  ].join(':');
  const topSpacerHeight = virtual.topSpacer;
  const bottomSpacerHeight = virtual.bottomSpacer;
  const canLoadA = resultA !== null
    && resultA.rows.length < Math.min(resultA.total, COMPARE_MAX_RESIDENT_ROWS);
  const canLoadB = resultB !== null
    && resultB.rows.length < Math.min(resultB.total, COMPARE_MAX_RESIDENT_ROWS);
  const displayLimitReached = (
    resultA !== null
    && resultA.total > COMPARE_MAX_RESIDENT_ROWS
    && resultA.rows.length >= COMPARE_MAX_RESIDENT_ROWS
  ) || (
    resultB !== null
    && resultB.total > COMPARE_MAX_RESIDENT_ROWS
    && resultB.rows.length >= COMPARE_MAX_RESIDENT_ROWS
  );
  const loadErrorA = resultA !== null
    && canLoadA
    && stateA?.state.status === 'error';
  const loadErrorB = resultB !== null
    && canLoadB
    && stateB?.state.status === 'error';
  const updateViewport = useCallback(() => {
    const port = portRef.current;
    if (port === null) return;
    setViewport((current) => {
      const next = { scrollTop: port.scrollTop, height: port.clientHeight };
      return current.scrollTop === next.scrollTop && current.height === next.height
        ? current
        : next;
    });
  }, []);
  const maybeLoadMore = useCallback(() => {
    const port = portRef.current;
    if (port === null) return;
    const preloadDistance = Math.max(port.clientHeight * 2, 400);
    if (port.scrollTop + port.clientHeight < port.scrollHeight - preloadDistance) return;
    if (
      canLoadA
      && stateA?.state.status === 'ready'
    ) onLoadMore('a');
    if (
      canLoadB
      && stateB?.state.status === 'ready'
    ) onLoadMore('b');
  }, [canLoadA, canLoadB, onLoadMore, stateA?.state.status, stateB?.state.status]);
  const onScroll = useCallback(() => {
    maybeLoadMore();
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateViewport();
    });
  }, [maybeLoadMore, updateViewport]);
  useEffect(() => {
    maybeLoadMore();
    updateViewport();
    const port = portRef.current;
    if (port === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      updateViewport();
      maybeLoadMore();
    });
    observer.observe(port);
    return () => observer.disconnect();
  }, [maybeLoadMore, updateViewport]);
  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);
  useEffect(() => {
    const profile = profileRef.current;
    if (profile === null) {
      setProfileHeight(0);
      return;
    }
    const measure = () => {
      const next = profile.getBoundingClientRect().height;
      if (next > 0) setProfileHeight(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(profile);
    return () => observer.disconnect();
  }, [profileOpen]);
  useEffect(() => {
    const row = measuredRowRef.current;
    if (row === null) return;
    const measure = () => {
      const next = row.getBoundingClientRect().height;
      if (next > 0) setRowHeight((current) =>
        Math.abs(current - next) < 0.25 ? current : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [loadedPairCount, measurementIdentity, virtualEnd, virtualStart]);
  useEffect(() => {
    setDetailHeight(COMPARE_DETAIL_HEIGHT_ESTIMATE);
  }, [rowTarget?.key, rowTarget?.typeId]);
  useEffect(() => {
    const detail = detailRowRef.current;
    if (detail === null) return;
    const measure = () => {
      const next = detail.getBoundingClientRect().height;
      if (next > 0) setDetailHeight(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(detail);
    return () => observer.disconnect();
  }, [expandedIndex, virtualEnd, virtualStart]);
  const navigationKeys = useMemo(() => pairs.flatMap(({ a, b }) => [
    ...(a ? [rowNavigationKey('a', a.typeId)] : []),
    ...(b ? [rowNavigationKey('b', b.typeId)] : []),
  ]), [pairs]);
  const revealNavigationIndex = useCallback((_: number, key: string) => {
    const port = portRef.current;
    if (port === null) return;
    const [side] = key.split(':') as ['a' | 'b'];
    const rank = (side === 'a' ? rowsA : rowsB).findIndex(
      (row) => rowNavigationKey(side, row.typeId) === key,
    );
    if (rank < 0) return;
    const top = profileHeight + rowTop(rank);
    const bottom = top + rowHeight;
    const visibleTop = port.scrollTop + profileHeight;
    const visibleBottom = port.scrollTop + port.clientHeight;
    if (top < visibleTop) port.scrollTop = Math.max(0, top - profileHeight);
    else if (bottom > visibleBottom) port.scrollTop = bottom - port.clientHeight;
    updateViewport();
    maybeLoadMore();
  }, [maybeLoadMore, profileHeight, rowHeight, rowTop, rowsA, rowsB, updateViewport]);
  const rowNavigation = useRowNavigation({
    keys: navigationKeys,
    label: 'Compare',
    portRef,
    preferredKey: rowTarget === null
      ? null
      : rowNavigationKey(rowTarget.side, rowTarget.typeId),
    onActivateIndex: revealNavigationIndex,
    onExit: onCloseRow,
    resolveTarget: ({ key, index, shortcut, pageSize }) => {
      const [side] = key.split(':') as ['a' | 'b'];
      const sideRows = side === 'a' ? rowsA : rowsB;
      const currentRow = sideRows.findIndex(
        (row) => rowNavigationKey(side, row.typeId) === key,
      );
      if (currentRow < 0) return index;
      const targetRow = rowNavigationTarget(
        sideRows.length,
        currentRow,
        shortcut,
        pageSize,
      );
      const target = sideRows[targetRow];
      return target
        ? navigationKeys.indexOf(rowNavigationKey(side, target.typeId))
        : index;
    },
    formatStatus: ({ key, boundary }) => {
      const [side] = key.split(':') as ['a' | 'b'];
      const sideRows = side === 'a' ? rowsA : rowsB;
      const rank = sideRows.findIndex(
        (row) => rowNavigationKey(side, row.typeId) === key,
      );
      if (rank < 0) return `Compare side ${side.toUpperCase()}: row unavailable`;
      if (boundary && rank === 0) return `Compare side ${side.toUpperCase()}: first row`;
      if (boundary && rank === sideRows.length - 1) {
        return `Compare side ${side.toUpperCase()}: last row`;
      }
      return `Compare side ${side.toUpperCase()}: row ${rank + 1} of ${sideRows.length}`;
    },
  });
  const navigationProps = (
    side: 'a' | 'b',
    row: KeynessRowV1,
    rank: number,
  ): RowControlProps => {
    const base = rowNavigation.controlProps(rowNavigationKey(side, row.typeId));
    return {
      ...base,
      'aria-keyshortcuts': `${base['aria-keyshortcuts']} ArrowLeft ArrowRight h l`,
      onKeyDown: (event) => {
        if (
          !event.altKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.shiftKey
          && (
            event.key === 'ArrowLeft'
            || event.key === 'ArrowRight'
            || event.key === 'h'
            || event.key === 'l'
          )
        ) {
          event.preventDefault();
          const targetSide = event.key === 'ArrowLeft' || event.key === 'h'
            ? 'a'
            : 'b';
          if (targetSide === side) return;
          const targetRow = targetSide === 'a' ? rowsA[rank] : rowsB[rank];
          if (!targetRow) return;
          const targetIndex = navigationKeys.indexOf(
            rowNavigationKey(targetSide, targetRow.typeId),
          );
          if (targetIndex >= 0) rowNavigation.activateIndex(targetIndex);
          return;
        }
        base.onKeyDown(event);
      },
    };
  };
  useEffect(() => {
    const enterFromPlace = (event: KeyboardEvent) => {
      if (event.defaultPrevented || navigationKeys.length === 0) return;
      const active = document.activeElement;
      if (
        active !== document.body
        && active !== document.getElementById('place-compare-heading')
      ) return;
      if (event.key !== 'j') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      rowNavigation.activateIndex(0);
    };
    document.addEventListener('keydown', enterFromPlace);
    return () => document.removeEventListener('keydown', enterFromPlace);
  }, [navigationKeys.length, navigationKeys[0], rowNavigation.activateIndex]);
  const retainedTarget = rowTarget !== null
    && expandedIndex < 0
    && (rowTarget.side === 'a' ? stateA : stateB)?.state.status !== 'ready';

  return (
    <section className="compare-axis-section" aria-label="Comparison rankings">
      {displayLimitReached && totalPairCount > 0 && (
        <p className="compare-rank-progress">
          Showing the first {integer.format(COMPARE_MAX_RESIDENT_ROWS)} of{' '}
          {integer.format(totalPairCount)} ranks; refine the filters for deeper
          ranks.
        </p>
      )}
      <div
        {...rowNavigation.portProps}
        ref={rowNavigation.portRef}
        className="compare-table-port"
        role="region"
        aria-label="Compare population pyramid"
        aria-busy={stateA?.state.status === 'pending' || stateB?.state.status === 'pending'}
        tabIndex={0}
        onScroll={onScroll}
      >
        {profileOpen && (
          <div ref={profileRef} className="compare-profile-dropdown">
            {profileContent}
          </div>
        )}
        <table
          className="compare-axis-table"
          role="table"
          aria-label="Compare population pyramid"
          aria-colcount={2}
          aria-rowcount={loadedPairCount === 0
            ? 1
            : Math.min(totalPairCount, COMPARE_MAX_RESIDENT_ROWS)}
          data-loaded-rows={loadedPairCount}
        >
          <caption className="visually-hidden">
            Distinctive vocabulary ranked independently on two sides. Bar length
            uses a shared scale over the loaded ranks; select either half-row for
            that word's full comparison.
          </caption>
          <tbody role="rowgroup" aria-label="Paired distinctive term ranks">
            {topSpacerHeight > 0 && (
              <tr
                className="compare-virtual-spacer"
                aria-hidden="true"
                style={{ height: `${topSpacerHeight}px` }}
              >
                <td colSpan={2} />
              </tr>
            )}
            {loadedPairCount === 0 && (
              <tr className="compare-pyramid-row" role="row" aria-rowindex={1}>
                <td className="compare-pyramid-half" data-side="a" role="cell" aria-colindex={1}>
                  <SideStatus state={stateA} side="a" />
                </td>
                <td className="compare-pyramid-half" data-side="b" role="cell" aria-colindex={2}>
                  <SideStatus state={stateB} side="b" />
                </td>
              </tr>
            )}
            {renderedPairs.map(({ a, b }, localIndex) => {
              const index = virtualStart + localIndex;
              const targetRow = rowTarget?.side === 'a' ? a : b;
              const expanded = rowTarget !== null
                && targetRow?.typeId === rowTarget.typeId
                && targetRow.key === rowTarget.key;
              return (
                <Fragment key={`${a?.typeId ?? 'empty'}:${b?.typeId ?? 'empty'}:${index}`}>
                  <tr
                    ref={localIndex === 0 ? measuredRowRef : undefined}
                    className="compare-pyramid-row"
                    role="row"
                    aria-rowindex={index + 1}
                    data-row-navigation-row
                  >
                    <td className="compare-pyramid-half" data-side="a" role="cell" aria-colindex={1}>
                      {a
                        ? (
                            <SideHalf
                              row={a}
                              side="a"
                              sideLabel={sideLabelA}
                              scale={scale}
                              showConfidenceIntervals={view.showConfidenceIntervals}
                              expanded={expanded && rowTarget?.side === 'a'}
                              onOpen={() => onRow('a', a)}
                              navigation={navigationProps('a', a, index)}
                            />
                          )
                        : index === 0 && <SideStatus state={stateA} side="a" />}
                    </td>
                    <td className="compare-pyramid-half" data-side="b" role="cell" aria-colindex={2}>
                      {b
                        ? (
                            <SideHalf
                              row={b}
                              side="b"
                              sideLabel={sideLabelB}
                              scale={scale}
                              showConfidenceIntervals={view.showConfidenceIntervals}
                              expanded={expanded && rowTarget?.side === 'b'}
                              onOpen={() => onRow('b', b)}
                              navigation={navigationProps('b', b, index)}
                            />
                          )
                        : index === 0 && <SideStatus state={stateB} side="b" />}
                    </td>
                  </tr>
                  {expanded && targetRow && rowTarget && (
                    <tr ref={detailRowRef} className="compare-detail-row" role="row">
                      <td colSpan={2} role="cell" aria-colindex={1}>
                        <CompareRowDetail
                          row={targetRow}
                          side={rowTarget.side}
                          sideLabelA={sideLabelA}
                          sideLabelB={sideLabelB}
                          totalsA={(resultA ?? resultB)?.totalsA ?? null}
                          totalsB={(resultA ?? resultB)?.totalsB ?? null}
                          view={view}
                          onClose={onCloseRow}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr
                className="compare-virtual-spacer"
                aria-hidden="true"
                style={{ height: `${bottomSpacerHeight}px` }}
              >
                <td colSpan={2} />
              </tr>
            )}
          </tbody>
        </table>
        {(loadErrorA || loadErrorB) && (
          <div className="compare-load-error" role="alert">
            <span>Couldn’t load more comparison ranks.</span>
            {loadErrorA && (
              <button type="button" onClick={() => onLoadMore('a')}>
                Retry {sideLabelA}
              </button>
            )}
            {loadErrorB && (
              <button type="button" onClick={() => onLoadMore('b')}>
                Retry {sideLabelB}
              </button>
            )}
          </div>
        )}
        {retainedTarget && rowTarget && (
          <p className="compare-row-note">
            Detail for {rowTarget.key} is retained while side{' '}
            {rowTarget.side.toUpperCase()} refreshes.
          </p>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {stateA?.state.status === 'pending' || stateB?.state.status === 'pending'
          ? `${loadedPairCount} comparison ranks available; loading more`
          : displayLimitReached
            ? `Showing the first ${COMPARE_MAX_RESIDENT_ROWS} of ${totalPairCount} comparison ranks; display limit reached`
          : loadedPairCount < totalPairCount
            ? `${loadedPairCount} of ${totalPairCount} comparison ranks available`
            : `All ${totalPairCount} comparison ranks available`}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {rowNavigation.status}
      </span>
    </section>
  );
}
