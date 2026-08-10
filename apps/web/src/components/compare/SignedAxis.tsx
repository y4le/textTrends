import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { KeynessRowV1 } from '@texttrends/core';
import { boundedPageView } from '../../lib/bounded-page-view.ts';
import {
  compareBarPercent,
  compareRowControlId,
  compareSortLabel,
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

const signed = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  signDisplay: 'always',
});
const scaleNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('en-US');
const rowNavigationKey = (side: 'a' | 'b', typeId: number) => `${side}:${typeId}`;

function projectedTotal(total: number): string {
  return `${integer.format(total)} projected ${total === 1 ? 'term' : 'terms'}`;
}

function sideOffset(view: KeynessViewV1, side: 'a' | 'b'): number {
  return side === 'a' ? view.offsetA : view.offsetB;
}

function AxisRow({
  row,
  side,
  view,
  scale,
  expanded,
  onOpen,
  compact,
  navigation,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
  readonly scale: CompareScale;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly compact: boolean;
  readonly navigation: RowControlProps;
}) {
  const width = compareBarPercent(row.logRatio, scale.maximum);
  const barStyle = { '--compare-bar-width': `${width}%` } as CSSProperties;
  return (
    <Fragment>
      <tr className="compare-axis-row" data-side={side} role="row">
        <th
          className="compare-term"
          scope="row"
          role="rowheader"
          aria-colindex={1}
        >
          <button
            {...navigation}
            id={compareRowControlId(side, row.typeId)}
            type="button"
            aria-expanded={expanded}
            onClick={onOpen}
          >
            <span>{row.key}</span>
            <span className="compare-term-cue" aria-hidden="true">▸</span>
          </button>
        </th>
        <td className="compare-effect" role="cell" aria-colindex={2}>
          {!compact && (
            <span className="compare-axis-plot" aria-hidden="true">
              <span className="compare-axis-zero" />
              <span
                className="compare-axis-bar"
                data-side={side}
                style={barStyle}
              />
            </span>
          )}
          <span className="compare-effect-value selectable-stat">{signed.format(row.logRatio)}</span>
        </td>
        <td className="compare-side" role="cell" aria-colindex={3}>
          {side.toUpperCase()}
          <span className="compare-side-cue" aria-hidden="true">▸</span>
        </td>
      </tr>
      {expanded && (
        <tr className="compare-detail-row" role="row">
          <td colSpan={3} role="cell" aria-colindex={1}>
            <CompareRowDetail
              row={row}
              side={side}
              view={view}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function SideRows({
  side,
  state,
  view,
  scale,
  rowTarget,
  onRow,
  compact,
  navigationProps,
}: {
  readonly side: 'a' | 'b';
  readonly state: KeynessTableState | null;
  readonly view: KeynessViewV1;
  readonly scale: CompareScale;
  readonly rowTarget: CompareRowTarget | null;
  readonly onRow: (row: KeynessRowV1) => void;
  readonly compact: boolean;
  readonly navigationProps: (key: string) => RowControlProps;
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
  const total = state?.state.status === 'ready'
    ? state.state.result.total
    : null;
  const groupLabel = [
    `Side ${side.toUpperCase()}`,
    `${compareSortDescription(view, side)}`,
    page && total !== null
      ? `${page.label} · ${projectedTotal(total)}`
      : state?.state.status ?? 'unavailable',
  ].join(' · ');
  let rows: ReactNode;
  if (!state || state.state.status === 'pending') {
    rows = (
      <tr className="compare-axis-status" role="row">
        <td colSpan={3} role="cell" aria-colindex={1}>
          ranking side {side.toUpperCase()}…
        </td>
      </tr>
    );
  } else if (state.state.status === 'error') {
    rows = (
      <tr className="compare-axis-status" data-error role="row">
        <td colSpan={3} role="cell" aria-colindex={1}>{state.state.message}</td>
      </tr>
    );
  } else if (state.state.result.rows.length === 0) {
    rows = (
      <tr className="compare-axis-status" role="row">
        <td colSpan={3} role="cell" aria-colindex={1}>
          No terms meet this side's projection and filters.
        </td>
      </tr>
    );
  } else {
    rows = state.state.result.rows.map((row) => {
      const expanded =
        rowTarget?.side === side
        && rowTarget.typeId === row.typeId
        && rowTarget.key === row.key;
      return (
        <AxisRow
          key={`${side}-${row.typeId}`}
          row={row}
          side={side}
          view={view}
          scale={scale}
          expanded={expanded}
          onOpen={() => onRow(row)}
          compact={compact}
          navigation={navigationProps(rowNavigationKey(side, row.typeId))}
        />
      );
    });
  }
  return (
    <tbody role="rowgroup" aria-label={groupLabel} data-side={side}>
      {rows}
      {rowTarget?.side === side && state?.state.status !== 'ready' && (
        <tr className="compare-detail-row" role="row">
          <td colSpan={3} role="cell" aria-colindex={1}>
            <p className="compare-row-note">
              {state?.state.status === 'error'
                ? (
                    <>
                      Detail for {rowTarget.key} is retained; side{' '}
                      {side.toUpperCase()} is unavailable: {state.state.message}
                    </>
                  )
                : (
                    <>
                      Detail for {rowTarget.key} is retained while side{' '}
                      {side.toUpperCase()} refreshes.
                    </>
                  )}
            </p>
          </td>
        </tr>
      )}
    </tbody>
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
  onRow,
  onPage,
  compact,
  onCloseRow,
}: {
  readonly stateA: KeynessTableState | null;
  readonly stateB: KeynessTableState | null;
  readonly view: KeynessViewV1;
  readonly scale: CompareScale;
  readonly rowTarget: CompareRowTarget | null;
  readonly onRow: (side: 'a' | 'b', row: KeynessRowV1) => void;
  readonly onPage: (side: 'a' | 'b', offset: number) => void;
  readonly compact: boolean;
  readonly onCloseRow: () => boolean;
}) {
  const caption = [
    `A and B keep independent ${compareSortLabel(view.sort.by)} rank order.`,
    `Bars share a page-local log₂-ratio scale from −${scaleNumber.format(scale.maximum)} to +${scaleNumber.format(scale.maximum)}.`,
    scale.provisional ? 'Scale is provisional until both sides are ready.' : '',
    'Terms with exactly zero log₂ ratio are in neither projection.',
  ].filter(Boolean).join(' ');
  const rowsA = stateA?.state.status === 'ready' ? stateA.state.result.rows : [];
  const rowsB = stateB?.state.status === 'ready' ? stateB.state.result.rows : [];
  const rowNavigation = useRowNavigation({
    keys: [
      ...rowsA.map((row) => rowNavigationKey('a', row.typeId)),
      ...rowsB.map((row) => rowNavigationKey('b', row.typeId)),
    ],
    label: 'Compare',
    preferredKey: rowTarget === null
      ? null
      : rowNavigationKey(rowTarget.side, rowTarget.typeId),
    onExit: onCloseRow,
  });
  return (
    <section className="compare-axis-section" aria-labelledby="compare-axis-heading">
      <h3 id="compare-axis-heading">Distinctive terms</h3>
      <div
        ref={rowNavigation.portRef}
        className="compare-table-port"
        role={compact ? undefined : 'region'}
        aria-label={compact ? undefined : 'Scrollable Compare signed axis'}
        tabIndex={compact ? -1 : 0}
      >
        <table
          className="compare-axis-table"
          role="table"
          aria-label="Compare signed axis"
          aria-colcount={3}
        >
          <caption>{caption}</caption>
          <colgroup>
            <col className="compare-col-term" />
            <col className="compare-col-effect" />
            <col className="compare-col-side" />
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" aria-colindex={1}>term</th>
              <th scope="col" role="columnheader" aria-colindex={2}>log₂ ratio</th>
              <th scope="col" role="columnheader" aria-colindex={3}>side</th>
            </tr>
          </thead>
          <SideRows
            side="a"
            state={stateA}
            view={view}
            scale={scale}
            rowTarget={rowTarget}
            onRow={(row) => onRow('a', row)}
            compact={compact}
            navigationProps={rowNavigation.controlProps}
          />
          <SideRows
            side="b"
            state={stateB}
            view={view}
            scale={scale}
            rowTarget={rowTarget}
            onRow={(row) => onRow('b', row)}
            compact={compact}
            navigationProps={rowNavigation.controlProps}
          />
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
