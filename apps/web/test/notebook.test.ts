import { describe, expect, it } from 'vitest';
import { TERM_GROUP_LIMITS_V1, termGroupIdentity } from '@texttrends/core';
import {
  aliasesForTermEditor,
  FOLDED_MATCH,
  coreGroupOf,
  firstFreeStyle,
  groupIdentity,
  memberSemanticKey,
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  parseQuickAdd,
  resolveActiveStyleCollisions,
  stylesVisuallyCollide,
  termAliasesForSave,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
} from '../src/lib/notebook.ts';

const counter = () => {
  let n = 0;
  return () => `u${++n}`;
};

const group = (
  id: string,
  alias: string,
  style: NotebookGroupV1['style'] = { color: 'blue', line: 'solid' },
): NotebookGroupV1 => ({
  id,
  aliases: [alias],
  exactMatch: false,
  countOverlaps: false,
  style,
});

const notebook = (...groups: NotebookGroupV1[]): QueryNotebookV1 => ({
  schema: 'texttrends/query-notebook/3',
  groups,
});

describe('parseQuickAdd', () => {
  it('splits, trims, normalizes, deduplicates, and mints one stable group id', () => {
    const parsed = parseQuickAdd(' wolf , , Wolf , wolf ', counter(), 10, []);
    expect(parsed.error).toBeNull();
    expect(parsed.groups!.map((term) => term.aliases[0])).toEqual(['wolf', 'Wolf']);
    expect(parsed.groups!.map((term) => term.id)).toEqual(['u1', 'u2']);
    expect(parsed.groups![0]!.exactMatch).toBe(false);
  });

  it('normalizes NFC without locale-dependent spelling deduplication', () => {
    const composed = '\u00e9t\u00e9';
    const decomposed = 'e\u0301te\u0301';
    expect(parseQuickAdd(`${composed}, ${decomposed}`, counter(), 10, []).groups)
      .toHaveLength(1);
    expect(parseQuickAdd('I, İ', counter(), 10, []).groups).toHaveLength(2);
  });

  it('skips an existing matching identity without consuming an id or room', () => {
    const existing = [group('g1', 'wolf')];
    const parsed = parseQuickAdd('wolf, bear', counter(), 1, existing);
    expect(parsed.error).toBeNull();
    expect(parsed.groups!.map((term) => term.aliases[0])).toEqual(['bear']);
    expect(parsed.groups![0]!.id).toBe('u1');
    const broader = { ...group('g2', 'fox'), aliases: ['fox', 'vulpes'] };
    expect(parseQuickAdd('fox', counter(), 1, [broader]).groups).toHaveLength(1);
  });

  it('refuses an over-room batch atomically and bounds aliases after NFC', () => {
    expect(parseQuickAdd('a, b, c', counter(), 2, []).error).toContain('room for 2');
    const tooLong = 'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1);
    expect(parseQuickAdd(tooLong, counter(), 10, []).error).toContain('too long');
    const longest = 'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
    const accepted = parseQuickAdd(longest, counter(), 10, []);
    expect(() => validateNotebookGroup(accepted.groups![0]!)).not.toThrow();
  });

  it('returns an atomic refusal instead of throwing for malformed natural aliases', () => {
    for (const input of ['…', '★', '—', '!!!', '*', '**', 'wo*lf', 'wolf, ★']) {
      expect(() => parseQuickAdd(input, counter(), 10, [])).not.toThrow();
      const parsed = parseQuickAdd(input, counter(), 10, []);
      expect(parsed.groups).toBeNull();
      expect(parsed.error).toBeTruthy();
    }
    const invalidExisting = { ...group('bad', 'word'), aliases: ['★'] };
    expect(() => parseQuickAdd('wolf', counter(), 10, [invalidExisting])).not.toThrow();
    expect(parseQuickAdd('wolf', counter(), 10, [invalidExisting]).groups).toBeNull();
  });
});

describe('authored alias model', () => {
  it('presents a legacy custom title first without duplicating an existing alias', () => {
    const legacy = {
      ...group('g', 'holmes'),
      aliases: ['holmes', 'sherlock'],
      displayName: 'Detective',
    };
    expect(aliasesForTermEditor(legacy)).toEqual(['Detective', 'holmes', 'sherlock']);
    expect(termAliasesForSave(legacy, ['Detective', 'holmes', 'sherlock'], false))
      .toEqual({ aliases: ['holmes', 'sherlock'], displayName: 'Detective' });
    expect(termAliasesForSave(legacy, ['Detective', 'holmes', 'sherlock'], true))
      .toEqual({ aliases: ['Detective', 'holmes', 'sherlock'] });
    expect(aliasesForTermEditor({
      ...group('g', 'holmes'),
      aliases: ['holmes', 'Detective'],
      displayName: 'Detective',
    })).toEqual(['Detective', 'holmes']);
  });

  it('compiles token, multiword, and wildcard aliases using one uniform mode', () => {
    const term: NotebookGroupV1 = {
      ...group('nyc', 'NYC'),
      aliases: ['NYC', 'NY', 'New York', 'New Yo*'],
    };
    const compiled = coreGroupOf(term);
    expect(compiled.members.map((member) => member.kind))
      .toEqual(['token', 'token', 'phrase', 'phrase']);
    expect(compiled.members.every((member) => member.match === FOLDED_MATCH)).toBe(true);
    expect(() => validateNotebookGroup(term)).not.toThrow();
  });

  it('exact match changes matching identity while style and display name do not', () => {
    const folded = group('g', 'Holmes');
    const exact = { ...folded, exactMatch: true };
    expect(groupIdentity(exact)).not.toBe(groupIdentity(folded));
    expect(groupIdentity({ ...folded, displayName: 'Detective', style: { color: 'gold', line: 'dot' } }))
      .toBe(groupIdentity(folded));
  });

  it('rejects blank, duplicate-semantic, over-cap, and unsupported authored data', () => {
    expect(() => validateNotebookGroup({ ...group('g', 'x'), aliases: [' '] })).toThrow(/alias/);
    expect(() => validateNotebookGroup({ ...group('g', 'x'), aliases: ['wolf', 'wolf'] }))
      .toThrow(/identically/);
    expect(() => validateNotebookGroup({
      ...group('g', 'x'),
      aliases: Array.from({ length: NOTEBOOK_LIMITS_V1.maxAliases + 1 }, (_, i) => `a${i}`),
    })).toThrow(/aliases/);
    expect(() => validateNotebookGroup({
      ...group('g', 'x'),
      style: { color: 'red', line: 'solid' } as never,
    })).toThrow(/style/);
  });
});

