import { lazy, Suspense, useEffect, useRef } from 'react';
import { PinButton } from './PinButton.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { SheetFrame } from './SheetFrame.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import {
  evidenceSurfaceView,
  type EvidenceSurfaceVM,
} from '../lib/evidence-surface.ts';
import { pinCapacity } from '../lib/pin-capacity.ts';
import { sheetDetent, sheetSurface, type SheetSurface } from '../lib/sheet.ts';
import { useApp } from '../lib/store-instance.ts';

const ComparisonOccurrences = lazy(() =>
  import('./evidence/ComparisonOccurrences.tsx').then(
    ({ ComparisonOccurrences: occurrences }) => ({ default: occurrences }),
  ),
);

function CurrentPassage({ view }: { readonly view: EvidenceSurfaceVM }) {
  if (view.kind === 'empty') {
    return <p className="evidence-empty">{view.message}</p>;
  }
  return (
    <>
      <p className="evidence-caption">{view.caption}</p>
      {view.kind === 'loading'
        ? <p className="evidence-empty">loading passage…</p>
        : (
            <p
              className="evidence-excerpt"
              title={view.truncated ? 'Passage clipped at the character safety limit.' : undefined}
            >
              <span>{view.text.slice(0, view.anchorCharsUtf16.start)}</span>
              <strong>{view.text.slice(
                view.anchorCharsUtf16.start,
                view.anchorCharsUtf16.end,
              )}</strong>
              <span>{view.text.slice(view.anchorCharsUtf16.end)}</span>
            </p>
          )}
    </>
  );
}

export function EvidenceSurface() {
  const presentation = usePresentation();
  const scrub = useApp((state) => state.scrub);
  const passage = useApp((state) => state.passage);
  const snapshot = useApp((state) => state.snapshot);
  const comparisonEvidence = useApp((state) => state.keynessEvidence);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const pins = useApp((state) => state.pins);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const pinPassage = useApp((state) => state.pinPassage);
  const openReader = useApp((state) => state.openReader);
  const setPlace = useApp((state) => state.setPlace);
  const layers = useApp((state) => state.layers);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const setLayerUI = useApp((state) => state.setLayerUI);
  const popLayer = useApp((state) => state.popLayer);
  const topLayer = layers.at(-1);
  const activeSheet = sheetSurface(topLayer);
  const previousWidth = useRef(presentation.width);

  useEffect(() => {
    const movedToWide = previousWidth.current !== 'wide' && presentation.width === 'wide';
    previousWidth.current = presentation.width;
    if (!movedToWide || activeSheet !== 'evidence') return undefined;
    const frame = requestAnimationFrame(() => {
      document.getElementById('evidence-region')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSheet, presentation.width]);

  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((entry) => [entry.doc, entry.meta.title]),
  );
  const tokenCount = scrub === null
    ? null
    : fullTokensByDoc(scrub.doc, { inventory, trends });
  const view = evidenceSurfaceView({
    scrub,
    passage,
    snapshot: snapshot?.snapshot ?? null,
    titleByDoc,
    tokenCount,
  });
  const capacity = pinCapacity(pins.length);
  const recent = [...pins].slice(-3).reverse();
  const detent = sheetDetent(topLayer);
  const sheetEnabled = presentation.width !== 'wide';
  const showEvidenceSheet = sheetEnabled && activeSheet === 'evidence';

  const openSheet = (surface: SheetSurface, returnFocusTo: string) => {
    if (topLayer?.kind === 'sheet') {
      replaceLayer('sheet', Object.freeze({ surface }), returnFocusTo, { detent });
    } else {
      pushLayer('sheet', Object.freeze({ surface }), returnFocusTo, { detent: 'peek' });
    }
  };

  const body = (
    <>
      {comparisonEvidence !== null
        && snapshot !== null
        && comparisonEvidence.snapshot === snapshot.snapshot
        && (
          <Suspense fallback={<p className="evidence-empty">loading comparison evidence…</p>}>
            <ComparisonOccurrences />
          </Suspense>
        )}
      <CurrentPassage view={view} />
      {view.kind !== 'empty' && snapshot !== null && (
        <div className="evidence-actions">
          <PinButton
            capacity={capacity}
            label={`Pin passage at token ${(view.token + 1).toLocaleString()}`}
            onPin={() => pinPassage(view.doc, view.token)}
          />
          <button
            id="evidence-read"
            className="coarse-target"
            type="button"
            aria-label="Open passage in reader"
            onClick={() => openReader(
              {
                snapshot: snapshot.snapshot,
                doc: view.doc,
                token: view.token,
                from: 'passage',
              },
              'evidence-read',
            )}
            style={SMALL_BUTTON_STYLE}
          >
            Read
          </button>
          {!capacity.enabled && (
            <button
              className="coarse-target"
              type="button"
              onClick={() => setPlace('findings')}
              style={SMALL_BUTTON_STYLE}
            >
              manage pins
            </button>
          )}
        </div>
      )}
    </>
  );

  if (showEvidenceSheet && topLayer?.kind === 'sheet') {
    return (
      <SheetFrame
        title="Evidence"
        detent={detent}
        compact={presentation.width === 'compact'}
        onDetent={(next) => setLayerUI(topLayer.id, { detent: next })}
        onClose={popLayer}
      >
        <div className="sheet-surface-switch">
          <span>{capacity.label}</span>
          <button
            id="method-open"
            type="button"
            onClick={() => openSheet('method', 'method-open')}
          >
            Method
          </button>
        </div>
        {body}
      </SheetFrame>
    );
  }

  // A non-wide Method sheet replaces Evidence rather than stacking over it.
  if (sheetEnabled && activeSheet === 'method') return null;

  return (
    <aside
      id="evidence-region"
      className="evidence-region"
      aria-label="Evidence"
      tabIndex={-1}
    >
      <div className="evidence-heading">
        <strong className="region-label">Evidence</strong>
        <span>{capacity.label}</span>
      </div>
      <div className="evidence-current">
        {body}
        {sheetEnabled && (
          <div className="evidence-inspect-actions">
            <button
              id="evidence-more"
              type="button"
              onClick={() => openSheet('evidence', 'evidence-more')}
            >
              More evidence
            </button>
            <button
              id="method-open"
              type="button"
              onClick={() => openSheet('method', 'method-open')}
            >
              Method
            </button>
          </div>
        )}
      </div>
      {recent.length > 0 && (
        <div className="evidence-recent">
          <strong>Recent retained evidence</strong>
          <ol>
            {recent.map((pin) => (
              <li key={pin.id}>
                {(titleByDoc.get(pin.anchor.doc) ?? pin.anchor.doc)}
                {' · token '}
                {(pin.anchor.token + 1).toLocaleString()}
                {pin.kind === 'pending' ? ' · capturing' : ''}
                {pin.kind === 'error' ? ' · capture failed' : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}
