/**
 * Runtime validators for protocol v4 (contract §12.8 requires each op's
 * runtime schema complete before the engine implements it). Every validator
 * accepts `unknown` and narrows; malformed containers/scalars are rejected
 * so the engine never sees a shape it cannot trust. Deep numeric-range
 * checks stay in the kernels — these guard container structure, discriminant
 * scalars, and the recipe VALUES the worker will recompute hashes
 * from.
 *
 * The engine narrows every inbound envelope with these before dispatch.
 */

import { exactRecord, isIndexRecipeProvisional, isNonNegSafeInt as isCount, isRecord, isSourceFormat, isString as isStr, MAX_KWIC_TRACKS, SOURCE_FORMATS, TERM_GROUP_LIMITS_V1, DISPERSION_BUCKET_BUDGET, DISPERSION_EXACT_MAX, INVENTORY_MAX_GROWTH_POINTS, INVENTORY_MAX_MATTR_WINDOW, INVENTORY_MAX_RHYTHM_BINS_PER_DOC, INVENTORY_MIN_GROWTH_POINTS, FREQUENCY_PAGE_MAX, FREQUENCY_PREFIX_MAX_UNITS, FREQUENCY_WINDOW_MAX, TREND_FIXED_TOKENS_MAX, TREND_FIXED_TOKENS_MIN, TREND_PER_DOC_MAX, TREND_PER_DOC_MIN } from '@texttrends/core';
import { PROTOCOL_VERSION_V4, type ToWorkerV4 } from './protocol-v4.ts';

const MATCH = new Set(['sensitive', 'folded']);
// Closed literal unions the kernels accept — a wire caller must not smuggle
// an unsupported coordinate/sort key through as a "trusted" request.
const COORDINATES = new Set(['document-relative', 'declared-sequence']);
const SORT_KEYS = new Set(['L3', 'L2', 'L1', 'R1', 'R2', 'R3', 'doc', 'pos']);
const FREQUENCY_CLASSES = new Set(['lexical', 'numeral']);
const FREQUENCY_SORT_KEYS = new Set(['count', 'docFreq', 'dp', 'dpNorm', 'key']);
const KEYNESS_SORT_KEYS = new Set(['logRatio', 'g2', 'countA', 'countB']);
const KEYNESS_SIDES = new Set(['a', 'b', 'both']);

function narrowTrendBins(value: unknown): boolean {
  if (!exactRecord(value, ['mode', 'count']) || !isCount(value.count)) return false;
  return value.mode === 'per-doc'
    ? value.count >= TREND_PER_DOC_MIN && value.count <= TREND_PER_DOC_MAX
    : value.mode === 'fixed-tokens'
      && value.count >= TREND_FIXED_TOKENS_MIN
      && value.count <= TREND_FIXED_TOKENS_MAX;
}

/** The extraction recipe value carried in a doc spec — structural shape only;
 *  the worker's async core validator (validateExtractionRecipe, which also
 *  checks the table hash) is the DEEP authority and commit 6 invokes it
 *  before any hash/admission work. */
function narrowExtractionRecipe(r: unknown): boolean {
  if (!isRecord(r) || r.schema !== 'texttrends/extraction-recipe/0-provisional' || !isSourceFormat(r.format)) return false;
  // Cheap STRUCTURAL guard only, keyed off the catalog's extraction kind:
  // literal formats carry a byte decoder + parser; transformed formats carry an
  // extractor policy. The deep authority (validateExtractionRecipe) checks every
  // field before any admission work.
  return SOURCE_FORMATS[r.format].extractionKind === 'literal'
    ? isRecord(r.decoder) && isRecord(r.parser)
    : isRecord(r.extractor);
}

function narrowDocSpec(d: unknown): boolean {
  if (!isRecord(d) || !isStr(d.doc) || !isStr(d.language)) return false;
  const s = d.source;
  if (
    !isRecord(s) || (s.expectedHash !== undefined && !isStr(s.expectedHash)) ||
    !isCount(s.byteLength) || !isSourceFormat(s.format)
  ) {
    return false;
  }
  const e = d.extraction;
  if (
    !isRecord(e) || !narrowExtractionRecipe(e.recipe) || !isStr(e.recipeHash) ||
    (e.expectedText !== undefined && !isStr(e.expectedText)) ||
    (e.expectedTextLengthUtf16 !== undefined && !isCount(e.expectedTextLengthUtf16))
  ) {
    return false;
  }
  return true;
}

// Wire admission enforces the SAME V1 bounds as the kernel validator
// (TERM_GROUP_LIMITS_V1, one authority) — an empty affix stem or an unbounded
// member list must be refused at the boundary, not discovered in a kernel.
const isBoundedId = (v: unknown): boolean =>
  isStr(v) && v.length >= 1 && v.length <= TERM_GROUP_LIMITS_V1.maxIdUnits;
