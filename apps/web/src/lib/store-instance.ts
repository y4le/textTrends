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

import type { WorkspaceV1 } from '@texttrends/core';
import { WorkerClient } from './client.ts';
import { RingTrace } from './trace.ts';
import type { ProjectSession, BundledByteProvider } from './project-session.ts';
import { createAppRuntime, type WorkspaceStorePort } from './store.ts';
import { createResumeMonitor } from './resume.ts';
import { browserHistoryPort } from './history-port.ts';

const trace = __TT_E2E__ ? new RingTrace() : undefined;

const client = new WorkerClient(trace);
const runtime = createAppRuntime(client, {
  history: browserHistoryPort(window),
});

/** The single React-facing store. */
export const useApp = runtime.useApp;

function pendingAnalyses(): number {
  const state = runtime.useApp.getState();
  const direct = [
    state.kwic?.state,
    state.dispersion?.state,
    state.selectedDispersion?.state,
    state.inventory?.state,
    state.frequency?.state,
    state.keynessA?.state,
    state.keynessB?.state,
    state.keynessInventoryA?.state,
    state.keynessInventoryB?.state,
    state.footerPassage?.state,
    state.readerPage?.state,
  ];
  const maps = [
    ...state.trends.values(),
    ...state.selectedTrends.values(),
  ];
  return direct.filter((item) => item?.status === 'pending').length
    + maps.filter((item) => item.status === 'pending').length;
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

async function bootstrap(): Promise<void> {
  let session: ProjectSession;
  let workspaceStore: WorkspaceStorePort | null = null;
  let restoredWorkspace: WorkspaceV1 | null = null;
  let bootstrapNotice: string | null = null;
  let defaultTerms = '';
  try {
    const [
      { localLibrary },
      {
        BUILTIN_SHERLOCK_ID,
        builtinCorpusOption,
        builtinProject,
        builtinProjectRegistry,
        libraryProject,
        reconcileLibraryWorkspace,
      },
      { ProjectSession },
    ] = await Promise.all([
      import('./local-library.ts'),
      import('./project.ts'),
      import('./project-session.ts'),
    ]);
    workspaceStore = localLibrary;
    closeLibrary = () => localLibrary.close();
    const [builtinProjects, libraryItems, stored] = await Promise.all([
      builtinProjectRegistry(),
      localLibrary.list(),
      localLibrary.loadWorkspace(),
    ]);
    const fallback = builtinProjects.get(BUILTIN_SHERLOCK_ID);
    if (fallback === undefined) throw new Error('the default Sherlock corpus is not registered');
    defaultTerms = builtinCorpusOption(BUILTIN_SHERLOCK_ID)!.defaultTerms;
    let initial = builtinProject(fallback);
    if (stored.kind === 'ready') {
      if (stored.workspace.corpus.kind === 'builtin') {
        const option = builtinCorpusOption(stored.workspace.corpus.id);
        const data = option === undefined ? undefined : builtinProjects.get(option.id);
        if (data === undefined) {
          bootstrapNotice = 'The saved demo corpus is unavailable; Sherlock Holmes was opened instead.';
          restoredWorkspace = { ...stored.workspace, corpus: { kind: 'builtin', id: BUILTIN_SHERLOCK_ID } };
        } else {
          initial = builtinProject(data);
          restoredWorkspace = stored.workspace;
        }
      } else {
        const reconciled = reconcileLibraryWorkspace(
          stored.workspace,
          new Set(libraryItems.map((item) => item.id)),
        );
        restoredWorkspace = reconciled.workspace;
        if (reconciled.removedDocuments.length > 0) {
          await localLibrary.saveWorkspace(reconciled.workspace);
          const count = reconciled.removedDocuments.length;
          bootstrapNotice = `${count} active book${count === 1 ? '' : 's'} no longer existed in the catalog and ${count === 1 ? 'was' : 'were'} removed.`;
        }
        initial = await libraryProject(
          reconciled.workspace,
          new Map(libraryItems.map((item) => [item.id, item])),
        );
      }
    } else if (stored.kind === 'corrupt') {
      bootstrapNotice = `The saved workspace was damaged and could not be restored: ${stored.reason}`;
    }
    if (torndown) return; // HMR replaced this module mid-bootstrap
    session = new ProjectSession(initial, {
      client,
      bundledBytes,
      libraryFiles: { get: (id) => localLibrary.file(id) },
      builtinProjects,
      newDocId: () => crypto.randomUUID(),
    });
  } catch (error) {
    if (!torndown) runtime.failBootstrap(error);
    return;
  }
  if (workspaceStore === null) throw new Error('the local library did not initialize');
  runtime.attachSession(session, restoredWorkspace ?? undefined, workspaceStore); // subscribe + seed, exactly once
  if (bootstrapNotice !== null) runtime.reportNotice(bootstrapNotice);
  // Seed the demo comparison ONCE at bootstrap (the store itself starts with
  // an empty notebook — demo content is a composition decision, not model
  // state). Queries issue when the first snapshot publishes.
  if (restoredWorkspace === null && runtime.useApp.getState().notebook.groups.length === 0) {
    runtime.useApp.getState().quickAdd(defaultTerms);
  }
  session.start(); // only after the store is observing
}

void bootstrap();

// Dev-server module replacement: this module owns the app's live resources
// (the Worker, the session, in-flight queries), so a hot swap must tear the
// old instance fully down — otherwise each edit leaks a Worker and the stale
// instance keeps answering. The client close is a `finally` so a throwing
// dispose can never leak the Worker. Dead code in production builds
// (import.meta.hot is undefined outside the dev server).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    torndown = true;
    try {
      unsubscribeResumeState();
      resumeMonitor.dispose();
      runtime.dispose();
      void closeLibrary?.();
    } finally {
      client.close();
    }
  });
}

if (__TT_E2E__ && trace && typeof window !== 'undefined') {
  (window as unknown as { __ttE2E: unknown }).__ttE2E = Object.freeze({
    trace: () => trace.snapshot(),
    clearTrace: () => trace.clear(),
  });
}
