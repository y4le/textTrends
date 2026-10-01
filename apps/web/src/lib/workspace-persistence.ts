/** Owns workspace hydration, save scheduling, failure pause, and lifetime fences. */
import type { StoreApi } from 'zustand';
import type { AppState, WorkspaceStorePort } from './app-state.ts';
import {
  workspaceFromApp,
  workspaceSemanticKey,
  workspaceSemanticSources,
  sameWorkspaceSemanticSources,
} from './workspace-state.ts';

export const WORKSPACE_SAVE_DEBOUNCE_MS = 1_500;

export function createWorkspacePersistence(
  store: Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>,
  initialPort: WorkspaceStorePort | null,
) {
  let workspaceStore = initialPort;
  let disposed = false;
  let workspaceHydrated = false;
  let workspaceLastKey: string | null = null;
  let workspacePausedKey: string | null = null;
  let workspaceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let workspaceSaveToken = 0;
  let workspaceScheduling = false;
  let suspended = false;
  const pendingWrites = new Set<Promise<void>>();
  let saveWorkspaceNow = (): void => undefined;

  const msg = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const clearWorkspaceTimer = (): void => {
    if (workspaceSaveTimer !== null) {
      clearTimeout(workspaceSaveTimer);
      workspaceSaveTimer = null;
    }
  };

  const scheduleWorkspaceSave = (): void => {
    if (
      disposed || suspended ||
      !workspaceHydrated ||
      workspaceStore === null
    ) {
      return;
    }
    if (workspaceScheduling) return;
    workspaceScheduling = true;
    clearWorkspaceTimer();
    if (store.getState().workspacePersistence.phase !== 'dirty') {
      store.setState({ workspacePersistence: { phase: 'dirty' } });
    }
    workspaceSaveTimer = setTimeout(() => {
      workspaceSaveTimer = null;
      saveWorkspaceNow();
    }, WORKSPACE_SAVE_DEBOUNCE_MS);
    workspaceScheduling = false;
  };

  saveWorkspaceNow = (): void => {
    if (disposed || suspended || !workspaceHydrated || workspaceStore === null) return;
    const workspace = workspaceFromApp(store.getState());
    const issuedKey = workspaceSemanticKey(store.getState());
    if (workspace === null || issuedKey === null) return;
    clearWorkspaceTimer();
    const token = ++workspaceSaveToken;
    workspaceScheduling = true;
    try {
      store.setState({ workspacePersistence: { phase: 'saving' } });
    } finally {
      workspaceScheduling = false;
    }
    const write = workspaceStore.saveWorkspace(workspace).then(() => {
      if (disposed || token !== workspaceSaveToken) return;
      workspacePausedKey = null;
      workspaceLastKey = issuedKey;
      const liveKey = workspaceSemanticKey(store.getState());
      if (liveKey === issuedKey) {
        store.setState({ workspacePersistence: { phase: 'saved' } });
      } else {
        scheduleWorkspaceSave();
      }
    }).catch((error: unknown) => {
      if (disposed || token !== workspaceSaveToken) return;
      workspacePausedKey = workspaceSemanticKey(store.getState());
      store.setState({
        workspacePersistence: {
          phase: 'error',
          message: `Workspace could not be saved: ${msg(error)}`,
        },
      });
    });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  };

  let workspaceSources = workspaceSemanticSources(store.getState());
  const unsubscribeWorkspace = store.subscribe((state) => {
    const nextSources = workspaceSemanticSources(state);
    if (sameWorkspaceSemanticSources(workspaceSources, nextSources)) return;
    workspaceSources = nextSources;
    if (!workspaceHydrated) return;
    const key = workspaceSemanticKey(state);
    if (key === workspacePausedKey) return;
    if (workspacePausedKey !== null) workspacePausedKey = null;
    if (key !== workspaceLastKey) scheduleWorkspaceSave();
  });

  const flushWorkspace = (): void => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      workspaceSaveTimer !== null
    ) {
      saveWorkspaceNow();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', flushWorkspace);
  }

  return {
    connect(port: WorkspaceStorePort) {
      if (workspaceStore !== null && workspaceStore !== port) {
        throw new Error('a different workspace store is already connected');
      }
      workspaceStore = port;
    },
    hydrate() {
      if (disposed || workspaceHydrated || workspaceStore === null) return;
      workspaceHydrated = true;
      workspaceLastKey = workspaceSemanticKey(store.getState());
      store.setState({ workspacePersistence: { phase: 'saved' } });
    },
    saveNow() {
      workspacePausedKey = null;
      saveWorkspaceNow();
    },
    /** Stop new writes and drain issued transactions before replacing the
     * durable workspace. The caller resumes only if replacement did not commit. */
    async suspend() {
      if (disposed || suspended) throw new Error('Workspace saving is already stopped.');
      suspended = true;
      clearWorkspaceTimer();
      workspaceSaveToken += 1;
      await Promise.allSettled([...pendingWrites]);
      let resumed = false;
      return () => {
        if (resumed || disposed) return;
        resumed = true;
        suspended = false;
        workspacePausedKey = null;
        if (workspaceSemanticKey(store.getState()) !== workspaceLastKey) scheduleWorkspaceSave();
        else store.setState({ workspacePersistence: { phase: 'saved' } });
      };
    },
    reportFailure(error: unknown) {
      if (!disposed) store.setState({ workspacePersistence: {
        phase: 'error', message: `Workspace could not be saved: ${msg(error)}`,
      } });
    },
    dispose() {
      disposed = true;
      clearWorkspaceTimer();
      workspaceSaveToken += 1;
      unsubscribeWorkspace();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', flushWorkspace);
      }
    },
  };
}
