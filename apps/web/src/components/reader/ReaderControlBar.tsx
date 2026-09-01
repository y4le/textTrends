import { readerCommand } from '../../lib/reader-commands.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';
import { useApp } from '../../lib/store-instance.ts';
import { ReaderProgressRail } from './ReaderProgressRail.tsx';
import { useReaderChromeModel } from './useReaderChromeModel.ts';

export function ReaderControlBar({
  title,
  onOpenControls,
  onAnnounce,
}: {
  readonly title: string;
  readonly onOpenControls: (returnFocus: HTMLElement) => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const closeReader = useApp((state) => state.closeReader);
  const navigateReader = useApp((state) => state.navigateReader);
  const navigation = useApp((state) => state.readerNavigation);
  const enterRsvp = useApp((state) => state.enterRsvp);
  const { position, progress, commands } = useReaderChromeModel();
  const exitCommand = readerCommand(commands, 'exit');
  const previousCommand = readerCommand(commands, 'page-previous');
  const nextCommand = readerCommand(commands, 'page-next');
  const speedCommand = readerCommand(commands, 'speed');
  const positionTitle = position?.title ?? title;
  const positionText = position === null || progress === null
    ? 'loading position…'
    : `token ${Math.min(position.tokenCount, position.token + 1).toLocaleString()} · ${progress.percent}%`;
  const openLabel = position === null
    ? `Open Reader controls for ${positionTitle}`
    : `Open Reader controls for ${positionTitle}, ${positionText}`;
  const movePage = (direction: -1 | 1) => {
    const target = direction === -1 ? navigation?.previous : navigation?.next;
    if (target === null || target === undefined) return;
    onAnnounce('');
    navigateReader(target);
  };

  return (
    <nav className="reader-control-bar" aria-label="Reader controls">
      <ReaderProgressRail
        className="reader-control-progress"
        progress={progress}
        accessibleName={`Position in ${positionTitle}`}
      />
      <button
        type="button"
        className="reader-control-exit"
        aria-label={exitCommand.accessibleName}
        aria-keyshortcuts={shortcutAria(['reader-close'])}
        onClick={closeReader}
      >
        <span aria-hidden="true">←</span>{' '}<span>back</span>
      </button>
      <button
        type="button"
        className="reader-control-page reader-control-page-previous"
        aria-label={previousCommand.accessibleName}
        aria-keyshortcuts={shortcutAria(['reader-page-previous'])}
        disabled={!previousCommand.enabled}
        title={previousCommand.enabled ? previousCommand.accessibleName : previousCommand.reason}
        onClick={() => movePage(-1)}
      >
        <span aria-hidden="true">‹</span>{' '}
        <span className="reader-control-page-label" aria-hidden="true">page</span>
      </button>
      <button
        id="reader-controls-open"
        type="button"
        className="reader-control-position"
        aria-label={openLabel}
        onClick={(event) => onOpenControls(event.currentTarget)}
      >
        <strong title={positionTitle}>{positionTitle}</strong>
        <span>{positionText}</span>
      </button>
      <button
        type="button"
        className="reader-control-page reader-control-page-next"
        aria-label={nextCommand.accessibleName}
        aria-keyshortcuts={shortcutAria(['reader-page-next'])}
        disabled={!nextCommand.enabled}
        title={nextCommand.enabled ? nextCommand.accessibleName : nextCommand.reason}
        onClick={() => movePage(1)}
      >
        <span className="reader-control-page-label" aria-hidden="true">page</span>{' '}
        <span aria-hidden="true">›</span>
      </button>
      <button
        type="button"
        className="reader-control-speed"
        aria-label={speedCommand.accessibleName}
        aria-keyshortcuts={shortcutAria(['reader-rsvp-toggle'])}
        disabled={!speedCommand.enabled}
        title={speedCommand.enabled ? speedCommand.accessibleName : speedCommand.reason}
        onClick={() => enterRsvp(false)}
      >
        <span aria-hidden="true">▶</span>{' '}
        <span className="reader-control-speed-label" aria-hidden="true">speed</span>
      </button>
    </nav>
  );
}
