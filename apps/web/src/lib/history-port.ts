export interface HistoryPort {
  readonly state: unknown;
  readonly url: string;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
  back(steps?: number): void;
  subscribe(listener: () => void): () => void;
}

/** Thin browser boundary; the store owns every navigation policy decision. */
export function browserHistoryPort(target: Window): HistoryPort {
  return {
    get state() {
      return target.history.state;
    },
    get url() {
      return target.location.href;
    },
    push(state, url) {
      target.history.pushState(state, '', url);
    },
    replace(state, url) {
      target.history.replaceState(state, '', url);
    },
    back(steps = 1) {
      if (steps === 1) target.history.back();
      else target.history.go(-steps);
    },
    subscribe(listener) {
      const onPopState = () => listener();
      target.addEventListener('popstate', onPopState);
      return () => target.removeEventListener('popstate', onPopState);
    },
  };
}
