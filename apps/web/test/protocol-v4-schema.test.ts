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
  defaultExtractionRecipes,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  TERM_GROUP_LIMITS_V1,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  INVENTORY_MAX_GROWTH_POINTS,
  INVENTORY_MAX_MATTR_WINDOW,
  INVENTORY_MAX_RHYTHM_BINS_PER_DOC,
  INVENTORY_MIN_GROWTH_POINTS,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_WINDOW_MAX,
} from '@texttrends/core';

const extractionRecipes = await defaultExtractionRecipes();

function docSpec(overrides: Record<string, unknown> = {}) {
  return {
    doc: 'a',
    language: 'en',
    source: { expectedHash: 'sh', byteLength: 10, format: 'txt' },
    extraction: {
      recipe: extractionRecipes.txt,
      recipeHash: 'erec',
      expectedText: 'th',
      expectedTextLengthUtf16: 10,
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

  it('accepts a well-formed begin-generation carrying full recipe values', () => {
    const msg = { v, t: 'begin-generation', job: 1, generation: 'g', docs: [docSpec()], indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4(msg)).not.toBeNull();
  });

  it('derives wire format membership from the core catalog — every SOURCE_FORMAT_IDS narrows, unknown rejected', () => {
    // Iterating the catalog (not a second hardcoded list) proves the wire check
    // cannot drift from core's authority.
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    for (const format of SOURCE_FORMAT_IDS) {
      const spec = docSpec({
        source: { byteLength: 10, format },
        extraction: { recipe: extractionRecipes[format], recipeHash: 'e' },
      });
      expect(parseToWorkerV4({ ...base, docs: [spec] }), format).not.toBeNull();
      expect(SOURCE_FORMATS[format].extractionKind === 'literal' || SOURCE_FORMATS[format].extractionKind === 'transformed').toBe(true);
    }
    // An unknown format is rejected at the membership check.
    const unknown = docSpec({ source: { byteLength: 10, format: 'pdf' } });
    expect(parseToWorkerV4({ ...base, docs: [unknown] })).toBeNull();
  });

  it('rejects a doc spec missing source or extraction sub-shapes', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: undefined })] })).toBeNull();
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ extraction: undefined })] })).toBeNull();
    // Bad discriminant scalars.
    expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: { byteLength: 1, format: 'pdf' } })] })).toBeNull();
  });

  it('optional extraction identity fields may be absent but must be typed when present', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    const noOptionals = docSpec({
      source: { byteLength: 10, format: 'txt' },
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
      expect(parseToWorkerV4({ ...base, docs: [docSpec({ source: { byteLength: n, format: 'txt' } })] }), why).toBeNull();
      expect(parseToWorkerV4({ ...base, docs: [docSpec({ extraction: { recipe: extractionRecipes.txt, recipeHash: 'e', expectedTextLengthUtf16: n } })] }), why).toBeNull();
      expect(parseToWorkerV4({ v, t: 'cancel', job: n }), why).toBeNull();
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

  it('rejects UNSUPPORTED recipe identities and EXTRA fields (one operation, one identity)', () => {
    const base = { v, t: 'begin-generation', job: 1, generation: 'g', indexRecipe: DEFAULT_INDEX_RECIPE };
    expect(parseToWorkerV4({ ...base, indexRecipe: {}, docs: [docSpec()] })).toBeNull();
    expect(parseToWorkerV4({ ...base, indexRecipe: { ...DEFAULT_INDEX_RECIPE, futurePolicy: 'x' }, docs: [docSpec()] })).toBeNull();
  });
});

describe('narrowQueryV4', () => {
  const kwicReq = { contextTokens: 6, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } };
  const kwicTracks = [{ seriesId: 's1', group: wolfGroup }];

  it('accepts trend and concordance with complete request fields', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } })).toBe(true);
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'fixed-tokens', count: 250 } } })).toBe(true);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: kwicReq })).toBe(true);
    // kwic accepts an optional axis center and multiple tracks.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 's1', group: wolfGroup }, { seriesId: 's2', group: wolfGroup }], request: { ...kwicReq, center: { doc: 'a', token: 3 } } })).toBe(true);
    // A valid selection with well-formed ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: 0, end: 5 } }] }, group: wolfGroup, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } })).toBe(true);
  });

  it('rejects skeletal requests, malformed ranges, and concordance caps', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'x', bins: { mode: 'per-doc', count: 4 } } })).toBe(false);
    // A skeletal concordance request is not valid.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: {} })).toBe(false);
    // Malformed selection ranges.
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: 7 }, group: wolfGroup, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } })).toBe(false);
    const sixTracks = Array.from({ length: 6 }, (_, i) => ({ seriesId: `s${i}`, group: wolfGroup }));
    // kwic: 0 tracks, over the shared cap, duplicate seriesId, and a malformed center.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [], request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: sixTracks, request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 'd', group: wolfGroup }, { seriesId: 'd', group: wolfGroup }], request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, center: { doc: 'a', token: 'x' } } })).toBe(false);
    // The forbidden dual shape: a valid `tracks` alongside a contradictory legacy `group`.
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, group: wolfGroup, request: kwicReq })).toBe(false);
    expect(narrowQueryV4({ op: 'bogus' })).toBe(false);
    // Exact match-mode enums (a bogus value must not silently mean sensitive).
    const badMatch = { ...wolfGroup, members: [{ id: 'm', kind: 'token', surface: 'w', match: { case: 'x', diacritics: 'folded' } }] };
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: badMatch, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } })).toBe(false);
  });

  it('enforces TERM_GROUP_LIMITS_V1 at the wire — same authority as the kernel validator', () => {
    const trend = (group: unknown) =>
      narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } });
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
      request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } },
    })).toBe(false);

    const ranges = [{ doc: 'a', tokens: { start: 0, end: 1 } }];
    ranges.length = 2;
    expect(narrowQueryV4({
      op: 'trend',
      selection: { docs: ['a'], ranges },
      group: wolfGroup,
      request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } },
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

  it('inventory/1 narrows only within every exported request bound', () => {
    const query = (request: Record<string, unknown>) => narrowQueryV4({
      op: 'inventory',
      selection: { docs: ['a'] },
      request: {
        method: 'inventory/1',
        rhythmBinsPerDoc: 0,
        growthPoints: 0,
        mattrWindow: 500,
        ...request,
      },
    });
    expect(query({})).toBe(true);
    expect(query({
      rhythmBinsPerDoc: INVENTORY_MAX_RHYTHM_BINS_PER_DOC,
      growthPoints: INVENTORY_MAX_GROWTH_POINTS,
      mattrWindow: INVENTORY_MAX_MATTR_WINDOW,
    })).toBe(true);
    expect(query({ rhythmBinsPerDoc: INVENTORY_MAX_RHYTHM_BINS_PER_DOC + 1 })).toBe(false);
    expect(query({ growthPoints: INVENTORY_MIN_GROWTH_POINTS - 1 })).toBe(false);
    expect(query({ growthPoints: INVENTORY_MAX_GROWTH_POINTS + 1 })).toBe(false);
    expect(query({ mattrWindow: 0 })).toBe(false);
    expect(query({ mattrWindow: INVENTORY_MAX_MATTR_WINDOW + 1 })).toBe(false);
    expect(query({ method: 'inventory/2' })).toBe(false);
    expect(query({ extra: true })).toBe(false);
    expect(narrowQueryV4({
      op: 'inventory',
      selection: { docs: ['a'] },
      request: {
        method: 'inventory/1',
        rhythmBinsPerDoc: 0,
        growthPoints: 0,
        mattrWindow: 500,
      },
      extra: true,
    })).toBe(false);
  });

  it('freq-list/1 pins dense classes, NFC prefix, sort, and page-window bounds', () => {
    const query = (over: Record<string, unknown> = {}) => narrowQueryV4({
      op: 'freq-list',
      selection: { docs: ['a'] },
      request: {
        method: 'freq-list/1',
        filter: { minCount: 1, minDocFreq: 1, classes: ['lexical'] },
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: FREQUENCY_PAGE_MAX },
        dispersion: true,
        ...over,
      },
    });
    expect(query()).toBe(true);
    expect(query({ page: { offset: FREQUENCY_WINDOW_MAX - 1, limit: 1 } })).toBe(true);
    expect(query({ page: { offset: FREQUENCY_WINDOW_MAX, limit: 1 } })).toBe(false);
    expect(query({ page: { offset: 0, limit: FREQUENCY_PAGE_MAX + 1 } })).toBe(false);
    expect(query({ filter: { minCount: 0, minDocFreq: 1, classes: ['lexical'] } })).toBe(false);
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: [] } })).toBe(false);
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: ['lexical', 'lexical'] } })).toBe(false);
    const sparse = ['lexical'];
    sparse.length = 2;
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: sparse } })).toBe(false);
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: ['lexical'], prefixNfc: 'e\u0301' } })).toBe(false);
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: ['lexical'], prefixNfc: 'x'.repeat(FREQUENCY_PREFIX_MAX_UNITS + 1) } })).toBe(false);
    expect(query({ sort: { by: 'bogus', dir: -1 } })).toBe(false);
    expect(query({ sort: { by: 'count', dir: 0 } })).toBe(false);
    expect(query({ page: { offset: 0, limit: 1, extra: true } })).toBe(false);
    expect(query({ filter: { minCount: 1, minDocFreq: 1, classes: ['lexical'], extra: true } })).toBe(false);
    expect(query({ dispersion: 'yes' })).toBe(false);
    expect(query({ sort: { by: 'dp', dir: -1 }, dispersion: false })).toBe(false);
    expect(query({ sort: { by: 'dpNorm', dir: -1 }, dispersion: false })).toBe(false);
  });

  it('keyness/1 pins two selections, methods, filters, sort, side, and page window', () => {
    const request = (over: Record<string, unknown> = {}) => ({
      method: 'keyness-g2-2x2/1',
      effect: 'log-ratio-halves/1',
      a: { docs: ['a'] },
      b: { docs: ['b'] },
      filter: {
        minCountTotal: 5,
        minDocFreqTotal: 2,
        classes: ['lexical'],
      },
      sort: { by: 'logRatio', dir: -1 },
      page: { offset: 0, limit: FREQUENCY_PAGE_MAX },
      side: 'a',
      ...over,
    });
    const query = (over: Record<string, unknown> = {}) =>
      narrowQueryV4({ op: 'keyness', request: request(over) });
    expect(query()).toBe(true);
    expect(query({
      a: {
        docs: ['a'],
        ranges: [{ doc: 'a', tokens: { start: 0, end: 10 } }],
      },
      b: { docs: ['b'] },
      side: 'both',
      sort: { by: 'countB', dir: 1 },
      page: { offset: FREQUENCY_WINDOW_MAX - 1, limit: 1 },
    })).toBe(true);
    expect(query({ method: 'keyness-g2-2x2/2' })).toBe(false);
    expect(query({ effect: 'log-ratio/2' })).toBe(false);
    expect(query({ a: { docs: new Array(1) } })).toBe(false);
    expect(query({ b: { docs: ['b'], ranges: 7 } })).toBe(false);
    expect(query({
      filter: { minCountTotal: 0, minDocFreqTotal: 1, classes: ['lexical'] },
    })).toBe(false);
    expect(query({
      filter: {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical', 'lexical'],
      },
    })).toBe(false);
    const sparseClasses = ['lexical'];
    sparseClasses.length = 2;
    expect(query({
      filter: {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: sparseClasses,
      },
    })).toBe(false);
    expect(query({ sort: { by: 'dp', dir: -1 } })).toBe(false);
    expect(query({ sort: { by: 'g2', dir: 0 } })).toBe(false);
    expect(query({ side: 'left' })).toBe(false);
    expect(query({
      page: { offset: FREQUENCY_WINDOW_MAX, limit: 1 },
    })).toBe(false);
    expect(query({
      filter: {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical'],
        extra: true,
      },
    })).toBe(false);
    expect(narrowQueryV4({
      op: 'keyness',
      request: request(),
      selection: { docs: ['a'] },
    })).toBe(false);
  });

  it('rejects unsupported closed-literal coordinate and sort-key/dir values', () => {
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'bogus', bins: { mode: 'per-doc', count: 4 } } })).toBe(false);
    expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'bogus', count: 4 } } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, sort: [{ at: 'bogus', dir: 1 }] } })).toBe(false);
    expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, sort: [{ at: 'pos', dir: 0 }] } })).toBe(false);
  });

  it('rejects non-finite/negative/fractional/unsafe numeric quantities across every query op', () => {
    for (const n of BAD_QUANTITIES) {
      const why = String(n);
      expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: n } } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'trend', selection: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: n, end: 5 } }] }, group: wolfGroup, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, contextTokens: n } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, page: { offset: n, limit: 10 } } }), why).toBe(false);
      expect(narrowQueryV4({ op: 'kwic', selection: { docs: ['a'] }, tracks: kwicTracks, request: { ...kwicReq, center: { doc: 'a', token: n } } }), why).toBe(false);
      expect(narrowQueryV4({
        op: 'inventory',
        selection: { docs: ['a'] },
        request: {
          method: 'inventory/1',
          rhythmBinsPerDoc: n,
          growthPoints: 0,
          mattrWindow: 500,
        },
      }), why).toBe(false);
    }
  });

  it('enforces exact trend-bin shapes and mode-specific bounds', () => {
    const trend = (bins: unknown) => narrowQueryV4({
      op: 'trend',
      selection: { docs: ['a'] },
      group: wolfGroup,
      request: { coordinate: 'document-relative', bins },
    });

    expect(narrowQueryV4({
      op: 'trend',
      selection: { docs: ['a'] },
      group: wolfGroup,
      request: { coordinate: 'document-relative', binsPerDoc: 40 },
    })).toBe(false);
    expect(trend({ mode: 'per-doc', count: 3 })).toBe(false);
    expect(trend({ mode: 'per-doc', count: 201 })).toBe(false);
    expect(trend({ mode: 'fixed-tokens', count: 249 })).toBe(false);
    expect(trend({ mode: 'fixed-tokens', count: 50_001 })).toBe(false);
    expect(trend({ mode: 'per-doc', count: 40, extra: true })).toBe(false);
  });
});
