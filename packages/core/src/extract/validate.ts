/**
 * Deep artifact admission validators — engine-v4 consult §B. The IDB adapter
 * checks only storage envelopes and key agreement; before the engine trusts
 * an extraction or structure artifact returned as `unknown`, it must verify
 * the artifact's own ABI and identity. These are the authorities.
 *
 * They RECOMPUTE the identity that a caller-supplied hash asserts — a hash is
 * an admission check, never authority. A structurally valid artifact whose
 * identity contradicts an asserted expectation is a MISMATCH (stale manifest /
 * changed source), not corrupt storage, and is reported distinctly by the
 * caller so it is never repaired by deletion or refetched forever.
 */

import { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from '../contract/verified-text.ts';
import { exactArray, exactRecord, isNonNegSafeInt as isSafeNonNeg, isRecord as isRec, isString as isStr } from '../contract/guards.ts';
import { validateSectionTable, type StructureSectionRecordV2 } from '../structure/sections.ts';
import {
  deriveCandidatesFromText,
  hashExtractionRecipe,
  isValidExtractionEvidence,
  isValidSourceDescriptor,
  type ExtractionArtifactV1,
  type ExtractionRecipeProvisional,
} from './extraction.ts';
import { hashStructureCandidates, isValidCandidate, type StructureCandidateV1 } from './candidates.ts';
import type { StructureArtifactV2 } from '../structure/build.ts';

/** The identity a cached extraction artifact is keyed by (matches the engine's
 *  ExtractionCacheKey). Admission requires the artifact to carry EXACTLY it. */
export interface ExtractionKey {
  readonly source: string;
  readonly recipe: string; // ExtractionRecipeHash
}

/** The identity a cached structure artifact is keyed by. */
export interface StructureKey {
  readonly text: string;
  readonly candidates: string;
  readonly recipe: string;
  readonly override: string;
}

export class ArtifactCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactCorruptError';
  }
}


// Candidate ABI is defined ONCE in candidates.ts so cold extraction, the
// transformed builder, and this admission path can never diverge on what a
// valid candidate is (a builder must not mint what admission rejects).
const isCandidate = isValidCandidate;

/**
 * Admit a cached extraction artifact against the recipe that keyed it and,
 * where present, the extracted text. Verifies schema, complete identity,
 * text/length assertions, candidate ranges and ordering, the recomputed
 * candidate hash, and evidence-count well-formedness. Throws
 * ArtifactCorruptError on any ABI violation. When `text` is supplied its hash
 * and length must match the artifact; candidate reconstruction from that text
 * must reproduce the stored candidateHash (catching a tampered candidate set
 * whose ranges still parse).
 */
export async function validateExtractionArtifact(
  value: unknown,
  key: ExtractionKey,
  recipe: ExtractionRecipeProvisional,
  text?: string,
): Promise<ExtractionArtifactV1> {
  // The safe self-verifying entry: hash the supplied text once, then delegate
  // to the verified lane (same checks, capability-borne identity).
  return admitExtractionArtifact(value, key, recipe, text === undefined ? undefined : await verifyText(text));
}

/**
 * The verified lane of `validateExtractionArtifact`: the text identity comes
 * from the capability's proof instead of a re-digest. Every non-hash admission
 * check — length agreement, descriptor/evidence ABI, candidate ranges and
 * order, the recomputed candidate hash, and the fresh-scan comparison for
 * text-reconstructible recipes — is unchanged.
 */
export async function validateExtractionArtifactVerified(
  value: unknown,
  key: ExtractionKey,
  recipe: ExtractionRecipeProvisional,
  verified: VerifiedText,
): Promise<ExtractionArtifactV1> {
  verifiedTextOf(verified); // authenticate at ENTRY — forgeries reject before any admission work
  return admitExtractionArtifact(value, key, recipe, verified);
}

