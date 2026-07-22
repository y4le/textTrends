/**
 * Structure building — contract §12.2/§12.3. Turns extraction candidates
 * into a validated section hierarchy under a provisional structure recipe,
 * applies the user's declarative override, and produces StructureArtifactV2.
 *
 * The recipe's evidence order is [extraction-candidates, chapter-heading]:
 * markdown headings (from extraction) rank first; a conservative English
 * Chapter/Book/Part scan over the extracted text fills a doc that carries no
 * markdown candidates. Both feed ONE outline; sections start at a heading and
 * end at the next heading of equal-or-higher outline rank, or document end.
 */

import { canonicalJson, sha256Hex } from '../contract/hash.ts';
import { exactArray, exactRecord } from '../contract/recipes.ts';
import type { StructureCandidateV1 } from '../extract/markdown.ts';
import { STRUCTURE_LIMITS_V0 } from '../contract/structure-limits.ts';
import {
  ROOT_KEY,
  StructureError,
  validateSectionTable,
  type CharRange,
  type SectionOrigin,
  type StructureSectionRecordV2,
} from './sections.ts';

export interface StructureRecipeProvisional {
  readonly schema: 'texttrends/structure-recipe/0-provisional';
  readonly root: 'whole-extracted-text-v1';
  readonly evidenceOrder: readonly ['extraction-candidates', 'english-chapter-heading-v1'];
  readonly chapterHeading: {
    readonly id: 'english-chapter-heading-v1';
    readonly linePolicy: 'unicode-lines-preserve-offsets-v1';
    readonly numerals: 'arabic-or-validated-roman-v1';
    readonly labels: readonly ['part', 'book', 'chapter'];
  };
}

export const DEFAULT_STRUCTURE_RECIPE: StructureRecipeProvisional = {
  schema: 'texttrends/structure-recipe/0-provisional',
  root: 'whole-extracted-text-v1',
  evidenceOrder: ['extraction-candidates', 'english-chapter-heading-v1'],
  chapterHeading: {
    id: 'english-chapter-heading-v1',
    linePolicy: 'unicode-lines-preserve-offsets-v1',
    numerals: 'arabic-or-validated-roman-v1',
    labels: ['part', 'book', 'chapter'],
  },
};

