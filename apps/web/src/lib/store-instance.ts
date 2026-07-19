/**
 * The app's live store instance — a separate module so tests can construct
 * stores with a fake client without touching the Worker global.
 */

import { WorkerClient } from './client.ts';
import { createAppStore, type ClientLike } from './store.ts';

export const useApp = createAppStore(new WorkerClient() as unknown as ClientLike);
