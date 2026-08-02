import { useMemo } from 'react';
import { scopeView } from '../lib/scope-view.ts';
import { useApp } from '../lib/store-instance.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';

export function ScopeBar() {
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const projectSession = useApp((state) => state.projectSession);
  const pinRestoreIssues = useApp((state) => state.pinRestoreIssues);
  const loadingPhase = useApp((state) => state.loadingPhase);
  const bootstrapPhase = useApp((state) => state.bootstrap.phase);
  const setLinkedSelection = useApp((state) => state.setLinkedSelection);
  const trends = useApp((state) => state.trends);
  const place = useApp((state) => state.place);
  const setPlace = useApp((state) => state.setPlace);
  const layers = useApp((state) => state.layers);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);

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
  const methodLabel = place === 'trends' ? 'Method & settings' : 'Method';

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
        <button
          className="scope-organ-link coarse-target scope-findings-link"
          type="button"
          onClick={() => setPlace('findings')}
        >
          Findings
        </button>
        <button
          id="global-method-open"
          className="scope-organ-link coarse-target scope-method-link"
          type="button"
          onClick={() => {
            if (layers.at(-1)?.kind === 'sheet') {
              replaceLayer(
                'sheet',
                Object.freeze({ surface: 'method' }),
                'global-method-open',
                { detent: 'tall' },
              );
            } else {
              pushLayer(
                'sheet',
                Object.freeze({ surface: 'method' }),
                'global-method-open',
                { detent: 'tall' },
              );
            }
          }}
        >
          {methodLabel}
        </button>
      </div>
    </section>
  );
}
