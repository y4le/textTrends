/** The Scope composition surface: a durable local library beside one ordered
 * active corpus. Acquisitions enter the library first; native drag-and-drop
 * then covers OS files, library-to-corpus activation, and corpus reordering. */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { CatalogPanel } from './CatalogPanel.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import {
  localLibrary,
  type LocalFileInput,
  type LocalLibraryItem,
} from '../lib/local-library.ts';
import { BUILTIN_CORPORA, builtinCorpusOption, SOURCE_FILE_ACCEPT, type BuiltinCorpusId } from '../lib/project.ts';
import { projectSaveView } from '../lib/project-save-view.ts';
import type { SourceStatus } from '../lib/project-session.ts';
import { useApp } from '../lib/store-instance.ts';

const LIBRARY_DRAG = 'application/x-texttrends-library-file';
const ACTIVE_DRAG = 'application/x-texttrends-active-document';

function sourceLabel(status: SourceStatus | undefined): string {
  switch (status?.phase) {
    case 'bundled': return 'bundled';
    case 'external-attached': return `attached · ${status.name}`;
    case 'external-missing':
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

function fileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

const panelStyle = {
  border: '1px solid var(--rule)',
  padding: 'var(--space-2)',
  minWidth: 0,
} as const;

const dropListStyle = {
  listStyle: 'none',
  margin: 'var(--space-2) 0 0',
  padding: 0,
  display: 'grid',
  gap: '3px',
} as const;

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
  const openBuiltinCorpus = useApp((s) => s.openBuiltinCorpus);
  const importFiles = useApp((s) => s.importFiles);
  const removeImport = useApp((s) => s.removeImport);
  const removeDocument = useApp((s) => s.removeDocument);
  const reorder = useApp((s) => s.reorder);
  const doReattach = useApp((s) => s.reattach);
  const setPersistIntent = useApp((s) => s.setPersistIntent);
  const loadSavedProject = useApp((s) => s.loadSavedProject);
  const saveProject = useApp((s) => s.saveProject);
  const researchPersistence = useApp((s) => s.researchPersistence);
  const reloadResearch = useApp((s) => s.reloadResearch);
  const overwriteResearch = useApp((s) => s.overwriteResearch);
  const clearCommandError = useApp((s) => s.clearCommandError);

  const importRef = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<readonly LocalLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<'library' | 'active' | null>(null);

  const refreshLibrary = useCallback(async (clearError = true) => {
    try {
      setLibrary(await localLibrary.list());
      if (clearError) setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    void localLibrary.list().then(
      (items) => {
        if (!live) return;
        setLibrary(items);
        setLibraryError(null);
        setLibraryLoading(false);
      },
      (error: unknown) => {
        if (!live) return;
        setLibraryError(error instanceof Error ? error.message : String(error));
        setLibraryLoading(false);
      },
    );
    return () => { live = false; };
  }, []);

  if (!project) return null;
  const isBuiltin = project.kind === 'builtin';
  const builtinLabel = builtinCorpusOption(project.id)?.label ?? 'Built-in corpus';
  const saveView = projectSaveView(project);
  const importLabel = isBuiltin ? 'Create project from files' : 'Add files';
  const finalizedDocs = docs ?? [];
  const pendingImports = imports ?? [];
  const canReorder = !isBuiltin && pendingImports.length === 0 && finalizedDocs.length > 1;

  const acquire = async (files: readonly LocalFileInput[], activate = true, signal?: AbortSignal) => {
    if (files.length === 0 || libraryBusy) return;
    setLibraryBusy(true);
    setLibraryError(null);
    try {
      await localLibrary.add(files);
      await refreshLibrary();
      if (activate && signal?.aborted !== true) importFiles(files);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
      await refreshLibrary(false); // quota failures may have committed earlier files
    } finally {
      setLibraryBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const activateSaved = async (id: string) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    setLibraryError(null);
    try {
      importFiles([await localLibrary.file(id)]);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const removeSaved = async (id: string) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    try {
      await localLibrary.delete(id);
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const clearSaved = async () => {
    if (libraryBusy || (library.length === 0 && libraryError === null)) return;
    const prompt = library.length === 0
      ? 'Delete all saved files from this device?'
      : `Delete all ${library.length} saved file${library.length === 1 ? '' : 's'} from this device?`;
    if (!window.confirm(prompt)) return;
    setLibraryBusy(true);
    try {
      await localLibrary.clear();
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const dropOnActive = (event: DragEvent<HTMLElement>, before: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (event.dataTransfer.files.length > 0) {
      void acquire([...event.dataTransfer.files]);
      return;
    }
    const savedId = event.dataTransfer.getData(LIBRARY_DRAG);
    if (savedId) {
      void activateSaved(savedId);
      return;
    }
    const moved = event.dataTransfer.getData(ACTIVE_DRAG);
    if (!moved || !canReorder) return;
    if (moved === before) return;
    const order = finalizedDocs.map((doc) => doc.doc).filter((doc) => doc !== moved);
    const target = before === null ? order.length : order.indexOf(before);
    order.splice(target < 0 ? order.length : target, 0, moved);
    reorder(order);
  };

  return (
    <section
      aria-labelledby="project-heading"
      style={{
        marginTop: 'var(--space-3)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Heading id="project-heading" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
          {isBuiltin ? `${builtinLabel} · built-in corpus (read-only)` : 'your project'}
        </Heading>
        <span style={{ flex: 1 }} />
        {isBuiltin && (
          <label>
            Demo corpus{' '}
            <select
              aria-label="Demo corpus"
              value={project.id}
              onChange={(event) => openBuiltinCorpus(event.target.value as BuiltinCorpusId)}
              style={{ font: 'inherit' }}
            >
              {BUILTIN_CORPORA.map((corpus) => (
                <option key={corpus.id} value={corpus.id}>{corpus.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {commandError && (
        <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0' }}>
          {commandError}{' '}
          <button type="button" onClick={() => clearCommandError()} style={{ ...SMALL_BUTTON_STYLE, padding: '0 0.5ch' }}>
            dismiss
          </button>
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        <section
          aria-labelledby="local-library-heading"
          onDragEnter={() => setDropTarget('library')}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDropTarget(null);
            if (event.dataTransfer.files.length > 0) void acquire([...event.dataTransfer.files], false);
          }}
          style={{ ...panelStyle, outline: dropTarget === 'library' ? '2px solid var(--accent)' : undefined, outlineOffset: '-2px' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <h4 id="local-library-heading" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>On this device</h4>
            <span style={{ color: 'var(--fg-muted)' }}>{library.length} file{library.length === 1 ? '' : 's'}</span>
            <span style={{ flex: 1 }} />
            <label style={{ cursor: libraryBusy ? 'default' : 'pointer', opacity: libraryBusy ? 0.6 : 1 }}>
              {importLabel}
              <input
                ref={importRef}
                type="file"
                multiple
                accept={SOURCE_FILE_ACCEPT}
                aria-label={importLabel}
                disabled={libraryBusy}
                onChange={(event) => {
                  if (event.target.files) void acquire([...event.target.files]);
                }}
                style={{ display: 'none' }}
              />
            </label>
            <button type="button" disabled={libraryBusy || (library.length === 0 && libraryError === null)} onClick={() => void clearSaved()} style={SMALL_BUTTON_STYLE}>
              Delete all
            </button>
          </div>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }}>
            Drop files here to save them. Drag a saved file to the active corpus to use it.
          </p>
          {libraryError && <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0 0' }}>{libraryError}</p>}
          {libraryLoading && <p role="status" style={{ color: 'var(--fg-muted)' }}>loading saved files…</p>}
          {!libraryLoading && library.length === 0 && (
            <p style={{ color: 'var(--fg-muted)', margin: 'var(--space-2) 0 0' }}>No saved files yet.</p>
          )}
          <ul aria-label="Files on this device" style={dropListStyle}>
            {library.map((file) => (
              <li
                key={file.id}
                draggable={!libraryBusy}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData(LIBRARY_DRAG, file.id);
                  event.dataTransfer.setData('text/plain', file.name);
                }}
                style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', padding: '3px 0.5ch', borderTop: '1px solid var(--rule)', cursor: libraryBusy ? 'default' : 'grab' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.name}>{file.name}</span>
                <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{fileSize(file.size)}</span>
                <span style={{ flex: 1 }} />
                <button type="button" disabled={libraryBusy} onClick={() => void activateSaved(file.id)} style={SMALL_BUTTON_STYLE} aria-label={`Add ${file.name} to active corpus`}>
                  add
                </button>
                <button type="button" disabled={libraryBusy} onClick={() => void removeSaved(file.id)} style={SMALL_BUTTON_STYLE} aria-label={`Delete ${file.name} from this device`}>
                  delete
                </button>
              </li>
            ))}
          </ul>
          <CatalogPanel onAcquire={(files, signal) => acquire(files, true, signal)} />
        </section>

        <section
          aria-labelledby="active-files-heading"
          onDragEnter={() => setDropTarget('active')}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes(ACTIVE_DRAG) ? 'move' : 'copy';
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={(event) => dropOnActive(event, null)}
          style={{ ...panelStyle, outline: dropTarget === 'active' ? '2px solid var(--accent)' : undefined, outlineOffset: '-2px' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <h4 id="active-files-heading" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Active files</h4>
            <span style={{ color: 'var(--fg-muted)' }}>{finalizedDocs.length + pendingImports.length} file{finalizedDocs.length + pendingImports.length === 1 ? '' : 's'}</span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => loadSavedProject()} style={SMALL_BUTTON_STYLE}>Load saved project</button>
            {!isBuiltin && (
              <button type="button" disabled={!saveView.canSave} onClick={() => saveProject()} style={SMALL_BUTTON_STYLE}>
                {saveView.attention ? 'retry Save project' : 'Save project'}
              </button>
            )}
          </div>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }}>
            Drop saved or new files here. Drag active files to reorder them.
          </p>
          {saveView.showStatus && (
            <p role={saveView.attention ? 'alert' : 'status'} style={{ margin: 'var(--space-1) 0 0', color: saveView.attention ? 'var(--accent-text)' : 'var(--fg-muted)' }}>
              {saveView.label}
            </p>
          )}
          <ol aria-label="Documents" style={{ ...dropListStyle, counterReset: 'active-document' }}>
            {finalizedDocs.map((doc, index) => {
              const status = sources?.[doc.doc];
              const attachment = reattach?.[doc.doc];
              const missing = status?.phase === 'external-missing';
              const canPersist = !isBuiltin && doc.sourceAvailability === 'external' && status?.phase === 'external-attached';
              const canRetryPersist = !isBuiltin && doc.sourceAvailability === 'external' && status?.phase === 'persist-failed';
              return (
                <li
                  key={doc.doc}
                  draggable={canReorder}
                  onDragStart={(event) => {
                    if (!canReorder) return;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(ACTIVE_DRAG, doc.doc);
                    event.dataTransfer.setData('text/plain', doc.meta.title);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => dropOnActive(event, doc.doc)}
                  style={{ display: 'grid', gridTemplateColumns: '3ch minmax(12ch, 1fr) auto', alignItems: 'baseline', gap: 'var(--space-2)', padding: '3px 0.5ch', borderTop: '1px solid var(--rule)', cursor: canReorder ? 'grab' : 'default' }}
                >
                  <span style={{ color: 'var(--fg-muted)', textAlign: 'right' }}>{index + 1}</span>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <span>{doc.meta.title}</span>{' '}
                    <span style={{ color: missing ? 'var(--accent-text)' : 'var(--fg-muted)' }}>{sourceLabel(status)}</span>
                    {attachment?.phase === 'hashing' && <span style={{ color: 'var(--fg-muted)' }}> · hashing…</span>}
                    {attachment?.phase === 'mismatch' && <span style={{ color: 'var(--accent-text)' }}> · {attachment.message}</span>}
                  </span>
                  <span style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'baseline' }}>
                    {missing && (
                      <label style={{ cursor: 'pointer', color: 'var(--fg-muted)' }}>
                        reattach…
                        <input
                          type="file"
                          accept={SOURCE_FILE_ACCEPT}
                          aria-label={`Reattach source for ${doc.meta.title}`}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) doReattach(doc.doc, file);
                            event.target.value = '';
                          }}
                          style={{ display: 'none' }}
                        />
                      </label>
                    )}
                    {canPersist && <button type="button" onClick={() => setPersistIntent(doc.doc, true)} style={SMALL_BUTTON_STYLE}>persist</button>}
                    {canRetryPersist && <button type="button" onClick={() => setPersistIntent(doc.doc, true)} style={SMALL_BUTTON_STYLE}>Retry persist</button>}
                    {!isBuiltin && (
                      <button type="button" onClick={() => removeDocument(doc.doc)} style={SMALL_BUTTON_STYLE} aria-label={`Remove ${doc.meta.title} from active corpus`}>
                        remove
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
            {pendingImports.map((item) => (
              <li key={item.doc} style={{ display: 'flex', gap: 'var(--space-2)', padding: '3px 0.5ch', borderTop: '1px solid var(--rule)', color: 'var(--fg-muted)' }}>
                <span style={{ minWidth: '3ch', textAlign: 'right' }}>{finalizedDocs.length + pendingImports.indexOf(item) + 1}</span>
                <span>{item.sourceName}</span>
                <span>{item.status === 'failed' ? 'import failed' : item.published ? 'analyzing…' : 'importing…'}</span>
                {item.status === 'failed' && <button type="button" onClick={() => removeImport(item.doc)} style={SMALL_BUTTON_STYLE}>remove</button>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      {(researchPersistence.phase === 'conflict' || researchPersistence.phase === 'error') && (
        <div role="alert" style={{ margin: 'var(--space-1) 0 0' }}>
          {researchPersistence.message}{' '}
          <button type="button" onClick={() => reloadResearch()} style={SMALL_BUTTON_STYLE}>reload saved analysis state</button>{' '}
          {researchPersistence.phase === 'conflict' && (
            <button type="button" onClick={() => overwriteResearch()} style={SMALL_BUTTON_STYLE}>overwrite with this tab</button>
          )}
        </div>
      )}
    </section>
  );
}
