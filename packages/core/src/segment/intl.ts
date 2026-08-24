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
import { sha256Hex } from '../contract/hash.ts';
import { TOKEN_CLASS } from '../contract/recipes.ts';
import { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from '../contract/verified-text.ts';

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
const ADAPTER_VERSION = '5'; // bumped: suppress false English prefix-title boundaries
/** Versioned numeral classifier - identity recorded in recipe and fingerprint. */
const NUMERAL_RE = /^\p{N}+(?:[.,\u00b7]\p{N}+)*$/u;

// Deliberately mirrored in @texttrends/rsvp/source. Core's copy participates
// in the segmenter fingerprint while RSVP's dependency-free copy does not;
// apps/web/test/segmentation-parity.test.ts pins their public behavior.
const ENGLISH_PREFIX_TITLES = [
  'Mr', 'Mrs', 'Ms', 'Mx', 'Messrs', 'Mmes', 'Mme', 'Mlle',
  'Dr', 'Prof', 'Rev', 'Fr', 'Hon',
  'Capt', 'Cmdr', 'Col', 'Cpl', 'Gen', 'Lt', 'Maj', 'Sgt', 'Adm',
  'Gov', 'Sen', 'Rep',
] as const;
const ENGLISH_TITLE_FORMS = ENGLISH_PREFIX_TITLES.flatMap((title) => [title, title.toUpperCase()]);
const ENGLISH_TITLE_BEFORE_RE = new RegExp(
  String.raw`(?:${ENGLISH_TITLE_FORMS.join('|')})\.[\p{Zs}\t]*$`,
  'u',
);
const WORD_FORMING_RE = /[\p{L}\p{N}_'’]/u;
const FOLLOWING_WORD_RE = /^[\p{L}\p{N}'’-]+/u;
const SENTENCE_STARTERS: ReadonlySet<string> = new Set(`
  the then this that there these those here
  he she it they we you i his her their our my your its
  but and however yet so nor or thus hence still
  after before when while if though although because since once
  now next later a an as at in on for from by with to of
  no not never nothing all both each every some such
  what who why how where which
  do did does is was were are be been have has had
  let perhaps indeed well yes oh ah
`.trim().split(/\s+/u));

/** The adapter-owned numeral classifier shared with authored alias
 * compilation. Keeping one authority prevents a query unit from surviving
 * when the corresponding index token would be dropped. */
export function isNumeralSegment(value: string): boolean {
  return NUMERAL_RE.test(value);
}

interface RawSegmentation {
  starts: number[];
  ends: number[];
  classes: number[];
  sentenceStarts: number[];
  resolvedLocale: string;
}

/** True when Intl's boundary follows a bound English prefix title rather than
 * a sentence end. Ambiguous postfix forms such as Jr., Sr., and St. are
 * intentionally excluded. The following-word guard preserves real endings
 * such as "Ask Mr. Then leave." */
function isFalseTitleBoundary(text: string, start: number, locale: string): boolean {
  if (locale.toLowerCase().split('-')[0] !== 'en') return false;

  const before = text.slice(Math.max(0, start - 24), start);
  const title = ENGLISH_TITLE_BEFORE_RE.exec(before);
  if (title === null) return false;
  if (title.index > 0 && WORD_FORMING_RE.test(before[title.index - 1]!)) return false;

  const following = FOLLOWING_WORD_RE.exec(text.slice(start, start + 32));
  return following !== null && !SENTENCE_STARTERS.has(following[0].toLowerCase());
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
      classes.push(isNumeralSegment(seg.segment) ? TOKEN_CLASS.numeral : TOKEN_CLASS.lexical);
    }
  }
  const sentences = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const resolvedSentenceLocale = sentences.resolvedOptions().locale;
  const sentenceStarts: number[] = [];
  for (const seg of sentences.segment(text)) {
    if (!isFalseTitleBoundary(text, seg.index, resolvedSentenceLocale)) sentenceStarts.push(seg.index);
  }
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

/** The safe self-verifying entry: verify (hash once, rejecting ill-formed
 *  UTF-16 up front) then delegate to the verified fast lane. */
export async function segment(text: string, locale: string): Promise<SegmentationBatch> {
  return segmentVerified(await verifyText(text), locale);
}

/** The verified fast lane: the batch's text identity is the capability's hash
 *  — no re-digest. Rejects unauthenticated capabilities at entry. */
export async function segmentVerified(verified: VerifiedText, locale: string): Promise<SegmentationBatch> {
  const text = verifiedTextOf(verified); // authenticates; throws on forgeries
  const textHash = verifiedHashOf(verified);
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
