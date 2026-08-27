import { useEffect, useRef, useState } from 'react';
import { STOPLIST_MAX_TOP_N } from '@texttrends/core';
import { useApp } from '../../lib/store-instance.ts';

export function VocabularySettings() {
  const view = useApp((state) => state.frequencyView);
  const frequency = useApp((state) => state.frequency);
  const setFrequencyStoplistTopN = useApp(
    (state) => state.setFrequencyStoplistTopN,
  );
  const [draft, setDraft] = useState(view.stoplistTopN);
  const latestDraftRef = useRef(draft);
  const appliedRef = useRef(view.stoplistTopN);

  latestDraftRef.current = draft;
  appliedRef.current = view.stoplistTopN;

  useEffect(() => {
    setDraft(view.stoplistTopN);
  }, [view.stoplistTopN]);

  useEffect(() => {
    if (draft === view.stoplistTopN) return undefined;
    const timer = window.setTimeout(() => {
      appliedRef.current = draft;
      setFrequencyStoplistTopN(draft);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draft, setFrequencyStoplistTopN, view.stoplistTopN]);

  useEffect(() => () => {
    if (latestDraftRef.current === appliedRef.current) return;
    setFrequencyStoplistTopN(latestDraftRef.current);
  }, [setFrequencyStoplistTopN]);

  const readyResult = frequency?.resident
    ?? (frequency?.state.status === 'ready' ? frequency.state.result : null);
  const applied = draft === view.stoplistTopN;
  const pending = !applied || frequency?.state.status === 'pending';

  return (
    <form
      className="vocabulary-settings"
      aria-label="Vocabulary settings"
      onSubmit={(event) => event.preventDefault()}
    >
      <fieldset>
        <legend>Rankings</legend>
        <div className="common-words-field">
          <label htmlFor="vocabulary-common-words">remove common words</label>
          <div className="common-words-control">
            <input
              id="vocabulary-common-words"
              type="range"
              min={0}
              max={STOPLIST_MAX_TOP_N}
              step={5}
              value={draft}
              aria-valuetext={draft === 0
                ? 'off — no reference words removed'
                : `top ${draft} reference words`}
              aria-describedby="vocabulary-common-words-note vocabulary-common-words-status"
              onChange={(event) => setDraft(event.currentTarget.valueAsNumber)}
            />
            <output htmlFor="vocabulary-common-words">
              {draft === 0
                ? 'off'
                : readyResult?.stoplist?.topN === draft
                  ? `top ${draft} · ${readyResult.stoplist.removedRows} rows hidden`
                  : `top ${draft}`}
            </output>
          </div>
          <p id="vocabulary-common-words-note">
            Uses the bundled English common-word reference. Remaining counts and rates
            do not change.
          </p>
          <span
            id="vocabulary-common-words-status"
            className="visually-hidden"
            role="status"
            aria-live="polite"
          >
            {pending
              ? 'Updating vocabulary.'
              : draft === 0
                ? 'Common-word filtering is off.'
                : `${readyResult?.stoplist?.removedRows ?? 0} vocabulary rows hidden.`}
          </span>
        </div>
      </fieldset>
    </form>
  );
}
