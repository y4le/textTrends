/**
 * Protocol v4 runtime validators (contract §12.8: each op's runtime schema
 * complete before the engine implements it). These prove the total wire
 * boundary — well-formed messages narrow, malformed ones are rejected —
 * ahead of the commit-6 engine migration.
 */
import { describe, expect, it } from 'vitest';
import { parseToWorkerV4, narrowQueryV4 } from '../src/worker/protocol-v4-schema.ts';
import { PROTOCOL_VERSION_V4 } from '../src/worker/protocol-v4.ts';
import {
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  defaultExtractionRecipes,
  emptyOverride,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  TERM_GROUP_LIMITS_V1,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
} from '@texttrends/core';

const extractionRecipes = await defaultExtractionRecipes();

function docSpec(overrides: Record<string, unknown> = {}) {
  return {
    doc: 'a',
    language: 'en',
    source: { expectedHash: 'sh', byteLength: 10, format: 'txt', availability: 'bundled' },
    extraction: {
      recipe: extractionRecipes.txt,
      recipeHash: 'erec',
      expectedText: 'th',
      expectedTextLengthUtf16: 10,
      expectedCandidates: 'ch',
    },
    structure: {
      recipe: DEFAULT_STRUCTURE_RECIPE,
      recipeHash: 'srec',
      override: { kind: 'none' },
    },
    ...overrides,
  };
}

const v = PROTOCOL_VERSION_V4;
const wolfGroup = {
  id: 'g', countOverlaps: false,
  members: [{ id: 'm', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } }],
};

