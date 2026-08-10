/**
 * Pure member-authoring helpers (slice-1 commit D): the narrow shorthand
 * compiler, phrase chips, and the concordance evidence key. DOM behavior is
 * proven in the Playwright acceptance spec.
 */
import { describe, expect, it } from 'vitest';
import { TERM_GROUP_LIMITS_V1, type MatchMode } from '@texttrends/core';
import { compileMemberInput, compilePhraseChips, describeMember, describeMatch } from '../src/lib/member-edit.ts';
import { kwicRowKey, type KwicRowView } from '../src/lib/store.ts';

const FOLDED: MatchMode = { case: 'folded', diacritics: 'folded' };
const id = () => 'm1';

describe('compileMemberInput — the DELIBERATELY narrow shorthand', () => {
  it('compiles token, prefix (one trailing *), and suffix (one leading *)', () => {
    expect(compileMemberInput('wolf', FOLDED, id)).toEqual({ ok: true, member: { id: 'm1', kind: 'token', surface: 'wolf', match: FOLDED } });
    expect(compileMemberInput(' wolf* ', FOLDED, id)).toEqual({ ok: true, member: { id: 'm1', kind: 'prefix', stem: 'wolf', match: FOLDED } });
    expect(compileMemberInput('*wolf', FOLDED, id)).toEqual({ ok: true, member: { id: 'm1', kind: 'suffix', stem: 'wolf', match: FOLDED } });
  });

  it('rejects bare *, both-ends, and internal asterisks — never silently reinterpreted', () => {
    for (const bad of ['*', '*wolf*', 'wo*lf', '**', '*wo*lf']) {
      const r = compileMemberInput(bad, FOLDED, id);
      expect(r.ok, bad).toBe(false);
    }
  });

  it('rejects internal whitespace in a member body — a spaced surface can never match one indexed token (review-D)', () => {
    for (const bad of ['dire wolf', 'wolf *', '* wolf', 'dire\twolf', 'wolf\u00a0run*']) {
      const r = compileMemberInput(bad, FOLDED, id);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.error).toMatch(/one word|asterisk/);
    }
  });

  it('rejects empty input and over-long bodies; NFC-normalizes the body', () => {
    expect(compileMemberInput('   ', FOLDED, id).ok).toBe(false);
    expect(compileMemberInput(`${'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1)}*`, FOLDED, id).ok).toBe(false);
    const decomposed = compileMemberInput('café', FOLDED, id);
    expect(decomposed.ok && decomposed.member.kind === 'token' && decomposed.member.surface).toBe('café');
  });

  it('carries the SELECTED match mode verbatim (sensitive stays sensitive, never "exact")', () => {
    const exact: MatchMode = { case: 'sensitive', diacritics: 'sensitive' };
    const r = compileMemberInput('Wolf', exact, id);
    expect(r.ok && r.member.match).toEqual(exact);
  });
});

describe('compilePhraseChips — ordered chips, no tokenization', () => {
  it('needs 2..max ordered words; trims/normalizes; refuses asterisks and over-long words', () => {
    const ok = compilePhraseChips([' dire ', 'wolf'], FOLDED, id);
    expect(ok.ok && ok.member.kind === 'phrase' && ok.member.elements).toEqual([
      { kind: 'token', surface: 'dire' },
      { kind: 'token', surface: 'wolf' },
    ]);
    expect(ok.ok && ok.member.kind === 'phrase' && ok.member.crossSentence).toBe(false);
    expect(compilePhraseChips(['solo'], FOLDED, id).ok).toBe(false);
    expect(compilePhraseChips(Array.from({ length: TERM_GROUP_LIMITS_V1.maxPhraseElements + 1 }, () => 'w'), FOLDED, id).ok).toBe(false);
    expect(compilePhraseChips(['dire', 'wolf*'], FOLDED, id).ok).toBe(false);
    // A multiword chip is refused, NEVER silently split (review-D).
    const spaced = compilePhraseChips(['dire wolf', 'runs'], FOLDED, id);
    expect(spaced.ok).toBe(false);
    expect(!spaced.ok && spaced.error).toContain('one word per chip');
    expect(compilePhraseChips(['dire', 'w'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1)], FOLDED, id).ok).toBe(false);
  });
});

describe('presentation helpers', () => {
  it('describeMember and describeMatch are stable presentation text', () => {
    expect(describeMember({ id: 'm', kind: 'prefix', stem: 'wolv', match: FOLDED })).toBe('wolv*');
    expect(describeMember({ id: 'm', kind: 'phrase', elements: [{ kind: 'token', surface: 'dire' }, { kind: 'token', surface: 'wolf' }], match: FOLDED, crossSentence: false })).toBe('“dire wolf”');
    expect(describeMember({ id: 'm', kind: 'phrase', elements: [{ kind: 'suffix', stem: 'ork' }, { kind: 'prefix', stem: 'cit' }], match: FOLDED, crossSentence: false })).toBe('“*ork cit*”');
    expect(describeMatch(FOLDED)).toBe('any case, any accents');
    expect(describeMatch({ case: 'sensitive', diacritics: 'folded' })).toBe('exact case, any accents');
  });
});

describe('kwicRowKey — full evidence identity (commit D)', () => {
  const base: KwicRowView = {
    seriesId: 's1', groupId: 'g1', members: [0], node: { start: 10, end: 11 },
    doc: 'a', pos: 5, left: 'l', nodeText: 'wolf', right: 'r',
  };

  it('two countOverlaps rows at the SAME (series, doc, pos) get DISTINCT keys', () => {
    // e.g. phrase [dire wolf] and token wolf both starting at pos 5 under
    // countOverlaps=true: same start, different span and member.
    const phraseRow: KwicRowView = { ...base, members: [1], node: { start: 10, end: 19 }, nodeText: 'dire wolf' };
    expect(kwicRowKey(base)).not.toBe(kwicRowKey(phraseRow));
    // And a merged row reporting BOTH members differs from either alone.
    const merged: KwicRowView = { ...base, members: [0, 1], node: { start: 10, end: 19 } };
    expect(new Set([kwicRowKey(base), kwicRowKey(phraseRow), kwicRowKey(merged)]).size).toBe(3);
  });

  it('is INJECTIVE over adversarial string fields — no delimiter aliasing, and groupId participates (review-D)', () => {
    // Concatenation would alias these: same joined text, different fields.
    const shifted: KwicRowView = { ...base, seriesId: 'a:b', doc: 'c' };
    const shifted2: KwicRowView = { ...base, seriesId: 'a', doc: 'b:c' };
    expect(kwicRowKey(shifted)).not.toBe(kwicRowKey(shifted2));
    // A groupId-only difference is a different evidence row.
    expect(kwicRowKey(base)).not.toBe(kwicRowKey({ ...base, groupId: 'g2' }));
    // JSON-hostile characters in ids stay injective too.
    const quoted: KwicRowView = { ...base, seriesId: 's"1', doc: 'a' };
    const quoted2: KwicRowView = { ...base, seriesId: 's', doc: '"1:a' };
    expect(kwicRowKey(quoted)).not.toBe(kwicRowKey(quoted2));
  });

  it('is deterministic for identical evidence', () => {
    expect(kwicRowKey(base)).toBe(kwicRowKey({ ...base }));
  });
});
