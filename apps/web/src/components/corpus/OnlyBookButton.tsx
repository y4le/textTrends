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
  const corpusTokenCounts = useApp((s) => s.corpusTokenCounts);
  const trends = useApp((s) => s.trends);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const fullTokens = fullTokensByDoc(doc, { corpusTokenCounts, inventory, trends });
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
          ? 'Restore analysis scope to all ready texts.'
          : 'Use this whole text as the linked analysis scope.'}
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
              ranges: [{ doc, tokens: { start: 0, end: fullTokens } }],
            });
      }}
    >
      {isOnlyThisBook ? 'all texts' : 'select this text'}
    </button>
  );
}
