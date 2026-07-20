/**
 * Runtime validators for protocol v4 (contract §12.8 requires each op's
 * runtime schema complete before the engine implements it). Every validator
 * accepts `unknown` and narrows; malformed containers/scalars are rejected
 * so the engine never sees a shape it cannot trust. Deep numeric-range
 * checks stay in the kernels — these guard container structure, discriminant
 * scalars, and the recipe/override VALUES the worker will recompute hashes
 * from.
 *
 * These mirror the v3 engine's narrowing discipline; commit 6 wires them
 * into the worker in place of the inline v3 narrowers.
 */

import { isIndexRecipeProvisional, isStructureOverrideV1, isStructureRecipeProvisional } from '@texttrends/core';
import { PROTOCOL_VERSION_V4, type ToWorkerV4 } from './protocol-v4.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number';

const MATCH = new Set(['sensitive', 'folded']);
const FORMATS = new Set(['txt', 'md']);
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
  return (
    isRecord(r) && r.schema === 'texttrends/extraction-recipe/0-provisional' &&
    (r.format === 'txt' || r.format === 'md') && isRecord(r.decoder) && isRecord(r.parser)
  );
}

function narrowDocSpec(d: unknown): boolean {
  if (!isRecord(d) || !isStr(d.doc) || !isStr(d.language)) return false;
  const s = d.source;
  if (
    !isRecord(s) || (s.expectedHash !== undefined && !isStr(s.expectedHash)) ||
    !isNum(s.byteLength) || !FORMATS.has(s.format as string) ||
    (s.declaredEncoding !== undefined && !isStr(s.declaredEncoding)) ||
    !AVAILABILITY.has(s.availability as string)
  ) {
    return false;
  }
  const e = d.extraction;
  if (
    !isRecord(e) || !narrowExtractionRecipe(e.recipe) || !isStr(e.recipeHash) ||
    (e.expectedText !== undefined && !isStr(e.expectedText)) ||
    (e.expectedTextLengthUtf16 !== undefined && !isNum(e.expectedTextLengthUtf16)) ||
    (e.expectedCandidates !== undefined && !isStr(e.expectedCandidates))
  ) {
    return false;
  }
  const st = d.structure;
  // DEEP core validators (closed enums / complete override values) — a wire
  // caller must not slip an unsupported recipe or an incomplete override
  // value through (commit 6 recomputes hashes from and applies these).
  return isRecord(st) && isStructureRecipeProvisional(st.recipe) && isStr(st.recipeHash) &&
    isStructureOverrideV1(st.override) && isStr(st.overrideHash);
}

function narrowMember(m: unknown): boolean {
  if (!isRecord(m) || !isStr(m.id) || !isRecord(m.match)) return false;
  const match = m.match as { case?: unknown; diacritics?: unknown };
  if (!MATCH.has(match.case as string) || !MATCH.has(match.diacritics as string)) return false;
  switch (m.kind) {
    case 'token': return isStr(m.surface);
    case 'phrase': return Array.isArray(m.surfaces) && (m.surfaces as unknown[]).every(isStr) && typeof m.crossSentence === 'boolean';
    case 'prefix':
    case 'suffix': return isStr(m.stem);
    default: return false;
  }
}

function narrowGroup(g: unknown): boolean {
  return isRecord(g) && isStr(g.id) && typeof g.countOverlaps === 'boolean' &&
    Array.isArray(g.members) && (g.members as unknown[]).every(narrowMember);
}

function narrowSelection(s: unknown): boolean {
  if (!isRecord(s) || !Array.isArray(s.docs) || !(s.docs as unknown[]).every(isStr)) return false;
  // Optional ranges must be a well-formed array of {doc, tokens:{start,end}}
  // — an unchecked `ranges: 7` becomes a TypeError deep in the kernel.
  if (s.ranges !== undefined) {
    if (!Array.isArray(s.ranges)) return false;
    for (const r of s.ranges as unknown[]) {
      if (!isRecord(r) || !isStr(r.doc) || !isRecord(r.tokens) || !isNum(r.tokens.start) || !isNum(r.tokens.end)) return false;
    }
  }
  return true;
}

