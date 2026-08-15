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
  compareDivergence,
  compareRowControlId,
  compareScale,
  compareSettingsControlId,
  compareSettingsError,
  compareSettingsInput,
  compareResidentResult,
  compareSideLabel,
  compareTarget,
  compareTargetIsStale,
  type CompareTarget,
} from '../../lib/compare-view.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  keynessSelections,
  type KeynessSettingsInputV1,
} from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';
import { CompareProfile } from './CompareProfile.tsx';
import { CompareSettings } from './CompareSettings.tsx';
import { SignedAxis } from './SignedAxis.tsx';

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
  const setSelection = useApp((state) => state.setKeynessSelection);
  const swapSides = useApp((state) => state.swapKeynessSides);
  const applySettings = useApp((state) => state.applyKeynessSettings);
  const reverseDirections = useApp((state) => state.reverseKeynessDirections);
  const loadMore = useApp((state) => state.loadMoreKeyness);
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
  const sideLabelA = compareSideLabel('a', view, titleOf);
  const sideLabelB = compareSideLabel('b', view, titleOf);

  const writeTarget = (
    next: CompareTarget,
    returnFocusTo: string,
  ): boolean => {
    if (
      (renderedLayer && topLayer?.id !== renderedLayer.id)
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
  const closeRow = () => {
    if (rowTarget === null || topLayer?.id !== renderedLayer?.id) return false;
    popLayer();
    return true;
  };
  const sideControl = (side: 'a' | 'b') => {
    const isRest = view.mode === 'document-rest' && view.restOn === side;
    const doc = side === 'a' ? view.documentA : view.documentB;
    const otherIsRest = view.mode === 'document-rest' && view.restOn !== side;
    const otherDoc = side === 'a' ? view.documentB : view.documentA;
    const restExcludes = otherIsRest ? doc : otherDoc;
    return (
      <select
        className="exact-input"
        aria-label={`${side === 'a' ? 'Left' : 'Right'} comparison input`}
        value={isRest ? '__rest__' : doc ?? ''}
        onChange={(event) => setSelection(
          side,
          event.currentTarget.value === '__rest__'
            ? null
            : event.currentTarget.value,
        )}
      >
        <option value="__rest__">
          All other texts{restExcludes ? ` (except ${titleOf(restExcludes)})` : ''}
        </option>
        {readyDocs.map((candidate) => (
          <option
            key={candidate}
            value={candidate}
            disabled={!otherIsRest && candidate === otherDoc}
          >
            {titleOf(candidate)}
          </option>
        ))}
      </select>
    );
  };
  const scale = compareScale(stateA, stateB);
  const divergence = compareDivergence(stateA, stateB);
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
      {readyDocs.length < 2
        ? <p>Add at least two ready books to compare distinctive terms.</p>
        : (
          <>
            <div className="compare-definition">
              <label data-side="a">
                <span>left side</span>
                {sideControl('a')}
              </label>
              <button
                className="compare-swap"
                type="button"
                onClick={swapSides}
                aria-label="Swap keyness sides"
                title="Swap comparison sides"
              >
                <span aria-hidden="true">⇄</span>
              </button>
              <label data-side="b">
                <span>right side</span>
                {sideControl('b')}
              </label>
            </div>

            <div className="compare-warnings">
              {(['a', 'b'] as const).map((side) => {
                const table = side === 'a' ? stateA : stateB;
                const result = compareResidentResult(table);
                const totals = result === null
                  ? null
                  : side === 'a' ? result.totalsA : result.totalsB;
                return totals && totals.tokens < 10_000
                  ? (
                      <p key={side} role="note">
                        Small side {side.toUpperCase()} (&lt;10,000 selected-class
                        tokens): ranks may be unstable.
                      </p>
                    )
                  : null;
              })}
            </div>

            <div className="compare-view-bar">
              <div className="compare-view-actions">
                <button type="button" onClick={reverseDirections}>
                  reverse rankings
                </button>
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

            <CompareProfile
              inventoryA={inventoryA}
              inventoryB={inventoryB}
              divergence={divergence}
              sideLabelA={sideLabelA}
              sideLabelB={sideLabelB}
            />

            <SignedAxis
              stateA={stateA}
              stateB={stateB}
              view={view}
              scale={scale}
              rowTarget={rowTarget}
              sideLabelA={sideLabelA}
              sideLabelB={sideLabelB}
              onRow={openRow}
              onLoadMore={loadMore}
              onCloseRow={closeRow}
            />
          </>
        )}
    </section>
  );
}
