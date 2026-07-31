/**
 * The dispersion barcode strip (slice-2 commit D): every occurrence as a
 * tick (exact) or an honest labeled density cell, one canvas row per active
 * track, sharing the trend chart's token→pixel mapping so the strip and the
 * chart place an occurrence identically.
 *
 * Honesty + interaction rules (recorded ruling §1/§D):
 * - NEVER one DOM node per occurrence — 2D canvas with an HTML overlay for
 *   labels, accessible summaries, and keyboard navigation.
 * - Exact tick click → the concordance centers at that occurrence's exact
 *   (doc, start) IMMEDIATELY (no debounce). Density cell click → the bucket
 *   midpoint, and the UI says "nearest occurrence to this bucket".
 * - Density mode is visibly labeled; a cell never renders as one occurrence.
 * - Resize/redraw consume the RESIDENT result only — never a worker query.
 * - Keyboard: per-track Previous/Next occurrence buttons (exact mode) walk
 *   the ticks and center the concordance; density mode exposes bucket
 *   totals through the same accessible summary.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { barcodeTracks, orderTracks, resolveBarcodeActivation, stepTarget, trackSummaryText, type BarcodeActivation, type BarcodeTrackVM } from '../lib/barcode-view.ts';
import { barcodeStepperFor } from '../lib/barcode-stepper.ts';
import { slotColor } from '../lib/series-style.ts';
import { usePresentation } from './PresentationProvider.tsx';

const TRACK_H = 7;
const TRACK_GAP = 2;

/** Token-START edge → x pixel for one doc row of the mounted layout. */
export type EdgeX = (docOrdinal: number, token: number) => number;

