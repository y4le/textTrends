export interface ResumeInput {
  readonly readyDocuments: number;
  readonly missingDocuments: number;
  readonly pendingAnalyses: number;
  readonly loadingPhase: string | null;
}

export interface ResumeVM {
  readonly kind: 'pending' | 'partial' | 'settled';
  readonly message: string;
}

/**
 * Describe only the state observed after resume. It deliberately says
 * nothing about work while suspended: browsers may freeze the worker, page,
 * timers, or all three, and the app cannot truthfully infer background
 * progress from the state it sees on pageshow.
 */
export function reconcileResume(input: ResumeInput): ResumeVM {
  if (input.pendingAnalyses > 0 || input.loadingPhase !== null) {
    const pending = input.pendingAnalyses;
    return {
      kind: 'pending',
      message: pending > 0
        ? `Resumed · ${pending} analysis ${pending === 1 ? 'request is' : 'requests are'} pending; the current reconciled state is shown.`
        : `Resumed · corpus preparation is pending; the current reconciled state is shown.`,
    };
  }
  if (input.missingDocuments > 0) {
    return {
      kind: 'partial',
      message: `Resumed · ${input.readyDocuments} ${input.readyDocuments === 1 ? 'text is' : 'texts are'} ready and ${input.missingDocuments} ${input.missingDocuments === 1 ? 'text is' : 'texts are'} unavailable.`,
    };
  }
  return {
    kind: 'settled',
    message: 'Resumed · local results and scope are reconciled.',
  };
}

export interface PageLifecycleTarget {
  addEventListener(type: 'pagehide' | 'pageshow', listener: EventListener): void;
  removeEventListener(type: 'pagehide' | 'pageshow', listener: EventListener): void;
}

export interface ResumeMonitor {
  readonly getSnapshot: () => ResumeAnnouncement | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

export interface ResumeAnnouncement {
  readonly revision: number;
  readonly view: ResumeVM;
}

export function createResumeMonitor(
  target: PageLifecycleTarget,
  read: () => ResumeInput,
): ResumeMonitor {
  let armed = false;
  let trackingUnsettledState = false;
  let revision = 0;
  let snapshot: ResumeAnnouncement | null = null;
  const listeners = new Set<() => void>();
  const publish = (view: ResumeVM, force: boolean) => {
    if (
      !force
      && view.kind === snapshot?.view.kind
      && view.message === snapshot.view.message
    ) return;
    revision += 1;
    snapshot = { revision, view };
    // Only work already pending at resume may refine. A partial corpus is an
    // observed terminal condition here: keeping it live would let unrelated,
    // later user actions be mislabeled as part of the resume reconciliation.
    trackingUnsettledState = view.kind === 'pending';
    for (const listener of listeners) listener();
  };
  const refresh = () => {
    if (armed || !trackingUnsettledState) return;
    publish(reconcileResume(read()), false);
  };
  const onPageHide: EventListener = () => {
    armed = true;
    trackingUnsettledState = false;
  };
  const onPageShow: EventListener = () => {
    if (!armed) return;
    armed = false;
    // Force a new revision even when the sentence is identical so a repeated
    // resume remounts the live region and is announced again.
    publish(reconcileResume(read()), true);
  };
  target.addEventListener('pagehide', onPageHide);
  target.addEventListener('pageshow', onPageShow);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose() {
      target.removeEventListener('pagehide', onPageHide);
      target.removeEventListener('pageshow', onPageShow);
      listeners.clear();
    },
  };
}
