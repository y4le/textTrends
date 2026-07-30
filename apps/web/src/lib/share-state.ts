import {
  canonicalJson,
  parseShareLink,
  type CharAnchorV1,
  type ShareLinkV1,
} from '@texttrends/core';
import { deflateSync, Inflate } from 'fflate';

export const SHARE_FRAGMENT_PREFIX = '#s=';
export const SHARE_MAX_URL_UNITS = 8_192;
export const SHARE_MAX_INFLATED_BYTES = 256 * 1024;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RangeError('share payload is not unpadded base64url');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeShareFragment(value: ShareLinkV1): string {
  const admitted = parseShareLink(value);
  const json = canonicalJson(admitted);
  const compressed = deflateSync(new TextEncoder().encode(json), { level: 9 });
  return `${SHARE_FRAGMENT_PREFIX}${base64Url(compressed)}`;
}

export function shareUrlFor(
  value: ShareLinkV1,
  baseUrl: string,
): string {
  const url = new URL(baseUrl);
  url.hash = encodeShareFragment(value).slice(1);
  const output = url.toString();
  if (output.length > SHARE_MAX_URL_UNITS) {
    throw new RangeError(
      `share link exceeds ${SHARE_MAX_URL_UNITS.toLocaleString()} characters; remove terms or saved selections`,
    );
  }
  return output;
}

function payloadFrom(value: string): string {
  const hash = value.startsWith('#')
    ? value
    : new URL(value, 'https://texttrends.invalid/').hash;
  if (!hash.startsWith(SHARE_FRAGMENT_PREFIX)) {
    throw new RangeError('no textTrends share payload was found');
  }
  if (hash.length > SHARE_MAX_URL_UNITS) {
    throw new RangeError('share fragment exceeds its URL cap');
  }
  return hash.slice(SHARE_FRAGMENT_PREFIX.length);
}

export function decodeShareLink(value: string): ShareLinkV1 {
  const compressed = fromBase64Url(payloadFrom(value));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > SHARE_MAX_INFLATED_BYTES) {
      throw new RangeError(
        `share payload exceeds ${SHARE_MAX_INFLATED_BYTES.toLocaleString()} inflated bytes`,
      );
    }
    chunks.push(chunk);
  });
  inflater.push(compressed, true);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RangeError(
      `share payload is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseShareLink(raw);
}

export interface ShareMatch {
  readonly anchors: readonly CharAnchorV1[];
  readonly matchedDocuments: number;
  readonly unmatchedDocuments: readonly string[];
}

export function matchShareDocuments(
  share: ShareLinkV1,
  local: readonly {
    readonly doc: string;
    readonly text: string;
  }[],
): ShareMatch {
  const localByHash = new Map(local.map((entry) => [entry.text, entry.doc]));
  const senderToLocal = new Map<string, string>();
  const unmatched: string[] = [];
  for (const entry of share.x) {
    const doc = localByHash.get(entry.h);
    if (doc === undefined) unmatched.push(entry.t ?? entry.d);
    else senderToLocal.set(entry.d, doc);
  }
  const anchors = (share.r ?? []).flatMap((anchor) => {
    const doc = senderToLocal.get(anchor.doc);
    return doc === undefined ? [] : [{ ...anchor, doc }];
  });
  return {
    anchors,
    matchedDocuments: senderToLocal.size,
    unmatchedDocuments: unmatched,
  };
}