describe('durable styles', () => {
  it('does not let custom colors consume the theme-aware default palette', () => {
    const custom = group('custom', 'custom', { color: '#a1b2c3', line: 'solid' });
    expect(firstFreeStyle([custom], new Set([custom.id])))
      .toEqual({ color: 'blue', line: 'solid' });
  });

  it('keeps active survivors and reassigns only a colliding returning term', () => {
    const source = notebook(
      group('returning', 'returning'),
      group('a', 'a', { color: 'orange', line: 'dash' }),
      group('c', 'c', { color: 'blue', line: 'solid' }),
    );
    const resolved = resolveActiveStyleCollisions(
      source,
      new Set(['returning', 'a', 'c']),
      new Set(['a', 'c']),
    );
    expect(resolved.groups[2]!.style).toEqual({ color: 'blue', line: 'solid' });
    expect(resolved.groups[0]!.style).not.toEqual(resolved.groups[2]!.style);
    expect(new Set(resolved.groups.map((term) => JSON.stringify(term.style))).size).toBe(3);
  });

  it('does not rewrite hidden terms or a collision-free notebook', () => {
    const source = notebook(group('a', 'a'), group('b', 'b'));
    expect(resolveActiveStyleCollisions(source, new Set(['a']))).toBe(source);
    expect(resolveActiveStyleCollisions(source, new Set(['a', 'b']))).not.toBe(source);
    expect(resolveActiveStyleCollisions(source, new Set(['a'])).groups[1]!.style)
      .toEqual({ color: 'blue', line: 'solid' });
  });

  it('keeps a unique custom style and reassigns only an exact returning collision', () => {
    const custom = { color: '#a1b2c3' as const, line: 'dash' as const };
    const source = notebook(
      group('survivor', 'survivor', custom),
      group('returning', 'returning', custom),
    );
    const resolved = resolveActiveStyleCollisions(
      source,
      new Set(['survivor', 'returning']),
      new Set(['survivor']),
    );
    expect(resolved.groups[0]!.style).toEqual(custom);
    expect(resolved.groups[1]!.style).not.toEqual(custom);
  });

  it('treats a shared automatic color as a collision even when line patterns differ', () => {
    const source = notebook(
      group('survivor', 'survivor', { color: 'blue', line: 'solid' }),
      group('returning', 'returning', { color: 'blue', line: 'dash' }),
    );
    const resolved = resolveActiveStyleCollisions(
      source,
      new Set(['survivor', 'returning']),
      new Set(['survivor']),
    );

    expect(resolved.groups[0]!.style).toEqual({ color: 'blue', line: 'solid' });
    expect(resolved.groups[1]!.style.color).not.toBe('blue');
    expect(stylesVisuallyCollide(resolved.groups[0]!.style, resolved.groups[1]!.style))
      .toBe(false);
  });
});

describe('query notebook admission', () => {
  it('admits v3 and upgrades legacy members, names, sensitivity, and styles', () => {
    const current = notebook(group('g1', 'wolf'));
    expect(parseQueryNotebook(current)).toBe(current);
    expect(parseQueryNotebook({
      schema: 'texttrends/query-notebook/1',
      groups: [{
        id: 'g1', name: 'New York', countOverlaps: false,
        members: [{
          id: 'm1', kind: 'phrase', surfaces: ['New', 'York'],
          match: { case: 'sensitive', diacritics: 'sensitive' }, crossSentence: false,
        }],
      }],
    })).toEqual(notebook({
      id: 'g1', aliases: ['New York'], exactMatch: true, countOverlaps: false,
      style: { color: 'blue', line: 'solid' },
    }));
  });

  it('rejects wrong schemas, duplicate ids, sparse groups, and hostile over-cap arrays', () => {
    expect(() => parseQueryNotebook({ schema: 'unknown', groups: [] })).toThrow(/schema/);
    expect(() => parseQueryNotebook(notebook(group('g', 'a'), group('g', 'b'))))
      .toThrow(/duplicate/);
    expect(() => parseQueryNotebook({ schema: 'texttrends/query-notebook/3', groups: Array(1) }))
      .toThrow(/dense/);
    expect(() => parseQueryNotebook({
      schema: 'texttrends/query-notebook/3',
      groups: Array.from({ length: NOTEBOOK_LIMITS_V1.maxGroups + 1 }, (_, i) => group(`g${i}`, `a${i}`)),
    })).toThrow(/at most/);
  });
});

describe('memberSemanticKey', () => {
  it('is id-independent and stays aligned with core group identity', () => {
    const member = { id: 'm1', kind: 'token' as const, surface: 'wolf', match: FOLDED_MATCH };
    expect(memberSemanticKey(member)).toBe(termGroupIdentity({
      id: 'synthetic', members: [member], countOverlaps: false,
    }));
    expect(memberSemanticKey({ ...member, id: 'm2' })).toBe(memberSemanticKey(member));
  });
});
