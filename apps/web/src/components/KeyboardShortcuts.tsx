import type { ShortcutHelpContext } from '../lib/shortcuts.ts';
import { shortcutAria, shortcutHelpSections } from '../lib/shortcuts.ts';
import { FormLayer } from './FormLayer.tsx';

export function KeyboardShortcuts({
  context,
  onClose,
}: {
  readonly context: ShortcutHelpContext;
  readonly onClose: () => void;
}) {
  const sections = shortcutHelpSections(context);
  return (
    <FormLayer label="Keyboard shortcuts" focusKey={context} onClose={onClose}>
      <div className="shortcut-help">
        <header className="shortcut-help-header">
          <div>
            <h2>Keyboard shortcuts</h2>
            <p>
              Vim keys and conventional keys work together. Shortcuts follow focus;
              typing fields keep their normal keys.
            </p>
          </div>
          <button
            type="button"
            aria-keyshortcuts={shortcutAria(['reader-close'])}
            onClick={onClose}
          >
            close
          </button>
        </header>
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
        </div>
      </div>
    </FormLayer>
  );
}
