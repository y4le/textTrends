import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { SeriesStyleV1 } from '@texttrends/core';
import { findScope } from '../../lib/interaction.ts';
import { readerCursorToken } from '../../lib/reader-intent.ts';
import {
  atlasCanvasWindow,
  atlasColumns,
  atlasDeviceRowCount,
  atlasDeviceRows,
  atlasLayout,
  atlasMovedToken,
  atlasRowOpacity,
  atlasTokenAtY,
  atlasTrackActivationAt,
  atlasTrackRail,
  atlasYForToken,
  type AtlasColumnTrackVM,
  type AtlasColumnVM,
  type AtlasLayoutColumn,
} from '../../lib/reader-atlas.ts';
import {
  readyReaderDocumentOrder,
  readerRelativeToken,
} from '../../lib/reader-order.ts';
import { projectedBarcodeTracks } from '../../lib/trend-stage.ts';
import { seriesColor } from '../../lib/series-style.ts';
import {
  shortcutAria,
  shortcutMatches,
  type ShortcutId,
} from '../../lib/shortcuts.ts';
import { useApp } from '../../lib/store-instance.ts';
import { SMALL_BUTTON_STYLE } from '../chrome.tsx';
import { usePresentation } from '../PresentationProvider.tsx';
import { ReaderScaleControl } from './ReaderScaleControl.tsx';

const ATLAS_COLUMN_GAP = 12;
const ATLAS_COLUMN_MIN = 116;
const ATLAS_COLUMN_MAX = 168;
const ATLAS_ANNOUNCEMENT_DELAY_MS = 400;
const ATLAS_WHEEL_STEP_PX = 40;
const ATLAS_PASSTHROUGH_SHORTCUTS = [
  'reader-occurrence-next',
  'reader-occurrence-previous',
  'reader-text-previous',
  'reader-text-next',
  'reader-close',
  'reader-rsvp-toggle',
  'show-help',
  'find-open',
] as const satisfies readonly ShortcutId[];

interface AtlasPosition {
  readonly doc: string;
  readonly token: number;
}

