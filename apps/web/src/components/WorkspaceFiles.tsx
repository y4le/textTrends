import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { libraryOperation } from '../lib/library-operation.ts';
import { useApp } from '../lib/store-instance.ts';
import { UtilityPane } from './UtilityPane.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import type { PreparedBackup } from '../lib/workspace-backup.ts';

type Operation = {
  readonly lease: symbol;
  readonly abort: AbortController;
  committed: boolean;
  locked: boolean;
  readonly returnFocus: HTMLElement | null;
};
const countLabel = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`;

export function WorkspaceFiles() {
  const ready = useApp((state) => state.bootstrap.phase === 'attached');
  const busy = useSyncExternalStore(libraryOperation.subscribe, libraryOperation.isBusy, libraryOperation.isBusy);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<Operation | null>(null);
  const [mode, setMode] = useState<'save' | 'load' | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [prepared, setPrepared] = useState<PreparedBackup | null>(null);
  const [loading, setLoading] = useState(false);
  const [committed, setCommitted] = useState(false);

  useEffect(() => () => {
    const operation = active.current;
    operation?.abort.abort();
    if (operation && !operation.locked) {
      libraryOperation.release(operation.lease);
    }
    active.current = null;
  }, []);

  const close = () => {
    const operation = active.current;
    if (operation?.locked || operation?.committed) return;
    operation?.abort.abort();
    if (operation) libraryOperation.release(operation.lease);
    active.current = null;
    setMode(null);
    setPrepared(null);
    requestAnimationFrame(() => {
      if (active.current === null && operation?.returnFocus?.isConnected) operation.returnFocus.focus();
    });
  };

  const begin = async (file?: File) => {
    if (active.current !== null) return;
    const lease = libraryOperation.claim();
    if (lease === null) { setNotice('Wait for the current library operation to finish.'); return; }
    const operation: Operation = { lease, abort: new AbortController(), committed: false, locked: false, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    active.current = operation;
    setMode(file ? 'load' : 'save');
    setPrepared(null);
    setError(null);
    setNotice('');
    setCommitted(false);
    setLoading(false);
    setProgress(file ? 'Checking workspace file…' : 'Preparing workspace file…');
    const report = (message: string) => { if (active.current === operation) setProgress(message); };
    try {
      if (file) {
        const { readBackup } = await import('../lib/workspace-backup.ts');
        const backup = await readBackup(file, operation.abort.signal, report);
        if (active.current !== operation) return;
        setPrepared(backup);
        setProgress('Ready to load.');
      } else {
        const { saveWorkspaceBackup, downloadWorkspaceBackup } = await import('../lib/workspace-backup-service.ts');
        const blob = await saveWorkspaceBackup(lease, operation.abort.signal, report);
        if (active.current !== operation) return;
        downloadWorkspaceBackup(blob);
        setNotice('Workspace file prepared and download started. It includes all saved texts, active text order, terms, and settings.');
        close();
      }
    } catch (failure) {
      if (active.current === operation && !operation.abort.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setProgress('');
      }
    }
  };

  const restore = async () => {
    const operation = active.current;
    if (!operation || operation.locked || !prepared) return;
    operation.locked = true;
    setLoading(true);
    setError(null);
    setProgress('Loading workspace and reopening the app…');
    let commitFailed = false;
    try {
      const { loadWorkspaceBackup, CommittedRestoreError } = await import('../lib/workspace-backup-service.ts');
      try { await loadWorkspaceBackup(prepared, operation.lease, operation.abort.signal); }
      catch (failure) { commitFailed = failure instanceof CommittedRestoreError; throw failure; }
    } catch (failure) {
      operation.committed = commitFailed;
      operation.locked = operation.committed;
      if (operation.abort.signal.aborted && !operation.committed) libraryOperation.release(operation.lease);
      if (active.current !== operation) return;
      setCommitted(operation.committed);
      setLoading(false);
      setProgress('');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section className="workspace-files" aria-labelledby="workspace-files-heading">
      <h3 id="workspace-files-heading">Workspace file</h3>
      <p>Save all library texts, active text order, terms, and display and reading settings in one file.</p>
      <div className="workspace-file-actions">
        <button type="button" style={SMALL_BUTTON_STYLE} disabled={!ready || busy} onClick={() => { void begin(); }}>Save workspace file</button>
        <button type="button" style={SMALL_BUTTON_STYLE} disabled={!ready || busy} onClick={() => input.current?.click()}>Load workspace file</button>
        <input ref={input} hidden type="file" accept=".ttws,.zip" aria-label="Choose workspace file" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void begin(file);
        }} />
      </div>
      {notice && <p role="status">{notice}</p>}
      {mode && (
        <UtilityPane
          title={mode === 'save' ? 'Save workspace file' : 'Load workspace file'}
          initialFocus="heading" closeDisabled={loading || committed} onClose={close}
          footer={(
            <div className="workspace-file-actions">
              {prepared && !committed && <button type="button" style={SMALL_BUTTON_STYLE} disabled={loading} onClick={() => { void restore(); }}>Replace workspace and load</button>}
              {committed ? <button type="button" style={SMALL_BUTTON_STYLE} onClick={() => window.location.reload()}>Reload to finish</button>
                : <button type="button" style={SMALL_BUTTON_STYLE} disabled={loading} onClick={close}>{error ? 'Close' : 'Cancel'}</button>}
            </div>
          )}
        >
          {progress && <p role="status">{progress}</p>}
          {error && <p role="alert">{error}</p>}
          {prepared && !committed && (
            <>
              <p>This file contains <strong>{countLabel(prepared.manifest.sources.length, 'saved text')}</strong>, {countLabel(prepared.manifest.workspace.corpus.docs.length, 'active text')}, and {countLabel(prepared.manifest.workspace.notebook.groups.length, 'term')}.</p>
              <p>Loading replaces your active texts, terms, and saved settings, then reopens the app. Unrelated library texts are kept. Texts already in this file take their saved names and metadata.</p>
              <p>Save your current workspace first if you want to return to it.</p>
            </>
          )}
        </UtilityPane>
      )}
    </section>
  );
}
