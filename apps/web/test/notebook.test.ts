/**
 * Pure notebook-model helpers from the slice-1 notebook ruling. Store-level
 * behavior (actions, projections, reissue policy) lives in store.test.ts;
 * these prove the pure functions' contracts directly.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLDED_MATCH,
  memberSemanticKey,
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  parseQuickAdd,
  reconcileStyleSlots,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
} from '../src/lib/notebook.ts';
import { TERM_GROUP_LIMITS_V1, termGroupIdentity } from '@texttrends/core';

const counter = () => {
  let n = 0;
  return () => `u${++n}`;
};

const nb = (...groups: NotebookGroupV1[]): QueryNotebookV1 =>
  ({ schema: 'texttrends/query-notebook/1', groups });

const tokenGroup = (id: string, name: string, surface = name): NotebookGroupV1 => ({
  id,
  name,
  members: [{ id: `${id}:m`, kind: 'token', surface, match: FOLDED_MATCH }],
  countOverlaps: false,
});

describe('parseQuickAdd', () => {
  it('splits, trims, NFC-normalizes, dedups within the batch, and mints ids via the injected factory', () => {
    const p = parseQuickAdd(' wolf , , Wolf , wolf ', counter(), 10, []);
    expect(p.error).toBeNull();
    expect(p.groups!.map((g) => g.name)).toEqual(['wolf', 'Wolf']);
    expect(p.groups!.map((g) => g.id)).toEqual(['u1', 'u3']); // u2/u4 = member ids
    expect(p.groups![0]!.members[0]!.match).toEqual(FOLDED_MATCH);
  });

  it('dedups by NFC (composed ≡ decomposed) but keeps I and İ distinct — locale-independent', () => {
    const composed = '\u00e9t\u00e9';
    const decomposed = 'e\u0301te\u0301';
    const p = parseQuickAdd(`${composed}, ${decomposed}`, counter(), 10, []);
    expect(p.groups!).toHaveLength(1);
    const only = p.groups![0]!.members[0]!;
    expect(only.kind === 'token' && only.surface).toBe(composed); // NFC surface emitted
    const distinct = parseQuickAdd('I, İ', counter(), 10, []);
    expect(distinct.groups!).toHaveLength(2); // NFC does not unify these
  });

  it('SKIPS a term whose matching identity already exists in the notebook — skips consume no room and no ids', () => {
    const existing = [tokenGroup('gA', 'wolf')];
    const p = parseQuickAdd('wolf, bear', counter(), 1, existing); // room for ONE
    expect(p.error).toBeNull(); // wolf skipped → only bear needs room
    expect(p.groups!.map((g) => g.name)).toEqual(['bear']);
    expect(p.groups![0]!.id).toBe('u1'); // the skip minted nothing
    // A DIFFERENT spelling is a different identity — not skipped.
    const p2 = parseQuickAdd('Wolf', counter(), 1, existing);
    expect(p2.groups!.map((g) => g.name)).toEqual(['Wolf']);
    // A multi-member group of the same NAME does not block its term.
    const multi = { ...tokenGroup('gM', 'fox'), members: [
      { id: 'm1', kind: 'token' as const, surface: 'fox', match: FOLDED_MATCH },
      { id: 'm2', kind: 'token' as const, surface: 'vulpes', match: FOLDED_MATCH },
    ] };
    const p3 = parseQuickAdd('fox', counter(), 1, [multi]);
    expect(p3.groups!).toHaveLength(1); // identities differ → appended
  });

  it('refuses ATOMICALLY when the NEW groups exceed the room — never a partial add', () => {
    const p = parseQuickAdd('a, b, c', counter(), 2, []);
    expect(p.groups).toBeNull();
    expect(p.error).toContain('room for 2');
  });

  it('refuses an over-long term explicitly (NFC length — the emitted surface is NFC)', () => {
    const p = parseQuickAdd('x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1), counter(), 10, []);
    expect(p.groups).toBeNull();
    expect(p.error).toContain('too long');
    // A decomposed spelling whose NFC form fits IS accepted — the bound and
    // the emitted surface are the same (NFC) string.
    const decomposed = 'e\u0301'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits / 2 + 1);
    const ok = parseQuickAdd(decomposed, counter(), 10, []);
    expect(ok.error).toBeNull();
    const m = ok.groups![0]!.members[0]!;
    expect(m.kind === 'token' ? m.surface.length : -1).toBeLessThanOrEqual(TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
  });
});

describe('reconcileStyleSlots', () => {
  it('assigns lowest-free in active order and keeps actives unique', () => {
    const slots = reconcileStyleSlots(new Map(), ['a', 'b', 'c'], new Set(['a', 'b', 'c']), new Set());
    expect([...slots.entries()]).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });

  it('a SURVIVOR outranks a returning muted owner — reactivation cannot steal a live colour (review-B)', () => {
    // b muted earlier retained slot 1; active newcomer c then claimed slot 1.
    // When b returns FIRST IN ORDER, surviving c must keep 1; b is reassigned.
    const prev = new Map([['a', 0], ['b', 1], ['c', 1]]);
    const slots = reconcileStyleSlots(prev, ['b', 'a', 'c'], new Set(['a', 'b', 'c']), new Set(['a', 'c']));
    expect(slots.get('a')).toBe(0); // survivor pinned
    expect(slots.get('c')).toBe(1); // survivor pinned — NOT displaced by b
    expect(slots.get('b')).toBe(2); // returning owner reassigned
  });

  it('a returning muted owner reclaims its retained slot when still free', () => {
    const prev = new Map([['a', 0], ['b', 1]]);
    const slots = reconcileStyleSlots(prev, ['a', 'b'], new Set(['a', 'b']), new Set(['a']));
    expect(slots.get('a')).toBe(0);
    expect(slots.get('b')).toBe(1); // prior slot free → reclaimed
  });

  it('reassigns a returning group whose slot was taken, and drops removed ids', () => {
    const prev = new Map([['a', 0], ['b', 0], ['gone', 2]]);
    const slots = reconcileStyleSlots(prev, ['a', 'b'], new Set(['a', 'b']), new Set(['a', 'b']));
    expect(slots.get('a')).toBe(0);
    expect(slots.get('b')).toBe(1); // collision resolved deterministically
    expect(slots.has('gone')).toBe(false);
  });
});

describe('validateNotebookGroup', () => {
  it('accepts a legal multi-member group', () => {
    const g: NotebookGroupV1 = {
      ...tokenGroup('g', 'wolves'),
      members: [
        { id: 'm1', kind: 'token', surface: 'wolf', match: FOLDED_MATCH },
        { id: 'm2', kind: 'phrase', surfaces: ['dire', 'wolf'], match: FOLDED_MATCH, crossSentence: false },
        { id: 'm3', kind: 'prefix', stem: 'wolv', match: FOLDED_MATCH },
      ],
    };
    expect(() => validateNotebookGroup(g)).not.toThrow();
  });

  it('rejects an empty, non-NFC, or over-long name', () => {
    expect(() => validateNotebookGroup({ ...tokenGroup('g', 'x'), name: '' })).toThrow(/name/);
    expect(() => validateNotebookGroup({ ...tokenGroup('g', 'x'), name: 'e\u0301' })).toThrow(/NFC/);
    expect(() => validateNotebookGroup({
      ...tokenGroup('g', 'x'),
      name: 'n'.repeat(NOTEBOOK_LIMITS_V1.maxNameUnits + 1),
    })).toThrow(/at most/);
  });

  it('composes the CORE validator — a kernel-invalid group never passes the app', () => {
    const g: NotebookGroupV1 = {
      ...tokenGroup('g', 'x'),
      members: [{ id: 'm', kind: 'prefix', stem: '', match: FOLDED_MATCH }],
    };
    expect(() => validateNotebookGroup(g)).toThrow(RangeError);
  });

  it('rejects two members with IDENTICAL matching semantics', () => {
    const g: NotebookGroupV1 = {
      ...tokenGroup('g', 'x'),
      members: [
        { id: 'm1', kind: 'token', surface: 'wolf', match: FOLDED_MATCH },
        { id: 'm2', kind: 'token', surface: 'wolf', match: FOLDED_MATCH },
      ],
    };
    expect(() => validateNotebookGroup(g)).toThrow(/match identically/);
    // Same surface under a DIFFERENT mode is legal (distinct semantics).
    const legal: NotebookGroupV1 = {
      ...g,
      members: [
        { id: 'm1', kind: 'token', surface: 'wolf', match: FOLDED_MATCH },
        { id: 'm2', kind: 'token', surface: 'wolf', match: { case: 'sensitive', diacritics: 'folded' } },
      ],
    };
    expect(() => validateNotebookGroup(legal)).not.toThrow();
  });
});

describe('memberSemanticKey', () => {
  it('is the core identity of a synthetic single-member group (cannot drift from termGroupIdentity)', () => {
    const m = { id: 'anything', kind: 'token' as const, surface: 'wolf', match: FOLDED_MATCH };
    expect(memberSemanticKey(m)).toBe(
      termGroupIdentity({ id: 'm', members: [m], countOverlaps: false }),
    );
    expect(memberSemanticKey({ ...m, id: 'other' })).toBe(memberSemanticKey(m)); // id-independent
  });
});

describe('parseQueryNotebook — the versioned whole-notebook admission (ruling §2)', () => {
  const legal = () => JSON.parse(JSON.stringify(nb(tokenGroup('gA', 'wolf'), tokenGroup('gB', 'bear')))) as unknown;

  it('admits a legal notebook and returns it typed', () => {
    const v = parseQueryNotebook(legal());
    expect(v.groups.map((g) => g.name)).toEqual(['wolf', 'bear']);
  });

  it('rejects a wrong or missing schema discriminant', () => {
    expect(() => parseQueryNotebook({ schema: 'texttrends/query-notebook/2', groups: [] })).toThrow(/schema/);
    expect(() => parseQueryNotebook({ groups: [] })).toThrow(/schema/);
    expect(() => parseQueryNotebook(null)).toThrow(RangeError);
    expect(() => parseQueryNotebook('nope')).toThrow(RangeError);
  });

  it('rejects over-cap, duplicate ids, sparse arrays, and malformed nested members', () => {
    const over = { schema: 'texttrends/query-notebook/1', groups: Array.from({ length: NOTEBOOK_LIMITS_V1.maxGroups + 1 }, (_, i) => tokenGroup(`g${i}`, `n${i}`)) };
    expect(() => parseQueryNotebook(over)).toThrow(/at most/);
    const dup = { schema: 'texttrends/query-notebook/1', groups: [tokenGroup('gA', 'wolf'), tokenGroup('gA', 'bear')] };
    expect(() => parseQueryNotebook(dup)).toThrow(/duplicate group id/);
    expect(() => parseQueryNotebook({ schema: 'texttrends/query-notebook/1', groups: Array(1) })).toThrow(/dense/);
    const sparseMembers = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: Array(1) }] };
    expect(() => parseQueryNotebook(sparseMembers)).toThrow(/dense/);
    const badMode = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: [{ id: 'm', kind: 'token', surface: 'w', match: { case: 'exact', diacritics: 'folded' } }] }] };
    expect(() => parseQueryNotebook(badMode)).toThrow(/malformed/);
  });

  it('applies the SAME semantic admission as the editor — a kernel-invalid nested group is refused', () => {
    const emptyStem = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: [{ id: 'm', kind: 'prefix', stem: '', match: { case: 'folded', diacritics: 'folded' } }] }] };
    expect(() => parseQueryNotebook(emptyStem)).toThrow(/code units/);
    const dupSemantics = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: [
      { id: 'm1', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } },
      { id: 'm2', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } },
    ] }] };
    expect(() => parseQueryNotebook(dupSemantics)).toThrow(/match identically/);
  });
});

describe('parseQueryNotebook — structured-clone safety and blank names (review-B round 2)', () => {
  it('rejects INHERITED and accessor-backed fields — what passes admission must survive structuredClone verbatim', () => {
    const inherited = Object.create({ id: 'm', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } }) as object;
    const v = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: [inherited] }] };
    expect(() => parseQueryNotebook(v)).toThrow(/malformed/);
    const accessor: Record<string, unknown> = { id: 'm', kind: 'token', match: { case: 'folded', diacritics: 'folded' } };
    Object.defineProperty(accessor, 'surface', { get: () => 'wolf', enumerable: true, configurable: true });
    const v2 = { schema: 'texttrends/query-notebook/1', groups: [{ ...tokenGroup('gA', 'wolf'), members: [accessor] }] };
    expect(() => parseQueryNotebook(v2)).toThrow(/malformed/);
  });

  it('caps nested collections BEFORE scanning them (no unbounded work on hostile input)', () => {
    const hugeMembers = { ...tokenGroup('gA', 'wolf'), members: { length: 1e9 } };
    const v = { schema: 'texttrends/query-notebook/1', groups: [hugeMembers] };
    expect(() => parseQueryNotebook(v)).toThrow(/at most/); // refused at the bound, not after a scan
  });

  it('rejects a whitespace-only name (validator and store rename)', () => {
    expect(() => validateNotebookGroup({ ...tokenGroup('g', 'x'), name: '   ' })).toThrow(/nonblank/);
  });
});

describe('quick-add name/surface bound alignment (review-B)', () => {
  it('any accepted term builds a VALID notebook group — the 129–256-unit band included', () => {
    const label = 'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits); // longest legal term
    const p = parseQuickAdd(label, counter(), 10, []);
    expect(p.error).toBeNull();
    expect(() => validateNotebookGroup(p.groups![0]!)).not.toThrow();
  });
});
