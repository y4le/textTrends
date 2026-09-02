import type { MouseEvent, ReactNode } from 'react';
import { readerCommand, type ReaderCommand } from '../../lib/reader-commands.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../../lib/series-style.ts';
import type { TrackLegendEntry } from '../../lib/track-legend.ts';
import { useApp } from '../../lib/store-instance.ts';
import { ReaderProgressRail } from './ReaderProgressRail.tsx';
import { useReaderChromeModel } from './useReaderChromeModel.ts';

function RailCommandButton({
  command,
  onClick,
  id,
  children,
}: {
  readonly command: ReaderCommand;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly id?: string;
  readonly children?: ReactNode;
}) {
  if (!command.present) return null;
  return (
    <button
      id={id}
      type="button"
      aria-label={command.accessibleName}
      aria-keyshortcuts={command.shortcut === undefined
        ? undefined
        : shortcutAria([command.shortcut])}
      disabled={!command.enabled}
      title={command.enabled ? command.accessibleName : command.reason}
      onClick={onClick}
    >
      {children ?? command.label}
    </button>
  );
}

export function ReaderWideRails({
  legend,
  showProgress,
  showReference,
  onOpenFind,
  onOpenSettings,
  onOpenHelp,
  onAnnounce,
}: {
  readonly legend: readonly TrackLegendEntry[];
  readonly showProgress: boolean;
  readonly showReference: boolean;
  readonly onOpenFind: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
  readonly onOpenHelp: () => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const closeReader = useApp((state) => state.closeReader);
  const navigation = useApp((state) => state.readerNavigation);
  const navigateReader = useApp((state) => state.navigateReader);
  const seekReader = useApp((state) => state.seekReader);
  const stepOccurrence = useApp((state) => state.stepOccurrence);
  const stepDocument = useApp((state) => state.stepReaderDocument);
  const setScale = useApp((state) => state.setReaderScale);
  const enterRsvp = useApp((state) => state.enterRsvp);
  const { position, progress, commands } = useReaderChromeModel();
  const command = (id: Parameters<typeof readerCommand>[1]) => readerCommand(commands, id);
  const pageRange = position?.pageRange ?? null;
  const movePage = (direction: -1 | 1) => {
    const target = direction === -1 ? navigation?.previous : navigation?.next;
    if (target === null || target === undefined) return;
    onAnnounce('');
    navigateReader(target);
  };
  const moveReference = (direction: -1 | 1) => {
    onAnnounce('');
    stepOccurrence(direction);
  };
  const moveText = (direction: -1 | 1) => {
    onAnnounce('');
    stepDocument(direction);
  };
  const moveToBoundary = (boundary: 'start' | 'end') => {
    onAnnounce('');
    if (boundary === 'start') navigateReader({ kind: 'from', token: 0 });
    else if (position !== null && position.tokenCount > 0) {
      navigateReader({ kind: 'before', token: position.tokenCount });
    }
  };

  return (
    <>
      <aside className="reader-wide-rail reader-wide-rail-left" aria-label="Reader navigation rail">
        <RailCommandButton command={command('exit')} onClick={closeReader}>
          <span aria-hidden="true">←</span>{' '}Back
        </RailCommandButton>

        {(command('scale').present || command('speed').present) && (
          <section aria-labelledby="reader-wide-view-heading">
            <h3 id="reader-wide-view-heading">View</h3>
            <div className="reader-wide-actions">
              <RailCommandButton command={command('scale')} onClick={() => setScale('atlas')} />
              <RailCommandButton command={command('speed')} onClick={() => enterRsvp(false)}>
                <span aria-hidden="true">▶</span>{' '}Speed
              </RailCommandButton>
            </div>
          </section>
        )}

        {command('text-previous').present && (
          <section aria-labelledby="reader-wide-text-heading">
            <h3 id="reader-wide-text-heading">Texts</h3>
            <span className="reader-wide-ordinal">
              text {Math.max(1, position?.ordinal ?? 1).toLocaleString()} of{' '}
              {(position?.textCount ?? 0).toLocaleString()}
            </span>
            <div className="reader-wide-actions">
              <RailCommandButton
                command={command('text-previous')}
                onClick={() => moveText(-1)}
              >
                <span aria-hidden="true">←</span>{' '}text
              </RailCommandButton>
              <RailCommandButton command={command('text-next')} onClick={() => moveText(1)}>
                text{' '}<span aria-hidden="true">→</span>
              </RailCommandButton>
            </div>
          </section>
        )}

        <section aria-labelledby="reader-wide-page-heading">
          <h3 id="reader-wide-page-heading">Page</h3>
          <div className="reader-wide-actions">
            <RailCommandButton command={command('page-previous')} onClick={() => movePage(-1)}>
              <span aria-hidden="true">←</span>{' '}page
            </RailCommandButton>
            <RailCommandButton command={command('page-next')} onClick={() => movePage(1)}>
              page{' '}<span aria-hidden="true">→</span>
            </RailCommandButton>
            <RailCommandButton command={command('text-start')} onClick={() => moveToBoundary('start')} />
            <RailCommandButton command={command('text-end')} onClick={() => moveToBoundary('end')} />
          </div>
        </section>

        <section className="reader-wide-utilities" aria-labelledby="reader-wide-tools-heading">
          <h3 id="reader-wide-tools-heading">Tools</h3>
          <div className="reader-wide-actions">
            <RailCommandButton
              id="reader-find-open-wide"
              command={command('find')}
              onClick={onOpenFind}
            />
            <RailCommandButton
              command={command('settings')}
              onClick={(event) => onOpenSettings(event.currentTarget)}
            />
            <RailCommandButton command={command('help')} onClick={onOpenHelp} />
          </div>
        </section>
      </aside>

      <aside className="reader-wide-rail reader-wide-rail-right" aria-label="Reader position rail">
        <header className="reader-wide-position">
          <strong title={position?.title}>{position?.title ?? 'Loading source text…'}</strong>
          {position !== null && (
            <>
              <span>
                token {Math.min(position.tokenCount, position.token + 1).toLocaleString()} of{' '}
                {position.tokenCount.toLocaleString()}
              </span>
              <span>{progress?.percent ?? 0}%</span>
              <span>
                {pageRange === null
                  ? 'page range fitting…'
                  : `page ${(pageRange.start + 1).toLocaleString()}–${pageRange.end.toLocaleString()}`}
              </span>
            </>
          )}
        </header>

        <div className="reader-wide-progress-wrap" aria-hidden={!showProgress || undefined}>
          {showProgress && (
            <ReaderProgressRail
              className="reader-wide-progress"
              orientation="vertical"
              progress={progress}
              accessibleName={position === null ? 'Reading position' : `Position in ${position.title}`}
              onSeek={seekReader}
            />
          )}
        </div>

        {legend.length > 0 && (
          <section aria-labelledby="reader-wide-highlights-heading">
            <h3 id="reader-wide-highlights-heading">Highlights</h3>
            <ul className="reader-wide-highlights">
              {legend.map((entry) => (
                <li
                  key={entry.seriesId}
                  style={{ borderInlineStartColor: seriesColor(entry.style ?? DEFAULT_SERIES_STYLE) }}
                >
                  {entry.label}{entry.stale ? ' · changed' : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
        {showReference && command('reference-previous').present && (
          <section aria-labelledby="reader-wide-reference-heading">
            <h3 id="reader-wide-reference-heading">Reference</h3>
            <div className="reader-wide-actions">
              <RailCommandButton
                command={command('reference-previous')}
                onClick={() => moveReference(-1)}
              >
                <span aria-hidden="true">←</span>{' '}ref
              </RailCommandButton>
              <RailCommandButton
                command={command('reference-next')}
                onClick={() => moveReference(1)}
              >
                ref{' '}<span aria-hidden="true">→</span>
              </RailCommandButton>
            </div>
          </section>
        )}
      </aside>
    </>
  );
}
