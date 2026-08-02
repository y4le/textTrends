import { useCallback, useState } from 'react';
import { MAX_KWIC_TRACKS, NOTEBOOK_LIMITS_V1 } from '@texttrends/core';
import { FormLayer } from './FormLayer.tsx';
import { GroupEditor, type GroupEditorDraft } from './GroupEditor.tsx';
import { NotebookPanel } from './NotebookPanel.tsx';
import { SeriesLineSample } from './chrome.tsx';
import {
  queryEditorTarget,
  querySurfaceView,
  type QueryEditorTarget,
} from '../lib/query-surface.ts';
import { rowDetailSurface, rowDetailWrite } from '../lib/row-detail.ts';
import type { GroupCountVM, NotebookRowVM } from '../lib/notebook-view.ts';
import { useApp } from '../lib/store-instance.ts';

const QUICK_ADD_LABEL = 'Add terms to the notebook, comma-separated';

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
  onDraft,
  onSubmit,
  onCancel,
}: {
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <form
      className="query-editor-form"
      aria-label="Quick add query terms"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2>Quick add terms</h2>
      <label className="query-editor-field">
        <span>Terms</span>
        <input
          id="query-quick-add-input"
          className="exact-input quick-add-input"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          aria-label={QUICK_ADD_LABEL}
          placeholder="holmes, moriarty"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <p className="query-editor-help">
        Commas create separate folded token groups. You can refine aliases,
        phrases, matching, and overlap rules after adding them.
      </p>
      <div className="form-layer-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit">Add terms</button>
      </div>
    </form>
  );
}

