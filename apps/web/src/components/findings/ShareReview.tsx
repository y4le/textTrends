import {
  SHARE_REPLACE_SURVIVORS,
  type ShareDraftReview,
} from '../../lib/findings-view.ts';

export function ShareReview({
  draft,
  review,
  onDraft,
  onCancel,
  onReplace,
}: {
  readonly draft: string;
  readonly review: ShareDraftReview;
  readonly onDraft: (value: string) => void;
  readonly onCancel: () => void;
  readonly onReplace: () => void;
}) {
  return (
    <form
      className="share-review-form"
      aria-label="Review shared state"
      onSubmit={(event) => {
        event.preventDefault();
        if (review.status === 'ready') onReplace();
      }}
    >
      <header>
        <p className="findings-kicker">Incoming shared state</p>
        <h2>Review before replacing</h2>
      </header>
      <label className="findings-share-field">
        textTrends share link
        <textarea
          className="exact-input"
          aria-label="Share link to import"
          value={draft}
          rows={4}
          onChange={(event) => onDraft(event.currentTarget.value)}
          placeholder="paste a textTrends share link"
        />
      </label>
      {review.status === 'empty' && (
        <p className="findings-record-note">Paste a share link to review it.</p>
      )}
      {review.status === 'invalid' && (
        <p className="findings-record-error" role="alert">
          Invalid share link: {review.message}
        </p>
      )}
      {review.status === 'ready' && (
        <div className="share-review-summary">
          <dl>
            <div><dt>notebook groups</dt><dd>{review.groups}</dd></div>
            <div><dt>referenced documents</dt><dd>{review.documents}</dd></div>
            <div><dt>saved anchors</dt><dd>{review.anchors}</dd></div>
            <div><dt>matched here</dt><dd>{review.matchedDocuments}</dd></div>
          </dl>
          {review.unmatchedDocuments.length > 0
            ? (
                <p role="note">
                  Unmatched documents: {review.unmatchedDocuments.join(', ')}.
                  Their anchors will not be imported.
                </p>
              )
            : <p role="note">Every referenced document matches this corpus.</p>}
          <p>{SHARE_REPLACE_SURVIVORS}</p>
          <p className="findings-record-note">
            Source text and pinned excerpts are not carried by the link.
          </p>
        </div>
      )}
      <div className="form-layer-actions share-review-actions">
        <button type="button" onClick={onCancel}>cancel</button>
        <button type="submit" disabled={review.status !== 'ready'}>
          replace with this shared state
        </button>
      </div>
    </form>
  );
}
