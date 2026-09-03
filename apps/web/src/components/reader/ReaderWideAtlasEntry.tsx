import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { atlasColumns, atlasLayout } from '../../lib/reader-atlas.ts';
import { readyReaderDocumentOrder } from '../../lib/reader-order.ts';
import type { ReaderProgress } from '../../lib/reader-progress.ts';
import { useApp } from '../../lib/store-instance.ts';
import { projectedBarcodeTracks } from '../../lib/trend-stage.ts';
import { usePresentation } from '../PresentationProvider.tsx';
import {
  atlasColumnDescription,
  ReaderAtlasColumnCanvas,
} from './ReaderAtlasColumn.tsx';
import { ReaderProgressRail, type ReaderSeekPhase } from './ReaderProgressRail.tsx';

export function ReaderWideAtlasEntry({
  progress,
  accessibleName,
  onSeek,
}: {
  readonly progress: ReaderProgress | null;
  readonly accessibleName: string;
  readonly onSeek: (token: number, phase: ReaderSeekPhase) => void;
}) {
  const place = useApp((state) => state.readerPlace);
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const tokenCounts = useApp((state) => state.corpusTokenCounts);
  const series = useApp((state) => state.series);
  const dispersion = useApp((state) => state.dispersion);
  const presentation = usePresentation();
  const entryRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const order = useMemo(
    () => readyReaderDocumentOrder(project?.data.order, snapshot?.readyDocs ?? []),
    [project?.data.order, snapshot?.readyDocs],
  );
  const seriesOrder = useMemo(() => series.map((item) => item.id), [series]);
  const labels = useMemo(
    () => new Map(series.map((item) => [item.id, item.label])),
    [series],
  );
  const styleOf = useMemo(
    () => new Map(series.map((item) => [item.id, item.style])),
    [series],
  );
  const resident = dispersion?.state.status === 'ready'
    && dispersion.snapshot === snapshot?.snapshot
    ? dispersion.state.result
    : null;
  const tracks = useMemo(
    () => series.length === 0
      ? []
      : projectedBarcodeTracks(resident, snapshot?.readyDocs ?? [], seriesOrder),
    [resident, series.length, seriesOrder, snapshot?.readyDocs],
  );
  const columns = useMemo(
    () => atlasColumns(tracks, resident?.geometry ?? null, order, tokenCounts),
    [order, resident?.geometry, tokenCounts, tracks],
  );
  const layout = useMemo(
    () => atlasLayout(columns, 'equal', {
      plotHeight: viewport.height,
      columnWidth: viewport.width,
      columnGap: 0,
    }),
    [columns, viewport.height, viewport.width],
  );
  const activeOrdinal = place === null
    ? -1
    : columns.findIndex((column) => column.doc === place.doc);
  const column = activeOrdinal < 0 ? null : columns[activeOrdinal] ?? null;
  const layoutColumn = activeOrdinal < 0 ? null : layout.columns[activeOrdinal] ?? null;
  const title = place === null
    ? 'Active text'
    : project?.data.docs.find((entry) => entry.doc === place.doc)?.meta.title ?? place.doc;
  const description = column === null || column.status !== 'ready'
    ? `${title}. Atlas entry unavailable.`
    : atlasColumnDescription(column, title, labels);

  useLayoutEffect(() => {
    const entry = entryRef.current;
    if (!entry || typeof ResizeObserver === 'undefined') return undefined;
    const publish = () => setViewport((current) => {
      const next = { width: entry.clientWidth, height: entry.clientHeight };
      return current.width === next.width && current.height === next.height ? current : next;
    });
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(entry);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={entryRef}
      className="reader-wide-atlas-entry"
      data-atlas-entry={place?.doc ?? 'unavailable'}
      data-atlas-normalization="equal"
      data-atlas-status={column?.status ?? 'missing'}
    >
      {column !== null && layoutColumn !== null && column.status === 'ready' ? (
        <div className="reader-wide-atlas-visual" role="img" aria-label={description}>
          <ReaderAtlasColumnCanvas
            column={column}
            layout={layoutColumn}
            styleOf={styleOf}
            activeToken={progress?.token ?? null}
            colorScheme={presentation.colorScheme}
          />
        </div>
      ) : (
        <div className="reader-atlas-unavailable" role="img" aria-label={description}>
          atlas entry unavailable
        </div>
      )}
      {progress !== null && (
        <div
          className="reader-wide-atlas-seek-wrap"
          style={{ blockSize: viewport.height }}
        >
          <ReaderProgressRail
            className="reader-wide-atlas-seek"
            orientation="vertical"
            progress={progress}
            accessibleName={accessibleName}
            onSeek={onSeek}
          />
        </div>
      )}
    </div>
  );
}
