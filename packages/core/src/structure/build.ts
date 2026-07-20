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
import type { StructureCandidateV1 } from '../extract/markdown.ts';
import {
  ROOT_KEY,
  StructureError,
  validateSectionTable,
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
