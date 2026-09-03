import { useEffect, useRef } from 'react';
import type { SeriesStyleV1 } from '@texttrends/core';
import {
  atlasDeviceRows,
  atlasRowOpacity,
  atlasTrackRail,
  atlasYForToken,
  type AtlasColumnTrackVM,
  type AtlasColumnVM,
  type AtlasLayoutColumn,
} from '../../lib/reader-atlas.ts';
import { seriesColor } from '../../lib/series-style.ts';

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function atlasCoarseDisclosure(
  track: AtlasColumnTrackVM,
  label: string,
): string | null {
  if (track.representation !== 'density' || track.densityResolution === null) return null;
  if (track.densityResolution === 'density') return null;
  const level = track.densityResolution === 'very-coarse-density'
    ? 'very coarse density'
    : 'coarse density';
  const bands = track.densityBands === null
    ? 'unknown bands'
    : counted(track.densityBands, 'band');
  return `${label}: ${bands}, ${level}, ${counted(track.documentTotal, 'hit')}`;
}

export function atlasColumnDescription(
  column: AtlasColumnVM,
  title: string,
  labels: ReadonlyMap<string, string>,
): string {
  const extent = column.tokenCount === null
    ? 'extent unavailable'
    : counted(column.tokenCount, 'token');
  const tracks = column.tracks.map((track) => {
    const label = labels.get(track.seriesId) ?? track.seriesId;
    return track.representation === 'exact'
      ? `${label}: ${counted(track.documentTotal, 'exact occurrence')}`
      : `${label}: ${counted(track.documentTotal, 'hit')} in ${
          track.densityBands === null
            ? 'unknown density bands'
            : counted(track.densityBands, 'density band')
        }`;
  });
  return [title, extent, ...tracks].join('. ');
}

function resolveCanvasColor(canvas: HTMLCanvasElement, color: string): string {
  const styles = getComputedStyle(canvas);
  const property = /^var\(\s*(--[^),\s]+)\s*\)$/.exec(color)?.[1];
  return property ? styles.getPropertyValue(property).trim() || styles.color : color;
}

function paintVeryCoarseHatch(
  context: CanvasRenderingContext2D,
  railX: number,
  railWidth: number,
  height: number,
  color: string,
): void {
  context.save();
  context.beginPath();
  context.rect(railX, 0, railWidth, height);
  context.clip();
  context.strokeStyle = color;
  context.globalAlpha = 0.14;
  context.lineWidth = 1;
  for (let y = -railWidth; y < height + railWidth; y += 8) {
    context.beginPath();
    context.moveTo(railX, y);
    context.lineTo(railX + railWidth, y + railWidth);
    context.stroke();
  }
  context.restore();
}

export function ReaderAtlasColumnCanvas({
  column,
  layout,
  styleOf,
  activeToken,
  colorScheme,
}: {
  readonly column: AtlasColumnVM;
  readonly layout: AtlasLayoutColumn;
  readonly styleOf: ReadonlyMap<string, SeriesStyleV1>;
  readonly activeToken: number | null;
  readonly colorScheme: 'dark' | 'light';
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markerY = activeToken === null ? null : atlasYForToken(layout, activeToken);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || layout.width <= 0 || layout.plotHeight <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const deviceWidth = Math.max(1, Math.round(layout.width * dpr));
    const rowsByTrack = column.tracks.map((track) =>
      atlasDeviceRows(track.segments, layout.domainTokenCount, layout.plotHeight, dpr));
    const deviceHeight = Math.max(1, ...rowsByTrack.map((rows) => rows.rowCount));
    if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
    if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, deviceWidth, deviceHeight);
    const rule = resolveCanvasColor(canvas, 'var(--rule)');

    column.tracks.forEach((track, trackOrdinal) => {
      const rail = atlasTrackRail(layout.width, column.tracks.length, trackOrdinal);
      const rows = rowsByTrack[trackOrdinal];
      if (!rail || !rows || rows.rowCount === 0) return;
      const x = Math.round((rail.x / layout.width) * deviceWidth);
      const right = Math.round(((rail.x + rail.width) / layout.width) * deviceWidth);
      const width = Math.max(1, right - x);
      const railDeviceHeight = Math.max(
        0,
        Math.min(deviceHeight, Math.round((layout.railHeight / layout.plotHeight) * deviceHeight)),
      );
      context.globalAlpha = 1;
      context.fillStyle = rule;
      context.fillRect(x, 0, 1, railDeviceHeight);
      context.fillRect(right - 1, 0, 1, railDeviceHeight);
      if (track.densityResolution === 'very-coarse-density') {
        paintVeryCoarseHatch(context, x, width, railDeviceHeight, rule);
      }
      context.fillStyle = resolveCanvasColor(
        canvas,
        seriesColor(styleOf.get(track.seriesId) ?? { color: 'blue', line: 'solid' }),
      );
      const scaleY = deviceHeight / rows.rowCount;
      for (let row = 0; row < rows.rowCount; row += 1) {
        const value = rows.values[row]!;
        if (value <= 0) continue;
        context.globalAlpha = atlasRowOpacity(value, rows.maxValue, track.representation);
        const y0 = Math.floor(row * scaleY);
        const y1 = Math.max(y0 + 1, Math.ceil((row + 1) * scaleY));
        context.fillRect(x, y0, width, y1 - y0);
      }
    });
    context.globalAlpha = 1;
  }, [
    colorScheme,
    column.tracks,
    layout.domainTokenCount,
    layout.plotHeight,
    layout.railHeight,
    layout.width,
    styleOf,
  ]);

  return (
    <div
      className="reader-atlas-rail"
      data-atlas-rail={column.doc}
      style={{ blockSize: layout.plotHeight }}
    >
      <span
        className="reader-atlas-extent"
        aria-hidden="true"
        style={{ blockSize: layout.railHeight }}
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-atlas-canvas={column.doc}
        style={{ inlineSize: layout.width, blockSize: layout.plotHeight }}
      />
      {markerY !== null && (
        <span
          className="reader-atlas-position-marker"
          aria-hidden="true"
          style={{ insetBlockStart: markerY }}
        />
      )}
    </div>
  );
}
