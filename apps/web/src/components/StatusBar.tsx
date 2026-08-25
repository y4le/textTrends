import { useMemo } from 'react';
import { scopeView } from '../lib/scope-view.ts';
import { useApp } from '../lib/store-instance.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import { isWholeBookSelection } from '../lib/corpus-view.ts';
import { isSettingsPlace } from '../lib/settings-place.ts';

export function StatusBar({
  onOpenFind,
  onOpenSettings,
}: {
  readonly onOpenFind: () => void;
  readonly onOpenSettings: () => void;
}) {
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const projectSession = useApp((state) => state.projectSession);
  const loadingPhase = useApp((state) => state.loadingPhase);
  const bootstrapPhase = useApp((state) => state.bootstrap.phase);
  const setLinkedSelection = useApp((state) => state.setLinkedSelection);
  const trends = useApp((state) => state.trends);
  const place = useApp((state) => state.place);
  const setPlace = useApp((state) => state.setPlace);

  const project = projectSession?.project ?? null;
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
        pendingInputCount: projectSession?.imports.length ?? 0,
        snapshot,
        inventory,
        linkedSelection,
        titleByDoc,
        loadingPhase: bootstrapPhase === 'initializing'
          ? 'preparing your inputs…'
          : loadingPhase,
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
      projectSession?.imports.length,
      snapshot,
      titleByDoc,
    ],
  );
  const onlyRange = linkedSelection?.ranges.length === 1
    ? linkedSelection.ranges[0]!
    : null;
  const selectionFullTokens = onlyRange === null
    ? null
    : fullTokensByDoc(onlyRange.doc, { inventory, trends });
  const isOnlyThisBook = onlyRange !== null
    && selectionFullTokens !== null
    && isWholeBookSelection(linkedSelection, onlyRange.doc, selectionFullTokens);
  // Keep the persistent header quiet at whole-corpus scope. A committed range
  // remains visible because it carries navigation and clear actions; Compare's
  // range exception remains beside it. The complete status is still announced
  // through the live region above.
  const visibleSegments = vm.range === null
    ? []
    : [vm.range.label, ...(vm.exception === null ? [] : [vm.exception])];

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
      <div
        className="scope-organ-content"
        role="group"
        aria-label="Corpus and analysis status"
        tabIndex={0}
        onKeyDown={(event) => {
          // A focusable overflow region is not consistently keyboard-scrollable
          // across engines. Own the conventional horizontal keys when the
          // region itself (rather than one of its controls) has focus.
          if (event.target !== event.currentTarget) return;
          const region = event.currentTarget;
          const page = Math.max(40, Math.round(region.clientWidth * 0.8));
          switch (event.key) {
            case 'ArrowLeft':
              region.scrollBy({ left: -40 });
              break;
            case 'ArrowRight':
              region.scrollBy({ left: 40 });
              break;
            case 'Home':
              region.scrollTo({ left: 0 });
              break;
            case 'End':
              region.scrollTo({ left: region.scrollWidth });
              break;
            case 'PageUp':
              region.scrollBy({ left: -page });
              break;
            case 'PageDown':
              region.scrollBy({ left: page });
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
      >
        {visibleSegments.map((segment, index) => (
          <span key={`${index}:${segment}`} style={{ display: 'inline-flex', gap: '0.5ch' }}>
            {index > 0 && <span aria-hidden="true">·</span>}
            {segment === vm.range?.label
              ? (
                  <button
                    className="scope-organ-link coarse-target"
                    type="button"
                    aria-label={`${segment} — review linked range in Trends`}
                    onClick={() => setPlace('trends')}
                  >
                    {segment}
                  </button>
                )
              : <span>{segment}</span>}
            {segment === vm.range?.label && (
              <button
                className="coarse-target"
                type="button"
                aria-label={isOnlyThisBook ? 'All books' : 'Clear linked range'}
                onClick={() => setLinkedSelection(null)}
                style={{
                  font: 'inherit',
                  color: 'var(--fg)',
                  background: 'none',
                  border: 0,
                  borderBottom: '1px solid var(--rule-strong)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {isOnlyThisBook ? 'all books' : '× clear'}
              </button>
            )}
          </span>
        ))}
        <button
          id="global-find-open"
          className="scope-organ-link coarse-target"
          type="button"
          onClick={onOpenFind}
        >
          Find
        </button>
        {isSettingsPlace(place) && (
          <button
            id="global-settings-open"
            className="scope-organ-link coarse-target scope-settings-link"
            type="button"
            onClick={onOpenSettings}
          >
            Settings
          </button>
        )}
      </div>
    </section>
  );
}
