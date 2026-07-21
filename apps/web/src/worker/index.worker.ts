/**
 * Thin worker shell (v4) — everything interesting lives in the testable
 * WorkerEngineV4. yieldControl is a REAL task-queue yield (MessageChannel), so
 * queued cancel messages actually run between engine phases; `await
 * Promise.resolve()` would only drain microtasks.
 *
 * TWO stores open CONCURRENTLY at boot (engine-v4 consult §Q1): the disposable
 * artifact cache (class-3, in-memory fallback that must never stall analysis)
 * and the durable user-data store (class-1). The engine is constructed as soon
 * as the ARTIFACT store resolves — analysis must not wait on the durable open,
 * whose bounded promise is passed as a memoized provider. Only a user-data
 * command awaits it; class-1 storage reports its real state (blocked/
 * unavailable), never a silent in-memory substitute. Messages arriving before
 * the engine exists are buffered as `unknown` and replayed in arrival order —
 * the engine owns all v4 parsing, so the shell never casts browser input.
 */

import { WorkerEngineV4, type UserDataProvider } from './engine-v4.ts';
import { openArtifactStore } from './idb-store.ts';
import { InMemoryArtifactStore, type ArtifactStore } from './store.ts';
import { openUserDataStore } from './idb-user-data-store.ts';
import { PROTOCOL_VERSION_V4, type FromWorkerV4 } from './protocol-v4.ts';

function taskQueueYield(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

// TS types `self` as Window here; the worker-scope postMessage takes a
// transfer array as its second argument.
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const emit = (message: FromWorkerV4, transfers?: readonly Transferable[]): void => {
  if (transfers && transfers.length > 0) workerScope.postMessage(message, [...transfers]);
  else workerScope.postMessage(message);
};

// Start the durable user-data open NOW (bounded internally) and hand the engine
// a memoized provider — its discriminated result IS the engine's UserDataAccess.
// Nothing here awaits it; only user-data commands do.
const userDataOpen = openUserDataStore();
const userDataProvider: UserDataProvider = () => userDataOpen;

let engine: WorkerEngineV4 | null = null;
const buffered: unknown[] = [];

self.onmessage = (event: MessageEvent<unknown>) => {
  if (engine) void engine.handle(event.data);
  else buffered.push(event.data);
};

const start = (store: ArtifactStore): void => {
  engine = new WorkerEngineV4(store, userDataProvider, emit, taskQueueYield);
  for (const message of buffered.splice(0)) void engine.handle(message);
};

void openArtifactStore((code, message) =>
  emit({ v: PROTOCOL_VERSION_V4, t: 'warning', code, message }),
).then(start, () => {
  // The factory contractually never rejects — but a null engine would buffer
  // messages FOREVER, so an unexpected fault still degrades to in-memory
  // analysis rather than a silent stall (review finding P1).
  emit({
    v: PROTOCOL_VERSION_V4,
    t: 'warning',
    code: 'CACHE_UNAVAILABLE',
    message: 'artifact store failed to initialize; results are not persisted',
  });
  start(new InMemoryArtifactStore());
});
