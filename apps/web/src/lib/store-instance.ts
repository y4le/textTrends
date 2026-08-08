/**
 * The app's composition root — the one place the synchronous React store, the
 * one `WorkerClient`, and the one `ProjectSession` are wired together (commit
 * 7c, per the recorded 7c integration ruling). A separate module so tests can
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

import { hashSourceBytes } from '@texttrends/core';
import { WorkerClient } from './client.ts';
import { RingTrace } from './trace.ts';
import {
  BUILTIN_SHERLOCK_ID,
  builtinCorpusOption,
  builtinProject,
  builtinProjectRegistry,
} from './project.ts';
import { ProjectSession, type BundledByteProvider } from './project-session.ts';
import { createAppRuntime } from './store.ts';
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
    state.tfidf?.state,
    state.keynessA?.state,
    state.keynessB?.state,
    state.keynessInventoryA?.state,
    state.keynessInventoryB?.state,
    state.keynessEvidence?.state,
    state.structure?.state,
    state.editContext?.state,
    state.lineExcerpt?.state,
    state.readerPage?.state,
  ];
  const maps = [
    ...state.trends.values(),
    ...state.selectedTrends.values(),
  ];
  return direct.filter((item) => item?.status === 'pending').length
    + maps.filter((item) => item.status === 'pending').length
    + state.pins.filter((pin) => pin.kind === 'pending').length;
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

async function bootstrap(): Promise<void> {
  let session: ProjectSession;
  try {
    const builtinProjects = await builtinProjectRegistry();
    const data = builtinProjects.get(BUILTIN_SHERLOCK_ID);
    if (data === undefined) throw new Error('the default Sherlock corpus is not registered');
    if (torndown) return; // HMR replaced this module mid-bootstrap
    session = new ProjectSession(builtinProject(data), {
      client,
      bundledBytes,
      builtinProjects,
      newDocId: () => crypto.randomUUID(),
      hashBytes: (bytes) => hashSourceBytes(bytes),
    });
  } catch (error) {
    if (!torndown) runtime.failBootstrap(error);
    return;
  }
  runtime.attachSession(session); // subscribe + seed, exactly once
  // Seed the demo comparison ONCE at bootstrap (the store itself starts with
  // an empty notebook — demo content is a composition decision, not model
  // state). Queries issue when the first snapshot publishes.
  if (runtime.useApp.getState().notebook.groups.length === 0) {
    runtime.useApp.getState().quickAdd(builtinCorpusOption(BUILTIN_SHERLOCK_ID)!.defaultTerms);
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
