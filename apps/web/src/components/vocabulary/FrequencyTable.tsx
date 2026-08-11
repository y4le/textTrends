import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FREQUENCY_PREFIX_MAX_UNITS, type FrequencyListRowV1 } from '@texttrends/core';
import { FormLayer } from '../FormLayer.tsx';
import { usePresentation } from '../PresentationProvider.tsx';
import { boundedPageView } from '../../lib/bounded-page-view.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  frequencyFilterError,
  frequencyMeasure,
  frequencyViewInput,
  frequencyViewSummary,
  toggleFrequencyClass,
  vocabularyFilterControlId,
  vocabularyRowControlId,
  vocabularyTarget,
  vocabularyTargetIsStale,
  type VocabularyTarget,
} from '../../lib/vocabulary-view.ts';
import { useApp } from '../../lib/store-instance.ts';
import type {
  FrequencyViewInputV1,
  FrequencyViewV1,
} from '../../lib/store.ts';
import { useRowNavigation } from '../useRowNavigation.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? 'unavailable' : decimal.format(input);

const SORTS = [
  { by: 'key', label: 'term' },
  { by: 'count', label: 'count' },
  { by: 'docFreq', label: 'docs' },
  { by: 'dp', label: 'DP' },
  { by: 'dpNorm', label: 'DPnorm' },
] as const;

