import { lazy, useState, type ComponentProps, type ComponentType } from 'react';
import { ErrorBoundary } from './ErrorBoundary.tsx';

interface FailureReturn {
  readonly onLoadFailureReturn?: () => void;
  readonly onLoadFailureReturnLabel?: string;
}

/** Recreate React's cached lazy result only after an explicit retry. Pending
 * modules continue to use the surrounding region's Suspense fallback. */
export function retryableLazy<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  region: string,
  modal = false,
): ComponentType<ComponentProps<T> & FailureReturn> {
  type P = ComponentProps<T>;
  let current = lazy(load) as ComponentType<P>;
  return function RetryableRegion({ onLoadFailureReturn, onLoadFailureReturnLabel, ...props }: P & FailureReturn) {
    const [attempt, setAttempt] = useState(0);
    const [View, setView] = useState(() => current);
    return (
      <ErrorBoundary
        region={region}
        modal={modal}
        resetKey={String(attempt)}
        onRetry={() => {
          current = lazy(load) as ComponentType<P>;
          setView(() => current);
          setAttempt((value) => value + 1);
        }}
        {...(onLoadFailureReturn ? { onReturn: onLoadFailureReturn } : {})}
        {...(onLoadFailureReturnLabel ? { returnLabel: onLoadFailureReturnLabel } : {})}
      >
        <View {...props as P} />
      </ErrorBoundary>
    );
  };
}