async function admitExtractionArtifact(
  value: unknown,
  key: ExtractionKey,
  recipe: ExtractionRecipeProvisional,
  verified: VerifiedText | undefined,
): Promise<ExtractionArtifactV1> {
  if (!isRec(value) || value.schema !== 'texttrends/extraction/1') {
    throw new ArtifactCorruptError('extraction artifact schema invalid');
  }
  if (!isStr(value.source) || !isStr(value.recipe) || !isStr(value.text) || !isSafeNonNeg(value.textLengthUtf16)) {
    throw new ArtifactCorruptError('extraction artifact identity fields invalid');
  }
  // The artifact must carry EXACTLY the identity it was keyed by, and its
  // recipe hash must be the one the supplied recipe produces (a keyed-identity
  // conflict is corrupt storage, distinct from a manifest text/candidate
  // mismatch).
  if (value.source !== key.source || value.recipe !== key.recipe) {
    throw new ArtifactCorruptError('extraction artifact does not match its cache key');
  }
  if (key.recipe !== (await hashExtractionRecipe(recipe))) {
    throw new ArtifactCorruptError('extraction cache key does not match the supplied recipe');
  }
  const textLength = value.textLengthUtf16 as number;
  // The descriptor and evidence ABIs are the SINGLE authority in extraction.ts,
  // shared with the transformed builder, so a built artifact and an admitted one
  // can never disagree on the shape (Codex review).
  if (!isValidSourceDescriptor(value.descriptor, value.source as string, recipe.format)) {
    throw new ArtifactCorruptError('extraction descriptor invalid');
  }
  if (!Array.isArray(value.candidates) || !value.candidates.every((c) => isCandidate(c, textLength))) {
    throw new ArtifactCorruptError('extraction candidates invalid');
  }
  // Candidates must be in non-decreasing char-start order (text order).
  for (let i = 1; i < value.candidates.length; i++) {
    if ((value.candidates[i] as StructureCandidateV1).chars.start < (value.candidates[i - 1] as StructureCandidateV1).chars.start) {
      throw new ArtifactCorruptError('extraction candidates are not in text order');
    }
  }
  if (!isStr(value.candidateHash) || value.candidateHash !== (await hashStructureCandidates(value.candidates as StructureCandidateV1[]))) {
    throw new ArtifactCorruptError('extraction candidateHash does not match its candidates');
  }
  if (!isValidExtractionEvidence(value.evidence)) {
    throw new ArtifactCorruptError('extraction evidence invalid');
  }
  if (verified !== undefined) {
    const text = verifiedTextOf(verified);
    if (verifiedHashOf(verified) !== value.text || text.length !== textLength) {
      throw new ArtifactCorruptError('extraction artifact does not describe the supplied text');
    }
    // Only a TEXT-reconstructible recipe may be re-scanned from the text. A
    // source-dependent recipe's candidates are not a function of the text (an
    // EPUB spine), so its identity was already admitted by the candidateHash
    // check above (planner ruling §1) — a text rescan would falsely reject it.
    if (recipe.candidateReconstruction === 'text') {
      const reconstructed = await deriveCandidatesFromText(text, recipe);
      if (reconstructed.candidateHash !== value.candidateHash) {
        throw new ArtifactCorruptError('stored candidates do not match a fresh scan of the text');
      }
    }
  }
  return value as unknown as ExtractionArtifactV1;
}

/**
 * Admit a cached structure artifact against the text it describes. Verifies
 * schema, complete identity tuple, and the full section-table invariants
 * (root/parent/level/range) via validateSectionTable against the verified
 * text length. Throws ArtifactCorruptError on any violation.
 */
export async function validateStructureArtifactV2(
  value: unknown,
  key: StructureKey,
  textLength: number,
): Promise<StructureArtifactV2> {
  // The shared plain-record boundary (Object/null prototype, exact own keys,
  // enumerable data descriptors, no symbols) — a custom-prototype/accessor
  // wrapper must not pass admission and then fail canonical hashing.
  if (!exactRecord(value, ['schema', 'text', 'candidates', 'recipe', 'override', 'sections'])) {
    throw new ArtifactCorruptError('structure artifact has an unexpected shape');
  }
  if (value.schema !== 'texttrends/structure/2') {
    throw new ArtifactCorruptError('structure artifact schema invalid');
  }
  if (!isStr(value.text) || !isStr(value.candidates) || !isStr(value.recipe) || !isStr(value.override)) {
    throw new ArtifactCorruptError('structure artifact identity fields invalid');
  }
  // EXACT keyed identity — the artifact must be the one requested.
  if (value.text !== key.text || value.candidates !== key.candidates || value.recipe !== key.recipe || value.override !== key.override) {
    throw new ArtifactCorruptError('structure artifact does not match its cache key');
  }
  if (!exactArray(value.sections, (value.sections as unknown[])?.length ?? -1)) {
    throw new ArtifactCorruptError('structure sections is not a dense array');
  }
  // Each section record and its chars must be EXACT — validateSectionTable
  // validates known fields deeply but tolerates extras/prototypes/accessors,
  // and structureHashOf hashes the stored object, so an extra field would
  // acquire a StructureHash the builder never produces.
  for (const s of value.sections as unknown[]) {
    if (!isExactSectionRecord(s)) throw new ArtifactCorruptError('structure section record has an unexpected shape');
  }
  let canonical: readonly StructureSectionRecordV2[];
  try {
    // validateSectionTable enforces every §12.2 invariant AND returns the
    // canonical order.
    canonical = validateSectionTable(value.sections as StructureSectionRecordV2[], textLength);
  } catch (e) {
    throw new ArtifactCorruptError(`structure section table invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The stored order must ALREADY be canonical — a reversed-but-valid table
  // would otherwise acquire a StructureHash the canonical builder never
  // produces (structureHashOf hashes the stored order).
  const stored = value.sections as StructureSectionRecordV2[];
  if (stored.length !== canonical.length || stored.some((s, i) => s.key !== canonical[i]!.key)) {
    throw new ArtifactCorruptError('structure sections are not in canonical order');
  }
  return value as unknown as StructureArtifactV2;
}

/** A section record held to exact/plain discipline — required key + present
 *  optional keys only, exact chars sub-record. Deep VALUE validation (ranges,
 *  parents, invariants) is validateSectionTable's job. */
function isExactSectionRecord(s: unknown): boolean {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return false;
  const keys = ['key', 'origin', 'level', 'chars'];
  if (Object.prototype.hasOwnProperty.call(s, 'parent')) keys.push('parent');
  if (Object.prototype.hasOwnProperty.call(s, 'title')) keys.push('title');
  if (!exactRecord(s, keys)) return false;
  return exactRecord((s as Record<string, unknown>).chars, ['start', 'end']);
}