function FrequencyFilters({
  draft,
  message,
  onDraft,
  onApply,
  onCancel,
}: {
  readonly draft: FrequencyViewInputV1;
  readonly message: string | null;
  readonly onDraft: (next: FrequencyViewInputV1) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <form
      className="frequency-filter-form"
      aria-label="Vocabulary sort and filter"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <h3>Sort and filter</h3>
      <div className="frequency-filter-fields">
        <label>
          starts with
          <input
            className="exact-input"
            value={draft.prefix}
            maxLength={FREQUENCY_PREFIX_MAX_UNITS}
            onChange={(event) => onDraft({ ...draft, prefix: event.target.value })}
          />
        </label>
        <label>
          count ≥
          <input
            className="exact-input"
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(draft.minCount) ? draft.minCount : ''}
            onChange={(event) => onDraft({
              ...draft,
              minCount: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <label>
          docs ≥
          <input
            className="exact-input"
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(draft.minDocFreq) ? draft.minDocFreq : ''}
            onChange={(event) => onDraft({
              ...draft,
              minDocFreq: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <fieldset>
          <legend>token classes</legend>
          {(['lexical', 'numeral'] as const).map((tokenClass) => (
            <label key={tokenClass}>
              <input
                type="checkbox"
                checked={draft.classes.includes(tokenClass)}
                onChange={() => onDraft({
                  ...draft,
                  classes: toggleFrequencyClass(draft.classes, tokenClass),
                })}
              />
              {tokenClass}
            </label>
          ))}
        </fieldset>
        <label>
          sort
          <select
            className="exact-input"
            aria-label="Sort field"
            value={draft.sort.by}
            onChange={(event) => onDraft({
              ...draft,
              sort: {
                ...draft.sort,
                by: event.currentTarget.value as FrequencyViewV1['sort']['by'],
              },
            })}
          >
            {SORTS.map(({ by, label }) => <option key={by} value={by}>{label}</option>)}
          </select>
        </label>
        <label>
          direction
          <select
            className="exact-input"
            aria-label="Sort direction"
            value={draft.sort.dir}
            onChange={(event) => onDraft({
              ...draft,
              sort: {
                ...draft.sort,
                dir: Number(event.currentTarget.value) as 1 | -1,
              },
            })}
          >
            <option value={-1}>descending</option>
            <option value={1}>ascending</option>
          </select>
        </label>
        <label>
          rows/page
          <select
            className="exact-input"
            value={draft.pageLimit}
            onChange={(event) => onDraft({
              ...draft,
              pageLimit: Number(event.currentTarget.value),
            })}
          >
            {[50, 100, 200].map((limit) => (
              <option key={limit} value={limit}>{limit}</option>
            ))}
          </select>
        </label>
      </div>
      {message && <p role="status" className="frequency-filter-message">{message}</p>}
      <div className="form-layer-actions frequency-filter-actions">
        <button type="button" onClick={onCancel}>cancel</button>
        <button type="submit">apply</button>
      </div>
    </form>
  );
}

function FrequencyRowDetail({
  row,
  onAdd,
  onConcordance,
}: {
  readonly row: FrequencyListRowV1;
  readonly onAdd: () => void;
  readonly onConcordance: () => void;
}) {
  return (
    <section
      className="frequency-row-detail"
      aria-label={`Vocabulary detail: ${row.key}`}
    >
      <dl>
        <div><dt>term</dt><dd>{row.key}</dd></div>
        <div><dt>count</dt><dd className="selectable-stat">{number.format(row.count)}</dd></div>
        <div><dt>rate / 10k</dt><dd className="selectable-stat">{decimal.format(row.ratePer10k)}</dd></div>
        <div><dt>documents</dt><dd className="selectable-stat">{number.format(row.docFreq)}</dd></div>
        <div><dt>DP</dt><dd className="selectable-stat">{value(row.dp)}</dd></div>
        <div><dt>DPnorm</dt><dd className="selectable-stat">{value(row.dpNorm)}</dd></div>
        <div><dt>class</dt><dd>{row.class}</dd></div>
      </dl>
      <p className="frequency-row-note">
        Per-book distribution is not available in this bounded result.
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
          onClick={onConcordance}
          title="Show this exact, case-sensitive term in the concordance"
        >
          concordance
        </button>
      </div>
    </section>
  );
}

export function FrequencyTable({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const presentation = usePresentation();
  const state = useApp((store) => store.frequency);
  const snapshot = useApp((store) => store.snapshot);
  const view = useApp((store) => store.frequencyView);
  const layers = useApp((store) => store.layers);
  const setSort = useApp((store) => store.setFrequencySort);
  const applyView = useApp((store) => store.applyFrequencyView);
  const setPage = useApp((store) => store.setFrequencyPage);
  const addTerm = useApp((store) => store.addTerm);
  const showInKwic = useApp((store) => store.showFrequencyTermInKwic);
  const pushLayer = useApp((store) => store.pushLayer);
  const replaceLayer = useApp((store) => store.replaceLayer);
  const popLayer = useApp((store) => store.popLayer);
  const [draft, setDraft] = useState<FrequencyViewInputV1>(() => frequencyViewInput(view));
  const [filterMessage, setFilterMessage] = useState<string | null>(null);
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
  const filterOpen = target?.surface === 'vocab-filter';
  const rowTarget = target?.surface === 'vocab-row' ? target : null;
  const compact = presentation.width === 'compact';
  const stalePopRequested = useRef(false);

  useEffect(() => {
    setDraft(frequencyViewInput(view));
  }, [
    view.minCount,
    view.minDocFreq,
    view.prefixNfc,
    view.classes,
    view.sort.by,
    view.sort.dir,
    view.page.limit,
  ]);

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
  const openFilter = () => writeTarget(
    { surface: 'vocab-filter' },
    vocabularyFilterControlId,
  );
  const closeFilter = (discard: boolean) => {
    if (!filterOpen) return;
    if (discard) {
      setDraft(frequencyViewInput(view));
      setFilterMessage(null);
    }
    popLayer();
  };
  const applyFilter = () => {
    if (!filterOpen) return;
    const error = frequencyFilterError(draft);
    if (error) {
      setFilterMessage(error);
      return;
    }
    setFilterMessage(null);
    applyView(draft);
    popLayer();
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

  const page = state?.state.status === 'ready'
    ? boundedPageView(
        state.state.result.total,
        view.page.offset,
        view.page.limit,
        state.state.result.rows.length,
      )
    : null;
  const rowNavigation = useRowNavigation({
    keys: state?.state.status === 'ready'
      ? state.state.result.rows.map((row) => String(row.typeId))
      : [],
    label: 'Vocabulary',
    preferredKey: rowTarget === null ? null : String(rowTarget.typeId),
    onExit: () => {
      if (rowTarget === null || topLayer?.id !== renderedLayer?.id) return false;
      popLayer();
      return true;
    },
  });
  const filter = (
    <FrequencyFilters
      draft={draft}
      message={filterMessage}
      onDraft={(next) => {
        setFilterMessage(null);
        setDraft(next);
      }}
      onApply={applyFilter}
      onCancel={() => closeFilter(true)}
    />
  );

  return (
    <section
      aria-labelledby={showHeading ? 'frequency-heading' : undefined}
      aria-label={showHeading ? undefined : 'Vocabulary frequency'}
    >
      {showHeading && (
        <h2 id="frequency-heading" style={{ fontSize: 'var(--text-md)' }}>
          Vocabulary
        </h2>
      )}
      <div className="frequency-view-bar">
        <p>{frequencyViewSummary(view)}</p>
        <button
          id={vocabularyFilterControlId}
          type="button"
          aria-expanded={filterOpen}
          aria-haspopup={compact ? 'dialog' : undefined}
          onClick={() => {
            if (filterOpen) closeFilter(false);
            else openFilter();
          }}
        >
          sort and filter
        </button>
      </div>
      {filterOpen && !compact && (
        <div
          className="frequency-filter-inline"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeFilter(false);
            }
          }}
        >
          {filter}
        </div>
      )}
      {filterOpen && compact && (
        <FormLayer
          label="Vocabulary sort and filter"
          focusKey={renderedLayer?.id ?? 'vocabulary-filter'}
          onClose={() => closeFilter(false)}
        >
          {filter}
        </FormLayer>
      )}
      {state?.state.status === 'pending' && <p>ranking vocabulary…</p>}
      {state?.state.status === 'error' && (
        <p style={{ color: 'var(--accent-text)' }}>{state.state.message}</p>
      )}
      {state?.state.status === 'ready' && (
        <>
          <p className="frequency-result-summary">
            {number.format(state.state.result.total)} matching types · rates use{' '}
            {number.format(state.state.result.totalTokens)} selected class tokens · DP parts
            are selected documents
          </p>
          <div
            ref={rowNavigation.portRef}
            className="frequency-table-port"
            role={compact ? undefined : 'region'}
            aria-label={compact ? undefined : 'Scrollable Vocabulary frequency list'}
            tabIndex={compact ? -1 : 0}
          >
            <table
              className="frequency-table"
              role="table"
              aria-label="Vocabulary frequency list"
              aria-colcount={7}
            >
              <thead role="rowgroup">
                <tr role="row">
                  {SORTS.map(({ by, label }, index) => (
                    <th
                      key={by}
                      role="columnheader"
                      aria-colindex={index + 1}
                      scope="col"
                      aria-sort={view.sort.by === by
                        ? (view.sort.dir === 1 ? 'ascending' : 'descending')
                        : 'none'}
                    >
                      {compact
                        ? label
                        : <button type="button" onClick={() => setSort(by)}>{label}</button>}
                    </th>
                  ))}
                  <th role="columnheader" aria-colindex={6} scope="col">rate/10k</th>
                  <th role="columnheader" aria-colindex={7} scope="col">class</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {state.state.result.rows.map((row) => {
                  const expanded =
                    rowTarget?.typeId === row.typeId && rowTarget.key === row.key;
                  const compactMeasure = frequencyMeasure(row, view.sort.by);
                  const measures = {
                    count: frequencyMeasure(row, 'count'),
                    docFreq: frequencyMeasure(row, 'docFreq'),
                    dp: frequencyMeasure(row, 'dp'),
                    dpNorm: frequencyMeasure(row, 'dpNorm'),
                  } as const;
                  const measureData = (field: keyof typeof measures) =>
                    compactMeasure.field === field ? true : undefined;
                  const measureLabel = (field: keyof typeof measures) =>
                    compactMeasure.field === field ? compactMeasure.label : undefined;
                  return (
                    <Fragment key={row.typeId}>
                      <tr
                        className="frequency-primary-row"
                        role="row"
                        data-frequency-row
                      >
                        <th
                          className="frequency-term"
                          role="rowheader"
                          aria-colindex={1}
                          scope="row"
                        >
                          <button
                            {...rowNavigation.controlProps(String(row.typeId))}
                            id={vocabularyRowControlId(row.typeId)}
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => openRow(row)}
                          >
                            <span>{row.key}</span>
                          </button>
                        </th>
                        <td
                          className="frequency-measure frequency-count selectable-stat"
                          role="cell"
                          aria-colindex={2}
                          data-current-measure={measureData('count')}
                          data-measure-label={measureLabel('count')}
                        >
                          {measures.count.value}
                        </td>
                        <td
                          className="frequency-measure frequency-docs selectable-stat"
                          role="cell"
                          aria-colindex={3}
                          data-current-measure={measureData('docFreq')}
                          data-measure-label={measureLabel('docFreq')}
                        >
                          {measures.docFreq.value}
                        </td>
                        <td
                          className="frequency-measure frequency-dp selectable-stat"
                          role="cell"
                          aria-colindex={4}
                          data-current-measure={measureData('dp')}
                          data-measure-label={measureLabel('dp')}
                        >
                          {measures.dp.value}
                        </td>
                        <td
                          className="frequency-measure frequency-dpnorm selectable-stat"
                          role="cell"
                          aria-colindex={5}
                          data-current-measure={measureData('dpNorm')}
                          data-measure-label={measureLabel('dpNorm')}
                        >
                          {measures.dpNorm.value}
                        </td>
                        <td
                          className="frequency-rate selectable-stat"
                          role="cell"
                          aria-colindex={6}
                        >
                          {decimal.format(row.ratePer10k)}
                        </td>
                        <td
                          className="frequency-class"
                          role="cell"
                          aria-colindex={7}
                        >
                          {row.class}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="frequency-detail-row" role="row">
                          <td role="cell" aria-colindex={1} colSpan={7}>
                            <FrequencyRowDetail
                              row={row}
                              onAdd={() => addAndManage(row.key, row.typeId)}
                              onConcordance={() => showInKwic(row.key)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="frequency-pagination">
            <button
              type="button"
              disabled={view.page.offset === 0}
              onClick={() => setPage(Math.max(0, view.page.offset - view.page.limit))}
            >
              previous
            </button>
            <span>{page?.label}</span>
            <button
              type="button"
              disabled={!page?.canNext}
              onClick={() => setPage(view.page.offset + view.page.limit)}
            >
              next
            </button>
          </div>
          {page?.atWindow && (
            <p role="status" className="frequency-window-message">
              The bounded result window ends at 5,000 rows. Narrow the filters to continue.
            </p>
          )}
          <span className="visually-hidden" role="status" aria-live="polite">
            {rowNavigation.status}
          </span>
        </>
      )}
    </section>
  );
}
