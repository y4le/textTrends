import { describe, expect, it } from 'vitest';
import { canonicalJson, hashText, sha256Hex } from '../src/contract/hash.ts';

describe('sha256Hex', () => {
  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('hashText', () => {
  it('rejects lone surrogates instead of colliding them at U+FFFD', async () => {
    const loneHigh = 'a' + String.fromCharCode(0xd800) + 'b';
    const loneLow = 'a' + String.fromCharCode(0xdc00) + 'b';
    await expect(hashText(loneHigh)).rejects.toThrow(/ill-formed/);
    await expect(hashText(loneLow)).rejects.toThrow(/ill-formed/);
    await expect(hashText('a😀b')).resolves.toMatch(/^[0-9a-f]{64}$/); // well-formed pair ok
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('is stable across key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('rejects undefined at top level and inside arrays (no [] collision)', () => {
    expect(() => canonicalJson(undefined)).toThrow(RangeError);
    expect(() => canonicalJson([undefined])).toThrow(RangeError);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([, 1])).toThrow(RangeError);
    expect(canonicalJson([null])).toBe('[null]');
    expect(canonicalJson([])).toBe('[]');
  });

  it('rejects non-finite numbers and non-JSON types', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(RangeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => canonicalJson(10n as unknown)).toThrow(RangeError);
    expect(() => canonicalJson(Symbol('x') as unknown)).toThrow(RangeError);
    expect(() => canonicalJson((() => 1) as unknown)).toThrow(RangeError);
  });

  it('rejects non-plain objects that would collide as "{}"', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(RangeError);
    expect(() => canonicalJson(new Map([['x', 1]]))).toThrow(RangeError);
    expect(() => canonicalJson(new Set([1]))).toThrow(RangeError);
    expect(() => canonicalJson(Object(42))).toThrow(RangeError);
    expect(() => canonicalJson({ [Symbol('k')]: 1 })).toThrow(RangeError);
    expect(canonicalJson(Object.create(null))).toBe('{}'); // null-proto record is fine
  });

  it('rejects arrays with symbol keys, named properties, or inherited holes', () => {
    const symArr: unknown[] = [];
    (symArr as unknown as Record<symbol, number>)[Symbol('k')] = 1;
    expect(() => canonicalJson(symArr)).toThrow(/symbol/);

    const namedArr: unknown[] = [1];
    (namedArr as unknown as Record<string, number>)['extra'] = 2;
    expect(() => canonicalJson(namedArr)).toThrow(/non-index/);

    // Numeric-LOOKING names that coerce in-range must also be rejected:
    for (const name of ['01', '1e0', '-0', ' 1', '1.0']) {
      const arr: unknown[] = [0, 1];
      (arr as unknown as Record<string, number>)[name] = 9;
      expect(() => canonicalJson(arr), name).toThrow(/non-index/);
    }

    // A prototype-filled hole must stay a hole (Object.hasOwn, not `in`).
    const proto = Array.prototype as unknown as Record<number, number>;
    proto[0] = 7;
    try {
      expect(() => canonicalJson(new Array(1))).toThrow(/holes/);
    } finally {
      delete proto[0];
    }
  });

  it('rejects accessor array elements without ever executing them', () => {
    let calls = 0;
    const arr: unknown[] = [0];
    Object.defineProperty(arr, 0, { get: () => { calls++; return 1; }, enumerable: true, configurable: true });
    expect(() => canonicalJson(arr)).toThrow(/accessor element/);
    expect(calls).toBe(0);
  });

  it('rejects records with accessor or non-enumerable properties', () => {
    const withGetter = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true });
    expect(() => canonicalJson(withGetter)).toThrow(/accessor/);
    const hidden = Object.defineProperty({}, 'x', { value: 1, enumerable: false });
    expect(() => canonicalJson(hidden)).toThrow(/non-enumerable/);
  });

  it('rejects cyclic values instead of overflowing', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalJson(a)).toThrow(/cyclic/);
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}'); // DAG ok
  });

  it('serializes unicode strings via JSON.stringify escaping rules', () => {
    expect(canonicalJson({ s: 'café\n😀' })).toBe('{"s":"café\\n😀"}');
  });
});
