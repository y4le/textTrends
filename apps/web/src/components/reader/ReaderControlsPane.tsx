import { findScope } from '../../lib/interaction.ts';
import { groupIdentity, groupTitle } from '../../lib/notebook.ts';
import { readerCommand, type ReaderCommand } from '../../lib/reader-commands.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';
import { useApp } from '../../lib/store-instance.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../../lib/series-style.ts';
import { trackLegend } from '../../lib/track-legend.ts';
import { sameReaderPlace } from '../../lib/reader-intent.ts';
import { UtilityPane } from '../UtilityPane.tsx';
import { useReaderChromeModel } from './useReaderChromeModel.ts';
import type { ReactNode } from 'react';

function ReaderCommandButton({
  command,
  onClick,
  children,
}: {
  readonly command: ReaderCommand;
  readonly onClick: () => void;
  readonly children?: ReactNode;
}) {
  if (!command.present) return null;
  return (
    <button
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

export function ReaderControlsPane({
  onClose,
  onOpenSettings,
  onOpenHelp,
  onAnnounce,
}: {
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHelp: () => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const place = useApp((state) => state.readerPlace);
  const pageState = useApp((state) => state.readerPage);
  const notebook = useApp((state) => state.notebook);
  const styles = useApp((state) => state.styles);
  const interaction = useApp((state) => state.interaction);
  const navigation = useApp((state) => state.readerNavigation);
  const navigateReader = useApp((state) => state.navigateReader);
  const stepOccurrence = useApp((state) => state.stepOccurrence);
  const stepDocument = useApp((state) => state.stepReaderDocument);
  const setScale = useApp((state) => state.setReaderScale);
  const enterRsvp = useApp((state) => state.enterRsvp);
  const { position, progress, commands } = useReaderChromeModel();
  const current = place !== null
    && pageState !== null
    && sameReaderPlace(pageState.place, place)
    ? pageState
    : null;
  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const findQuery = scopedFind?.find?.query ?? null;
  const presentedSeries = findMode
    ? findQuery === null
      ? []
      : [{ id: findQuery.seriesId, label: findQuery.label, style: findQuery.style }]
    : notebook.groups.map((group) => ({
        id: group.id,
        label: groupTitle(group),
        style: styles.get(group.id) ?? group.style,
      }));
  const legend = trackLegend(
    current?.tracks ?? [],
    (id) => {
      if (findQuery?.seriesId === id) return findQuery.identity;
      if (findMode) return null;
      const group = notebook.groups.find((candidate) => candidate.id === id);
      return group ? groupIdentity(group) : null;
    },
    presentedSeries,
  );
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
    if (boundary === 'start') {
      navigateReader({ kind: 'from', token: 0 });
    } else if (position !== null && position.tokenCount > 0) {
      navigateReader({ kind: 'before', token: position.tokenCount });
    }
  };
  const switchScale = () => {
    setScale('atlas');
    onClose();
  };
  const startSpeed = () => {
    enterRsvp(false);
    onClose();
  };

  return (
    <UtilityPane
      title="Reader controls"
      subtitle="Reading position and navigation"
      initialFocus="heading"
      compactClose
      closeOnBackdrop
      layerClassName="reader-controls-layer"
      className="reader-controls-pane"
      onClose={onClose}
    >
      <div className="reader-controls-sections">
        <section className="reader-controls-position" aria-labelledby="reader-controls-position-heading">
          <h3 id="reader-controls-position-heading">Position</h3>
          <strong>{position?.title ?? 'Loading source text…'}</strong>
          {position !== null && (
            <>
              {position.textCount > 1 && (
                <span>
                  text {Math.max(1, position.ordinal).toLocaleString()} of {position.textCount.toLocaleString()}
                </span>
              )}
              <span>
                token {Math.min(position.tokenCount, position.token + 1).toLocaleString()} of{' '}
                {position.tokenCount.toLocaleString()}
                {progress === null ? '' : ` · ${progress.percent}%`}
              </span>
              <span>
                {pageRange === null
                  ? 'page range fitting…'
                  : `page tokens ${(pageRange.start + 1).toLocaleString()}–${pageRange.end.toLocaleString()}`}
              </span>
            </>
          )}
        </section>

        {(command('scale').present || command('speed').present) && (
          <section aria-labelledby="reader-controls-view-heading">
            <h3 id="reader-controls-view-heading">View</h3>
            <div className="reader-controls-actions">
              <ReaderCommandButton command={command('scale')} onClick={switchScale} />
              <ReaderCommandButton command={command('speed')} onClick={startSpeed} />
            </div>
          </section>
        )}

        <section aria-labelledby="reader-controls-page-heading">
          <h3 id="reader-controls-page-heading">Page</h3>
          <div className="reader-controls-actions">
            <ReaderCommandButton command={command('page-previous')} onClick={() => movePage(-1)} />
            <ReaderCommandButton command={command('page-next')} onClick={() => movePage(1)} />
          </div>
        </section>

        {command('reference-previous').present && (
          <section aria-labelledby="reader-controls-reference-heading">
            <h3 id="reader-controls-reference-heading">Reference</h3>
            <div className="reader-controls-actions">
              <ReaderCommandButton
                command={command('reference-previous')}
                onClick={() => moveReference(-1)}
              />
              <ReaderCommandButton
                command={command('reference-next')}
                onClick={() => moveReference(1)}
              />
            </div>
          </section>
        )}

        {command('text-start').present && (
          <section aria-labelledby="reader-controls-text-heading">
            <h3 id="reader-controls-text-heading">Text</h3>
            <div className="reader-controls-actions">
              <ReaderCommandButton command={command('text-previous')} onClick={() => moveText(-1)} />
              <ReaderCommandButton command={command('text-next')} onClick={() => moveText(1)} />
              <ReaderCommandButton command={command('text-start')} onClick={() => moveToBoundary('start')} />
              <ReaderCommandButton command={command('text-end')} onClick={() => moveToBoundary('end')} />
            </div>
          </section>
        )}

        {legend.length > 0 && (
          <section aria-labelledby="reader-controls-highlights-heading">
            <h3 id="reader-controls-highlights-heading">Highlights</h3>
            <ul className="reader-controls-highlights">
              {legend.map((entry) => (
                <li
                  key={entry.seriesId}
                  style={{ borderInlineStartColor: seriesColor(entry.style ?? DEFAULT_SERIES_STYLE) }}
                >
                  {entry.label}{entry.stale ? ' · changed since Reader opened' : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="reader-controls-utility-heading">
          <h3 id="reader-controls-utility-heading">Display and help</h3>
          <div className="reader-controls-actions">
            <ReaderCommandButton command={command('settings')} onClick={onOpenSettings}>
              Display settings
            </ReaderCommandButton>
            <ReaderCommandButton command={command('help')} onClick={onOpenHelp} />
          </div>
        </section>
      </div>
    </UtilityPane>
  );
}
