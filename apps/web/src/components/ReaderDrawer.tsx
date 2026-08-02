/**
 * Lazy full-document reader. Every mounted string is a React text node sliced
 * from authenticated worker text; source HTML is never interpreted.
 */

import { useEffect, useRef } from 'react';
import type { ReaderPageMarkV1, ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import { useApp } from '../lib/store-instance.ts';
import { groupIdentity } from '../lib/notebook.ts';
import { pinTrackLegend, type PinLegendEntry } from '../lib/pins.ts';
import { pinCapacity } from '../lib/pin-capacity.ts';
import { segmentPassageMarks, type PassageSegment } from '../lib/passage-marks.ts';
import { readerRangeLabel, readerSelectionChars } from '../lib/reader-view.ts';
import { sameReaderPlace } from '../lib/reader-intent.ts';
import {
  READER_MODES,
  type ReaderComposition,
} from '../lib/reader-presentation.ts';
import { slotColor } from '../lib/series-style.ts';
import { SMALL_BUTTON_STYLE, SeriesLineSample } from './chrome.tsx';
import { PinButton } from './PinButton.tsx';

function ReaderProse({
  page,
  snapshot,
  legend,
}: {
  page: ReaderPageResultV1;
  snapshot: string;
  legend: readonly PinLegendEntry[];
}) {
  const selection = useApp((state) => state.linkedSelection);
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const selected = readerSelectionChars(page, selection, snapshot);
  const slotOf = new Map(legend.map((entry) => [entry.seriesId, entry.styleSlot]));
  const labelOf = new Map(legend.map((entry) => [entry.seriesId, entry.label]));
  const boundaries = [
    ...(selected ? [selected.start, selected.end] : []),
    ...(page.anchor ? [page.anchor.charsUtf16.start, page.anchor.charsUtf16.end] : []),
  ];
  const segments = segmentPassageMarks(
    page.text.length,
    page.marks.map((mark) => ({
      seriesId: mark.seriesId,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
    boundaries,
  );
  const coveringMark = (segment: PassageSegment): ReaderPageMarkV1 | null =>
    page.marks.find(
      (mark) =>
        mark.seriesId === segment.seriesIds[0]
        && mark.charsUtf16.start <= segment.start
        && mark.charsUtf16.end >= segment.end,
    ) ?? null;

  return (
    <div
      data-reader-page={`${page.tokens.start}:${page.tokens.end}`}
      style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.05rem',
        lineHeight: 1.75,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        userSelect: 'text',
      }}
    >
      {segments.map((segment, index) => {
        const mark = coveringMark(segment);
        const inSelection =
          selected !== null
          && segment.start >= selected.start
          && segment.end <= selected.end;
        const inAnchor =
          page.anchor !== null
          && segment.start >= page.anchor.charsUtf16.start
          && segment.end <= page.anchor.charsUtf16.end;
        const color = mark ? slotColor(slotOf.get(mark.seriesId) ?? 0) : undefined;
        const text = page.text.slice(segment.start, segment.end);
        if (!mark) {
          return (
            <span
              key={index}
              data-reader-selection={inSelection || undefined}
              style={{
                background: inAnchor
                  ? 'color-mix(in srgb, var(--accent) 30%, transparent)'
                  : inSelection
                    ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                    : undefined,
                fontWeight: inAnchor ? 600 : undefined,
              }}
            >
              {text}
            </span>
          );
        }
        const clippedStart = mark.clippedStart && segment.start === mark.charsUtf16.start;
        const clippedEnd = mark.clippedEnd && segment.end === mark.charsUtf16.end;
        return (
          <span
            key={index}
            role="button"
            tabIndex={0}
            aria-label={`Find ${labelOf.get(mark.seriesId) ?? mark.seriesId} occurrence in concordance`}
            title={[
              'Show this full occurrence in the concordance',
              clippedStart ? 'continues from previous page' : '',
              clippedEnd ? 'continues on next page' : '',
            ].filter(Boolean).join(' · ')}
            onClick={() => centerKwicAt(mark.seriesId, page.doc, mark.tokens.start)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              centerKwicAt(mark.seriesId, page.doc, mark.tokens.start);
            }}
            data-reader-mark={mark.seriesId}
            data-reader-selection={inSelection || undefined}
            style={{
              background: inAnchor
                ? 'color-mix(in srgb, var(--accent) 30%, transparent)'
                : inSelection
                  ? `color-mix(in srgb, ${color} 30%, var(--accent) 16%)`
                  : `color-mix(in srgb, ${color} 20%, transparent)`,
              borderBottom: `2px solid ${color}`,
              borderLeft: clippedStart ? `2px dashed ${color}` : undefined,
              borderRight: clippedEnd ? `2px dashed ${color}` : undefined,
              cursor: 'pointer',
              fontWeight: inAnchor ? 600 : undefined,
            }}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}

export function ReaderDrawer({
  composition,
}: {
  readonly composition: ReaderComposition;
}) {
  const place = useApp((state) => state.readerPlace);
  const result = useApp((state) => state.readerPage);
  const navigation = useApp((state) => state.readerNavigation);
  const notebook = useApp((state) => state.notebook);
  const styleSlots = useApp((state) => state.styleSlots);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const closeReader = useApp((state) => state.closeReader);
  const setPlace = useApp((state) => state.setPlace);
  const setReaderMode = useApp((state) => state.setReaderMode);
  const navigateReader = useApp((state) => state.navigateReader);
  const retryReader = useApp((state) => state.retryReader);
  const pinPassage = useApp((state) => state.pinPassage);
  const pinError = useApp((state) => state.pinError);
  const pinAnnouncement = useApp((state) => state.pinAnnouncement);
  const pinFeedbackOrigin = useApp((state) => state.pinFeedbackOrigin);
  const clearPinFeedback = useApp((state) => state.clearPinFeedback);
  const pinsUsed = useApp((state) => state.pins.length);
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    drawerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    clearPinFeedback('reader');
  }, [clearPinFeedback, place?.snapshot, place?.doc, place?.cursor.token]);

  if (!place) return null;
  const pinAtReaderCursor = () => {
    pinPassage(place.doc, place.cursor.token, 'reader');
  };
  const current = result && sameReaderPlace(result.place, place) ? result : null;
  const title =
    project?.data.docs.find((entry) => entry.doc === place.doc)?.meta.title
    ?? place.doc;
  const identities = new Map(
    notebook.groups.map((group) => [group.id, groupIdentity(group)]),
  );
  const liveSeries = notebook.groups.map((group) => ({
    id: group.id,
    label: group.name,
    styleSlot: styleSlots.get(group.id) ?? 0,
  }));
  const legend = pinTrackLegend(
    current?.tracks ?? [],
    (id) => identities.get(id) ?? null,
    liveSeries,
  );
  const ready = current?.state.status === 'ready' ? current.state.page : null;
  const capacity = pinCapacity(pinsUsed);

  return (
    <aside
      ref={drawerRef}
      id="reader-region"
      className="reader-region"
      data-mode={composition.mode}
      data-requested={composition.requested}
      data-slot={composition.slot}
      role="dialog"
      aria-modal="false"
      aria-label={`Reader: ${title}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeReader();
        }
      }}
    >
      <header className="reader-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{title}</h2>
          <p className="reader-position">
            {ready ? readerRangeLabel(ready) : 'loading canonical page…'}
          </p>
        </div>
        <div className="reader-header-actions">
          {composition.modeControls && (
            <div
              className="reader-mode-controls"
              role="group"
              aria-label="Reader width"
            >
              {READER_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={composition.requested === mode}
                  onClick={() => setReaderMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
          <PinButton
            capacity={capacity}
            label={`Save reader excerpt at token ${(place.cursor.token + 1).toLocaleString()} to Findings`}
            onPin={pinAtReaderCursor}
          />
          {!capacity.enabled && (
            <button
              type="button"
              onClick={() => setPlace('findings')}
              style={SMALL_BUTTON_STYLE}
            >
              Open Findings
            </button>
          )}
          <button type="button" onClick={closeReader} style={SMALL_BUTTON_STYLE}>
            {composition.slot === 'viewport' ? 'back' : 'close'}
          </button>
        </div>
      </header>

      <div className="reader-pin-feedback">
        {pinFeedbackOrigin === 'reader' && pinError && (
          <p role="alert">
            {pinError}{' '}
            <button
              type="button"
              onClick={() => clearPinFeedback('reader')}
              style={SMALL_BUTTON_STYLE}
            >
              dismiss
            </button>
          </p>
        )}
        {pinFeedbackOrigin === 'reader'
          && !pinError
          && pinAnnouncement && (
            <p role="status" aria-live="polite" aria-atomic="true">
              {pinAnnouncement}
            </p>
        )}
      </div>

      <div className="reader-prose-scroll">
        <div className="reader-highlights" aria-label="Reader query highlights">
          <span>highlights</span>
          {legend.length === 0 && <span>none</span>}
          {legend.map((entry) => (
            <span key={entry.seriesId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5ch' }}>
              <SeriesLineSample slot={entry.styleSlot} emphasized />
              {entry.label}{entry.stale ? ' (query changed)' : ''}
            </span>
          ))}
        </div>

        <div aria-live="polite" aria-busy={current?.state.status === 'pending' || undefined}>
          {!current || current.state.status === 'pending' ? (
            <div aria-label="Loading reader page" style={{ minHeight: '12em', opacity: 0.45 }}>
              {Array.from({ length: 7 }, (_, index) => (
                <div
                  key={index}
                  style={{
                    height: '1em',
                    margin: '0.65em 0',
                    width: `${92 - (index % 3) * 8}%`,
                    background: 'var(--rule)',
                  }}
                />
              ))}
            </div>
          ) : current.state.status === 'error' ? (
            <p role="alert" style={{ color: 'var(--accent-text)' }}>
              reader failed: {current.state.message}{' '}
              <button type="button" onClick={retryReader} style={SMALL_BUTTON_STYLE}>retry</button>
            </p>
          ) : (
            <>
              <ReaderProse page={current.state.page} snapshot={current.snapshot} legend={legend} />
              {(current.state.page.marksTruncated || current.state.page.cappedBy === 'text') && (
                <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
                  {current.state.page.marksTruncated ? 'Highlight cap reached on this page. ' : ''}
                  {current.state.page.cappedBy === 'text' ? 'Page shortened by the text-size cap.' : ''}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <nav
        className="reader-pages"
        data-dock={composition.dockPages || undefined}
        aria-label="Reader pages"
      >
        <button
          type="button"
          disabled={!navigation?.previous}
          onClick={() => navigation?.previous && navigateReader(navigation.previous)}
          style={{ ...SMALL_BUTTON_STYLE, cursor: navigation?.previous ? 'pointer' : 'default', opacity: navigation?.previous ? 1 : 0.45 }}
        >
          ← previous
        </button>
        <button
          type="button"
          disabled={!navigation?.next}
          onClick={() => navigation?.next && navigateReader(navigation.next)}
          style={{ ...SMALL_BUTTON_STYLE, cursor: navigation?.next ? 'pointer' : 'default', opacity: navigation?.next ? 1 : 0.45 }}
        >
          next →
        </button>
      </nav>
    </aside>
  );
}
