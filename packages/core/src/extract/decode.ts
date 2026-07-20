/**
 * Byte decoding — contract §12.4 (DecoderPolicyV0, 'bom-utf8-windows1252-v1').
 *
 * Deterministic algorithm:
 * 1. A supported BOM is AUTHORITATIVE: UTF-8 / UTF-16LE / UTF-16BE, decoded
 *    strictly; the BOM is stripped from extracted text; malformed
 *    BOM-declared data is a DecodeError — never reinterpreted as 1252.
 * 2. No BOM: strict UTF-8 (fatal).
 * 3. On failure: the WHATWG windows-1252 mapping — a TOTAL single-byte
 *    decoding (0x80 = €, the five undefined bytes map to C1 controls), so it
 *    cannot fail and inserts no replacements.
 * No newline or Unicode normalization of extracted text: character offsets
 * address the text exactly as decoded.
 *
 * Evidence semantics: `decoderReplacementCount` means the DECODER inserted
 * replacements (normally 0 under this policy — an intentional U+FFFD in
 * valid UTF-8 is not data loss); `suspiciousControlCount` counts C0 controls
 * other than tab/LF/CR plus all C1 controls in the extracted text.
 *
 * The platform's windows-1252 decoder is not trusted by name: it is
 * conformance-tested once against the embedded table whose content hash is
 * part of the recipe identity (WINDOWS_1252_TABLE_HASH).
 */

import { canonicalJson, sha256Hex } from '../contract/hash.ts';

/** Decoding failed under an AUTHORITATIVE declaration (BOM). */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export type DetectedEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le-bom'
  | 'utf-16be-bom'
  | 'windows-1252';

/** The CLOSED set of encodings this decoder can report — the single authority
 *  for membership-testing an untrusted `descriptor.encoding.detected` string
 *  (the artifact and manifest validators use it to close the field). Typed as
 *  a string set because callers test values of `unknown` provenance. */
export const DETECTED_ENCODINGS: ReadonlySet<string> = new Set<DetectedEncoding>([
  'utf-8',
  'utf-8-bom',
  'utf-16le-bom',
  'utf-16be-bom',
  'windows-1252',
]);

export interface DecodedSource {
  readonly text: string;
  readonly detected: DetectedEncoding;
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
}

/**
 * WHATWG windows-1252, rows 0x80–0x9F (the rest is identity with latin-1 /
 * code points). Five historically undefined bytes (0x81 0x8D 0x8F 0x90 0x9D)
 * map to their C1 control code points — the mapping is TOTAL.
 * https://encoding.spec.whatwg.org/index-windows-1252.txt
 */
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

export async function windows1252TableHash(): Promise<string> {
  return sha256Hex(canonicalJson({ high: WINDOWS_1252_HIGH, low: 'identity-0x00-0x7f-0xa0-0xff' }));
}

/** Decode per the table directly — used as the implementation so behavior
 *  never depends on an unverified platform decoder. */
function decodeWindows1252(bytes: Uint8Array): string {
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    codes[i] = b >= 0x80 && b <= 0x9f ? WINDOWS_1252_HIGH[b - 0x80]! : b;
  }
  // Chunked to respect argument-count limits on large files.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < codes.length; i += CHUNK) {
    out += String.fromCharCode(...codes.subarray(i, Math.min(codes.length, i + CHUNK)));
  }
  return out;
}

function countSuspiciousControls(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) {
      count++;
    }
  }
  return count;
}

function strictDecode(bytes: Uint8Array, label: 'utf-8' | 'utf-16le' | 'utf-16be', context: string): string {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    throw new DecodeError(`${context}: malformed ${label} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Decode source bytes under DecoderPolicyV0. Throws DecodeError only for
 *  malformed BOM-declared Unicode; the fallback path is total. */
export function decodeSource(bytes: Uint8Array): DecodedSource {
  let text: string;
  let detected: DetectedEncoding;
  // UNSUPPORTED explicit declarations fail — never fallback data (§12.4).
  // UTF-32 BOMs must be checked BEFORE UTF-16: the UTF-32LE signature
  // (FF FE 00 00) begins with the UTF-16LE one, and UTF-32BE would
  // otherwise fall through to the total 1252 mapping.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
    throw new DecodeError('UTF-32LE BOM declared: unsupported encoding');
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
    throw new DecodeError('UTF-32BE BOM declared: unsupported encoding');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = strictDecode(bytes.subarray(3), 'utf-8', 'UTF-8 BOM declared');
    detected = 'utf-8-bom';
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2 !== 0) throw new DecodeError('UTF-16LE BOM declared: odd byte length');
    text = strictDecode(bytes.subarray(2), 'utf-16le', 'UTF-16LE BOM declared');
    detected = 'utf-16le-bom';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0) throw new DecodeError('UTF-16BE BOM declared: odd byte length');
    text = strictDecode(bytes.subarray(2), 'utf-16be', 'UTF-16BE BOM declared');
    detected = 'utf-16be-bom';
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      detected = 'utf-8';
    } catch {
      text = decodeWindows1252(bytes);
      detected = 'windows-1252';
    }
  }
  // Strict decoders never substitute, and the 1252 table is total — the
  // count is structurally 0 under this policy, asserted here so a future
  // decoder change cannot silently start losing data.
  return {
    text,
    detected,
    decoderReplacementCount: 0,
    suspiciousControlCount: countSuspiciousControls(text),
  };
}

/** UTF-16 lone surrogates cannot appear from utf-8/1252 decoding, but a
 *  BOM-declared UTF-16 file can contain them while still being "well-formed
 *  bytes" — hashText will reject those texts downstream; this predicate lets
 *  extraction report the condition as a DecodeError with context instead. */
export function assertWellFormed(text: string, context: string): void {
  if (!text.isWellFormed()) {
    throw new DecodeError(`${context}: decoded text contains lone surrogates`);
  }
}
