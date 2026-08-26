import { shortcutAria } from '../lib/shortcuts.ts';

export function HeaderActions({
  onOpenFind,
  onOpenSettings,
  onOpenHelp,
}: {
  readonly onOpenFind: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHelp: () => void;
}) {
  return (
    <nav className="header-actions" aria-label="Application tools">
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
