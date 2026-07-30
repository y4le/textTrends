export interface HistoryPort {
  readonly state: unknown;
  readonly url: string;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
  back(): void;
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
    back() {
      target.history.back();
    },
    subscribe(listener) {
      const onPopState = () => listener();
      target.addEventListener('popstate', onPopState);
      return () => target.removeEventListener('popstate', onPopState);
    },
  };
}
