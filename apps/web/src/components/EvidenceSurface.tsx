import { PinButton } from './PinButton.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import {
  evidenceSurfaceView,
  type EvidenceSurfaceVM,
} from '../lib/evidence-surface.ts';
import { pinCapacity } from '../lib/pin-capacity.ts';
import { useApp } from '../lib/store-instance.ts';

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
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const pins = useApp((state) => state.pins);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const pinPassage = useApp((state) => state.pinPassage);
  const openReader = useApp((state) => state.openReader);
  const setPlace = useApp((state) => state.setPlace);
  const readerOpen = useApp((state) => state.readerPlace !== null);

  // Compact Reader is the one full-viewport evidence owner. Keeping the
  // fixed Evidence line mounted would cover its prose and duplicate actions.
  if (readerOpen && presentation.width === 'compact') return null;

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

  return (
    <aside className="evidence-region" aria-label="Evidence">
      <div className="evidence-heading">
        <strong className="region-label">Evidence</strong>
        <span>{capacity.label}</span>
      </div>
      <div className="evidence-current">
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
                type="button"
                onClick={() => setPlace('findings')}
                style={SMALL_BUTTON_STYLE}
              >
                manage pins
              </button>
            )}
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
