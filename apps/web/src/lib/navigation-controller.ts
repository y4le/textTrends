/** Owns URL initialization, layer history, Back/Forward reconciliation, and focus return. */
import type { StoreApi } from 'zustand';
import type { HistoryPort } from './history-port.ts';
import type { AppState, ScrubTarget } from './app-state.ts';
import { liveReaderPlace, sameReaderPlace, type ReaderPlace } from './reader-intent.ts';
import type { ProjectView } from './project-session.ts';
import {
  historyStateFor,
  parseLayerHistory,
  pushLayer as pushLayerStack,
  reconcileLayerRefs,
  replaceTopLayer,
  type Layer,
  type LayerKind,
} from './layers.ts';
import { parseRoute, routeSearch, type RouteV1 } from './route.ts';
import { PLACES, type Place } from './places.ts';

function routeFromUrl(url: string): RouteV1 {
  try {
    return parseRoute(new URL(url, 'https://texttrends.invalid/').search);
  } catch {
    return { place: null };
  }
}

function urlWithRoute(
  url: string,
  route: RouteV1,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://texttrends.invalid/');
  } catch {
    parsed = new URL('https://texttrends.invalid/');
  }
  return `${parsed.pathname}${routeSearch(parsed.search, route)}${parsed.hash}`;
}

function relativeHistoryUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://texttrends.invalid/');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function defaultPlaceFor(project: ProjectView | null | undefined): Place {
  return (project?.data.order.length ?? 0) === 0 ? 'inputs' : 'trends';
}

function placeReturnFocusTo(place: Place): string {
  return place === 'vocabulary'
    ? 'vocabulary-grid-port'
    : `place-${place}-heading`;
}

function restoreFocusTo(id: string): void {
  if (typeof document === 'undefined') return;
  const focus = () => document.getElementById(id)?.focus({ preventScroll: true });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
  else queueMicrotask(focus);
}

interface NavigationCallbacks {
  isDisposed(): boolean;
  supersedeReader(): void;
  resetReaderSeek(): void;
  scheduleFooterPassage(target: ScrubTarget): void;
  runFooterPassage(): void;
  runReader(): void;
}

/** Construct before Zustand; bind once after it exists. Boot URL normalization
 * must precede the first state snapshot, while history callbacks need the store. */
