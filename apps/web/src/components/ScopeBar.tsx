import { useMemo } from 'react';
import { MAX_PINNED_SNIPPETS } from '../lib/pins.ts';
import { scopeView } from '../lib/scope-view.ts';
import { useApp } from '../lib/store-instance.ts';

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
      // The long page's implicit place until routed places land in W1.3.
      'trends',
    ),
    [
      bootstrapPhase,
      inventory,
      linkedSelection,
      loadingPhase,
      pins.length,
      pinRestoreIssues.length,
      project,
      snapshot,
      titleByDoc,
    ],
  );

  return (
    <section
      aria-label="Scope"
      style={{
        borderBottom: '1px solid var(--rule)',
        padding: 'var(--space-2) 0',
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
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
            <span>{segment}</span>
            {segment === vm.range?.label && (
          <button
            className="coarse-target"
            type="button"
                aria-label="Clear linked range"
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
                × clear
              </button>
            )}
          </span>
        ))}
      </div>
    </section>
  );
}
