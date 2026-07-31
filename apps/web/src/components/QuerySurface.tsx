import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  GroupEditor,
  type GroupEditorDraft,
} from './GroupEditor.tsx';
import { FormLayer } from './FormLayer.tsx';
import { NotebookPanel } from './NotebookPanel.tsx';
import { SeriesLineSample } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import {
  queryEditorTarget,
  querySurfaceView,
  type QueryEditorTarget,
} from '../lib/query-surface.ts';
import type { GroupCountVM, NotebookRowVM } from '../lib/notebook-view.ts';
import { useApp } from '../lib/store-instance.ts';

const QUICK_ADD_LABEL = 'Add terms to the notebook, comma-separated';
const INLINE_FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function countLabel(count: GroupCountVM): string {
  switch (count.kind) {
    case 'not-run': return 'not run';
    case 'pending': return 'pending';
    case 'error': return 'error';
    case 'ready': return `${count.total}${count.partial ? ' partial' : ''}`;
    case 'selected':
      return count.selected.kind === 'ready'
        ? `${count.selected.total} selected / ${count.total}`
        : `${count.selected.kind} selected / ${count.total}`;
    default: {
      const exhaustive: never = count;
      return exhaustive;
    }
  }
}

function QuickAddForm({
  draft,
  compact,
  onDraft,
  onSubmit,
  onCancel,
}: {
  readonly draft: string;
  readonly compact: boolean;
  readonly onDraft: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <form
      className={compact ? 'query-editor-form' : 'quick-add-form'}
      aria-label={compact ? 'Quick add query terms' : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {compact && <h2>Quick add terms</h2>}
      <label className={compact ? 'query-editor-field' : undefined}>
        {compact && <span>Terms</span>}
        <input
          id="query-quick-add-input"
          className="exact-input quick-add-input"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          aria-label={QUICK_ADD_LABEL}
          placeholder="add terms: holmes, moriarty"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      {compact && (
        <div className="form-layer-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit">Add terms</button>
        </div>
      )}
    </form>
  );
}

function ChartFocusChip({
  row,
  focused,
  onFocus,
}: {
  readonly row: NotebookRowVM;
  readonly focused: boolean;
  readonly onFocus: () => void;
}) {
  const status = row.count.kind === 'error'
    ? 'error'
    : row.count.kind === 'pending'
      ? 'pending'
      : 'ready';
  return (
    <button
      type="button"
      className="query-focus-chip"
      onClick={onFocus}
      disabled={!row.projected}
      aria-pressed={focused}
      title={
        !row.projected
          ? `${row.name} is not shown in analysis`
          : status === 'error'
            ? 'query failed'
            : `emphasize “${row.name}” in the chart`
      }
    >
      <SeriesLineSample slot={row.slot ?? 0} emphasized={focused} />
      <span>{row.name}</span>
      <span className="query-count">{countLabel(row.count)}</span>
    </button>
  );
}

function CompactQueryKey({
  rows,
  focusedSeries,
  onFocus,
  onEdit,
  onQuickAdd,
}: {
  readonly rows: readonly NotebookRowVM[];
  readonly focusedSeries: string | null;
  readonly onFocus: (groupId: string) => void;
  readonly onEdit: (groupId: string, returnFocusTo: string) => void;
  readonly onQuickAdd: () => void;
}) {
  return (
    <>
      <strong className="compact-query-label">Terms</strong>
      <div className="compact-query-scroll" role="group" aria-label="Query terms">
        {rows.map((row) => (
          <span className="compact-query-item" key={row.id}>
            <ChartFocusChip
              row={row}
              focused={row.id === focusedSeries}
              onFocus={() => onFocus(row.id)}
            />
            <button
              type="button"
              id={`compact-query-edit-${row.id}`}
              className="compact-query-edit"
              aria-label={`Edit members: ${row.name}`}
              onClick={() => onEdit(row.id, `compact-query-edit-${row.id}`)}
            >
              edit
            </button>
          </span>
        ))}
        <button
          type="button"
          id="compact-query-add"
          className="compact-query-add"
          aria-label={QUICK_ADD_LABEL}
          onClick={onQuickAdd}
        >
          +
        </button>
      </div>
    </>
  );
}

function CompactQuerySummary({
  count,
  onOpenQueries,
  onQuickAdd,
}: {
  readonly count: number;
  readonly onOpenQueries: () => void;
  readonly onQuickAdd: () => void;
}) {
  return (
    <>
      <strong className="compact-query-label">Queries</strong>
      <div className="compact-query-summary">
        <button type="button" className="compact-query-route" onClick={onOpenQueries}>
          {count === 0 ? 'No groups' : `${count} ${count === 1 ? 'group' : 'groups'}`}
          {' · edit in Trends'}
        </button>
        <button
          type="button"
          id="compact-query-add"
          className="compact-query-add"
          aria-label={QUICK_ADD_LABEL}
          onClick={onQuickAdd}
        >
          +
        </button>
      </div>
    </>
  );
}

export function QuerySurface() {
  const presentation = usePresentation();
  const place = useApp((state) => state.place);
  const notebook = useApp((state) => state.notebook);
  const activeGroupIds = useApp((state) => state.activeGroupIds);
  const soloGroupId = useApp((state) => state.soloGroupId);
  const styleSlots = useApp((state) => state.styleSlots);
  const trends = useApp((state) => state.trends);
  const selectedTrends = useApp((state) => state.selectedTrends);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const snapshot = useApp((state) => state.snapshot);
  const focusedSeries = useApp((state) => state.focusedSeries);
  const layers = useApp((state) => state.layers);
  const quickAdd = useApp((state) => state.quickAdd);
  const setFocus = useApp((state) => state.setFocus);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);
  const setPlace = useApp((state) => state.setPlace);
  const [draft, setDraft] = useState('');
  const [inlineGroupId, setInlineGroupId] = useState<string | null>(null);
  const [inlineReturnFocusTo, setInlineReturnFocusTo] = useState<string | null>(null);
  const [groupDrafts, setGroupDrafts] = useState<Record<string, GroupEditorDraft>>({});

  const view = querySurfaceView({
    place,
    groups: notebook.groups,
    activeGroupIds,
    soloGroupId,
    styleSlots,
    trends,
    selectedTrends,
    hasSelection: linkedSelection !== null,
    hasSnapshot: snapshot !== null,
    partialCorpus: (snapshot?.missingDocs.length ?? 0) > 0,
  });
  const topLayer = layers.at(-1);
  const layerTarget = topLayer?.kind === 'row-detail'
    ? queryEditorTarget(topLayer.target)
    : null;
  const compact = presentation.width === 'compact';
  const activeGroupId =
    layerTarget?.mode === 'group' ? layerTarget.groupId : inlineGroupId;
  const activeGroup = notebook.groups.find((group) => group.id === activeGroupId) ?? null;
  const compactEditorOpen = compact && (layerTarget !== null || activeGroup !== null);
  const retainActiveGroupDraft = useCallback((next: GroupEditorDraft) => {
    if (!activeGroupId) return;
    setGroupDrafts((current) => ({
      ...current,
      [activeGroupId]: next,
    }));
  }, [activeGroupId]);

  useEffect(() => {
    if (compact || layerTarget === null) return undefined;
    const frame = requestAnimationFrame(() => {
      const equivalent = layerTarget.mode === 'quick-add'
        ? document.getElementById('query-quick-add-input')
        : document.querySelector('.query-inline-editor')
          ?.querySelector<HTMLElement>(INLINE_FOCUSABLE);
      equivalent?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [compact, layerTarget?.mode, layerTarget?.mode === 'group' ? layerTarget.groupId : null]);

  const writeEditorLayer = (
    target: QueryEditorTarget,
    returnFocusTo: string,
  ) => {
    if (layerTarget !== null) {
      replaceLayer('row-detail', Object.freeze(target), returnFocusTo);
    } else {
      pushLayer('row-detail', Object.freeze(target), returnFocusTo);
    }
  };
  const openGroup = (groupId: string, returnFocusTo: string) => {
    if (activeGroupId === groupId) {
      if (layerTarget !== null) popLayer();
      else setInlineGroupId(null);
      return;
    }
    if (compact) {
      setInlineGroupId(null);
      writeEditorLayer(
        { surface: 'query-editor', mode: 'group', groupId },
        returnFocusTo,
      );
    } else {
      setInlineGroupId(groupId);
      setInlineReturnFocusTo(returnFocusTo);
    }
  };
  const closeEditor = () => {
    if (activeGroupId) {
      setGroupDrafts(({ [activeGroupId]: _closed, ...remaining }) => remaining);
    }
    if (layerTarget !== null) {
      popLayer();
    } else {
      const returnFocusTo = inlineReturnFocusTo;
      setInlineGroupId(null);
      setInlineReturnFocusTo(null);
      requestAnimationFrame(() => {
        if (returnFocusTo) document.getElementById(returnFocusTo)?.focus();
      });
    }
  };
  const submitQuickAdd = () => {
    quickAdd(draft);
    setDraft('');
    if (layerTarget?.mode === 'quick-add') popLayer();
  };
  const openQuickAdd = () => writeEditorLayer(
    { surface: 'query-editor', mode: 'quick-add' },
    'compact-query-add',
  );
  const compactModal = compact && layerTarget?.mode === 'quick-add'
    ? (
        <FormLayer
          label="Quick add query terms"
          focusKey="quick-add"
          onClose={closeEditor}
        >
          <QuickAddForm
            draft={draft}
            compact
            onDraft={setDraft}
            onSubmit={submitQuickAdd}
            onCancel={closeEditor}
          />
        </FormLayer>
      )
    : activeGroup && compact
      ? (
          <FormLayer
            label={`Query editor: ${activeGroup.name}`}
            focusKey={activeGroup.id}
            onClose={closeEditor}
          >
            <GroupEditor
              group={activeGroup}
              onClose={closeEditor}
              {...(groupDrafts[activeGroup.id]
                ? { initialDraft: groupDrafts[activeGroup.id] }
                : {})}
              onDraftChange={retainActiveGroupDraft}
            />
          </FormLayer>
        )
      : null;

  return (
    <>
      <aside
        className="query-region"
        aria-label="Queries"
        data-uses-query-encoding={view.usesQueryEncoding}
      >
        {!compact && (
          <>
            <strong className="region-label">Queries</strong>
            <QuickAddForm
              draft={draft}
              compact={false}
              onDraft={setDraft}
              onSubmit={submitQuickAdd}
              onCancel={() => undefined}
            />
            {view.rows.length === 0
              ? <p className="region-placeholder">No query groups.</p>
              : (
                  <div className="query-focus-key" aria-label="Chart focus">
                    {view.rows.map((row) => (
                      <ChartFocusChip
                        key={row.id}
                        row={row}
                        focused={row.id === focusedSeries}
                        onFocus={() => setFocus(row.id)}
                      />
                    ))}
                  </div>
                )}
            <NotebookPanel
              rows={view.rows}
              activeEditorGroupId={activeGroupId}
              onEdit={openGroup}
            />
          </>
        )}
        {compact && !compactEditorOpen && (
          view.usesQueryEncoding
            ? (
                <CompactQueryKey
                  rows={view.rows}
                  focusedSeries={focusedSeries}
                  onFocus={setFocus}
                  onEdit={openGroup}
                  onQuickAdd={openQuickAdd}
                />
              )
            : (
                <CompactQuerySummary
                  count={view.rows.length}
                  onOpenQueries={() => setPlace('trends')}
                  onQuickAdd={openQuickAdd}
                />
              )
        )}
        {activeGroup && !compact && (
          <div
            className="query-inline-editor"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeEditor();
              }
            }}
          >
            <GroupEditor
              group={activeGroup}
              onClose={closeEditor}
              {...(groupDrafts[activeGroup.id]
                ? { initialDraft: groupDrafts[activeGroup.id] }
                : {})}
              onDraftChange={retainActiveGroupDraft}
            />
          </div>
        )}
      </aside>
      {compactModal}
    </>
  );
}
