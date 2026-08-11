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
  defaultSeriesStyle,
  groupIdentity,
  SERIES_COLOR_IDS,
  SERIES_LINE_IDS,
  TERM_GROUP_LIMITS_V1,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
  type SeriesColorId,
  type SeriesLineId,
  type SeriesStyleV1,
} from '@texttrends/core';

// Durable admission lives in core. Keep this app module as the stable
// import boundary for UI code while retaining only app editing/style helpers.
export {
  EMPTY_NOTEBOOK,
  EXACT_MATCH,
  FOLDED_MATCH,
  NOTEBOOK_LIMITS_V1,
  coreGroupOf,
  defaultSeriesStyle,
  groupIdentity,
  groupTitle,
  memberSemanticKey,
  parseQueryNotebook,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
  type SeriesColorId,
  type SeriesLineId,
  type SeriesStyleV1,
} from '@texttrends/core';

export function styleSlotOf(style: { readonly color: string; readonly line: string }): number {
  const color = SERIES_COLOR_IDS.indexOf(style.color as never);
  const line = SERIES_LINE_IDS.indexOf(style.line as never);
  return color * SERIES_LINE_IDS.length + line;
}

export function styleOfSlot(slot: number): { readonly color: SeriesColorId; readonly line: SeriesLineId } {
  const safe = Math.max(0, Math.min(SERIES_COLOR_IDS.length * SERIES_LINE_IDS.length - 1, slot));
  return {
    color: SERIES_COLOR_IDS[Math.floor(safe / SERIES_LINE_IDS.length)]!,
    line: SERIES_LINE_IDS[safe % SERIES_LINE_IDS.length]!,
  };
}

export function styleKey(style: { readonly color: string; readonly line: string }): string {
  return `${style.color}|${style.line}`;
}

/** Present a legacy custom title in the unified comma-authored field. An
 * untouched save can still round-trip the legacy representation losslessly;
 * once the aliases are edited, the title becomes the first matching alias. */
export function aliasesForTermEditor(group: NotebookGroupV1): readonly string[] {
  if (!group.displayName) return group.aliases;
  return [
    group.displayName,
    ...group.aliases.filter((alias) => alias !== group.displayName),
  ];
}

/** Keep a legacy title lossless on a no-op/style-only save. Any actual edit
 * adopts the unified model, where the first authored alias is also the title. */
export function termAliasesForSave(
  group: NotebookGroupV1,
  aliases: readonly string[],
  aliasesTouched: boolean,
): { readonly aliases: readonly string[]; readonly displayName?: string } {
  return group.displayName && !aliasesTouched
    ? { aliases: group.aliases, displayName: group.displayName }
    : { aliases };
}

export function firstFreeStyle(groups: readonly NotebookGroupV1[], active: ReadonlySet<string>): SeriesStyleV1 {
  const taken = new Set(groups.filter((group) => active.has(group.id)).map((group) => styleKey(group.style)));
  // The first five terms should be distinguishable by color before line type
  // is needed as a secondary encoding.
  for (let index = 0; index < SERIES_COLOR_IDS.length; index++) {
    const style = defaultSeriesStyle(index);
    if (!taken.has(styleKey(style))) return style;
  }
  for (const color of SERIES_COLOR_IDS) {
    for (const line of SERIES_LINE_IDS) {
      if (!taken.has(styleKey({ color, line }))) return { color, line };
    }
  }
  return defaultSeriesStyle(groups.length);
}

/** Keep every active series visually distinguishable. Hidden terms retain
 * their authored style, but a term returning to the chart yields to active
 * survivors and receives the first available color/line combination. */
export function resolveActiveStyleCollisions(
  notebook: QueryNotebookV1,
  active: ReadonlySet<string>,
  previouslyActive: ReadonlySet<string> = new Set(),
): QueryNotebookV1 {
  let groups = [...notebook.groups];
  const taken = new Set<string>();
  let changed = false;
  const activeIndexes = groups
    .map((group, index) => active.has(group.id) ? index : -1)
    .filter((index) => index >= 0);
  const survivorIndexes = activeIndexes.filter((index) => previouslyActive.has(groups[index]!.id));
  const returningIndexes = activeIndexes.filter((index) => !previouslyActive.has(groups[index]!.id));
  for (const index of [...survivorIndexes, ...returningIndexes]) {
    const group = groups[index]!;
    const key = styleKey(group.style);
    if (!taken.has(key)) {
      taken.add(key);
      continue;
    }
    const style = firstFreeStyle(groups, active);
    groups[index] = { ...group, style };
    taken.add(styleKey(style));
    changed = true;
  }
  return changed ? { ...notebook, groups } : notebook;
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
  let existingIdentities: Set<string>;
  try {
    existingIdentities = new Set(existing.map(groupIdentity));
  } catch (e) {
    return { groups: null, error: e instanceof Error ? e.message : String(e) };
  }
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
      aliases: [label],
      exactMatch: false,
      countOverlaps: false,
      style: defaultSeriesStyle(existing.length + groups.length),
    };
    try {
      if (existingIdentities.has(groupIdentity(probe))) continue; // already in the notebook
      validateNotebookGroup(probe);
    } catch (e) {
      return { groups: null, error: e instanceof Error ? e.message : String(e) };
    }
    groups.push({ ...probe, id: newId() });
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
