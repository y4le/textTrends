/**
 * Structure section records and invariants — contract §12.2.
 *
 * Persisted records are char-anchored and carry a LINEAGE-STABLE key, never
 * a project id (the artifact is text-keyed and reusable across project docs;
 * the project-bound Section view derives ids at bind time — §12.2). The
 * invariant checker below is the single admission gate every produced or
 * loaded table passes before it can key an artifact or bind to a snapshot.
 */

export type SectionOrigin = 'source' | 'heuristic' | 'user' | 'fixed';

export interface CharRange {
  readonly start: number;
  readonly end: number;
}

/** A persisted section record (§12.2 StructureSectionRecordV2). */
export interface StructureSectionRecordV2 {
  readonly key: string;
  readonly origin: SectionOrigin;
  readonly parent?: string;
  readonly level: number;
  readonly title?: string;
  readonly chars: CharRange;
}

import { STRUCTURE_LIMITS_V0 } from '../contract/structure-limits.ts';

export const ROOT_KEY = 'root';
/** Titles are bounded so a hostile/huge heading cannot bloat a record. */
export const MAX_TITLE_LENGTH = STRUCTURE_LIMITS_V0.maxTitleUtf16;
const SECTION_ORIGINS: ReadonlySet<string> = new Set(['source', 'heuristic', 'user', 'fixed']);

/** Structural validation failure — maps to REQUEST_INVALID / ARTIFACT_CORRUPT
 *  depending on whether the table came from the wire or from storage. */
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}

/** A section-table SIZE violation specifically — a subclass so the worker can
 *  map it to CAP_EXCEEDED while ordinary StructureErrors map to REQUEST_INVALID
 *  (planner ruling §5). */
