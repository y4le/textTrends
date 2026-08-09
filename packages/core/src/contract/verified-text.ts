/**
 * VerifiedText — the text-identity capability (Phase D workstream D2).
 *
 * The same document text used to be SHA-256'd once per pipeline stage
 * (extraction, segmentation, index build, binding — ~48 ms each at the 32M-char
 * cap). This module lets the digest happen ONCE: a boundary that authenticates
 * a text mints a `VerifiedText`, and the verified fast lanes
 * (`segmentVerified`, `createDocumentIndexVerified`, and `bindTextsVerified`)
 * consume the capability's hash instead
 * of re-deriving it.
 *
 * AUTHENTICATION MECHANISM: the module-private WeakMap below — NOT a
 * TypeScript brand. The public object is frozen, empty, and nominally typed,
 * but types are erased at runtime; only membership in the WeakMap proves the
 * pair (text, hash) was computed by `verifyText`. A structurally identical
 * imposter (plain object, cast, spread copy, structuredClone of an authentic
 * capability) is rejected by the accessors, never consulted. The wrapper
 * carries NO public data fields at all — consumers read it exclusively through
 * `verifiedTextOf` / `verifiedHashOf`.
 *
 * MINTING DISCIPLINE: `verifyText` is the ONE sanctioned factory. It hashes
 * the text itself (rejecting ill-formed UTF-16 exactly as `hashText` does) and
 * optionally proves the result against an expected identity. There is
 * deliberately NO exported "trust this (text, hash) pair" constructor — a
 * capability can never carry a hash that was not computed over its text.
 *
 * REALM-LOCAL: the capability authenticates only within this JS realm. It must
 * never be structured-cloned or postMessage'd — a clone loses its WeakMap
 * membership and is an unauthenticated forgery on arrival. A receiving
 * boundary re-mints by hashing (`verifyText(text, expectedHash)`).
 */

import type { TextHash } from './brands.ts';
import { hashText } from './hash.ts';

declare const verifiedText: unique symbol;
/** Opaque, nominally-typed handle. Carries no runtime data — the WeakMap does. */
export interface VerifiedText {
  readonly [verifiedText]: 'VerifiedText';
}

/** Module-private authentication store — membership IS the proof. */
const VERIFIED = new WeakMap<object, { readonly text: string; readonly hash: TextHash }>();

/**
 * The ONE sanctioned factory: checks well-formed UTF-16 and computes SHA-256
 * (both via `hashText` — same check, same RangeError as the plain paths), then
 * proves the digest against `expected` when supplied. Rejects on mismatch.
 */
export async function verifyText(text: string, expected?: TextHash): Promise<VerifiedText> {
  const hash = (await hashText(text)) as TextHash; // rejects ill-formed UTF-16
  if (expected !== undefined && hash !== expected) {
    throw new RangeError(
      `text hashed to ${hash.slice(0, 16)}… but the caller expected ${String(expected).slice(0, 16)}…`,
    );
  }
  const capability = Object.freeze({}) as object as VerifiedText;
  VERIFIED.set(capability, { text, hash });
  return capability;
}

/** The authenticated text. Throws on any object `verifyText` did not mint. */
export function verifiedTextOf(v: VerifiedText): string {
  const entry = VERIFIED.get(v);
  if (entry === undefined) throw new RangeError('unauthenticated VerifiedText capability');
  return entry.text;
}

/** The authenticated text identity. Throws on any object `verifyText` did not mint. */
export function verifiedHashOf(v: VerifiedText): TextHash {
  const entry = VERIFIED.get(v);
  if (entry === undefined) throw new RangeError('unauthenticated VerifiedText capability');
  return entry.hash;
}