const isBoundedSurface = (v: unknown): boolean =>
  isStr(v) && v.length >= 1 && v.length <= TERM_GROUP_LIMITS_V1.maxSurfaceUnits;

/** Bounded DENSE-array check. `Array.prototype.every` skips holes, so a
 *  sparse `Array(1)` would narrow and structured-clone its holes into the
 *  kernel as `undefined` (review-A finding) — an indexed loop visits them. */
function denseBoundedArray(v: unknown, min: number, max: number, pred: (e: unknown) => boolean): boolean {
  if (!Array.isArray(v) || v.length < min || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(v, i) || !pred(v[i])) return false;
  }
  return true;
}

/** Dense-only admission where a later authority owns the semantic cap, or
 * where v4 intentionally carried no cap. A separate name prevents passing an
 * array's own length as a misleading no-op “bound.” */
function denseArray(v: unknown, pred: (e: unknown) => boolean): boolean {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(v, i) || !pred(v[i])) return false;
  }
  return true;
}

function narrowMember(m: unknown): boolean {
  if (!isRecord(m) || !isBoundedId(m.id) || !isRecord(m.match)) return false;
  const match = m.match as { case?: unknown; diacritics?: unknown };
  if (!MATCH.has(match.case as string) || !MATCH.has(match.diacritics as string)) return false;
  switch (m.kind) {
    case 'token': return isBoundedSurface(m.surface);
    case 'phrase': return denseBoundedArray(m.surfaces, 1, TERM_GROUP_LIMITS_V1.maxPhraseSurfaces, isBoundedSurface) &&
      typeof m.crossSentence === 'boolean';
    case 'prefix':
    case 'suffix': return isBoundedSurface(m.stem);
    default: return false;
  }
}

function narrowGroup(g: unknown): boolean {
  return isRecord(g) && isBoundedId(g.id) && typeof g.countOverlaps === 'boolean' &&
    denseBoundedArray(g.members, 1, TERM_GROUP_LIMITS_V1.maxMembers, narrowMember);
}

function narrowSelection(s: unknown): boolean {
  if (!isRecord(s) || !denseArray(s.docs, isStr)) return false;
  // Optional ranges must be a well-formed array of {doc, tokens:{start,end}}
  // — an unchecked `ranges: 7` becomes a TypeError deep in the kernel.
  if (s.ranges !== undefined) {
    if (!Array.isArray(s.ranges)) return false;
    for (const r of s.ranges as unknown[]) {
      if (!isRecord(r) || !isStr(r.doc) || !isRecord(r.tokens) || !isCount(r.tokens.start) || !isCount(r.tokens.end)) return false;
    }
  }
  return true;
}

/** 1..MAX_KWIC_TRACKS tracks with unique, nonempty seriesIds and valid groups —
 *  the shared concordance track cap (one authority in core). */
function narrowTracks(tracks: unknown, min: number): boolean {
  if (!Array.isArray(tracks) || tracks.length < min || tracks.length > MAX_KWIC_TRACKS) return false;
  const seen = new Set<string>();
  for (const t of tracks as unknown[]) {
    if (!isRecord(t) || !isStr(t.seriesId) || t.seriesId === '' || !narrowGroup(t.group)) return false;
    if (seen.has(t.seriesId)) return false; // seriesIds must be unique
    seen.add(t.seriesId);
  }
  return true;
}

function narrowKwicRequest(r: unknown): boolean {
  if (!isRecord(r) || !isCount(r.contextTokens) || !isRecord(r.page)) return false;
  // sort.at is a CLOSED key set; dir is exactly 1 or -1.
  if (!denseArray(
    r.sort,
    (x) => isRecord(x) && SORT_KEYS.has(x.at as string) && (x.dir === 1 || x.dir === -1),
  )) return false;
  // Optional axis center — a well-formed {doc, token} or absent.
  if (r.center !== undefined) {
    if (!isRecord(r.center) || !isStr((r.center as Record<string, unknown>).doc) || !isCount((r.center as Record<string, unknown>).token)) return false;
  }
  return isCount(r.page.offset) && isCount(r.page.limit);
}

