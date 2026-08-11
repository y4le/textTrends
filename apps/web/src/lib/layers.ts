export const LAYER_KINDS = [
  'place',
  'row-detail',
  'reader',
] as const;

export type LayerKind = (typeof LAYER_KINDS)[number];

/**
 * Layer targets and focus return identities remain store-side. They are never
 * placed in the URL or browser history.
 */
export interface Layer {
  readonly kind: LayerKind;
  readonly id: string;
  readonly target: unknown;
  readonly returnFocusTo: string;
}

export interface LayerRef {
  readonly kind: LayerKind;
  readonly id: string;
}

export interface AppHistoryStateV1 {
  readonly tt: {
    readonly v: 1;
    readonly layers: readonly LayerRef[];
  };
}

export interface ParsedLayerHistory {
  readonly valid: boolean;
  readonly refs: readonly LayerRef[];
}

export interface ReconciledLayers {
  readonly layers: readonly Layer[];
  readonly refs: readonly LayerRef[];
  readonly truncated: boolean;
}

const kindSet = new Set<string>(LAYER_KINDS);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const MAX_LAYER_DEPTH = 16;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLayerKind(value: unknown): value is LayerKind {
  return typeof value === 'string' && kindSet.has(value);
}

export function isLayerId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function layerRef(layer: Layer): LayerRef {
  return { kind: layer.kind, id: layer.id };
}

function validRef(value: unknown): value is LayerRef {
  return record(value) && isLayerKind(value.kind) && isLayerId(value.id);
}

function assertSerializableStack(layers: readonly Layer[]): void {
  if (layers.length > MAX_LAYER_DEPTH) {
    throw new Error(`Layer history is limited to ${MAX_LAYER_DEPTH} entries.`);
  }
  const seen = new Set<string>();
  let readerSeen = false;
  for (const [index, layer] of layers.entries()) {
    if (!isLayerKind(layer.kind) || !isLayerId(layer.id)) {
      throw new Error('Layer history requires an enumerated kind and a minted UUID.');
    }
    if (seen.has(layer.id)) {
      throw new Error('Layer history identities must be unique.');
    }
    if (layer.kind === 'place' && index !== 0) {
      throw new Error('A place layer must begin a fresh stack.');
    }
    if (readerSeen) {
      throw new Error('Reader must be the terminal layer.');
    }
    if (layer.kind === 'reader') readerSeen = true;
    seen.add(layer.id);
  }
}

/**
 * The complete app-owned history payload. Only enum kinds and minted UUIDs
 * cross the browser-history boundary.
 */
export function historyStateFor(layers: readonly Layer[]): AppHistoryStateV1 {
  assertSerializableStack(layers);
  return {
    tt: {
      v: 1,
      layers: layers.map(layerRef),
    },
  };
}

/** Total parser for restored, foreign, corrupt, or hostile history state. */
export function parseLayerHistory(state: unknown): ParsedLayerHistory {
  if (!record(state) || !record(state.tt) || state.tt.v !== 1) {
    return { valid: false, refs: [] };
  }
  const raw = state.tt.layers;
  if (!Array.isArray(raw)) {
    return { valid: false, refs: [] };
  }
  const refs: LayerRef[] = [];
  const seen = new Set<string>();
  let readerSeen = false;
  let valid = raw.length <= MAX_LAYER_DEPTH;
  for (const value of raw.slice(0, MAX_LAYER_DEPTH)) {
    if (
      !validRef(value)
      || seen.has(value.id)
    ) {
      valid = false;
      break;
    }
    if (value.kind === 'place' && refs.length !== 0) {
      valid = false;
      break;
    }
    if (readerSeen) {
      valid = false;
      break;
    }
    if (value.kind === 'reader') readerSeen = true;
    seen.add(value.id);
    refs.push({ kind: value.kind, id: value.id });
  }
  return { valid, refs };
}

/**
 * Push a new app-owned navigation layer. A place entry begins a fresh stack;
 * all transient layers preserve the layers beneath them.
 */
export function pushLayer(stack: readonly Layer[], layer: Layer): readonly Layer[] {
  if (layer.kind === 'place') {
    assertSerializableStack([layer]);
    return [layer];
  }
  const next = [...stack, layer];
  assertSerializableStack(next);
  return next;
}

/** Replace the active depth, used for row-target and presentation changes. */
export function replaceTopLayer(stack: readonly Layer[], layer: Layer): readonly Layer[] {
  const next = layer.kind === 'place' || stack.length === 0
    ? [layer]
    : [...stack.slice(0, -1), layer];
  assertSerializableStack(next);
  return next;
}

/**
 * Reconcile backward or forward browser navigation against the store-side
 * registry. Forward restoration stops at the first missing or mismatched id;
 * callers replace browser state with the returned normalized refs.
 */
export function reconcileLayerRefs(
  requested: readonly LayerRef[],
  resolve: (id: string) => Layer | undefined,
): ReconciledLayers {
  const layers: Layer[] = [];
  const refs: LayerRef[] = [];
  const seen = new Set<string>();
  let readerSeen = false;
  let truncated = requested.length > MAX_LAYER_DEPTH;
  for (const ref of requested.slice(0, MAX_LAYER_DEPTH)) {
    if (
      !isLayerKind(ref.kind)
      || !isLayerId(ref.id)
      || seen.has(ref.id)
      || (ref.kind === 'place' && layers.length !== 0)
      || readerSeen
    ) {
      truncated = true;
      break;
    }
    const layer = resolve(ref.id);
    if (layer === undefined || layer.kind !== ref.kind || layer.id !== ref.id) {
      truncated = true;
      break;
    }
    seen.add(ref.id);
    if (ref.kind === 'reader') readerSeen = true;
    layers.push(layer);
    refs.push(layerRef(layer));
  }
  return { layers, refs, truncated };
}
