/**
 * The query notebook behind the term-group UI.
 *
 * Two identities with different jobs (ruling invariant 1):
 * - `NotebookGroupV1.id` is a stable UUID — pure UI/notebook identity. Rename
 *   and semantic edits preserve it; focus, style ownership, selection, and
 *   editor state key on it.
 * - `termGroupIdentity(coreGroupOf(g))` is the MATCHING identity. Worker
 *   caches and stale-result admission key on it; name/mute/style never
 *   affect it.
 *
 * The notebook is presentation + authoring state; the core query spec is
 * derived per issue via `coreGroupOf`. `name`, activation, and solo NEVER
 * enter the wire spec. The versioned schema is persisted inside the one
 * browser-local workspace.
 */

import {
  FOLDED_MATCH,
  groupIdentity,
  TERM_GROUP_LIMITS_V1,
  validateNotebookGroup,
  type NotebookGroupV1,
} from '@texttrends/core';

// Durable admission lives in core. Keep this app module as the stable
// import boundary for UI code while retaining only app editing/style helpers.
export {
  EMPTY_NOTEBOOK,
  FOLDED_MATCH,
  NOTEBOOK_LIMITS_V1,
  coreGroupOf,
  groupIdentity,
  memberSemanticKey,
  parseQueryNotebook,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
} from '@texttrends/core';

/**
 * Style-slot ownership for a new ACTIVE order (ruling invariants 2/5/6).
 * Three tiers, in strict precedence:
 * 1. SURVIVORS — groups active both before and after — keep their slots
 *    unconditionally (a new activation must never steal a survivor's colour).
 * 2. RETURNING/NEW actives take their prior slot if free, else lowest-free.
 *    A muted group whose retained slot was claimed while it was away is
 *    simply reassigned on return.
 * 3. NON-active owners retain their entries (mute preserves style identity)
 *    but never block an active claim.
 * With ≤5 actives the result stays within slots 0–4. Entries for ids absent
 * from `retain` are dropped (removal frees style ownership).
 */
export function reconcileStyleSlots(
  prev: ReadonlyMap<string, number>,
  activeInOrder: readonly string[],
  retain: ReadonlySet<string>,
  prevActive: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, slot] of prev) if (retain.has(id) && !activeInOrder.includes(id)) next.set(id, slot);
  const taken = new Set<number>();
  // Tier 1: pin SURVIVORS (active before AND after) — they outrank everyone,
  // including a returning muted owner whose retained slot now collides
  // (review-B finding: [b,a,c] order must not let returning b displace c).
  for (const id of activeInOrder) {
    const prior = prev.get(id);
    if (prevActive.has(id) && prior !== undefined && !taken.has(prior)) {
      taken.add(prior);
      next.set(id, prior);
    }
  }
  // Tier 2: returning/new actives — prior slot if free, else lowest-free.
  for (const id of activeInOrder) {
    if (next.has(id)) continue; // pinned as a survivor
    const prior = prev.get(id);
    let slot: number;
    if (prior !== undefined && !taken.has(prior)) {
      slot = prior;
    } else {
      slot = 0;
      while (taken.has(slot)) slot++;
    }
    taken.add(slot);
    next.set(id, slot);
  }
  return next;
}

export interface QuickAddRefusal {
  readonly groups: null;
  readonly error: string;
}

/** Parse the quick-add comma input into APPENDED single-token folded groups
 *  (ruling §3: append-only, subordinate to the notebook). Each distinct term
 *  (NFC) becomes a named group with one token member; a term whose matching
 *  identity ALREADY exists in the notebook is skipped (it adds nothing, like
 *  the input's own dedup). Refusal (a batch larger than `room`) is explicit
 *  and ATOMIC — never a partial add, never a partial activation. */
export function parseQuickAdd(
  input: string,
  newId: () => string,
  room: number,
  existing: readonly NotebookGroupV1[],
): { readonly groups: readonly NotebookGroupV1[]; readonly error: null } | QuickAddRefusal {
  const existingIdentities = new Set(existing.map(groupIdentity));
  const labels: string[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim().normalize('NFC');
    if (label === '') continue;
    if (labels.includes(label)) continue;
    labels.push(label);
  }
  const over = labels.find((l) => l.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
  if (over !== undefined) {
    return { groups: null, error: `“${over.slice(0, 24)}…” is too long for one term` };
  }
  const groups: NotebookGroupV1[] = [];
  for (const label of labels) {
    // Identity excludes the caller-owned ids, so probe BEFORE minting —
    // skipped duplicates must not consume (deterministic test) ids.
    const probe: NotebookGroupV1 = {
      id: 'probe',
      name: label,
      members: [{ id: 'm', kind: 'token', surface: label, match: FOLDED_MATCH }],
      countOverlaps: false,
    };
    if (existingIdentities.has(groupIdentity(probe))) continue; // already in the notebook
    groups.push({ ...probe, id: newId(), members: [{ ...probe.members[0]!, id: newId() }] });
  }
  if (groups.length > room) {
    return { groups: null, error: `only room for ${room} more group${room === 1 ? '' : 's'}` };
  }
  // Constructed groups pass the same admission the editor enforces; a
  // violation is an explicit refusal, never an invalid adopted notebook.
  try {
    for (const g of groups) validateNotebookGroup(g);
  } catch (e) {
    return { groups: null, error: e instanceof Error ? e.message : String(e) };
  }
  return { groups, error: null };
}
