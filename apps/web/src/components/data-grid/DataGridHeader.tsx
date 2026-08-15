import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from 'react';
import { InfoTooltip } from '../InfoTooltip.tsx';

export type DataGridSortDirection = 'ascending' | 'descending' | 'none';

export interface DataGridColumn<Key extends string = string> {
  readonly key: Key;
  readonly label: string;
  readonly className?: string;
  readonly headingRef?: RefObject<HTMLElement | null>;
  readonly sort?: DataGridSortDirection;
  readonly onSort?: () => void;
  readonly explanation?: string;
}

export interface ColumnResizeHandleProps {
  readonly label: string;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly valueNow: number;
  readonly valueText: string;
  readonly adjustable: boolean;
  readonly className?: string;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function ColumnResizeHandle({
  label,
  valueMin,
  valueMax,
  valueNow,
  valueText,
  adjustable,
  className,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: ColumnResizeHandleProps) {
  return (
    <div
      className={['data-grid-column-resizer', className].filter(Boolean).join(' ')}
      role="separator"
      aria-label={`${label} width`}
      aria-orientation="vertical"
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={valueText}
      tabIndex={adjustable ? 0 : -1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  );
}

function HeaderContents<Key extends string>({
  column,
  tooltipIdBase,
  tooltipsDisabled,
  resizeHandle,
}: {
  readonly column: DataGridColumn<Key>;
  readonly tooltipIdBase: string;
  readonly tooltipsDisabled: boolean;
  readonly resizeHandle?: ReactNode;
}) {
  return (
    <>
      <span className="data-grid-heading-content">
        {column.onSort
          ? (
              <button
                type="button"
                className="data-grid-sort-button"
                onClick={column.onSort}
                title={`Sort by ${column.label}`}
              >
                <span className="data-grid-heading-label">{column.label}</span>
                {(column.sort === 'ascending' || column.sort === 'descending') && (
                  <span className="data-grid-sort-indicator" aria-hidden="true">
                    {column.sort === 'ascending' ? '↑' : '↓'}
                  </span>
                )}
              </button>
            )
          : <span className="data-grid-heading-label">{column.label}</span>}
        {column.explanation && (
          <InfoTooltip
            id={`${tooltipIdBase}-${column.key}-help`}
            label={column.label}
            explanation={column.explanation}
            disabled={tooltipsDisabled}
            className="data-grid-header-info"
          />
        )}
      </span>
      {resizeHandle}
    </>
  );
}

/** One semantic header implementation for native bounded tables and virtual
 * ARIA grids. Both structures use the same labels, sort affordances,
 * explanations, and resize handles while retaining the correct host markup. */
export function DataGridHeader<Key extends string>({
  columns,
  kind,
  className,
  tooltipIdBase,
  tooltipsDisabled = false,
  renderResizeHandle,
}: {
  readonly columns: readonly DataGridColumn<Key>[];
  readonly kind: 'table' | 'grid';
  readonly className: string;
  readonly tooltipIdBase: string;
  readonly tooltipsDisabled?: boolean;
  readonly renderResizeHandle?: (column: DataGridColumn<Key>, index: number) => ReactNode;
}) {
  if (kind === 'table') {
    return (
      <thead className="data-grid-header-group" role="rowgroup">
        <tr className={`data-grid-header ${className}`} role="row">
          {columns.map((column, index) => (
            <th
              key={column.key}
              ref={column.headingRef as RefObject<HTMLTableCellElement | null> | undefined}
              className={column.className}
              role="columnheader"
              aria-colindex={index + 1}
              aria-sort={column.sort}
              scope="col"
            >
              <HeaderContents
                column={column}
                tooltipIdBase={tooltipIdBase}
                tooltipsDisabled={tooltipsDisabled}
                resizeHandle={renderResizeHandle?.(column, index)}
              />
            </th>
          ))}
        </tr>
      </thead>
    );
  }
  return (
    <div className={`data-grid-header ${className}`} role="row">
      {columns.map((column, index) => (
        <div
          key={column.key}
          ref={column.headingRef as RefObject<HTMLDivElement | null> | undefined}
          className={column.className}
          role="columnheader"
          aria-colindex={index + 1}
          aria-sort={column.sort}
        >
          <HeaderContents
            column={column}
            tooltipIdBase={tooltipIdBase}
            tooltipsDisabled={tooltipsDisabled}
            resizeHandle={renderResizeHandle?.(column, index)}
          />
        </div>
      ))}
    </div>
  );
}

export function DataGridColumnToolbar({
  label,
  controls,
  adjustable,
  toggleButtonRef,
  onToggle,
  atDefault,
  onReset,
  className,
}: {
  readonly label: string;
  readonly controls: string;
  readonly adjustable: boolean;
  readonly toggleButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
  readonly atDefault: boolean;
  readonly onReset: () => void;
  readonly className?: string;
}) {
  return (
    <div
      className={['data-grid-column-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={`${label} columns`}
    >
      {adjustable && (
        <button
          type="button"
          aria-label="Reset column widths"
          title="Reset column widths"
          disabled={atDefault}
          onClick={onReset}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16 7a7 7 0 1 0 1 6M16 3v4h-4" />
          </svg>
        </button>
      )}
      <button
        ref={toggleButtonRef}
        type="button"
        aria-controls={controls}
        aria-label={adjustable ? 'Lock column widths' : 'Adjust column widths'}
        aria-pressed={adjustable}
        title={adjustable ? 'Lock column widths' : 'Adjust column widths'}
        onClick={onToggle}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 3v14M8 3v14M13 3v14M18 3v14" />
          <path d={adjustable ? 'M1 6h4M6 13h4M11 8h4M16 11h3' : 'M1 9h4M6 6h4M11 11h4M16 7h3'} />
        </svg>
      </button>
    </div>
  );
}
