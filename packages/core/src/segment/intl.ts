/**
 * Intl.Segmenter adapter — the injected segmentation boundary (contract §3).
 *
 * Contract obligations honored here:
 * - Segmentation runs over the UNCHANGED extracted UTF-16 text; spans address it.
 * - Output is batched typed arrays (SegmentationBatch) INCLUDING the versioned
 *   token-class array — classification is adapter behavior, part of the
 *   fingerprint, never re-derived downstream.
 * - Behavior identity is a fingerprint whose probe hash covers packed starts,
 *   ends, classes, and sentence bounds (terminal included), hashed with the
 *   project's canonical SHA-256 scheme, under the RESOLVED locale.
 */

import type { TextHash } from '../contract/brands.ts';
import { hashText, sha256Hex } from '../contract/hash.ts';
import { TOKEN_CLASS } from '../contract/recipes.ts';

export interface SegmenterFingerprint {
  readonly adapter: string;
  readonly adapterVersion: string;
  /** Effective locale from Intl.Segmenter.resolvedOptions(), not caller spelling. */
  readonly locale: string;
  readonly wordPolicy: 'intl-word-v1';
  readonly sentencePolicy: 'intl-sentence-v1';
  readonly classifierVersion: 'numeral-re-v1';
  readonly probeHash: string;
}

export interface SegmentationBatch {
  /** Identity of the exact input text this batch was produced from. */
  readonly text: TextHash;
  /** Word-like segment spans over the input text, in order. */
  readonly startsUtf16: Uint32Array;
  readonly endsUtf16: Uint32Array;
  /** Versioned token classes (TOKEN_CLASS), parallel to the word spans. */
  readonly classes: Uint8Array;
  /** Sentence start offsets over the input text, with terminal text.length. */
  readonly sentenceBoundsUtf16: Uint32Array;
  readonly provenance: SegmenterFingerprint;
}

/**
 * Fixed probe text exercising the behaviors that differ across ICU builds:
 * contractions, numerals with separators, hyphens, smart quotes, CJK,
 * combining marks, and sentence boundaries with abbreviations.
 */
// Escape sequences keep genuinely DECOMPOSED combining marks in the probe --
// editors silently NFC-precompose literal accented characters (review finding).
export const SEGMENTER_PROBE =
  "Dr. Smith's co-operation\u2014remarkable, isn't it? 3.14 miles; \u201cwell,\u201d she said. " +
  '\u65e5\u672c\u8a9e\u306e\u5206\u304b\u3061\u66f8\u304d\u3002 cafe\u0301 nai\u0308ve re\u0301sume\u0301. e\u0301toile. ' +
  'Mr. Jones went home. \ud83d\ude00 emoji!';

const ADAPTER = 'intl-segmenter';
const ADAPTER_VERSION = '3'; // bumped: probe content changed (decomposed forms)
/** Versioned numeral classifier - identity recorded in recipe and fingerprint. */
const NUMERAL_RE = /^\p{N}+(?:[.,\u00b7]\p{N}+)*$/u;

interface RawSegmentation {
  starts: number[];
  ends: number[];
  classes: number[];
  sentenceStarts: number[];
  resolvedLocale: string;
}

function segmentRaw(text: string, locale: string): RawSegmentation {
  const words = new Intl.Segmenter(locale, { granularity: 'word' });
  const resolvedLocale = words.resolvedOptions().locale;
  const starts: number[] = [];
  const ends: number[] = [];
  const classes: number[] = [];
  for (const seg of words.segment(text)) {
    if (seg.isWordLike) {
      starts.push(seg.index);
      ends.push(seg.index + seg.segment.length);
      classes.push(NUMERAL_RE.test(seg.segment) ? TOKEN_CLASS.numeral : TOKEN_CLASS.lexical);
    }
  }
  const sentences = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const sentenceStarts: number[] = [];
  for (const seg of sentences.segment(text)) sentenceStarts.push(seg.index);
  return { starts, ends, classes, sentenceStarts, resolvedLocale };
}

const fingerprintCache = new Map<string, Promise<SegmenterFingerprint>>();

/** Behavior fingerprint: SHA-256 of the probe corpus's full packed output. */
export function fingerprint(locale: string): Promise<SegmenterFingerprint> {
  const cached = fingerprintCache.get(locale);
  if (cached) return cached;
  const p = (async () => {
    const raw = segmentRaw(SEGMENTER_PROBE, locale);
    const packed = [
      raw.starts.join(','),
      raw.ends.join(','),
      raw.classes.join(','),
      `${raw.sentenceStarts.join(',')},${SEGMENTER_PROBE.length}`, // terminal included
    ].join('|');
    return {
      adapter: ADAPTER,
      adapterVersion: ADAPTER_VERSION,
      locale: raw.resolvedLocale,
      wordPolicy: 'intl-word-v1' as const,
      sentencePolicy: 'intl-sentence-v1' as const,
      classifierVersion: 'numeral-re-v1' as const,
      probeHash: await sha256Hex(packed),
    };
  })();
  fingerprintCache.set(locale, p);
  return p;
}

/** The effective locale a tag resolves to under this runtime's Intl data. */
export function resolveLocale(tag: string): string {
  return new Intl.Segmenter(tag, { granularity: 'word' }).resolvedOptions().locale;
}

export async function segment(text: string, locale: string): Promise<SegmentationBatch> {
  const textHash = (await hashText(text)) as TextHash; // rejects ill-formed UTF-16 up front
  const raw = segmentRaw(text, locale);
  const sentenceBounds = new Uint32Array(raw.sentenceStarts.length + 1);
  sentenceBounds.set(raw.sentenceStarts);
  sentenceBounds[raw.sentenceStarts.length] = text.length;
  return {
    text: textHash,
    startsUtf16: Uint32Array.from(raw.starts),
    endsUtf16: Uint32Array.from(raw.ends),
    classes: Uint8Array.from(raw.classes),
    sentenceBoundsUtf16: sentenceBounds,
    provenance: await fingerprint(locale),
  };
}
