/**
 * Transient reading-position history. This is deliberately independent from
 * browser/layer history: it is a bounded jump list with a browser-shaped
 * current index.
 */

export const POSITION_HISTORY_MAX_ENTRIES = 32;
export const POSITION_HISTORY_NEAR_TOKENS = 64;
export const POSITION_HISTORY_REFIT_TOLERANCE_TOKENS = 1_500;
export const POSITION_HISTORY_SETTLE_MS = 400;

export type PositionHistoryOrigin =
  | 'barcode'
  | 'find'
  | 'matches'
  | 'occurrence'
  | 'reader'
  | 'scrub'
  | 'seek';

export interface PositionHistoryEntry {
  readonly snapshot: string;
  readonly doc: string;
  readonly token: number;
  readonly origin: PositionHistoryOrigin;
}

/**
 * `provisional` is the mutable end of one continuous reading run. `settling`
 * admits one surface-authored refinement after traversal; `hardened` is a
 * stable jump boundary.
 */
export type PositionHistoryTail = 'hardened' | 'settling' | 'provisional';

export interface PositionHistory {
  readonly entries: readonly PositionHistoryEntry[];
  readonly index: number;
  readonly tail: PositionHistoryTail;
}

export const EMPTY_POSITION_HISTORY: PositionHistory = Object.freeze({
  entries: Object.freeze([]),
  index: -1,
  tail: 'hardened',
});

function validEntry(entry: PositionHistoryEntry): boolean {
  return entry.snapshot.length > 0
    && entry.doc.length > 0
    && Number.isSafeInteger(entry.token)
    && entry.token >= 0;
}

function within(
  left: PositionHistoryEntry | undefined,
  right: PositionHistoryEntry,
  tolerance: number,
): boolean {
  return left !== undefined
    && left.snapshot === right.snapshot
    && left.doc === right.doc
    && Math.abs(left.token - right.token) <= tolerance;
}

function replaceCurrent(
  history: PositionHistory,
  entry: PositionHistoryEntry,
  tail: PositionHistoryTail,
): PositionHistory {
  if (history.index < 0 || history.index >= history.entries.length) {
    return EMPTY_POSITION_HISTORY;
  }
  const entries = [...history.entries];
  entries[history.index] = entry;
  return { entries, index: history.index, tail };
}

function push(
  history: PositionHistory,
  entry: PositionHistoryEntry,
  tail: PositionHistoryTail,
): PositionHistory {
  if (!validEntry(entry)) return history;
  const current = history.entries[history.index];
  // A near push is an amendment. In particular, activating the same evidence
  // twice must not grow the list or destroy an existing forward branch.
  if (within(current, entry, POSITION_HISTORY_NEAR_TOKENS)) {
    return replaceCurrent(history, entry, tail);
  }
  const prefix = history.entries.slice(0, history.index + 1);
  const entries = [...prefix, entry];
  let index = entries.length - 1;
  if (entries.length > POSITION_HISTORY_MAX_ENTRIES) {
    const overflow = entries.length - POSITION_HISTORY_MAX_ENTRIES;
    entries.splice(0, overflow);
    index -= overflow;
  }
  return { entries, index, tail };
}

function harden(history: PositionHistory): PositionHistory {
  return history.tail === 'hardened'
    ? history
    : { ...history, tail: 'hardened' };
}

/** Record one quiet point in continuous movement. */
export function recordPositionSettle(
  history: PositionHistory,
  entry: PositionHistoryEntry,
): PositionHistory {
  if (!validEntry(entry)) return history;
  const current = history.entries[history.index];
  if (current === undefined) return push(history, entry, 'hardened');
  if (history.tail === 'provisional') {
    return replaceCurrent(history, entry, 'provisional');
  }
  if (
    history.tail === 'settling'
    && within(current, entry, POSITION_HISTORY_REFIT_TOLERANCE_TOKENS)
  ) {
    return replaceCurrent(history, entry, 'hardened');
  }
  if (within(current, entry, POSITION_HISTORY_NEAR_TOKENS)) {
    return replaceCurrent(history, entry, history.tail);
  }
  return push(history, entry, 'provisional');
}

/**
 * Record a discrete jump. `from` is the live cursor being left, so an
 * unsettled drag immediately followed by a jump cannot lose its destination.
 */
