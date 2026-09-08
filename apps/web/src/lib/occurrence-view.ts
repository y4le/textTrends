/** Accessible status text for exact any-term navigation. */
import type { OccurrenceNavigationState } from './app-state.ts';

export function occurrenceNavigationText(
  navigation: OccurrenceNavigationState | null,
): string {
  if (navigation === null) return '';
  const way = navigation.direction === 1 ? 'next' : 'previous';
  switch (navigation.state.status) {
    case 'pending': return `finding ${way} reference from any term`;
    case 'ready': return `${way} reference from any term`;
    case 'edge': return `no references from any term`;
    case 'error': return `reference navigation failed: ${navigation.state.message}`;
    default: {
      const exhaustive: never = navigation.state;
      return exhaustive;
    }
  }
}
