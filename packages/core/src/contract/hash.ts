/**
 * Canonical hashing — SHA-256 via Web Crypto (browser + Node), the project's
 * collision-resistant scheme for artifact and recipe identities.
 */

/** The canonical-JSON input domain. Anything outside it is rejected, not coerced. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash a text for identity purposes. Rejects ill-formed UTF-16 (lone
 * surrogates): TextEncoder would silently map distinct ill-formed inputs to
 * the same U+FFFD bytes, colliding their identities.
 */
export async function hashText(text: string): Promise<string> {
  if (!text.isWellFormed()) {
    throw new RangeError('cannot hash ill-formed UTF-16 text (lone surrogates)');
  }
  return sha256Hex(text);
}

/**
 * Canonical JSON: recursively key-sorted, no whitespace — the hash input form.
 *
 * Domain rules (deterministic, collision-averse):
 * - object properties whose value is `undefined` are omitted (documented rule);
 * - `undefined` anywhere else (top level, array elements, holes) is rejected —
 *   `[undefined]` must not collide with `[]` or `[null]`;
 * - non-finite numbers are rejected (JSON.stringify would coerce to null);
 * - functions, symbols, bigints are rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet());
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) throw new RangeError('undefined is outside the canonical JSON domain');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('non-finite number in canonical JSON');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new RangeError(`unsupported canonical JSON value of type ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new RangeError('cyclic value in canonical JSON');
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new RangeError('symbol-keyed properties are outside the canonical JSON domain');
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Own-key discipline: nothing but index slots and 'length' — a named
      // property or an inherited/prototype-filled hole must not silently
      // vanish into (or leak into) the serialization (review finding).
      for (const k of Object.getOwnPropertyNames(obj)) {
        if (k === 'length') continue;
        const idx = Number(k);
        // Canonical index SPELLING required: '01', '1e0', '-0', ' 1' all coerce
        // to in-range integers but are named properties the index loop would
        // silently drop (review finding).
        if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length || String(idx) !== k) {
          throw new RangeError(`non-index array property '${k}' in canonical JSON`);
        }
      }
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        // Read through the descriptor: a getter at a canonical index must be
        // rejected, never EXECUTED during identity computation (review finding
        // — a counting getter made consecutive hashes differ).
        const d = Object.getOwnPropertyDescriptor(obj, i);
        if (d === undefined) {
          throw new RangeError('array holes/undefined are outside the canonical JSON domain');
        }
        if (d.get !== undefined || d.set !== undefined) {
          throw new RangeError(`accessor element at index ${i} in canonical JSON`);
        }
        if (d.value === undefined) {
          throw new RangeError('array holes/undefined are outside the canonical JSON domain');
        }
        parts.push(serialize(d.value, seen));
      }
      return `[${parts.join(',')}]`;
    }
    // Only plain records — Date, Map, Set, boxed primitives, class instances
    // would all silently serialize as "{}" and collide (review finding).
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new RangeError('only plain objects are canonical JSON records');
    }
    const entries: Array<[string, unknown]> = [];
    for (const k of Object.getOwnPropertyNames(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (d === undefined) continue;
      if (d.get !== undefined || d.set !== undefined) {
        throw new RangeError(`accessor property '${k}' in canonical JSON`);
      }
      if (!d.enumerable) {
        throw new RangeError(`non-enumerable property '${k}' in canonical JSON`);
      }
      if (d.value !== undefined) entries.push([k, d.value]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen)}`).join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
