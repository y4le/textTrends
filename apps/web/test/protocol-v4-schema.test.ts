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
      override: emptyOverride('th', 'ch', 'srec'),
      overrideHash: 'oh',
    },
    ...overrides,
  };
}

const v = PROTOCOL_VERSION_V4;
const wolfGroup = {
  id: 'g', countOverlaps: false,
  members: [{ id: 'm', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } }],
};

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

  it('narrows ingest transfer, cancel, and excerpt', () => {
    expect(parseToWorkerV4({ v, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: new ArrayBuffer(4) })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: [1, 2] })).toBeNull();
    expect(parseToWorkerV4({ v, t: 'cancel', job: 3 })).not.toBeNull();
    expect(parseToWorkerV4({ v, t: 'excerpt', job: 4, snapshot: 's', doc: 'a', charStart: 0, charEnd: 2 })).not.toBeNull();
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

  it('rejects UNSUPPORTED recipe identities and INCOMPLETE override values (not just missing subshapes)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    // Unsupported index recipe.
    expect(parseToWorkerV4({ ...base, indexRecipe: {}, docs: [docSpec()] })).toBeNull();
    // Unsupported structure evidence order / empty chapter policy.
    const badStructRecipe = { ...DEFAULT_STRUCTURE_RECIPE, evidenceOrder: ['unsupported-policy'] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: badStructRecipe, recipeHash: 'r', override: emptyOverride('t', 'c', 'r'), overrideHash: 'o' } })] })).toBeNull();
    // An `add` override with an incomplete SectionValue (no chars) would
    // crash applyOverride — must be rejected at the wire.
    const badOverride = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'add', key: 'x', value: {} }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: 'r', override: badOverride, overrideHash: 'o' } })] })).toBeNull();
    // A duplicate-target override is non-canonical and rejected.
    const dupOverride = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'remove', target: 'x' }, { op: 'remove', target: 'x' }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: 'r', override: dupOverride, overrideHash: 'o' } })] })).toBeNull();
  });

  it('rejects EXTRA fields on recipes and override changes (one operation, one identity)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    // An unknown field on the index recipe would hash to a distinct identity.
    expect(parseToWorkerV4({ ...base, indexRecipe: { ...DEFAULT_INDEX_RECIPE, futurePolicy: 'x' }, docs: [docSpec()] })).toBeNull();
    // Extra field on a structure recipe.
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: { ...DEFAULT_STRUCTURE_RECIPE, extra: 1 }, recipeHash: 'r', override: emptyOverride('t', 'c', 'r'), overrideHash: 'o' } })] })).toBeNull();
    // Extra field on an override CHANGE hashes differently yet applies the same.
    const extraChange = { schema: 'texttrends/structure-override/1', text: 't', candidates: 'c', baseRecipe: 'r', changes: [{ op: 'remove', target: 'x', ignored: true }] };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: 'r', override: extraChange, overrideHash: 'o' } })] })).toBeNull();
  });
});

describe('narrowQueryV4', () => {
  const kwicReq = { contextTokens: 6, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } };
  const passageReq = { doc: 'a', centerToken: 3, maxTokens: 200, tracks: [{ seriesId: 's1', group: wolfGroup }] };

  it('accepts trend/kwic/passage/structure with COMPLETE request fields', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 2 } })).toBe(true);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup, request: kwicReq })).toBe(true);
    expect(narrowQueryV4({ op: 'passage', request: passageReq })).toBe(true);
    expect(narrowQueryV4({ op: 'structure', request: { doc: 'a' } })).toBe(true);
    // A valid selection with well-formed ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: 0, end: 5 } }] }, group: wolfGroup, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(true);
  });

  it('rejects skeletal/malformed requests, ranges, and passage caps', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'x', binsPerDoc: 1 } })).toBe(false);
    // A skeletal kwic/passage request is NOT valid (required fields missing).
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup, request: {} })).toBe(false);
    expect(narrowQueryV4({ op: 'passage', request: { doc: 'a' } })).toBe(false);
    // Malformed selection ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: 7 }, group: wolfGroup, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(false);
    // Passage: over the 5-track cap and duplicate seriesIds.
    const sixTracks = Array.from({ length: 6 }, (_, i) => ({ seriesId: `s${i}`, group: wolfGroup }));
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: sixTracks } })).toBe(false);
    expect(narrowQueryV4({ op: 'passage', request: { ...passageReq, tracks: [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: wolfGroup }] } })).toBe(false);
    expect(narrowQueryV4({ op: 'structure', request: {} })).toBe(false);
    expect(narrowQueryV4({ op: 'bogus' })).toBe(false);
    // Exact match-mode enums (a bogus value must not silently mean sensitive).
    const badMatch = { ...wolfGroup, members: [{ id: 'm', kind: 'token', surface: 'w', match: { case: 'x', diacritics: 'folded' } }] };
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: badMatch, request: { coordinate: 'declared-sequence', binsPerDoc: 1 } })).toBe(false);
  });

  it('rejects unsupported closed-literal coordinate and sort-key/dir values', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'bogus', binsPerDoc: 1 } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup, request: { ...kwicReq, sort: [{ at: 'bogus', dir: 1 }] } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup, request: { ...kwicReq, sort: [{ at: 'pos', dir: 0 }] } })).toBe(false);
  });
});
