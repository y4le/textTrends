/** Browser orchestration. The archive codec has no store, DOM, or IDB owner. */
import { parseWorkspace } from '@texttrends/core';
import { localLibrary } from './local-library.ts';
import { libraryOperation } from './library-operation.ts';
import { useApp, currentRsvpPacing, suspendWorkspaceSaving, reloadRestoredWorkspace } from './store-instance.ts';
import { workspaceFromApp } from './workspace-state.ts';
import { browserStorage } from './preference-store.ts';
import { getDisplayPreference } from './display-store.ts';
import { applyBackupPreferences, captureBackupPreferences } from './workspace-backup-preferences.ts';
import { BACKUP_SCHEMA, verifyBackupSources, writeBackup, type BackupProgress, type PreparedBackup } from './workspace-backup.ts';

const preferenceStores = () => ({ local: browserStorage(window, 'local'), session: browserStorage(window, 'session') });

export async function saveWorkspaceBackup(lease: symbol, signal: AbortSignal, progress: BackupProgress): Promise<Blob> {
  if (!libraryOperation.owns(lease)) throw new Error('Another library operation is running.');
  const state = useApp.getState();
  if (state.bootstrap.phase !== 'attached') throw new Error('Wait for the workspace to finish opening.');
  if ((state.projectSession?.imports.length ?? 0) > 0) throw new Error('Finish importing, or remove failed imports, before saving a complete workspace.');
  const workspace = workspaceFromApp(state);
  if (workspace === null) throw new Error('The active texts are not ready to be saved.');
  const settings = captureBackupPreferences(preferenceStores(), {
    display: getDisplayPreference(),
    speed: currentRsvpPacing(),
    atlas: { normalization: state.atlasNormalization },
    matchesColumns: state.matchesView.columns,
  });
  const inspection = await localLibrary.inspect();
  signal.throwIfAborted();
  if (inspection.damaged.length > 0) {
    throw new Error(`“${inspection.damaged[0]!.name}” is damaged. Repair or remove damaged library items before saving a complete backup.`);
  }
  return writeBackup({
    schema: BACKUP_SCHEMA,
    createdAt: Date.now(),
    // Warm text/index hints are disposable. Source identity and authored
    // metadata survive; bootstrap obtains fresh extraction recipes.
    workspace: parseWorkspace({ ...workspace, corpus: { ...workspace.corpus, docs: workspace.corpus.docs.map(({ warm: _warm, ...doc }) => doc) } }),
    settings,
    sources: inspection.items,
  }, async (id) => (await localLibrary.file(id)).arrayBuffer(), signal, progress);
}

export class CommittedRestoreError extends Error {}

export async function loadWorkspaceBackup(backup: PreparedBackup, lease: symbol, signal?: AbortSignal): Promise<void> {
  if (!libraryOperation.owns(lease)) throw new Error('Another library operation is running.');
  if (useApp.getState().bootstrap.phase !== 'attached') throw new Error('Wait for the workspace to finish opening.');
  await verifyBackupSources(backup, signal);
  const resume = await suspendWorkspaceSaving();
  let committed = false;
  try {
    signal?.throwIfAborted();
    await localLibrary.restoreBackup(backup, signal);
    committed = true;
    applyBackupPreferences(backup.manifest.settings, preferenceStores());
    await localLibrary.finishBackupSettings();
    await reloadRestoredWorkspace();
  } catch (error) {
    if (!committed) { resume(); throw error; }
    // The sources/workspace have committed. Keep the old runtime suspended;
    // pending settings can be replayed safely by startup after a reload.
    throw new CommittedRestoreError(`The workspace was saved, but reopening did not finish: ${error instanceof Error ? error.message : String(error)} Reload to finish loading it.`);
  }
}

export function downloadWorkspaceBackup(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `textTrends-${new Date().toISOString().slice(0, 10)}.ttws`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
