import { readerCommand } from '../../lib/reader-commands.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';
import { useApp } from '../../lib/store-instance.ts';
import { useReaderChromeModel } from './useReaderChromeModel.ts';

export function ReaderRuler() {
  const scale = useApp((state) => state.readerScale);
  const enterRsvp = useApp((state) => state.enterRsvp);
  const stepDocument = useApp((state) => state.stepReaderDocument);
  const { position, progress, commands } = useReaderChromeModel();
  if (position === null || scale !== 'read') return null;
  const hasMultipleTexts = position.textCount > 1;
  const previousCommand = readerCommand(commands, 'text-previous');
  const nextCommand = readerCommand(commands, 'text-next');
  const speedCommand = readerCommand(commands, 'speed');

  return (
    <nav
      className="reader-ruler"
      aria-label="Text navigation"
      data-reader-scale="read"
      data-multiple-texts={hasMultipleTexts || undefined}
    >
      {previousCommand.present && (
        <button
          type="button"
          className="reader-ruler-previous"
          aria-label={previousCommand.accessibleName}
          aria-keyshortcuts={shortcutAria(['reader-text-previous'])}
          disabled={!previousCommand.enabled}
          onClick={() => stepDocument(-1)}
        >
          <span aria-hidden="true">←</span>{' '}
          <span className="reader-ruler-button-label">previous text</span>
        </button>
      )}
      <div className="reader-ruler-current">
        {hasMultipleTexts && (
          <span className="reader-ruler-ordinal">
            text {Math.max(1, position.ordinal).toLocaleString()} of {position.textCount.toLocaleString()}
          </span>
        )}
        <strong title={position.title}>{position.title}</strong>
        <span className="reader-ruler-meta">
          {progress === null
            ? 'position unavailable'
            : `token ${Math.min(position.tokenCount, position.token + 1).toLocaleString()} of ${position.tokenCount.toLocaleString()} · ${progress.percent}%`}
        </span>
        {progress !== null && (
          <span
            className="reader-ruler-progress"
            role="progressbar"
            aria-label={`Position in ${position.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <span style={{ inlineSize: `${progress.percent}%` }} />
          </span>
        )}
      </div>
      {nextCommand.present && (
        <button
          type="button"
          className="reader-ruler-next"
          aria-label={nextCommand.accessibleName}
          aria-keyshortcuts={shortcutAria(['reader-text-next'])}
          disabled={!nextCommand.enabled}
          onClick={() => stepDocument(1)}
        >
          <span className="reader-ruler-button-label">next text</span>{' '}
          <span aria-hidden="true">→</span>
        </button>
      )}
      <button
        type="button"
        className="reader-ruler-speed"
        aria-label={speedCommand.accessibleName}
        aria-keyshortcuts={shortcutAria(['reader-rsvp-toggle'])}
        disabled={!speedCommand.enabled}
        onClick={() => enterRsvp(false)}
      >
        <span aria-hidden="true">▶</span>{' '}speed
      </button>
    </nav>
  );
}
