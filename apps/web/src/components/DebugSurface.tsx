import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePresentation } from './PresentationProvider.tsx';
import { UtilityPane } from './UtilityPane.tsx';
import { collectDebugDiagnostics, type DebugDiagnostics } from '../lib/debug-diagnostics.ts';
import { clearAllApplicationStorage, clearArtifactDatabase } from '../lib/debug-storage.ts';
import { demoLoadNotice, loadDemoCorpus } from '../lib/demo-loader.ts';
import { libraryOperation } from '../lib/library-operation.ts';
import { BUILTIN_CORPORA, builtinCorpusOption, type BuiltinCorpusId } from '../lib/project.ts';
import { isShortcutTypingTarget, shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import {
  restartWorker,
  shutdownAppForReload,
  useApp,
  workerDiagnostics,
} from '../lib/store-instance.ts';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unavailable';
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function shortIdentity(value: string | null): string {
  if (value === null) return '—';
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('The browser refused clipboard access.');
}

export function DebugSurface({ onClose }: { readonly onClose: () => void }) {
  const state = useApp((value) => value);
  const presentation = usePresentation();
  const libraryBusy = useSyncExternalStore(
    libraryOperation.subscribe,
    libraryOperation.isBusy,
    libraryOperation.isBusy,
  );
  const [diagnostics, setDiagnostics] = useState<DebugDiagnostics | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let live = true;
    setDiagnosticError(null);
    void collectDebugDiagnostics(state, presentation, workerDiagnostics()).then(
      (value) => {
        if (!live) return;
        setDiagnostics(value);
      },
      (error: unknown) => {
        if (!live) return;
        setDiagnosticError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => { live = false; };
  }, [presentation, revision, state.projectSession, state.snapshot, state.workspacePersistence]);

  const loadDemo = async (id: BuiltinCorpusId) => {
    const label = builtinCorpusOption(id)!.label;
    setWorking(`demo:${id}`);
    setStatus(`Loading ${label} demo…`);
    try {
      const result = await loadDemoCorpus(id, 'additive', { getState: useApp.getState });
      setStatus(demoLoadNotice(result, 'additive'));
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(null);
    }
  };

  const clearCache = async () => {
    if (!window.confirm('Clear the disposable analysis cache and reload textTrends? Your local library and workspace will be preserved.')) return;
    setWorking('cache');
    setStatus('Closing the app and clearing the analysis cache…');
    try {
      await shutdownAppForReload({ preserveWorkspace: true });
      await clearArtifactDatabase(indexedDB, () => {
        setStatus('Another textTrends tab is holding the cache open. Close it; clearing will then continue automatically.');
      });
      window.location.reload();
    } catch (error) {
      setStatus(`The cache could not be cleared: ${error instanceof Error ? error.message : String(error)}.`);
      setWorking(null);
    }
  };

  const fullReset = async () => {
    if (!window.confirm('Full reset deletes imported source bytes, the active corpus, notebook, workspace settings, and analysis cache from this browser. Continue?')) return;
    if (!window.confirm('This cannot be undone. Delete all textTrends browser data and reload?')) return;
    setWorking('reset');
    setStatus('Closing the app and deleting browser data…');
    try {
      await shutdownAppForReload();
      await clearAllApplicationStorage(indexedDB, sessionStorageOrNull(), () => {
        setStatus('Another textTrends tab is holding browser data open. Close it; the reset will then continue automatically.');
      });
      window.location.reload();
    } catch (error) {
      setStatus(`The full reset could not finish: ${error instanceof Error ? error.message : String(error)}. Reload the page to resume.`);
      setWorking(null);
    }
  };

  const busy = working !== null || libraryBusy;
  const storage = diagnostics?.storage;
  return (
    <UtilityPane
      title="Debug"
      subtitle="Sanitized runtime metadata and recovery tools. Diagnostics never include source text, query results, or imported bytes."
      focusKey="debug"
      className="debug-pane"
      layerClassName="debug-layer"
      closeKeyshortcuts={shortcutAria(['reader-close', 'show-debug'])}
      onClose={onClose}
      onKeyDown={(event) => {
        if (isShortcutTypingTarget(event.target)) return;
        if (!shortcutMatches(event, 'show-debug')) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="debug-sections">
        <section aria-labelledby="debug-runtime-heading">
          <h3 id="debug-runtime-heading">Runtime</h3>
          {diagnosticError && <p role="alert">Diagnostics unavailable: {diagnosticError}</p>}
          {!diagnostics && !diagnosticError && <p role="status">Collecting diagnostics…</p>}
          {diagnostics && (
            <dl className="debug-facts">
              <div><dt>Build</dt><dd>{diagnostics.build.mode} · {diagnostics.build.commit === null ? 'local build' : shortIdentity(diagnostics.build.commit)}</dd></div>
              <div><dt>Protocol</dt><dd>v{diagnostics.build.protocol}</dd></div>
              <div><dt>Worker</dt><dd>{diagnostics.worker.health} · {diagnostics.worker.restartCount} restart{diagnostics.worker.restartCount === 1 ? '' : 's'} · {diagnostics.worker.pendingRequests} pending</dd></div>
              <div><dt>Cache warning</dt><dd>{diagnostics.worker.lastStorageWarning?.code ?? 'none reported'}</dd></div>
              <div><dt>Workspace save</dt><dd>{diagnostics.workspace.persistence}</dd></div>
              <div><dt>Analysis</dt><dd>{diagnostics.workspace.analysis}</dd></div>
              <div><dt>Project</dt><dd>{diagnostics.workspace.projectKind} · {diagnostics.workspace.activeDocuments} active · {diagnostics.workspace.pendingImports} importing</dd></div>
              <div><dt>Import states</dt><dd>{Object.entries(diagnostics.workspace.pendingImportStates).map(([kind, count]) => `${kind} ${count}`).join(' · ') || 'none'}</dd></div>
              <div><dt>Route</dt><dd>{diagnostics.workspace.route.place} · {diagnostics.workspace.route.status} · layers {diagnostics.workspace.route.layers.join(' › ') || 'none'}</dd></div>
              <div><dt>Generation</dt><dd><code>{shortIdentity(diagnostics.workspace.generation)}</code></dd></div>
              <div><dt>Snapshot</dt><dd><code>{shortIdentity(diagnostics.workspace.snapshot)}</code></dd></div>
              <div><dt>Documents</dt><dd>{diagnostics.workspace.readyDocuments} ready · {diagnostics.workspace.missingDocuments} missing</dd></div>
              <div><dt>Token counts</dt><dd>{diagnostics.workspace.documentTokenCounts.length === 0 ? '—' : diagnostics.workspace.documentTokenCounts.join(', ')}</dd></div>
              <div><dt>Index recipe</dt><dd><code>{diagnostics.recipes.index.map(shortIdentity).join(', ') || '—'}</code></dd></div>
              <div><dt>Extraction recipes</dt><dd><code>{diagnostics.recipes.extraction.map(shortIdentity).join(', ') || '—'}</code></dd></div>
              <div><dt>Segmenters</dt><dd>{diagnostics.recipes.segmenters.map((item) => `${item.locale} / ${item.adapter}@${item.adapterVersion} / ${shortIdentity(item.probeHash)}`).join(', ') || '—'}</dd></div>
              <div><dt>Extraction warnings</dt><dd>{diagnostics.recipes.extractionDiagnostics.documents} observed · {diagnostics.recipes.extractionDiagnostics.decoderReplacements} replacements · {diagnostics.recipes.extractionDiagnostics.suspiciousControls} suspicious controls</dd></div>
            </dl>
          )}
        </section>

        <section aria-labelledby="debug-lanes-heading">
          <h3 id="debug-lanes-heading">Analysis lanes</h3>
          {diagnostics && (
            <dl className="debug-facts debug-facts-lanes">
              {Object.entries(diagnostics.lanes).map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{typeof value === 'string'
                    ? value
                    : Object.entries(value).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(' · ')}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section aria-labelledby="debug-storage-heading">
          <h3 id="debug-storage-heading">Storage and presentation</h3>
          {diagnostics && storage && (
            <dl className="debug-facts">
              <div><dt>Local library</dt><dd>{storage.localLibrary.files} files · {formatBytes(storage.localLibrary.bytes)}</dd></div>
              <div><dt>Origin storage</dt><dd>{formatBytes(storage.estimate.usage)} / {formatBytes(storage.estimate.quota)} · {storage.estimate.persisted === null ? 'persistence unknown' : storage.estimate.persisted ? 'persistent' : 'best effort'}</dd></div>
              <div><dt>Databases</dt><dd>{storage.databases.map((database) => `${database.name} v${database.version}${database.disposable ? ' (disposable)' : ''}`).join(' · ')}</dd></div>
              <div><dt>Viewport</dt><dd>{diagnostics.presentation.width} · {diagnostics.presentation.viewport.width}×{diagnostics.presentation.viewport.height} @ {diagnostics.presentation.viewport.devicePixelRatio}×</dd></div>
              <div><dt>Input</dt><dd>{diagnostics.presentation.coarseAvailable ? 'coarse pointer available' : 'precise pointer only'}</dd></div>
              <div><dt>Preferences</dt><dd>{diagnostics.presentation.colorScheme} · {diagnostics.presentation.reducedMotion ? 'reduced motion' : 'full motion'}</dd></div>
            </dl>
          )}
        </section>

        <section aria-labelledby="debug-demo-heading">
          <h3 id="debug-demo-heading">Demo corpora</h3>
          <p>Load prepared texts additively. Existing active texts, saved files, and terms are preserved.</p>
          <div className="debug-actions">
            {BUILTIN_CORPORA.map((corpus) => (
              <button
                key={corpus.id}
                type="button"
                aria-disabled={busy}
                aria-busy={working === `demo:${corpus.id}` || undefined}
                onClick={() => {
                  if (!busy) void loadDemo(corpus.id);
                }}
              >
                Load {corpus.label} demo
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="debug-actions-heading">
          <h3 id="debug-actions-heading">Recovery</h3>
          <div className="debug-actions">
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                useApp.getState().retryAnalysis();
                setStatus('Analysis retry requested.');
              }}
            >
              Retry analysis
            </button>
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                useApp.getState().retryWorkspaceSave();
                setStatus('Workspace save retry requested.');
              }}
            >
              Retry workspace save
            </button>
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                setStatus(restartWorker() ? 'Worker restarted; reopening the current analysis.' : 'The worker could not be restarted.');
                setRevision((value) => value + 1);
              }}
            >
              Restart worker
            </button>
            <button type="button" aria-disabled={busy || diagnostics === null} onClick={() => {
              if (busy || diagnostics === null) return;
              void copyText(`${JSON.stringify(diagnostics, null, 2)}\n`).then(
                () => setStatus('Diagnostics copied.'),
                (error: unknown) => setStatus(error instanceof Error ? error.message : String(error)),
              );
            }}>
              Copy diagnostics
            </button>
            <button type="button" aria-disabled={busy} onClick={() => {
              if (!busy) setRevision((value) => value + 1);
            }}>
              Refresh diagnostics
            </button>
            <button type="button" aria-disabled={busy} onClick={() => {
              if (!busy) void clearCache();
            }}>
              Clear cache
            </button>
            <button type="button" className="debug-danger" aria-disabled={busy} onClick={() => {
              if (!busy) void fullReset();
            }}>
              Full reset
            </button>
          </div>
          <p className="debug-recovery-note">
            Clear cache deletes only recomputable analysis artifacts. Full reset deletes both app databases and owned session settings.
          </p>
        </section>

        <p className="debug-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      </div>
    </UtilityPane>
  );
}