// Every count/position/length quantity is a NON-NEGATIVE SAFE INTEGER at the
// wire: `typeof number` alone admitted these, which poison cap totals and
// defeat kernel stopping comparisons. Shared by the envelope and query tables so
// the safe-integer boundary is pinned on both paths (incl. MAX_SAFE + 1).
const BAD_QUANTITIES = [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

describe('parseToWorkerV4 envelope', () => {
  it('rejects wrong version, non-objects, and missing t', () => {
    expect(parseToWorkerV4({ v: 3, t: 'cancel', job: 1 })).toBeNull();
    expect(parseToWorkerV4(null)).toBeNull();
    expect(parseToWorkerV4('x')).toBeNull();
    expect(parseToWorkerV4({ v, job: 1 })).toBeNull();
    expect(parseToWorkerV4({ v, t: 'bogus' })).toBeNull();
  });

  it('accepts a well-formed begin-generation carrying full recipe/override values', () => {
    const msg = { v, t: 'begin-generation', job: 1, generation: 'g', docs: [docSpec()], indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4(msg)).not.toBeNull();
  });

  it('derives wire format membership from the core catalog — every SOURCE_FORMAT_IDS narrows, unknown rejected', () => {
    // Iterating the catalog (not a second hardcoded list) proves the wire check
    // cannot drift from core's authority.
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    for (const format of SOURCE_FORMAT_IDS) {
      const spec = docSpec({
        source: { byteLength: 10, format, availability: 'bundled' },
        extraction: { recipe: extractionRecipes[format], recipeHash: 'e' },
      });
      expect(parseToWorkerV4({ ...base, docs: [spec] }), format).not.toBeNull();
      expect(SOURCE_FORMATS[format].extractionKind === 'literal' || SOURCE_FORMATS[format].extractionKind === 'transformed').toBe(true);
    }
    // An unknown format is rejected at the membership check.
    const unknown = docSpec({ source: { byteLength: 10, format: 'pdf', availability: 'bundled' } });
    expect(parseToWorkerV4({ ...base, docs: [unknown] })).toBeNull();
  });

  it('rejects a doc spec missing source/extraction/structure sub-shapes', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: undefined })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ extraction: undefined })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: undefined })] })).toBeNull();
    // Bad discriminant scalars.
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: { byteLength: 1, format: 'pdf', availability: 'bundled' } })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: { byteLength: 1, format: 'txt', availability: 'nope' } })] })).toBeNull();
  });

  it('optional extraction identity fields may be absent but must be typed when present', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    const noOptionals = docSpec({
      source: { byteLength: 10, format: 'txt', availability: 'external' },
      extraction: { recipe: extractionRecipes.md, recipeHash: 'erec' },
    });
    expect(parseToWorkerV4({ ...base, docs: [noOptionals] })).not.toBeNull();
    const badLen = docSpec({ extraction: { recipe: extractionRecipes.txt, recipeHash: 'e', expectedTextLengthUtf16: 'ten' } });
    expect(parseToWorkerV4({ ...base, docs: [badLen] })).toBeNull();
  });

  it('narrows ingest transfer and cancel; an unknown tag maps to null', () => {
    expect(parseToWorkerV4({ v, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: new ArrayBuffer(4) })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: [1, 2] })).toBeNull();
    expect(parseToWorkerV4({ v, t: 'cancel', job: 3 })).not.toBeNull();
    // The retired direct-excerpt op is an unknown tag now — PARSE_FAILED at the
    // wire, exactly like any tag the protocol never knew.
    expect(parseToWorkerV4({ v, t: 'excerpt', job: 4, snapshot: 's', doc: 'a', charStart: 0, charEnd: 2 })).toBeNull();
  });

  it('rejects non-finite/negative/fractional/UNSAFE envelope quantities (byteLength, textLength, job)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    for (const n of BAD_QUANTITIES) {
      const why = String(n);
      // A poisoned declared byteLength/textLength would corrupt the cap-preflight total.
      expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: { byteLength: n, format: 'txt', availability: 'bundled' } })] }), why).toBeNull();
      expect(parseToWorkerV4({ ...base, docs: [docSpec({ extraction: { recipe: extractionRecipes.txt, recipeHash: 'e', expectedTextLengthUtf16: n } })] }), why).toBeNull();
      expect(parseToWorkerV4({ v, t: 'cancel', job: n }), why).toBeNull();
    }
  });

  it('narrows the user-data operation map distinctly from analysis ops', () => {
    expect(parseToWorkerV4({ v, t: 'project-load', job: 5, project: 'p' })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'project-save', job: 6, project: 'p', manifest: {}, expectedRevision: 0 })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'project-save', job: 6, project: 'p', expectedRevision: 0 })).toBeNull(); // no manifest
    expect(parseToWorkerV4({ v, t: 'source-persist', job: 7, sourceHash: 'h', bytes: new ArrayBuffer(2) })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'source-persist', job: 7, sourceHash: 'h', bytes: 'nope' })).toBeNull();
  });

  it('rejects invalid CAS revisions (only a positive safe integer or the 0 create sentinel)', () => {
    const ok = { v, t: 'project-save', job: 6, project: 'p', manifest: {} };
    expect(parseToWorkerV4({ ...ok, expectedRevision: 0 })).not.toBeNull();
    expect(parseToWorkerV4({ ...ok, expectedRevision: 3 })).not.toBeNull();
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseToWorkerV4({ ...ok, expectedRevision: bad }), String(bad)).toBeNull();
    }
  });

  it('rejects sparse generation document arrays', () => {
    const docs = [docSpec()];
    docs.length = 2;
    expect(parseToWorkerV4({
      v,
      t: 'begin-generation',
      job: 1,
      generation: 'g',
      docs,
      indexRecipe: DEFAULT_INDEX_RECIPE,
    })).toBeNull();
  });

  const struct = (override: unknown) => ({ recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: 'r', override });

  it('accepts both override forms: none and a well-formed active correction', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'none' }) })] })).not.toBeNull();
    const active = { kind: 'active', value: emptyOverride('t', 'c', 'r'), hash: 'oh' };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct(active) })] })).not.toBeNull();
  });

  it('rejects malformed override inputs (bad kind, extra fields, incomplete active value)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    // Unknown kind, none-with-extra, active missing hash, active with a bad value.
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'bogus' }) })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'none', extra: 1 }) })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'active', value: emptyOverride('t', 'c', 'r') }) })] })).toBeNull();
    const badValue = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'add', key: 'x', value: {} }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'active', value: badValue, hash: 'h' }) })] })).toBeNull();
    // A duplicate-target active value is non-canonical.
    const dupValue = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'remove', target: 'x' }, { op: 'remove', target: 'x' }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'active', value: dupValue, hash: 'h' }) })] })).toBeNull();
  });

  it('the override wrapper is held to exact/plain discipline (symbols, non-enumerable, prototype, accessors)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    const reject = (override: unknown) =>
      expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct(override) })] })).toBeNull();
    reject({ kind: 'none', [Symbol('x')]: 1 });
    const nonEnum = { kind: 'none' };
    Object.defineProperty(nonEnum, 'extra', { value: 1, enumerable: false });
    reject(nonEnum);
    const inheritedNone = Object.create({ kind: 'none' });
    (inheritedNone as { extra: number }).extra = 1;
    reject(inheritedNone);
    const active = emptyOverride('t', 'c', 'r');
    const inheritedHash = Object.create({ hash: 'h' });
    Object.assign(inheritedHash, { kind: 'active', value: active });
    reject(inheritedHash);
    const getterValue: Record<string, unknown> = { kind: 'active', hash: 'h' };
    Object.defineProperty(getterValue, 'value', { get: () => active, enumerable: true });
    reject(getterValue);
  });

  it('rejects UNSUPPORTED recipe identities and EXTRA fields (one operation, one identity)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4({ ...base, indexRecipe: {}, docs: [docSpec()] })).toBeNull();
    expect(parseToWorkerV4({ ...base, indexRecipe: { ...DEFAULT_INDEX_RECIPE, futurePolicy: 'x' }, docs: [docSpec()] })).toBeNull();
    const badStructRecipe = { ...DEFAULT_STRUCTURE_RECIPE, evidenceOrder: ['unsupported-policy'] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: badStructRecipe, recipeHash: 'r', override: { kind: 'none' } } })] })).toBeNull();
    // Extra field on an active override change hashes differently yet applies the same.
    const extraChange = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'remove', target: 'x', ignored: true }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: struct({ kind: 'active', value: extraChange, hash: 'h' }) })] })).toBeNull();
  });
});

