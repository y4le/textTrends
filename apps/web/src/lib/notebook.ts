/**
 * The query notebook — the durable-SHAPED (but in slice 1 session-only) model
 * behind the term-group UI, per the recorded slice-1 planner ruling
 * (docs/design/term-groups-plan.md).
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
 * enter the wire spec. The schema string exists so the eventual durable/
 * share serialization (a later slice) starts versioned; nothing persists it
 * in slice 1 (ruling: a hand-authored notebook is class-1 user data — no ad
 * hoc localStorage/IDB stash beside the project store).
 */

import {
  exactArray,
  exactRecord,
  TERM_GROUP_LIMITS_V1,
  termGroupIdentity,
  validateGroup,
  type GroupMember,
  type MatchMode,
  type TermGroupSpec,
} from '@texttrends/core';

export interface NotebookGroupV1 {
  /** Stable UUID; never a match key (see module doc). */
  readonly id: string;
  /** Presentation text only — normalized NFC, rendered as text, never markup. */
  readonly name: string;
  readonly members: readonly GroupMember[];
  readonly countOverlaps: boolean;
}

export interface QueryNotebookV1 {
  readonly schema: 'texttrends/query-notebook/1';
  readonly groups: readonly NotebookGroupV1[];
}

/** App-level bounds beyond the core group limits. */
export const NOTEBOOK_LIMITS_V1 = {
  /** Groups the notebook may hold (distinct from the 5-active-track cap). */
  maxGroups: 64,
  /** Group display name, UTF-16 code units, after NFC normalization.
   *  DELIBERATELY equal to the core surface bound: quick-add names a group
   *  after its one term, so any legal term must be a legal name (review-B). */
  maxNameUnits: TERM_GROUP_LIMITS_V1.maxSurfaceUnits,
} as const;

/** The one quick-add / default match mode: folded case and diacritics. */
export const FOLDED_MATCH: MatchMode = { case: 'folded', diacritics: 'folded' };

export const EMPTY_NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/1',
  groups: [],
};

/** The core query spec for a notebook group — exactly the authored members;
 *  name/activation/solo are presentation and never reach the wire. */
export function coreGroupOf(g: NotebookGroupV1): TermGroupSpec {
  return { id: g.id, members: g.members, countOverlaps: g.countOverlaps };
}

/** App-side admission (ruling invariant 8): a group the app accepts must be
 *  EXACTLY a group the kernel accepts — core `validateGroup` plus the
 *  app-only rules (bounded NFC name, no duplicate semantic members). Throws
 *  RangeError with a user-presentable message. */
export function validateNotebookGroup(g: NotebookGroupV1): void {
  if (g.name.trim().length === 0 || g.name !== g.name.normalize('NFC')) {
    throw new RangeError('a group needs a nonblank NFC-normalized name');
  }
  if (g.name.length > NOTEBOOK_LIMITS_V1.maxNameUnits) {
    throw new RangeError(`a group name is at most ${NOTEBOOK_LIMITS_V1.maxNameUnits} characters`);
  }
  validateGroup(coreGroupOf(g));
  // No duplicate semantic members within one authored group: two members that
  // differ only by id would double-report every occurrence under
  // countOverlaps and confuse the editor's member list.
  const seen = new Set<string>();
  for (const m of g.members) {
    const key = memberSemanticKey(m);
    if (seen.has(key)) throw new RangeError('two members of this group match identically');
    seen.add(key);
  }
}

/** Semantic key for ONE member — the core matching identity of a synthetic
 *  single-member group, so this can never drift from `termGroupIdentity`
 *  (member order is a GROUP concern, absent from a single member's key). */
export function memberSemanticKey(m: GroupMember): string {
  return termGroupIdentity({ id: 'm', members: [m], countOverlaps: false });
}

/** The canonical MATCHING identity of a notebook group (core authority). */
export function groupIdentity(g: NotebookGroupV1): string {
  return termGroupIdentity(coreGroupOf(g));
}

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

