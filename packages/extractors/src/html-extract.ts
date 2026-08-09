/**
 * HTML container extraction — the worker-side adapter behind the `html` format.
 * Real-world HTML is rarely well-formed XML, so this uses a standards HTML5 tree
 * builder (parse5, dynamically imported) rather than an XML parser. Extraction
 * is INERT: parse5 builds a detached tree, and the walk never executes scripts,
 * fetches subresources, or resolves external entities. Source bytes are decoded
 * with the shared BOM/UTF-8/windows-1252 policy (a `<meta charset>` sniff is a
 * documented future refinement).
 *
 * The document is split into heading-delimited segments. This preserves the
 * established text serialization and bounds memory without exposing headings
 * as separate text blocks.
 *
 * Segments are FLUSHED during the walk — when the next top-level heading opens
 * and once at the end — so the per-document text cap is enforced against the
 * EXACT accumulated output length as it grows, and the walk never holds a
 * second whole-document intermediate alongside the parse tree.
 */

import {
  DecodeError,
  decodeSource,
  finalizeExtraction,
  hashSourceBytes,
  type ExtractedDocument,
  type ExtractionRecipeProvisional,
  type PreparedExtraction,
} from '@texttrends/core';
import { ExtractionFailure } from './failure.ts';

type HtmlRecipe = Extract<ExtractionRecipeProvisional, { format: 'html' }>;

const SKIPPED = new Set(['script', 'style', 'nav', 'head', 'template', 'noscript']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot',
  'thead', 'tr', 'ul',
]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

interface P5Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly childNodes?: readonly P5Node[];
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
}

interface Segment {
  chunks: string[];
}

/** The during-walk output accumulator: flushed segments ARE the final text. */
interface Emitter {
  readonly maxTextUtf16: number;
  /** Cleaned segment texts interleaved with their '\n\n' joins. */
  readonly out: string[];
  /** The EXACT accumulated final-output UTF-16 length (one running cursor). */
  length: number;
  /** The segment currently being collected. */
  cur: Segment;
}

function attr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function clean(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Close the current segment: clean it, account for the EXACT blank-line join
 * plus cleaned length on the running output cursor,
 * release the segment's chunk references, and reject the moment the exact
 * accumulated output length exceeds the cap. Raw chunk length is NEVER compared
 * against the cap — `clean()` collapses arbitrary whitespace runs, so raw-length
 * accounting would change the accept/reject set.
 */
function flushSegment(em: Emitter): void {
  const text = clean(em.cur.chunks.join(''));
  em.cur.chunks.length = 0; // the walk holds no other reference to these chunks
  if (text === '') return;
  if (em.out.length > 0) { em.out.push('\n\n'); em.length += 2; }
  em.out.push(text);
  em.length += text.length;
  if (em.length > em.maxTextUtf16) {
    throw new ExtractionFailure('CAP_EXCEEDED', `html extracted text of ${em.length} exceeds the per-document cap`);
  }
}

/** Walk a parse5 tree, splitting into heading-delimited segments and flushing
 *  the previous segment (cap-checked) whenever a top-level heading opens. */
function walk(node: P5Node, em: Emitter, inHeading: { level: number } | null): void {
  const name = node.nodeName;
  if (node.nodeName === '#text') {
    em.cur.chunks.push((node.value ?? '').replace(/[\t\r\n\f\v ]+/gu, ' '));
    return;
  }
  if (node.tagName === undefined) {
    for (const c of node.childNodes ?? []) walk(c, em, inHeading);
    return;
  }
  const tag = name.toLowerCase();
  if (SKIPPED.has(tag) || attr(node, 'aria-hidden') === 'true') return;
  if (tag === 'br') { em.cur.chunks.push('\n'); return; }
  if (tag === 'img') {
    const alt = attr(node, 'alt')?.trim();
    if (alt) em.cur.chunks.push(alt);
    return;
  }

  const level = HEADINGS[tag];
  if (level !== undefined && inHeading === null) {
    // A top-level heading closes the previous segment and opens a new one.
    flushSegment(em);
    const cur: Segment = { chunks: [] };
    em.cur = cur;
    cur.chunks.push('\n\n');
    for (const c of node.childNodes ?? []) walk(c, em, { level });
    cur.chunks.push('\n\n');
    return;
  }

  const isBlock = BLOCK.has(tag);
  if (isBlock) em.cur.chunks.push('\n\n');
  for (const c of node.childNodes ?? []) walk(c, em, inHeading);
  if (isBlock) em.cur.chunks.push('\n\n');
}

function findBody(node: P5Node): P5Node | null {
  if (node.tagName?.toLowerCase() === 'body') return node;
  for (const c of node.childNodes ?? []) {
    const found = findBody(c);
    if (found) return found;
  }
  return null;
}

/**
 * Parse + walk in ONE synchronous scope: the parse5 tree (many times the source
 * size) is unreachable — garbage-collectible — before any later await (source
 * hash / finalization). The cap is enforced DURING the walk at each segment
 * flush against the exact accumulated output length, so an over-cap document
 * with heading-delimited segments rejects at the first over-cap boundary and
 * completed segments release their chunk references as the walk proceeds.
 * (A heading-FREE document is one segment: its single end-of-walk flush still
 * cleans the whole text beside the live tree before the cap check — the win
 * there is only that the old retained `parts` intermediate is gone.)
 */
function parseAndCollect(
  parse: (html: string) => unknown,
  html: string,
  maxTextUtf16: number,
): string {
  const doc = parse(html) as P5Node;
  const body = findBody(doc) ?? doc;
  const em: Emitter = {
    maxTextUtf16,
    out: [],
    length: 0,
    cur: { chunks: [] },
  };
  walk(body, em, null);
  flushSegment(em); // the final segment has no next heading to flush it
  return em.out.join('');
}

export async function extractHtmlDocument(
  bytes: Uint8Array,
  recipe: HtmlRecipe,
  maxTextUtf16: number,
): Promise<ExtractedDocument> {
  let decoded;
  try {
    decoded = decodeSource(bytes); // BOM/UTF-8/1252 — throws DecodeError on ill-formed BOM Unicode
  } catch (e) {
    // Only a genuine decode failure is a domain error; anything else propagates
    // UNCHANGED for the caller's own taxonomy (not mislabelled as a domain code).
    if (!(e instanceof DecodeError)) throw e;
    throw new ExtractionFailure('DECODE_FAILED', e.message, { cause: e });
  }
  const { parse } = await import('parse5');
  const text = parseAndCollect(parse, decoded.text, maxTextUtf16);
  // Defensive re-assertion of the invariant the per-flush accounting enforces.
  if (text.length > maxTextUtf16) {
    throw new ExtractionFailure('CAP_EXCEEDED', `html extracted text of ${text.length} exceeds the per-document cap`);
  }

  const hash = await hashSourceBytes(bytes);
  const prepared: PreparedExtraction = {
    kind: 'transformed',
    source: {
      kind: 'markup',
      hash,
      byteLength: bytes.length,
      format: 'html',
      encoding: { detected: decoded.detected, hadReplacementChars: decoded.decoderReplacementCount > 0 },
    },
    text,
    evidence: { decoderReplacementCount: decoded.decoderReplacementCount, suspiciousControlCount: decoded.suspiciousControlCount },
  };
  return finalizeExtraction(prepared, recipe);
}
