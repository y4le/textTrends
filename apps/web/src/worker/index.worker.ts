/**
 * Thin worker shell — everything interesting lives in the testable
 * WorkerEngine. yieldControl is a REAL task-queue yield (MessageChannel),
 * so queued cancel messages actually run between engine phases;
 * `await Promise.resolve()` would only drain microtasks.
 *
 * The artifact store opens asynchronously (IndexedDB, with an in-memory
 * fallback that must never stall analysis — M5); messages arriving before
 * the engine exists are buffered and replayed in arrival order.
 */

import { WorkerEngine } from './engine.ts';
import { openArtifactStore } from './idb-store.ts';
import { InMemoryArtifactStore, type ArtifactStore } from './store.ts';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from './protocol.ts';

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

const emit = (message: FromWorker): void => self.postMessage(message);

let engine: WorkerEngine | null = null;
const buffered: ToWorker[] = [];

self.onmessage = (event: MessageEvent<ToWorker>) => {
  if (engine) void engine.handle(event.data);
  else buffered.push(event.data);
};

const start = (store: ArtifactStore): void => {
  engine = new WorkerEngine(store, emit, taskQueueYield);
  for (const message of buffered.splice(0)) void engine.handle(message);
};

void openArtifactStore((code, message) =>
  emit({ v: PROTOCOL_VERSION, t: 'warning', code, message }),
).then(start, () => {
  // The factory contractually never rejects — but a null engine would
  // buffer messages FOREVER, so an unexpected fault still degrades to
  // in-memory analysis rather than a silent stall (review finding P1).
  emit({
    v: PROTOCOL_VERSION,
    t: 'warning',
    code: 'CACHE_UNAVAILABLE',
    message: 'artifact store failed to initialize; results are not persisted',
  });
  start(new InMemoryArtifactStore());
});
