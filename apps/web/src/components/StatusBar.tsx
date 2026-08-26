import { useMemo } from 'react';
import { scopeView } from '../lib/scope-view.ts';
import { useApp } from '../lib/store-instance.ts';
import { ScopeDetails, SCOPE_DETAILS_ID } from './ScopeDetails.tsx';

export function StatusBar() {
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const pendingInputCount = useApp((state) => state.projectSession?.imports.length ?? 0);
  const loadingPhase = useApp((state) => state.loadingPhase);
  const bootstrapPhase = useApp((state) => state.bootstrap.phase);
  const setLinkedSelection = useApp((state) => state.setLinkedSelection);
  const place = useApp((state) => state.place);
  const setPlace = useApp((state) => state.setPlace);
  const totalCorpusTokens = useApp((state) => {
    const order = state.projectSession?.project.data.order ?? [];
    if (order.length === 0) return null;
    let total = 0;
    for (const doc of order) {
      const tokens = state.corpusTokenCounts.get(doc);
      if (tokens === undefined) return null;
      total += tokens;
    }
    return total;
  });

  const titleByDoc = useMemo(
    () => new Map(
      (project?.data.docs ?? []).map((document) => [document.doc, document.meta.title] as const),
    ),
    [project],
  );
  const vm = useMemo(
    () => scopeView(
      {
        project: project
          ? { kind: project.kind, id: project.id, docCount: project.data.order.length }
          : null,
        pendingInputCount,
        snapshot,
        inventory,
        linkedSelection,
        titleByDoc,
        loadingPhase: bootstrapPhase === 'initializing'
          ? 'preparing your inputs…'
          : loadingPhase,
        totalCorpusTokens,
      },
      place,
    ),
    [
      bootstrapPhase,
      inventory,
      linkedSelection,
      loadingPhase,
      place,
      project,
      pendingInputCount,
      snapshot,
      titleByDoc,
      totalCorpusTokens,
    ],
  );
  const useAllTexts = () => {
    setLinkedSelection(null);
    requestAnimationFrame(() => {
      document.getElementById('global-find-open')?.focus({ preventScroll: true });
    });
  };

  return (
    <section
      className="scope-organ"
      aria-label="Corpus status"
    >
      <span
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {vm.announcement}
      </span>
      <div className="scope-organ-content">
        {vm.chip !== null && (
          <>
            <button
              id="scope-chip"
              className="scope-chip coarse-target"
              type="button"
              aria-label={vm.chip.accessibleName}
              popoverTarget={SCOPE_DETAILS_ID}
              data-narrowed={vm.chip.narrowed || undefined}
              data-partial={vm.chip.partial || undefined}
              data-has-magnitude={vm.chip.compactMagnitude !== null || undefined}
            >
              <span className="scope-chip-title scope-chip-title-expanded" aria-hidden="true">
                {vm.chip.expandedTitle}
              </span>
              <span className="scope-chip-title scope-chip-title-short" aria-hidden="true">
                {vm.chip.shortTitle}
              </span>
              {vm.chip.magnitude !== null && (
                <span className="scope-chip-magnitude scope-chip-magnitude-exact" aria-hidden="true">
                  {vm.chip.magnitude}
                </span>
              )}
              {vm.chip.compactMagnitude !== null && (
                <span className="scope-chip-magnitude scope-chip-magnitude-compact" aria-hidden="true">
                  {vm.chip.compactMagnitude}
                </span>
              )}
              {vm.chip.partial && (
                <span className="scope-chip-alert" aria-hidden="true">!</span>
              )}
            </button>
            <ScopeDetails
              vm={vm}
              canReviewRange={vm.range !== null && place !== 'trends'}
              onUseAllTexts={useAllTexts}
              onReviewRange={() => setPlace('trends')}
              onReviewInputs={() => setPlace('inputs')}
            />
          </>
        )}
      </div>
    </section>
  );
}
