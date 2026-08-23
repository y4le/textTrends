/**
 * The app's composition root — the one place the synchronous React store, the
 * one `WorkerClient`, and the one `ProjectSession` are wired together. A
 * separate module lets tests
 * build a runtime with fakes without touching the Worker global.
 *
 * The store is exported synchronously, but the session needs the async-built
 * built-in `ProjectDataV1`. So the runtime is created synchronously and the
 * session is attached once, from an async bootstrap: construct the session
 * (which installs the sole generation-lane listeners) → attach the store
 * (subscribe + seed) → `start()`. No React effect starts a generation, so
 * Strict Mode's double mount cannot open a second one.
 *
 * Under `--mode e2e` (compile-time __TT_E2E__; dead-code-eliminated from the
 * normal production build), the client gets a passive sanitized protocol trace
 * and the page exposes a frozen read-only facade for the Playwright suite.
 */

import { reconcileWorkspaceDocuments, type WorkspaceV1 } from '@texttrends/core';
import { WorkerClient } from './client.ts';
import { RingTrace } from './trace.ts';
import type { ProjectSession, BundledByteProvider } from './project-session.ts';
import {
  createAppRuntime,
  emptyLibraryWorkspace,
  workspaceSemanticKey,
  type WorkspaceStorePort,
} from './store.ts';
import { createResumeMonitor } from './resume.ts';
import { browserHistoryPort } from './history-port.ts';
import { libraryOperation } from './library-operation.ts';
import { pendingAnalysisCount } from './pending-analyses.ts';
import {
  browserSessionStorage,
  loadMatchesColumnSettings,
  saveMatchesColumnSettings,
} from './matches-column-storage.ts';
import { consumeDemoBootRequest } from './demo-query.ts';
import { demoLoadNotice, loadDemoCorpus } from './demo-loader.ts';
import { findScope } from './interaction.ts';
import { RSVP_PACING_DEFAULTS, type RsvpPacing } from '@texttrends/rsvp';
import {
  browserLocalStorage,
  loadRsvpPacing,
  loadRsvpWpm,
  pacingFromLegacyWpm,
  saveRsvpPacing,
} from './rsvp-storage.ts';

// Consume the one-shot parameter before createAppRuntime performs any route
// replace. Otherwise the route layer correctly preserves this foreign key and
// the preset would run again after reload or place navigation.
const demoBootRequest = consumeDemoBootRequest(window);
const trace = __TT_E2E__ ? new RingTrace() : undefined;

const client = new WorkerClient(trace);
const matchesStorage = browserSessionStorage(window);
const restoredMatchesColumns = loadMatchesColumnSettings(matchesStorage);
const rsvpStorage = browserLocalStorage(window);
const storedRsvpPacing = loadRsvpPacing(rsvpStorage);
const legacyRsvpWpm = storedRsvpPacing === null ? loadRsvpWpm(matchesStorage) : null;
const restoredRsvpPacing = storedRsvpPacing
  ?? (legacyRsvpWpm === null ? RSVP_PACING_DEFAULTS : pacingFromLegacyWpm(legacyRsvpWpm));
if (storedRsvpPacing === null && legacyRsvpWpm !== null) {
  saveRsvpPacing(rsvpStorage, restoredRsvpPacing);
}
const runtime = createAppRuntime(client, {
  history: browserHistoryPort(window),
  ...(restoredMatchesColumns === null
    ? {}
    : { matchesColumns: restoredMatchesColumns }),
  rsvpPacing: restoredRsvpPacing,
});

/** The single React-facing store. */
export const useApp = runtime.useApp;

export const workerDiagnostics = () => client.diagnostics();

export function restartWorker(): boolean {
  return client.restartNow();
}

