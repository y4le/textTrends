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
import { builtinProject } from './project.ts';
import { ProjectSession, type BundledByteProvider } from './project-session.ts';
import { createAppRuntime, sherlockProjectData } from './store.ts';

const trace = __TT_E2E__ ? new RingTrace() : undefined;

const client = new WorkerClient(trace);
const runtime = createAppRuntime(client);

/** The single React-facing store. */
export const useApp = runtime.useApp;

/** Built-in byte acquisition: fetch a bundled document by its source name under
 *  the deployed base path. The session verifies the returned length against the
 *  authoritative descriptor before transfer, so this only fetches. */
const bundledBytes: BundledByteProvider = {
  async get(doc, signal) {
    const base = `${import.meta.env.BASE_URL ?? '/'}corpora/sherlock/`;
    const response = await fetch(base + encodeURIComponent(doc.sourceName), { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  },
};

async function bootstrap(): Promise<void> {
  let session: ProjectSession;
  try {
    const data = await sherlockProjectData();
    session = new ProjectSession(builtinProject(data), {
      client,
      bundledBytes,
      newDocId: () => crypto.randomUUID(),
      hashBytes: (bytes) => hashSourceBytes(bytes),
    });
  } catch (error) {
    runtime.failBootstrap(error);
    return;
  }
  runtime.attachSession(session); // subscribe + seed, exactly once
  session.start(); // only after the store is observing
}

void bootstrap();

if (__TT_E2E__ && trace && typeof window !== 'undefined') {
  (window as unknown as { __ttE2E: unknown }).__ttE2E = Object.freeze({
    trace: () => trace.snapshot(),
    clearTrace: () => trace.clear(),
  });
}
