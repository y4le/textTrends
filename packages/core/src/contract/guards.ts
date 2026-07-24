/**
 * Shared primitive guards — the ONE definition of the repo's most-repeated
 * validation twins. Two strictness tiers exist ON PURPOSE:
 *
 * - `isRecord` / `isString` / `isNonNegSafeInt`: the plain-shape tier every
 *   wire/storage boundary narrows with. A quantity guard must reject
 *   NaN/±Infinity/negative/fractional/unsafe values — `typeof number` alone
 *   lets them through, where they poison cap-preflight totals and defeat
 *   kernel stopping comparisons (Codex architecture review §7).
 * - `exactRecord` / `exactArray`: the identity-domain tier (recipes and every
 *   hashed value): plain prototype, no symbols, no accessors, exact key sets —
 *   an extra or exotic property would hash into a SECOND identity for the same
 *   behavior. Do not "simplify" one tier into the other.
 */

/** A plain data record: a non-null object that is not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** A non-negative safe integer — every count/position/length/revision. */
export function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** A record with EXACTLY the given own property names, a plain prototype, no
 *  symbols, and only enumerable data descriptors. Own PROPERTY NAMES are
 *  compared (catching non-enumerable extras) — an extra field would be HASHED
 *  into an identity while changing no behavior. */
export function exactRecord(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(v).length !== 0) return false;
  const names = Object.getOwnPropertyNames(v);
  if (names.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return false;
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(v, name)!;
    if (!d.enumerable || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}

/** A DENSE Array of exactly `length` elements carrying no extra own
 *  properties (named or symbol), no holes, and plain enumerable data
 *  descriptors — an identity-bearing tuple whose canonical JSON must not
 *  smuggle a named array property (which structuredClone preserves and the
 *  canonical hasher rejects). */
export function exactArray(v: unknown, length: number): v is readonly unknown[] {
  if (!Array.isArray(v) || v.length !== length) return false;
  if (Object.getOwnPropertySymbols(v).length !== 0) return false;
  const names = Object.getOwnPropertyNames(v);
  // Own names must be exactly the numeric indices [0..length) plus 'length'.
  if (names.length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (!d || !d.enumerable || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}
