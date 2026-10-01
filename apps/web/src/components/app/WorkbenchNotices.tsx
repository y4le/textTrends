import { shutdownAppForReload, useApp } from '../../lib/store-instance.ts';
import { ResumeStatus } from '../ResumeStatus.tsx';

/** Stable notices and their retry/reload actions, independent of place data. */
export function WorkbenchNotices({ reloadError, setReloadError }: {
  readonly reloadError: string | null;
  readonly setReloadError: (message: string | null) => void;
}) {
  const retryAnalysis = useApp((state) => state.retryAnalysis);
  const loadError = useApp((state) => state.loadError);
  const loadErrorFatal = useApp((state) => state.loadErrorFatal);
  const notebookError = useApp((state) => state.notebookError);
  const clearNotebookError = useApp((state) => state.clearNotebookError);
  const commandError = useApp((state) => state.commandError);
  const clearCommandError = useApp((state) => state.clearCommandError);
  const appNotice = useApp((state) => state.appNotice);
  const clearAppNotice = useApp((state) => state.clearAppNotice);
  const bootstrap = useApp((state) => state.bootstrap);
  return <>
      <ResumeStatus />
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', margin: appNotice ? undefined : 0 }}
      >
        {appNotice && (
          <>
            {appNotice}{' '}
            <button
              type="button"
              onClick={clearAppNotice}
              style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--rule-strong)', cursor: 'pointer', padding: '0 0.5ch' }}
            >
              dismiss
            </button>
          </>
        )}
      </p>
      {commandError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {commandError}{' '}
          <button
            type="button"
            onClick={clearCommandError}
            style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--rule-strong)', cursor: 'pointer', padding: '0 0.5ch' }}
          >
            dismiss
          </button>
        </p>
      )}
      {notebookError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {notebookError}{' '}
          <button
            type="button"
            onClick={clearNotebookError}
            style={{
              font: 'inherit',
              color: 'inherit',
              background: 'none',
              border: '1px solid var(--rule-strong)',
              cursor: 'pointer',
              padding: '0 0.5ch',
            }}
          >
            dismiss
          </button>
        </p>
      )}
      <div role="status" aria-live="polite">
        {bootstrap.phase === 'error' && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            failed to prepare the app: {bootstrap.message} — reload the page to retry
          </p>
        )}
        {loadError && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            {loadError}{' '}
            <button
              type="button"
              onClick={() => {
                if (!loadErrorFatal) {
                  retryAnalysis();
                  return;
                }
                setReloadError(null);
                void shutdownAppForReload({ preserveWorkspace: true })
                  .then(() => window.location.reload())
                  .catch((error: unknown) => setReloadError(`Could not save before reload: ${error instanceof Error ? error.message : String(error)}. Your edits remain open.`));
              }}
              style={{
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: '1px solid var(--rule-strong)',
                cursor: 'pointer',
                padding: '0 0.5ch',
              }}
            >
              {loadErrorFatal ? 'reload' : 'retry'}
            </button>
          </p>
        )}
        {reloadError && <p role="alert">{reloadError}</p>}
      </div>
  </>;
}
