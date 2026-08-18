import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  FIND_INPUT_ID,
  findBarModel,
  findMatchProgress,
  findStatusText,
} from '../lib/interaction.ts';
import { shortcutAria } from '../lib/shortcuts.ts';
import { useApp } from '../lib/store-instance.ts';

export function FindBar({
  onClose,
  placement = 'floating',
}: {
  readonly onClose: () => void;
  readonly placement?: 'rail' | 'floating';
}) {
  const interaction = useApp((state) => state.interaction);
  const interactionError = useApp((state) => state.interactionError);
  const matches = useApp((state) => state.kwic);
  const clearInteractionError = useApp((state) => state.clearInteractionError);
  const submitFind = useApp((state) => state.submitFind);
  const stepFind = useApp((state) => state.stepFind);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const find = interaction.kind === 'find' ? interaction.find : null;
  const submittedRaw = find?.query.raw ?? '';
  const [draft, setDraft] = useState(submittedRaw);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const model = findBarModel(interaction);
  const progress = findMatchProgress(find, matches);
  const rail = placement === 'rail';

  useEffect(() => setDraft(submittedRaw), [submittedRaw]);

  if (interaction.kind !== 'find') return null;

  const titleFor = (doc: string) =>
    project?.data.docs.find((candidate) => candidate.doc === doc)?.meta.title ?? doc;
  const status = findStatusText(find, titleFor);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitFind(draft)) {
      requestAnimationFrame(() => nextRef.current?.focus({ preventScroll: true }));
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      className={`find-bar find-bar--${placement}${rail ? ' query-region term-bar' : ''}`}
      data-interaction-surface="find"
      role="search"
      aria-label="Find in corpus"
      aria-busy={model.busy}
      data-find-submitted={model.hasSubmittedQuery || undefined}
      onKeyDown={handleKeyDown}
    >
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
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (interactionError !== null) clearInteractionError();
          }}
        />
        <button type="submit" className="coarse-target" aria-label="Submit find">Find</button>
      </form>
      <div
        className="find-bar-actions"
        data-has-find-progress={progress !== null || undefined}
      >
        {progress !== null && (
          <output
            className="find-bar-match-progress"
            data-find-match-progress
            aria-label={`Find match ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`}
            aria-live="polite"
            aria-atomic="true"
          >
            <span aria-hidden="true">
              {progress.current.toLocaleString()}/{progress.total.toLocaleString()}
            </span>
          </output>
        )}
        <button
          type="button"
          className="coarse-target"
          aria-label="Previous match"
          aria-keyshortcuts={shortcutAria(['find-previous'])}
          disabled={!model.hasSubmittedQuery}
          onClick={() => stepFind(-1)}
        >
          previous
        </button>
        <button
          ref={nextRef}
          type="button"
          className="coarse-target"
          aria-label="Next match"
          aria-keyshortcuts={shortcutAria(['find-next'])}
          disabled={!model.hasSubmittedQuery}
          onClick={() => stepFind(1)}
        >
          next
        </button>
        <button
          type="button"
          className="coarse-target"
          aria-label="Clear and close find"
          aria-keyshortcuts={shortcutAria(['find-close'])}
          onClick={onClose}
        >
          {rail ? <span aria-hidden="true">×</span> : 'close'}
        </button>
      </div>
      <p
        id="corpus-find-status"
        className="find-bar-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status}
      </p>
      <p id="corpus-find-error" className="find-bar-error" role={interactionError ? 'alert' : undefined}>
        {interactionError}
      </p>
    </section>
  );
}