function TermBucket({
  row,
  focused,
  onFocus,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly row: NotebookRowVM;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <span className="term-bucket" data-active={row.active || undefined}>
      <button
        type="button"
        className="term-bucket-focus"
        disabled={!row.projected}
        aria-pressed={focused}
        onClick={onFocus}
        title={row.projected ? `Emphasize ${row.name} in the chart` : `${row.name} is not shown`}
      >
        <SeriesLineSample slot={row.slot ?? 0} emphasized={focused} />
        <span className="term-bucket-name">{row.name}</span>
        <span className="term-bucket-count">{countLabel(row.count)}</span>
      </button>
      <button
        type="button"
        className="term-bucket-toggle"
        aria-label={`Shown in analysis: ${row.name}`}
        aria-pressed={row.active}
        onClick={onToggle}
        title={row.active ? 'Hide from analysis' : 'Show in analysis'}
      >
        <span aria-hidden="true">{row.active ? '✓' : '○'}</span>
      </button>
      <button
        type="button"
        id={`term-edit-${row.id}`}
        className="term-bucket-edit"
        aria-label={`Edit members: ${row.name}`}
        onClick={onEdit}
      >
        edit
      </button>
      <button
        type="button"
        className="term-bucket-remove"
        aria-label={`Remove ${row.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

export function QuerySurface() {
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
  const removedGroups = useApp((state) => state.removedGroups);
  const quickAdd = useApp((state) => state.quickAdd);
  const setFocus = useApp((state) => state.setFocus);
  const setGroupActive = useApp((state) => state.setGroupActive);
  const removeGroup = useApp((state) => state.removeGroup);
  const undoRemoveGroup = useApp((state) => state.undoRemoveGroup);
  const dismissRemovedGroup = useApp((state) => state.dismissRemovedGroup);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);
  const [draft, setDraft] = useState('');
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
  const target = topLayer?.kind === 'row-detail'
    ? queryEditorTarget(topLayer.target)
    : null;
  const activeGroup = target?.mode === 'group'
    ? notebook.groups.find((group) => group.id === target.groupId) ?? null
    : null;

  const writeLayer = (next: QueryEditorTarget, returnFocusTo: string) => {
    if (target?.mode === 'manage') {
      pushLayer('row-detail', Object.freeze(next), returnFocusTo);
      return;
    }
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      'query-editor',
    );
    if (write === 'replace') replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    else pushLayer('row-detail', Object.freeze(next), returnFocusTo);
  };
  const openGroup = (groupId: string, returnFocusTo: string) => writeLayer(
    { surface: 'query-editor', mode: 'group', groupId },
    returnFocusTo,
  );
  const closeEditor = () => {
    if (activeGroup) {
      setGroupDrafts(({ [activeGroup.id]: _closed, ...remaining }) => remaining);
    }
    popLayer();
  };
  const retainDraft = useCallback((next: GroupEditorDraft) => {
    if (!activeGroup) return;
    setGroupDrafts((current) => ({ ...current, [activeGroup.id]: next }));
  }, [activeGroup]);
  const submitQuickAdd = () => {
    quickAdd(draft);
    setDraft('');
    popLayer();
  };

  return (
    <>
      <aside
        className="query-region term-bar"
        aria-label="Terms"
        data-uses-query-encoding={view.usesQueryEncoding}
      >
        <strong className="term-bar-label">Terms</strong>
        <div className="term-bucket-port" role="group" aria-label="Query terms">
          {view.rows.length === 0 && (
            <span className="term-bar-empty">No terms yet.</span>
          )}
          {view.rows.map((row) => (
            <TermBucket
              key={row.id}
              row={row}
              focused={row.id === focusedSeries}
              onFocus={() => setFocus(row.id)}
              onToggle={() => setGroupActive(row.id, !row.active)}
              onEdit={() => openGroup(row.id, `term-edit-${row.id}`)}
              onRemove={() => removeGroup(row.id)}
            />
          ))}
        </div>
        <div className="term-bar-actions">
          <button
            id="term-add"
            type="button"
            aria-label={QUICK_ADD_LABEL}
            onClick={() => writeLayer({ surface: 'query-editor', mode: 'quick-add' }, 'term-add')}
          >
            + Add
          </button>
          <button
            id="term-manage"
            type="button"
            onClick={() => writeLayer({ surface: 'query-editor', mode: 'manage' }, 'term-manage')}
          >
            Manage <span aria-hidden="true">({view.rows.length})</span>
          </button>
        </div>
        {removedGroups.length > 0 && (
          <div className="term-undo" role="status">
            Removed {removedGroups.at(-1)!.group.name}.
            {' '}<button type="button" onClick={undoRemoveGroup}>Undo</button>
            {' '}<button type="button" onClick={dismissRemovedGroup}>Dismiss</button>
          </div>
        )}
      </aside>

      {target?.mode === 'quick-add' && (
        <FormLayer label="Quick add query terms" focusKey="quick-add" onClose={closeEditor}>
          <QuickAddForm
            draft={draft}
            onDraft={setDraft}
            onSubmit={submitQuickAdd}
            onCancel={closeEditor}
          />
        </FormLayer>
      )}
      {target?.mode === 'manage' && (
        <FormLayer label="Manage terms" focusKey="manage-terms" onClose={closeEditor}>
          <section className="term-manager">
            <header className="term-manager-header">
              <div>
                <h2>Manage terms</h2>
                <p>
                  {view.rows.length} of {NOTEBOOK_LIMITS_V1.maxGroups} groups · up to{' '}
                  {MAX_KWIC_TRACKS} shown in analysis
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => writeLayer(
                    { surface: 'query-editor', mode: 'quick-add' },
                    'term-manager-add',
                  )}
                  id="term-manager-add"
                >
                  Add terms
                </button>
                <button type="button" onClick={closeEditor}>Done</button>
              </div>
            </header>
            <NotebookPanel
              rows={view.rows}
              activeEditorGroupId={null}
              onEdit={openGroup}
            />
          </section>
        </FormLayer>
      )}
      {activeGroup && (
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
            onDraftChange={retainDraft}
          />
        </FormLayer>
      )}
    </>
  );
}
