import { MAX_KWIC_TRACKS, NOTEBOOK_LIMITS_V1 } from '@texttrends/core';
import { FormLayer } from './FormLayer.tsx';
import { groupTitle } from '../lib/notebook.ts';
import { NotebookPanel } from './NotebookPanel.tsx';
import { SeriesLineSample } from './chrome.tsx';
import { DEFAULT_SERIES_STYLE } from '../lib/series-style.ts';
import {
  queryEditorTarget,
  querySurfaceView,
  termToggleControlId,
  type QueryEditorTarget,
} from '../lib/query-surface.ts';
import { rowDetailSurface, rowDetailWrite } from '../lib/row-detail.ts';
import type { GroupCountVM, NotebookRowVM } from '../lib/notebook-view.ts';
import { useApp } from '../lib/store-instance.ts';

const ADD_TERM_LABEL = 'Add term';

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

function TermBucket({
  row,
  onToggle,
  onEdit,
}: {
  readonly row: NotebookRowVM;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
}) {
  return (
    <span className="term-bucket" data-active={row.active || undefined}>
      <span
        className="term-bucket-summary"
        data-projected={row.projected || undefined}
      >
        <SeriesLineSample style={row.style ?? DEFAULT_SERIES_STYLE} emphasized={row.projected} />
        <span className="term-bucket-name">{row.name}</span>
        <span className="term-bucket-count">{countLabel(row.count)}</span>
      </span>
      <button
        id={termToggleControlId(row.id)}
        type="button"
        className="term-bucket-toggle"
        data-term-toggle
        data-term-id={row.id}
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
        aria-label={`Edit term: ${row.name}`}
        onClick={onEdit}
      >
        edit
      </button>
    </span>
  );
}

export function QuerySurface() {
  const place = useApp((state) => state.place);
  const notebook = useApp((state) => state.notebook);
  const activeGroupIds = useApp((state) => state.activeGroupIds);
  const soloGroupId = useApp((state) => state.soloGroupId);
  const styles = useApp((state) => state.styles);
  const trends = useApp((state) => state.trends);
  const selectedTrends = useApp((state) => state.selectedTrends);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const snapshot = useApp((state) => state.snapshot);
  const layers = useApp((state) => state.layers);
  const removedGroups = useApp((state) => state.removedGroups);
  const setGroupActive = useApp((state) => state.setGroupActive);
  const undoRemoveGroup = useApp((state) => state.undoRemoveGroup);
  const dismissRemovedGroup = useApp((state) => state.dismissRemovedGroup);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);

  const view = querySurfaceView({
    place,
    groups: notebook.groups,
    activeGroupIds,
    soloGroupId,
    styles,
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
  const writeLayer = (next: QueryEditorTarget, returnFocusTo: string) => {
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      'query-editor',
    );
    if (write === 'replace') replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    else pushLayer('row-detail', Object.freeze(next), returnFocusTo);
  };
  const openGroup = (groupId: string, returnFocusTo: string) => writeLayer(
    { surface: 'query-editor', mode: 'manage', groupId },
    returnFocusTo,
  );
  const closeEditor = () => popLayer();

  return (
    <>
      <aside
        className="query-region term-bar"
        aria-label="Terms"
        data-uses-query-encoding={view.usesQueryEncoding}
      >
        <strong className="term-bar-label">Terms</strong>
        <div
          className="term-bucket-port"
          role="group"
          aria-label="Query terms"
        >
          {view.rows.length === 0 && (
            <span className="term-bar-empty">No terms yet.</span>
          )}
          {view.rows.map((row) => (
            <TermBucket
              key={row.id}
              row={row}
              onToggle={() => setGroupActive(row.id, !row.active)}
              onEdit={() => openGroup(row.id, `term-edit-${row.id}`)}
            />
          ))}
        </div>
        <div className="term-bar-actions">
          <button
            id="term-add"
            type="button"
            aria-label={ADD_TERM_LABEL}
            onClick={() => writeLayer(
              { surface: 'query-editor', mode: 'manage', create: true },
              'term-add',
            )}
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
            Removed {groupTitle(removedGroups.at(-1)!.group)}.
            {' '}<button type="button" onClick={undoRemoveGroup}>Undo</button>
            {' '}<button type="button" onClick={dismissRemovedGroup}>Dismiss</button>
          </div>
        )}
      </aside>

      {target?.mode === 'manage' && (
        <FormLayer
          label="Manage terms"
          focusKey={target.groupId ?? (target.create ? 'new-term' : 'manage-terms')}
          onClose={closeEditor}
        >
          <section className="term-manager">
            <header className="term-manager-header">
              <div>
                <h2>Manage terms</h2>
                <p>
                  {view.rows.length} of {NOTEBOOK_LIMITS_V1.maxGroups} terms · up to{' '}
                  {MAX_KWIC_TRACKS} shown in analysis
                </p>
              </div>
            </header>
            <NotebookPanel
              rows={view.rows}
              onDone={closeEditor}
              {...(target.groupId ? { initialGroupId: target.groupId } : {})}
              {...(target.create ? { createOnOpen: true } : {})}
            />
          </section>
        </FormLayer>
      )}
    </>
  );
}
