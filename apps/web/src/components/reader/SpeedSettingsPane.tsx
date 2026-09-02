import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  RSVP_FRAME_CHAR_LIMIT_STEP,
  RSVP_LENGTH_EMPHASIS_STEP,
  RSVP_MAX_FRAME_CHAR_LIMIT,
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WPM,
  RSVP_MIN_EXPOSURE_MS,
  RSVP_MIN_FRAME_CHAR_LIMIT,
  RSVP_PARAGRAPH_PAUSE_STEP_MS,
  RSVP_REST_FLOOR_CROSSOVER_WPM,
  RSVP_RHYTHM_RESET,
  RSVP_SENTENCE_PAUSE_STEP_MS,
  clampRsvpPacing,
  effectiveRsvpWordsPerFrame,
  type RsvpPacing,
} from '@texttrends/rsvp';
import type { RsvpState } from '../../lib/interaction.ts';
import { usePresentation } from '../PresentationProvider.tsx';
import { UtilityPane } from '../UtilityPane.tsx';

type NumberSettingKey =
  | 'frameCharLimit'
  | 'sentencePauseMs'
  | 'paragraphPauseMs'
  | 'lengthEmphasis';

const RSVP_MULTI_WORD_HINT_WPM = 1_200;
const RSVP_FRAME_CHAR_LIMIT_HELP_ID = 'reader-rsvp-frame-char-limit-help';
const RSVP_FRAME_GROUP_HEADING_ID = 'reader-rsvp-frame-group-heading';
const RSVP_RHYTHM_GROUP_HEADING_ID = 'reader-rsvp-rhythm-group-heading';
const RSVP_SENTENCE_REST_HELP_ID = 'reader-rsvp-sentence-rest-help';
const RSVP_PARAGRAPH_REST_HELP_ID = 'reader-rsvp-paragraph-rest-help';

const NUMBER_SETTING_LABEL: Readonly<Record<NumberSettingKey, string>> = Object.freeze({
  frameCharLimit: 'character limit',
  sentencePauseMs: 'sentence rest',
  paragraphPauseMs: 'paragraph rest',
  lengthEmphasis: 'length emphasis',
});

const NUMBER_SETTING_UNIT: Readonly<Record<NumberSettingKey, string>> = Object.freeze({
  frameCharLimit: 'characters',
  sentencePauseMs: 'milliseconds',
  paragraphPauseMs: 'milliseconds',
  lengthEmphasis: 'percent',
});

function stopControlSpace(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === ' ') event.stopPropagation();
}

