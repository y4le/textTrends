import type { SavedPinV1 } from '@texttrends/core';
import {
  displayPassageText,
  segmentPassageMarks,
  type PassageSegment,
} from '../../lib/passage-marks.ts';
import type {
  PinLegendEntry,
  PinnedSnippet,
} from '../../lib/pins.ts';
import type {
  PinRestoreIssue,
  SelectionCheck,
} from '../../lib/store.ts';
import { slotColor } from '../../lib/series-style.ts';
import type { SavedRangeRowView } from '../../lib/findings-view.ts';
import { SeriesLineSample } from '../chrome.tsx';

function EvidenceText({
  pin,
  legend,
}: {
  readonly pin: Extract<PinnedSnippet, { readonly kind: 'ready' }>;
  readonly legend: readonly PinLegendEntry[];
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
  const render = (segment: PassageSegment, index: number) => {
    const marked = segment.seriesIds.length > 0;
    const anchor = segment.start >= anchorStart && segment.end <= anchorEnd;
    const color = marked
      ? slotColor(slotOf.get(segment.seriesIds[0]!) ?? 0)
      : undefined;
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
  return <p className="findings-captured-excerpt source-text">{segments.map(render)}</p>;
}

function Check({ check }: { readonly check: SelectionCheck | null }) {
  if (check === null) {
    return <p className="findings-record-note">Not checked in this session.</p>;
  }
  if (check.status === 'ok') {
    return (
      <p className="findings-record-note" role="status">
        Checked in this session · tokens {check.tokens.start + 1}–{check.tokens.end}.
      </p>
    );
  }
  return <p className="findings-record-error" role="alert">{check.message}</p>;
}

export function RangeRecordDetail({
  range,
  onPreview,
  onApply,
  onRemove,
}: {
  readonly range: SavedRangeRowView;
  readonly onPreview: () => void;
  readonly onApply: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <section
      className="findings-record-detail"
      aria-label={`Saved range detail: ${range.name}`}
    >
      <dl>
        <div><dt>document</dt><dd>{range.document}</dd></div>
        <div><dt>character range</dt><dd>{range.charSpan} · 1-based</dd></div>
        <div><dt>document id</dt><dd>{range.documentId}</dd></div>
        <div><dt>text identity</dt><dd>{range.textHash}</dd></div>
      </dl>
      <Check check={range.check} />
      <div className="findings-record-actions">
        <button type="button" onClick={onPreview}>preview passage</button>
        <button type="button" onClick={onApply}>use as linked range</button>
        <button type="button" onClick={onRemove}>remove</button>
      </div>
    </section>
  );
}

export function PinRecordDetail({
  pin,
  durable,
  title,
  legend,
  onShow,
  onRead,
  onRetry,
  onNote,
  onRemove,
}: {
  readonly pin: PinnedSnippet;
  readonly durable: SavedPinV1 | undefined;
  readonly title: string;
  readonly legend: readonly PinLegendEntry[];
  readonly onShow: () => void;
  readonly onRead: () => void;
  readonly onRetry: () => void;
  readonly onNote: (note: string) => void;
  readonly onRemove: () => void;
}) {
  return (
    <section
      className="findings-record-detail"
      aria-label={`Saved excerpt detail: ${title}, token ${pin.anchor.token + 1}`}
    >
      <dl>
        <div><dt>document</dt><dd>{title}</dd></div>
        <div><dt>token</dt><dd>{pin.anchor.token + 1} · 1-based</dd></div>
        <div><dt>captured snapshot</dt><dd>{pin.anchor.snapshot}</dd></div>
        <div>
          <dt>captured tracks</dt>
          <dd className="findings-track-list">
            {legend.length === 0 && 'none'}
            {legend.map((entry) => (
              <span key={entry.seriesId}>
                <SeriesLineSample slot={entry.styleSlot} emphasized />
                {entry.label}{entry.stale ? ' · query changed' : ''}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      {pin.kind === 'pending' && (
        <p className="findings-record-note" role="status">capturing passage…</p>
      )}
      {pin.kind === 'error' && (
        <p className="findings-record-error" role="alert">
          Capture failed: {pin.message}
        </p>
      )}
      {pin.kind === 'ready' && <EvidenceText pin={pin} legend={legend} />}
      {pin.kind === 'ready' && (
        <label className="findings-note-field">
          research note
          <input
            className="exact-input"
            value={durable?.note ?? ''}
            maxLength={2_000}
            onChange={(event) => onNote(event.currentTarget.value)}
            placeholder="optional note for this evidence"
          />
        </label>
      )}
      <p className="findings-record-note">
        The current live passage can differ from this captured excerpt.
      </p>
      <div className="findings-record-actions">
        <button type="button" onClick={onShow}>show current passage</button>
        <button
          type="button"
          aria-label={`Open saved excerpt at token ${pin.anchor.token + 1} in reader`}
          onClick={onRead}
          disabled={pin.kind !== 'ready'}
        >
          open in Reader
        </button>
        {pin.kind === 'error' && (
          <button type="button" onClick={onRetry}>retry capture</button>
        )}
        <button type="button" onClick={onRemove}>remove</button>
      </div>
    </section>
  );
}

export function AnchorRecordDetail({
  issue,
  document,
  onRepair,
  onRemove,
}: {
  readonly issue: PinRestoreIssue;
  readonly document: string;
  readonly onRepair: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <section
      className="findings-record-detail"
      aria-label={`Anchor needing review: ${document}`}
    >
      <dl>
        <div><dt>document</dt><dd>{document}</dd></div>
        <div>
          <dt>character range</dt>
          <dd>
            {issue.pin.anchor.chars.start + 1}–{issue.pin.anchor.chars.end} · 1-based
          </dd>
        </div>
        <div><dt>text identity</dt><dd>{issue.pin.anchor.text}</dd></div>
        <div><dt>reason</dt><dd>{issue.reason} · {issue.message}</dd></div>
      </dl>
      <p className="findings-record-note">
        This anchor is quarantined. textTrends will not guess a replacement
        position after a missing document or source-text change.
      </p>
      <div className="findings-record-actions">
        <button type="button" onClick={onRepair}>repair sources in Corpus</button>
        <button type="button" onClick={onRemove}>remove record</button>
      </div>
    </section>
  );
}
