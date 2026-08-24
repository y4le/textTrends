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
import {
  GHOST_BARCODE_OPACITY,
  seriesColor,
  seriesDash,
  seriesLinecap,
} from '../lib/series-style.ts';
import { barcodeBandHeight } from '../lib/trend-geometry.ts';
import { usePresentation } from './PresentationProvider.tsx';
import type { TrendView } from '../lib/trend-view.ts';

interface BarcodeBandProps {
  readonly view: TrendView;
  readonly docs: readonly string[];
  readonly tracks: readonly BarcodeTrackVM[];
  readonly backgroundTracks?: readonly BarcodeTrackVM[];
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
  readonly coarse: boolean;
  readonly foregroundOverlay?: boolean;
  readonly reservedTrackCount?: number;
}

export function BarcodeBand({
  view,
  docs,
  tracks,
  backgroundTracks = [],
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
  coarse,
  foregroundOverlay = false,
  reservedTrackCount = 0,
}: BarcodeBandProps) {
  const presentation = usePresentation();
  const docOrdinalById = useMemo(
    () => new Map(docs.map((doc, d) => [doc, d])),
    [docs],
  );
  if (tracks.length === 0 && backgroundTracks.length === 0) return null;
  const height = barcodeBandHeight(
    Math.max(tracks.length, backgroundTracks.length, reservedTrackCount),
    trackHeight,
    trackGap,
  );
  if (view === 'series') {
    return (
      <BarcodeCanvas
        band="series"
        docs={docs}
        tracks={tracks}
        backgroundTracks={backgroundTracks}
        selectedTracks={selectedTracks}
        linkedSelection={linkedSelection}
        edgeX={edgeX}
        width={width}
        height={height}
        top={plotHeight + bandGap}
        trackHeight={trackHeight}
        trackGap={trackGap}
        styleOf={styleOf}
        coarse={coarse}
        foregroundOverlay={foregroundOverlay}
        reservedTrackCount={reservedTrackCount}
        colorScheme={presentation.colorScheme}
        docOrdinalById={docOrdinalById}
      />
    );
  }
  return docs.map((doc, d) => (
    <BarcodeCanvas
      key={doc}
      band={view}
      docs={docs}
      docOrdinal={d}
      tracks={tracks}
      backgroundTracks={backgroundTracks}
      selectedTracks={selectedTracks}
      linkedSelection={linkedSelection}
      edgeX={edgeX}
      width={width}
      height={height}
      top={d * rowPitch + plotHeight + bandGap}
      trackHeight={trackHeight}
      trackGap={trackGap}
      styleOf={styleOf}
      coarse={coarse}
      foregroundOverlay={foregroundOverlay}
      reservedTrackCount={reservedTrackCount}
      colorScheme={presentation.colorScheme}
      docOrdinalById={docOrdinalById}
    />
  ));
}

