import { MAX_KWIC_TRACKS, NOTEBOOK_LIMITS_V1 } from '@texttrends/core';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  FIND_INPUT_ID,
  findBarModel,
  findMatchProgress,
  findScope,
  findStatusText,
} from '../lib/interaction.ts';
import { shortcutAria } from '../lib/shortcuts.ts';
import { parseAuthoredAliases } from '../lib/notebook.ts';
import { useApp } from '../lib/store-instance.ts';
import { DockTakeover } from './DockTakeover.tsx';

const FIND_RESULT_ID = 'corpus-find-result';

type FindBarProps =
  | {
      readonly onClose: () => void;
      readonly onExitReader: () => void;
      readonly placement: 'reader';
    }
  | {
      readonly onClose: () => void;
      readonly onExitReader?: never;
      readonly placement?: 'rail' | 'floating';
    };

export function FindBar(props: FindBarProps) {
  const { onClose } = props;
  const placement = props.placement ?? 'floating';
  const onExitReader = props.placement === 'reader' ? props.onExitReader : undefined;
  const interaction = useApp((state) => state.interaction);
  const interactionError = useApp((state) => state.interactionError);
  const matches = useApp((state) => state.kwic);
  const notebookTermCount = useApp((state) => state.notebook.groups.length);
  const activeTermCount = useApp((state) => state.activeGroupIds.size);
  const clearInteractionError = useApp((state) => state.clearInteractionError);
  const clearNotebookError = useApp((state) => state.clearNotebookError);
  const addTerm = useApp((state) => state.addTerm);
  const submitFind = useApp((state) => state.submitFind);
  const stepFind = useApp((state) => state.stepFind);
  const openReader = useApp((state) => state.openReader);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const scopedFind = findScope(interaction);
  const find = scopedFind?.find ?? null;
  const submittedRaw = find?.query.raw ?? '';
  const [draft, setDraft] = useState(submittedRaw);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const model = findBarModel(interaction);
  const progress = findMatchProgress(find, matches);
  const rail = placement === 'rail';
  const reader = placement === 'reader';
  const takeover = rail || reader;
  const submittedDraft = find !== null && draft === submittedRaw;
  const notebookAtCapacity = notebookTermCount >= NOTEBOOK_LIMITS_V1.maxGroups;
  const analysisAtCapacity = activeTermCount >= MAX_KWIC_TRACKS;
  const saveDisabled = find === null || notebookAtCapacity || analysisAtCapacity;
  const saveTitle = notebookAtCapacity
    ? `Terms is limited to ${NOTEBOOK_LIMITS_V1.maxGroups} saved terms`
    : analysisAtCapacity
      ? `Deactivate a term before saving this Find; analysis shows up to ${MAX_KWIC_TRACKS}`
      : find === null
        ? 'Run Find before saving a term'
        : `Save ${find.query.label} to Terms`;

  useEffect(() => {
    setDraft(submittedRaw);
    setSaveStatus('');
    setSaveError('');
  }, [submittedRaw]);

  if (scopedFind === null) return null;

  const titleFor = (doc: string) =>
    project?.data.docs.find((candidate) => candidate.doc === doc)?.meta.title ?? doc;
  const status = findStatusText(find, titleFor);
  const submitDraft = () => {
    setSaveStatus('');
    setSaveError('');
    const accepted = submitFind(draft);
    requestAnimationFrame(() => {
      if (accepted) nextRef.current?.focus({ preventScroll: true });
      else document.getElementById(FIND_INPUT_ID)?.focus({ preventScroll: true });
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const openCurrentResult = () => {
    if (find?.state.status !== 'ready') return;
    openReader(
      {
        snapshot: find.snapshot,
        doc: find.state.hit.doc,
        token: find.state.hit.token,
        from: 'occurrence',
        anchor: 'occurrence',
      },
      FIND_RESULT_ID,
    );
  };
  const saveCurrentFind = () => {
    if (find === null || notebookAtCapacity || analysisAtCapacity) return;
    clearNotebookError();
    const groupId = addTerm({ aliases: parseAuthoredAliases(find.query.raw) });
    if (groupId === null) {
      setSaveError(useApp.getState().notebookError ?? 'Could not save this Find to Terms.');
      setSaveStatus('');
      return;
    }
    setSaveError('');
    setSaveStatus(`Saved ${find.query.label} to Terms.`);
  };
  const statusContent = (
    <>
      <span className="find-bar-status-text">{status}</span>
      {progress !== null && (
        <span
          className="find-bar-match-progress"
          data-find-match-progress
          aria-label={`Find match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`}
        >
          <span aria-hidden="true">
            {progress.current.toLocaleString()}/{progress.total.toLocaleString()}
          </span>
        </span>
      )}
    </>
  );

  return (
    <section
      className={`find-bar find-bar--${placement}${rail ? ' query-region term-bar' : ''}`}
      data-interaction-surface="find"
      role="search"
      aria-label="Find in corpus"
      aria-busy={model.busy}
      data-takeover={takeover ? 'find' : undefined}
      onKeyDown={handleKeyDown}
    >
      {reader ? (
        <>
          <form className="reader-find-form" onSubmit={submit}>
            <button
              type="button"
              className="reader-find-exit"
              aria-label="Return to workbench"
              aria-keyshortcuts={shortcutAria(['reader-close'])}
              onClick={onExitReader}
            >
              <span aria-hidden="true">←</span>{' '}
              <span className="reader-find-exit-label" aria-hidden="true">back</span>
            </button>
            <label className="reader-find-label" htmlFor={FIND_INPUT_ID}>Find</label>
            <div className="reader-find-field">
              <input
                id={FIND_INPUT_ID}
                type="search"
                value={draft}
                aria-label="Find term or aliases"
                placeholder="word, phrase, alias*"
                aria-describedby="corpus-find-status corpus-find-error"
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setSaveStatus('');
                  setSaveError('');
                  if (interactionError !== null) clearInteractionError();
                }}
              />
              {submittedDraft && progress !== null && (
                <span
                  className="reader-find-progress"
                  title={status}
                  aria-hidden="true"
                >
                  {progress.current.toLocaleString()}/{progress.total.toLocaleString()}
                </span>
              )}
            </div>
            <div className="reader-find-actions">
              {!submittedDraft ? (
                <button
                  type="submit"
                  aria-label="Submit find"
                  disabled={draft.trim() === ''}
                >
                  Find
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="find-bar-icon-action"
                    aria-label="Previous match"
                    aria-keyshortcuts={shortcutAria(['find-previous'])}
                    onClick={() => {
                      setSaveStatus('');
                      setSaveError('');
                      stepFind(-1);
                    }}
                  >
                    <span className="find-bar-action-glyph" aria-hidden="true">←</span>
                  </button>
                  <button
                    ref={nextRef}
                    type="button"
                    className="find-bar-icon-action"
                    aria-label="Next match"
                    aria-keyshortcuts={shortcutAria(['find-next'])}
                    onClick={() => {
                      setSaveStatus('');
                      setSaveError('');
                      stepFind(1);
                    }}
                  >
                    <span className="find-bar-action-glyph" aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    aria-label={saveStatus === '' ? 'Save Find as term' : 'Saved Find as term'}
                    title={saveStatus === '' ? saveTitle : `${find.query.label} saved to Terms`}
                    disabled={saveDisabled || saveStatus !== ''}
                    onClick={saveCurrentFind}
                  >
                    <span className="reader-find-save-wide" aria-hidden="true">
                      {saveStatus === '' ? 'save' : 'saved'}
                    </span>
                    <span className="reader-find-save-compact" aria-hidden="true">
                      {saveStatus === '' ? '+' : '✓'}
                    </span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="find-bar-icon-action"
                aria-label="Clear and close find"
                aria-keyshortcuts={shortcutAria(['find-close'])}
                onClick={onClose}
              >
                <span className="find-bar-action-glyph" aria-hidden="true">×</span>
              </button>
            </div>
          </form>
          <p
            id="corpus-find-status"
            className="visually-hidden"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {saveStatus || status}
            {progress !== null
              ? ` Find match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}.`
              : ''}
          </p>
          <p
            id="corpus-find-error"
            className="visually-hidden"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {interactionError ?? saveError}
          </p>
        </>
      ) : rail ? (
        <>
          <DockTakeover
            mode="find"
            formLabel="Find in corpus controls"
            label="Find"
            input={{
              id: FIND_INPUT_ID,
              ariaLabel: 'Find term or aliases',
              type: 'search',
              value: draft,
              placeholder: 'word, phrase, alias*',
              enterKeyHint: 'search',
              describedBy: 'corpus-find-status corpus-find-error',
              onChange: (value) => {
                setDraft(value);
                setSaveStatus('');
                setSaveError('');
                if (interactionError !== null) clearInteractionError();
              },
            }}
            status={(interactionError ?? saveError) || saveStatus || status}
            statusTone={interactionError !== null || saveError !== ''
              ? 'error'
              : saveStatus !== '' ? 'success' : 'muted'}
            busy={model.busy}
            onSubmit={submitDraft}
            onDismiss={onClose}
            controls={(
              <>
                {!submittedDraft ? (
                  <button
                    type="submit"
                    aria-label="Submit find"
                    disabled={draft.trim() === ''}
                  >
                    Find
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="find-bar-icon-action"
                      aria-label="Previous match"
                      aria-keyshortcuts={shortcutAria(['find-previous'])}
                      onClick={() => {
                        setSaveStatus('');
                        setSaveError('');
                        stepFind(-1);
                      }}
                    >
                      <span className="find-bar-action-glyph" aria-hidden="true">←</span>
                    </button>
                    <button
                      ref={nextRef}
                      type="button"
                      className="find-bar-icon-action"
                      aria-label="Next match"
                      aria-keyshortcuts={shortcutAria(['find-next'])}
                      onClick={() => {
                        setSaveStatus('');
                        setSaveError('');
                        stepFind(1);
                      }}
                    >
                      <span className="find-bar-action-glyph" aria-hidden="true">→</span>
                    </button>
                    {find.state.status === 'ready' && (
                      <button
                        id={FIND_RESULT_ID}
                        type="button"
                        className="dock-takeover-result"
                        title={progress === null
                          ? 'Open current Find result in Reader'
                          : `Open current Find result in Reader — match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`}
                        onClick={openCurrentResult}
                      >
                        <span className="visually-hidden">
                          Open current Find result in Reader: {status}.{' '}
                        </span>
                        {progress === null ? (
                          <span aria-hidden="true">Open</span>
                        ) : (
                          <span
                            data-find-match-progress
                            aria-label={`Find match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`}
                          >
                            <span className="visually-hidden" data-find-match-exact aria-hidden="true">
                              {progress.current.toLocaleString()}/{progress.total.toLocaleString()}
                            </span>
                            <span className="find-bar-progress-percent" aria-hidden="true">
                              {Math.round((progress.current / progress.total) * 100)}%
                            </span>
                          </span>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={saveStatus === '' ? 'Save Find as term' : 'Saved Find as term'}
                      title={saveStatus === '' ? saveTitle : `${find.query.label} saved to Terms`}
                      disabled={saveDisabled || saveStatus !== ''}
                      onClick={saveCurrentFind}
                    >
                      {saveStatus === '' ? 'Save' : 'Saved'}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="dock-takeover-icon-action find-bar-icon-action"
                  aria-label="Clear and close find"
                  aria-keyshortcuts={shortcutAria(['find-close'])}
                  onClick={onClose}
                >
                  <span className="find-bar-action-glyph" aria-hidden="true">×</span>
                </button>
              </>
            )}
          />
          <p
            id="corpus-find-status"
            className="visually-hidden"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {saveStatus || status}
            {progress !== null
              ? ` Find match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}.`
              : ''}
          </p>
          <p
            id="corpus-find-error"
            className="visually-hidden"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {interactionError ?? saveError}
          </p>
        </>
      ) : (
        <>
          <label
            className={rail ? 'term-bar-label' : 'find-bar-label'}
            htmlFor={FIND_INPUT_ID}
          >
            Find
          </label>
          <form className="find-bar-form" onSubmit={submit}>
            <input
              id={FIND_INPUT_ID}
              type="search"
              value={draft}
              aria-label="Find term or aliases"
              placeholder="word, phrase, alias*"
              aria-describedby="corpus-find-status corpus-find-error"
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setSaveStatus('');
                setSaveError('');
                if (interactionError !== null) clearInteractionError();
              }}
            />
            <button type="submit" className="coarse-target" aria-label="Submit find">Find</button>
            <button
              type="button"
              className="coarse-target"
              aria-label="Save Find as term"
              title={saveTitle}
              disabled={saveDisabled}
              onClick={saveCurrentFind}
            >
              Save
            </button>
          </form>
          <div className="find-bar-actions">
            <button
              type="button"
              className="coarse-target find-bar-icon-action"
              aria-label="Previous match"
              aria-keyshortcuts={shortcutAria(['find-previous'])}
              disabled={!model.hasSubmittedQuery}
              onClick={() => stepFind(-1)}
            >
              <span className="find-bar-action-glyph" aria-hidden="true">←</span>
            </button>
            <button
              ref={nextRef}
              type="button"
              className="coarse-target find-bar-icon-action"
              aria-label="Next match"
              aria-keyshortcuts={shortcutAria(['find-next'])}
              disabled={!model.hasSubmittedQuery}
              onClick={() => stepFind(1)}
            >
              <span className="find-bar-action-glyph" aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              className="coarse-target find-bar-icon-action"
              aria-label="Clear and close find"
              aria-keyshortcuts={shortcutAria(['find-close'])}
              onClick={onClose}
            >
              <span className="find-bar-action-glyph" aria-hidden="true">×</span>
            </button>
          </div>
          <p
            id="corpus-find-status"
            className="find-bar-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {find?.state.status === 'ready' ? (
              <button
                id={FIND_RESULT_ID}
                type="button"
                className="find-bar-result"
                title="Open current Find result in Reader"
                onClick={openCurrentResult}
              >
                <span className="visually-hidden">Open current Find result in Reader: </span>
                {statusContent}
              </button>
            ) : statusContent}
          </p>
          <p
            id="corpus-find-error"
            className="find-bar-error"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {interactionError ?? saveError}
          </p>
        </>
      )}
    </section>
  );
}
