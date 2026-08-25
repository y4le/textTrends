export function HelpSection({
  onOpenShortcuts,
  onOpenDebug,
}: {
  readonly onOpenShortcuts: () => void;
  readonly onOpenDebug: () => void;
}) {
  return (
    <div className="settings-help">
      <p>Imported text is processed in your browser and is never uploaded.</p>
      <div className="settings-help-actions">
        <button type="button" onClick={onOpenShortcuts}>Keyboard shortcuts</button>
        <button type="button" onClick={onOpenDebug}>Debug & diagnostics</button>
      </div>
    </div>
  );
}
