import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeynessRowV1 } from '@texttrends/core';
import { FormLayer } from '../FormLayer.tsx';
import { usePresentation } from '../PresentationProvider.tsx';
import {
  compareRowControlId,
  compareScale,
  compareSettingsControlId,
  compareSettingsError,
  compareSettingsInput,
  compareSideLabel,
  compareTarget,
  compareTargetIsStale,
  compareViewSummary,
  type CompareTarget,
} from '../../lib/compare-view.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  keynessSelections,
  type KeynessInventoryState,
  type KeynessSettingsInputV1,
  type KeynessTableState,
  type KeynessViewV1,
} from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';
import { CompareSettings } from './CompareSettings.tsx';
import { SignedAxis } from './SignedAxis.tsx';

const number = new Intl.NumberFormat('en-US');

function WholeSideSummary({
  inventory,
}: {
  readonly inventory: KeynessInventoryState | null;
}) {
  if (!inventory || inventory.state.status === 'pending') {
    return <span>whole side: summarizing…</span>;
  }
  if (inventory.state.status === 'error') {
    return <span>whole side unavailable: {inventory.state.message}</span>;
  }
  return (
    <span>
      whole side: {number.format(inventory.state.result.totals.types)} types ·{' '}
      {number.format(inventory.state.result.totals.sentences)} sentences
    </span>
  );
}

function SideSummary({
  side,
  table,
  inventory,
}: {
  readonly side: 'a' | 'b';
  readonly table: KeynessTableState | null;
  readonly inventory: KeynessInventoryState | null;
}) {
  const totals = table?.state.status === 'ready'
    ? (side === 'a' ? table.state.result.totalsA : table.state.result.totalsB)
    : null;
  const selectedSummary = totals
    ? (
        <>
          selected classes: {number.format(totals.tokens)} tokens ·{' '}
          {number.format(totals.documents)}{' '}
          {totals.documents === 1 ? 'document' : 'documents'}
        </>
      )
    : table?.state.status === 'error'
      ? `selected classes unavailable: ${table.state.message}`
      : 'selected classes: calculating…';
  return (
    <section className="compare-side-summary" aria-label={`Side ${side.toUpperCase()} summary`}>
      <strong>Side {side.toUpperCase()}</strong>
      <p>{selectedSummary}</p>
      <p><WholeSideSummary inventory={inventory} /></p>
    </section>
  );
}

