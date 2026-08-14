/** The Inputs composition surface: a durable local library beside one ordered
 * active input set. Acquisitions enter the library first; native drag-and-drop
 * then covers OS files, library activation, and input reordering. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
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
import { inputResetCopy } from '../lib/input-reset-view.ts';
import { useApp } from '../lib/store-instance.ts';

const LIBRARY_DRAG = 'application/x-texttrends-library-file';
const ACTIVE_DRAG = 'application/x-texttrends-active-document';
const LIBRARY_BUSY_NOTICE = 'Another input is being saved. Try again when it finishes.';

function sourceLabel(status: SourceStatus | undefined): string {
  switch (status?.phase) {
    case 'bundled': return 'bundled';
    case 'library': return 'local library';
    case 'error': return status.message;
    default: return '—';
  }
}

function fileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

const dropListStyle = {
  listStyle: 'none',
  margin: 'var(--space-2) 0 0',
  padding: 0,
  display: 'grid',
  gap: '3px',
} as const;

export function ProjectPanel() {
  const project = useApp((s) => s.projectSession?.project ?? null);
  const docs = useApp((s) => s.projectSession?.project.data.docs ?? null);
  const imports = useApp((s) => s.projectSession?.imports ?? null);
  const sources = useApp((s) => s.projectSession?.sources ?? null);
  const mergeStarterTerms = useApp((s) => s.mergeStarterTerms);
  const importFiles = useApp((s) => s.importFiles);
  const removeImport = useApp((s) => s.removeImport);
  const removeDocument = useApp((s) => s.removeDocument);
  const removeDocuments = useApp((s) => s.removeDocuments);
  const clearActiveInputsAndTerms = useApp((s) => s.clearActiveInputsAndTerms);
  const termCount = useApp((s) => s.notebook.groups.length);
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
  const [libraryFilter, setLibraryFilter] = useState('');
  const filteredLibrary = useMemo(() => {
    if (libraryFilter === '') return { items: library, invalid: false };
    try {
      const expression = new RegExp(libraryFilter, 'iu');
      return {
        items: library.filter((item) => expression.test(item.name)),
        invalid: false,
      };
    } catch {
      return { items: library, invalid: true };
    }
  }, [library, libraryFilter]);
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
  const [activeNotice, setActiveNotice] = useState<string | null>(null);
  const [reorderNotice, setReorderNotice] = useState('');
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
  const importLabel = 'Add files';
  const finalizedDocs = docs ?? [];
  const pendingImports = imports ?? [];
  const canReorder = pendingImports.length === 0 && finalizedDocs.length > 1;
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
    setNotice: (message: string | null) => void = setLibraryNotice,
  ): Promise<{ readonly ok: boolean; readonly activated: number }> => {
    if (files.length === 0) return { ok: false, activated: 0 };
    const claimedHere = existingLease === undefined;
    const lease = existingLease ?? claimLibrary();
    if (lease === null || !libraryOperation.owns(lease)) {
      setNotice(LIBRARY_BUSY_NOTICE);
      return { ok: false, activated: 0 };
    }
    setLibraryError(null);
    setNotice(null);
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
        setNotice(duplicateNotice(savedDuplicates, activation.duplicates));
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
      if (claimedHere) releaseLibrary(lease);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const loadDemo = async (id: BuiltinCorpusId) => {
    const lease = claimLibrary();
    if (lease === null) {
      setDemoNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    setDemoLoading(id);
    setDemoError(null);
    setDemoNotice(null);
    try {
      const demo = await fetchDemoCorpus(id);
      const acquired = await acquire(demo.files, true, undefined, lease, setDemoNotice);
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
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
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
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
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
    if (libraryOperation.isBusy()) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    if (library.length === 0 && libraryError === null) return;
    const prompt = library.length === 0
      ? 'Delete all saved texts from the local library?'
      : `Delete all ${library.length} saved text${library.length === 1 ? '' : 's'} from the local library?`;
    if (!window.confirm(prompt)) return;
    const lease = claimLibrary();
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
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
      void acquire([...event.dataTransfer.files], true, undefined, undefined, setActiveNotice);
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
    setActiveNotice(null);
    const index = order.indexOf(moved);
    const title = finalizedDocs.find((document) => document.doc === moved)?.meta.title ?? 'Text';
    setReorderNotice(`${title} moved to position ${index + 1} of ${order.length}.`);
  };

  const moveDocument = (doc: string, direction: -1 | 1): void => {
    if (!canReorder) return;
    const order = finalizedDocs.map((document) => document.doc);
    const from = order.indexOf(doc);
    const to = from + direction;
    if (from < 0) return;
    const title = finalizedDocs[from]!.meta.title;
    if (to < 0 || to >= order.length) {
      setReorderNotice(`${title} is already ${direction < 0 ? 'first' : 'last'}.`);
      return;
    }
    [order[from], order[to]] = [order[to]!, order[from]!];
    reorder(order);
    setActiveNotice(null);
    setReorderNotice(`${title} moved to position ${to + 1} of ${order.length}.`);
  };

  const clearActive = (): void => {
    const textCount = finalizedDocs.length + pendingImports.length;
    if (textCount === 0 && termCount === 0) return;
    if (libraryOperation.isBusy()) {
      setActiveNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    const copy = inputResetCopy(textCount, termCount);
    if (!window.confirm(copy.confirmation)) return;
    const lease = claimLibrary();
    if (lease === null) {
      setActiveNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    try {
      const cleared = clearActiveInputsAndTerms();
      if (cleared.texts + cleared.terms === 0) return;
      setReorderNotice('');
      setActiveNotice(inputResetCopy(cleared.texts, cleared.terms).notice);
    } finally {
      releaseLibrary(lease);
    }
  };

  return (
    <section className="input-workspace">
      <div className="input-card-grid">
        <section
          className="input-card input-card-active"
          aria-labelledby="active-inputs-heading"
          onDragEnter={() => setDropTarget('active')}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes(ACTIVE_DRAG) ? 'move' : 'copy';
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={(event) => dropOnActive(event, null)}
          style={{ outline: dropTarget === 'active' ? '2px solid var(--accent)' : undefined, outlineOffset: '-2px' }}
        >
          <div className="input-card-heading-row">
            <h4 id="active-inputs-heading">Active inputs</h4>
            <span>{finalizedDocs.length + pendingImports.length} text{finalizedDocs.length + pendingImports.length === 1 ? '' : 's'}</span>
            <span className="input-card-spacer" />
            <button
              type="button"
              aria-disabled={libraryBusy || (finalizedDocs.length + pendingImports.length === 0 && termCount === 0)}
              aria-label={inputResetCopy(finalizedDocs.length + pendingImports.length, termCount).accessibleName}
              onClick={clearActive}
              style={SMALL_BUTTON_STYLE}
            >
              Clear all
            </button>
          </div>
          <p className="input-card-help">
            These texts are analyzed in this order. Drop saved or new files here; drag rows or use the move buttons to reorder.
          </p>
          {finalizedDocs.length === 0 && pendingImports.length === 0 && (
            <p className="input-card-empty">No active inputs. Nothing is being analyzed.</p>
          )}
          <p
            className={activeNotice ? 'input-card-status' : 'visually-hidden'}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {activeNotice ?? reorderNotice}
          </p>
          <ol aria-label="Active input order" style={dropListStyle}>
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
                  className="active-input-row"
                  style={{ cursor: canReorder ? 'grab' : 'default' }}
                >
                  <span className="active-input-position">{index + 1}</span>
                  <span className="active-input-title">
                    <span>{doc.meta.title}</span>{' '}
                    <span style={{ color: sourceError ? 'var(--accent-text)' : 'var(--fg-muted)' }}>{sourceLabel(status)}</span>
                  </span>
                  <span className="active-input-actions">
                    <button
                      type="button"
                      disabled={!canReorder}
                      aria-disabled={!canReorder || index === 0}
                      onClick={() => moveDocument(doc.doc, -1)}
                      style={SMALL_BUTTON_STYLE}
                      aria-label={`Move ${doc.meta.title} up`}
                    >
                      up
                    </button>
                    <button
                      type="button"
                      disabled={!canReorder}
                      aria-disabled={!canReorder || index === finalizedDocs.length - 1}
                      onClick={() => moveDocument(doc.doc, 1)}
                      style={SMALL_BUTTON_STYLE}
                      aria-label={`Move ${doc.meta.title} down`}
                    >
                      down
                    </button>
                    <button type="button" onClick={() => removeDocument(doc.doc)} style={SMALL_BUTTON_STYLE} aria-label={`Remove ${doc.meta.title} from active inputs`}>
                      remove
                    </button>
                  </span>
                </li>
              );
            })}
            {pendingImports.map((item, index) => (
              <li key={item.doc} className="active-input-row active-input-row-pending">
                <span className="active-input-position">{finalizedDocs.length + index + 1}</span>
                <span className="active-input-title">{item.sourceName}</span>
                <span>{item.status === 'failed' ? 'import failed' : item.published ? 'analyzing…' : 'importing…'}</span>
                {item.status === 'failed' && (
                  <button type="button" onClick={() => removeImport(item.doc)} style={SMALL_BUTTON_STYLE} aria-label={`Remove failed import ${item.sourceName}`}>
                    remove
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section
          className="input-card"
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
          style={{ outline: dropTarget === 'library' ? '2px solid var(--accent)' : undefined, outlineOffset: '-2px' }}
        >
          <div className="input-card-heading-row">
            <h4 id="local-library-heading">Local library</h4>
            <span>{library.length} text{library.length === 1 ? '' : 's'}</span>
            <span className="input-card-spacer" />
            <label className="input-file-label" data-disabled={libraryBusy || undefined}>
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
              />
            </label>
            <button type="button" disabled={libraryBusy || (library.length === 0 && libraryError === null)} onClick={() => void clearSaved()} style={SMALL_BUTTON_STYLE}>
              Delete all
            </button>
          </div>
          <p className="input-card-help">
            Drop files here to save them without activating them. Filter filenames with a case-insensitive regular expression.
          </p>
          {libraryError && <p role="alert" className="input-card-error">{libraryError}</p>}
          <p role="status" aria-live="polite" className="input-card-status">{libraryNotice ?? (libraryLoading ? 'loading saved texts…' : '')}</p>
          {!libraryLoading && library.length === 0 && <p className="input-card-empty">No saved texts yet.</p>}
          <div className="local-library-filter-row">
            <label htmlFor="local-library-filter">filter (regex)</label>
            <input
              id="local-library-filter"
              type="search"
              value={libraryFilter}
              disabled={libraryLoading || library.length === 0}
              aria-invalid={filteredLibrary.invalid || undefined}
              aria-describedby="local-library-filter-status"
              aria-label="Filter saved texts by filename"
              placeholder="filename pattern"
              spellCheck={false}
              onChange={(event) => setLibraryFilter(event.target.value)}
            />
            <button
              type="button"
              disabled={libraryFilter === ''}
              onClick={() => setLibraryFilter('')}
              style={SMALL_BUTTON_STYLE}
              aria-label="Clear library filter"
            >
              clear
            </button>
          </div>
          <p
            id="local-library-filter-status"
            className={`local-library-filter-status${filteredLibrary.invalid ? ' local-library-filter-status-invalid' : ''}`}
            aria-live="polite"
          >
            {filteredLibrary.invalid
              ? `Invalid regular expression; showing all ${library.length} saved text${library.length === 1 ? '' : 's'}.`
              : `${filteredLibrary.items.length} of ${library.length} saved text${library.length === 1 ? '' : 's'} shown.`}
          </p>
          {!libraryLoading
            && library.length > 0
            && !filteredLibrary.invalid
            && filteredLibrary.items.length === 0
            && <p className="input-card-empty">No saved texts match this regular expression.</p>}
          <div
            className="local-library-list-port"
            role="region"
            aria-label="Saved text results"
            tabIndex={filteredLibrary.items.length > 0 ? 0 : undefined}
          >
            <ul aria-label="Saved texts" className="local-library-list">
              {filteredLibrary.items.map((file) => (
                <li
                  key={file.id}
                  draggable={!libraryBusy}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(LIBRARY_DRAG, file.id);
                    event.dataTransfer.setData('text/plain', file.name);
                  }}
                  className="local-library-row"
                  style={{ cursor: libraryBusy ? 'default' : 'grab' }}
                >
                  <span className="local-library-name" title={file.name}>{file.name}</span>
                  <span className="local-library-size">{fileSize(file.size)}</span>
                  <button type="button" disabled={libraryBusy} onClick={() => void activateSaved(file.id)} style={SMALL_BUTTON_STYLE} aria-label={`Add ${file.name} to active inputs`}>
                    add
                  </button>
                  <button type="button" disabled={libraryBusy} onClick={() => void removeSaved(file.id)} style={SMALL_BUTTON_STYLE} aria-label={`Delete ${file.name} from local library`}>
                    delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="input-card input-card-standard-ebooks" aria-labelledby="standard-ebooks-heading">
          <h4 id="standard-ebooks-heading">Load from Standard Ebooks</h4>
          <p className="input-card-help">Browse a built-in catalog of carefully produced public-domain ebooks. Added books are saved locally and activated.</p>
          <CatalogPanel onAcquire={async (files, signal, lease) => (await acquire(files, true, signal, lease)).ok} />
        </section>

        <section className="input-card" aria-labelledby="demo-corpora-heading">
          <h4 id="demo-corpora-heading">Load demo</h4>
          <p className="input-card-help">Add a prepared corpus to your local library. Suggested terms are appended without replacing yours.</p>
          <div className="demo-actions">
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
          {demoError && <p role="alert" className="input-card-error">{demoError}</p>}
          <p role="status" aria-live="polite" aria-atomic="true" className="input-card-status">
            {demoLoading ? `Loading ${builtinCorpusOption(demoLoading)!.label} demo…` : demoNotice ?? ''}
          </p>
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
