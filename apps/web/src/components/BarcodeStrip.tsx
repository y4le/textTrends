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
import type { SeriesStyleV1 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import {
  barcodeLegendTotalText,
  stepTarget,
  type BarcodeActivation,
  type BarcodeTrackVM,
} from '../lib/barcode-view.ts';
import { barcodeStepperFor } from '../lib/barcode-stepper.ts';
import { seriesColor } from '../lib/series-style.ts';
import { barcodeBandHeight } from '../lib/trend-geometry.ts';
import { SeriesLineSample } from './chrome.tsx';
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
  readonly styleOf: (seriesId: string) => SeriesStyleV1;
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
  styleOf,
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
        styleOf={styleOf}
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
      styleOf={styleOf}
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
  styleOf,
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
        ctx.fillStyle = canvasColor(seriesColor(styleOf(track.seriesId)));
        const focusDim = focusedSeries !== null && track.seriesId !== focusedSeries ? 0.45 : 1;
        const paintBucket = (bucketOrdinal: number) => {
          const doc = track.docOrder[bucketOrdinal];
          const d = doc === undefined ? undefined : docOrdinalById.get(doc);
          if (d === undefined) return;
          for (const segment of track.segmentsByDocOrdinal[bucketOrdinal] ?? []) {
            const x0 = edgeX(d, segment.t0);
            const x1 = edgeX(d, segment.t1);
            const markAlpha = segment.kind === 'tick' ? 1 : 0.15 + 0.85 * segment.intensity;
            ctx.globalAlpha = markAlpha * focusDim * (context ? 0.25 : 1);
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
  }, [docs, docOrdinal, tracks, selectedTracks, linkedSelection, edgeX, width, height, trackHeight, trackGap, styleOf, focusedSeries, colorScheme, docOrdinalById]);

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
  styleOf,
  focusedSeries,
  onActivate,
}: {
  readonly tracks: readonly BarcodeTrackVM[];
  readonly selectedTracks: readonly BarcodeTrackVM[];
  readonly linkedSelection: boolean;
  readonly selectedStatus: 'pending' | 'ready' | 'error' | null;
  readonly labelOf: (seriesId: string) => string;
  readonly styleOf: (seriesId: string) => SeriesStyleV1;
  readonly focusedSeries: string | null;
  readonly onActivate: (track: BarcodeTrackVM, target: BarcodeActivation | null, openExact?: boolean) => void;
}) {
  const presentation = usePresentation();
  const coarse = presentation.coarseAvailable;
  const selectedBySeries = new Map(selectedTracks.map((track) => [track.seriesId, track]));
  const stepper = barcodeStepperFor(tracks, focusedSeries);
  if (tracks.length === 0) return null;

  const step = (track: BarcodeTrackVM, dir: 1 | -1) => {
    onActivate(track, stepTarget(track, useApp.getState().scrub, dir));
  };
  const occurrenceText = (track: BarcodeTrackVM): string => barcodeLegendTotalText({
    linkedSelection,
    selectedStatus,
    selectedTotal: selectedBySeries.get(track.seriesId)?.total,
    corpusTotal: track.total,
  });

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <ul
        aria-label="Term totals"
        style={{
          display: 'grid',
          gap: 'var(--space-1)',
          listStyle: 'none',
          margin: 'var(--space-2) 0 0',
          padding: 0,
          width: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: presentation.width === 'compact' ? 'var(--text-sm)' : 'var(--text-xs)',
        }}
      >
        {tracks.map((track) => (
          <li
            key={track.seriesId}
            data-term-occurrences={track.seriesId}
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              minWidth: 0,
              color: 'var(--fg-muted)',
            }}
          >
            <SeriesLineSample
              style={styleOf(track.seriesId)}
              emphasized={focusedSeries === track.seriesId}
            />
            <span data-term-occurrence-label style={{ color: 'var(--fg)' }}>
              {labelOf(track.seriesId)}
            </span>
            <span aria-hidden="true">·</span>
            <span data-term-occurrence-count>
              {occurrenceText(track)}
            </span>
            {!coarse && track.total > 0 && (
              <>
                <button type="button" style={navBtn} aria-label={`Previous ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'reference' : 'bucket'}`} onClick={() => step(track, -1)}>‹</button>
                <button type="button" style={navBtn} aria-label={`Next ${labelOf(track.seriesId)} ${track.representation === 'exact' ? 'reference' : 'bucket'}`} onClick={() => step(track, 1)}>›</button>
              </>
            )}
            {coarse && stepper.track?.seriesId === track.seriesId && (
              <span
                role="group"
                aria-label={`Barcode ${stepper.unit === 'occurrence' ? 'reference' : 'bucket'} navigation`}
                style={{ display: 'inline-flex', gap: 'var(--space-2)' }}
              >
                <button type="button" style={coarseNavBtn} disabled={!stepper.enabled} aria-label={`Previous ${stepper.unit === 'occurrence' ? 'reference' : 'bucket'}`} onClick={() => step(track, -1)}>‹</button>
                <button type="button" style={coarseNavBtn} disabled={!stepper.enabled} aria-label={`Next ${stepper.unit === 'occurrence' ? 'reference' : 'bucket'}`} onClick={() => step(track, 1)}>›</button>
              </span>
            )}
          </li>
        ))}
      </ul>
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
