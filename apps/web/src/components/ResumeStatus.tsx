import { useSyncExternalStore } from 'react';
import { resumeMonitor } from '../lib/store-instance.ts';

export function ResumeStatus() {
  const announcement = useSyncExternalStore(
    resumeMonitor.subscribe,
    resumeMonitor.getSnapshot,
    resumeMonitor.getSnapshot,
  );
  if (announcement === null) return null;
  return (
    <p
      key={announcement.revision}
      role="status"
      data-testid="resume-status"
      data-resume-revision={announcement.revision}
      style={{
        margin: 'var(--space-2) 0',
        color: 'var(--fg-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
      }}
    >
      {announcement.view.message}
    </p>
  );
}
