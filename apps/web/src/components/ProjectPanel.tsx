/**
 * Minimal project/import surface (commit 7c). The store is the sole data source
 * — this reads narrow slices of the projected `SessionState` and drives the
 * thin session-command wrappers. It is deliberately utilitarian: native file
 * input + drop to create/append a project, a document list with per-source
 * status and reattachment, persistence intent, and CAS save/load with dirty and
 * conflict display. The extended restart/corruption/failure matrix is commit 9;
 * structure-query and chapter correction are commit 8.
 *
 * The built-in corpus is visibly read-only: no Save/Persist/Reattach mutation
 * is ever enabled for it (its source is bundled, fetched from a URL).
 */

import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { useRef } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { SOURCE_FILE_ACCEPT } from '../lib/project.ts';
import { projectSaveView } from '../lib/project-save-view.ts';
import { CatalogPanel } from './CatalogPanel.tsx';
import type { SourceStatus } from '../lib/project-session.ts';

function sourceLabel(status: SourceStatus | undefined): string {
  switch (status?.phase) {
    case 'bundled': return 'bundled';
    case 'external-attached': return `attached · ${status.name}`;
    case 'external-missing':
      // Reattach-vs-repair must read differently: an external file simply
      // needs re-picking; a damaged/absent DURABLE copy is data needing repair.
      switch (status.repair) {
        case 'external-not-attached': return 'source missing — reattach the file';
        case 'persisted-missing': return 'persisted copy missing — reattach to repair';
        case 'persisted-corrupt': return 'persisted copy damaged — reattach to repair';
        case 'rehydrate-failed': return 'persisted copy unreadable — reattach to repair';
      }
    case 'persist-saving': return 'persisting…';
    case 'persist-failed': return `persist failed: ${status.message}`;
    case 'persisted': return 'persisted';
    default: return '—';
  }
}

export function ProjectPanel({
  headingAs: Heading = 'h2',
}: {
  readonly headingAs?: 'h2' | 'h3';
}) {
  const project = useApp((s) => s.projectSession?.project ?? null);
  const docs = useApp((s) => s.projectSession?.project.data.docs ?? null);
  const imports = useApp((s) => s.projectSession?.imports ?? null);
  const sources = useApp((s) => s.projectSession?.sources ?? null);
  const reattach = useApp((s) => s.projectSession?.reattach ?? null);
  const commandError = useApp((s) => s.commandError);
  const importFiles = useApp((s) => s.importFiles);
  const doReattach = useApp((s) => s.reattach);
  const setPersistIntent = useApp((s) => s.setPersistIntent);
  const loadSavedProject = useApp((s) => s.loadSavedProject);
  const setPlace = useApp((s) => s.setPlace);
  const clearCommandError = useApp((s) => s.clearCommandError);

  const importRef = useRef<HTMLInputElement>(null);

  if (!project) return null; // bootstrap not yet attached
  const isBuiltin = project.kind === 'builtin';
  const saveView = projectSaveView(project);
  const importLabel = isBuiltin ? 'Create project from files' : 'Add files';

  const onImport = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    importFiles([...fileList]);
    if (importRef.current) importRef.current.value = ''; // allow re-selecting the same file
  };

  return (
    <section
      aria-labelledby="project-heading"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onImport(e.dataTransfer.files);
      }}
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-2)',
        border: '1px solid var(--rule)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Heading id="project-heading" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
          {isBuiltin ? 'built-in corpus (read-only)' : 'your project'}
        </Heading>
        <span style={{ flex: 1 }} />
        <label style={{ cursor: 'pointer' }}>
          {importLabel}
          <input
            ref={importRef}
            type="file"
            multiple
            accept={SOURCE_FILE_ACCEPT}
            aria-label={importLabel}
            onChange={(e) => onImport(e.target.files)}
            style={{ display: 'none' }}
          />
        </label>
        <button
          type="button"
          onClick={() => loadSavedProject()}
          style={SMALL_BUTTON_STYLE}
        >
          Load saved project
        </button>
      </div>
      {saveView.showCorpusPointer && (
        <p
          role={saveView.attention ? 'alert' : 'status'}
          style={{ margin: 'var(--space-1) 0 0', color: saveView.attention ? 'var(--accent-text)' : 'var(--fg-muted)' }}
        >
          {saveView.label}{' '}
          <button
            type="button"
            onClick={() => setPlace('findings')}
            style={SMALL_BUTTON_STYLE}
          >
            Save and status in Findings
          </button>
        </p>
      )}

      {commandError && (
        <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0 0' }}>
          {commandError}{' '}
          <button type="button" onClick={() => clearCommandError()} style={{ ...SMALL_BUTTON_STYLE, padding: '0 0.5ch' }}>
            dismiss
          </button>
        </p>
      )}

      <ul aria-label="Documents" style={{ listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'grid', gap: '2px' }}>
        {(docs ?? []).map((doc) => {
          const status = sources?.[doc.doc];
          const r = reattach?.[doc.doc];
          const missing = status?.phase === 'external-missing';
          const canPersist = !isBuiltin && doc.sourceAvailability === 'external' && status?.phase === 'external-attached';
          // A failed persist retains the private File, so the user can retry —
          // re-issuing the same intent re-reads and re-posts the retained bytes.
          const canRetryPersist = !isBuiltin && doc.sourceAvailability === 'external' && status?.phase === 'persist-failed';
          return (
            <li key={doc.doc} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <span style={{ minWidth: '24ch' }}>{doc.meta.title}</span>
              <span style={{ color: missing ? 'var(--accent-text)' : 'var(--fg-muted)' }}>{sourceLabel(status)}</span>
              {r?.phase === 'hashing' && <span style={{ color: 'var(--fg-muted)' }}>hashing…</span>}
              {r?.phase === 'mismatch' && <span style={{ color: 'var(--accent-text)' }}>{r.message}</span>}
              {missing && (
                <label style={{ cursor: 'pointer', color: 'var(--fg-muted)' }}>
                  reattach…
                  <input
                    type="file"
                    accept={SOURCE_FILE_ACCEPT}
                    aria-label={`Reattach source for ${doc.meta.title}`}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) doReattach(doc.doc, f);
                      e.target.value = '';
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              )}
              {canPersist && (
                <button type="button" onClick={() => setPersistIntent(doc.doc, true)} style={SMALL_BUTTON_STYLE}>
                  persist
                </button>
              )}
              {canRetryPersist && (
                <button type="button" onClick={() => setPersistIntent(doc.doc, true)} style={SMALL_BUTTON_STYLE}>
                  Retry persist
                </button>
              )}
            </li>
          );
        })}
        {(imports ?? []).map((imp) => (
          <li key={imp.doc} style={{ display: 'flex', gap: 'var(--space-2)', color: 'var(--fg-muted)' }}>
            <span style={{ minWidth: '24ch' }}>{imp.sourceName}</span>
            <span>{imp.status === 'failed' ? 'import failed' : imp.published ? 'analyzing…' : 'importing…'}</span>
          </li>
        ))}
      </ul>
      <CatalogPanel />
    </section>
  );
}
