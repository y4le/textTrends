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
  const gestures = context === 'reader'
    ? new Map([['Reader', [
        ['Touch', 'Tap a page edge to turn; drag vertically to scroll or select text.'],
      ]]])
    : new Map([
        ['Terms', [
          ['Touch', 'Drag a term only from its reorder handle.'],
          ['Keyboard', 'On a reorder handle, press Space or Enter to grab, Arrow Up or Down to move, then Space or Enter to drop.'],
        ]],
        ['Trends', [
          ['Touch', 'Drag one finger to read. Hold a range start, then tap its end; two fingers select the same range directly.'],
        ]],
        ['Reading footer', [
          ['Touch', 'Tap or drag horizontally to read; drag vertically to scroll.'],
        ]],
      ]);
  return (
    <UtilityPane
      title="Keys & gestures"
      subtitle={`${context === 'reader' ? 'Reader' : 'Workbench'} · Vim and conventional keys work together and follow focus; typing fields keep their normal keys.`}
      focusKey={context}
      closeKeyshortcuts={shortcutAria(['reader-close', 'show-help'])}
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
              {(gestures.get(section.title) ?? []).map(([kind, label]) => (
                <div key={`${kind}:${label}`}>
                  <dt><span className="shortcut-help-gesture">{kind}</span></dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </UtilityPane>
  );
}
