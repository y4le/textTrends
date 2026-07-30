/**
 * Runtime validators for protocol v4 (contract §12.8 requires each op's
 * runtime schema complete before the engine implements it). Every validator
 * accepts `unknown` and narrows; malformed containers/scalars are rejected
 * so the engine never sees a shape it cannot trust. Deep numeric-range
 * checks stay in the kernels — these guard container structure, discriminant
 * scalars, and the recipe/override VALUES the worker will recompute hashes
 * from.
 *
 * The engine narrows every inbound envelope with these before dispatch.
 */

import { exactRecord, isIndexRecipeProvisional, isNonNegSafeInt as isCount, isRecord, isSourceFormat, isString as isStr, isStructureOverrideV1, isStructureRecipeProvisional, MAX_KWIC_TRACKS, SOURCE_FORMATS, TERM_GROUP_LIMITS_V1, DISPERSION_BUCKET_BUDGET, DISPERSION_EXACT_MAX } from '@texttrends/core';
import { PROTOCOL_VERSION_V4, type ToWorkerV4 } from './protocol-v4.ts';

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const MATCH = new Set(['sensitive', 'folded']);
const AVAILABILITY = new Set(['bundled', 'persisted', 'external']);
// Closed literal unions the kernels accept — a wire caller must not smuggle
// an unsupported coordinate/sort key through as a "trusted" request.
const COORDINATES = new Set(['document-relative', 'declared-sequence']);
const SORT_KEYS = new Set(['L3', 'L2', 'L1', 'R1', 'R2', 'R3', 'doc', 'pos']);

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
    !isCount(s.byteLength) || !isSourceFormat(s.format) ||
    !AVAILABILITY.has(s.availability as string)
  ) {
    return false;
  }
  const e = d.extraction;
  if (
    !isRecord(e) || !narrowExtractionRecipe(e.recipe) || !isStr(e.recipeHash) ||
    (e.expectedText !== undefined && !isStr(e.expectedText)) ||
    (e.expectedTextLengthUtf16 !== undefined && !isCount(e.expectedTextLengthUtf16)) ||
    (e.expectedCandidates !== undefined && !isStr(e.expectedCandidates))
  ) {
    return false;
  }
  const st = d.structure;
  if (!isRecord(st) || !isStructureRecipeProvisional(st.recipe) || !isStr(st.recipeHash)) return false;
  return narrowOverrideInput(st.override);
}

/** The override may be absent (`none`) — a first cold ingest cannot bind one
 *  — or an `active` user correction whose value passes the DEEP core
 *  validator (closed enums / complete section values); commit 6 recomputes
 *  its hash and verifies base identities before applying. */
function narrowOverrideInput(o: unknown): boolean {
  if (!isRecord(o) || !isStr(o.kind)) return false;
  // exactRecord enforces the plain prototype, exact own-key set, no
  // symbols/accessors/non-enumerables — a wrapper whose `value` is a getter
  // or that inherits a field cannot narrow as a trusted OverrideInputV4.
  if (o.kind === 'none') return exactRecord(o, ['kind']);
  if (o.kind === 'active') return exactRecord(o, ['kind', 'value', 'hash']) && isStructureOverrideV1(o.value) && isStr(o.hash);
  return false;
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
  for (let i = 0; i < v.length; i++) if (!pred(v[i])) return false;
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
 *  the shared concordance/passage track cap (one authority in core). */
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

function narrowPassageRequest(r: unknown): boolean {
  if (!isRecord(r) || !isStr(r.doc) || !isCount(r.centerToken) || !isCount(r.maxTokens)) return false;
  // ONE track authority: same shape/uniqueness/cap as the concordance, with
  // zero tracks allowed (a passage may be fetched with no marks) — and the
  // same NONEMPTY seriesId rule, which the old inline copy had lost.
  return narrowTracks(r.tracks, 0);
}

/** The query op union (§12.8 QueryOpV4) — including the new `structure` op.
 *  Every required request field is checked so commit 6 can trust the result. */
export function narrowQueryV4(q: unknown): boolean {
  if (!isRecord(q) || !isStr(q.op)) return false;
  switch (q.op) {
    case 'trend':
      return narrowSelection(q.selection) && narrowGroup(q.group) && isRecord(q.request) &&
        COORDINATES.has((q.request as Record<string, unknown>).coordinate as string) &&
        isCount((q.request as Record<string, unknown>).binsPerDoc);
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
    case 'passage':
      return narrowPassageRequest(q.request);
    case 'structure':
    case 'structure-edit-context':
      return isRecord(q.request) && isStr((q.request as Record<string, unknown>).doc);
    case 'line-excerpt': {
      const r = q.request as Record<string, unknown>;
      // FINITE numbers only — NaN/±Infinity must never reach the window budget
      // (a NaN budget defeats every stopping comparison and returns an unbounded
      // slice of a pathological line).
      return isRecord(q.request) && isStr(r.doc) && isFiniteNum(r.anchor) && isFiniteNum(r.maxChars);
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
    case 'project-load':
      return isCount(m.job) && isStr(m.project) ? (m as unknown as ToWorkerV4) : null;
    case 'project-save':
      // expectedRevision is a CAS token: a positive safe integer, or 0 (the
      // sole create sentinel) — a fractional/negative/NaN value is
      // REQUEST_INVALID, not a misleading revision conflict.
      return isCount(m.job) && isStr(m.project) &&
        Number.isSafeInteger(m.expectedRevision) && (m.expectedRevision as number) >= 0 && 'manifest' in m
        ? (m as unknown as ToWorkerV4) : null;
    case 'source-persist':
      return isCount(m.job) && isStr(m.sourceHash) && m.bytes instanceof ArrayBuffer
        ? (m as unknown as ToWorkerV4) : null;
    default:
      return null;
  }
}
