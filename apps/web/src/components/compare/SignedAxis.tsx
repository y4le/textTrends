import { Fragment, type CSSProperties } from 'react';
import type { KeynessRowV1 } from '@texttrends/core';
import { boundedPageView } from '../../lib/bounded-page-view.ts';
import {
  compareBarPercent,
  compareRowControlId,
  compareSortDescription,
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

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('en-US');
const rowNavigationKey = (side: 'a' | 'b', typeId: number) => `${side}:${typeId}`;

function projectedTotal(total: number): string {
  return `${integer.format(total)} distinctive ${total === 1 ? 'term' : 'terms'}`;
}

function sideOffset(view: KeynessViewV1, side: 'a' | 'b'): number {
  return side === 'a' ? view.offsetA : view.offsetB;
}

function readyRows(state: KeynessTableState | null): readonly KeynessRowV1[] {
  return state?.state.status === 'ready' ? state.state.result.rows : [];
}

function SideHalf({
  row,
  side,
  sideLabel,
  scale,
  expanded,
  onOpen,
  navigation,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly sideLabel: string;
  readonly scale: CompareScale;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly navigation: RowControlProps;
}) {
  const width = compareBarPercent(row.logRatio, scale.maximum);
  const barStyle = { '--compare-bar-width': `${width}%` } as CSSProperties;
  return (
    <button
      {...navigation}
      id={compareRowControlId(side, row.typeId)}
      className="compare-pyramid-button"
      type="button"
      aria-label={`${row.key}, ${decimal.format(Math.abs(row.logRatio))} log₂ lift for ${sideLabel}`}
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <span className="compare-pyramid-value selectable-stat">
        {decimal.format(Math.abs(row.logRatio))}
      </span>
      <span className="compare-pyramid-term" title={row.key}>{row.key}</span>
      <span className="compare-pyramid-plot" aria-hidden="true">
        <span className="compare-pyramid-bar" style={barStyle} />
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
  const message = !state || state.state.status === 'pending'
    ? 'ranking…'
    : state.state.status === 'error'
      ? state.state.message
      : 'No terms meet the filters.';
  return (
    <p className="compare-pyramid-status" data-error={state?.state.status === 'error' || undefined}>
      <span className="visually-hidden">Side {side.toUpperCase()}: </span>
      {message}
    </p>
  );
}

function SidePagination({
  side,
  state,
  view,
  onPage,
}: {
  readonly side: 'a' | 'b';
  readonly state: KeynessTableState | null;
  readonly view: KeynessViewV1;
  readonly onPage: (offset: number) => void;
}) {
  const offset = sideOffset(view, side);
  const page = state?.state.status === 'ready'
    ? boundedPageView(
        state.state.result.total,
        offset,
        view.pageLimit,
        state.state.result.rows.length,
      )
    : null;
  const label = page && state?.state.status === 'ready'
    ? `${page.label} · ${projectedTotal(state.state.result.total)}`
    : 'waiting for ranks';
  return (
    <div
      className="compare-pagination"
      data-side={side}
      role="group"
      aria-label={`Side ${side.toUpperCase()} pagination`}
    >
      <button
        type="button"
        disabled={offset === 0 || page === null}
        onClick={() => onPage(Math.max(0, offset - view.pageLimit))}
      >
        previous
      </button>
      <span>{label}</span>
      <button
        type="button"
        disabled={!page?.canNext}
        onClick={() => onPage(offset + view.pageLimit)}
      >
        next
      </button>
      {page?.atWindow && (
        <p role="status" className="compare-window-message">
          Side {side.toUpperCase()} reaches the bounded 5,000-row result
          window. Narrow the filters to continue.
        </p>
      )}
    </div>
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
  onRow,
  onPage,
  onCloseRow,
}: {
  readonly stateA: KeynessTableState | null;
  readonly stateB: KeynessTableState | null;
  readonly view: KeynessViewV1;
  readonly scale: CompareScale;
  readonly rowTarget: CompareRowTarget | null;
  readonly sideLabelA: string;
  readonly sideLabelB: string;
  readonly onRow: (side: 'a' | 'b', row: KeynessRowV1) => void;
  readonly onPage: (side: 'a' | 'b', offset: number) => void;
  readonly onCloseRow: () => boolean;
}) {
  const rowsA = readyRows(stateA);
  const rowsB = readyRows(stateB);
  const pairCount = Math.max(rowsA.length, rowsB.length, 1);
  const pairs = Array.from({ length: pairCount }, (_, index) => ({
    a: rowsA[index] ?? null,
    b: rowsB[index] ?? null,
  }));
  const navigationKeys = pairs.flatMap(({ a, b }) => [
    ...(a ? [rowNavigationKey('a', a.typeId)] : []),
    ...(b ? [rowNavigationKey('b', b.typeId)] : []),
  ]);
  const rowNavigation = useRowNavigation({
    keys: navigationKeys,
    label: 'Compare',
    preferredKey: rowTarget === null
      ? null
      : rowNavigationKey(rowTarget.side, rowTarget.typeId),
    onExit: onCloseRow,
  });
  const retainedTarget = rowTarget !== null
    && (rowTarget.side === 'a' ? stateA : stateB)?.state.status !== 'ready';

  return (
    <section className="compare-axis-section" aria-labelledby="compare-axis-heading">
      <div className="compare-axis-heading">
        <h3 id="compare-axis-heading">Distinctive terms</h3>
        <p>
          {compareSortDescription(view, 'a')} left · {compareSortDescription(view, 'b')} right
        </p>
      </div>
      <div
        {...rowNavigation.portProps}
        ref={rowNavigation.portRef}
        className="compare-table-port"
        role="region"
        aria-label="Compare population pyramid"
        tabIndex={0}
      >
        <table
          className="compare-axis-table"
          role="table"
          aria-label="Compare population pyramid"
          aria-colcount={2}
        >
          <caption className="visually-hidden">
            Distinctive vocabulary ranked independently on two sides. Bar length
            uses a shared page-local log₂-ratio scale; select either half-row for
            that word's full comparison.
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" aria-colindex={1}>
                <span>log₂ lift</span>
                <strong>{sideLabelA}</strong>
              </th>
              <th scope="col" role="columnheader" aria-colindex={2}>
                <strong>{sideLabelB}</strong>
                <span>log₂ lift</span>
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup" aria-label="Paired distinctive term ranks">
            {pairs.map(({ a, b }, index) => {
              const targetRow = rowTarget?.side === 'a' ? a : b;
              const expanded = rowTarget !== null
                && targetRow?.typeId === rowTarget.typeId
                && targetRow.key === rowTarget.key;
              return (
                <Fragment key={`${a?.typeId ?? 'empty'}:${b?.typeId ?? 'empty'}:${index}`}>
                  <tr className="compare-pyramid-row" role="row" data-row-navigation-row>
                    <td className="compare-pyramid-half" data-side="a" role="cell" aria-colindex={1}>
                      {a
                        ? (
                            <SideHalf
                              row={a}
                              side="a"
                              sideLabel={sideLabelA}
                              scale={scale}
                              expanded={expanded && rowTarget?.side === 'a'}
                              onOpen={() => onRow('a', a)}
                              navigation={rowNavigation.controlProps(rowNavigationKey('a', a.typeId))}
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
                              expanded={expanded && rowTarget?.side === 'b'}
                              onOpen={() => onRow('b', b)}
                              navigation={rowNavigation.controlProps(rowNavigationKey('b', b.typeId))}
                            />
                          )
                        : index === 0 && <SideStatus state={stateB} side="b" />}
                    </td>
                  </tr>
                  {expanded && targetRow && rowTarget && (
                    <tr className="compare-detail-row" role="row">
                      <td colSpan={2} role="cell" aria-colindex={1}>
                        <CompareRowDetail
                          row={targetRow}
                          side={rowTarget.side}
                          sideLabelA={sideLabelA}
                          sideLabelB={sideLabelB}
                          view={view}
                          onClose={onCloseRow}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {retainedTarget && rowTarget && (
              <tr className="compare-detail-row" role="row">
                <td colSpan={2} role="cell" aria-colindex={1}>
                  <p className="compare-row-note">
                    Detail for {rowTarget.key} is retained while side{' '}
                    {rowTarget.side.toUpperCase()} refreshes.
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="compare-pagers">
        <SidePagination
          side="a"
          state={stateA}
          view={view}
          onPage={(offset) => onPage('a', offset)}
        />
        <SidePagination
          side="b"
          state={stateB}
          view={view}
          onPage={(offset) => onPage('b', offset)}
        />
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {rowNavigation.status}
      </span>
    </section>
  );
}
