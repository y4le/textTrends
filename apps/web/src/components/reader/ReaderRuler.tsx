import { readerCursorToken } from '../../lib/reader-intent.ts';
import {
  adjacentReadableDocumentAtRelativePosition,
  readyReaderDocumentOrder,
} from '../../lib/reader-order.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';
import { useApp } from '../../lib/store-instance.ts';

function percentAt(token: number, tokenCount: number): number {
  if (tokenCount <= 1) return 0;
  return Math.round((Math.max(0, Math.min(tokenCount - 1, token)) / (tokenCount - 1)) * 100);
}

export function ReaderRuler() {
  const place = useApp((state) => state.readerPlace);
  const scale = useApp((state) => state.readerScale);
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const tokenCounts = useApp((state) => state.corpusTokenCounts);
  const scrub = useApp((state) => state.scrub);
  const stepDocument = useApp((state) => state.stepReaderDocument);
  if (place === null || snapshot === null || scale !== 'read') return null;

  const order = readyReaderDocumentOrder(project?.data.order, snapshot.readyDocs);
  if (order.length < 2) return null;
  const activeIndex = order.indexOf(place.doc);
  const activeToken = scrub?.doc === place.doc
    ? scrub.token
    : readerCursorToken(place.cursor);
  const tokenCount = tokenCounts.get(place.doc);
  const countOf = (doc: string) => tokenCounts.get(doc);
  const previous = adjacentReadableDocumentAtRelativePosition(
    order, place.doc, -1, activeToken, countOf,
  );
  const next = adjacentReadableDocumentAtRelativePosition(
    order, place.doc, 1, activeToken, countOf,
  );
  const titleOf = (doc: string) =>
    project?.data.docs.find((entry) => entry.doc === doc)?.meta.title ?? doc;
  const title = titleOf(place.doc);
  const percent = tokenCount === undefined || tokenCount < 1
    ? null
    : percentAt(activeToken, tokenCount);

  return (
    <nav className="reader-ruler" aria-label="Text navigation" data-reader-scale="read">
      <button
        type="button"
        className="reader-ruler-previous"
        aria-label={previous ? `Previous text: ${titleOf(previous.doc)}` : 'At first readable text'}
        aria-keyshortcuts={shortcutAria(['reader-text-previous'])}
        disabled={previous === null}
        onClick={() => stepDocument(-1)}
      >
        <span aria-hidden="true">←</span>{' '}
        <span className="reader-ruler-button-label">previous text</span>
      </button>
      <div className="reader-ruler-current">
        <span className="reader-ruler-ordinal">
          text {Math.max(1, activeIndex + 1).toLocaleString()} of {order.length.toLocaleString()}
        </span>
        <strong title={title}>{title}</strong>
        <span className="reader-ruler-meta">
          {tokenCount === undefined || tokenCount < 1
            ? 'position unavailable'
            : `token ${Math.min(tokenCount, activeToken + 1).toLocaleString()} of ${tokenCount.toLocaleString()} · ${percent}%`}
        </span>
        {percent !== null && (
          <span
            className="reader-ruler-progress"
            role="progressbar"
            aria-label={`Position in ${title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ inlineSize: `${percent}%` }} />
          </span>
        )}
      </div>
      <button
        type="button"
        className="reader-ruler-next"
        aria-label={next ? `Next text: ${titleOf(next.doc)}` : 'At last readable text'}
        aria-keyshortcuts={shortcutAria(['reader-text-next'])}
        disabled={next === null}
        onClick={() => stepDocument(1)}
      >
        <span className="reader-ruler-button-label">next text</span>{' '}
        <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}
