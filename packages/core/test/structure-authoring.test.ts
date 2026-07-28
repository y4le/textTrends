/**
 * Structure authoring core (commit 8b): the declarative-diff helper
 * `overrideFromEditedOutline`, the provisional structure caps, and the bounded
 * source-line window. These are the contracts the correction UI (8c) builds on.
 */
import { describe, expect, it } from 'vitest';
import {
  ROOT_KEY,
  STRUCTURE_LIMITS_V0,
  StructureCapError,
  StructureError,
  lineWindowAround,
  overrideFromEditedOutline,
  type EditableSectionValue,
  type StructureSectionRecordV2,
} from '../src/index.ts';
import { applyOverride, canonicalChanges } from '../src/structure/build.ts';
import { validateSectionTable } from '../src/structure/sections.ts';

const BASE = { text: 'th', candidates: 'ch', baseRecipe: 'rh' };

/** A validated detected table: root + two top-level chapters. */
const DETECTED = validateSectionTable(
  [
    { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: 100 } },
    { key: 'sec-0', origin: 'heuristic', parent: ROOT_KEY, level: 1, title: 'Chapter 1', chars: { start: 10, end: 50 } },
    { key: 'sec-1', origin: 'source', parent: ROOT_KEY, level: 1, title: 'Chapter 2', chars: { start: 50, end: 100 } },
  ],
  100,
);

/** The editable outline (origin stripped) for a detected table. */
function editableOf(table: readonly StructureSectionRecordV2[]): EditableSectionValue[] {
  return table.map((s) => ({
    key: s.key,
    ...(s.parent === undefined ? {} : { parent: s.parent }),
    level: s.level,
    ...(s.title === undefined ? {} : { title: s.title }),
    chars: { start: s.chars.start, end: s.chars.end },
  }));
}

describe('overrideFromEditedOutline', () => {
  it('returns an empty override when nothing changed', () => {
    const o = overrideFromEditedOutline(BASE, DETECTED, editableOf(DETECTED));
    expect(o.changes).toEqual([]);
    expect(o.text).toBe('th');
  });

  it('emits a single replace for a retitle, and reproduces the edited outline', () => {
    const edited = editableOf(DETECTED).map((e) => (e.key === 'sec-0' ? { ...e, title: 'Beginnings' } : e));
    const o = overrideFromEditedOutline(BASE, DETECTED, edited);
    expect(o.changes).toEqual([
      { op: 'replace', target: 'sec-0', value: { parent: ROOT_KEY, level: 1, title: 'Beginnings', chars: { start: 10, end: 50 } } },
    ]);
    const applied = applyOverride(DETECTED, o, 100);
    expect(applied.find((s) => s.key === 'sec-0')!.title).toBe('Beginnings');
    expect(applied.find((s) => s.key === 'sec-0')!.origin).toBe('user');
  });

  it('emits a remove for a deleted section, in CANONICAL order', () => {
    const edited = editableOf(DETECTED).filter((e) => e.key !== 'sec-1');
    // Extend sec-0 to cover the freed range so the outline stays valid.
    const grown = edited.map((e) => (e.key === 'sec-0' ? { ...e, chars: { start: 10, end: 100 } } : e));
    const o = overrideFromEditedOutline(BASE, DETECTED, grown);
    // Canonical order sorts by (target-or-key, op): 'sec-0' (replace) before
    // 'sec-1' (remove) — NOT construction order (removes-first).
    expect(o.changes.map((c) => (c.op === 'add' ? c.key : c.target))).toEqual(['sec-0', 'sec-1']);
    expect(o.changes.map((c) => c.op)).toEqual(['replace', 'remove']);
  });

  it('returns a canonical override that is independent of edited-row order', () => {
    const retitle = (e: EditableSectionValue): EditableSectionValue =>
      e.key === 'sec-0' ? { ...e, title: 'A' } : e.key === 'sec-1' ? { ...e, title: 'B' } : e;
    const forward = editableOf(DETECTED).map(retitle);
    const reversed = [...forward].reverse();
    const a = overrideFromEditedOutline(BASE, DETECTED, forward);
    const b = overrideFromEditedOutline(BASE, DETECTED, reversed);
    expect(a.changes).toEqual(b.changes); // row order is truly meaningless
    expect(a.changes.map((c) => (c.op === 'add' ? c.key : c.target))).toEqual(['sec-0', 'sec-1']);
  });

  it('emits an add for a user-keyed section not in the detected table', () => {
    const edited: EditableSectionValue[] = [
      ...editableOf(DETECTED).map((e) => (e.key === 'sec-0' ? { ...e, chars: { start: 10, end: 30 } } : e)),
      { key: 'user-abc', parent: ROOT_KEY, level: 1, title: 'Inserted', chars: { start: 30, end: 50 } },
    ];
    const o = overrideFromEditedOutline(BASE, DETECTED, edited);
    const add = o.changes.find((c) => c.op === 'add');
    expect(add).toEqual({ op: 'add', key: 'user-abc', value: { parent: ROOT_KEY, level: 1, title: 'Inserted', chars: { start: 30, end: 50 } } });
    // Applying reproduces the inserted section as a user origin.
    const applied = applyOverride(DETECTED, o, 100);
    expect(applied.find((s) => s.key === 'user-abc')!.origin).toBe('user');
  });

  it('emits a replace for a re-parent (subsection under an existing chapter)', () => {
    const edited = editableOf(DETECTED).map((e) =>
      e.key === 'sec-1' ? { ...e, parent: 'sec-0', level: 2, chars: { start: 40, end: 50 } } : e,
    ).map((e) => (e.key === 'sec-0' ? { ...e, chars: { start: 10, end: 50 } } : e));
    const o = overrideFromEditedOutline(BASE, DETECTED, edited);
    expect(o.changes.find((c) => c.op === 'replace' && c.target === 'sec-1')).toBeTruthy();
    const applied = applyOverride(DETECTED, o, 100);
    expect(applied.find((s) => s.key === 'sec-1')!.parent).toBe('sec-0');
  });

  it('rejects any mutation of the root', () => {
    const edited = editableOf(DETECTED).map((e) => (e.key === ROOT_KEY ? { ...e, chars: { start: 0, end: 90 } } : e));
    expect(() => overrideFromEditedOutline(BASE, DETECTED, edited)).toThrow(StructureError);
  });

  it('rejects an edited outline missing the root', () => {
    const edited = editableOf(DETECTED).filter((e) => e.key !== ROOT_KEY);
    expect(() => overrideFromEditedOutline(BASE, DETECTED, edited)).toThrow(/root/);
  });

  it('rejects an invalid edited outline (overlapping siblings)', () => {
    const edited = editableOf(DETECTED).map((e) => (e.key === 'sec-0' ? { ...e, chars: { start: 10, end: 60 } } : e));
    expect(() => overrideFromEditedOutline(BASE, DETECTED, edited)).toThrow(StructureError);
  });
});