export async function hashStructureRecipe(recipe: StructureRecipeProvisional): Promise<string> {
  return sha256Hex(canonicalJson(recipe as unknown as Parameters<typeof canonicalJson>[0]));
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Total structural validation of a StructureRecipeProvisional — closed
 *  enums and EXACT key sets at every level (an extra field would hash into a
 *  novel identity the builder never implements — same discipline as the
 *  extraction/index validators). */
export function isStructureRecipeProvisional(v: unknown): v is StructureRecipeProvisional {
  if (!exactRecord(v, ['schema', 'root', 'evidenceOrder', 'chapterHeading'])) return false;
  if (v.schema !== 'texttrends/structure-recipe/0-provisional' || v.root !== 'whole-extracted-text-v1') return false;
  // The identity-bearing tuples must be DENSE arrays with no smuggled named
  // properties (structuredClone preserves them; canonical hashing rejects).
  if (!exactArray(v.evidenceOrder, 2)) return false;
  if (v.evidenceOrder[0] !== 'extraction-candidates' || v.evidenceOrder[1] !== 'english-chapter-heading-v1') return false;
  const c = v.chapterHeading;
  return (
    exactRecord(c, ['id', 'linePolicy', 'numerals', 'labels']) &&
    c.id === 'english-chapter-heading-v1' && c.linePolicy === 'unicode-lines-preserve-offsets-v1' &&
    c.numerals === 'arabic-or-validated-roman-v1' &&
    exactArray(c.labels, 3) && c.labels[0] === 'part' && c.labels[1] === 'book' && c.labels[2] === 'chapter'
  );
}

/** A complete SectionValue held to the same plain/exact discipline as the
 *  recipes: required level+chars, optional parent/title, and NOTHING else —
 *  built from the present optional fields so exactRecord enforces the plain
 *  prototype, enumerable data descriptors, and no symbols/accessors/inherited
 *  keys (a value inheriting level/chars from a custom prototype would hash
 *  outside the canonical domain). */
function isSectionValue(v: unknown): v is SectionValue {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys: string[] = ['level', 'chars'];
  if (Object.prototype.hasOwnProperty.call(v, 'parent')) keys.push('parent');
  if (Object.prototype.hasOwnProperty.call(v, 'title')) keys.push('title');
  if (!exactRecord(v, keys)) return false;
  const r = v as Record<string, unknown>;
  if (r.parent !== undefined && typeof r.parent !== 'string') return false;
  if (r.title !== undefined && typeof r.title !== 'string') return false;
  if (!isInt(r.level) || (r.level as number) < 0) return false;
  return exactRecord(r.chars, ['start', 'end']) &&
    isInt(r.chars.start) && isInt(r.chars.end) && (r.chars.start as number) >= 0 && (r.chars.start as number) < (r.chars.end as number);
}

/**
 * Total validation of a StructureOverrideV1, with EXACT keys at the override
 * and change levels, complete section values on add/replace, and rejection
 * of duplicate targets — so a wire caller cannot hand applyOverride a value
 * it will crash dereferencing, nor hash an extra field into a distinct
 * identity for an identical operation. Does not check that targets exist
 * against a table (applyOverride's job once the base is known).
 */
export function isStructureOverrideV1(v: unknown): v is StructureOverrideV1 {
  if (!exactRecord(v, ['schema', 'text', 'candidates', 'baseRecipe', 'changes'])) return false;
  if (v.schema !== 'texttrends/structure-override/1') return false;
  if (typeof v.text !== 'string' || typeof v.candidates !== 'string' || typeof v.baseRecipe !== 'string') return false;
  if (!Array.isArray(v.changes)) return false;
  const seen = new Set<string>();
  for (const c of v.changes) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return false;
    const rec = c as Record<string, unknown>;
    let key: string;
    if (rec.op === 'remove') {
      if (!exactRecord(rec, ['op', 'target']) || typeof rec.target !== 'string') return false;
      key = rec.target;
    } else if (rec.op === 'replace') {
      if (!exactRecord(rec, ['op', 'target', 'value']) || typeof rec.target !== 'string' || !isSectionValue(rec.value)) return false;
      key = rec.target;
    } else if (rec.op === 'add') {
      if (!exactRecord(rec, ['op', 'key', 'value']) || typeof rec.key !== 'string' || !isSectionValue(rec.value)) return false;
      key = rec.key;
    } else {
      return false;
    }
    if (seen.has(key)) return false; // canonical: one change per target/key
    seen.add(key);
  }
  return true;
}

/** An outline entry BEFORE range closing: a heading at a char anchor with a
 *  rank (smaller = higher in the outline, so it ends larger-rank spans). */
interface Heading {
  readonly anchor: number;   // char offset the section starts at
  readonly rank: number;     // outline rank; part<book<chapter or md level
  readonly title: string;
  readonly origin: SectionOrigin;
}

const LABEL_RANK: Record<string, number> = { part: 1, book: 2, chapter: 3 };
// Conservative: label, a separator, a numeral (arabic or validated roman),
// optionally a title after a period/colon/dash. Line-anchored, case-folded.
const CHAPTER_RE =
  /^[ \t]*(part|book|chapter)\b[ \t]+([0-9]{1,4}|[ivxlcdm]{1,15})\b[ \t]*(?:[.:—–-][ \t]*(.*\S))?[ \t]*$/i;
const ROMAN_RE = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

function validRoman(s: string): boolean {
  return s.length > 0 && ROMAN_RE.test(s) && s.toLowerCase() !== '';
}

