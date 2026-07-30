/**
 * The query notebook (slice-1 commit C): the authoritative group list behind
 * the comparison. Rendering rules live in lib/notebook-view.ts (pure,
 * unit-tested); this component only lays rows out and forwards intents.
 *
 * Control semantics (recorded ruling §3 — deliberately DISTINCT controls):
 * - "Shown in analysis" (active/mute) — membership in the whole comparison:
 *   trends, passage marks, KWIC eligibility;
 * - the CONCORDANCE chips stay in KwicPanel (orthogonal: hide one track
 *   from the table without touching the chart);
 * - chart FOCUS stays the header chips' job (emphasis only);
 * - solo — transient projection to one group; clearing restores exactly.
 * Reorder uses accessible Up/Down buttons (ruling: no drag requirement).
 * Member editing (aliases/phrases/affixes) arrives with commit D.
 */

import { Fragment, useState } from 'react';
import { GroupEditor } from './GroupEditor.tsx';
import { useApp } from '../lib/store-instance.ts';
import { notebookRows, type GroupCountVM } from '../lib/notebook-view.ts';
import { SeriesLineSample } from './chrome.tsx';

function CountCell({ count }: { count: GroupCountVM }) {
  const muted = { color: 'var(--fg-muted)' } as const;
  switch (count.kind) {
    case 'not-run': return <span style={muted}>not run</span>;
    case 'pending': return <span style={muted}>…</span>;
    case 'error': return <span style={{ color: 'var(--accent-text)' }} title={count.message}>error</span>;
    case 'selected': {
      const suffix = count.partial ? <span style={muted}> (partial)</span> : null;
      if (count.selected.kind === 'pending') {
        return <span><span style={muted}>… selected</span> / {count.total} corpus{suffix}</span>;
      }
      if (count.selected.kind === 'error') {
        return <span title={count.selected.message}><span style={{ color: 'var(--accent-text)' }}>error</span> / {count.total} corpus{suffix}</span>;
      }
      return <span>{count.selected.total} selected / {count.total} corpus{suffix}</span>;
    }
    default:
      return (
        <span title={count.partial ? 'total over the READY documents only' : 'total occurrences'}>
          {count.total}{count.partial ? <span style={muted}> (partial)</span> : null}
        </span>
      );
  }
}

const rowButton = {
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule)',
  cursor: 'pointer',
  padding: '0 0.5ch',
} as const;

export function NotebookPanel() {
  const notebook = useApp((s) => s.notebook);
  const activeGroupIds = useApp((s) => s.activeGroupIds);
  const soloGroupId = useApp((s) => s.soloGroupId);
  const styleSlots = useApp((s) => s.styleSlots);
  const trends = useApp((s) => s.trends);
  const selectedTrends = useApp((s) => s.selectedTrends);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const snapshot = useApp((s) => s.snapshot);
  const notebookError = useApp((s) => s.notebookError);
  const renameGroup = useApp((s) => s.renameGroup);
  const removeGroup = useApp((s) => s.removeGroup);
  const reorderGroups = useApp((s) => s.reorderGroups);
  const setGroupActive = useApp((s) => s.setGroupActive);
  const setSolo = useApp((s) => s.setSolo);
  const clearNotebookError = useApp((s) => s.clearNotebookError);
  // Rename drafts are local until commit (Enter/blur) — keystrokes must not
  // hit the store (and thus never a worker) per the draft-and-Apply rule.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // At most one member editor open (commit D); closing discards its draft.
  const [editing, setEditing] = useState<string | null>(null);

  if (notebook.groups.length === 0) return null;

  const rows = notebookRows({
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
  const order = notebook.groups.map((g) => g.id);
  const move = (id: string, delta: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    reorderGroups(next);
  };
  const commitRename = (id: string) => {
    const draft = drafts[id];
    if (draft === undefined) return;
    setDrafts(({ [id]: _done, ...rest }) => rest);
    const current = notebook.groups.find((g) => g.id === id);
    if (!current || draft.normalize('NFC') === current.name) return;
    renameGroup(id, draft.normalize('NFC'));
  };

  return (
    <section className="query-notebook" aria-labelledby="query-notebook-heading" style={{ marginTop: 'var(--space-2)' }}>
      <h3 id="query-notebook-heading" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
        Query notebook
      </h3>
      {notebookError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {notebookError}{' '}
          <button type="button" style={rowButton} onClick={clearNotebookError}>dismiss</button>
        </p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {rows.map((row, i) => (
          <Fragment key={row.id}>
          <li
            className="query-notebook-row"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              opacity: row.projected ? 1 : 0.55,
            }}
          >
            <SeriesLineSample slot={row.slot ?? 0} emphasized={row.projected} />
            <input
              className="exact-input"
              value={drafts[row.id] ?? row.name}
              onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
              onBlur={() => commitRename(row.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(row.id); }
              }}
              aria-label={`Group name: ${row.name}`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              style={{
                font: 'inherit',
                background: 'transparent',
                color: 'var(--fg)',
                border: 'none',
                borderBottom: '1px dashed var(--rule)',
                padding: '1px 0',
                width: '18ch',
              }}
            />
            <span style={{ minWidth: '8ch', textAlign: 'right' }}><CountCell count={row.count} /></span>
            <button
              type="button"
              style={rowButton}
              // STABLE group-qualified accessible name (review-C): several
              // rows carry this control, and the name must say WHICH group it
              // operates and never vary with the pressed state — aria-pressed
              // already conveys that; the checkmark is decorative.
              aria-label={`Shown in analysis: ${row.name}`}
              aria-pressed={row.active}
              onClick={() => setGroupActive(row.id, !row.active)}
              title={row.active ? 'remove from the comparison (keeps results settings)' : 'add to the comparison'}
            >
              <span aria-hidden="true">{row.active ? '✓ ' : ''}</span>shown in analysis
            </button>
            <button
              type="button"
              style={rowButton}
              aria-label={`Solo: ${row.name}`}
              aria-pressed={row.solo}
              onClick={() => setSolo(row.solo ? null : row.id)}
              title={row.solo ? 'end solo — restore the full comparison' : 'solo — temporarily show only this group'}
            >
              solo
            </button>
            <button type="button" style={rowButton} aria-label={`Move ${row.name} up`} disabled={i === 0} onClick={() => move(row.id, -1)}>↑</button>
            <button type="button" style={rowButton} aria-label={`Move ${row.name} down`} disabled={i === rows.length - 1} onClick={() => move(row.id, 1)}>↓</button>
            <button
              type="button"
              style={rowButton}
              aria-label={`Edit members: ${row.name}`}
              aria-expanded={editing === row.id}
              onClick={() => setEditing(editing === row.id ? null : row.id)}
            >edit</button>
            <button type="button" style={rowButton} aria-label={`Remove ${row.name}`} onClick={() => removeGroup(row.id)}>remove</button>
          </li>
          {editing === row.id && (
            <li style={{ listStyle: 'none' }}>
              <GroupEditor
                group={notebook.groups.find((g) => g.id === row.id)!}
                onClose={() => setEditing(null)}
              />
            </li>
          )}
          </Fragment>
        ))}
      </ul>
    </section>
  );
}
