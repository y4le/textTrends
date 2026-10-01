import { Suspense, useEffect, type KeyboardEvent } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import type { ReaderPlace } from '../../lib/reader-intent.ts';
import { occurrenceNavigationText } from '../../lib/occurrence-view.ts';
import { guideAnchorProps } from '../../lib/guide/anchors.ts';
import { WorkbenchDock } from '../WorkbenchDock.tsx';
import { retryableLazy } from '../retryable-lazy.tsx';

const ReaderDrawer = retryableLazy(() =>
  import('../ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
  'Reader',
);

/** Own the Reader shell, lazy fallback, viewport scroll lock and orphaned
 * focus repair. App retains the meaning of global commands and pane routing. */
export function ReaderShell({ readerPlace, readerKeyboardStatus, onKeyDown,
  closeReader, setReaderKeyboardStatus, closeFind, openFind, openReaderControls,
  openSpeedSettings, openSettings, openHelp,
}: {
  readonly readerPlace: ReaderPlace;
  readonly readerKeyboardStatus: string;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly closeReader: () => void;
  readonly setReaderKeyboardStatus: (message: string) => void;
  readonly closeFind: () => void;
  readonly openFind: () => void;
  readonly openReaderControls: (returnFocus: HTMLElement) => void;
  readonly openSpeedSettings: (returnFocus: HTMLElement, restSummary: string) => void;
  readonly openSettings: (context: 'reader', returnFocus: HTMLElement) => void;
  readonly openHelp: (context: 'reader' | 'rsvp') => void;
}) {
  const readerScale = useApp((state) => state.readerScale);
  const interaction = useApp((state) => state.interaction);
  const readerVisibleRange = useApp((state) => state.readerVisibleRange);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const occurrenceNavigation = useApp((state) => state.occurrenceNavigation);
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation);
  const readerTitle = project?.data.docs.find((document) => document.doc === readerPlace.doc)?.meta.title ?? readerPlace.doc;
  const readerDockPresent = readerScale === 'atlas';

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        const destination = readerScale === 'atlas'
          ? document.getElementById('reader-atlas-plane')
          : document.getElementById('reader-region');
        destination?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [interaction.kind, readerScale]);

  useEffect(() => {
    document.documentElement.classList.add('reader-open');
    return () => document.documentElement.classList.remove('reader-open');
  }, []);

  return (
      <main
        id="reader-region"
        className="reader-region"
        data-reader-footer={readerDockPresent ? 'true' : 'false'}
        data-shortcut-context={interaction.kind === 'rsvp' ? 'rsvp' : 'reader'}
        data-reader-fit-size={readerVisibleRange?.geometry.split(':', 1)[0]}
        aria-labelledby="reader-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <span
          className="visually-hidden"
          role="status"
          aria-label="Reader keyboard status"
          aria-live="polite"
        >
          {[readerKeyboardStatus, occurrenceStatus].filter(Boolean).join(' · ')}
        </span>
        <Suspense
          fallback={(
            <>
              <h2 id="reader-title" className="visually-hidden">Reader: {readerTitle}</h2>
              <p className="reader-position visually-hidden" role="status">loading reader…</p>
              <div
                {...guideAnchorProps('reader-prose')}
                className="reader-prose-pane"
                aria-hidden="true"
              />
              <nav className="reader-control-bar" aria-label="Reader controls">
                <span className="reader-progress-rail reader-control-progress" aria-hidden="true" />
                <button
                  type="button"
                  className="reader-control-exit"
                  aria-label="Return to workbench"
                  onClick={closeReader}
                >
                  <span aria-hidden="true">←</span>{' '}<span>back</span>
                </button>
                <button type="button" className="reader-control-page" disabled aria-label="Previous page">
                  <span aria-hidden="true">‹</span>
                </button>
                <button
                  type="button"
                  className="reader-control-position"
                  aria-label={`Open Reader controls for ${readerTitle}`}
                  disabled
                >
                  <strong>{readerTitle}</strong>
                  <span>loading position…</span>
                </button>
                <button type="button" className="reader-control-page" disabled aria-label="Next page">
                  <span aria-hidden="true">›</span>
                </button>
                <button type="button" className="reader-control-speed" disabled aria-label="Speed reading unavailable">
                  <span aria-hidden="true">▶</span>
                </button>
              </nav>
            </>
          )}
        >
          <ReaderDrawer
            onLoadFailureReturn={closeReader}
            onLoadFailureReturnLabel="Return to workbench"
            onAnnounce={setReaderKeyboardStatus}
            onCloseFind={closeFind}
            onOpenFind={() => openFind()}
            onOpenControls={openReaderControls}
            onOpenSpeedSettings={openSpeedSettings}
            onOpenSettings={(returnFocus) => openSettings('reader', returnFocus)}
            onOpenHelp={() => openHelp(
              interaction.kind === 'rsvp' ? 'rsvp' : 'reader',
            )}
          />
        </Suspense>
        {readerDockPresent && (
          <WorkbenchDock
            mode="reader"
            globalShortcuts={false}
            onCloseFind={closeFind}
          />
        )}
      </main>
  );
}