/**
 * Replacement-mode reconcile for the comma input (transitional: commit B
 * keeps the input's replace-everything semantics; commit C makes it
 * append-only). Each label becomes a single-token folded group; a previous
 * group with the SAME matching identity is reused wholesale (its UUID,
 * member ids, and thus focus/style/concordance ownership survive an
 * ordinary edit), claimed at most once. Everything unclaimed is dropped.
 */
export function replaceWithQuickAdd(
  prev: QueryNotebookV1,
  labels: readonly string[],
  newId: () => string,
): QueryNotebookV1 {
  const claimed = new Set<string>();
  const groups = labels.map((label): NotebookGroupV1 => {
    const fresh: NotebookGroupV1 = {
      id: '',
      name: label.normalize('NFC'),
      members: [{ id: 'm', kind: 'token', surface: label, match: FOLDED_MATCH }],
      countOverlaps: false,
    };
    const identity = groupIdentity(fresh);
    const survivor = prev.groups.find((g) => !claimed.has(g.id) && groupIdentity(g) === identity);
    if (survivor) {
      claimed.add(survivor.id);
      return survivor;
    }
    const minted: NotebookGroupV1 = { ...fresh, id: newId(), members: [{ ...fresh.members[0]!, id: newId() }] };
    // Every CONSTRUCTED group passes the same admission the editor enforces
    // (review-B): with the name bound aligned to the surface bound this
    // cannot fire for input parseSeries accepted, but the invariant is
    // asserted, not assumed.
    validateNotebookGroup(minted);
    return minted;
  });
  return { schema: 'texttrends/query-notebook/1', groups };
}

/**
 * The versioned WHOLE-NOTEBOOK runtime validator (ruling §2: the codec is
 * defined in slice 1 even though persistence is deferred — the eventual
 * durable/share serialization starts from this admission, never from a
 * TypeScript-only trust). Narrows `unknown`: schema discriminant, dense
 * bounded groups array, unique group UUIDs, and full per-group admission
 * (shape here, then `validateNotebookGroup` for semantics). Throws
 * RangeError; returns the value TYPED on success.
 */
export function parseQueryNotebook(value: unknown): QueryNotebookV1 {
  if (!exactRecord(value, ['schema', 'groups'])) throw new RangeError('a notebook must be an exact {schema, groups} record');
  if (value.schema !== 'texttrends/query-notebook/1') throw new RangeError('unknown notebook schema');
  const groups = value.groups;
  // Cap BEFORE any per-element scan (an untrusted persisted/shared value must
  // not buy unbounded work with a huge array), then exact-own-element density.
  if (!Array.isArray(groups) || groups.length > NOTEBOOK_LIMITS_V1.maxGroups) {
    throw new RangeError(`a notebook holds at most ${NOTEBOOK_LIMITS_V1.maxGroups} groups`);
  }
  if (!exactArray(groups, groups.length)) throw new RangeError('notebook groups must be a dense plain array');
  const ids = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    const g: unknown = groups[i];
    if (!exactRecord(g, ['id', 'name', 'members', 'countOverlaps'])) {
      throw new RangeError(`group ${i} must be an exact {id, name, members, countOverlaps} record`);
    }
    if (typeof g.id !== 'string' || typeof g.name !== 'string' || typeof g.countOverlaps !== 'boolean') {
      throw new RangeError(`group ${i} has a malformed id/name/countOverlaps`);
    }
    if (ids.has(g.id)) throw new RangeError(`duplicate group id '${g.id.slice(0, 32)}'`);
    ids.add(g.id);
    const members = g.members;
    if (!Array.isArray(members) || members.length > TERM_GROUP_LIMITS_V1.maxMembers) {
      throw new RangeError(`group ${i} must have at most ${TERM_GROUP_LIMITS_V1.maxMembers} members`);
    }
    if (!exactArray(members, members.length)) throw new RangeError(`group ${i} members must be a dense plain array`);
    for (let j = 0; j < members.length; j++) {
      if (!isGroupMemberShape(members[j])) throw new RangeError(`group ${i} member ${j} is malformed`);
    }
    // Shape proven — EXACT own-data plain records throughout, so the value
    // survives structured clone verbatim (review-B round 2). Semantic
    // admission is the SAME authority the editor uses.
    validateNotebookGroup(g as unknown as NotebookGroupV1);
  }
  return value as unknown as QueryNotebookV1;
}