function pendingAnalyses(): number {
  const state = runtime.useApp.getState();
  return pendingAnalysisCount({
    inventory: state.inventory?.state,
    corpusInventory: state.corpusInventory?.state,
    other: [
      state.kwic?.state,
      state.dispersion?.state,
      state.company?.state,
      state.destinations?.state,
      state.selectedDispersion?.state,
      state.frequency?.state,
      state.keynessA?.state,
      state.keynessB?.state,
      state.keynessInventoryA?.state,
      state.keynessInventoryB?.state,
      state.footerPassage?.state,
      state.readerPage?.state,
      state.occurrenceNavigation?.state,
      findScope(state.interaction)?.find?.state ?? null,
    ],
    maps: [state.trends, state.selectedTrends],
  });
}

export const resumeMonitor = createResumeMonitor(window, () => {
  const state = runtime.useApp.getState();
  return {
    readyDocuments: state.snapshot?.readyDocs.length ?? 0,
    missingDocuments: state.snapshot?.missingDocs.length ?? 0,
    pendingAnalyses: pendingAnalyses(),
    loadingPhase: state.loadingPhase,
  };
});
const unsubscribeResumeState = runtime.useApp.subscribe(resumeMonitor.refresh);
let savedMatchesColumns = runtime.useApp.getState().matchesView.columns;
const unsubscribeMatchesColumns = runtime.useApp.subscribe((state) => {
  const columns = state.matchesView.columns;
  if (columns === savedMatchesColumns) return;
  savedMatchesColumns = columns;
  saveMatchesColumnSettings(matchesStorage, columns);
});
let savedRsvpPacing = JSON.stringify(restoredRsvpPacing);
const unsubscribeRsvpPacing = runtime.useApp.subscribe((state) => {
  if (state.interaction.kind !== 'rsvp') return;
  const source = state.interaction.rsvp;
  const pacing: RsvpPacing = {
    wpm: source.wpm,
    wordsPerFrame: source.wordsPerFrame,
    sentencePauseMs: source.sentencePauseMs,
    paragraphPauseMs: source.paragraphPauseMs,
    lengthEmphasis: source.lengthEmphasis,
  };
  const serialized = JSON.stringify(pacing);
  if (serialized === savedRsvpPacing) return;
  savedRsvpPacing = serialized;
  saveRsvpPacing(rsvpStorage, pacing);
});

/** Built-in byte acquisition: fetch a bundled document by its corpus-qualified
 *  source name under the deployed base path. The session verifies the returned
 *  length against the authoritative descriptor before transfer, so this only
 *  fetches. The `.txt`
 *  suffix is a transport/storage-path detail only — it gives static hosts a
 *  recognizable text MIME suffix, ENABLING (not guaranteeing) text/plain +
 *  compression, which stays a deployment property of the host. The
 *  `doc`/`sourceName` identities stay extensionless, and the hashes cover
 *  the identical bytes either way. */