describe('narrowQueryV4', () => {
  const kwicReq = { contextTokens: 6, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } };
  const kwicTracks = [{ seriesId: 's1', group: wolfGroup }];
  const passageReq = { doc: 'a', centerToken: 3, maxTokens: 200, tracks: [{ seriesId: 's1', group: wolfGroup }] };

  it('accepts trend/kwic/passage/structure with COMPLETE request fields', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 2 } })).toBe(true);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: kwicReq })).toBe(true);
    expect(narrowQueryV4({ op: 'passage', request: passageReq })).toBe(true);
    expect(narrowQueryV4({ op: 'structure', request: { doc: 'a' } })).toBe(true);
    expect(narrowQueryV4({ op: 'structure-edit-context', request: { doc: 'a' } })).toBe(true);
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: 10, maxChars: 200 } })).toBe(true);
    // kwic accepts an optional axis center and multiple tracks.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 's1', group: wolfGroup }, { seriesId: 's2', group: wolfGroup }], request: { ...kwicReq, center: { doc: 'a', token: 3 } } })).toBe(true);
    // A valid selection with well-formed ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: 0, end: 5 } }] }, group: wolfGroup, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(true);
  });

  it('rejects skeletal/malformed requests, ranges, and passage caps', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'x', binsPerDoc: 1 } })).toBe(false);
    // A skeletal kwic/passage request is NOT valid (required fields missing).
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: {} })).toBe(false);
    expect(narrowQueryV4({ op: 'passage', request: { doc: 'a' } })).toBe(false);
    // Malformed selection ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: 7 }, group: wolfGroup, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(false);
    // Passage: over the 5-track cap and duplicate seriesIds.
    const sixTracks = Array.from({ length: 6 }, (_, i) => ({ seriesId: `s${i}`, group: wolfGroup }));
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: sixTracks } })).toBe(false);
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: wolfGroup }] } })).toBe(false);
    // Passage tracks share the ONE narrowing authority with kwic: an EMPTY
    // seriesId is rejected (the old inline copy admitted it) — zero tracks stay valid.
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: [{ seriesId: '', group: wolfGroup }] } })).toBe(false);
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: [] } })).toBe(true);
    // kwic: 0 tracks, over the shared cap, duplicate seriesId, and a malformed center.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [], request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: sixTracks, request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: wolfGroup }], request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, center: { doc: 'a', token: 'x' } } })).toBe(false);
    // The forbidden dual shape: a valid `tracks` alongside a contradictory legacy `group`.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, group: wolfGroup, request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'structure', request: {} })).toBe(false);
    expect(narrowQueryV4({ op: 'structure-edit-context', request: {} })).toBe(false);
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: 'x', maxChars: 1 } })).toBe(false);
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: 1 } })).toBe(false);
    // Non-finite budgets/anchors are rejected: a NaN budget would defeat the
    // window's stopping comparisons and return an unbounded slice.
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: 5, maxChars: NaN } })).toBe(false);
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: NaN, maxChars: 100 } })).toBe(false);
    expect(narrowQueryV4({ op: 'line-excerpt', request: { doc: 'a', anchor: 5, maxChars: Infinity } })).toBe(false);
    expect(narrowQueryV4({ op: 'bogus' })).toBe(false);
    // Exact match-mode enums (a bogus value must not silently mean sensitive).
    const badMatch = { ...wolfGroup, members: [{ id: 'm', kind: 'token', surface: 'w', match: { case: 'x', diacritics: 'folded' } }] };
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: badMatch, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(false);
  });

  it('enforces TERM_GROUP_LIMITS_V1 at the wire — same authority as the kernel validator', () => {
    const trend = (group: unknown) =>
      narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } });
    const member = (over: Record<string, unknown>) => ({
      id: 'm', kind: 'token', surface: 'w', match: { case: 'folded', diacritics: 'folded' }, ...over,
    });
    const g = (over: Record<string, unknown>) => ({ ...wolfGroup, ...over });
    // Emptiness at every string position — an empty affix stem would union the
    // entire vocabulary if it ever reached resolution.
    expect(trend(g({ id: '' }))).toBe(false);
    expect(trend(g({ members: [] }))).toBe(false);
    expect(trend(g({ members: [member({ id: '' })] }))).toBe(false);
    expect(trend(g({ members: [member({ surface: '' })] }))).toBe(false);
    expect(trend(g({ members: [{ id: 'm', kind: 'prefix', stem: '', match: { case: 'folded', diacritics: 'folded' } }] }))).toBe(false);
    expect(trend(g({ members: [member({ kind: 'phrase', surface: undefined, surfaces: ['a', ''], crossSentence: false })] }))).toBe(false);
    expect(trend(g({ members: [member({ kind: 'phrase', surface: undefined, surfaces: [], crossSentence: false })] }))).toBe(false);
    // Size bounds.
    expect(trend(g({ id: 'g'.repeat(TERM_GROUP_LIMITS_V1.maxIdUnits + 1) }))).toBe(false);
    expect(trend(g({ members: [member({ surface: 'w'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1) })] }))).toBe(false);
    expect(trend(g({ members: Array.from({ length: TERM_GROUP_LIMITS_V1.maxMembers + 1 }, (_, i) => member({ id: `m${i}` })) }))).toBe(false);
    expect(trend(g({ members: [member({ kind: 'phrase', surface: undefined, surfaces: Array.from({ length: TERM_GROUP_LIMITS_V1.maxPhraseSurfaces + 1 }, () => 'w'), crossSentence: false })] }))).toBe(false);
    // SPARSE arrays must not narrow: `every` skips holes, and structured
    // cloning preserves them into the kernel as undefined (review-A finding).
    expect(trend(g({ members: Array(1) }))).toBe(false);
    const sparseMembers = [member({})]; sparseMembers.length = 2;
    expect(trend(g({ members: sparseMembers }))).toBe(false);
    const sparseSurfaces = ['a']; sparseSurfaces.length = 2;
    expect(trend(g({ members: [member({ kind: 'phrase', surface: undefined, surfaces: sparseSurfaces, crossSentence: false })] }))).toBe(false);
    // Maximal-at-every-bound still narrows.
    expect(trend(g({
      id: 'g'.repeat(TERM_GROUP_LIMITS_V1.maxIdUnits),
      members: Array.from({ length: TERM_GROUP_LIMITS_V1.maxMembers }, (_, i) =>
        member({ id: `m${i}`, surface: 'w'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits) })),
    }))).toBe(true);
  });

  it('rejects sparse selection, range, track, and sort arrays', () => {
    const docs = ['a'];
    docs.length = 2;
    expect(narrowQueryV4({
      op: 'trend',
      selection: { docs },
      group: wolfGroup,
      request: { coordinate: 'declared-sequence', binsPerDoc: 1 },
    })).toBe(false);

    const ranges = [{ doc: 'a', tokens: { start: 0, end: 1 } }];
    ranges.length = 2;
    expect(narrowQueryV4({
      op: 'trend',
      selection: { docs: ['a'], ranges },
      group: wolfGroup,
      request: { coordinate: 'declared-sequence', binsPerDoc: 1 },
    })).toBe(false);

    const tracks = [...kwicTracks];
    tracks.length = 2;
    expect(narrowQueryV4({
      op: 'kwic',
      selection: { docs: ['a'] },
      tracks,
      request: kwicReq,
    })).toBe(false);

    const sort = [{ at: 'pos', dir: 1 }] as { at: string; dir: number }[];
    sort.length = 2;
    expect(narrowQueryV4({
      op: 'kwic',
      selection: { docs: ['a'] },
      tracks: kwicTracks,
      request: { ...kwicReq, sort },
    })).toBe(false);
  });

  it('dispersion/1 narrows only with the PINNED policy constants and valid tracks', () => {
    const disp = (over: Record<string, unknown> = {}, tracks: unknown = [{ seriesId: 's1', group: wolfGroup }]) =>
      narrowQueryV4({ op: 'dispersion', selection: { docs: ['a'] }, tracks, request: { method: 'dispersion/1', exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET, ...over } });
    expect(disp()).toBe(true);
    // Policy drift is a MALFORMED message, not a tunable (slice-2 ruling).
    expect(disp({ exactMax: DISPERSION_EXACT_MAX + 1 })).toBe(false);
    expect(disp({ bucketBudget: 1024 })).toBe(false);
    expect(disp({ method: 'dispersion/2' })).toBe(false);
    // Track discipline is the shared kwic/passage authority.
    expect(disp({}, [])).toBe(false);
    expect(disp({}, [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: { ...wolfGroup, id: 'g2' } }])).toBe(false);
    expect(disp({}, Array.from({ length: 6 }, (_, i) => ({ seriesId: `s${i}`, group: wolfGroup })))).toBe(false);
  });

  it('reader-page/1 narrows with zero tracks, closed cursor kinds, and before ≥ 1', () => {
    const rq = (cursor: Record<string, unknown>, over: Record<string, unknown> = {}, tracks: unknown = []) =>
      narrowQueryV4({ op: 'reader-page', tracks, request: { method: 'reader-page/1', doc: 'a', cursor, maxTokens: 100, ...over } });
    expect(rq({ kind: 'around', token: 0 })).toBe(true);
    expect(rq({ kind: 'from', token: 0 })).toBe(true);
    expect(rq({ kind: 'before', token: 1 })).toBe(true);
    expect(rq({ kind: 'before', token: 0 })).toBe(false); // before(0) has no page
    expect(rq({ kind: 'sideways', token: 1 })).toBe(false);
    expect(rq({ kind: 'from', token: -1 })).toBe(false);
    expect(rq({ kind: 'from', token: 0 }, { maxTokens: 0 })).toBe(false);
    expect(rq({ kind: 'from', token: 0 }, { method: 'reader-page/2' })).toBe(false);
    expect(narrowQueryV4({
      op: 'reader-page',
      selection: { docs: ['a'] },
      tracks: [],
      request: { method: 'reader-page/1', doc: 'a', cursor: { kind: 'from', token: 0 }, maxTokens: 100 },
    })).toBe(false);
    // Zero tracks legal; the shared track discipline still applies when present.
    expect(rq({ kind: 'from', token: 0 }, {}, [{ seriesId: 's1', group: wolfGroup }])).toBe(true);
    expect(rq({ kind: 'from', token: 0 }, {}, [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: { ...wolfGroup, id: 'g2' } }])).toBe(false);
  });

  it('rejects unsupported closed-literal coordinate and sort-key/dir values', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'bogus', binsPerDoc: 1 } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, sort: [{ at: 'bogus', dir: 1 }] } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, sort: [{ at: 'pos', dir: 0 }] } })).toBe(false);
  });

  it('rejects non-finite/negative/fractional/unsafe numeric quantities across every query op', () => {
    for (const n of BAD_QUANTITIES) {
      const why = String(n);
      expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: n } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: n, end: 5 } }] }, group: wolfGroup, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, contextTokens: n } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, page: { offset: n, limit: 10 } } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, center: { doc: 'a', token: n } } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, centerToken: n } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, maxTokens: n } }), why).toBe(false);
    }
  });
});
