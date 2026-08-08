/**
 * The barcode has two deliberately separate halves:
 * - BarcodeBand paints resident dispersion evidence inside the chart's slider.
 * - BarcodeLegend exposes summaries and keyboard steppers outside the slider.
 *
 * Keeping interactive buttons out of role=slider preserves valid semantics;
 * the chart's single pointer pipeline owns hover and click activation. The
 * band intentionally does not begin mouse range brushing; range authoring
 * starts in the plot or through its explicit controls.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { selectedBarcodeTotalText, stepTarget, trackSummaryText, type BarcodeActivation, type BarcodeTrackVM } from '../lib/barcode-view.ts';
import { barcodeStepperFor } from '../lib/barcode-stepper.ts';
import { slotColor } from '../lib/series-style.ts';
import { barcodeBandHeight } from '../lib/trend-geometry.ts';
import { usePresentation } from './PresentationProvider.tsx';

interface BarcodeBandProps {
  readonly view: 'series' | 'by-book';
  readonly docs: readonly string[];
  readonly tracks: readonly BarcodeTrackVM[];
  readonly selectedTracks: readonly BarcodeTrackVM[];
  readonly linkedSelection: boolean;
  readonly edgeX: (docOrdinal: number, token: number) => number;
  readonly width: number;
  readonly plotHeight: number;
  readonly rowPitch: number;
  readonly bandGap: number;
  readonly trackHeight: number;
  readonly trackGap: number;
  readonly slotOf: (seriesId: string) => number;
  readonly focusedSeries: string | null;
  readonly coarse: boolean;
}

export function BarcodeBand({
  view,
  docs,
  tracks,
  selectedTracks,
  linkedSelection,
  edgeX,
  width,
  plotHeight,
  rowPitch,
  bandGap,
  trackHeight,
  trackGap,
  slotOf,
  focusedSeries,
  coarse,
}: BarcodeBandProps) {
  const presentation = usePresentation();
  const docOrdinalById = useMemo(
    () => new Map(docs.map((doc, d) => [doc, d])),
    [docs],
  );
  if (tracks.length === 0) return null;
  const height = barcodeBandHeight(tracks.length, trackHeight, trackGap);
  if (view === 'series') {
    return (
      <BarcodeCanvas
        docs={docs}
        tracks={tracks}
        selectedTracks={selectedTracks}
        linkedSelection={linkedSelection}
        edgeX={edgeX}
        width={width}
        height={height}
        top={plotHeight + bandGap}
        trackHeight={trackHeight}
        trackGap={trackGap}
        slotOf={slotOf}
        focusedSeries={focusedSeries}
        coarse={coarse}
        colorScheme={presentation.colorScheme}
        docOrdinalById={docOrdinalById}
      />
    );
  }
  return docs.map((doc, d) => (
    <BarcodeCanvas
      key={doc}
      docs={docs}
      docOrdinal={d}
      tracks={tracks}
      selectedTracks={selectedTracks}
      linkedSelection={linkedSelection}
      edgeX={edgeX}
      width={width}
      height={height}
      top={d * rowPitch + plotHeight + bandGap}
      trackHeight={trackHeight}
      trackGap={trackGap}
      slotOf={slotOf}
      focusedSeries={focusedSeries}
      coarse={coarse}
      colorScheme={presentation.colorScheme}
      docOrdinalById={docOrdinalById}
    />
  ));
}

function BarcodeCanvas({
  docs,
  docOrdinal,
  tracks,
  selectedTracks,
  linkedSelection,
  edgeX,
  width,
  height,
  top,
  trackHeight,
  trackGap,
  slotOf,
  focusedSeries,
  coarse,
  colorScheme,
  docOrdinalById,
}: Omit<BarcodeBandProps, 'view' | 'plotHeight' | 'rowPitch' | 'bandGap'> & {
  readonly docOrdinal?: number;
  readonly height: number;
  readonly top: number;
  readonly colorScheme: 'dark' | 'light';
  readonly docOrdinalById: ReadonlyMap<string, number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(canvas);
    const canvasColor = (color: string): string => {
      const property = /^var\(\s*(--[^),\s]+)\s*\)$/.exec(color)?.[1];
      return property
        ? styles.getPropertyValue(property).trim() || styles.color
        : color;
    };

    if (docOrdinal === undefined) {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.5)';
      for (let d = 1; d < docs.length; d++) {
        ctx.fillRect(Math.round(edgeX(d, 0)), 0, 1, height);
      }
    }

    const rowBySeries = new Map(tracks.map((track, row) => [track.seriesId, row]));
    const paint = (paintTracks: readonly BarcodeTrackVM[], context: boolean) => {
      for (const track of paintTracks) {
        const row = rowBySeries.get(track.seriesId);
        if (row === undefined) continue;
        const y = row * (trackHeight + trackGap);
        // Canvas fillStyle does not resolve CSS custom-property expressions.
        // Resolve the shared series token explicitly so a per-book canvas
        // does not silently retain its default black fill.
        ctx.fillStyle = canvasColor(slotColor(slotOf(track.seriesId)));
        const focusDim = focusedSeries !== null && track.seriesId !== focusedSeries ? 0.45 : 1;
        const paintBucket = (bucketOrdinal: number) => {
          const doc = track.docOrder[bucketOrdinal];
          const d = doc === undefined ? undefined : docOrdinalById.get(doc);
          if (d === undefined) return;
          for (const segment of track.segmentsByDocOrdinal[bucketOrdinal] ?? []) {
            const x0 = edgeX(d, segment.t0);
            const x1 = edgeX(d, segment.t1);
            const evidenceAlpha = segment.kind === 'tick' ? 1 : 0.15 + 0.85 * segment.intensity;
            ctx.globalAlpha = evidenceAlpha * focusDim * (context ? 0.25 : 1);
            ctx.fillRect(x0, y, Math.max(1, x1 - x0), trackHeight);
          }
        };
        if (docOrdinal === undefined) {
          for (let d = 0; d < track.segmentsByDocOrdinal.length; d++) paintBucket(d);
        } else {
          const localOrdinal = track.docOrder.indexOf(docs[docOrdinal] ?? '');
          if (localOrdinal >= 0) paintBucket(localOrdinal);
        }
        ctx.globalAlpha = 1;
      }
    };
    paint(tracks, linkedSelection);
    paint(selectedTracks, false);
  }, [docs, docOrdinal, tracks, selectedTracks, linkedSelection, edgeX, width, height, trackHeight, trackGap, slotOf, focusedSeries, colorScheme, docOrdinalById]);

  return (
    <canvas
      ref={canvasRef}
      data-barcode-band={docOrdinal === undefined ? 'series' : 'by-book'}
      data-barcode-doc={docOrdinal}
      data-pointer-contract={coarse ? 'scrub-only' : 'hover-scrub-click-activate'}
      data-selected-layer={selectedTracks.some((track) =>
        docOrdinal === undefined
          ? track.segments.length > 0
          : (track.segmentsByDocOrdinal[track.docOrder.indexOf(docs[docOrdinal] ?? '')]?.length ?? 0) > 0,
      ) ? 'ready' : undefined}
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top,
        width,
        height,
        display: 'block',
        pointerEvents: coarse ? 'none' : 'auto',
        zIndex: 1,
      }}
    />
  );
}

export function BarcodeLegend({
  tracks,
  selectedTracks,
  linkedSelection,
  selectedStatus,
  labelOf,
  slotOf,
  focusedSeries,
  axisLabel,
  onActivate,
}: {
  readonly tracks: readonly BarcodeTrackVM[];
  readonly selectedTracks: readonly BarcodeTrackVM[];
  readonly linkedSelection: boolean;
  readonly selectedStatus: 'pending' | 'ready' | 'error' | null;
  readonly labelOf: (seriesId: string) => string;
  readonly slotOf: (seriesId: string) => number;
  readonly focusedSeries: string | null;
  readonly axisLabel: string;
  readonly onActivate: (track: BarcodeTrackVM, target: BarcodeActivation | null, openExact?: boolean) => void;
}) {
  const presentation = usePresentation();
  const coarse = presentation.pointer === 'coarse';
  const selectedBySeries = new Map(selectedTracks.map((track) => [track.seriesId, track]));
  const stepper = barcodeStepperFor(tracks, focusedSeries, labelOf);
  if (tracks.length === 0) return null;

  const step = (track: BarcodeTrackVM, dir: 1 | -1) => {
    onActivate(track, stepTarget(track, useApp.getState().scrub, dir));
  };

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: presentation.width === 'compact' ? 'var(--text-sm)' : 'var(--text-xs)', color: 'var(--fg-muted)' }}>
        <span>{axisLabel}</span>
        {tracks.map((track) => (
          <span key={track.seriesId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5ch' }}>
            <span aria-hidden="true" style={{ width: '1.5ch', height: 3, background: slotColor(slotOf(track.seriesId)), display: 'inline-block' }} />
            <span>
              {trackSummaryText(track, labelOf(track.seriesId))}
              {linkedSelection && selectedStatus
                ? <> · {selectedBarcodeTotalText(selectedStatus, selectedBySeries.get(track.seriesId)?.total)} selected</>
                : null}
            </span>
            {!coarse && track.total > 0 && (
              <>
                <button type="button" style={navBtn} aria-label={`Previous ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'occurrence' : 'bucket'}`} onClick={() => step(track, -1)}>‹</button>
                <button type="button" style={navBtn} aria-label={`Next ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'occurrence' : 'bucket'}`} onClick={() => step(track, 1)}>›</button>
              </>
            )}
          </span>
        ))}
      </div>
      {coarse && stepper.track && (
        <div role="group" aria-label="Barcode occurrence navigation" style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
          <span>{stepper.label}</span>
          {stepper.fellBack && <span role="note" style={{ color: 'var(--fg-muted)' }}>focused term has no delivered barcode track; showing the first track</span>}
          <button type="button" style={coarseNavBtn} disabled={!stepper.enabled} aria-label={`Previous ${labelOf(stepper.track.seriesId)} ${stepper.unit}`} onClick={() => step(stepper.track!, -1)}>‹</button>
          <button type="button" style={coarseNavBtn} disabled={!stepper.enabled} aria-label={`Next ${labelOf(stepper.track.seriesId)} ${stepper.unit}`} onClick={() => step(stepper.track!, 1)}>›</button>
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
