export const GUIDE_INVITATION_START_ID = 'guide-invitation-start';

export function GuideInvitation({
  starting,
  onStart,
  onDismiss,
}: {
  readonly starting: boolean;
  readonly onStart: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <aside className="guide-invitation" aria-label="Guided tour invitation">
      <p>
        <strong>New to textTrends?</strong>{' '}
        Follow one shown term from the chart into its source and back — about a minute.
      </p>
      <div>
        <button
          id={GUIDE_INVITATION_START_ID}
          type="button"
          aria-haspopup="dialog"
          disabled={starting}
          onClick={onStart}
        >
          {starting ? 'Starting…' : 'Start'}
        </button>
        <button type="button" disabled={starting} onClick={onDismiss}>Not now</button>
      </div>
    </aside>
  );
}
