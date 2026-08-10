/**
 * Pure member-authoring helpers for the group editor (slice-1 commit D).
 *
 * The shorthand is DELIBERATELY narrow (recorded ruling §3):
 * - `wolf`   → token member;
 * - `wolf*`  → prefix member (ONE trailing asterisk);
 * - `*wolf`  → suffix member (ONE leading asterisk);
 * - bare `*`, asterisks at both ends, and internal asterisks are ERRORS —
 *   never silently reinterpreted.
 * Phrases are authored as ORDERED TOKEN CHIPS, one surface per chip —
 * quote-to-phrase tokenization is deferred (splitting on whitespace is not a
 * canonical rule, and honest tokenization needs the per-document segmenter).
 *
 * Everything here is text → data; no store, no DOM.
 */

import { TERM_GROUP_LIMITS_V1, type GroupMember, type MatchMode } from '@texttrends/core';

export type CompiledMember =
  | { readonly ok: true; readonly member: GroupMember }
  | { readonly ok: false; readonly error: string };

/** Compile ONE add-member input under the narrow shorthand. `newId` mints the
 *  member id; `match` is the editor's currently selected mode pair. */
export function compileMemberInput(raw: string, match: MatchMode, newId: () => string): CompiledMember {
  const text = raw.trim().normalize('NFC');
  if (text === '') return { ok: false, error: 'type a term to add' };
  const leading = text.startsWith('*');
  const trailing = text.endsWith('*');
  if (text === '*' || (leading && trailing)) {
    return { ok: false, error: 'one asterisk only: wolf* (prefix) or *wolf (suffix)' };
  }
  const body = leading ? text.slice(1) : trailing ? text.slice(0, -1) : text;
  if (body.includes('*')) {
    return { ok: false, error: 'an asterisk is only allowed at one end: wolf* or *wolf' };
  }
  // A member matches ONE indexed token; the vocabulary holds single word-like
  // segments, so a whitespace-bearing surface would silently never match
  // (review-D). Multi-word matching is what phrases are for.
  if (/\s/u.test(body)) {
    return { ok: false, error: 'one word per member — use a phrase for multi-word matches' };
  }
  if (body.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits) {
    return { ok: false, error: `a term is at most ${TERM_GROUP_LIMITS_V1.maxSurfaceUnits} UTF-16 code units` };
  }
  if (leading) return { ok: true, member: { id: newId(), kind: 'suffix', stem: body, match } };
  if (trailing) return { ok: true, member: { id: newId(), kind: 'prefix', stem: body, match } };
  return { ok: true, member: { id: newId(), kind: 'token', surface: body, match } };
}

/** Compile ordered phrase chips into one phrase member. Chips are individual
 *  surfaces (already entered one by one); empty chips were refused at entry. */
export function compilePhraseChips(chips: readonly string[], match: MatchMode, newId: () => string): CompiledMember {
  const surfaces = chips.map((c) => c.trim().normalize('NFC')).filter((c) => c !== '');
  if (surfaces.length < 2) return { ok: false, error: 'a phrase needs at least two words' };
  if (surfaces.length > TERM_GROUP_LIMITS_V1.maxPhraseElements) {
    return { ok: false, error: `a phrase is at most ${TERM_GROUP_LIMITS_V1.maxPhraseElements} words` };
  }
  if (surfaces.some((s) => s.includes('*'))) {
    return { ok: false, error: 'phrases match exact words — no asterisks' };
  }
  // One word per chip, NEVER silently split (the ruling forbids treating
  // whitespace-splitting as a canonical rule).
  if (surfaces.some((s) => /\s/u.test(s))) {
    return { ok: false, error: 'one word per chip — add each phrase word separately' };
  }
  const over = surfaces.find((s) => s.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
  if (over !== undefined) {
    return { ok: false, error: `a word is at most ${TERM_GROUP_LIMITS_V1.maxSurfaceUnits} UTF-16 code units` };
  }
  return {
    ok: true,
    member: {
      id: newId(),
      kind: 'phrase',
      elements: surfaces.map((surface) => ({ kind: 'token' as const, surface })),
      match,
      crossSentence: false,
    },
  };
}

/** Human description of a member for the editor list (presentation only). */
export function describeMember(m: GroupMember): string {
  switch (m.kind) {
    case 'token': return m.surface;
    case 'phrase': return `“${m.elements.map((element) => element.kind === 'token'
      ? element.surface
      : element.kind === 'prefix' ? `${element.stem}*` : `*${element.stem}`).join(' ')}”`;
    case 'prefix': return `${m.stem}*`;
    default: return `*${m.stem}`;
  }
}

/** The user-facing name of a match dimension's state (values stay wire-true:
 *  sensitive|folded — the UI SAYS "exact", the data never does). */
export function describeMatch(m: MatchMode): string {
  const c = m.case === 'folded' ? 'any case' : 'exact case';
  const d = m.diacritics === 'folded' ? 'any accents' : 'exact accents';
  return `${c}, ${d}`;
}