const bundledBytes: BundledByteProvider = {
  async get(doc, signal) {
    const sourcePath = doc.sourceName.split('/').map((part) => encodeURIComponent(part)).join('/');
    const base = `${import.meta.env.BASE_URL ?? '/'}corpora/`;
    const response = await fetch(`${base}${sourcePath}.txt`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  },
};

/** Set by the HMR dispose hook: the async bootstrap below must not construct
 *  a session, register client listeners, or attach after teardown began. */
let torndown = false;
let closeLibrary: (() => Promise<void>) | null = null;
let migrationAbort: AbortController | null = null;

async function bootstrap(): Promise<void> {
  let session: ProjectSession;
  let workspaceStore: WorkspaceStorePort | null = null;
  let restoredWorkspace: WorkspaceV1 | null = null;
  let bootstrapNotice: string | null = null;
  let afterAttach: (() => void) | null = null;
  try {
    const [
      { localLibrary },
      {
        builtinCorpusOption,
        libraryProject,
        reconcileLibraryWorkspace,
      },
      { fetchDemoCorpus },
      { ProjectSession },
    ] = await Promise.all([
      import('./local-library.ts'),
      import('./project.ts'),
      import('./demo-corpora.ts'),
      import('./project-session.ts'),
    ]);
    workspaceStore = localLibrary;
    closeLibrary = () => localLibrary.close();
    const [libraryItems, stored] = await Promise.all([
      localLibrary.list(),
      localLibrary.loadWorkspace(),
    ]);
    let workspace = emptyLibraryWorkspace();
    if (stored.kind === 'ready') {
      if (stored.workspace.corpus.kind === 'builtin') {
        const option = builtinCorpusOption(stored.workspace.corpus.id);
        const empty = reconcileWorkspaceDocuments(
          { ...stored.workspace, corpus: { kind: 'library', order: [], docs: [] } },
          new Set(),
        );
        workspace = empty;
        restoredWorkspace = empty;
        if (option === undefined) {
          bootstrapNotice = 'The saved legacy demo was unavailable. Its terms and view settings were preserved; choose a demo again from Inputs or Debug.';
          afterAttach = () => {
            void localLibrary.saveWorkspace(empty).catch((error: unknown) => runtime.reportWorkspaceFailure(error));
          };
        } else {
          afterAttach = () => {
            const lease = libraryOperation.claim();
            if (lease === null) {
              runtime.reportNotice(`The saved ${option.label} demo is ready to migrate. Retry it from Inputs or Debug after the current library action finishes.`);
              return;
            }
            const controller = new AbortController();
            migrationAbort = controller;
            runtime.reportNotice(`Migrating the saved ${option.label} demo into local texts…`);
            void (async () => {
              try {
                const demo = await fetchDemoCorpus(option.id, controller.signal);
                const saved = await localLibrary.add(demo.files);
                const files = await Promise.all(saved.map((result) => localLibrary.file(result.item.id)));
                if (torndown || controller.signal.aborted) return;
                if (!runtime.useApp.getState().importFiles(files)) {
                  throw new Error('the active corpus refused the migrated texts');
                }
                runtime.reportNotice(`${option.label} was migrated to local inputs. Its texts can now be reordered, removed, and reused like any others.`);
              } catch (error) {
                if (!torndown && !controller.signal.aborted) {
                  runtime.reportNotice(`The saved ${option.label} demo could not be migrated: ${error instanceof Error ? error.message : String(error)}. Its terms and view settings were preserved; retry from Inputs or Debug.`);
                }
              } finally {
                if (migrationAbort === controller) migrationAbort = null;
                libraryOperation.release(lease);
              }
            })();
          };
        }
      } else {
        const reconciled = reconcileLibraryWorkspace(
          stored.workspace,
          new Set(libraryItems.map((item) => item.id)),
        );
        restoredWorkspace = reconciled.workspace;
        if (reconciled.removedDocuments.length > 0) {
          afterAttach = () => {
            void localLibrary.saveWorkspace(reconciled.workspace).catch((error: unknown) => runtime.reportWorkspaceFailure(error));
          };
          const count = reconciled.removedDocuments.length;
          bootstrapNotice = `${count} active book${count === 1 ? '' : 's'} no longer existed in the catalog and ${count === 1 ? 'was' : 'were'} removed.`;
        }
        workspace = reconciled.workspace;
      }
    } else if (stored.kind === 'corrupt') {
      bootstrapNotice = `The saved workspace was damaged and could not be restored: ${stored.reason}`;
      restoredWorkspace = workspace;
      afterAttach = () => {
        void localLibrary.saveWorkspace(workspace).catch((error: unknown) => runtime.reportWorkspaceFailure(error));
      };
    } else {
      restoredWorkspace = workspace;
      afterAttach = () => {
        void localLibrary.saveWorkspace(workspace).catch((error: unknown) => runtime.reportWorkspaceFailure(error));
      };
    }
    const initial = await libraryProject(
      workspace,
      new Map(libraryItems.map((item) => [item.id, item])),
    );
    if (torndown) {
      await localLibrary.close();
      return; // HMR or a reset replaced this module mid-bootstrap
    }
    session = new ProjectSession(initial, {
      client,
      bundledBytes,
      libraryFiles: { get: (id) => localLibrary.file(id) },
      newDocId: () => crypto.randomUUID(),
    });
  } catch (error) {
    if (!torndown) runtime.failBootstrap(error);
    return;
  }
  if (workspaceStore === null) throw new Error('the local library did not initialize');
  runtime.attachSession(session, restoredWorkspace ?? undefined, workspaceStore); // subscribe + seed, exactly once
  if (bootstrapNotice !== null) runtime.reportNotice(bootstrapNotice);
  session.start(); // only after the store is observing
  if (demoBootRequest !== null && demoBootRequest.id !== null) {
    void loadDemoCorpus(demoBootRequest.id, 'replace', { getState: runtime.useApp.getState }).then(
      (result) => runtime.reportNotice(demoLoadNotice(result, 'replace')),
      (error: unknown) => {
        // A successful replacement supersedes legacy migration/persistence.
        // On failure, resume that deferred bootstrap work so the prior saved
        // state is not silently abandoned.
        afterAttach?.();
        runtime.reportNotice(
          `The ${demoBootRequest.slug} demo could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  } else {
    afterAttach?.();
    if (demoBootRequest !== null) {
      runtime.reportNotice(`Unknown demo “${demoBootRequest.slug || '(empty)'}”. The URL parameter was removed.`);
    }
  }
}

void bootstrap();

let teardownStarted = false;

async function saveWorkspaceBeforeReload(): Promise<void> {
  const initial = runtime.useApp.getState();
  if (initial.bootstrap.phase !== 'attached') return;
  // Some transient library projects cannot be represented as a durable
  // workspace. The store deliberately declines to save them; there is no
  // persistence barrier for cache clearing to wait on.
  if (workspaceSemanticKey(initial) === null) return;
  initial.retryWorkspaceSave();
  const current = runtime.useApp.getState().workspacePersistence;
  if (current.phase === 'saved') return;
  if (current.phase === 'error') throw new Error(current.message);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = runtime.useApp.subscribe((state) => {
      if (state.workspacePersistence.phase === 'saved') finish();
      else if (state.workspacePersistence.phase === 'error') {
        finish(new Error(state.workspacePersistence.message));
      }
    });
    const timeout = setTimeout(() => {
      finish(new Error('Workspace saving did not finish before the cache clear.'));
    }, 15_000);
  });
}

/** Stop every app-owned live resource before deleting IndexedDB databases.
 * Idempotence also keeps HMR and a user-triggered reset from racing teardown. */
export async function shutdownAppForReload(options: { readonly preserveWorkspace?: boolean } = {}): Promise<void> {
  if (!teardownStarted && options.preserveWorkspace === true) {
    await saveWorkspaceBeforeReload();
  }
  if (!teardownStarted) {
    teardownStarted = true;
    torndown = true;
    migrationAbort?.abort(new DOMException('app is reloading', 'AbortError'));
    try {
      unsubscribeResumeState();
      unsubscribeMatchesColumns();
      unsubscribeRsvpPacing();
      resumeMonitor.dispose();
      runtime.dispose();
    } finally {
      client.close();
    }
  }
  await closeLibrary?.();
}

// Dev-server module replacement: this module owns the app's live resources
// (the Worker, the session, in-flight queries), so a hot swap must tear the
// old instance fully down — otherwise each edit leaks a Worker and the stale
// instance keeps answering. The client close is a `finally` so a throwing
// dispose can never leak the Worker. Dead code in production builds
// (import.meta.hot is undefined outside the dev server).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void shutdownAppForReload();
  });
}

if (__TT_E2E__ && trace && typeof window !== 'undefined') {
  (window as unknown as { __ttE2E: unknown }).__ttE2E = Object.freeze({
    trace: () => trace.snapshot(),
    clearTrace: () => trace.clear(),
  });
}