/** Unicode line boundaries the recipe's linePolicy names — LF, CR, CRLF,
 *  NEL (U+0085), LS (U+2028), PS (U+2029) — preserving exact UTF-16 anchors.
 *  Yields [lineStart, lineEnd) spans (terminator excluded). */
function* unicodeLines(text: string): Generator<{ start: number; end: number }> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isBreak = c === 0x0a || c === 0x0d || c === 0x85 || c === 0x2028 || c === 0x2029;
    if (!isBreak) continue;
    yield { start, end: i };
    // CRLF is one terminator.
    if (c === 0x0d && i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  yield { start, end: text.length };
}

/** English Chapter/Book/Part scan over the extracted text (line-anchored,
 *  offsets preserved). Skips nothing — the caller decides precedence. */
export function scanChapterHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  for (const { start: lineStart, end } of unicodeLines(text)) {
    const line = text.slice(lineStart, end);
    const m = CHAPTER_RE.exec(line);
    if (!m) continue;
    const numeral = m[2]!;
    const isArabic = /^[0-9]+$/.test(numeral);
    if (!isArabic && !validRoman(numeral)) continue;
    const label = m[1]!.toLowerCase();
    const titleTail = m[3]?.trim();
    headings.push({
      anchor: lineStart,
      rank: LABEL_RANK[label]!,
      title: titleTail ? `${capitalize(label)} ${numeral}. ${titleTail}` : `${capitalize(label)} ${numeral}`,
      origin: 'heuristic',
    });
  }
  return headings;
}

/** Truncate to at most `maxUnits` UTF-16 code units WITHOUT splitting a
 *  surrogate pair (which would produce ill-formed text the invariant checker
 *  rejects — review finding). */
export function boundTitle(title: string, maxUnits = 512): string {
  if (title.length <= maxUnits) return title;
  let cut = maxUnits;
  const code = title.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't leave a lone high surrogate
  return title.slice(0, cut);
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Build the DETECTED section table (before overrides) from extraction
 * candidates and the recipe, over the extracted text. Markdown candidates
 * win when present (evidence order); otherwise the chapter scan is used.
 * Deterministic keys: 'sec-<zero-padded index in anchor order>'.
 */
export function buildDetectedSections(
  text: string,
  candidates: readonly StructureCandidateV1[],
  recipe: StructureRecipeProvisional,
): readonly StructureSectionRecordV2[] {
  const textLength = text.length;
  const headings: Heading[] =
    candidates.length > 0
      ? candidates.map((c) => ({ anchor: c.chars.start, rank: c.level, title: c.title, origin: 'source' as const }))
      : recipe.evidenceOrder.includes('english-chapter-heading-v1')
        ? scanChapterHeadings(text)
        : [];

  // Anchor order; ties broken by rank (higher outline first) then title.
  const ordered = [...headings].sort(
    (a, b) => a.anchor - b.anchor || a.rank - b.rank || (a.title < b.title ? -1 : 1),
  );
  // Drop a heading anchored at 0 duplicating the root boundary only if it
  // would create an empty range; otherwise sections start at their heading.
  const sections: StructureSectionRecordV2[] = [
    { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: textLength } },
  ];
  const stack: { key: string; rank: number }[] = []; // open sections by rank
  ordered.forEach((h, idx) => {
    const start = h.anchor;
    // End = next heading of equal-or-higher outline rank (rank <=), else doc.
    let end = textLength;
    for (let j = idx + 1; j < ordered.length; j++) {
      if (ordered[j]!.rank <= h.rank) {
        end = ordered[j]!.anchor;
        break;
      }
    }
    if (start >= end) return; // degenerate (adjacent same-rank at same anchor)
    // Parent = nearest open section with strictly higher outline rank whose
    // range contains this one; else root.
    while (stack.length > 0 && stack[stack.length - 1]!.rank >= h.rank) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]!.key : ROOT_KEY;
    const key = `sec-${String(idx).padStart(4, '0')}`;
    sections.push({
      key,
      origin: h.origin,
      parent,
      level: stack.length + 1,
      title: boundTitle(h.title),
      chars: { start, end },
    });
    stack.push({ key, rank: h.rank });
  });
  return validateSectionTable(sections, textLength);
}