export function recordPositionJump(
  history: PositionHistory,
  from: PositionHistoryEntry | null,
  to: PositionHistoryEntry,
): PositionHistory {
  if (!validEntry(to)) return history;
  let next = history;
  if (from !== null && validEntry(from)) {
    const current = next.entries[next.index];
    if (current === undefined) {
      next = push(next, from, 'hardened');
    } else if (next.tail === 'provisional') {
      next = replaceCurrent(next, from, 'hardened');
    } else if (
      next.tail === 'settling'
      && within(current, from, POSITION_HISTORY_REFIT_TOLERANCE_TOKENS)
    ) {
      next = replaceCurrent(next, from, 'hardened');
    } else if (within(current, from, POSITION_HISTORY_NEAR_TOKENS)) {
      next = replaceCurrent(next, from, 'hardened');
    } else {
      next = push(next, from, 'hardened');
    }
  }
  return push(harden(next), to, 'hardened');
}

export interface PositionHistoryTraversal {
  readonly history: PositionHistory;
  readonly target: PositionHistoryEntry;
}

/** Traverse without recording a new entry or truncating the forward branch. */
export function traversePositionHistory(
  history: PositionHistory,
  direction: -1 | 1,
): PositionHistoryTraversal | null {
  const index = history.index + direction;
  const target = history.entries[index];
  if (target === undefined) return null;
  return {
    history: { ...history, index, tail: 'settling' },
    target,
  };
}

/**
 * Reconcile transient positions with a new live corpus snapshot. Surviving
 * document identities keep their position; removed/empty documents disappear.
 */
export function reconcilePositionHistory(
  history: PositionHistory,
  snapshot: string,
  readyDocs: readonly string[],
  tokenCounts: ReadonlyMap<string, number>,
): PositionHistory {
  if (snapshot.length === 0 || history.entries.length === 0) {
    return EMPTY_POSITION_HISTORY;
  }
  const ready = new Set(readyDocs);
  const entries: PositionHistoryEntry[] = [];
  let index = -1;
  for (let oldIndex = 0; oldIndex < history.entries.length; oldIndex += 1) {
    const entry = history.entries[oldIndex]!;
    const tokenCount = tokenCounts.get(entry.doc);
    if (!ready.has(entry.doc) || (tokenCount !== undefined && tokenCount < 1)) continue;
    const candidate: PositionHistoryEntry = {
      ...entry,
      snapshot,
      token: tokenCount === undefined
        ? entry.token
        : Math.max(0, Math.min(tokenCount - 1, entry.token)),
    };
    const previous = entries.at(-1);
    if (within(previous, candidate, POSITION_HISTORY_NEAR_TOKENS)) {
      entries[entries.length - 1] = candidate;
    } else {
      entries.push(candidate);
    }
    if (oldIndex <= history.index) index = entries.length - 1;
  }
  if (entries.length === 0) return EMPTY_POSITION_HISTORY;
  return {
    entries,
    index: Math.max(0, Math.min(entries.length - 1, index)),
    tail: 'hardened',
  };
}

/**
 * Apply newly measured document extents inside one live snapshot. Unlike a
 * snapshot reconciliation, this must preserve the current tail contract so an
 * in-flight reading run or post-traversal landing refinement stays intact.
 */
export function clampPositionHistoryExtents(
  history: PositionHistory,
  tokenCounts: ReadonlyMap<string, number>,
): PositionHistory {
  if (history.entries.length === 0) return history;
  const entries: PositionHistoryEntry[] = [];
  let index = -1;
  let currentSurvived = false;
  let changed = false;
  for (let oldIndex = 0; oldIndex < history.entries.length; oldIndex += 1) {
    const entry = history.entries[oldIndex]!;
    const tokenCount = tokenCounts.get(entry.doc);
    if (tokenCount !== undefined && tokenCount < 1) {
      changed = true;
      continue;
    }
    const token = tokenCount === undefined
      ? entry.token
      : Math.max(0, Math.min(tokenCount - 1, entry.token));
    const candidate = token === entry.token ? entry : { ...entry, token };
    if (candidate !== entry) changed = true;
    entries.push(candidate);
    if (oldIndex <= history.index) index = entries.length - 1;
    if (oldIndex === history.index) currentSurvived = true;
  }
  if (entries.length === 0) return EMPTY_POSITION_HISTORY;
  const boundedIndex = Math.max(0, Math.min(entries.length - 1, index));
  if (!changed && boundedIndex === history.index) return history;
  return {
    entries,
    index: boundedIndex,
    tail: currentSurvived ? history.tail : 'hardened',
  };
}

export function previousPosition(
  history: PositionHistory,
): PositionHistoryEntry | null {
  return history.entries[history.index - 1] ?? null;
}

export function nextPosition(
  history: PositionHistory,
): PositionHistoryEntry | null {
  return history.entries[history.index + 1] ?? null;
}
