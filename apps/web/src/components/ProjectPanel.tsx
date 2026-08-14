/** The Scope composition surface: a durable local library beside one ordered
 * active corpus. Acquisitions enter the library first; native drag-and-drop
 * then covers OS files, library-to-corpus activation, and corpus reordering. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { CatalogPanel } from './CatalogPanel.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { fetchDemoCorpus } from '../lib/demo-corpora.ts';
import {
  localFileIdentity,
  localLibrary,
  type LocalFileInput,
  type LocalLibraryFile,
  type LocalLibraryItem,
} from '../lib/local-library.ts';
import { BUILTIN_CORPORA, builtinCorpusOption, SOURCE_FILE_ACCEPT, type BuiltinCorpusId } from '../lib/project.ts';
import type { SourceStatus } from '../lib/project-session.ts';
import { libraryOperation } from '../lib/library-operation.ts';
import { useApp } from '../lib/store-instance.ts';

const LIBRARY_DRAG = 'application/x-texttrends-library-file';
const ACTIVE_DRAG = 'application/x-texttrends-active-document';

function sourceLabel(status: SourceStatus | undefined): string {
  switch (status?.phase) {
    case 'bundled': return 'bundled';
    case 'library': return 'on this device';
    case 'error': return status.message;
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
  const mergeStarterTerms = useApp((s) => s.mergeStarterTerms);
  const importFiles = useApp((s) => s.importFiles);
  const removeImport = useApp((s) => s.removeImport);
  const removeDocument = useApp((s) => s.removeDocument);
  const removeDocuments = useApp((s) => s.removeDocuments);
  const reorder = useApp((s) => s.reorder);
  const workspacePersistence = useApp((s) => s.workspacePersistence);
  const retryWorkspaceSave = useApp((s) => s.retryWorkspaceSave);

  const importRef = useRef<HTMLInputElement>(null);
  const activeIdentityRef = useRef<ReadonlySet<string>>(new Set());
  const pendingActivationRef = useRef(new Set<string>());
  const sawPendingImportsRef = useRef(false);
  const [library, setLibrary] = useState<readonly LocalLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const libraryBusy = useSyncExternalStore(
    libraryOperation.subscribe,
    libraryOperation.isBusy,
    libraryOperation.isBusy,
  );
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<'library' | 'active' | null>(null);
  const [demoLoading, setDemoLoading] = useState<BuiltinCorpusId | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const claimLibrary = libraryOperation.claim;
  const releaseLibrary = libraryOperation.release;

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

  // Startup migration mutates the same durable library outside this component.
  // A project publication is therefore also a prompt to reconcile this view.
  useEffect(() => {
    if (docs !== null) void refreshLibrary(false);
  }, [docs, refreshLibrary]);

  if (!project) return null;
  const isBuiltin = project.kind === 'builtin';
  const builtinLabel = builtinCorpusOption(project.id)?.label ?? 'Built-in corpus';
  const importLabel = isBuiltin ? 'Create project from files' : 'Add files';
  const finalizedDocs = docs ?? [];
  const pendingImports = imports ?? [];
  const canReorder = !isBuiltin && pendingImports.length === 0 && finalizedDocs.length > 1;
  activeIdentityRef.current = new Set(finalizedDocs.flatMap((doc) => doc.library === undefined ? [] : [doc.library]));
  if (pendingImports.length > 0) sawPendingImportsRef.current = true;
  else if (sawPendingImportsRef.current) {
    pendingActivationRef.current.clear();
    sawPendingImportsRef.current = false;
  }

  const activateUnique = (
    files: readonly LocalLibraryFile[],
    items: readonly LocalLibraryItem[],
  ): { readonly duplicates: number; readonly activated: number; readonly accepted: boolean } => {
    const unique: LocalLibraryFile[] = [];
    const queuedIdentities: string[] = [];
    let duplicates = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const identity = localFileIdentity(item.format, item.contentHash);
      if (activeIdentityRef.current.has(identity) || pendingActivationRef.current.has(identity)) {
        duplicates += 1;
        continue;
      }
      pendingActivationRef.current.add(identity);
      queuedIdentities.push(identity);
      unique.push(files[index]!);
    }
    let activated = 0;
    let accepted = true;
    if (unique.length > 0) {
      accepted = importFiles(unique);
      if (accepted) activated = unique.length;
      if ((useApp.getState().projectSession?.imports.length ?? 0) === 0) {
        for (const identity of queuedIdentities) pendingActivationRef.current.delete(identity);
      }
    }
    return { duplicates, activated, accepted };
  };

  const duplicateNotice = (saved: number, active: number): string | null => {
    const parts: string[] = [];
    if (saved > 0) parts.push(`${saved} already saved`);
    if (active > 0) parts.push(`${active} already active`);
    return parts.length === 0 ? null : `${parts.join(' · ')} — no duplicate added`;
  };

  const acquire = async (
    files: readonly LocalFileInput[],
    activate = true,
    signal?: AbortSignal,
    existingLease?: symbol,
  ): Promise<{ readonly ok: boolean; readonly activated: number }> => {
    if (files.length === 0) return { ok: false, activated: 0 };
    const lease = existingLease ?? claimLibrary();
    if (lease === null || !libraryOperation.owns(lease)) return { ok: false, activated: 0 };
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      const results = await localLibrary.add(files);
      await refreshLibrary();
      const savedDuplicates = results.filter((result) => !result.added).length;
      const activation = activate && signal?.aborted !== true
        ? activateUnique(
            await Promise.all(results.map((result) => localLibrary.file(result.item.id))),
            results.map((result) => result.item),
          )
        : { duplicates: 0, activated: 0, accepted: true };
      if (signal?.aborted !== true) {
        setLibraryNotice(duplicateNotice(savedDuplicates, activation.duplicates));
      }
      return {
        ok: signal?.aborted !== true && activation.accepted,
        activated: activation.activated,
      };
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
      await refreshLibrary(false); // quota failures may have committed earlier files
      return { ok: false, activated: 0 };
    } finally {
      releaseLibrary(lease);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const loadDemo = async (id: BuiltinCorpusId) => {
    const lease = claimLibrary();
    if (lease === null) return;
    setDemoLoading(id);
    setDemoError(null);
    setDemoNotice(null);
    try {
      const demo = await fetchDemoCorpus(id);
      const acquired = await acquire(demo.files, true, undefined, lease);
      if (!acquired.ok) {
        setDemoError('The demo texts were saved, but could not be activated. Review the app message, then retry.');
        return;
      }
      const terms = mergeStarterTerms(demo.option.defaultTerms);
      const termText = terms.added === 0
        ? 'Starter terms were already present or the notebook is full.'
        : `${terms.added} starter term${terms.added === 1 ? '' : 's'} added${terms.activated < terms.added ? `; ${terms.activated} activated` : ''}.`;
      const inputText = acquired.activated === 0
        ? 'No new texts were activated.'
        : `${acquired.activated} local text${acquired.activated === 1 ? '' : 's'} activated.`;
      setDemoNotice(`${demo.option.label}: ${inputText} ${termText}`);
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
      setDemoLoading(null);
    }
  };

  const activateSaved = async (id: string) => {
    const lease = claimLibrary();
    if (lease === null) return;
    const item = library.find((candidate) => candidate.id === id);
    if (item === undefined) {
      setLibraryError('that saved file no longer exists');
      releaseLibrary(lease);
      return;
    }
    const identity = localFileIdentity(item.format, item.contentHash);
    if (activeIdentityRef.current.has(identity) || pendingActivationRef.current.has(identity)) {
      setLibraryNotice('1 already active — no duplicate added');
      releaseLibrary(lease);
      return;
    }
    pendingActivationRef.current.add(identity);
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      importFiles([await localLibrary.file(id)]);
      if ((useApp.getState().projectSession?.imports.length ?? 0) === 0) {
        pendingActivationRef.current.delete(identity);
      }
    } catch (error) {
      pendingActivationRef.current.delete(identity);
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
    }
  };

  const removeSaved = async (id: string) => {
    const lease = claimLibrary();
    if (lease === null) return;
    const liveDocuments = finalizedDocs
      .filter((doc) => doc.library === id)
      .map((doc) => doc.doc)
      .concat(pendingImports.filter((item) => item.library === id).map((item) => item.doc));
    try {
      const result = await localLibrary.delete(id);
      const removed = [...new Set([...liveDocuments, ...result.removedDocuments])];
      if (removed.length > 0) removeDocuments(removed);
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
    }
  };

  const clearSaved = async () => {
    if (libraryOperation.isBusy() || (library.length === 0 && libraryError === null)) return;
    const prompt = library.length === 0
      ? 'Delete all saved files from this device?'
      : `Delete all ${library.length} saved file${library.length === 1 ? '' : 's'} from this device?`;
    if (!window.confirm(prompt)) return;
    const lease = claimLibrary();
    if (lease === null) return;
    const liveDocuments = finalizedDocs
      .flatMap((doc) => doc.library === undefined ? [] : [doc.doc])
      .concat(pendingImports.map((item) => item.doc));
    try {
      const result = await localLibrary.clear();
      const removed = [...new Set([...liveDocuments, ...result.removedDocuments])];
      if (removed.length > 0) removeDocuments(removed);
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
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
          {isBuiltin ? `${builtinLabel} · built-in corpus (read-only)` : 'library corpus'}
        </Heading>
        <span style={{ flex: 1 }} />
      </div>

      <section aria-labelledby="demo-corpora-heading" style={{ ...panelStyle, marginTop: 'var(--space-2)' }}>
        <h4 id="demo-corpora-heading" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Load demo</h4>
        <p style={{ margin: 'var(--space-1) 0', color: 'var(--fg-muted)' }}>
          Demo texts are saved to your local library and added to Active inputs. Suggested terms are appended without replacing yours.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
          {BUILTIN_CORPORA.map((corpus) => (
            <button
              key={corpus.id}
              type="button"
              aria-disabled={demoLoading !== null || libraryBusy}
              aria-label={`Load ${corpus.label} demo`}
              aria-busy={demoLoading === corpus.id || undefined}
              onClick={() => {
                if (demoLoading === null && !libraryBusy) void loadDemo(corpus.id);
              }}
              style={SMALL_BUTTON_STYLE}
            >
              Load {corpus.label} demo
            </button>
          ))}
        </div>
        {demoError && <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0 0' }}>{demoError}</p>}
        <p role="status" aria-live="polite" aria-atomic="true" style={{ color: 'var(--fg-muted)', margin: demoLoading || demoNotice ? 'var(--space-1) 0 0' : 0 }}>
          {demoLoading
            ? `Loading ${builtinCorpusOption(demoLoading)!.label} demo…`
            : demoNotice ?? ''}
        </p>
      </section>

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
          {libraryNotice && <p role="status" style={{ color: 'var(--fg-muted)', margin: 'var(--space-1) 0 0' }}>{libraryNotice}</p>}
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
          <CatalogPanel onAcquire={async (files, signal) => { await acquire(files, true, signal); }} />
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
          </div>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }}>
            Drop saved or new files here. Drag active files to reorder them.
          </p>
          {finalizedDocs.length === 0 && pendingImports.length === 0 && (
            <p style={{ color: 'var(--fg-muted)', margin: 'var(--space-2) 0 0' }}>
              No active inputs. Nothing is being analyzed.
            </p>
          )}
          <ol aria-label="Documents" style={{ ...dropListStyle, counterReset: 'active-document' }}>
            {finalizedDocs.map((doc, index) => {
              const status = sources?.[doc.doc];
              const sourceError = status?.phase === 'error';
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
                    <span style={{ color: sourceError ? 'var(--accent-text)' : 'var(--fg-muted)' }}>{sourceLabel(status)}</span>
                  </span>
                  <span style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'baseline' }}>
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

      {workspacePersistence.phase === 'error' && (
        <div role="alert" style={{ margin: 'var(--space-1) 0 0' }}>
          {workspacePersistence.message}{' '}
          <button type="button" onClick={() => retryWorkspaceSave()} style={SMALL_BUTTON_STYLE}>retry</button>
        </div>
      )}
    </section>
  );
}
