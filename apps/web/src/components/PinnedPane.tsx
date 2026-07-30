/**
 * Bounded, snapshot-bound captured evidence beneath the chart. A pin is not a
 * live query projection: its text, marks, and semantic labels remain those
 * captured at issue time. Presentation-only renames may flow through while
 * the matching identity still agrees.
 */

import { useEffect, useRef } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { groupIdentity } from '../lib/notebook.ts';
import {
  MAX_PINNED_SNIPPETS,
  pinTrackLegend,
  type PinLegendEntry,
  type PinnedSnippet,
} from '../lib/pins.ts';
import {
  displayPassageText,
  segmentPassageMarks,
  type PassageSegment,
} from '../lib/passage-marks.ts';
import { slotColor } from '../lib/series-style.ts';
import { SMALL_BUTTON_STYLE, SeriesLineSample } from './chrome.tsx';

function EvidenceText({
  pin,
  legend,
}: {
  pin: Extract<PinnedSnippet, { readonly kind: 'ready' }>;
  legend: readonly PinLegendEntry[];
}) {
  const display = displayPassageText(pin.evidence.text);
  const slotOf = new Map(legend.map((entry) => [entry.seriesId, entry.styleSlot]));
  const { start: anchorStart, end: anchorEnd } = pin.evidence.anchorCharsUtf16;
  const segments = segmentPassageMarks(
    display.length,
    pin.evidence.marks.map((mark) => ({
      seriesId: mark.seriesId,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
    [anchorStart, anchorEnd],
  );

  const renderSegment = (segment: PassageSegment, index: number) => {
    const marked = segment.seriesIds.length > 0;
    const anchor = segment.start >= anchorStart && segment.end <= anchorEnd;
    const color = marked ? slotColor(slotOf.get(segment.seriesIds[0]!) ?? 0) : undefined;
    return (
      <span
        key={index}
        data-pin-anchor={anchor || undefined}
        style={{
          background: anchor
            ? 'color-mix(in srgb, var(--accent) 28%, transparent)'
            : marked
              ? `color-mix(in srgb, ${color} 18%, transparent)`
              : undefined,
          borderBottom: marked ? `2px solid ${color}` : undefined,
          fontWeight: anchor ? 600 : undefined,
        }}
      >
        {display.slice(segment.start, segment.end)}
      </span>
    );
  };

  return (
    <p
      style={{
        margin: 'var(--space-2) 0',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {segments.map(renderSegment)}
    </p>
  );
}

export function PinnedPane() {
  const pins = useApp((state) => state.pins);
  const focusedPinId = useApp((state) => state.focusedPinId);
  const pinError = useApp((state) => state.pinError);
  const pinAnnouncement = useApp((state) => state.pinAnnouncement);
  const notebook = useApp((state) => state.notebook);
  const styleSlots = useApp((state) => state.styleSlots);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const removePin = useApp((state) => state.removePin);
  const retryPin = useApp((state) => state.retryPin);
  const focusPin = useApp((state) => state.focusPin);
  const clearPinError = useApp((state) => state.clearPinError);
  const openReader = useApp((state) => state.openReader);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (focusedPinId) itemRefs.current.get(focusedPinId)?.focus({ preventScroll: true });
  }, [focusedPinId, pinAnnouncement]);

  if (pins.length === 0 && !pinError) return null;

  const identityById = new Map(
    notebook.groups.map((group) => [group.id, groupIdentity(group)]),
  );
  const liveSeries = notebook.groups.map((group) => ({
    id: group.id,
    label: group.name,
    styleSlot: styleSlots.get(group.id) ?? 0,
  }));
  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((entry) => [entry.doc, entry.meta.title]),
  );

  return (
    <section aria-label="Pinned evidence" style={{ marginTop: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Pinned evidence</h2>
        <span style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
          {pins.length}/{MAX_PINNED_SNIPPETS}
        </span>
      </div>
      {pinError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {pinError}{' '}
          <button type="button" onClick={clearPinError} style={SMALL_BUTTON_STYLE}>dismiss</button>
        </p>
      )}
      <p
        role="status"
        aria-live="polite"
        style={{
          margin: 'var(--space-1) 0',
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          minHeight: '1.3em',
        }}
      >
        {pinAnnouncement}
      </p>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        {pins.map((pin) => {
          const legend = pinTrackLegend(
            pin.tracks,
            (id) => identityById.get(id) ?? null,
            liveSeries,
          );
          const title = titleByDoc.get(pin.anchor.doc) ?? pin.anchor.doc;
          return (
            <article
              key={pin.id}
              ref={(node) => {
                if (node) itemRefs.current.set(pin.id, node);
                else itemRefs.current.delete(pin.id);
              }}
              tabIndex={-1}
              onFocus={() => {
                // Programmatic focus follows store focus. Do not turn that
                // second-order DOM event into a new announcement that erases
                // the duplicate/cap/remove outcome the user needs to hear.
                if (focusedPinId !== pin.id) focusPin(pin.id);
              }}
              data-pin-id={pin.id}
              style={{
                border: `1px solid ${pin.id === focusedPinId ? 'var(--rule-strong)' : 'var(--rule)'}`,
                padding: 'var(--space-2)',
                outline: pin.id === focusedPinId ? '2px solid color-mix(in srgb, var(--accent) 45%, transparent)' : 'none',
                outlineOffset: 1,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                <strong style={{ fontSize: 'var(--text-sm)' }}>
                  {title} · token {(pin.anchor.token + 1).toLocaleString()}
                </strong>
                <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                  {pin.kind === 'ready' && (
                    <button
                      type="button"
                      aria-label={`Open pinned evidence at token ${pin.anchor.token + 1} in reader`}
                      onClick={() => openReader({
                        snapshot: pin.anchor.snapshot,
                        doc: pin.anchor.doc,
                        token: pin.anchor.token,
                        from: 'pin',
                      })}
                      style={SMALL_BUTTON_STYLE}
                    >
                      open reader
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const returnsToScrubber = pins.length === 1;
                      removePin(pin.id);
                      if (returnsToScrubber) {
                        requestAnimationFrame(() => {
                          document
                            .getElementById('reading-position-scrubber')
                            ?.focus({ preventScroll: true });
                        });
                      }
                    }}
                    style={SMALL_BUTTON_STYLE}
                  >
                    remove
                  </button>
                </div>
              </div>
              <div
                aria-label="Captured query tracks"
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  marginTop: 'var(--space-1)',
                  color: 'var(--fg-muted)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                }}
              >
                <span>captured with</span>
                {legend.length === 0 && <span>no active tracks</span>}
                {legend.map((entry) => (
                  <span key={entry.seriesId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5ch' }}>
                    <SeriesLineSample slot={entry.styleSlot} emphasized />
                    {entry.label}{entry.stale ? ' (captured; query changed)' : ''}
                  </span>
                ))}
              </div>
              {pin.kind === 'pending' && (
                <p role="status" style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
                  capturing passage…
                </p>
              )}
              {pin.kind === 'error' && (
                <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
                  capture failed: {pin.message}{' '}
                  <button type="button" onClick={() => retryPin(pin.id)} style={SMALL_BUTTON_STYLE}>
                    retry
                  </button>
                </p>
              )}
              {pin.kind === 'ready' && <EvidenceText pin={pin} legend={legend} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