export class StructureCapError extends StructureError {
  constructor(message: string) {
    super(message);
    this.name = 'StructureCapError';
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Validate a section table against every §12.2 invariant and return it in
 * the canonical order: root first, then depth-first by char start, key as
 * the final tie-breaker. Throws StructureError on any violation. `textLength`
 * bounds all offsets.
 */
export function validateSectionTable(
  sections: readonly StructureSectionRecordV2[],
  textLength: number,
): readonly StructureSectionRecordV2[] {
  if (!isInt(textLength) || textLength < 0) {
    throw new StructureError(`invalid text length ${textLength}`);
  }
  if (sections.length === 0) throw new StructureError('section table is empty');
  // Table size is capped regardless of validation cost (the sweep below is
  // O(n log n), but the cap is a §12.2 contract, not a perf guard).
  if (sections.length > STRUCTURE_LIMITS_V0.maxSectionsPerTable) {
    throw new StructureCapError(
      `section table has ${sections.length} sections, over the ${STRUCTURE_LIMITS_V0.maxSectionsPerTable} cap`,
    );
  }

  const byKey = new Map<string, StructureSectionRecordV2>();
  for (const s of sections) {
    if (typeof s.key !== 'string' || s.key === '') throw new StructureError('section key must be a non-empty string');
    if (s.key.length > STRUCTURE_LIMITS_V0.maxLineageKeyUtf16) {
      throw new StructureError(`section key '${s.key.slice(0, 16)}…' exceeds the ${STRUCTURE_LIMITS_V0.maxLineageKeyUtf16}-unit cap`);
    }
    if (byKey.has(s.key)) throw new StructureError(`duplicate section key '${s.key}'`);
    byKey.set(s.key, s);
  }

  const root = byKey.get(ROOT_KEY);
  if (!root) throw new StructureError("table has no 'root' section");
  if (root.origin !== 'fixed' || root.level !== 0 || root.parent !== undefined) {
    throw new StructureError('root must be origin=fixed, level 0, no parent');
  }
  if (root.chars.start !== 0 || root.chars.end !== textLength) {
    throw new StructureError(`root range must be [0, ${textLength})`);
  }

  for (const s of sections) {
    if (!SECTION_ORIGINS.has(s.origin)) {
      throw new StructureError(`section '${s.key}' has unknown origin '${String(s.origin)}'`);
    }
    if (!isInt(s.chars.start) || !isInt(s.chars.end)) {
      throw new StructureError(`section '${s.key}' has non-integer offsets`);
    }
    // Empty NON-ROOT ranges are rejected in v1 (§12.2); the root of an empty
    // document is legitimately [0, 0) and is exempted (its exact range was
    // already validated above).
    const emptyAllowed = s.key === ROOT_KEY;
    if (
      s.chars.start < 0 || s.chars.end > textLength ||
      (emptyAllowed ? s.chars.start > s.chars.end : s.chars.start >= s.chars.end)
    ) {
      throw new StructureError(`section '${s.key}' range [${s.chars.start}, ${s.chars.end}) is invalid`);
    }
    if (!isInt(s.level) || s.level < 0) throw new StructureError(`section '${s.key}' has invalid level ${s.level}`);
    if (s.title !== undefined) {
      if (typeof s.title !== 'string' || s.title.length > MAX_TITLE_LENGTH || !s.title.isWellFormed()) {
        throw new StructureError(`section '${s.key}' has an invalid title`);
      }
    }
    if (s.key !== ROOT_KEY && s.parent === undefined) {
      throw new StructureError(`non-root section '${s.key}' has no parent`);
    }
  }

  // Parent graph: every parent exists; acyclic; child range contained in its
  // direct parent. One memoized walk per node (O(n) total): each chain is
  // followed only until it reaches an already-resolved key, and every chain
  // terminates at root (a non-root without a parent was rejected above).
  // Depths feed the sweep's sort below.
  const depth = new Map<string, number>([[ROOT_KEY, 0]]);
  for (const s of sections) {
    if (!depth.has(s.key)) {
      const chain: StructureSectionRecordV2[] = [];
      const onChain = new Set<string>();
      let cur: StructureSectionRecordV2 = s;
      while (!depth.has(cur.key)) {
        if (onChain.has(cur.key)) throw new StructureError(`section '${s.key}' is in a parent cycle`);
        onChain.add(cur.key);
        chain.push(cur);
        const parent = byKey.get(cur.parent!);
        if (!parent) throw new StructureError(`section '${cur.key}' references missing parent '${cur.parent}'`);
        cur = parent;
      }
      let d = depth.get(cur.key)!;
      for (let i = chain.length - 1; i >= 0; i--) {
        d += 1;
        depth.set(chain[i]!.key, d);
      }
    }
    if (s.parent !== undefined) {
      const parent = byKey.get(s.parent)!;
      if (s.chars.start < parent.chars.start || s.chars.end > parent.chars.end) {
        throw new StructureError(`section '${s.key}' is not contained in parent '${s.parent}'`);
      }
    }
  }

  // O(1) declared-ancestry via DFS entry/exit intervals over the parent
  // graph (iterative — a legal chain can be `maxSectionsPerTable` deep).
  const children = new Map<string, StructureSectionRecordV2[]>();
  for (const s of sections) {
    if (s.parent === undefined) continue;
    (children.get(s.parent) ?? children.set(s.parent, []).get(s.parent)!).push(s);
  }
  const tin = new Map<string, number>();
  const tout = new Map<string, number>();
  {
    let clock = 0;
    const work: { key: string; entered: boolean }[] = [{ key: ROOT_KEY, entered: false }];
    while (work.length > 0) {
      const frame = work.pop()!;
      if (frame.entered) {
        tout.set(frame.key, ++clock);
        continue;
      }
      tin.set(frame.key, ++clock);
      work.push({ key: frame.key, entered: true });
      for (const child of children.get(frame.key) ?? []) work.push({ key: child.key, entered: false });
    }
  }
  const isDeclaredAncestor = (ancestor: StructureSectionRecordV2, node: StructureSectionRecordV2): boolean =>
    tin.get(ancestor.key)! < tin.get(node.key)! && tout.get(node.key)! <= tout.get(ancestor.key)!;

  // Non-ancestor records must be disjoint (half-open). Sweep in (start asc,
  // end desc, depth asc, key) order with a stack of still-open ranges: the
  // stack is always a declared-ancestor chain (each push is verified against
  // the then-innermost), so the pairwise invariant reduces to "each section
  // fits inside the innermost open range AND that range is a declared
  // ancestor" — geometric containment alone is NOT acceptance (a contained
  // non-ancestor is still 'overlap without nesting'). O(n log n) for the
  // sort; the old check was O(n² × chain depth) and took ~17 s at the
  // 2,048-section cap on valid input.
  const sweep = [...sections].sort(
    (a, b) =>
      a.chars.start - b.chars.start ||
      b.chars.end - a.chars.end ||
      depth.get(a.key)! - depth.get(b.key)! ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const open: StructureSectionRecordV2[] = [];
  for (const s of sweep) {
    while (open.length > 0 && open[open.length - 1]!.chars.end <= s.chars.start) open.pop();
    if (open.length > 0) {
      const top = open[open.length - 1]!;
      if (s.chars.end > top.chars.end || !isDeclaredAncestor(top, s)) {
        throw new StructureError(`sections '${top.key}' and '${s.key}' overlap without nesting`);
      }
    }
    open.push(s);
  }

  return canonicalOrder(sections, byKey);
}

/** Root first, then depth-first by (char start, key). */
export function canonicalOrder(
  sections: readonly StructureSectionRecordV2[],
  byKey: ReadonlyMap<string, StructureSectionRecordV2>,
): readonly StructureSectionRecordV2[] {
  const children = new Map<string, StructureSectionRecordV2[]>();
  for (const s of sections) {
    if (s.parent === undefined) continue;
    (children.get(s.parent) ?? children.set(s.parent, []).get(s.parent)!).push(s);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.chars.start - b.chars.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  const out: StructureSectionRecordV2[] = [];
  const walk = (key: string): void => {
    out.push(byKey.get(key)!);
    for (const child of children.get(key) ?? []) walk(child.key);
  };
  walk(ROOT_KEY);
  if (out.length !== sections.length) {
    // A record not reachable from root (its parent chain never hits root).
    throw new StructureError('table contains sections unreachable from root');
  }
  return out;
}
