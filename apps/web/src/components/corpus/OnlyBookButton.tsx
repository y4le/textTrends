import { useApp } from '../../lib/store-instance.ts';
import { fullTokensByDoc } from '../../lib/doc-tokens.ts';
import { isWholeBookSelection } from '../../lib/corpus-view.ts';

export function OnlyBookButton({
  doc,
  onMessage,
}: {
  readonly doc: string;
  readonly onMessage: (message: string | null) => void;
}) {
  const inventory = useApp((s) => s.inventory);
  const trends = useApp((s) => s.trends);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const fullTokens = fullTokensByDoc(doc, { inventory, trends });
  const unavailable = fullTokens === null || snapshot === null;
  const isOnlyThisBook = fullTokens !== null
    && isWholeBookSelection(linkedSelection, doc, fullTokens);

  return (
    <button
      className="coarse-target"
      type="button"
      aria-disabled={unavailable ? true : undefined}
      title={unavailable
        ? 'The full token extent is not available yet.'
        : isOnlyThisBook
          ? 'Restore analysis scope to all ready books.'
          : 'Use this whole book as the linked analysis scope.'}
      onClick={() => {
        if (snapshot === null || fullTokens === null) {
          onMessage('The full token extent is not available yet.');
          return;
        }
        onMessage(null);
        setLinkedSelection(isOnlyThisBook
          ? null
          : {
              snapshot: snapshot.snapshot,
              doc,
              tokens: { start: 0, end: fullTokens },
            });
      }}
    >
      {isOnlyThisBook ? 'all books' : 'only this book'}
    </button>
  );
}