// ---------------------------------------------------------------------------
// Overrides (§12.3)
// ---------------------------------------------------------------------------

export interface StructureOverrideV1 {
  readonly schema: 'texttrends/structure-override/1';
  readonly text: string;        // TextHash it was authored against
  readonly candidates: string;  // StructureCandidateHash
  readonly baseRecipe: string;  // StructureRecipeHash
  readonly changes: readonly StructureChange[];
}

export type StructureChange =
  | { readonly op: 'remove'; readonly target: string }
  | { readonly op: 'replace'; readonly target: string; readonly value: SectionValue }
  | { readonly op: 'add'; readonly key: string; readonly value: SectionValue };

/** A change's complete replacement value — no omitted-field ambiguity. */
export interface SectionValue {
  readonly parent?: string;
  readonly level: number;
  readonly title?: string;
  readonly chars: { readonly start: number; readonly end: number };
}

export function emptyOverride(text: string, candidates: string, baseRecipe: string): StructureOverrideV1 {
  return { schema: 'texttrends/structure-override/1', text, candidates, baseRecipe, changes: [] };
}

const changeKey = (c: StructureChange): string => (c.op === 'add' ? c.key : c.target);

/**
 * The ONE canonicalization of an override's changes — sorted by
 * (target-or-key, op), duplicates rejected — shared by BOTH hashing and
 * application so a single StructureOverrideHash can only ever denote one
 * application outcome (review finding: array order must be meaningless in
 * BEHAVIOR, not just in the hash).
 */
export function canonicalChanges(override: StructureOverrideV1): readonly StructureChange[] {
  if (override.changes.length > STRUCTURE_LIMITS_V0.maxOverrideChanges) {
    throw new StructureError(
      `override has ${override.changes.length} changes, over the ${STRUCTURE_LIMITS_V0.maxOverrideChanges} cap`,
    );
  }
  const sorted = [...override.changes].sort((a, b) => {
    const ka = changeKey(a);
    const kb = changeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : a.op < b.op ? -1 : a.op > b.op ? 1 : 0;
  });
  const seen = new Set<string>();
  for (const c of sorted) {
    const k = changeKey(c);
    if (seen.has(k)) throw new StructureError(`override has multiple changes to '${k}'`);
    seen.add(k);
  }
  return sorted;
}

export async function hashStructureOverride(override: StructureOverrideV1): Promise<string> {
  return sha256Hex(
    canonicalJson({
      schema: override.schema,
      text: override.text,
      candidates: override.candidates,
      baseRecipe: override.baseRecipe,
      changes: canonicalChanges(override) as unknown as Parameters<typeof canonicalJson>[0],
    }),
  );
}

/**
 * Apply an override to a detected table and re-validate. `remove` of a
 * section reparents its children to the removed section's parent (root can
 * never be removed). Returns the canonical table. Throws StructureError on
 * any illegal change or a result that violates the section invariants.
 */
export function applyOverride(
  detected: readonly StructureSectionRecordV2[],
  override: StructureOverrideV1,
  textLength: number,
): readonly StructureSectionRecordV2[] {
  const byKey = new Map(detected.map((s) => [s.key, { ...s }] as const));
  // Apply the CANONICAL change order — identical to what the hash saw, so
  // two equal-hash overrides always produce the same table.
  for (const change of canonicalChanges(override)) {
    if (change.op === 'remove') {
      if (change.target === ROOT_KEY) throw new StructureError('cannot remove the root section');
      const removed = byKey.get(change.target);
      if (!removed) throw new StructureError(`remove targets missing section '${change.target}'`);
      // Reparent children to the removed section's parent. A non-root
      // section always has a parent, so this is defined; if it were not,
      // reparenting to root is the safe default.
      const newParent = removed.parent ?? ROOT_KEY;
      for (const s of byKey.values()) {
        if (s.parent === change.target) byKey.set(s.key, { ...s, parent: newParent });
      }
      byKey.delete(change.target);
    } else if (change.op === 'replace') {
      if (change.target === ROOT_KEY) throw new StructureError('cannot replace the root section');
      const existing = byKey.get(change.target);
      if (!existing) throw new StructureError(`replace targets missing section '${change.target}'`);
      byKey.set(change.target, { ...sectionFromValue(change.target, existing.origin, change.value), origin: 'user' });
    } else {
      if (byKey.has(change.key)) throw new StructureError(`add key '${change.key}' already exists`);
      if (change.key === ROOT_KEY) throw new StructureError("cannot add a second 'root'");
      byKey.set(change.key, { ...sectionFromValue(change.key, 'user', change.value), origin: 'user' });
    }
  }
  return validateSectionTable([...byKey.values()], textLength);
}

