import type { SavedPinV1 } from '@texttrends/core';
import type { ReactNode } from 'react';
import {
  findingsRowControlId,
  type FindingsRowTarget,
  type SavedRangeRowView,
} from '../../lib/findings-view.ts';
import {
  MAX_PINNED_SNIPPETS,
  type PinLegendEntry,
  type PinnedSnippet,
} from '../../lib/pins.ts';
import type { PinRestoreIssue } from '../../lib/store.ts';
import {
  AnchorRecordDetail,
  PinRecordDetail,
  RangeRecordDetail,
} from './RecordDetail.tsx';

export interface FindingsPinRow {
  readonly pin: PinnedSnippet;
  readonly durable: SavedPinV1 | undefined;
  readonly title: string;
  readonly legend: readonly PinLegendEntry[];
}

const firstLine = (value: string): string =>
  value.split(/\r?\n/u, 1)[0]?.trim() ?? '';

function expanded(
  target: FindingsRowTarget | null,
  kind: FindingsRowTarget['kind'],
  id: string,
): boolean {
  return target?.kind === kind && target.id === id;
}

export function RecordRows({
  ranges,
  pins,
  issues,
  target,
  pinAnnouncement,
  rangeAuthoring,
  onOpen,
  onRangePreview,
  onRangeApply,
  onRangeRemove,
  onPinShow,
  onPinRead,
  onPinRetry,
  onPinNote,
  onPinRemove,
  onIssueRepair,
  onIssueRemove,
}: {
  readonly ranges: readonly SavedRangeRowView[];
  readonly pins: readonly FindingsPinRow[];
  readonly issues: readonly PinRestoreIssue[];
  readonly target: FindingsRowTarget | null;
  readonly pinAnnouncement: string | null;
  readonly rangeAuthoring: ReactNode;
  readonly onOpen: (kind: FindingsRowTarget['kind'], id: string) => void;
  readonly onRangePreview: (id: string) => void;
  readonly onRangeApply: (id: string) => void;
  readonly onRangeRemove: (id: string) => void;
  readonly onPinShow: (pin: PinnedSnippet) => void;
  readonly onPinRead: (pin: PinnedSnippet) => void;
  readonly onPinRetry: (id: string) => void;
  readonly onPinNote: (id: string, note: string) => void;
  readonly onPinRemove: (id: string) => void;
  readonly onIssueRepair: () => void;
  readonly onIssueRemove: (id: string) => void;
}) {
  return (
    <>
      <section className="findings-group" aria-labelledby="findings-ranges-heading">
        <header className="findings-group-heading">
          <h3 id="findings-ranges-heading" tabIndex={-1}>Saved ranges</h3>
          <span>{ranges.length} saved</span>
        </header>
        {rangeAuthoring}
        {ranges.length === 0
          ? (
              <p className="findings-empty">
                No saved ranges. Commit a linked range in Trends, then name it here.
              </p>
            )
          : (
              <ul className="findings-record-list" aria-label="Saved ranges">
                {ranges.map((range) => {
                  const open = expanded(target, 'range', range.id);
                  return (
                    <li key={range.id}>
                      <article>
                        <button
                          id={range.controlId}
                          className="findings-record-trigger"
                          type="button"
                          aria-expanded={open}
                          onClick={() => onOpen('range', range.id)}
                        >
                          <strong>{range.name}</strong>
                          <span>{range.document} · chars {range.charSpan}</span>
                          <span className="findings-row-status">
                            {range.check === null
                              ? 'not checked this session'
                              : range.check.status === 'ok'
                                ? 'checked this session'
                                : 'needs review'}
                          </span>
                        </button>
                        {open && (
                          <RangeRecordDetail
                            range={range}
                            onPreview={() => onRangePreview(range.id)}
                            onApply={() => onRangeApply(range.id)}
                            onRemove={() => onRangeRemove(range.id)}
                          />
                        )}
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
      </section>

      <section className="findings-group" aria-labelledby="findings-pins-heading">
        <header className="findings-group-heading">
          <h3 id="findings-pins-heading" tabIndex={-1}>Pinned evidence</h3>
          <span>{pins.length} of {MAX_PINNED_SNIPPETS} pinned</span>
        </header>
        <p
          className="findings-announcement"
          role="status"
          aria-live="polite"
        >
          {pinAnnouncement}
        </p>
        {pins.length === 0
          ? (
              <p className="findings-empty">
                No pinned evidence. Pin a current passage from Evidence or Reader.
              </p>
            )
          : (
              <ul className="findings-record-list" aria-label="Pinned evidence">
                {pins.map((entry) => {
                  const { pin, durable, title, legend } = entry;
                  const open = expanded(target, 'pin', pin.id);
                  const note = firstLine(durable?.note ?? '');
                  return (
                    <li key={pin.id}>
                      <article data-pin-id={pin.id}>
                        <button
                          id={findingsRowControlId('pin', pin.id)}
                          className="findings-record-trigger"
                          type="button"
                          aria-expanded={open}
                          onClick={() => onOpen('pin', pin.id)}
                        >
                          <strong>{title} · token {pin.anchor.token + 1}</strong>
                          <span>
                            {note || (pin.kind === 'pending'
                              ? 'capturing passage…'
                              : pin.kind === 'error'
                                ? `capture failed · ${pin.message}`
                                : 'no research note')}
                          </span>
                          <span className="findings-track-chips">
                            {legend.length === 0 && 'captured with no active tracks'}
                            {legend.map((track) => (
                              <span key={track.seriesId}>
                                {track.label}{track.stale ? ' · query changed' : ''}
                              </span>
                            ))}
                          </span>
                        </button>
                        {open && (
                          <PinRecordDetail
                            pin={pin}
                            durable={durable}
                            title={title}
                            legend={legend}
                            onShow={() => onPinShow(pin)}
                            onRead={() => onPinRead(pin)}
                            onRetry={() => onPinRetry(pin.id)}
                            onNote={(value) => onPinNote(pin.id, value)}
                            onRemove={() => onPinRemove(pin.id)}
                          />
                        )}
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
      </section>

      {issues.length > 0 && (
        <section className="findings-group" aria-labelledby="findings-anchors-heading">
          <header className="findings-group-heading">
            <h3 id="findings-anchors-heading" tabIndex={-1}>Anchors needing review</h3>
            <span>{issues.length} quarantined</span>
          </header>
          <ul className="findings-record-list" aria-label="Anchors needing review">
            {issues.map((issue) => {
              const open = expanded(target, 'anchor', issue.pin.id);
              const title = issue.pin.note || issue.pin.anchor.doc;
              return (
                <li key={issue.pin.id}>
                  <article>
                    <button
                      id={findingsRowControlId('anchor', issue.pin.id)}
                      className="findings-record-trigger"
                      type="button"
                      aria-expanded={open}
                      onClick={() => onOpen('anchor', issue.pin.id)}
                    >
                      <strong>{title}</strong>
                      <span>
                        {issue.pin.anchor.doc} · chars{' '}
                        {issue.pin.anchor.chars.start + 1}–{issue.pin.anchor.chars.end}
                      </span>
                      <span className="findings-row-error">
                        {issue.reason} · {issue.message}
                      </span>
                    </button>
                    {open && (
                      <AnchorRecordDetail
                        issue={issue}
                        document={issue.pin.anchor.doc}
                        onRepair={onIssueRepair}
                        onRemove={() => onIssueRemove(issue.pin.id)}
                      />
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
