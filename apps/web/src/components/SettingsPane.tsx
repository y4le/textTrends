import { shortcutAria } from '../lib/shortcuts.ts';
import type { SettingsEntry } from '../lib/settings-entry.ts';
import { DisplaySettings } from './settings/DisplaySettings.tsx';
import { HelpSection } from './settings/HelpSection.tsx';
import { PlaceSettings } from './settings/PlaceSettings.tsx';
import { UtilityPane } from './UtilityPane.tsx';

export function SettingsPane({
  entry,
  onClose,
  onOpenShortcuts,
  onOpenDebug,
}: {
  readonly entry: SettingsEntry;
  readonly onClose: () => void;
  readonly onOpenShortcuts: () => void;
  readonly onOpenDebug: () => void;
}) {
  return (
    <UtilityPane
      title="Settings"
      subtitle="Display preferences, place-specific method, and help."
      focusKey={`${entry.context}:${entry.section}`}
      initialFocus="heading"
      closeKeyshortcuts={shortcutAria(['reader-close'])}
      className="settings-pane"
      onClose={onClose}
    >
      <div className="settings-sections">
        <section aria-labelledby="settings-display-heading">
          <h3 id="settings-display-heading">Display</h3>
          <DisplaySettings />
        </section>
        <section aria-labelledby="settings-place-heading">
          <h3 id="settings-place-heading">This place</h3>
          <PlaceSettings context={entry.context} onApplied={onClose} />
        </section>
        <section aria-labelledby="settings-help-heading">
          <h3 id="settings-help-heading">Help &amp; method</h3>
          <HelpSection onOpenShortcuts={onOpenShortcuts} onOpenDebug={onOpenDebug} />
        </section>
      </div>
    </UtilityPane>
  );
}
