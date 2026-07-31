import { useMemo } from 'react';
import { MAX_PINNED_SNIPPETS } from '../lib/pins.ts';
import { scopeView } from '../lib/scope-view.ts';
import { useApp } from '../lib/store-instance.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import { pinCapacity } from '../lib/pin-capacity.ts';

export function ScopeBar() {
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const projectSession = useApp((state) => state.projectSession);
  const pins = useApp((state) => state.pins);
  const pinRestoreIssues = useApp((state) => state.pinRestoreIssues);
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
          ? { kind: project.kind, docCount: project.data.order.length }
          : null,
        snapshot,
        inventory,
        linkedSelection,
        titleByDoc,
        pins: {
          // This is the collection MAX_PINNED_SNIPPETS actually caps. Durable
          // anchors that failed restoration remain visible via needingReview
          // but do not consume a live pin slot.
          used: pins.length,
          cap: MAX_PINNED_SNIPPETS,
          needingReview: pinRestoreIssues.length,
        },
        loadingPhase: bootstrapPhase === 'initializing'
          ? 'preparing the built-in project…'
          : loadingPhase,
      },
      place,
    ),
    [
      bootstrapPhase,
      inventory,
      linkedSelection,
      loadingPhase,
      pins.length,
      pinRestoreIssues.length,
      place,
      project,
      snapshot,
      titleByDoc,
    ],
  );
  const selectionFullTokens = linkedSelection === null
    ? null
    : fullTokensByDoc(linkedSelection.doc, { inventory, trends });
  const isOnlyThisBook = linkedSelection !== null
    && linkedSelection.tokens.start === 0
    && linkedSelection.tokens.end === selectionFullTokens;
  const findingsLabel = pinCapacity(pins.length, MAX_PINNED_SNIPPETS).label;

  return (
    <section
      className="scope-organ"
      aria-label="Scope"
      style={{
        borderBottom: '1px solid var(--rule)',
        padding: 'var(--space-2) 0',
      }}
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
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '0 var(--space-2)',
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <strong
          style={{
            color: 'var(--fg)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
          }}
        >
          Scope
        </strong>
        {vm.segments.map((segment, index) => (
          <span key={`${index}:${segment}`} style={{ display: 'inline-flex', gap: '0.5ch' }}>
            {index > 0 && <span aria-hidden="true">·</span>}
            {index === 0
              ? (
                  <button
                    className="scope-organ-link coarse-target"
                    type="button"
                    onClick={() => setPlace('corpus')}
                  >
                    {segment}
                  </button>
                )
              : segment === findingsLabel
                ? (
                    <button
                      className="scope-organ-link coarse-target"
                      type="button"
                      onClick={() => setPlace('findings')}
                    >
                      {segment}
                    </button>
                  )
                : segment === vm.range?.label
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
      </div>
    </section>
  );
}
