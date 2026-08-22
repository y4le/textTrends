import { Fragment } from 'react';
import type { ShortcutHelpContext } from '../lib/shortcuts.ts';
import {
  isShortcutTypingTarget,
  shortcutAria,
  shortcutHelpSections,
  shortcutMatches,
} from '../lib/shortcuts.ts';
import type { Place } from '../lib/places.ts';
import { useApp } from '../lib/store-instance.ts';
import { UtilityPane } from './UtilityPane.tsx';

const KEY_ACCESSIBLE_NAME: Readonly<Record<string, string>> = Object.freeze({
  '←': 'Left arrow',
  '→': 'Right arrow',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
});

export function KeyboardShortcuts({
  context,
  place,
  onFind,
  onDebug,
  onClose,
}: {
  readonly context: ShortcutHelpContext;
  readonly place: Place;
  readonly onFind: () => void;
  readonly onDebug: () => void;
  readonly onClose: () => void;
}) {
  const activeTextCount = useApp(
    (state) => state.projectSession?.project.data.order.length ?? 0,
  );
  const footerAvailable = useApp((state) => state.snapshot !== null
    && state.snapshot.readyDocs.length > 0
    && state.snapshot.readyDocs.some((doc) =>
      (state.corpusTokenCounts.get(doc) ?? 0) > 0));
  const sections = shortcutHelpSections(context !== 'workbench'
    ? { context }
    : { context, place, activeTextCount, footerAvailable });
  return (
    <UtilityPane
      title="Keyboard shortcuts"
      focusKey={`${context}:${place}`}
      className="shortcut-help-pane"
      layerClassName="shortcut-help-layer"
      compactClose
      closeOnBackdrop
      closeKeyshortcuts={shortcutAria(['reader-close', 'show-help'])}
      onClose={onClose}
      onKeyDown={(event) => {
        if (isShortcutTypingTarget(event.target)) return;
        if (shortcutMatches(event, 'show-help')) {
          event.preventDefault();
          onClose();
        } else if (shortcutMatches(event, 'show-debug')) {
          event.preventDefault();
          onDebug();
        }
      }}
    >
      <div className="shortcut-help-sections">
        <section className="shortcut-help-tools" aria-labelledby="shortcut-help-tools">
          <h3 id="shortcut-help-tools">Tools</h3>
          {context !== 'rsvp' && (
            <button
              type="button"
              className="coarse-target"
              aria-keyshortcuts={shortcutAria(['find-open'])}
              onClick={onFind}
            >
              Find in corpus <kbd aria-hidden="true">/</kbd>
            </button>
          )}
          <button
            type="button"
            className="coarse-target"
            aria-keyshortcuts={shortcutAria(['show-debug'])}
            onClick={onDebug}
          >
            Debug <kbd aria-hidden="true">Shift + D</kbd>
          </button>
        </section>
        {sections.map((section) => (
          <section
            className="shortcut-help-section"
            key={section.title}
            aria-labelledby={`shortcut-help-${section.title.toLowerCase().replaceAll(' ', '-')}`}
          >
            <h3 id={`shortcut-help-${section.title.toLowerCase().replaceAll(' ', '-')}`}>
              {section.title}
            </h3>
            <dl className="shortcut-help-list">
              {section.entries.map((entry) => (
                <div key={entry.id}>
                  <dt>
                    {entry.keys.map((key, index) => (
                      <Fragment key={`${key}:${index}`}>
                        {index > 0 && (
                          <span className="shortcut-help-key-separator" aria-hidden="true">/</span>
                        )}
                        <kbd
                          {...(KEY_ACCESSIBLE_NAME[key]
                            ? {
                                'aria-label': KEY_ACCESSIBLE_NAME[key],
                                title: KEY_ACCESSIBLE_NAME[key],
                              }
                            : {})}
                        >
                          {key}
                        </kbd>
                      </Fragment>
                    ))}
                  </dt>
                  <dd>{entry.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </UtilityPane>
  );
}
