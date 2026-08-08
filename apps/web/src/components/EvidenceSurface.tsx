import { lazy, Suspense } from 'react';
import { PinButton } from './PinButton.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { SheetFrame } from './SheetFrame.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import { evidenceSurfaceView, type EvidenceSurfaceVM } from '../lib/evidence-surface.ts';
import { pinCapacity } from '../lib/pin-capacity.ts';
import { sheetDetent, sheetSurface, type SheetSurface } from '../lib/sheet.ts';
import { useApp } from '../lib/store-instance.ts';

const ComparisonOccurrences = lazy(() =>
  import('./evidence/ComparisonOccurrences.tsx').then(
    ({ ComparisonOccurrences: occurrences }) => ({ default: occurrences }),
  ),
);

function CurrentPassage({ view }: { readonly view: EvidenceSurfaceVM }) {
  if (view.kind === 'empty') return <p className="evidence-empty">{view.message}</p>;
  return (
    <>
      <p className="evidence-caption">{view.caption}</p>
      {view.kind === 'loading'
        ? <p className="evidence-empty">loading passage…</p>
        : (
            <p
              className="evidence-excerpt source-text"
              title={view.truncated ? 'Passage clipped at the character safety limit.' : undefined}
            >
              <span>{view.text.slice(0, view.anchorCharsUtf16.start)}</span>
              <strong>{view.text.slice(view.anchorCharsUtf16.start, view.anchorCharsUtf16.end)}</strong>
              <span>{view.text.slice(view.anchorCharsUtf16.end)}</span>
            </p>
          )}
    </>
  );
}

export function EvidenceSurface() {
  const presentation = usePresentation();
  const place = useApp((state) => state.place);
  const scrub = useApp((state) => state.scrub);
  const passage = useApp((state) => state.passage);
  const snapshot = useApp((state) => state.snapshot);
  const comparisonEvidence = useApp((state) => state.keynessEvidence);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const pins = useApp((state) => state.pins);
  const pinError = useApp((state) => state.pinError);
  const pinAnnouncement = useApp((state) => state.pinAnnouncement);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const pinPassage = useApp((state) => state.pinPassage);
  const openReader = useApp((state) => state.openReader);
  const setPlace = useApp((state) => state.setPlace);
  const clearPinFeedback = useApp((state) => state.clearPinFeedback);
  const pinFeedbackOrigin = useApp((state) => state.pinFeedbackOrigin);
  const layers = useApp((state) => state.layers);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const setLayerUI = useApp((state) => state.setLayerUI);
  const popLayer = useApp((state) => state.popLayer);
  const topLayer = layers.at(-1);
  const activeSheet = sheetSurface(topLayer);
  const detent = sheetDetent(topLayer);

  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((entry) => [entry.doc, entry.meta.title]),
  );
  const tokenCount = scrub === null
    ? null
    : fullTokensByDoc(scrub.doc, { corpusTokenCounts, inventory, trends });
  const view = evidenceSurfaceView({
    scrub,
    passage,
    snapshot: snapshot?.snapshot ?? null,
    titleByDoc,
    tokenCount,
  });
  const capacity = pinCapacity(pins.length);
  const comparisonLive = comparisonEvidence !== null
    && snapshot !== null
    && comparisonEvidence.snapshot === snapshot.snapshot;
  const hasEvidence = view.kind !== 'empty' || comparisonLive;
  const methodLabel = place === 'trends' ? 'Method & settings' : 'Method';

  const openSheet = (surface: SheetSurface, returnFocusTo: string) => {
    if (topLayer?.kind === 'sheet') {
      replaceLayer('sheet', Object.freeze({ surface }), topLayer.returnFocusTo, { detent });
    } else {
      pushLayer('sheet', Object.freeze({ surface }), returnFocusTo, { detent: 'half' });
    }
  };

  const saveAction = view.kind !== 'empty' && snapshot !== null && (
    <PinButton
      capacity={capacity}
      label={`Save excerpt at token ${(view.token + 1).toLocaleString()} to Findings`}
      onPin={() => pinPassage(view.doc, view.token, 'evidence')}
    />
  );
  const readAction = view.kind !== 'empty' && snapshot !== null && (
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
  );
  const capacityAction = view.kind !== 'empty'
    && snapshot !== null
    && !capacity.enabled
    && (
      <button className="coarse-target" type="button" onClick={() => setPlace('findings')} style={SMALL_BUTTON_STYLE}>
        Open Findings
      </button>
    );
  const passageActions = view.kind !== 'empty' && snapshot !== null && (
    <div className="evidence-actions">
      {saveAction}
      {readAction}
      {capacityAction}
    </div>
  );
  const pinFeedback = pinFeedbackOrigin !== 'evidence'
    ? null
    : pinError
    ? (
        <p className="evidence-feedback" role="alert">
          {pinError}{' '}
          <button type="button" onClick={() => clearPinFeedback('evidence')}>dismiss</button>
        </p>
      )
    : pinAnnouncement
      ? <p className="evidence-feedback" role="status">{pinAnnouncement}</p>
      : null;

  if (activeSheet === 'evidence' && topLayer?.kind === 'sheet') {
    return (
      <SheetFrame
        title="Evidence"
        detent={detent}
        compact={presentation.width === 'compact'}
        onDetent={(next) => setLayerUI(topLayer.id, { detent: next })}
        onClose={popLayer}
      >
        <div className="sheet-surface-switch">
          <span>Current evidence</span>
          <button id="method-open" type="button" onClick={() => openSheet('method', 'method-open')}>
            {methodLabel}
          </button>
        </div>
        {comparisonLive && (
          <Suspense fallback={<p className="evidence-empty">loading comparison evidence…</p>}>
            <ComparisonOccurrences />
          </Suspense>
        )}
        <CurrentPassage view={view} />
        {passageActions}
        {pinFeedback}
      </SheetFrame>
    );
  }

  if (activeSheet === 'method') {
    return pinFeedback === null
      ? null
      : (
          <aside className="evidence-feedback-fallback" aria-label="Evidence feedback">
            {pinFeedback}
          </aside>
        );
  }
  if (!hasEvidence) return null;

  return (
    <aside id="evidence-region" className="evidence-region evidence-strip" aria-label="Evidence">
      <strong className="region-label">Evidence</strong>
      <div className="evidence-strip-body">
        {view.kind === 'empty'
          ? <p className="evidence-caption">Comparison occurrences are ready to inspect.</p>
          : <CurrentPassage view={view} />}
      </div>
      <div className="evidence-strip-actions">
        {view.kind !== 'empty' && snapshot !== null && (
          <div className="evidence-actions">
            {saveAction}
            {presentation.width !== 'compact' && readAction}
            {capacityAction}
          </div>
        )}
        <button id="evidence-more" type="button" onClick={() => openSheet('evidence', 'evidence-more')}>
          Inspect
        </button>
        {presentation.width !== 'compact' && (
          <button
            id="method-open"
            type="button"
            aria-label={`Open ${methodLabel} from Evidence`}
            onClick={() => openSheet('method', 'method-open')}
          >
            Method
          </button>
        )}
      </div>
      {pinFeedback}
    </aside>
  );
}
