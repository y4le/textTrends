import { useEffect, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { decodeShareLink } from '../lib/share-state.ts';

export function ResearchPanel() {
  const persistence = useApp((state) => state.researchPersistence);
  const selections = useApp((state) => state.savedSelections);
  const selectionChecks = useApp((state) => state.selectionChecks);
  const selectionError = useApp((state) => state.selectionError);
  const restoreIssues = useApp((state) => state.pinRestoreIssues);
  const shareNotice = useApp((state) => state.shareNotice);
  const saveSelection = useApp((state) => state.saveNamedSelection);
  const applySelection = useApp((state) => state.applyNamedSelection);
  const removeSelection = useApp((state) => state.removeNamedSelection);
  const reload = useApp((state) => state.reloadResearch);
  const overwrite = useApp((state) => state.overwriteResearch);
  const createShareUrl = useApp((state) => state.createShareUrl);
  const importShare = useApp((state) => state.importShareLink);
  const [name, setName] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [importValue, setImportValue] = useState('');
  const [importPreview, setImportPreview] = useState<string | null>(null);

  useEffect(() => {
    if (typeof location === 'undefined' || !location.hash.startsWith('#s=')) return;
    const value = location.href;
    setImportValue(value);
    try {
      const decoded = decodeShareLink(value);
      setImportPreview(
        `${decoded.n.groups.length} notebook group${decoded.n.groups.length === 1 ? '' : 's'}, ${decoded.x.length} referenced document${decoded.x.length === 1 ? '' : 's'}, and ${(decoded.r ?? []).length} anchor${(decoded.r ?? []).length === 1 ? '' : 's'}`,
      );
    } catch (error) {
      setImportPreview(`Invalid share link: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const status = persistence.phase === 'error' || persistence.phase === 'conflict'
    ? persistence.message
    : persistence.phase === 'dirty'
      ? 'research changes waiting to save'
      : persistence.phase === 'saving'
        ? 'saving research state…'
        : persistence.phase === 'loading'
          ? 'loading research state…'
          : persistence.phase === 'saved'
            ? 'research state saved locally'
            : 'research state not loaded';

  return (
    <details style={{ marginTop: 'var(--space-2)' }}>
      <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
        Research state & sharing
        {persistence.phase === 'conflict'
          ? ' — conflict'
          : persistence.phase === 'error'
            ? ' — attention needed'
            : ''}
      </summary>
      <section
        aria-label="Research state and sharing"
        style={{
          borderLeft: '2px solid var(--rule)',
          marginTop: 'var(--space-2)',
          paddingLeft: 'var(--space-3)',
          display: 'grid',
          gap: 'var(--space-2)',
        }}
      >
        <p
          role={persistence.phase === 'error' || persistence.phase === 'conflict' ? 'alert' : 'status'}
          style={{
            margin: 0,
            color: persistence.phase === 'error' || persistence.phase === 'conflict'
              ? 'var(--accent-text)'
              : 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {status}
        </p>
        {persistence.phase === 'conflict' && (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" onClick={reload} style={SMALL_BUTTON_STYLE}>
              reload other tab’s state
            </button>
            <button type="button" onClick={overwrite} style={SMALL_BUTTON_STYLE}>
              overwrite with this tab
            </button>
          </div>
        )}
        {persistence.phase === 'error' && (
          <button type="button" onClick={reload} style={{ ...SMALL_BUTTON_STYLE, width: 'fit-content' }}>
            retry research load
          </button>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveSelection(name);
            setName('');
          }}
          style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}
        >
          <input
            aria-label="Saved selection name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="name selected range"
            maxLength={256}
          />
          <button type="submit" style={SMALL_BUTTON_STYLE}>save selection</button>
        </form>
        {selectionError && (
          <p role="alert" style={{ margin: 0, color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            {selectionError}
          </p>
        )}
        {selections.length > 0 && (
          <ul aria-label="Saved selections" style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {selections.map((selection) => {
              const check = selectionChecks.get(selection.id);
              return (
              <li key={selection.id}>
                {selection.name}{' '}
                <button type="button" onClick={() => applySelection(selection.id)} style={SMALL_BUTTON_STYLE}>
                  apply
                </button>{' '}
                <button type="button" onClick={() => removeSelection(selection.id)} style={SMALL_BUTTON_STYLE}>
                  remove
                </button>
                {check && (
                  <p
                    role={check.status === 'ok' ? 'status' : 'alert'}
                    style={{
                      margin: 'var(--space-1) 0',
                      color: check.status === 'ok'
                        ? 'var(--fg-muted)'
                        : 'var(--accent-text)',
                      fontSize: 'var(--text-xs)',
                    }}
                  >
                    {check.status === 'ok'
                      ? 'Checked in this session; ready to use as the linked range.'
                      : check.message}
                  </p>
                )}
              </li>
              );
            })}
          </ul>
        )}
        {restoreIssues.length > 0 && (
          <div role="status" style={{ fontSize: 'var(--text-sm)' }}>
            <strong>{restoreIssues.length} saved pin{restoreIssues.length === 1 ? '' : 's'} need review</strong>
            <ul>
              {restoreIssues.map((issue) => (
                <li key={issue.pin.id}>
                  {issue.pin.note || issue.pin.anchor.doc}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <button
            type="button"
            onClick={() => {
              try {
                setShareUrl(createShareUrl());
              } catch (error) {
                setShareUrl(error instanceof Error ? error.message : String(error));
              }
            }}
            style={{ ...SMALL_BUTTON_STYLE, width: 'fit-content' }}
          >
            preview share link
          </button>
          {shareUrl && (
            <>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
                Preview: {selections.length} saved selection{selections.length === 1 ? '' : 's'}; pins and source text are excluded.
              </span>
              <textarea
                aria-label="Share link preview"
                readOnly
                value={shareUrl}
                rows={3}
                style={{ width: 'min(100%, 72rem)', fontFamily: 'var(--font-mono)' }}
              />
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(shareUrl)}
                style={{ ...SMALL_BUTTON_STYLE, width: 'fit-content' }}
              >
                copy share link
              </button>
            </>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const decoded = decodeShareLink(importValue);
              setImportPreview(
                `${decoded.n.groups.length} notebook group${decoded.n.groups.length === 1 ? '' : 's'}, ${decoded.x.length} referenced document${decoded.x.length === 1 ? '' : 's'}, and ${(decoded.r ?? []).length} anchor${(decoded.r ?? []).length === 1 ? '' : 's'}`,
              );
            } catch (error) {
              setImportPreview(`Invalid share link: ${error instanceof Error ? error.message : String(error)}`);
            }
          }}
          style={{ display: 'grid', gap: 'var(--space-1)' }}
        >
          <textarea
            aria-label="Share link to import"
            value={importValue}
            onChange={(event) => setImportValue(event.target.value)}
            placeholder="paste a textTrends share link"
            rows={2}
            style={{ width: 'min(100%, 72rem)', fontFamily: 'var(--font-mono)' }}
          />
          <button type="submit" style={{ ...SMALL_BUTTON_STYLE, width: 'fit-content' }}>
            preview shared state
          </button>
        </form>
        {importPreview && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--text-sm)' }}>{importPreview}</span>
            {!importPreview.startsWith('Invalid') && (
              <button
                type="button"
                onClick={() => {
                  importShare(importValue);
                  setImportPreview(null);
                }}
                style={SMALL_BUTTON_STYLE}
              >
                replace with this shared state
              </button>
            )}
          </div>
        )}
        {shareNotice && (
          <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{shareNotice}</p>
        )}
      </section>
    </details>
  );
}