describe('structure caps (§5)', () => {
  it('rejects a table over the section cap with a StructureCapError', () => {
    const rows: StructureSectionRecordV2[] = [{ key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: 1_000_000 } }];
    for (let i = 0; i < STRUCTURE_LIMITS_V0.maxSectionsPerTable; i++) {
      rows.push({ key: `s${i}`, origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: i * 2, end: i * 2 + 1 } });
    }
    expect(rows.length).toBe(STRUCTURE_LIMITS_V0.maxSectionsPerTable + 1); // root pushes over
    expect(() => validateSectionTable(rows, 1_000_000)).toThrow(StructureCapError);
  });

  it('rejects an over-long lineage key with a plain StructureError', () => {
    const rows: StructureSectionRecordV2[] = [
      { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: 100 } },
      { key: 'k'.repeat(STRUCTURE_LIMITS_V0.maxLineageKeyUtf16 + 1), origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 0, end: 100 } },
    ];
    let err: unknown;
    try { validateSectionTable(rows, 100); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StructureError);
    expect(err).not.toBeInstanceOf(StructureCapError);
  });

  it('rejects an override over the change cap', () => {
    const changes = Array.from({ length: STRUCTURE_LIMITS_V0.maxOverrideChanges + 1 }, (_, i) => ({ op: 'remove' as const, target: `s${i}` }));
    expect(() => canonicalChanges({ schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes })).toThrow(/cap/);
  });
});

describe('lineWindowAround', () => {
  it('returns the whole short line untruncated', () => {
    const text = 'first line\nHERE is the anchor line\nthird line';
    const anchor = text.indexOf('anchor');
    const w = lineWindowAround(text, anchor, 200);
    expect(w.text).toBe('HERE is the anchor line');
    expect(w.truncatedStart).toBe(false);
    expect(w.truncatedEnd).toBe(false);
  });

  it('handles CRLF and other Unicode breaks as line terminators', () => {
    const text = 'a\r\nBETA c';
    const w = lineWindowAround(text, text.indexOf('BETA'), 100);
    expect(w.text).toBe('BETA');
  });

  it('clamps a pathological long line to maxChars and flags both truncations', () => {
    const text = 'x'.repeat(10_000);
    const w = lineWindowAround(text, 5_000, 100);
    expect(w.end - w.start).toBeLessThanOrEqual(100);
    expect(w.truncatedStart).toBe(true);
    expect(w.truncatedEnd).toBe(true);
    // The anchor lies within the returned window.
    expect(w.start).toBeLessThanOrEqual(5_000);
    expect(w.end).toBeGreaterThan(5_000);
  });

  it('never splits a surrogate pair at a clipped boundary', () => {
    const emoji = '😀'; // one astral char = two UTF-16 units
    const text = emoji.repeat(2_000);
    const w = lineWindowAround(text, 2_000, 100);
    expect(w.text.isWellFormed()).toBe(true);
  });

  it('bounds a non-finite budget instead of scanning the whole line', () => {
    const text = 'x'.repeat(5_000);
    const w = lineWindowAround(text, 100, Number.NaN);
    expect(w.end - w.start).toBeLessThanOrEqual(1); // never the whole line
    expect(w.truncatedEnd).toBe(true);
  });
});
