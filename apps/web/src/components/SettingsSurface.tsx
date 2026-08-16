import { TrendSettings } from './TrendSettings.tsx';
import { shortcutAria } from '../lib/shortcuts.ts';
import { UtilityPane } from './UtilityPane.tsx';

export function SettingsSurface({ onClose }: { readonly onClose: () => void }) {
  return (
    <UtilityPane
      title="Trend settings"
      subtitle="Trends · Configure result geometry and presentation."
      closeKeyshortcuts={shortcutAria(['reader-close'])}
      className="settings-pane"
      onClose={onClose}
    >
      <TrendSettings onApplied={onClose} />
    </UtilityPane>
  );
}