export function BarcodeStrip({
  docs,
  edgeX,
  xToDocToken,
  width,
  slotOf,
  labelOf,
  focusedSeries,
  axisLabel,
  seriesOrder,
}: {
  /** Selection order the dispersion result was computed under. */
  docs: readonly string[];
  edgeX: EdgeX;
  /** Pixel → (doc ordinal, document-local token) inversion for THIS layout —
   *  the component never re-derives evidence from pixels (review-D). */
  xToDocToken: (px: number) => { d: number; token: number } | null;
  width: number;
  slotOf: (seriesId: string) => number;
  labelOf: (seriesId: string) => string;
  /** Chart focus: non-focused tracks dim (§D focus styling). */
  focusedSeries: string | null;
  /** Names the strip's own axis (by-book rows use a different one). */
  axisLabel: string;
  /** CURRENT series order — a query-free reorder must move these rows. */
  seriesOrder: readonly string[];
}) {
  const dispersion = useApp((s) => s.dispersion);
  const selectedDispersion = useApp((s) => s.selectedDispersion);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const centerKwicAt = useApp((s) => s.centerKwicAt);
  const showEvidenceAt = useApp((s) => s.showEvidenceAt);
  const openReader = useApp((s) => s.openReader);
  const kwicCenter = useApp((s) => s.kwic?.center ?? null);
  const presentation = usePresentation();
  const coarse = presentation.pointer === 'coarse';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const tracks: readonly BarcodeTrackVM[] = useMemo(() => {
    if (!dispersion || dispersion.state.status !== 'ready') return [];
    // Resident result, CURRENT presentation order (review-D round 2).
    return orderTracks(barcodeTracks(dispersion.state.result, docs), seriesOrder);
  }, [dispersion, docs, seriesOrder]);
  const selectedTracks: readonly BarcodeTrackVM[] = useMemo(() => {
    if (
      !linkedSelection ||
      !selectedDispersion ||
      selectedDispersion.state.status !== 'ready'
    ) return [];
    return orderTracks(
      barcodeTracks(selectedDispersion.state.result, [linkedSelection.doc]),
      seriesOrder,
    );
  }, [linkedSelection, selectedDispersion, seriesOrder]);
  const selectedBySeries = new Map(selectedTracks.map((track) => [track.seriesId, track]));
  const selectedLabel = (seriesId: string): string => {
    if (!selectedDispersion || selectedDispersion.state.status === 'pending') return '…';
    if (selectedDispersion.state.status === 'error') return 'error';
    return selectedBySeries.get(seriesId)?.total.toLocaleString() ?? '0';
  };

  const height = tracks.length === 0 ? 0 : tracks.length * (TRACK_H + TRACK_GAP);
  const stepper = barcodeStepperFor(tracks, focusedSeries, labelOf);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tracks.length === 0 || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const docOrdinal = new Map(docs.map((d, i) => [d, i]));
    // Document boundaries: the strip has its OWN axis (concatenated reading
    // order) — separators keep it from reading as the row above (review-D).
    ctx.fillStyle = 'rgba(128, 128, 128, 0.5)';
    for (let d = 1; d < docs.length; d++) {
      ctx.fillRect(Math.round(edgeX(d, 0)), 0, 1, height);
    }
    const rowBySeries = new Map(tracks.map((track, row) => [track.seriesId, row]));
    const paint = (paintTracks: readonly BarcodeTrackVM[], context: boolean) => {
      paintTracks.forEach((track) => {
        const row = rowBySeries.get(track.seriesId);
        if (row === undefined) return;
        const y = row * (TRACK_H + TRACK_GAP);
        ctx.fillStyle = colorOf(slotOf(track.seriesId));
        const focusDim = focusedSeries !== null && track.seriesId !== focusedSeries ? 0.45 : 1;
        for (const seg of track.segments) {
          const d = docOrdinal.get(seg.doc);
          if (d === undefined) continue;
          const x0 = edgeX(d, seg.t0);
          const x1 = edgeX(d, seg.t1);
          const evidenceAlpha = seg.kind === 'tick' ? 1 : 0.15 + 0.85 * seg.intensity;
          ctx.globalAlpha = evidenceAlpha * focusDim * (context ? 0.25 : 1);
          ctx.fillRect(x0, y, Math.max(1, x1 - x0), TRACK_H);
        }
        ctx.globalAlpha = 1;
      });
    };
    paint(tracks, linkedSelection !== null);
    paint(selectedTracks, false);
  }, [tracks, selectedTracks, linkedSelection, docs, edgeX, width, height, slotOf, focusedSeries]);

  if (tracks.length === 0) return null;

  /** Canvas click → invert to (doc, token) → the ONE authoritative
   *  activation resolver (overlap tie rules live in barcode-view, tested). */
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const row = Math.min(tracks.length - 1, Math.floor((e.clientY - rect.top) / (TRACK_H + TRACK_GAP)));
    const track = tracks[row];
    const at = xToDocToken(px);
    if (!track || !at) return;
    const doc = docs[at.d];
    if (doc === undefined) return;
    activate(track, resolveBarcodeActivation(track, doc, at.token), true);
  };

  const activate = (
    track: BarcodeTrackVM,
    target: BarcodeActivation | null,
    openExact = false,
  ) => {
    if (!target) return;
    centerKwicAt(
      track.seriesId, target.doc, target.token,
      target.kind === 'bucket' ? { kind: 'bucket', count: target.bucketCount ?? 0 } : undefined,
    );
    showEvidenceAt(target.doc, target.token);
    // An exact tick is authenticated occurrence evidence and can open
    // directly. A density cell is only an aggregate midpoint; it centres the
    // KWIC, whose nearest real row supplies the reader link.
    if (openExact && target.kind === 'occurrence' && dispersion) {
      openReader({
        snapshot: dispersion.snapshot,
        doc: target.doc,
        token: target.token,
        from: 'barcode',
      });
    }
  };

  /** Keyboard navigation for BOTH representations: exact tracks step
   *  occurrences, density tracks step nonzero buckets (midpoints) — always
   *  relative to the current concordance center. */
  const step = (track: BarcodeTrackVM, dir: 1 | -1) => {
    activate(track, stepTarget(track, docs, kwicCenter, dir));
  };

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          display: 'block',
          pointerEvents: coarse ? 'none' : 'auto',
        }}
        onClick={coarse ? undefined : onClick}
        data-pointer-contract={coarse ? 'read-only' : 'clickable'}
        data-selected-layer={selectedTracks.length > 0 ? 'ready' : undefined}
        aria-hidden="true"
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: presentation.width === 'compact' ? 'var(--text-sm)' : 'var(--text-xs)', color: 'var(--fg-muted)' }}>
        <span>{axisLabel}</span>
        {tracks.map((track) => (
          <span key={track.seriesId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5ch' }}>
            <span aria-hidden="true" style={{ width: '1.5ch', height: 3, background: colorOf(slotOf(track.seriesId)), display: 'inline-block' }} />
            {/* The accessible per-track summary: representation is NAMED —
                density counts are bucket totals, never occurrences. */}
            <span>
              {trackSummaryText(track, labelOf(track.seriesId))}
              {linkedSelection ? (
                <> · {selectedLabel(track.seriesId)} selected</>
              ) : null}
            </span>
            {!coarse && track.total > 0 && (
              <>
                <button
                  type="button" style={navBtn}
                  aria-label={`Previous ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'occurrence' : 'bucket'}`}
                  onClick={() => step(track, -1)}
                >‹</button>
                <button
                  type="button" style={navBtn}
                  aria-label={`Next ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'occurrence' : 'bucket'}`}
                  onClick={() => step(track, 1)}
                >›</button>
              </>
            )}
          </span>
        ))}
      </div>
      {coarse && stepper.track && (
        <div
          role="group"
          aria-label="Barcode occurrence navigation"
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-2)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <span>{stepper.label}</span>
          {stepper.fellBack && (
            <span role="note" style={{ color: 'var(--fg-muted)' }}>
              focused term has no delivered barcode track; showing the first track
            </span>
          )}
          <button
            type="button"
            style={coarseNavBtn}
            disabled={!stepper.enabled}
            aria-label={`Previous ${labelOf(stepper.track.seriesId)} ${stepper.unit}`}
            onClick={() => step(stepper.track!, -1)}
          >
            ‹
          </button>
          <button
            type="button"
            style={coarseNavBtn}
            disabled={!stepper.enabled}
            aria-label={`Next ${labelOf(stepper.track.seriesId)} ${stepper.unit}`}
            onClick={() => step(stepper.track!, 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

const navBtn = {
  font: 'inherit',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule)',
  cursor: 'pointer',
  padding: '0 0.5ch',
} as const;

const coarseNavBtn = {
  ...navBtn,
  minBlockSize: 48,
  minInlineSize: 48,
} as const;

function colorOf(slot: number): string {
  return slotColor(slot);
}
