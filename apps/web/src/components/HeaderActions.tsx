import { shortcutAria } from '../lib/shortcuts.ts';
import { nextPosition, previousPosition } from '../lib/position-history.ts';
import { useApp } from '../lib/store-instance.ts';

function positionTitle(
  direction: -1 | 1,
  title: string,
  token: number,
  ordinal: number,
  total: number,
): string {
  const way = direction === -1 ? 'Back' : 'Forward';
  return `${way} to ${title} · token ${(token + 1).toLocaleString()} (${ordinal} of ${total})`;
}

export function HeaderActions({
  onOpenFind,
  onOpenSettings,
  onOpenHelp,
  onStepPositionHistory,
}: {
  readonly onOpenFind: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHelp: () => void;
  readonly onStepPositionHistory: (direction: -1 | 1) => void;
}) {
  const history = useApp((state) => state.positionHistory);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((document) => [document.doc, document.meta.title] as const),
  );
  const previous = previousPosition(history);
  const next = nextPosition(history);
  const titleFor = (doc: string) => titleByDoc.get(doc) ?? doc;

  return (
    <nav className="header-actions" aria-label="Application tools">
      <div className="position-history-actions" role="group" aria-label="Reading position history">
        <button
          className="header-action position-history-action coarse-target"
          type="button"
          aria-label="Previous reading position"
          aria-keyshortcuts={shortcutAria(['position-previous'])}
          title={previous
            ? positionTitle(
                -1,
                titleFor(previous.doc),
                previous.token,
                history.index,
                history.entries.length,
              )
            : 'No previous reading position'}
          disabled={previous === null}
          onClick={() => onStepPositionHistory(-1)}
        >
          <span aria-hidden="true">↶</span>
        </button>
        <button
          className="header-action position-history-action coarse-target"
          type="button"
          aria-label="Next reading position"
          aria-keyshortcuts={shortcutAria(['position-next'])}
          title={next
            ? positionTitle(
                1,
                titleFor(next.doc),
                next.token,
                history.index + 2,
                history.entries.length,
              )
            : 'No next reading position'}
          disabled={next === null}
          onClick={() => onStepPositionHistory(1)}
        >
          <span aria-hidden="true">↷</span>
        </button>
      </div>
      <button
        id="global-find-open"
        className="header-action coarse-target"
        type="button"
        onClick={onOpenFind}
      >
        Find
      </button>
      <button
        id="global-settings-open"
        className="header-action coarse-target"
        type="button"
        onClick={onOpenSettings}
      >
        Settings
      </button>
      <button
        id="global-help-open"
        className="header-action coarse-target"
        type="button"
        aria-keyshortcuts={shortcutAria(['show-help'])}
        onClick={onOpenHelp}
      >
        Help
      </button>
    </nav>
  );
}
