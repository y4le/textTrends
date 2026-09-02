import { createContext, useContext } from 'react';
import type {
  GuideId,
  GuideReadiness,
} from '../../lib/guide/definition.ts';
import type { GuideOrigin } from '../../lib/guide/session.ts';

export interface GuideController {
  readonly activeGuideId: GuideId | null;
  readonly guidedTourReadiness: GuideReadiness;
  readonly guidedTourSeen: boolean;
  readonly guidedTourInvitation:
    | { readonly status: 'hidden' }
    | {
        readonly status: 'available';
        readonly starting: boolean;
        readonly start: () => void;
        readonly dismiss: () => void;
      };
  readonly startGuide: (id: GuideId, origin: GuideOrigin) => Promise<boolean>;
}

export const GuideControllerContext = createContext<GuideController | null>(null);

export function useGuide(): GuideController {
  const value = useContext(GuideControllerContext);
  if (value === null) throw new Error('useGuide must be used inside GuideProvider');
  return value;
}
