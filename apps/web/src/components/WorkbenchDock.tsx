import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { dockSizing } from '../lib/footer-metrics.ts';
import { shortcutAria } from '../lib/shortcuts.ts';
import { useApp } from '../lib/store-instance.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { FindBar } from './FindBar.tsx';

const QuerySurface = lazy(() =>
  import('./QuerySurface.tsx').then(({ QuerySurface: surface }) => ({ default: surface })),
);
const WorkbenchFooter = lazy(() =>
  import('./WorkbenchFooter.tsx').then(({ WorkbenchFooter: footer }) => ({ default: footer })),
);

function TermsRailFallback() {
  return (
    <aside className="query-region term-bar" aria-label="Terms">
      <strong className="term-bar-label">Terms</strong>
      <p className="region-placeholder">loading Terms…</p>
    </aside>
  );
}

/** Fixed layout host for the authored query state and transient reading
 * instrument. The two named asides remain independent accessibility regions;
 * this wrapper owns only viewport placement and the pre-mount reservation. */
export function WorkbenchDock({ globalShortcuts, onCloseFind }: {
  readonly globalShortcuts: boolean;
  readonly onCloseFind: () => void;
}) {
  const presentation = usePresentation();
  const seriesCount = useApp((state) => state.series.length);
  const interaction = useApp((state) => state.interaction);
  const snapshot = useApp((state) => state.snapshot);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const documentCount = useApp(
    (state) => state.projectSession?.project.data.docs.length ?? 0,
  );
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [targetBlockSize, setTargetBlockSize] = useState<number | null>(null);
  const [availableBlockSize, setAvailableBlockSize] = useState(() => window.innerHeight);
  const [resizing, setResizing] = useState(false);
  const footerPresent = documentCount > 0;
  const footerVisible = snapshot !== null
    && snapshot.readyDocs.length > 0
    && snapshot.readyDocs.some((doc) => (corpusTokenCounts.get(doc) ?? 0) > 0);
  const displayedTrackCount = interaction.kind === 'find'
    ? interaction.find === null ? 0 : 1
    : seriesCount;
  const sizing = dockSizing({
    width: presentation.width,
    coarse: presentation.coarseAvailable,
    trackCount: displayedTrackCount,
    footerPresent,
    targetBlockSize,
    availableBlockSize,
  });
  const sizingRef = useRef(sizing);
  sizingRef.current = sizing;
  const targetRef = useRef(targetBlockSize);
  targetRef.current = targetBlockSize;
  const resizeFrame = useRef<number | null>(null);
  const pendingTarget = useRef<number | null>(null);
  const resizeDrag = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startBlockSize: number;
    readonly startTarget: number | null;
  } | null>(null);

  const measureAvailable = useCallback(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const headerBottom = document.querySelector<HTMLElement>('.app-header')
      ?.getBoundingClientRect().bottom ?? 0;
    const dockBottomGap = Math.max(
      0,
      window.innerHeight - dock.getBoundingClientRect().bottom,
    );
    setAvailableBlockSize(Math.max(
      0,
      Math.floor(window.innerHeight - dockBottomGap - headerBottom),
    ));
  }, []);

  useLayoutEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        measureAvailable();
      });
    };
    const visual = window.visualViewport;
    window.addEventListener('resize', schedule);
    visual?.addEventListener('resize', schedule);
    visual?.addEventListener('scroll', schedule);
    measureAvailable();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      visual?.removeEventListener('resize', schedule);
      visual?.removeEventListener('scroll', schedule);
    };
  }, [measureAvailable]);

  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--dock-block-size', `${sizing.blockSize}px`);
    root.setProperty('--terms-rail-block-size', `${sizing.railBlockSize}px`);
    root.setProperty('--terms-rail-pad-block', `${sizing.railPadBlock}px`);
    root.setProperty('--term-target-block-size', `${sizing.termTargetBlockSize}px`);
    root.setProperty('--footer-block-size', `${sizing.footerBlockSize}px`);
    return () => {
      root.removeProperty('--dock-block-size');
      root.removeProperty('--terms-rail-block-size');
      root.removeProperty('--terms-rail-pad-block');
      root.removeProperty('--term-target-block-size');
      root.removeProperty('--footer-block-size');
    };
  }, [sizing]);

  useEffect(() => () => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    document.documentElement.removeAttribute('data-footer-resizing');
  }, []);

  const setResizeActive = (active: boolean) => {
    setResizing(active);
    if (active) document.documentElement.setAttribute('data-footer-resizing', 'true');
    else document.documentElement.removeAttribute('data-footer-resizing');
  };

  const commitPendingTarget = () => {
    if (resizeFrame.current !== null) {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = null;
    }
    if (pendingTarget.current !== null) {
      setTargetBlockSize(pendingTarget.current);
      pendingTarget.current = null;
    }
  };

  const scheduleTarget = (next: number) => {
    pendingTarget.current = next;
    resizeFrame.current ??= requestAnimationFrame(() => {
      resizeFrame.current = null;
      const pending = pendingTarget.current;
      pendingTarget.current = null;
      if (pending !== null) setTargetBlockSize(pending);
    });
  };

  const finishResize = (pointerId: number) => {
    if (resizeDrag.current?.pointerId !== pointerId) return;
    commitPendingTarget();
    resizeDrag.current = null;
    setResizeActive(false);
  };

  const resizeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowUp' || event.key === 'PageUp'
      ? 1
      : event.key === 'ArrowDown' || event.key === 'PageDown'
        ? -1
        : 0;
    if (
      direction === 0
      && !['Home', 'End', 'Enter', 'Escape'].includes(event.key)
    ) return;
    if (event.key === 'Escape' && resizeDrag.current === null) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      const drag = resizeDrag.current;
      if (drag) {
        pendingTarget.current = null;
        if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
        resizeFrame.current = null;
        setTargetBlockSize(drag.startTarget);
        resizeDrag.current = null;
        setResizeActive(false);
      }
      return;
    }
    if (event.key === 'Enter') {
      setTargetBlockSize(null);
      return;
    }
    const current = sizingRef.current;
    const step = event.shiftKey
      ? 1
      : event.key === 'PageUp' || event.key === 'PageDown'
        ? 64
        : 16;
    setTargetBlockSize(event.key === 'Home'
      ? current.minBlockSize
      : event.key === 'End'
        ? current.maxBlockSize
        : Math.max(
            current.minBlockSize,
            Math.min(current.maxBlockSize, current.blockSize + direction * step),
          ));
  };

  const laneText = [
    interaction.kind === 'find' ? 'find' : 'terms',
    footerVisible ? 'passage' : '',
    footerVisible && sizing.showStatus ? 'status' : '',
    footerVisible ? 'graph' : '',
    footerVisible && sizing.showBarcode ? 'occurrences' : '',
  ].filter(Boolean).join(', ');

  return (
    <div
      id="workbench-dock"
      ref={dockRef}
      className="workbench-dock"
      data-terms-compressed={sizing.blockSize < sizing.baseBlockSize || undefined}
      style={{
        '--dock-local-block-size': `${sizing.blockSize}px`,
        '--terms-local-block-size': `${sizing.railBlockSize}px`,
      } as CSSProperties}
    >
      {footerVisible && (
        <div
          className="footer-resize-handle"
          role="separator"
          aria-label="Resize reading footer"
          aria-orientation="horizontal"
          aria-controls="workbench-dock"
          aria-valuemin={sizing.minBlockSize}
          aria-valuemax={sizing.maxBlockSize}
          aria-valuenow={sizing.blockSize}
          aria-valuetext={`${sizing.blockSize} pixels · ${laneText}`}
          aria-keyshortcuts={shortcutAria([
            'dock-resize-step',
            'dock-resize-fine',
            'dock-resize-page',
            'dock-resize-limits',
            'dock-resize-reset',
          ])}
          tabIndex={0}
          data-resizing={resizing || undefined}
          onFocus={measureAvailable}
          onDoubleClick={() => { setTargetBlockSize(null); }}
          onKeyDown={resizeByKeyboard}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
            event.preventDefault();
            event.currentTarget.focus();
            measureAvailable();
            resizeDrag.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startBlockSize: sizingRef.current.blockSize,
              startTarget: targetRef.current,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizeActive(true);
          }}
          onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
            const drag = resizeDrag.current;
            if (drag?.pointerId !== event.pointerId) return;
            event.preventDefault();
            const current = sizingRef.current;
            const next = drag.startBlockSize + drag.startY - event.clientY;
            scheduleTarget(Math.max(
              current.minBlockSize,
              Math.min(current.maxBlockSize, Math.round(next)),
            ));
          }}
          onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            finishResize(event.pointerId);
          }}
          onPointerCancel={(event) => { finishResize(event.pointerId); }}
          onLostPointerCapture={(event) => { finishResize(event.pointerId); }}
        >
          <span aria-hidden="true" />
        </div>
      )}
      {interaction.kind === 'find'
        ? <FindBar placement="rail" onClose={onCloseFind} />
        : (
            <Suspense fallback={<TermsRailFallback />}>
              <QuerySurface />
            </Suspense>
          )}
      <Suspense fallback={null}>
        <WorkbenchFooter
          globalShortcuts={globalShortcuts}
          geometry={sizing.footerGeometry}
          blockSize={sizing.footerBlockSize}
          trackCount={displayedTrackCount}
          showStatus={sizing.showStatus}
          showBarcode={sizing.showBarcode}
        />
      </Suspense>
    </div>
  );
}
