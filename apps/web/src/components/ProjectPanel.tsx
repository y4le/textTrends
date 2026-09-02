/** The Inputs composition surface: a durable local library beside one ordered
 * active input set. Acquisitions enter the library first; native drag-and-drop
 * then covers OS files, library activation, and input reordering. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { CatalogPanel } from './CatalogPanel.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import {
  demoLoadNotice,
  LIBRARY_BUSY_NOTICE,
  loadDemoCorpus,
} from '../lib/demo-loader.ts';
import {
  localFileIdentity,
  localLibrary,
  type LocalFileInput,
  type LocalLibraryFile,
  type LocalLibraryItem,
} from '../lib/local-library.ts';
import {
  builtinCorpusOption,
  demoCorpusFixtures,
  FEATURED_DEMO_IDS,
  SOURCE_FILE_ACCEPT,
  type BuiltinCorpusId,
} from '../lib/project.ts';
import type { SourceStatus } from '../lib/project-session.ts';
import { libraryOperation } from '../lib/library-operation.ts';
import { inputResetCopy } from '../lib/input-reset-view.ts';
import { useApp } from '../lib/store-instance.ts';

const LIBRARY_DRAG = 'application/x-texttrends-library-file';
const ACTIVE_DRAG = 'application/x-texttrends-active-document';
const FEATURED_LIBRARY_IDS = new Map(
  FEATURED_DEMO_IDS.map((id) => [
    id,
    new Set(demoCorpusFixtures(id).map((document) => localFileIdentity('txt', document.sourceHash))),
  ]),
);

function sourceLabel(status: SourceStatus | undefined): string {
  switch (status?.phase) {
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
  const saveRef = useRef<HTMLInputElement>(null);
  const acquisitionToggleRef = useRef<HTMLButtonElement>(null);
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
  const [acquisitionOverride, setAcquisitionOverride] = useState<boolean | null>(null);
  const [catalogOverride, setCatalogOverride] = useState<boolean | null>(null);
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

  const finalizedDocs = docs ?? [];
  const pendingImports = imports ?? [];
  const inputCount = finalizedDocs.length + pendingImports.length;
  const acquisitionExpanded = acquisitionOverride ?? inputCount === 0;
  const catalogExpanded = catalogOverride ?? inputCount === 0;
  const previousAcquisitionExpandedRef = useRef(acquisitionExpanded);

  useLayoutEffect(() => {
    const wasExpanded = previousAcquisitionExpandedRef.current;
    previousAcquisitionExpandedRef.current = acquisitionExpanded;
    if (wasExpanded && !acquisitionExpanded && document.activeElement === document.body) {
      acquisitionToggleRef.current?.focus({ preventScroll: true });
    }
  }, [acquisitionExpanded]);

  if (!project) return null;
  const importLabel = 'Add files — import and analyze';
  const canReorder = pendingImports.length === 0 && finalizedDocs.length > 1;
  activeIdentityRef.current = new Set(finalizedDocs.flatMap((doc) => doc.library === undefined ? [] : [doc.library]));
  if (pendingImports.length > 0) sawPendingImportsRef.current = true;
  else if (sawPendingImportsRef.current) {
    pendingActivationRef.current.clear();
    sawPendingImportsRef.current = false;
  }
  const activeLibraryIds = [
    ...finalizedDocs.flatMap((document) => document.library === undefined ? [] : [document.library]),
    ...pendingImports.map((item) => item.library),
  ];
  const demoActions = FEATURED_DEMO_IDS.map((id) => {
    const option = builtinCorpusOption(id)!;
    const fixtures = demoCorpusFixtures(id);
    const fixtureIds = FEATURED_LIBRARY_IDS.get(id)!;
    const activeCount = new Set(activeLibraryIds.filter((libraryId) => fixtureIds.has(libraryId))).size;
    const savedCount = library.filter((item) => fixtureIds.has(item.id)).length;
    const allActive = activeCount === fixtures.length;
    const shortName = option.shortLabel;
    const label = demoLoading === id
      ? `Adding ${shortName} sample…`
      : allActive
        ? `All ${shortName} texts are active`
        : savedCount === fixtures.length
          ? `Activate saved ${shortName} texts`
          : activeCount > 0 || savedCount > 0
            ? `Add missing ${shortName} texts`
            : inputCount === 0
              ? `Try the ${option.label} sample`
              : `Add ${shortName} sample`;
    return {
      id,
      label,
      unavailable: demoLoading !== null || libraryBusy || allActive,
    };
  });
  const loadingDemoLabel = demoLoading === null ? null : builtinCorpusOption(demoLoading)?.label ?? 'demo';

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
  ): Promise<{ readonly ok: boolean; readonly activated: number; readonly firstDocument: string | null }> => {
    if (files.length === 0) return { ok: false, activated: 0, firstDocument: null };
    const claimedHere = existingLease === undefined;
    const lease = existingLease ?? claimLibrary();
    if (lease === null || !libraryOperation.owns(lease)) {
      setNotice(LIBRARY_BUSY_NOTICE);
      return { ok: false, activated: 0, firstDocument: null };
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
      const firstLibrary = results[0]?.item.id;
      const session = useApp.getState().projectSession;
      const firstDocument = firstLibrary === undefined || session === null
        ? null
        : session.project.data.docs.find((doc) => doc.library === firstLibrary)?.doc
          ?? session.imports.find((item) => item.library === firstLibrary)?.doc
          ?? null;
      return {
        ok: signal?.aborted !== true && activation.accepted,
        activated: activation.activated,
        firstDocument,
      };
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
      await refreshLibrary(false); // quota failures may have committed earlier files
      return { ok: false, activated: 0, firstDocument: null };
    } finally {
      if (claimedHere) releaseLibrary(lease);
      if (importRef.current) importRef.current.value = '';
      if (saveRef.current) saveRef.current.value = '';
    }
  };

  const loadDemo = async (id: BuiltinCorpusId) => {
    setDemoLoading(id);
    setDemoError(null);
    setDemoNotice(null);
    try {
      const result = await loadDemoCorpus(id, 'additive', { getState: useApp.getState });
      await refreshLibrary();
      setDemoNotice(demoLoadNotice(result, 'additive'));
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : String(error));
    } finally {
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
      setDemoError(null);
      setDemoNotice(null);
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
            <span>{inputCount} text{inputCount === 1 ? '' : 's'}</span>
            <span className="input-card-spacer" />
            <button
              type="button"
              aria-disabled={libraryBusy || (inputCount === 0 && termCount === 0)}
              aria-label={inputResetCopy(inputCount, termCount).accessibleName}
              onClick={clearActive}
              style={SMALL_BUTTON_STYLE}
            >
              Clear all
            </button>
          </div>
          <p className="input-card-help">
            These texts are analyzed in this order. Drop saved or new files here; drag rows or use the move buttons to reorder.
          </p>
          {inputCount === 0 && (
            <>
              <p className="input-card-empty">No active inputs. Nothing is being analyzed.</p>
              <p className="input-card-empty input-card-next-step">
                Add a text, then track a term.
              </p>
            </>
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

        <section className="input-card input-card-acquisition" aria-labelledby="input-acquisition-heading">
          <div className="input-card-heading-row">
            <h4 id="input-acquisition-heading">Add texts</h4>
            <span className="input-card-spacer" />
            <button
              ref={acquisitionToggleRef}
              type="button"
              className="input-acquisition-toggle"
              aria-expanded={acquisitionExpanded}
              aria-controls="input-acquisition-options"
              onClick={() => setAcquisitionOverride(!acquisitionExpanded)}
              style={SMALL_BUTTON_STYLE}
            >
              {acquisitionExpanded ? 'Hide options' : 'Show options'}
            </button>
          </div>
          <div className={`input-acquisition-primary${acquisitionExpanded ? '' : ' input-acquisition-primary-collapsed'}`}>
            {acquisitionExpanded && (
              <p className="input-sample-copy">
                <strong>{inputCount === 0 ? 'Start with your text' : 'Add more of your text'}</strong>
                <span>Choose text, Markdown, HTML, EPUB, or PDF files to save locally and analyze now.</span>
              </p>
            )}
            <label className="input-file-label input-file-label-primary" data-disabled={libraryBusy || undefined}>
              Import and analyze
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
            <p className="input-acquisition-trust">Processed in your browser · never uploaded.</p>
          </div>
          {acquisitionExpanded && (
            <div id="input-acquisition-options" className="input-acquisition-options">
              <div className="input-sample">
                <p className="input-sample-copy">
                  <strong>Try a prepared sample</strong>
                  <span>Public-domain texts and useful starter terms are added without replacing your work.</span>
                </p>
                <div className="input-sample-actions">
                  {demoActions.map((action) => (
                    <button
                      key={`${action.id}-sample`}
                      type="button"
                      aria-disabled={action.unavailable}
                      aria-busy={demoLoading === action.id || undefined}
                      onClick={() => {
                        if (!action.unavailable) void loadDemo(action.id);
                      }}
                      style={SMALL_BUTTON_STYLE}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {demoError && <p role="alert" className="input-card-error input-sample-message">{demoError}</p>}
                <p role="status" aria-live="polite" aria-atomic="true" className="input-card-status input-sample-message">
                  {loadingDemoLabel ? `Adding the ${loadingDemoLabel} sample…` : demoNotice ?? ''}
                </p>
              </div>

              <div className="input-catalog-disclosure">
                <button
                  type="button"
                  className="input-catalog-summary"
                  aria-expanded={catalogExpanded}
                  aria-controls="input-catalog-body"
                  onClick={() => setCatalogOverride(!catalogExpanded)}
                >
                  <span>Browse Standard Ebooks</span>
                  <span>Search a public-domain catalog</span>
                </button>
                {catalogExpanded && (
                  <div id="input-catalog-body" className="input-catalog-body">
                    <CatalogPanel onAcquire={async (files, signal, lease) => (await acquire(files, true, signal, lease)).ok} />
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section
          className="input-card input-card-library"
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
              Save to library
              <input
                ref={saveRef}
                type="file"
                multiple
                accept={SOURCE_FILE_ACCEPT}
                aria-label="Save files to library"
                disabled={libraryBusy}
                onChange={(event) => {
                  if (event.target.files) void acquire([...event.target.files], false);
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