function narrowKwicRequest(r: unknown): boolean {
  if (!isRecord(r) || !isNum(r.contextTokens) || !Array.isArray(r.sort) || !isRecord(r.page)) return false;
  // sort.at is a CLOSED key set; dir is exactly 1 or -1.
  if (!(r.sort as unknown[]).every((x) => isRecord(x) && SORT_KEYS.has(x.at as string) && (x.dir === 1 || x.dir === -1))) return false;
  return isNum(r.page.offset) && isNum(r.page.limit);
}

function narrowPassageRequest(r: unknown): boolean {
  if (!isRecord(r) || !isStr(r.doc) || !isNum(r.centerToken) || !isNum(r.maxTokens) || !Array.isArray(r.tracks)) return false;
  if ((r.tracks as unknown[]).length > 5) return false; // the passage track cap
  const seen = new Set<string>();
  for (const t of r.tracks as unknown[]) {
    if (!isRecord(t) || !isStr(t.seriesId) || !narrowGroup(t.group)) return false;
    if (seen.has(t.seriesId)) return false; // seriesIds must be unique
    seen.add(t.seriesId);
  }
  return true;
}

/** The query op union (§12.8 QueryOpV4) — including the new `structure` op.
 *  Every required request field is checked so commit 6 can trust the result. */
export function narrowQueryV4(q: unknown): boolean {
  if (!isRecord(q) || !isStr(q.op)) return false;
  switch (q.op) {
    case 'trend':
      return narrowSelection(q.selection) && narrowGroup(q.group) && isRecord(q.request) &&
        COORDINATES.has((q.request as Record<string, unknown>).coordinate as string) &&
        isNum((q.request as Record<string, unknown>).binsPerDoc);
    case 'kwic':
      return narrowSelection(q.selection) && narrowGroup(q.group) && narrowKwicRequest(q.request);
    case 'passage':
      return narrowPassageRequest(q.request);
    case 'structure':
      return isRecord(q.request) && isStr((q.request as Record<string, unknown>).doc);
    default:
      return false;
  }
}

/**
 * Top-level v4 envelope narrowing. Returns the narrowed message or null; the
 * caller distinguishes null (malformed → PARSE_FAILED) from a version
 * mismatch (checked separately) and unknown ops (dispatch → UNKNOWN_OP).
 */
export function parseToWorkerV4(m: unknown): ToWorkerV4 | null {
  if (!isRecord(m) || m.v !== PROTOCOL_VERSION_V4 || !isStr(m.t)) return null;
  switch (m.t) {
    case 'begin-generation':
      return isNum(m.job) && isStr(m.generation) && Array.isArray(m.docs) &&
        (m.docs as unknown[]).every(narrowDocSpec) && isIndexRecipeProvisional(m.indexRecipe)
        ? (m as unknown as ToWorkerV4) : null;
    case 'ingest':
      return isNum(m.job) && isStr(m.generation) && isStr(m.doc) && m.bytes instanceof ArrayBuffer
        ? (m as unknown as ToWorkerV4) : null;
    case 'query':
      return isNum(m.job) && isStr(m.snapshot) && narrowQueryV4(m.query) ? (m as unknown as ToWorkerV4) : null;
    case 'excerpt':
      return isNum(m.job) && isStr(m.snapshot) && isStr(m.doc) && isNum(m.charStart) && isNum(m.charEnd)
        ? (m as unknown as ToWorkerV4) : null;
    case 'cancel':
      return isNum(m.job) ? (m as unknown as ToWorkerV4) : null;
    case 'project-load':
      return isNum(m.job) && isStr(m.project) ? (m as unknown as ToWorkerV4) : null;
    case 'project-save':
      // expectedRevision is a CAS token: a positive safe integer, or 0 (the
      // sole create sentinel) — a fractional/negative/NaN value is
      // REQUEST_INVALID, not a misleading revision conflict.
      return isNum(m.job) && isStr(m.project) &&
        Number.isSafeInteger(m.expectedRevision) && (m.expectedRevision as number) >= 0 && 'manifest' in m
        ? (m as unknown as ToWorkerV4) : null;
    case 'source-persist':
      return isNum(m.job) && isStr(m.sourceHash) && m.bytes instanceof ArrayBuffer
        ? (m as unknown as ToWorkerV4) : null;
    default:
      return null;
  }
}