function sectionFromValue(key: string, origin: SectionOrigin, value: SectionValue): StructureSectionRecordV2 {
  return {
    key,
    origin,
    ...(value.parent === undefined ? {} : { parent: value.parent }),
    level: value.level,
    ...(value.title === undefined ? {} : { title: value.title }),
    chars: { start: value.chars.start, end: value.chars.end },
  };
}

// ---------------------------------------------------------------------------
// Artifact (§12.2 StructureArtifactV2)
// ---------------------------------------------------------------------------

export interface StructureArtifactV2 {
  readonly schema: 'texttrends/structure/2';
  readonly text: string;
  readonly candidates: string;
  readonly recipe: string;
  readonly override: string;
  readonly sections: readonly StructureSectionRecordV2[];
}

// ---------------------------------------------------------------------------
// Authoring: derive a complete override from an edited outline (§12.3, ruling §1)
// ---------------------------------------------------------------------------

/** A user-editable outline row: a lineage key plus the SectionValue fields.
 *  NO origin — the caller never authors provenance (composition stamps `user`
 *  on every changed row). The root row (`ROOT_KEY`) must be present, unchanged. */
export interface EditableSectionValue {
  readonly key: string;
  readonly parent?: string;
  readonly level: number;
  readonly title?: string;
  readonly chars: CharRange;
}

/** True when two outline rows carry the same SectionValue (parent/level/title/
 *  chars) — origin is deliberately ignored. */
function sameOutlineValue(
  a: { parent?: string; level: number; title?: string; chars: CharRange },
  b: { parent?: string; level: number; title?: string; chars: CharRange },
): boolean {
  return (
    a.parent === b.parent &&
    a.level === b.level &&
    a.title === b.title &&
    a.chars.start === b.chars.start &&
    a.chars.end === b.chars.end
  );
}

function valueFromEditable(e: EditableSectionValue): SectionValue {
  return {
    ...(e.parent === undefined ? {} : { parent: e.parent }),
    level: e.level,
    ...(e.title === undefined ? {} : { title: e.title }),
    chars: { start: e.chars.start, end: e.chars.end },
  };
}

/**
 * Derive the ONE complete, canonical override that turns `detected` into
 * `edited` (ruling §1). This is the sole authoring authority: the UI presents
 * the current composed outline, the user edits it, and the resulting DESIRED
 * outline is diffed against the DETECTED baseline here — never expressed as an
 * incremental delta over a previous override (which would recreate the edit-log
 * coupling the declarative contract rejects).
 *
 * Diff by lineage key: a detected key absent from `edited` → `remove`; a
 * detected key whose value changed → `replace`; an edited-only key → `add`.
 * Root mutation is rejected. The generated override is then APPLIED back to the
 * detected table and PROVED to reproduce `edited` exactly (mod origin); caps and
 * section invariants run here, not only later in the worker. An empty change set
 * returns the canonical empty override (the caller installs `none`).
 */
