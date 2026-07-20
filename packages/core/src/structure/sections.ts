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

export const ROOT_KEY = 'root';
/** Titles are bounded so a hostile/huge heading cannot bloat a record. */
export const MAX_TITLE_LENGTH = 512;
const SECTION_ORIGINS: ReadonlySet<string> = new Set(['source', 'heuristic', 'user', 'fixed']);

/** Structural validation failure — maps to REQUEST_INVALID / ARTIFACT_CORRUPT
 *  depending on whether the table came from the wire or from storage. */
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
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

  const byKey = new Map<string, StructureSectionRecordV2>();
  for (const s of sections) {
    if (typeof s.key !== 'string' || s.key === '') throw new StructureError('section key must be a non-empty string');
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

  // Parent graph: every parent exists; acyclic; child range contained in
  // parent (walking to root proves acyclicity by bounded depth).
  for (const s of sections) {
    if (s.parent === undefined) continue;
    const seen = new Set<string>([s.key]);
    let cur: StructureSectionRecordV2 | undefined = s;
    while (cur && cur.parent !== undefined) {
      const parent = byKey.get(cur.parent);
      if (!parent) throw new StructureError(`section '${cur.key}' references missing parent '${cur.parent}'`);
      if (seen.has(parent.key)) throw new StructureError(`section '${s.key}' is in a parent cycle`);
      seen.add(parent.key);
      cur = parent;
    }
    const parent = byKey.get(s.parent)!;
    if (s.chars.start < parent.chars.start || s.chars.end > parent.chars.end) {
      throw new StructureError(`section '${s.key}' is not contained in parent '${s.parent}'`);
    }
  }

  // Non-ancestor records must be disjoint (half-open). Check every ordered
  // pair once: two sections either nest (one's range contains the other's)
  // or are disjoint; a partial overlap is illegal.
  const isAncestor = (maybeAncestor: string, node: StructureSectionRecordV2): boolean => {
    let cur: StructureSectionRecordV2 | undefined = node;
    while (cur && cur.parent !== undefined) {
      if (cur.parent === maybeAncestor) return true;
      cur = byKey.get(cur.parent);
    }
    return false;
  };
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i]!;
      const b = sections[j]!;
      const overlap = a.chars.start < b.chars.end && b.chars.start < a.chars.end;
      if (!overlap) continue;
      const nested = isAncestor(a.key, b) || isAncestor(b.key, a);
      if (!nested) {
        throw new StructureError(`sections '${a.key}' and '${b.key}' overlap without nesting`);
      }
    }
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
