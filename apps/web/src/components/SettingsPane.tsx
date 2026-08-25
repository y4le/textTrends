import { useLayoutEffect, useRef } from 'react';
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const placeSectionRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const sections = sectionsRef.current;
    const placeSection = placeSectionRef.current;
    if (body === null || sections === null) return undefined;
    sections.style.paddingBlockEnd = '0px';
    if (entry.section !== 'this-place' || placeSection === null) {
      body.scrollTop = 0;
      return undefined;
    }

    const targetScrollTop = placeSection.offsetTop - body.offsetTop;
    const missingScrollRoom = Math.max(
      0,
      targetScrollTop + body.clientHeight - body.scrollHeight,
    );
    sections.style.paddingBlockEnd = `${missingScrollRoom}px`;
    body.scrollTop = targetScrollTop;
    return undefined;
  }, [entry.context, entry.section]);

  const initialFocusId = entry.section === 'this-place'
    ? entry.context === 'trends'
      ? 'trend-bin-mode'
      : entry.context === 'compare'
        ? 'compare-sort-field'
        : undefined
    : undefined;

  return (
    <UtilityPane
      title="Settings"
      subtitle="Display preferences, place-specific method, and help."
      focusKey={`${entry.context}:${entry.section}`}
      initialFocus={entry.section === 'display' ? 'heading' : 'first-control'}
      {...(initialFocusId === undefined ? {} : { initialFocusId })}
      closeKeyshortcuts={shortcutAria(['reader-close'])}
      className="settings-pane"
      bodyRef={bodyRef}
      onClose={onClose}
    >
      <div ref={sectionsRef} className="settings-sections">
        <section id="settings-display" aria-labelledby="settings-display-heading">
          <h3 id="settings-display-heading">Display</h3>
          <DisplaySettings />
        </section>
        <section
          id="settings-place"
          ref={placeSectionRef}
          aria-labelledby="settings-place-heading"
        >
          <h3 id="settings-place-heading">This place</h3>
          <PlaceSettings context={entry.context} onApplied={onClose} />
        </section>
        <section id="settings-help" aria-labelledby="settings-help-heading">
          <h3 id="settings-help-heading">Help &amp; method</h3>
          <HelpSection onOpenShortcuts={onOpenShortcuts} onOpenDebug={onOpenDebug} />
        </section>
      </div>
    </UtilityPane>
  );
}