/** Every required request field is checked before dispatch. */
export function narrowQueryV4(q: unknown): boolean {
  if (!isRecord(q) || !isStr(q.op)) return false;
  switch (q.op) {
    case 'trend':
      return narrowSelection(q.selection) && narrowGroup(q.group) &&
        exactRecord(q.request, ['coordinate', 'bins']) &&
        COORDINATES.has(q.request.coordinate as string) && narrowTrendBins(q.request.bins);
    case 'kwic':
      // kwic/2 is a BREAKING replacement: `group` was removed. Reject a payload
      // that carries the legacy field so a partially-migrated caller cannot hide
      // contradictory semantics under an ignored `group` (ruling §1).
      return q.group === undefined && narrowSelection(q.selection) && narrowTracks(q.tracks, 1) && narrowKwicRequest(q.request);
    case 'dispersion': {
      // dispersion/1 pins its resolution POLICY on the wire: the request must
      // carry exactly the exported core constants — a drifted or bespoke
      // value is a malformed message, not a tunable (slice-2 ruling §1).
      const r = q.request as Record<string, unknown>;
      return narrowSelection(q.selection) && narrowTracks(q.tracks, 1) &&
        isRecord(q.request) && r.method === 'dispersion/1' &&
        r.exactMax === DISPERSION_EXACT_MAX && r.bucketBudget === DISPERSION_BUCKET_BUDGET;
    }
    case 'inventory': {
      const r = q.request as Record<string, unknown>;
      if (
        !exactRecord(q, ['op', 'selection', 'request']) ||
        !narrowSelection(q.selection) ||
        !exactRecord(q.request, [
          'method',
          'rhythmBinsPerDoc',
          'growthPoints',
          'mattrWindow',
        ])
      ) {
        return false;
      }
      if (
        r.method !== 'inventory/1' ||
        !isCount(r.rhythmBinsPerDoc) ||
        !isCount(r.growthPoints) ||
        !isCount(r.mattrWindow)
      ) {
        return false;
      }
      const rhythm = r.rhythmBinsPerDoc as number;
      const growth = r.growthPoints as number;
      const mattrWindow = r.mattrWindow as number;
      return (
        rhythm <= INVENTORY_MAX_RHYTHM_BINS_PER_DOC &&
        (
          growth === 0 ||
          (
            growth >= INVENTORY_MIN_GROWTH_POINTS &&
            growth <= INVENTORY_MAX_GROWTH_POINTS
          )
        ) &&
        mattrWindow >= 1 &&
        mattrWindow <= INVENTORY_MAX_MATTR_WINDOW
      );
    }
    case 'freq-list': {
      const r = q.request as Record<string, unknown>;
      if (
        !exactRecord(q, ['op', 'selection', 'request']) ||
        !narrowSelection(q.selection) ||
        !exactRecord(q.request, ['method', 'filter', 'sort', 'page', 'dispersion'])
      ) {
        return false;
      }
      const filter = r.filter as Record<string, unknown>;
      const sort = r.sort as Record<string, unknown>;
      const page = r.page as Record<string, unknown>;
      const filterKeys = isRecord(r.filter) &&
        Object.prototype.hasOwnProperty.call(r.filter, 'prefixNfc')
        ? ['minCount', 'minDocFreq', 'classes', 'prefixNfc']
        : ['minCount', 'minDocFreq', 'classes'];
      if (
        r.method !== 'freq-list/1' ||
        !exactRecord(r.filter, filterKeys) ||
        !exactRecord(r.sort, ['by', 'dir']) ||
        !exactRecord(r.page, ['offset', 'limit']) ||
        typeof r.dispersion !== 'boolean' ||
        !isCount(filter.minCount) ||
        (filter.minCount as number) < 1 ||
        !isCount(filter.minDocFreq) ||
        (filter.minDocFreq as number) < 1 ||
        !denseBoundedArray(filter.classes, 1, 2, (value) => FREQUENCY_CLASSES.has(value as string)) ||
        new Set(filter.classes as unknown[]).size !== (filter.classes as unknown[]).length ||
        !FREQUENCY_SORT_KEYS.has(sort.by as string) ||
        (sort.dir !== 1 && sort.dir !== -1) ||
        (
          r.dispersion === false &&
          (sort.by === 'dp' || sort.by === 'dpNorm')
        ) ||
        !isCount(page.offset) ||
        !isCount(page.limit)
      ) {
        return false;
      }
      if (filter.prefixNfc !== undefined) {
        if (
          !isStr(filter.prefixNfc) ||
          filter.prefixNfc.length < 1 ||
          filter.prefixNfc.length > FREQUENCY_PREFIX_MAX_UNITS ||
          filter.prefixNfc.normalize('NFC') !== filter.prefixNfc
        ) {
          return false;
        }
      }
      return (
        (page.limit as number) >= 1 &&
        (page.limit as number) <= FREQUENCY_PAGE_MAX &&
        (page.offset as number) + (page.limit as number) <= FREQUENCY_WINDOW_MAX
      );
    }
    case 'keyness': {
      const r = q.request as Record<string, unknown>;
      if (
        !exactRecord(q, ['op', 'request']) ||
        !exactRecord(q.request, [
          'method',
          'effect',
          'a',
          'b',
          'filter',
          'sort',
          'page',
          'side',
        ]) ||
        r.method !== 'keyness-g2-2x2/1' ||
        r.effect !== 'log-ratio-halves/1' ||
        !narrowSelection(r.a) ||
        !narrowSelection(r.b)
      ) {
        return false;
      }
      const filter = r.filter as Record<string, unknown>;
      const sort = r.sort as Record<string, unknown>;
      const page = r.page as Record<string, unknown>;
      if (
        !exactRecord(r.filter, ['minCountTotal', 'minDocFreqTotal', 'classes']) ||
        !exactRecord(r.sort, ['by', 'dir']) ||
        !exactRecord(r.page, ['offset', 'limit']) ||
        !isCount(filter.minCountTotal) ||
        (filter.minCountTotal as number) < 1 ||
        !isCount(filter.minDocFreqTotal) ||
        (filter.minDocFreqTotal as number) < 1 ||
        !denseBoundedArray(filter.classes, 1, 2, (value) =>
          FREQUENCY_CLASSES.has(value as string)) ||
        new Set(filter.classes as unknown[]).size !==
          (filter.classes as unknown[]).length ||
        !KEYNESS_SORT_KEYS.has(sort.by as string) ||
        (sort.dir !== 1 && sort.dir !== -1) ||
        !isCount(page.offset) ||
        !isCount(page.limit) ||
        (page.limit as number) < 1 ||
        (page.limit as number) > FREQUENCY_PAGE_MAX ||
        (page.offset as number) + (page.limit as number) >
          FREQUENCY_WINDOW_MAX ||
        !KEYNESS_SIDES.has(r.side as string)
      ) {
        return false;
      }
      return true;
    }
    case 'reader-page': {
      // reader-page/1: zero tracks is LEGAL (reading never depends on the
      // notebook). Selection is ENGINE-OWNED base corpus state, so reject the
      // legacy round-1 field rather than silently ignore a caller that thinks
      // it narrows marks. Cursor kinds are a closed set; `before` needs token
      // ≥ 1 (before(0) has no page); maxTokens is a positive count — the
      // kernel CLAMPS above READER_MAX_TOKENS and reports cappedBy (documented
      // min() semantics), so no upper bound at the wire.
      const r = q.request as Record<string, unknown>;
      if (q.selection !== undefined || !narrowTracks(q.tracks, 0)) return false;
      if (!isRecord(q.request) || r.method !== 'reader-page/1' || !isStr(r.doc)) return false;
      if (!isCount(r.maxTokens) || r.maxTokens === 0) return false;
      const c = r.cursor as Record<string, unknown>;
      if (!isRecord(r.cursor) || !isCount(c.token)) return false;
      if (c.kind === 'before') return (c.token as number) >= 1;
      return c.kind === 'around' || c.kind === 'from';
    }
    case 'occurrence-step': {
      // Full-corpus selection is ENGINE-owned, and exactly one track is part
      // of the operation identity. The result is one bounded hit, never an
      // occurrence array or a density approximation.
      const r = q.request as Record<string, unknown>;
      return exactRecord(q, ['op', 'track', 'request'])
        && narrowTracks([q.track], 1)
        && exactRecord(q.request, ['method', 'doc', 'token', 'direction'])
        && r.method === 'occurrence-step/1'
        && isStr(r.doc)
        && isCount(r.token)
        && (r.direction === 1 || r.direction === -1);
    }
    default:
      return false;
  }
}