export function overrideFromEditedOutline(
  base: { readonly text: string; readonly candidates: string; readonly baseRecipe: string },
  detected: readonly StructureSectionRecordV2[],
  edited: readonly EditableSectionValue[],
): StructureOverrideV1 {
  const detByKey = new Map(detected.map((s) => [s.key, s] as const));
  const detRoot = detByKey.get(ROOT_KEY);
  if (!detRoot) throw new StructureError('detected table has no root');
  const textLength = detRoot.chars.end;

  const editByKey = new Map<string, EditableSectionValue>();
  for (const e of edited) {
    if (editByKey.has(e.key)) throw new StructureError(`edited outline repeats key '${e.key}'`);
    editByKey.set(e.key, e);
  }
  const edRoot = editByKey.get(ROOT_KEY);
  if (!edRoot) throw new StructureError('edited outline must include the root section');
  // The root is immutable: same level 0, no parent, full-text range.
  if (edRoot.parent !== undefined || edRoot.level !== 0 || edRoot.chars.start !== 0 || edRoot.chars.end !== textLength) {
    throw new StructureError('the root section cannot be moved, re-parented, or re-leveled');
  }

  const changes: StructureChange[] = [];
  // Removes: a detected non-root key the user deleted.
  for (const s of detected) {
    if (s.key !== ROOT_KEY && !editByKey.has(s.key)) changes.push({ op: 'remove', target: s.key });
  }
  // Replaces + adds, ignoring order and provenance.
  for (const e of edited) {
    if (e.key === ROOT_KEY) continue;
    const d = detByKey.get(e.key);
    if (d) {
      if (!sameOutlineValue(e, d)) changes.push({ op: 'replace', target: e.key, value: valueFromEditable(e) });
    } else {
      changes.push({ op: 'add', key: e.key, value: valueFromEditable(e) });
    }
  }

  const built: StructureOverrideV1 = {
    schema: 'texttrends/structure-override/1',
    text: base.text,
    candidates: base.candidates,
    baseRecipe: base.baseRecipe,
    changes,
  };
  // canonicalChanges enforces the change cap + rejects duplicate targets, and
  // makes the RETURNED representation canonical so construction/row order is
  // truly meaningless (not just erased by the hash); applyOverride enforces
  // every section invariant and the section-count cap.
  const override: StructureOverrideV1 = { ...built, changes: canonicalChanges(built) };
  const applied = applyOverride(detected, override, textLength);
  // Prove the diff reproduces the desired outline exactly (mod origin) — the
  // edited outline is validated + canonicalized through the same gate.
  const wantRecords: StructureSectionRecordV2[] = edited.map((e) => ({
    key: e.key,
    origin: e.key === ROOT_KEY ? 'fixed' : 'user',
    ...(e.parent === undefined ? {} : { parent: e.parent }),
    level: e.level,
    ...(e.title === undefined ? {} : { title: e.title }),
    chars: { start: e.chars.start, end: e.chars.end },
  }));
  const want = validateSectionTable(wantRecords, textLength);
  if (applied.length !== want.length) throw new StructureError('derived override does not reproduce the edited outline');
  for (let i = 0; i < applied.length; i++) {
    const a = applied[i]!;
    const b = want[i]!;
    if (a.key !== b.key || !sameOutlineValue(a, b)) {
      throw new StructureError('derived override does not reproduce the edited outline');
    }
  }
  return override;
}

/** Compose the full artifact: detect → apply override → validate. The four
 *  identity hashes are supplied by the caller (they bind the artifact key). */
export function composeStructure(
  text: string,
  candidates: readonly StructureCandidateV1[],
  recipe: StructureRecipeProvisional,
  override: StructureOverrideV1,
  identities: { readonly text: string; readonly candidates: string; readonly recipe: string; readonly override: string },
): StructureArtifactV2 {
  const detected = buildDetectedSections(text, candidates, recipe);
  const sections = applyOverride(detected, override, text.length);
  return {
    schema: 'texttrends/structure/2',
    text: identities.text,
    candidates: identities.candidates,
    recipe: identities.recipe,
    override: identities.override,
    sections,
  };
}