export function SpeedSettingsPane({
  mode,
  restSummary,
  onSetPacing,
  onOpenHelp,
  onClose,
}: {
  readonly mode: RsvpState;
  readonly restSummary: string;
  readonly onSetPacing: (patch: Partial<RsvpPacing>) => void;
  readonly onOpenHelp: () => void;
  readonly onClose: () => void;
}) {
  const presentation = usePresentation();
  const [drafts, setDrafts] = useState<Record<NumberSettingKey, string>>({
    frameCharLimit: String(mode.frameCharLimit),
    sentencePauseMs: String(mode.sentencePauseMs),
    paragraphPauseMs: String(mode.paragraphPauseMs),
    lengthEmphasis: String(mode.lengthEmphasis),
  });
  const [status, setStatus] = useState('');
  const editingRef = useRef<NumberSettingKey | null>(null);
  const effectiveWords = effectiveRsvpWordsPerFrame(
    mode.wordsPerFrame,
    presentation.width === 'compact',
  );
  const frameLimitInert = effectiveWords === 1;

  useEffect(() => {
    setDrafts((current) => ({
      frameCharLimit: editingRef.current === 'frameCharLimit'
        ? current.frameCharLimit
        : String(mode.frameCharLimit),
      sentencePauseMs: editingRef.current === 'sentencePauseMs'
        ? current.sentencePauseMs
        : String(mode.sentencePauseMs),
      paragraphPauseMs: editingRef.current === 'paragraphPauseMs'
        ? current.paragraphPauseMs
        : String(mode.paragraphPauseMs),
      lengthEmphasis: editingRef.current === 'lengthEmphasis'
        ? current.lengthEmphasis
        : String(mode.lengthEmphasis),
    }));
  }, [mode.frameCharLimit, mode.lengthEmphasis, mode.paragraphPauseMs, mode.sentencePauseMs]);

  useEffect(() => {
    if (status === '') return undefined;
    const timer = window.setTimeout(() => setStatus(''), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const updatePacing = (patch: Partial<RsvpPacing>, message: string) => {
    onSetPacing(patch);
    setStatus(message);
  };
  const finishNumberSettingEdit = (key: NumberSettingKey, commit: boolean) => {
    if (editingRef.current !== key) return;
    editingRef.current = null;
    if (key === 'frameCharLimit' && frameLimitInert) {
      setDrafts((current) => ({ ...current, frameCharLimit: String(mode.frameCharLimit) }));
      return;
    }
    const parsed = drafts[key].trim() === '' ? Number.NaN : Number(drafts[key]);
    if (commit && Number.isFinite(parsed)) {
      const patch = { [key]: parsed } as Pick<RsvpPacing, NumberSettingKey>;
      const bounded = clampRsvpPacing({ ...mode, ...patch });
      updatePacing(
        patch,
        `${NUMBER_SETTING_LABEL[key]} ${bounded[key]} ${NUMBER_SETTING_UNIT[key]}`,
      );
    } else {
      setDrafts((current) => ({ ...current, [key]: String(mode[key]) }));
    }
  };
  const handleNumberSettingKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    key: NumberSettingKey,
  ) => {
    if (key === 'frameCharLimit' && frameLimitInert) {
      if (event.key !== 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finishNumberSettingEdit(key, true);
    } else {
      stopControlSpace(event);
    }
  };
  const highSpeedNote = [
    mode.wpm > RSVP_MULTI_WORD_HINT_WPM && effectiveWords === 1
      ? 'Showing 2 or 3 words at once keeps each frame on screen longer.'
      : '',
    mode.wpm === RSVP_MAX_WPM
      ? `Boundary rests are zero at this pace to preserve the ${RSVP_MIN_EXPOSURE_MS} ms word floor.`
      : mode.wpm > RSVP_REST_FLOOR_CROSSOVER_WPM
        ? `Boundary rests may be capped by the ${RSVP_MIN_EXPOSURE_MS} ms word floor.`
        : '',
  ].filter(Boolean).join(' ');

  return (
    <UtilityPane
      title="Speed settings"
      subtitle="Frame limits, rhythm, and rest timing"
      initialFocus="heading"
      compactClose
      closeOnBackdrop
      layerClassName="reader-controls-layer speed-settings-layer"
      className="reader-controls-pane speed-settings-pane"
      onClose={onClose}
      footer={<button type="button" onClick={onOpenHelp}>Speed reader help</button>}
    >
      <div className="speed-settings-sections">
        <p className="visually-hidden" role="status" aria-live="polite">{status}</p>
        <section
          className="reader-rsvp-settings-group reader-rsvp-frame-settings"
          aria-labelledby={RSVP_FRAME_GROUP_HEADING_ID}
        >
          <h3 id={RSVP_FRAME_GROUP_HEADING_ID}>Frame</h3>
          <p className="reader-rsvp-settings-note">
            Frames stop at the word limit, the character limit, or punctuation — whichever
            comes first. Spaces and punctuation count, and a single long word is always shown whole.
          </p>
          <label>
            <span className="reader-rsvp-setting-label">
              character limit
              <span id={RSVP_FRAME_CHAR_LIMIT_HELP_ID}>
                {frameLimitInert ? 'applies with 2+ words' : 'per frame · at most'}
              </span>
            </span>
            <span className="reader-rsvp-setting-input">
              <input
                type="number"
                inputMode="numeric"
                min={RSVP_MIN_FRAME_CHAR_LIMIT}
                max={RSVP_MAX_FRAME_CHAR_LIMIT}
                step={RSVP_FRAME_CHAR_LIMIT_STEP}
                value={drafts.frameCharLimit}
                readOnly={frameLimitInert}
                aria-disabled={frameLimitInert || undefined}
                aria-label="Frame character limit in characters"
                aria-describedby={RSVP_FRAME_CHAR_LIMIT_HELP_ID}
                onFocus={(event) => {
                  editingRef.current = 'frameCharLimit';
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  if (frameLimitInert) return;
                  const value = event.currentTarget.value;
                  setDrafts((current) => ({ ...current, frameCharLimit: value }));
                }}
                onKeyDown={(event) => handleNumberSettingKeyDown(event, 'frameCharLimit')}
                onBlur={() => finishNumberSettingEdit('frameCharLimit', true)}
              />
              <span>chars</span>
            </span>
          </label>
        </section>

        <section
          className="reader-rsvp-settings-group reader-rsvp-rhythm-settings"
          aria-labelledby={RSVP_RHYTHM_GROUP_HEADING_ID}
        >
          <h3 id={RSVP_RHYTHM_GROUP_HEADING_ID}>Rhythm</h3>
          <p className="reader-rsvp-settings-note">
            Rest values are maxima taken from the current sentence&rsquo;s time.
            {restSummary === '' ? '' : ` When this sheet opened: ${restSummary}.`}
          </p>
          <label>
            <span className="reader-rsvp-setting-label">
              sentence rest
              <span id={RSVP_SENTENCE_REST_HELP_ID}>at most · from sentence time</span>
            </span>
            <span className="reader-rsvp-setting-input">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={RSVP_MAX_SENTENCE_PAUSE_MS}
                step={RSVP_SENTENCE_PAUSE_STEP_MS}
                value={drafts.sentencePauseMs}
                aria-label="Sentence rest in milliseconds"
                aria-describedby={RSVP_SENTENCE_REST_HELP_ID}
                onFocus={(event) => {
                  editingRef.current = 'sentencePauseMs';
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDrafts((current) => ({ ...current, sentencePauseMs: value }));
                }}
                onKeyDown={(event) => handleNumberSettingKeyDown(event, 'sentencePauseMs')}
                onBlur={() => finishNumberSettingEdit('sentencePauseMs', true)}
              />
              <span>ms</span>
            </span>
          </label>

          <label>
            <span className="reader-rsvp-setting-label">
              paragraph rest
              <span id={RSVP_PARAGRAPH_REST_HELP_ID}>at most · from sentence time</span>
            </span>
            <span className="reader-rsvp-setting-input">
              <input
                type="number"
                inputMode="numeric"
                min={mode.sentencePauseMs}
                max={RSVP_MAX_PARAGRAPH_PAUSE_MS}
                step={RSVP_PARAGRAPH_PAUSE_STEP_MS}
                value={drafts.paragraphPauseMs}
                aria-label="Paragraph rest in milliseconds"
                aria-describedby={RSVP_PARAGRAPH_REST_HELP_ID}
                onFocus={(event) => {
                  editingRef.current = 'paragraphPauseMs';
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDrafts((current) => ({ ...current, paragraphPauseMs: value }));
                }}
                onKeyDown={(event) => handleNumberSettingKeyDown(event, 'paragraphPauseMs')}
                onBlur={() => finishNumberSettingEdit('paragraphPauseMs', true)}
              />
              <span>ms</span>
            </span>
          </label>

          <label>
            <span>length emphasis</span>
            <span className="reader-rsvp-setting-input">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={RSVP_MAX_LENGTH_EMPHASIS}
                step={RSVP_LENGTH_EMPHASIS_STEP}
                value={drafts.lengthEmphasis}
                aria-label="Length emphasis in percent"
                onFocus={(event) => {
                  editingRef.current = 'lengthEmphasis';
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDrafts((current) => ({ ...current, lengthEmphasis: value }));
                }}
                onKeyDown={(event) => handleNumberSettingKeyDown(event, 'lengthEmphasis')}
                onBlur={() => finishNumberSettingEdit('lengthEmphasis', true)}
              />
              <span>%</span>
            </span>
          </label>

          <button
            type="button"
            onClick={() => updatePacing(
              RSVP_RHYTHM_RESET,
              'rhythm reset to Natural at 300 words per minute',
            )}
            onKeyDown={stopControlSpace}
          >
            reset
          </button>
        </section>

        {(restSummary !== '' || highSpeedNote !== '') && (
          <section className="speed-settings-diagnostics" aria-labelledby="speed-settings-diagnostics-heading">
            <h3 id="speed-settings-diagnostics-heading">Timing notes</h3>
            {restSummary !== '' && <p>Frame when opened: {restSummary}</p>}
            {highSpeedNote !== '' && <p>{highSpeedNote}</p>}
          </section>
        )}
      </div>
    </UtilityPane>
  );
}