/**
 * Top-level v4 envelope narrowing. Returns the narrowed message or null; the
 * caller distinguishes null (malformed OR unknown tag → PARSE_FAILED) from a
 * version mismatch (checked separately). Every unknown tag maps to null here,
 * so the engine dispatch can never see an unknown message type.
 */
export function parseToWorkerV4(m: unknown): ToWorkerV4 | null {
  if (!isRecord(m) || m.v !== PROTOCOL_VERSION_V4 || !isStr(m.t)) return null;
  switch (m.t) {
    case 'begin-generation':
      return isCount(m.job) && isStr(m.generation) &&
        // The engine owns maxDocsPerProject so overflow retains the precise
        // CAP_EXCEEDED contract rather than becoming generic PARSE_FAILED.
        denseArray(m.docs, narrowDocSpec) &&
        isIndexRecipeProvisional(m.indexRecipe)
        ? (m as unknown as ToWorkerV4) : null;
    case 'ingest':
      return isCount(m.job) && isStr(m.generation) && isStr(m.doc) && m.bytes instanceof ArrayBuffer
        ? (m as unknown as ToWorkerV4) : null;
    case 'query':
      return isCount(m.job) && isStr(m.snapshot) && narrowQueryV4(m.query) ? (m as unknown as ToWorkerV4) : null;
    case 'cancel':
      return isCount(m.job) ? (m as unknown as ToWorkerV4) : null;
    default:
      return null;
  }
}