function BarcodeCanvas({
  band,
  docs,
  docOrdinal,
  tracks,
  backgroundTracks = [],
  selectedTracks,
  linkedSelection,
  edgeX,
  width,
  height,
  top,
  trackHeight,
  trackGap,
  styleOf,
  coarse,
  foregroundOverlay = false,
  colorScheme,
  docOrdinalById,
}: Omit<BarcodeBandProps, 'view' | 'plotHeight' | 'rowPitch' | 'bandGap'> & {
  readonly band: TrendView;
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

    const paint = (
      paintTracks: readonly BarcodeTrackVM[],
      rowTracks: readonly BarcodeTrackVM[],
      context: boolean,
      opacity: number,
      overlay: boolean,
    ) => {
      const rowBySeries = new Map(rowTracks.map((track, row) => [track.seriesId, row]));
      for (const track of paintTracks) {
        const row = rowBySeries.get(track.seriesId);
        if (row === undefined) continue;
        const y = overlay ? 0 : row * (trackHeight + trackGap);
        const markHeight = overlay ? height : trackHeight;
        // Canvas fillStyle does not resolve CSS custom-property expressions.
        // Resolve the shared series token explicitly so a per-book canvas
        // does not silently retain its default black fill.
        ctx.fillStyle = canvasColor(seriesColor(styleOf(track.seriesId)));
        const paintBucket = (bucketOrdinal: number) => {
          const doc = track.docOrder[bucketOrdinal];
          const d = doc === undefined ? undefined : docOrdinalById.get(doc);
          if (d === undefined) return;
          for (const segment of track.segmentsByDocOrdinal[bucketOrdinal] ?? []) {
            const x0 = edgeX(d, segment.t0);
            const x1 = edgeX(d, segment.t1);
            const markAlpha = segment.kind === 'tick' ? 1 : 0.15 + 0.85 * segment.intensity;
            const markWidth = Math.max(overlay ? 2 : 1, x1 - x0);
            if (overlay) {
              ctx.globalAlpha = 0.9;
              ctx.fillStyle = canvasColor('var(--bg)');
              ctx.fillRect(x0 - 1, y, markWidth + 2, markHeight);
              ctx.fillStyle = canvasColor(seriesColor(styleOf(track.seriesId)));
            }
            ctx.globalAlpha = markAlpha * opacity * (context ? 0.25 : 1);
            ctx.fillRect(x0, y, markWidth, markHeight);
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
    paint(backgroundTracks, backgroundTracks, false, GHOST_BARCODE_OPACITY, false);
    paint(tracks, tracks, linkedSelection, 1, foregroundOverlay);
    paint(selectedTracks, tracks, false, 1, foregroundOverlay);
  }, [docs, docOrdinal, tracks, backgroundTracks, selectedTracks, linkedSelection, edgeX, width, height, trackHeight, trackGap, styleOf, coarse, colorScheme, docOrdinalById, foregroundOverlay]);

  return (
    <canvas
      ref={canvasRef}
      data-barcode-band={band}
      data-barcode-doc={docOrdinal}
      data-barcode-series={tracks.map((track) => track.seriesId).join(' ')}
      data-barcode-background-series={backgroundTracks.map((track) => track.seriesId).join(' ')}
      data-barcode-foreground-overlay={foregroundOverlay || undefined}
      data-pointer-contract={coarse
        ? 'scrub-only'
        : tracks.length === 0
          ? 'background-only'
          : 'hover-scrub-click-activate'}
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
        pointerEvents: coarse || tracks.length === 0 ? 'none' : 'auto',
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
  onActivate,
}: {
  readonly tracks: readonly BarcodeTrackVM[];
  readonly selectedTracks: readonly BarcodeTrackVM[];
  readonly linkedSelection: boolean;
  readonly selectedStatus: 'pending' | 'ready' | 'error' | null;
  readonly labelOf: (seriesId: string) => string;
  readonly styleOf: (seriesId: string) => SeriesStyleV1;
  readonly onActivate: (track: BarcodeTrackVM, target: BarcodeActivation | null, openExact?: boolean) => void;
}) {
  const presentation = usePresentation();
  const coarse = presentation.coarseAvailable;
  const selectedBySeries = new Map(selectedTracks.map((track) => [track.seriesId, track]));
  const stepper = barcodeStepperFor(tracks);
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
    <div className="trend-term-navigation">
      <ul
        aria-label="Term totals"
        className="trend-term-list"
        style={{ fontSize: presentation.width === 'compact' ? 'var(--text-sm)' : 'var(--text-xs)' }}
      >
        {tracks.map((track) => {
          const label = labelOf(track.seriesId);
          const unit = track.representation === 'exact' ? 'reference' : 'bucket';
          const enabled = track.total > 0 && track.segments.length > 0;
          const isPrimaryCoarseStepper = coarse && stepper.track?.seriesId === track.seriesId;
          const navigation = (
            <>
              <button
                type="button"
                className="trend-term-arrow"
                style={coarse ? coarseNavBtn : navBtn}
                disabled={!enabled}
                aria-label={isPrimaryCoarseStepper ? `Previous ${unit}` : `Previous ${label} ${unit}`}
                onClick={() => step(track, -1)}
              >
                ‹
              </button>
              <span className="trend-term-summary">
                <span data-term-occurrence-label>{label}</span>
                <span aria-hidden="true">·</span>
                <span data-term-occurrence-count>{occurrenceText(track)}</span>
                <svg
                  className="trend-term-underline"
                  width="100%"
                  height="4"
                  aria-hidden="true"
                >
                  <line
                    x1="0"
                    y1="2"
                    x2="100%"
                    y2="2"
                    stroke={seriesColor(styleOf(track.seriesId))}
                    strokeWidth="2"
                    strokeDasharray={seriesDash(styleOf(track.seriesId))}
                    strokeLinecap={seriesLinecap(styleOf(track.seriesId))}
                  />
                </svg>
              </span>
              <button
                type="button"
                className="trend-term-arrow"
                style={coarse ? coarseNavBtn : navBtn}
                disabled={!enabled}
                aria-label={isPrimaryCoarseStepper ? `Next ${unit}` : `Next ${label} ${unit}`}
                onClick={() => step(track, 1)}
              >
                ›
              </button>
            </>
          );
          return (
            <li
              key={track.seriesId}
              data-term-occurrences={track.seriesId}
              className="trend-term-item"
            >
              {isPrimaryCoarseStepper ? (
                <span
                  role="group"
                  aria-label={`Barcode ${stepper.unit === 'occurrence' ? 'reference' : 'bucket'} navigation`}
                  className="trend-term-item-controls"
                >
                  {navigation}
                </span>
              ) : navigation}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const navBtn = {
  font: 'inherit',
  color: 'var(--fg)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 'var(--space-1) 0.5ch',
} as const;

const coarseNavBtn = {
  ...navBtn,
  minBlockSize: 48,
  minInlineSize: 48,
} as const;