export function createNavigationController(historyPort: HistoryPort | null, newLayerId: () => string) {
  let store: Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>;
  let callbacks: NavigationCallbacks;
  let bound = false;
  let disposed = false;
  let unsubscribeHistory = () => {};
  let historyTraversalPending = false;
  let pendingBackFocusTo: string | null = null;
  const get = () => store.getState();
  const set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => store.setState(partial);
  // Route and layer state is initialized before the store so the first React
  // snapshot and the current history entry cannot disagree.
  const MAX_LAYER_REGISTRY_ENTRIES = 128;
  const layerRegistry = new Map<string, Layer>();
  const rememberLayer = (layer: Layer, retain: readonly Layer[] = []): void => {
    layerRegistry.delete(layer.id);
    layerRegistry.set(layer.id, layer);
    if (layerRegistry.size <= MAX_LAYER_REGISTRY_ENTRIES) return;
    const protectedIds = new Set(retain.map((item) => item.id));
    for (const id of layerRegistry.keys()) {
      if (layerRegistry.size <= MAX_LAYER_REGISTRY_ENTRIES) break;
      if (!protectedIds.has(id)) layerRegistry.delete(id);
    }
  };
  const resolveLayer = (id: string): Layer | undefined => {
    const layer = layerRegistry.get(id);
    if (layer === undefined) return undefined;
    // A resolved Back/Forward identity becomes most-recently used.
    layerRegistry.delete(id);
    layerRegistry.set(id, layer);
    return layer;
  };
  const bootRoute = historyPort === null
    ? { place: null }
    : routeFromUrl(historyPort.url);

  if (historyPort !== null) {
    historyPort.replace(
      historyStateFor([]),
      urlWithRoute(historyPort.url, bootRoute),
    );
  }

    const readerForLayers = (
      layers: readonly Layer[],
      snapshot = get().snapshot,
    ): ReaderPlace | null => {
      const layer = layers.findLast((candidate) => candidate.kind === 'reader');
      if (layer === undefined) return null;
      return liveReaderPlace(
        layer.target,
        snapshot?.snapshot ?? null,
        snapshot?.readyDocs ?? [],
      );
    };

    const writeNavigation = (
      mode: 'push' | 'replace',
      place: Place,
      layers: readonly Layer[],
      options: {
        readonly preserveReaderNavigation?: boolean;
        readonly resolveRoute?: boolean;
        readonly writeHistory?: boolean;
      } = {},
    ): void => {
      if (historyPort !== null && options.writeHistory !== false) {
        const routePlace = options.resolveRoute === true || get().routeStatus === 'resolved'
          ? place
          : null;
        historyPort[mode](
          historyStateFor(layers),
          urlWithRoute(historyPort.url, { place: routePlace }),
        );
      }
      const current = get();
      const readerPlace = readerForLayers(layers, current.snapshot);
      const readerChanged = !sameReaderPlace(current.readerPlace, readerPlace);
      if (readerChanged) callbacks.supersedeReader();
      set((state) => ({
        place,
        routeStatus: options.resolveRoute === true ? 'resolved' : state.routeStatus,
        layers,
        interaction: state.interaction.kind === 'rsvp'
          && (
            readerPlace === null
            || readerPlace.snapshot !== state.interaction.rsvp.snapshot
            || readerPlace.doc !== state.interaction.rsvp.doc
          )
          ? state.interaction.suspended
          : state.interaction,
        notebookError: place === state.place ? state.notebookError : null,
        readerPlace,
        readerPage: readerChanged ? null : state.readerPage,
        readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
        readerCursorToken: readerChanged ? null : state.readerCursorToken,
        readerNavigation:
          readerChanged && !options.preserveReaderNavigation
            ? null
            : state.readerNavigation,
      }));
      if (current.readerPlace !== null && readerPlace === null && current.scrub !== null) {
        callbacks.scheduleFooterPassage(current.scrub);
      }
    };

    const requestBack = (count = 1, returnFocusTo?: string): boolean => {
      const layers = get().layers;
      if (
        historyTraversalPending
        || layers.length === 0
        || !Number.isSafeInteger(count)
        || count < 1
        || count > layers.length
      ) return false;
      if (historyPort === null) {
        const closing = layers.at(-count)!;
        writeNavigation('replace', get().place, layers.slice(0, -count));
        restoreFocusTo(returnFocusTo ?? closing.returnFocusTo);
        return true;
      }
      historyTraversalPending = true;
      pendingBackFocusTo = returnFocusTo ?? null;
      historyPort.back(count);
      return true;
    };

    const freshLayer = (
      kind: Exclude<LayerKind, 'place'>,
      target: unknown,
      returnFocusTo: string,
    ): Layer => ({
      kind,
      id: newLayerId(),
      target,
      returnFocusTo,
    });

  const reconcileHistory = (): void => {
    if (historyPort === null || disposed || callbacks.isDisposed()) return;
    callbacks.resetReaderSeek();
    const requestedFocusTo = pendingBackFocusTo;
    pendingBackFocusTo = null;
    historyTraversalPending = false;
    const previous = store.getState();
    const route = routeFromUrl(historyPort.url);
    const routePlace = route.place ?? defaultPlaceFor(previous.projectSession?.project);
    const parsed = parseLayerHistory(historyPort.state);
    const reconciled = reconcileLayerRefs(parsed.refs, resolveLayer);
    let layers = reconciled.layers;
    let staleReader = false;
    const readerIndex = layers.findIndex((layer) => layer.kind === 'reader');
    let readerPlace: ReaderPlace | null = null;
    if (readerIndex >= 0) {
      const layer = layers[readerIndex]!;
      readerPlace = liveReaderPlace(
        layer.target,
        previous.snapshot?.snapshot ?? null,
        previous.snapshot?.readyDocs ?? [],
      );
      if (readerPlace === null) {
        layers = layers.slice(0, readerIndex);
        staleReader = true;
      }
    }
    const readerChanged = !sameReaderPlace(previous.readerPlace, readerPlace);
    if (readerChanged) callbacks.supersedeReader();
    store.setState((state) => ({
      place: routePlace,
      routeStatus: 'resolved',
      layers,
      interaction: state.interaction.kind === 'rsvp'
        && (
          readerPlace === null
          || readerPlace.snapshot !== state.interaction.rsvp.snapshot
          || readerPlace.doc !== state.interaction.rsvp.doc
        )
        ? state.interaction.suspended
        : state.interaction,
      notebookError: routePlace === state.place ? state.notebookError : null,
      readerPlace,
      readerPage: readerChanged ? null : state.readerPage,
      readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
      readerNavigation: readerChanged ? null : state.readerNavigation,
    }));
    if (previous.readerPlace !== null && readerPlace === null && previous.scrub !== null) {
      callbacks.runFooterPassage();
    }
    const normalizedUrl = urlWithRoute(historyPort.url, { place: routePlace });
    if (
      !parsed.valid
      || reconciled.truncated
      || staleReader
      || relativeHistoryUrl(historyPort.url) !== normalizedUrl
    ) {
      historyPort.replace(historyStateFor(layers), normalizedUrl);
    }
    const removed = previous.layers.find(
      (candidate) => !layers.some((layer) => layer.id === candidate.id),
    );
    if (removed) {
      restoreFocusTo(requestedFocusTo ?? removed.returnFocusTo);
    }
    if (readerPlace !== null && readerChanged) {
      callbacks.runReader();
    }
  };

  const actions: Pick<AppState, 'setPlace' | 'replacePlace' | 'pushLayer' | 'replaceLayer' | 'popLayer'> = {
      setPlace(place) {
        if (
          !PLACES.includes(place)
          || (place === get().place && get().routeStatus === 'resolved')
        ) return;
        const next: Layer = {
          kind: 'place',
          id: newLayerId(),
          target: Object.freeze({ place }),
          returnFocusTo: placeReturnFocusTo(get().place),
        };
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', place, layers, { resolveRoute: true });
      },
      replacePlace(place) {
        if (
          !PLACES.includes(place)
          || (place === get().place && get().routeStatus === 'resolved')
        ) return;
        const next: Layer = {
          kind: 'place',
          id: newLayerId(),
          target: Object.freeze({ place }),
          returnFocusTo: placeReturnFocusTo(get().place),
        };
        const layers = replaceTopLayer(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('replace', place, layers, { resolveRoute: true });
      },
      pushLayer(kind, target, returnFocusTo) {
        const next = freshLayer(kind, target, returnFocusTo);
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', get().place, layers);
      },
      replaceLayer(kind, target, returnFocusTo) {
        const next = freshLayer(kind, target, returnFocusTo);
        const layers = replaceTopLayer(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('replace', get().place, layers);
      },
      popLayer(count = 1, returnFocusTo) {
        return requestBack(count, returnFocusTo);
      },

  };
  const initial: Pick<AppState, 'place' | 'routeStatus' | 'layers'> = {
    place: bootRoute.place ?? 'inputs',
    routeStatus: bootRoute.place === null ? 'pending' : 'resolved',
    layers: [],
  };
  return {
    initial, actions, rememberLayer, writeNavigation, freshLayer, requestBack, defaultPlaceFor,
    replaceEntry(place: Place, layers: readonly Layer[]) {
      historyPort?.replace(historyStateFor(layers), urlWithRoute(historyPort.url, { place }));
    },
    bind(next: typeof store, nextCallbacks: NavigationCallbacks) {
      if (bound || disposed) throw new Error('navigation binds once per runtime');
      bound = true;
      store = next;
      callbacks = nextCallbacks;
      unsubscribeHistory = historyPort?.subscribe(reconcileHistory) ?? (() => {});
    },
    dispose() {
      disposed = true;
      unsubscribeHistory();
      layerRegistry.clear();
    },
  };
}
