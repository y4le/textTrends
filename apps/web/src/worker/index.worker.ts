/**
 * Thin worker shell (v4) — everything interesting lives in the testable
 * WorkerEngineV4. yieldControl is a REAL task-queue yield (MessageChannel), so
 * queued cancel messages actually run between engine phases; `await
 * Promise.resolve()` would only drain microtasks.
 *
 * The disposable artifact cache falls back to memory and must never stall
 * analysis. Messages arriving before the engine exists are buffered as
 * `unknown` and replayed in arrival order; the engine owns all v4 parsing.
 */

import { WorkerEngineV4 } from './engine-v4.ts';
import { openArtifactStore } from './idb-store.ts';
import { InMemoryArtifactStore, type ArtifactStore } from './store.ts';
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

let engine: WorkerEngineV4 | null = null;
const buffered: unknown[] = [];

self.onmessage = (event: MessageEvent<unknown>) => {
  if (engine) void engine.handle(event.data);
  else buffered.push(event.data);
};

const start = (store: ArtifactStore): void => {
  engine = new WorkerEngineV4(store, emit, taskQueueYield);
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
