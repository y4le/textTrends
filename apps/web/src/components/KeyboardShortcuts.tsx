import type { ShortcutHelpContext } from '../lib/shortcuts.ts';
import {
  shortcutAria,
  shortcutHelpSections,
  shortcutMatches,
} from '../lib/shortcuts.ts';
import { UtilityPane } from './UtilityPane.tsx';

export function KeyboardShortcuts({
  context,
  onClose,
}: {
  readonly context: ShortcutHelpContext;
  readonly onClose: () => void;
}) {
  const sections = shortcutHelpSections(context);
  return (
    <UtilityPane
      title="Keyboard shortcuts"
      subtitle="Vim keys and conventional keys work together. Shortcuts follow focus; typing fields keep their normal keys. Touch gestures are listed below. Press ? again to close."
      focusKey={context}
      closeKeyshortcuts={shortcutAria(['reader-close', 'show-help'])}
      className="shortcut-help"
      onClose={onClose}
      onKeyDown={(event) => {
        if (!shortcutMatches(event, 'show-help')) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="shortcut-help-sections">
        {sections.map((section) => (
          <section key={section.title} aria-labelledby={`shortcut-help-${section.title.toLowerCase().replaceAll(' ', '-')}`}>
            <h3 id={`shortcut-help-${section.title.toLowerCase().replaceAll(' ', '-')}`}>
              {section.title}
            </h3>
            <dl className="shortcut-help-list">
              {section.entries.map((entry) => (
                <div key={entry.id}>
                  <dt>{entry.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
                  <dd>{entry.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section aria-labelledby="shortcut-help-touch-gestures">
          <h3 id="shortcut-help-touch-gestures">Touch gestures</h3>
          <dl className="shortcut-help-list">
            {context === 'workbench' ? (
              <>
                <div>
                  <dt><span className="shortcut-help-gesture">Trends</span></dt>
                  <dd>
                    Drag one finger to read. Press and hold a range start, then tap
                    its end; two fingers select the same range directly.
                  </dd>
                </div>
                <div>
                  <dt><span className="shortcut-help-gesture">Footer</span></dt>
                  <dd>Tap or drag horizontally to read; drag vertically to scroll.</dd>
                </div>
                <div>
                  <dt><span className="shortcut-help-gesture">Terms</span></dt>
                  <dd>Drag a term only from its reorder handle.</dd>
                </div>
              </>
            ) : (
              <div>
                <dt><span className="shortcut-help-gesture">Reader</span></dt>
                <dd>
                  Tap a page edge to turn; drag vertically to scroll or select text.
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </UtilityPane>
  );
}
