/**
 * The app's live store instance — a separate module so tests can construct
 * stores with a fake client without touching the Worker global.
 *
 * Under `--mode e2e` (compile-time __TT_E2E__; dead-code-eliminated from
 * the normal production build), the client gets a passive sanitized
 * protocol trace and the page exposes a frozen read-only facade for the
 * Playwright suite. Nothing else about the app changes in e2e mode.
 */

import { WorkerClient } from './client.ts';
import { RingTrace } from './trace.ts';
import { createAppStore, type ClientLike } from './store.ts';

const trace = __TT_E2E__ ? new RingTrace() : undefined;

export const useApp = createAppStore(new WorkerClient(trace) as unknown as ClientLike);

if (__TT_E2E__ && trace && typeof window !== 'undefined') {
  (window as unknown as { __ttE2E: unknown }).__ttE2E = Object.freeze({
    trace: () => trace.snapshot(),
    clearTrace: () => trace.clear(),
  });
}