interface AtlasTouchStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly scrollLeft: number;
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function measuredAtlasPlotHeight(scroller: HTMLElement): number {
  let measured = Number.POSITIVE_INFINITY;
  for (const column of scroller.querySelectorAll<HTMLElement>('.reader-atlas-column')) {
    const header = column.querySelector<HTMLElement>(':scope > header');
    const footer = column.querySelector<HTMLElement>(':scope > footer');
    if (!header || !footer) continue;
    const styles = getComputedStyle(column);
    const padding = Number.parseFloat(styles.paddingBlockStart)
      + Number.parseFloat(styles.paddingBlockEnd);
    const available = column.clientHeight - padding - header.offsetHeight - footer.offsetHeight;
    if (Number.isFinite(available)) measured = Math.min(measured, available);
  }
  return Number.isFinite(measured) ? Math.max(0, measured) : 0;
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

function AtlasColumnCanvas({
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

function coarseDisclosure(track: AtlasColumnTrackVM, label: string): string | null {
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

function columnDescription(
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

function ReaderAtlasRuler({
  order,
  activeDoc,
  focusedDoc,
  titleOf,
  normalization,
  onFocusDoc,
  onActivateDoc,
  onNormalization,
}: {
  readonly order: readonly string[];
  readonly activeDoc: string;
  readonly focusedDoc: string;
  readonly titleOf: (doc: string) => string;
  readonly normalization: 'equal' | 'to-scale';
  readonly onFocusDoc: (doc: string) => void;
  readonly onActivateDoc: (doc: string) => void;
  readonly onNormalization: (normalization: 'equal' | 'to-scale') => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusIndex = Math.max(0, order.indexOf(focusedDoc));
  const activeIndex = Math.max(0, order.indexOf(activeDoc));
  const previous = activeIndex > 0 ? order[activeIndex - 1]! : null;
  const next = activeIndex < order.length - 1 ? order[activeIndex + 1]! : null;

  useEffect(() => {
    const button = listRef.current?.querySelector<HTMLElement>(
      `[data-reader-atlas-ruler-doc="${CSS.escape(focusedDoc)}"]`,
    );
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusedDoc]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.key === 'Enter') {
      onActivateDoc(order[index]!);
      return;
    }
    const next = Math.max(
      0,
      Math.min(order.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)),
    );
    const doc = order[next]!;
    onFocusDoc(doc);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(
        `[data-reader-atlas-ruler-doc="${CSS.escape(doc)}"]`,
      )?.focus();
    });
  };

  return (
    <div className="reader-atlas-ruler" data-reader-scale="atlas">
      <div className="reader-atlas-ruler-compact" role="group" aria-label="Active text">
        <button
          type="button"
          aria-label={previous === null ? 'At first readable text' : `Previous text: ${titleOf(previous)}`}
          disabled={previous === null}
          onClick={() => { if (previous !== null) onActivateDoc(previous); }}
        >
          <span aria-hidden="true">←</span>
        </button>
        <div>
          <span>text {activeIndex + 1} of {order.length}</span>
          <strong title={titleOf(activeDoc)}>{titleOf(activeDoc)}</strong>
        </div>
        <button
          type="button"
          aria-label={next === null ? 'At last readable text' : `Next text: ${titleOf(next)}`}
          disabled={next === null}
          onClick={() => { if (next !== null) onActivateDoc(next); }}
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
      <div ref={listRef} className="reader-atlas-ruler-list" role="toolbar" aria-label="Texts">
        {order.map((doc, index) => (
          <button
            key={doc}
            type="button"
            data-reader-atlas-ruler-doc={doc}
            aria-label={`Text ${index + 1} of ${order.length}: ${titleOf(doc)}`}
            aria-pressed={doc === activeDoc}
            tabIndex={index === focusIndex ? 0 : -1}
            title={titleOf(doc)}
            onFocus={() => onFocusDoc(doc)}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onActivateDoc(doc)}
          >
            {titleOf(doc)}
          </button>
        ))}
      </div>
      <div className="reader-atlas-normalization" role="group" aria-label="Atlas normalization">
        {(['equal', 'to-scale'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={normalization === value}
            onClick={() => onNormalization(value)}
          >
            {value === 'equal' ? 'Equal' : 'To scale'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderAtlas({
  onOpenHelp,
  onOpenSettings,
  onAnnounce,
}: {
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const place = useApp((state) => state.readerPlace);
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const tokenCounts = useApp((state) => state.corpusTokenCounts);
  const scrub = useApp((state) => state.scrub);
  const series = useApp((state) => state.series);
  const dispersion = useApp((state) => state.dispersion);
  const interaction = useApp((state) => state.interaction);
  const normalization = useApp((state) => state.atlasNormalization);
  const setNormalization = useApp((state) => state.setAtlasNormalization);
  const selectPosition = useApp((state) => state.selectAtlasPosition);
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const closeReader = useApp((state) => state.closeReader);
  const runQueries = useApp((state) => state.runQueries);
  const presentation = usePresentation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollFrame = useRef(0);
  const positionFrame = useRef(0);
  const queuedPosition = useRef<AtlasPosition | null>(null);
  const navigationPosition = useRef<AtlasPosition | null>(null);
  const navigationAnchor = useRef<'occurrence' | 'position'>('position');
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<AtlasTouchStart | null>(null);
  const wheelRemainder = useRef(0);
  const lastCentered = useRef<string | null>(null);
  const [viewport, setViewport] = useState({ width: 0, plotHeight: 64 });
  const [scrollLeft, setScrollLeft] = useState(0);
  const [focusedDoc, setFocusedDoc] = useState(place?.doc ?? '');

  const order = useMemo(
    () => readyReaderDocumentOrder(project?.data.order, snapshot?.readyDocs ?? []),
    [project?.data.order, snapshot?.readyDocs],
  );
  const titles = useMemo(
    () => new Map(project?.data.docs.map((entry) => [entry.doc, entry.meta.title]) ?? []),
    [project?.data.docs],
  );
  const titleOf = (doc: string) => titles.get(doc) ?? doc;
  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const find = scopedFind?.find ?? null;
  const activeSeries = useMemo(() => findMode
    ? find === null
      ? []
      : [{ id: find.query.seriesId, label: find.query.label, style: find.query.style }]
    : series, [find, findMode, series]);
  const seriesOrder = useMemo(() => activeSeries.map((item) => item.id), [activeSeries]);
  const labels = useMemo(
    () => new Map(activeSeries.map((item) => [item.id, item.label])),
    [activeSeries],
  );
  const styleOf = useMemo(
    () => new Map(activeSeries.map((item) => [item.id, item.style])),
    [activeSeries],
  );
  const effectiveSnapshot = snapshot?.snapshot ?? null;
  const dispersionState = findMode ? find?.dispersion ?? null : dispersion?.state ?? null;
  const dispersionSnapshot = findMode ? find?.snapshot ?? null : dispersion?.snapshot ?? null;
  const resident = dispersionState?.status === 'ready'
    && dispersionSnapshot === effectiveSnapshot
    ? dispersionState.result
    : null;
  const tracks = useMemo(
    () => activeSeries.length === 0
      ? []
      : projectedBarcodeTracks(resident, snapshot?.readyDocs ?? [], seriesOrder),
    [activeSeries.length, resident, seriesOrder, snapshot?.readyDocs],
  );
  const columns = useMemo(
    () => atlasColumns(tracks, resident?.geometry ?? null, order, tokenCounts),
    [order, resident?.geometry, tokenCounts, tracks],
  );
  const columnDetails = useMemo(() => columns.map((column) => {
    const title = titles.get(column.doc) ?? column.doc;
    return {
      title,
      description: columnDescription(column, title, labels),
      coarse: column.tracks.flatMap((track) => {
        const disclosure = coarseDisclosure(track, labels.get(track.seriesId) ?? track.seriesId);
        return disclosure === null ? [] : [disclosure];
      }),
    };
  }), [columns, labels, titles]);
  const activeToken = place === null
    ? 0
    : scrub?.doc === place.doc
      ? scrub.token
      : readerCursorToken(place.cursor);
  const plotHeight = Math.max(64, viewport.plotHeight);
  const availableForFour = viewport.width > 0
    ? (viewport.width - ATLAS_COLUMN_GAP * 3) / Math.min(4, Math.max(1, columns.length))
    : ATLAS_COLUMN_MIN;
  const columnWidth = Math.max(ATLAS_COLUMN_MIN, Math.min(ATLAS_COLUMN_MAX, availableForFour));
  const layout = useMemo(
    () => atlasLayout(columns, normalization, {
      plotHeight,
      columnWidth,
      columnGap: ATLAS_COLUMN_GAP,
    }),
    [columnWidth, columns, normalization, plotHeight],
  );
  const canvasWindow = atlasCanvasWindow(layout, scrollLeft, viewport.width);

  useLayoutEffect(() => {
    if (place === null || queuedPosition.current !== null) return;
    navigationPosition.current = { doc: place.doc, token: activeToken };
    navigationAnchor.current = place.anchor;
  }, [activeToken, place]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
    const publish = () => setViewport((current) => {
      const next = {
        width: scroller.clientWidth,
        plotHeight: measuredAtlasPlotHeight(scroller),
      };
      return current.width === next.width && current.plotHeight === next.plotHeight
        ? current
        : next;
    });
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(scroller);
    for (const column of scroller.querySelectorAll<HTMLElement>('.reader-atlas-column')) {
      const header = column.querySelector<HTMLElement>(':scope > header');
      const footer = column.querySelector<HTMLElement>(':scope > footer');
      if (header) observer.observe(header);
      if (footer) observer.observe(footer);
    }
    return () => observer.disconnect();
  }, [columns]);

  useEffect(() => () => {
    cancelAnimationFrame(scrollFrame.current);
    cancelAnimationFrame(positionFrame.current);
    if (announcementTimer.current !== null) clearTimeout(announcementTimer.current);
  }, []);

  useEffect(() => {
    if (!place) return;
    setFocusedDoc(place.doc);
    const key = place.doc;
    if (lastCentered.current === key) return;
    lastCentered.current = key;
    const target = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-atlas-column="${CSS.escape(place.doc)}"]`,
    );
    target?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: presentation.reducedMotion ? 'auto' : 'smooth',
    });
  }, [place, presentation.reducedMotion]);

  const atlasAvailable = place !== null && snapshot !== null && order.length >= 2;
  const onAtlasWheel = useEffectEvent((event: WheelEvent, plane: HTMLDivElement) => {
    if (
      event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      || event.deltaY === 0
    ) return;
    // React delegates wheel passively. Atlas owns dominant-axis vertical
    // movement, so this listener must be explicitly non-passive to prevent
    // a future scrollable ancestor from consuming the same gesture.
    event.preventDefault();
    const pixels = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * plane.clientHeight
        : event.deltaY;
    wheelRemainder.current += pixels;
    const steps = Math.trunc(wheelRemainder.current / ATLAS_WHEEL_STEP_PX);
    if (steps === 0) return;
    wheelRemainder.current -= steps * ATLAS_WHEEL_STEP_PX;
    moveVertical(steps < 0 ? 'previous' : 'next', Math.abs(steps));
  });

  useEffect(() => {
    if (!atlasAvailable) return undefined;
    const plane = scrollerRef.current;
    if (plane === null) return undefined;
    const onWheel = (event: WheelEvent) => onAtlasWheel(event, plane);
    plane.addEventListener('wheel', onWheel, { passive: false });
    return () => plane.removeEventListener('wheel', onWheel);
  }, [atlasAvailable]);

  if (!atlasAvailable) return null;
  const activeIndex = Math.max(0, order.indexOf(place.doc));
  const activeExtent = tokenCounts.get(place.doc);
  const activePercent = activeExtent && activeExtent > 1
    ? Math.round((activeToken / (activeExtent - 1)) * 100)
    : 0;
  const distributionStatus = activeSeries.length === 0
    ? 'No terms shown.'
    : dispersionState?.status === 'error'
      ? `Term distribution unavailable: ${dispersionState.message}`
      : resident === null
        ? 'Loading term distribution…'
        : null;

  const announcePosition = (target: AtlasPosition) => {
    const count = tokenCounts.get(target.doc);
    const ordinal = order.indexOf(target.doc);
    if (count === undefined || ordinal < 0) return;
    const percent = count > 1 ? Math.round((target.token / (count - 1)) * 100) : 0;
    onAnnounce(
      `Atlas. ${titleOf(target.doc)}, text ${ordinal + 1} of ${order.length}. Token ${
        Math.min(count, target.token + 1).toLocaleString()} of ${count.toLocaleString()}, ${percent} percent.`,
    );
  };

  const scheduleAnnouncement = (target: AtlasPosition) => {
    if (announcementTimer.current !== null) clearTimeout(announcementTimer.current);
    announcementTimer.current = setTimeout(() => {
      announcementTimer.current = null;
      announcePosition(target);
    }, ATLAS_ANNOUNCEMENT_DELAY_MS);
  };

  const cancelAnnouncement = () => {
    if (announcementTimer.current !== null) clearTimeout(announcementTimer.current);
    announcementTimer.current = null;
  };

  const cancelQueuedPosition = () => {
    cancelAnimationFrame(positionFrame.current);
    positionFrame.current = 0;
    queuedPosition.current = null;
  };

  const commitPosition = (
    target: AtlasPosition,
    anchor: 'occurrence' | 'position' = 'position',
    descend = false,
  ) => {
    cancelQueuedPosition();
    navigationPosition.current = target;
    navigationAnchor.current = anchor;
    selectPosition(target, anchor, descend);
    if (descend) cancelAnnouncement();
    else scheduleAnnouncement(target);
  };

  const queuePosition = (target: AtlasPosition) => {
    navigationPosition.current = target;
    navigationAnchor.current = 'position';
    queuedPosition.current = target;
    if (positionFrame.current !== 0) return;
    positionFrame.current = requestAnimationFrame(() => {
      positionFrame.current = 0;
      const queued = queuedPosition.current;
      queuedPosition.current = null;
      if (queued === null) return;
      selectPosition(queued, 'position');
      scheduleAnnouncement(queued);
    });
  };

  const relativePositionIn = (doc: string, base: AtlasPosition): AtlasPosition | null => {
    const currentCount = tokenCounts.get(base.doc);
    const targetCount = tokenCounts.get(doc);
    if (currentCount === undefined || targetCount === undefined) return null;
    const token = readerRelativeToken(base.token, currentCount, targetCount);
    return token === null ? null : { doc, token };
  };

  const activateDocument = (doc: string) => {
    const base = navigationPosition.current ?? { doc: place.doc, token: activeToken };
    const target = relativePositionIn(doc, base);
    if (target !== null) commitPosition(target);
  };

  const hitTrack = (
    event: ReactPointerEvent<HTMLDivElement>,
    column: AtlasColumnVM,
    layoutColumn: AtlasLayoutColumn,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const token = atlasTokenAtY(layoutColumn, localY);
    if (token === null) return;
    const dpr = window.devicePixelRatio || 1;
    const rowCount = atlasDeviceRowCount(layoutColumn.plotHeight, dpr);
    const trackOrdinal = column.tracks.findIndex((_track, ordinal) => {
      const rail = atlasTrackRail(layoutColumn.width, column.tracks.length, ordinal);
      return rail !== null && localX >= rail.x && localX < rail.x + rail.width;
    });
    if (trackOrdinal < 0) {
      commitPosition({ doc: column.doc, token });
      return;
    }
    const track = column.tracks[trackOrdinal]!;
    const activation = atlasTrackActivationAt(track, layoutColumn, localY, rowCount);
    if (activation === null) return;
    if (activation.kind === 'occurrence') {
      centerKwicAt(track.seriesId, column.doc, activation.token, {
        kind: 'occurrence', groupId: track.groupId,
      });
      commitPosition({ doc: column.doc, token: activation.token }, 'occurrence', true);
      return;
    }
    if (activation.kind === 'bucket') {
      centerKwicAt(track.seriesId, column.doc, activation.token, {
        kind: 'bucket', count: activation.count,
      });
      commitPosition({ doc: column.doc, token: activation.token }, 'position', true);
      return;
    }
    commitPosition({ doc: column.doc, token: activation.token });
  };

  const moveVertical = (
    movement: Parameters<typeof atlasMovedToken>[2],
    multiplier = 1,
  ) => {
    const base = navigationPosition.current ?? { doc: place.doc, token: activeToken };
    const count = tokenCounts.get(base.doc);
    if (count === undefined) return;
    const token = atlasMovedToken(base.token, count, movement, multiplier);
    if (token !== null && token !== base.token) queuePosition({ doc: base.doc, token });
  };

  const moveHorizontal = (direction: -1 | 1) => {
    const base = navigationPosition.current ?? { doc: place.doc, token: activeToken };
    const index = order.indexOf(base.doc);
    const doc = index < 0 ? undefined : order[index + direction];
    if (doc === undefined) {
      cancelAnnouncement();
      onAnnounce(direction < 0 ? 'First readable text.' : 'Last readable text.');
      return;
    }
    const target = relativePositionIn(doc, base);
    if (target !== null) queuePosition(target);
  };

  const onAtlasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent;
    if (ATLAS_PASSTHROUGH_SHORTCUTS.some((id) => shortcutMatches(nativeEvent, id))) {
      cancelQueuedPosition();
      cancelAnnouncement();
      return;
    }
    if (shortcutMatches(nativeEvent, 'reader-atlas-descend')) {
      event.preventDefault();
      const target = navigationPosition.current ?? { doc: place.doc, token: activeToken };
      commitPosition(target, navigationAnchor.current, true);
      return;
    }
    if (shortcutMatches(nativeEvent, 'reader-atlas-text-previous')) {
      event.preventDefault();
      moveHorizontal(-1);
    } else if (shortcutMatches(nativeEvent, 'reader-atlas-text-next')) {
      event.preventDefault();
      moveHorizontal(1);
    } else if (shortcutMatches(nativeEvent, 'reader-atlas-position-previous')) {
      event.preventDefault();
      moveVertical('previous');
    } else if (shortcutMatches(nativeEvent, 'reader-atlas-position-next')) {
      event.preventDefault();
      moveVertical('next');
    } else if (shortcutMatches(nativeEvent, 'reader-atlas-page-previous')) {
      event.preventDefault();
      moveVertical('page-previous');
    } else if (shortcutMatches(nativeEvent, 'reader-atlas-page-next')) {
      event.preventDefault();
      moveVertical('page-next');
    } else if (shortcutMatches(nativeEvent, 'reader-book-start')) {
      event.preventDefault();
      moveVertical('start');
    } else if (shortcutMatches(nativeEvent, 'reader-book-end')) {
      event.preventDefault();
      moveVertical('end');
    }
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    touchStart.current = null;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    touchStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    };
  };

  const onTrackPointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
    column: AtlasColumnVM,
    layoutColumn: AtlasLayoutColumn,
  ) => {
    if (event.pointerType !== 'touch') {
      hitTrack(event, column, layoutColumn);
      return;
    }
    const down = touchStart.current;
    touchStart.current = null;
    if (
      down === null
      || down.pointerId !== event.pointerId
      || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8
      || Math.abs((scrollerRef.current?.scrollLeft ?? 0) - down.scrollLeft) > 8
    ) return;
    hitTrack(event, column, layoutColumn);
  };

  const atlasLabel = [
    `Atlas, ${normalization === 'equal' ? 'Equal' : 'To scale'}`,
    `${titleOf(place.doc)}, text ${activeIndex + 1} of ${order.length}`,
    `token ${Math.min(activeToken + 1, activeExtent ?? activeToken + 1)} of ${activeExtent ?? 'unknown'}, ${activePercent} percent`,
    distributionStatus ?? `${counted(activeSeries.length, 'term')} shown`,
  ].join('. ');

  return (
    <>
      <header className="reader-header">
        <div>
          <h2 id="reader-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            <span className="visually-hidden">Reader: </span>{titleOf(place.doc)}
          </h2>
          <p className="reader-position">
            text {activeIndex + 1} of {order.length} · token {Math.min(activeToken + 1, activeExtent ?? activeToken + 1).toLocaleString()} of {activeExtent?.toLocaleString() ?? 'unknown'} · {activePercent}%
          </p>
        </div>
        <div className="reader-header-actions">
          <ReaderScaleControl />
          <button
            id="reader-settings-open"
            type="button"
            onClick={(event) => onOpenSettings(event.currentTarget)}
            style={SMALL_BUTTON_STYLE}
          >
            settings
          </button>
          <button
            type="button"
            aria-keyshortcuts={shortcutAria(['show-help'])}
            onClick={onOpenHelp}
            style={SMALL_BUTTON_STYLE}
          >
            help
          </button>
          <button type="button" onClick={closeReader} style={SMALL_BUTTON_STYLE}>back</button>
        </div>
      </header>
      <ReaderAtlasRuler
        order={order}
        activeDoc={place.doc}
        focusedDoc={focusedDoc}
        titleOf={titleOf}
        normalization={normalization}
        onFocusDoc={setFocusedDoc}
        onActivateDoc={activateDocument}
        onNormalization={(value) => {
          cancelAnnouncement();
          setNormalization(value);
          onAnnounce(`Atlas normalization: ${value === 'equal' ? 'Equal' : 'To scale'}.`);
        }}
      />
      {distributionStatus && (
        <div
          className="reader-feedback reader-atlas-feedback"
          role={dispersionState?.status === 'error' ? 'alert' : 'status'}
        >
          <span>{distributionStatus}</span>
          {dispersionState?.status === 'error' && (
            <button type="button" onClick={runQueries} style={SMALL_BUTTON_STYLE}>retry analysis</button>
          )}
        </div>
      )}
      <div
        id="reader-atlas-plane"
        ref={scrollerRef}
        className="reader-atlas-plane"
        role="group"
        tabIndex={0}
        aria-label={atlasLabel}
        aria-keyshortcuts={shortcutAria([
          'reader-atlas-text-previous',
          'reader-atlas-text-next',
          'reader-atlas-position-previous',
          'reader-atlas-position-next',
          'reader-atlas-page-previous',
          'reader-atlas-page-next',
          'reader-atlas-descend',
          'reader-occurrence-previous',
          'reader-occurrence-next',
          'reader-text-previous',
          'reader-text-next',
          'reader-book-start',
          'reader-book-end',
        ])}
        onScroll={(event) => {
          const left = event.currentTarget.scrollLeft;
          cancelAnimationFrame(scrollFrame.current);
          scrollFrame.current = requestAnimationFrame(() => setScrollLeft(left));
        }}
        onKeyDown={onAtlasKeyDown}
      >
        <div className="reader-atlas-columns" style={{ inlineSize: layout.width }}>
          {columns.map((column, ordinal) => {
            const layoutColumn = layout.columns[ordinal]!;
            const details = columnDetails[ordinal]!;
            const visible = ordinal >= canvasWindow.start && ordinal < canvasWindow.end;
            const keepCanvas = visible || column.doc === place.doc || column.doc === focusedDoc;
            const position = column.doc === place.doc ? activeToken : null;
            return (
              <article
                key={column.doc}
                className="reader-atlas-column"
                data-atlas-column={column.doc}
                data-atlas-active={column.doc === place.doc || undefined}
                data-atlas-status={column.status}
                style={{ inlineSize: layoutColumn.width }}
              >
                <header title={details.title}>
                  <strong>{details.title}</strong>
                  <span>text {ordinal + 1}</span>
                </header>
                {column.status === 'ready' ? (
                  keepCanvas ? (
                    <div
                      onPointerDown={onTrackPointerDown}
                      onPointerUp={(event) => onTrackPointerUp(event, column, layoutColumn)}
                      onPointerCancel={() => { touchStart.current = null; }}
                      onDoubleClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const token = atlasTokenAtY(layoutColumn, event.clientY - rect.top);
                        if (token !== null) {
                          commitPosition({ doc: column.doc, token }, 'position', true);
                        }
                      }}
                    >
                      <AtlasColumnCanvas
                        column={column}
                        layout={layoutColumn}
                        styleOf={styleOf}
                        activeToken={position}
                        colorScheme={presentation.colorScheme}
                      />
                    </div>
                  ) : (
                    <div
                      className="reader-atlas-rail reader-atlas-rail-placeholder"
                      aria-hidden="true"
                      style={{ blockSize: layoutColumn.plotHeight }}
                    >
                      <span
                        className="reader-atlas-extent"
                        style={{ blockSize: layoutColumn.railHeight }}
                      />
                    </div>
                  )
                ) : (
                  <div className="reader-atlas-unavailable" style={{ blockSize: layoutColumn.plotHeight }}>
                    {column.status === 'empty' ? 'empty text' : 'extent unavailable'}
                  </div>
                )}
                <footer>
                  <span>{column.tokenCount === null ? 'unknown tokens' : counted(column.tokenCount, 'token')}</span>
                  {details.coarse.map((message) => <span key={message} className="reader-atlas-coarse">{message}</span>)}
                  <span className="visually-hidden">{details.description}</span>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}