export function ComparePanel() {
  const presentation = usePresentation();
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const view = useApp((state) => state.keynessView);
  const stateA = useApp((state) => state.keynessA);
  const stateB = useApp((state) => state.keynessB);
  const inventoryA = useApp((state) => state.keynessInventoryA);
  const inventoryB = useApp((state) => state.keynessInventoryB);
  const layers = useApp((state) => state.layers);
  const setMode = useApp((state) => state.setKeynessMode);
  const setDocument = useApp((state) => state.setKeynessDocument);
  const swapSides = useApp((state) => state.swapKeynessSides);
  const applySettings = useApp((state) => state.applyKeynessSettings);
  const setDirection = useApp((state) => state.setKeynessDirection);
  const setPage = useApp((state) => state.setKeynessPage);
  const openEvidence = useApp((state) => state.openKeynessEvidence);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);
  const [draft, setDraft] = useState<KeynessSettingsInputV1>(
    () => compareSettingsInput(view),
  );
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const topLayer = layers.at(-1);
  const renderedLayer = useMemo(
    () => renderedRowDetailLayer(layers),
    [layers],
  );
  const target = useMemo(
    () => renderedLayer ? compareTarget(renderedLayer.target) : null,
    [renderedLayer],
  );
  const settingsOpen = target?.surface === 'compare-settings';
  const rowTarget = target?.surface === 'compare-row' ? target : null;
  const compact = presentation.width === 'compact';
  const stalePopRequested = useRef(false);

  useEffect(() => {
    setDraft(compareSettingsInput(view));
  }, [
    view.minCountTotal,
    view.minDocFreqTotal,
    view.classes,
    view.sort.by,
    view.pageLimit,
  ]);

  useEffect(() => {
    stalePopRequested.current = false;
  }, [renderedLayer?.id]);

  const readyDocs = snapshot?.readyDocs ?? [];
  const comparison = snapshot
    ? keynessSelections(view, snapshot.readyDocs)
    : null;
  const hasComparison = comparison !== null;

  useEffect(() => {
    if (target === null || stalePopRequested.current) return;
    if (!compareTargetIsStale(
      target,
      snapshot !== null,
      hasComparison,
      stateA,
      stateB,
    )) {
      return;
    }
    const index = renderedLayer ? layers.indexOf(renderedLayer) : -1;
    stalePopRequested.current = popLayer(
      index < 0 ? 1 : layers.length - index,
      'place-compare-heading',
    );
  }, [
    hasComparison,
    layers,
    popLayer,
    renderedLayer,
    snapshot,
    stateA,
    stateB,
    target,
  ]);

  const titleByDoc = useMemo(
    () => new Map(
      (project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title]),
    ),
    [project],
  );
  const titleOf = (doc: string) => titleByDoc.get(doc) ?? doc;

  const writeTarget = (
    next: CompareTarget,
    returnFocusTo: string,
  ): boolean => {
    if (
      (renderedLayer && topLayer?.id !== renderedLayer.id)
      || topLayer?.kind === 'sheet'
      || topLayer?.kind === 'reader'
    ) {
      return false;
    }
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail'
        ? rowDetailSurface(topLayer.target)
        : null,
      next.surface,
    );
    if (write === 'replace') {
      replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    } else {
      pushLayer('row-detail', Object.freeze(next), returnFocusTo);
    }
    return true;
  };

  const closeSettings = (discard: boolean) => {
    if (!settingsOpen) return;
    if (discard) {
      setDraft(compareSettingsInput(view));
      setSettingsMessage(null);
    }
    popLayer();
  };
  const applyDraft = () => {
    if (!settingsOpen) return;
    const error = compareSettingsError(draft);
    if (error) {
      setSettingsMessage(error);
      return;
    }
    setSettingsMessage(null);
    applySettings(draft);
    popLayer();
  };
  const openRow = (side: 'a' | 'b', row: KeynessRowV1) => {
    if (
      rowTarget?.side === side
      && rowTarget.typeId === row.typeId
      && rowTarget.key === row.key
    ) {
      if (topLayer?.id === renderedLayer?.id) popLayer();
      return;
    }
    writeTarget(
      {
        surface: 'compare-row',
        side,
        typeId: row.typeId,
        key: row.key,
      },
      compareRowControlId(side, row.typeId),
    );
  };
  const showRowEvidence = (side: 'a' | 'b', row: KeynessRowV1) => {
    if (topLayer?.id !== renderedLayer?.id) return;
    if (!openEvidence(row.key, side)) return;
    if (presentation.width !== 'wide') {
      pushLayer(
        'sheet',
        Object.freeze({ surface: 'evidence' }),
        compareRowControlId(side, row.typeId),
        { detent: 'tall' },
      );
    }
  };

  const sideControl = (side: 'a' | 'b') => {
    const isRest = view.mode === 'document-rest' && view.restOn === side;
    const doc = side === 'a' ? view.documentA : view.documentB;
    if (isRest) {
      return <span className="compare-rest-label">{compareSideLabel(side, view, titleOf)}</span>;
    }
    return (
      <select
        className="exact-input"
        aria-label={`Side ${side.toUpperCase()} book`}
        value={doc ?? ''}
        onChange={(event) => setDocument(side, event.currentTarget.value)}
      >
        {readyDocs.map((candidate) => (
          <option
            key={candidate}
            value={candidate}
            disabled={candidate === (side === 'a' ? view.documentB : view.documentA)}
          >
            {titleOf(candidate)}
          </option>
        ))}
      </select>
    );
  };
  const scale = compareScale(stateA, stateB);
  const settings = (
    <CompareSettings
      draft={draft}
      message={settingsMessage}
      onDraft={(next) => {
        setSettingsMessage(null);
        setDraft(next);
      }}
      onApply={applyDraft}
      onCancel={() => closeSettings(true)}
    />
  );

  return (
    <section className="compare-panel" aria-label="Keyness comparison">
      <p className="compare-scope-note">
        Compare uses explicit sides A and B. A linked Trends range does not
        redefine either side.
      </p>
      {readyDocs.length < 2
        ? <p>Add at least two ready books to compare distinctive terms.</p>
        : (
          <>
            <div className="compare-definition">
              <label>
                comparison
                <select
                  className="exact-input"
                  aria-label="Comparison mode"
                  value={view.mode}
                  onChange={(event) =>
                    setMode(event.currentTarget.value as KeynessViewV1['mode'])}
                >
                  <option value="documents">book vs book</option>
                  <option value="document-rest">book vs rest</option>
                </select>
              </label>
              <label>side A {sideControl('a')}</label>
              <button
                className="compare-swap"
                type="button"
                onClick={swapSides}
                aria-label="Swap keyness sides"
              >
                ⇄ swap
              </button>
              <label>side B {sideControl('b')}</label>
            </div>

            <div className="compare-side-summaries">
              <SideSummary side="a" table={stateA} inventory={inventoryA} />
              <SideSummary side="b" table={stateB} inventory={inventoryB} />
            </div>
            <div className="compare-warnings">
              {(['a', 'b'] as const).map((side) => {
                const table = side === 'a' ? stateA : stateB;
                const totals = table?.state.status === 'ready'
                  ? (side === 'a'
                      ? table.state.result.totalsA
                      : table.state.result.totalsB)
                  : null;
                return totals && totals.tokens < 10_000
                  ? (
                      <p key={side} role="note">
                        Small side {side.toUpperCase()} (&lt;10,000 selected-class
                        tokens): ranks may be unstable.
                      </p>
                    )
                  : null;
              })}
              <p role="note">
                No confidence intervals are available; inspect exact evidence
                before interpreting small differences.
              </p>
            </div>

            <div className="compare-view-bar">
              <p>{compareViewSummary(view)}</p>
              <button
                id={compareSettingsControlId}
                type="button"
                aria-expanded={settingsOpen}
                aria-haspopup={compact ? 'dialog' : undefined}
                onClick={() => {
                  if (settingsOpen) closeSettings(false);
                  else {
                    writeTarget(
                      { surface: 'compare-settings' },
                      compareSettingsControlId,
                    );
                  }
                }}
              >
                sort and filter
              </button>
            </div>
            <div
              className="compare-direction-controls"
              role="group"
              aria-label="Independent projection directions"
            >
              <button type="button" onClick={() => setDirection('a')}>
                reverse side A · {view.sort.dirA === 1 ? 'ascending' : 'descending'}
              </button>
              <button type="button" onClick={() => setDirection('b')}>
                reverse side B · {view.sort.dirB === 1 ? 'ascending' : 'descending'}
              </button>
            </div>
            {settingsOpen && !compact && (
              <div
                className="compare-settings-inline"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeSettings(false);
                  }
                }}
              >
                {settings}
              </div>
            )}
            {settingsOpen && compact && (
              <FormLayer
                label="Compare sort and filter"
                focusKey={renderedLayer?.id ?? 'compare-settings'}
                onClose={() => closeSettings(false)}
              >
                {settings}
              </FormLayer>
            )}

            <SignedAxis
              stateA={stateA}
              stateB={stateB}
              view={view}
              scale={scale}
              rowTarget={rowTarget}
              onRow={openRow}
              onEvidence={showRowEvidence}
              onPage={setPage}
              compact={compact}
            />
          </>
        )}
    </section>
  );
}
