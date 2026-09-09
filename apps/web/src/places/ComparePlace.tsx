// Passive timing marks are removed from the normal production build.
if (__TT_E2E__) performance.mark('tt:module:compare');

import { ComparePanel } from '../components/compare/ComparePanel.tsx';

/** Compare owns explicit A/B scope, rankings, and occurrence inspection. */
export function ComparePlace() {
  if (__TT_E2E__) performance.mark('tt:render:compare');
  return <ComparePanel />;
}