const MEMBER_MODES = new Set<unknown>(['sensitive', 'folded']);

function isGroupMemberShape(m: unknown): boolean {
  if (!exactRecord(m, ['id', 'kind', 'surface', 'match'])
    && !exactRecord(m, ['id', 'kind', 'surfaces', 'match', 'crossSentence'])
    && !exactRecord(m, ['id', 'kind', 'stem', 'match'])) return false;
  const r = m as { id?: unknown; kind?: unknown; match?: unknown; surface?: unknown; surfaces?: unknown; stem?: unknown; crossSentence?: unknown };
  if (typeof r.id !== 'string') return false;
  if (!exactRecord(r.match, ['case', 'diacritics'])) return false;
  const match = r.match as { case?: unknown; diacritics?: unknown };
  if (!MEMBER_MODES.has(match.case) || !MEMBER_MODES.has(match.diacritics)) return false;
  switch (r.kind) {
    case 'token': return typeof r.surface === 'string' && r.surfaces === undefined && r.stem === undefined;
    case 'phrase': {
      if (typeof r.crossSentence !== 'boolean') return false;
      const s = r.surfaces;
      // Cap BEFORE the per-element scan, then exact dense elements.
      if (!Array.isArray(s) || s.length > TERM_GROUP_LIMITS_V1.maxPhraseSurfaces) return false;
      if (!exactArray(s, s.length)) return false;
      for (let i = 0; i < s.length; i++) if (typeof s[i] !== 'string') return false;
      return true;
    }
    case 'prefix':
    case 'suffix': return typeof r.stem === 'string' && r.surface === undefined && r.surfaces === undefined;
    default: return false;
  }
}

export interface QuickAddRefusal {
  readonly groups: null;
  readonly error: string;
}

/** Parse the quick-add comma input into single-token folded groups (ruling
 *  §3): each distinct term (NFC, first spelling wins) becomes a named group
 *  with one token member. Comparison against existing names/semantics is the
 *  caller's job (the store reconciles); this is the pure text → groups step.
 *  Refusal (over-limit) is explicit and atomic — never a partial batch. */
export function parseQuickAdd(
  input: string,
  newId: () => string,
  room: number,
): { readonly groups: readonly NotebookGroupV1[]; readonly error: null } | QuickAddRefusal {
  const labels: string[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim().normalize('NFC');
    if (label === '') continue;
    if (labels.includes(label)) continue;
    labels.push(label);
  }
  if (labels.length > room) {
    return { groups: null, error: `only room for ${room} more group${room === 1 ? '' : 's'}` };
  }
  const over = labels.find((l) => l.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
  if (over !== undefined) {
    return { groups: null, error: `“${over.slice(0, 24)}…” is too long for one term` };
  }
  const groups = labels.map((label): NotebookGroupV1 => ({
    id: newId(),
    name: label,
    members: [{ id: newId(), kind: 'token', surface: label, match: FOLDED_MATCH }],
    countOverlaps: false,
  }));
  // Constructed groups pass the same admission the editor enforces; a
  // violation is an explicit refusal, never an invalid adopted notebook.
  try {
    for (const g of groups) validateNotebookGroup(g);
  } catch (e) {
    return { groups: null, error: e instanceof Error ? e.message : String(e) };
  }
  return { groups, error: null };
}
