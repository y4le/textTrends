import { describe, expect, it } from 'vitest';
import {
  createResumeMonitor,
  reconcileResume,
  type PageLifecycleTarget,
} from '../src/lib/resume.ts';

class FakeLifecycle implements PageLifecycleTarget {
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: 'pagehide' | 'pageshow', listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'pagehide' | 'pageshow', listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: 'pagehide' | 'pageshow') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

describe('reconcileResume', () => {
  it('never claims pending work continued in the background', () => {
    const view = reconcileResume({
      readyDocuments: 4,
      missingDocuments: 0,
      pendingAnalyses: 3,
      loadingPhase: null,
    });
    expect(view.kind).toBe('pending');
    expect(view.message).toContain('3 analysis requests are pending');
    expect(view.message).toContain('current reconciled state');
    expect(view.message).not.toMatch(/continued|completed|kept running|background/i);
  });

  it('describes partial and settled states without inventing progress', () => {
    expect(reconcileResume({
      readyDocuments: 4,
      missingDocuments: 2,
      pendingAnalyses: 0,
      loadingPhase: null,
    })).toEqual({
      kind: 'partial',
      message: 'Resumed · 4 texts are ready and 2 texts are unavailable.',
    });
    expect(reconcileResume({
      readyDocuments: 6,
      missingDocuments: 0,
      pendingAnalyses: 0,
      loadingPhase: null,
    }).message).toBe('Resumed · local results and scope are reconciled.');
  });
});

describe('createResumeMonitor', () => {
  it('publishes only after a matching pagehide/pageshow cycle and never mutates inputs', () => {
    const lifecycle = new FakeLifecycle();
    let reads = 0;
    let input = {
      readyDocuments: 6,
      missingDocuments: 0,
      pendingAnalyses: 0,
      loadingPhase: null as string | null,
    };
    const monitor = createResumeMonitor(lifecycle, () => {
      reads += 1;
      return input;
    });
    const observed: Array<{ readonly revision: number; readonly message: string } | null> = [];
    const unsubscribe = monitor.subscribe(() => {
      const snapshot = monitor.getSnapshot();
      observed.push(snapshot === null
        ? null
        : { revision: snapshot.revision, message: snapshot.view.message });
    });

    lifecycle.dispatch('pageshow');
    expect(reads).toBe(0);
    expect(observed).toEqual([]);
    lifecycle.dispatch('pagehide');
    expect(reads).toBe(0);
    lifecycle.dispatch('pageshow');
    expect(reads).toBe(1);
    expect(observed).toEqual([{
      revision: 1,
      message: 'Resumed · local results and scope are reconciled.',
    }]);

    // A settled announcement does not start describing later user work.
    input = { ...input, pendingAnalyses: 1 };
    monitor.refresh();
    expect(reads).toBe(1);

    // An identical later resume is still a distinct announcement.
    lifecycle.dispatch('pagehide');
    input = { ...input, pendingAnalyses: 0 };
    lifecycle.dispatch('pageshow');
    expect(observed.at(-1)).toEqual({
      revision: 2,
      message: 'Resumed · local results and scope are reconciled.',
    });

    unsubscribe();
    monitor.dispose();
    expect(lifecycle.listeners.get('pagehide')?.size).toBe(0);
    expect(lifecycle.listeners.get('pageshow')?.size).toBe(0);
  });

  it('keeps an unsettled announcement truthful until reconciliation settles', () => {
    const lifecycle = new FakeLifecycle();
    let input = {
      readyDocuments: 6,
      missingDocuments: 0,
      pendingAnalyses: 2,
      loadingPhase: null as string | null,
    };
    const monitor = createResumeMonitor(lifecycle, () => input);

    lifecycle.dispatch('pagehide');
    lifecycle.dispatch('pageshow');
    expect(monitor.getSnapshot()?.view.message).toContain('2 analysis requests are pending');

    input = { ...input, pendingAnalyses: 1 };
    monitor.refresh();
    expect(monitor.getSnapshot()?.view.message).toContain('1 analysis request is pending');

    input = { ...input, pendingAnalyses: 0 };
    monitor.refresh();
    expect(monitor.getSnapshot()?.view).toEqual({
      kind: 'settled',
      message: 'Resumed · local results and scope are reconciled.',
    });

    monitor.dispose();
  });

  it('treats a partial corpus as the terminal resume observation', () => {
    const lifecycle = new FakeLifecycle();
    let input = {
      readyDocuments: 4,
      missingDocuments: 2,
      pendingAnalyses: 0,
      loadingPhase: null as string | null,
    };
    const monitor = createResumeMonitor(lifecycle, () => input);

    lifecycle.dispatch('pagehide');
    lifecycle.dispatch('pageshow');
    const partial = monitor.getSnapshot();
    expect(partial?.view.kind).toBe('partial');

    input = { ...input, pendingAnalyses: 5 };
    monitor.refresh();
    expect(monitor.getSnapshot()).toBe(partial);

    monitor.dispose();
  });
});
