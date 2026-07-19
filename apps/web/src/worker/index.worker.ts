/**
 * Thin worker shell — everything interesting lives in the testable
 * WorkerEngine. yieldControl is a REAL task-queue yield (MessageChannel),
 * so queued cancel messages actually run between engine phases;
 * `await Promise.resolve()` would only drain microtasks.
 */

import { WorkerEngine } from './engine.ts';
import { InMemoryArtifactStore } from './store.ts';
import type { ToWorker } from './protocol.ts';

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

const engine = new WorkerEngine(
  new InMemoryArtifactStore(), // IndexedDB store lands in Milestone 5
  (message) => self.postMessage(message),
  taskQueueYield,
);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  void engine.handle(event.data);
};
