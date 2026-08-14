/**
 * One process-wide lane for mutations of the local library. It deliberately
 * lives outside React so an acquisition remains exclusive across Inputs
 * unmounts, remounts, and startup migration.
 */

type Listener = () => void;

let active: symbol | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener();
}

export const libraryOperation = {
  claim(): symbol | null {
    if (active !== null) return null;
    active = Symbol('library-operation');
    publish();
    return active;
  },

  release(lease: symbol): void {
    if (active !== lease) return;
    active = null;
    publish();
  },

  isBusy(): boolean {
    return active !== null;
  },

  owns(lease: symbol): boolean {
    return active === lease;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
