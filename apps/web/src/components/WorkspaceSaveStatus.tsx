import { useApp } from '../lib/store-instance.ts';

/** Durability failures follow the researcher through every workbench/Reader view. */
export function WorkspaceSaveStatus() {
  const persistence = useApp((state) => state.workspacePersistence);
  const retry = useApp((state) => state.retryWorkspaceSave);
  if (persistence.phase !== 'error') return null;
  return (
    <aside className="workspace-save-warning" role="alert" aria-label="Unsaved workspace">
      <strong>Your changes are not saved.</strong>
      <span>{persistence.message}</span>
      <button type="button" onClick={() => {
        retry();
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('#reader-region, .place-surface')?.focus({ preventScroll: true });
        });
      }}>Retry saving</button>
    </aside>
  );
}
