import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeynessRowV1 } from '@texttrends/core';
import {
  compareDivergence,
  compareRowControlId,
  compareScale,
  compareSettingsControlId,
  compareSettingsInput,
  compareResidentResult,
  compareSideLabel,
  compareTarget,
  compareTargetIsStale,
  type CompareRowTarget,
} from '../../lib/compare-view.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  keynessSelections,
} from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';
import { contextualSettingsEntry } from '../../lib/settings-entry.ts';
import { useOpenSettings } from '../SettingsEntryContext.tsx';
import { CompareProfile } from './CompareProfile.tsx';
import { SignedAxis } from './SignedAxis.tsx';

export function ComparePanel() {
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const view = useApp((state) => state.keynessView);
  const stateA = useApp((state) => state.keynessA);
  const stateB = useApp((state) => state.keynessB);
  const inventoryA = useApp((state) => state.keynessInventoryA);
  const inventoryB = useApp((state) => state.keynessInventoryB);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const layers = useApp((state) => state.layers);
  const setSelection = useApp((state) => state.setKeynessSelection);
  const applySettings = useApp((state) => state.applyKeynessSettings);
  const loadMore = useApp((state) => state.loadMoreKeyness);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);
  const openSettings = useOpenSettings();
  const [profileOpen, setProfileOpen] = useState(false);
  const topLayer = layers.at(-1);
  const renderedLayer = useMemo(
    () => renderedRowDetailLayer(layers),
    [layers],
  );
  const target = useMemo(
    () => renderedLayer ? compareTarget(renderedLayer.target) : null,
    [renderedLayer],
  );
  const rowTarget = target;
  const stalePopRequested = useRef(false);

  useEffect(() => {
    stalePopRequested.current = false;
  }, [renderedLayer?.id]);

  const readyDocs = snapshot?.readyDocs ?? [];
  const comparison = snapshot
    ? keynessSelections({
        view,
        readyDocs: snapshot.readyDocs,
        selection: linkedSelection,
        tokenCountOf: (doc) => corpusTokenCounts.get(doc),
      })
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
    next: CompareRowTarget,
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

  const reverseRankings = () => applySettings({
    ...compareSettingsInput(view),
    dirA: view.sort.dirA === 1 ? -1 : 1,
    dirB: view.sort.dirB === 1 ? -1 : 1,
  });
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
  return (
    <section className="compare-panel" aria-label="Keyness comparison">
      {readyDocs.length < 2
        ? <p>Add at least two ready books to compare distinctive terms.</p>
        : (
          <>
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

            <div className="compare-definition">
              <button
                className="compare-reverse"
                type="button"
                onClick={reverseRankings}
                aria-label="Swap — Reverse both rankings"
                title="Reverse ranking directions"
              >
                Swap
              </button>
              <label data-side="a">
                {sideControl('a')}
              </label>
              <button
                className="compare-profile-trigger"
                type="button"
                aria-label="Text profile"
                aria-expanded={profileOpen}
                aria-controls="compare-text-profile"
                title={`${profileOpen ? 'Hide' : 'Show'} text profile`}
                onClick={() => setProfileOpen((open) => !open)}
              >
                Profile
              </button>
              <label data-side="b">
                {sideControl('b')}
              </label>
              <button
                id={compareSettingsControlId}
                className="compare-settings-trigger"
                type="button"
                aria-label="Compare settings"
                aria-haspopup="dialog"
                title="Compare settings"
                onClick={(event) => openSettings(
                  contextualSettingsEntry('compare'),
                  event.currentTarget,
                )}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                </svg>
              </button>
            </div>

            <SignedAxis
              stateA={stateA}
              stateB={stateB}
              view={view}
              scale={scale}
              rowTarget={rowTarget}
              sideLabelA={sideLabelA}
              sideLabelB={sideLabelB}
              profileOpen={profileOpen}
              profileContent={(
                <CompareProfile
                  inventoryA={inventoryA}
                  inventoryB={inventoryB}
                  divergence={divergence}
                  sideLabelA={sideLabelA}
                  sideLabelB={sideLabelB}
                />
              )}
              onRow={openRow}
              onLoadMore={loadMore}
              onCloseRow={closeRow}
            />
          </>
        )}
    </section>
  );
}
